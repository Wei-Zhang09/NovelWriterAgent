/**
 * Novel Workflow 的 IPC 适配层（P0-1）
 *
 * ## 为什么单独一个文件
 *
 * `core-process.ts` 已经 3000+ 行。把「12 个 stage 的实现」直接塞进去会
 * 让它继续膨胀，而这些实现是**应用层**的事（要知道 Planner/Writer/Reviewer
 * 怎么构造），与 IPC 路由本身无关。
 *
 * ## 这一层的职责
 *
 * 提示词 §三 要求：
 *
 *   UI → NovelWorkflow → WorkflowEngine → Harness → Planner/Writer/...
 *
 * 本文件提供 `NovelWorkflowServices` 的**真实实现** —— 每个方法就是把原
 * IPC handler 的核心逻辑搬过来（去掉 IPC 参数解析）。这样编排收回到
 * WorkflowEngine（代码控制，LLM 跳不过 stage），而业务逻辑仍在原模块里。
 *
 * ## ⚠ 与旧 IPC 的关系
 *
 * 旧 IPC（`chapter.plan` / `writer.draft` / `review.run` / ...）**保留不删**：
 * 它们是单步调试与验证脚本的入口（`verify:writing` 等依赖它们）。
 * 正常写作流程改走 workflow。两边调用的是同一批组件，不是两套实现。
 *
 * ## ⚠ 落库必须走 `tools.invoke`，不直接调仓储
 *
 * 旧 IPC 写计划/审查用的是 `p.tools.invoke('chapter.plan', ...)` ——
 * 那条路径有**权限校验 + schema 校验**。直接调 `repos.chapters.savePlan()`
 * 会绕过这两层，等于给 Workflow 开了一个后门。这里保持与旧 IPC 一致。
 */
import {
  AppError,
  ErrorCode,
  Logger,
  DEFAULT_TARGET_WORDS_PER_CHAPTER,
  perSceneWords,
  checkWordCountDeviation,
} from '@nwa/core';
import type { Repositories, Database } from '@nwa/storage';
import type { ToolRegistry, NovelWorkflowServices } from '@nwa/harness';
import { hashOfFile } from '@nwa/harness';
import { evaluateSettingsGate, hashSettings } from '@nwa/core';
import {
  renderCharacterBlock,
  toCharacterBrief,
  selectRelevantCharacters,
} from '@nwa/harness';
import type { RetrievalService } from '@nwa/harness';
import type { ToolContext } from '@nwa/shared';
import {
  ChapterWorkspace,
  ContinuityChecker,
  StateExtractor,
  StateSettlement,
  TimelineChecker,
} from '@nwa/story';
import { Writer, Reviewer, Reviser, Planner } from '@nwa/writing';
import type { ReviewIssue } from '@nwa/shared';

/**
 * 产物内容哈希（P1）。
 *
 * ⚠ 此前每个 stage 都返回 `contentHash: ''` —— 空字符串。
 *   `workflow_artifacts.content_hash` 是 NOT NULL，空串虽然能写进去，
 *   但它等于**没有哈希**：无法回答"这份产物还是当初那份吗"，
 *   也无法在恢复时判断产物是否被外部改动过。
 *   硬约束被一个空值绕过了。
 *
 * ⚠ 返回 null 而不是抛错：哈希取不到不该让整个 stage 失败
 *   （产物本身已经写成功了）。但 null 会被 recordArtifact 明确拒绝，
 *   所以"没哈希"是**可见的**，不会退化成又一个空串。
 */
function hashOfArtifact(path: string): string | null {
  try {
    return hashOfFile(path);
  } catch {
    return null;
  }
}

/** 模型网关需要的能力（只声明用到的，便于测试注入假实现） */
export interface WorkflowModel {
  plannerStructured(req: unknown): Promise<unknown>;
  structured(slot: string, req: unknown): Promise<unknown>;
  completeText(slot: string, req: unknown): Promise<unknown>;
}

export interface WorkflowServicesDeps {
  readonly dir: string;
  readonly db: Database;
  readonly repos: Repositories;
  readonly tools: ToolRegistry;
  readonly logger: Logger;
  /**
   * 模型网关（`null` 表示未配置）。
   *
   * ⚠ 需要它的 stage 在 null 时**明确报错**，不静默跳过 ——
   *   否则"没配模型"会表现为"这一章跑完了但正文是空的"。
   */
  readonly runtime: WorkflowModel | null;
  /** 技能（可能为空：技能是增强不是前置） */
  readonly loadSkills: () => { rows: readonly unknown[]; genre: string | null };
  /**
   * 分层检索服务（P0-3）。
   *
   * ⚠ `null` 表示检索层不可用（FTS 未建索引等）—— 此时各 stage
   *   **如实报告 retrieved:false**，不假装"没有相关记忆"。
   *   由 main 进程构造并注入（它才知道项目 db 与分词器）。
   */
  readonly retrieval: RetrievalService | null;
  /** 原子提交（§ADR-0002） */
  readonly commitChapter: (input: {
    chapterId: string;
    chapterNumber: number;
    params: Record<string, unknown>;
  }) => Promise<{ manifestPath: string; contentHash: string; committed: boolean }>;
}

/** ADMIN 工具上下文（与旧 IPC 一致） */
function adminContext(deps: WorkflowServicesDeps, runId: string): ToolContext {
  void runId;
  return {
    runId: `workflow`,
    projectId: '',
    callerPermission: 'ADMIN',
    emit: () => {},
  } as unknown as ToolContext;
}

function needModel(deps: WorkflowServicesDeps, what: string): WorkflowModel {
  if (!deps.runtime) {
    throw new AppError(
      ErrorCode.MODEL_AUTH_FAILED,
      `尚未配置模型，无法${what}。请在「模型配置」里填写 API 密钥后重试。`,
    );
  }
  return deps.runtime;
}

function needChapter(deps: WorkflowServicesDeps, chapterId: string) {
  const ch = deps.repos.chapters.get(chapterId);
  if (!ch) {
    throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, `章节不存在：${chapterId}`);
  }
  return ch;
}

/**
 * 构造本章的角色设定块（P2-2）。
 *
 * ⚠ **必须由 plan 与 write 两个 stage 共用**：如果只在其中一个注入，
 *   就会出现"规划时知道有谁、写作时忘了"——计划与正文对不上，
 *   而这正是"角色不进 prompt"这个缺陷的另一种表现形式。
 *
 * 筛选依据：用户指令 + 上一章摘要（两者都提到的人 → 相关）。
 * 都没有时（如第 1 章）注入全部 —— 那时作者刚写好的设定最需要被看见。
 */
function buildCharacterContext(
  deps: WorkflowServicesDeps,
  bookId: string,
  hints: readonly string[],
): string {
  try {
    const all = deps.repos.characters.listByBook(bookId).map(toCharacterBrief);
    if (all.length === 0) return '';
    return renderCharacterBlock(selectRelevantCharacters(all, hints));
  } catch (e) {
    // ⚠ 角色设定是**增强**不是前置依赖：读角色失败不该让整章写不出来。
    //   如实记录并返回空串，让写作继续（缺设定的稿仍是可用的草稿）。
    deps.logger.warn('角色设定读取失败（本次不注入角色）', {
      bookId,
      error: e instanceof Error ? e.message : String(e),
    });
    return '';
  }
}

/**
 * 断言设定门禁已通过（P2-3）。
 *
 * ⚠ 这是**硬门禁**（用户决策：「作者先写设定 → Agent 按设定写」）。
 *   判定逻辑本身在 `@nwa/core` 的 `evaluateSettingsGate`（纯函数、可穷举单测），
 *   这里只负责：读当前状态 → 判定 → 不通过时抛错。
 *
 * ⚠ 在 **plan 与 write 两处**都调用：
 *   只拦 write 的话，作者可以在设定未确认时先规划 —— 而计划一旦落库，
 *   Writer 就会按它写。门禁必须在"开始动脑"那一步就生效。
 */
function assertSettingsGate(deps: WorkflowServicesDeps, bookId: string): void {
  let book;
  try {
    book = deps.repos.books.get(bookId);
  } catch {
    // 书读不到是存储问题，不是门禁问题 —— 交给后续步骤报真正的错
    return;
  }
  const entries = deps.repos.world.snapshot(bookId);
  const verdict = evaluateSettingsGate({
    gateEnabled: book.settings_gate_enabled === 1,
    confirmedHash: book.settings_confirmed_hash,
    currentHash: hashSettings(entries),
    entryCount: entries.length,
  });
  if (!verdict.allowed) {
    throw new AppError(
      ErrorCode.SETTINGS_NOT_CONFIRMED,
      verdict.message,
      { details: { bookId, reason: verdict.reason, entryCount: entries.length } },
    );
  }
}

export function createWorkflowServices(deps: WorkflowServicesDeps): NovelWorkflowServices {
  const log = deps.logger.child('workflow-services');

  const workspaceFor = (chapterNumber: number): ChapterWorkspace => {
    const ws = new ChapterWorkspace({
      rootDir: deps.dir,
      chapterNumber,
      logger: deps.logger.child('workspace'),
    });
    ws.ensure();
    return ws;
  };

  return {
    // ── 1. 章节 ──
    //
    // 提示词 §二十九 的目标：用户只做「选书 → 选下一章 → 点写下一章」。
    // 因此允许 chapterId 为空 —— 说明用户要写"下一章"，由这里建出来。
    async ensureChapter(input) {
      if (input.chapterId) {
        const ch = needChapter(deps, input.chapterId);
        return { chapterId: ch.id, chapterNumber: ch.chapter_number };
      }
      const bookId = input.params['bookId'] as string | undefined;
      if (!bookId) {
        throw new AppError(
          ErrorCode.TOOL_VALIDATION_ERROR,
          '既没有 chapterId 也没有 bookId，无法确定要写哪一章',
        );
      }
      const existing = deps.repos.chapters.listByBook(bookId);

      // ⚠ 必须**尊重传入的 chapterNumber**。此前这里只取 max+1，
      //   调用方说"写第 1 章"却建出第 2 章 —— 参数被静默忽略。
      //   实测：verify:state 传 chapterNumber:1，提议挂到了第 2 章上，
      //   于是"按 chapterId 查提议"查不到，看起来像没落库。
      const requested = input.chapterNumber;
      if (requested !== null && requested !== undefined) {
        // 该章已存在则复用（重跑工作流不该建出重复章节）
        const hit = existing.find((c) => c.chapter_number === requested);
        if (hit) {
          log.info('复用已存在的章节', { chapterId: hit.id, chapterNumber: requested });
          return { chapterId: hit.id, chapterNumber: hit.chapter_number };
        }
        const id = `chapter_${bookId}_${String(requested).padStart(3, '0')}`;
        const ch = deps.repos.chapters.create({
          id,
          bookId,
          chapterNumber: requested,
          title: `第 ${requested} 章`,
          status: 'DRAFT',
        });
        log.info('已按请求创建章节', { chapterId: ch.id, chapterNumber: requested });
        return { chapterId: ch.id, chapterNumber: ch.chapter_number };
      }

      // 未指定章号 → 接续下一章
      const n = existing.reduce((m, c) => Math.max(m, c.chapter_number), 0) + 1;
      const id = `chapter_${bookId}_${String(n).padStart(3, '0')}`;
      const ch = deps.repos.chapters.create({
        id,
        bookId,
        chapterNumber: n,
        title: `第 ${n} 章`,
        status: 'DRAFT',
      });
      log.info('已创建章节（未指定章号，接续下一章）', { chapterId: ch.id, chapterNumber: n });
      return { chapterId: ch.id, chapterNumber: ch.chapter_number };
    },

    // ── 2. 上下文装配（P0-3：检索策略由 stage 声明，engine 只负责装配）──
    //
    // ⚠ 本方法做**章节级检索**（提示词 §五 Planner 用 chapter-level）。
    //   场景级检索在 write stage 内部（它才知道场景划分）。
    //   检索轨迹如实返回 —— 让"为什么引用了那个旧章节"可回答。
    async buildContext(input) {
      const ch = needChapter(deps, input.chapterId);
      const query = String(input.params['query'] ?? ch.title ?? `第 ${input.chapterNumber} 章`);
      const trace: {
        query: string;
        retriever: string;
        hitId: string;
        score: number | null;
        sourceRef: string | null;
        reason: string | null;
      }[] = [];
      const tiers: {
        tier: string;
        stage: string;
        retrieved: boolean;
        hitCount: number;
        error: string | null;
      }[] = [];

      // ── 分层检索（P0-3）────────────────────────────────
      //
      // ⚠ 提示词 §五：不同 stage 用**不同粒度**，不能一个 gather 打天下。
      //   这里为每个 stage 预取它需要的那一层，结果按 stage 分别落
      //   retrieval_traces（`stage` 字段就是证据），使
      //   「为什么 Planner 引用了第 12 章」与「为什么 Writer 引用了它」
      //   是两个可分别回答的问题。
      //
      // ⚠ 检索层不可用（null）时**如实报告**，不静默当成"没有记忆"。
      if (deps.retrieval) {
        const svc = deps.retrieval;
        const base = {
          bookId: ch.book_id,
          chapterNumber: ch.chapter_number,
          query,
          // ⚠ 用真实的 workflowId：痕迹的 workflow_id 为 NULL 时
          //   按 workflowId 查不到（"写了但挂错归属"）。
          workflowId: input.workflowId,
        };
        const perStage: readonly {
          readonly stage: string;
          readonly run: () => { hits: readonly unknown[]; retrieved: boolean; error?: string };
        }[] = [
          // Planner：章节级（"前面发生过什么"）
          { stage: 'planner', run: () => svc.gatherChapterLevel({ ...base, stage: 'planner', limit: 8 }) },
          // Writer：场景级（"这个场景该怎么写"）
          { stage: 'writer', run: () => svc.gatherSceneLevel({ ...base, stage: 'writer', limit: 5 }) },
          // Reviewer：证据级（"这条指控有没有依据"）
          { stage: 'reviewer', run: () => svc.gatherEvidenceLevel({ ...base, stage: 'reviewer', limit: 10 }) },
          // Continuity：结构化真相优先
          {
            stage: 'continuity',
            run: () => svc.gatherForContinuity({ ...base, stage: 'continuity', limit: 20 }),
          },
        ];
        for (const t of perStage) {
          const r = t.run();
          tiers.push({
            tier: t.stage,
            stage: t.stage,
            retrieved: r.retrieved,
            hitCount: r.hits.length,
            error: r.error ?? null,
          });
          for (const h of r.hits as readonly {
            sourceRef: string;
            retriever: string;
            hitId: string;
            score: number | null;
            reason: string;
          }[]) {
            trace.push({
              query,
              retriever: h.retriever,
              hitId: h.hitId,
              score: h.score,
              sourceRef: h.sourceRef,
              reason: `[${t.stage}] ${h.reason}`,
            });
          }
        }
      } else {
        // ⚠ 不是"没有相关记忆"，而是"检索层不可用" —— 必须区分
        for (const st of ['planner', 'writer', 'reviewer', 'continuity']) {
          tiers.push({
            tier: st,
            stage: st,
            retrieved: false,
            hitCount: 0,
            error: '检索服务未注入（FTS 可能未建索引）',
          });
        }
        log.warn('检索服务未注入：上下文将缺少长程记忆（不阻断写作）', {
          chapterNumber: ch.chapter_number,
        });
      }

      return {
        contextSummary: {
          chapterId: ch.id,
          chapterNumber: ch.chapter_number,
          query,
          retrievalHits: trace.length,
        },
        retrievalTrace: trace,
        retrievalTiers: tiers,
      };
    },

    // ── 3. 规划 ──
    async plan(input) {
      const ch = needChapter(deps, input.chapterId);
      // ⚠ 设定门禁（P2-3）：在"开始动脑"这一步就拦，而不是等写完再拦
      assertSettingsGate(deps, ch.book_id);
      const model = needModel(deps, '生成章节计划');
      const planner = new Planner({
        structured: (req) => model.plannerStructured(req) as never,
        logger: deps.logger.child('planner'),
      });

      // 上一章摘要（Planner 需要它来接续剧情）
      const prevSummary = deps.repos.chapters
        .listByStatus(ch.book_id, 'COMMITTED')
        .filter((c) => c.chapter_number < ch.chapter_number)
        .sort((a, b) => b.chapter_number - a.chapter_number)[0]?.summary;

      // ── 角色设定注入（P2-2）──────────────────────────────
      //
      // ⚠ 此前 `contextText` 被传空串 —— 角色表与 character.* 工具早就
      //   存在，但没有任何地方把角色喂给模型。作者写了「沈砚左手有旧伤」，
      //   模型完全不知道，只能靠检索旧章节猜，猜不到就自己编。
      const characterContext = buildCharacterContext(deps, ch.book_id, [
        prevSummary ?? '',
        String(input.params['userInstruction'] ?? ''),
      ]);
      if (characterContext.length > 0) {
        log.info('已注入角色设定（规划）', {
          chapterNumber: ch.chapter_number,
          chars: characterContext.length,
        });
      }

      const res = await planner.plan({
        chapterNumber: ch.chapter_number,
        contextText: characterContext,
        ...(prevSummary ? { previousSummary: prevSummary } : {}),
        ...(input.params['userInstruction']
          ? { userInstruction: String(input.params['userInstruction']) }
          : {}),
      });

      if (!res.ok || !res.plan) {
        throw new AppError(
          ErrorCode.MODEL_STRUCTURED_EMPTY,
          res.error?.message ?? '计划生成失败',
          { details: { issues: res.issues ?? [] } },
        );
      }

      // ⚠ 落库走 tools.invoke（权限 + schema 双重校验），不直接调仓储
      const saved = await deps.tools.invoke(
        'chapter.plan',
        { chapterId: ch.id, plan: res.plan },
        adminContext(deps, ''),
      );
      if (!saved.ok) {
        throw new AppError(
          saved.error.code as never,
          `计划落库失败：${saved.error.message}`,
        );
      }

      const ws = workspaceFor(ch.chapter_number);
      // ⚠ 必须**真的写文件**，否则下面返回的 planPath 指向一个不存在的
      //   文件 —— 而 workflow_artifacts 会把它当"产物路径"存下来。
      //   实测：plan 阶段标记 DONE 时，工作区目录是空的，plan.json
      //   要到 write 阶段才由 Writer 写出。于是"产物路径"在当时是假的，
      //   恢复时按这个路径找不到任何东西。
      ws.writeJson('plan', res.plan);
      return {
        planPath: ws.pathOf('plan'),
        sceneCount: res.plan.scenes.length,
        contentHash: hashOfArtifact(ws.pathOf('plan')) ?? '',
      };
    },

    // ── 4. 计划校验 ──
    //
    // ⚠ 真门禁：计划不合格就不让 Writer 去写。原流程没有这一步，
    //   UI 可以 plan 完直接 draft —— 于是在自相矛盾的计划上
    //   烧掉最贵的一段额度。
    async planVerify(input) {
      const ch = needChapter(deps, input.chapterId);
      const plan = deps.repos.chapters.readPlan<{
        scenes?: { sceneId?: string; purpose?: string }[];
      }>(ch.id);
      const problems: string[] = [];

      if (!plan) {
        problems.push('章节没有计划（plan 未落库）');
        return { ok: false, problems };
      }
      const scenes = plan.scenes ?? [];
      if (scenes.length === 0) problems.push('计划里没有任何场景');
      scenes.forEach((s, i) => {
        if (!s.purpose || String(s.purpose).trim() === '') {
          problems.push(`场景 ${i + 1} 缺少 purpose（写这段是为了什么）`);
        }
      });

      return { ok: problems.length === 0, problems };
    },

    // ── 5. 写正文 ──
    async write(input) {
      const ch = needChapter(deps, input.chapterId);
      // ⚠ 设定门禁（P2-3）：与 plan 一样要拦 —— 计划可能是门禁前就落库的
      assertSettingsGate(deps, ch.book_id);
      const model = needModel(deps, '生成正文');
      const plan = deps.repos.chapters.readPlan<unknown>(ch.id);
      if (!plan) {
        throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '该章节还没有计划，请先规划');
      }
      const ws = workspaceFor(ch.chapter_number);
      const { rows: skillRows, genre } = deps.loadSkills();

      // ⚠ 角色设定（P2-2）：与 plan stage 共用同一个 helper，
      //   否则"规划时知道有谁"但"写作时忘了" —— 计划与正文对不上。
      //
      // ⚠ 提示文本用**本章计划**（含 brief.mainCharacters 与场景 purpose）：
      //   计划里点名的人正是这一章要写的人，比"上一章摘要"更准。
      const characterContext = buildCharacterContext(deps, ch.book_id, [
        JSON.stringify(plan),
      ]);

      // ── 每章字数目标（P2-1，软约束）──────────────────────
      //
      // ⚠ Writer 是**逐场景**生成的（§7.3 约束 3），所以要把章级目标
      //   换算成场景级。未设定目标时回落到默认值 —— 不因为"没设过"
      //   就让模型没有篇幅概念。
      const book = deps.repos.books.get(ch.book_id);
      const chapterTarget =
        book.target_words_per_chapter ?? DEFAULT_TARGET_WORDS_PER_CHAPTER;
      const planScenes = (plan as { scenes?: unknown[] }).scenes ?? [];
      const wordsPerScene = perSceneWords(
        chapterTarget,
        Math.max(1, planScenes.length),
      );

      const writer = new Writer({
        complete: (req) => model.completeText('writer', req) as never,
        workspace: ws,
        logger: deps.logger.child('writer'),
        skillRows: skillRows as never,
        genre,
        wordsPerScene,
        // ⚠ 角色设定（P2-2）：与 plan stage 用同一套筛选，
        //   否则"规划时知道有谁"但"写作时忘了" —— 计划与正文对不上。
        ...(characterContext.trim().length > 0 ? { characterContext } : {}),
        // ⚠ 场景级检索（P0-3）：按**每个场景**的意图取旧内容，
        //   不是整章共用一份。检索失败返回空串（Writer 会继续写）。
        ...(deps.retrieval
          ? {
              sceneMemory: (scene: { purpose?: string; sceneId?: string }) => {
                const q = [scene.purpose, scene.sceneId].filter(Boolean).join(' ');
                if (!q.trim()) return '';
                const r = deps.retrieval!.gatherSceneLevel({
                  bookId: ch.book_id,
                  chapterNumber: ch.chapter_number,
                  query: q,
                  stage: 'writer',
                  limit: 3,
                });
                // ⚠ 检索不可用时返回空串并在日志里留痕 —— 不假装"没有记忆"
                if (!r.retrieved) {
                  deps.logger.warn('场景级检索不可用（本场景无长程记忆）', {
                    sceneId: scene.sceneId,
                    error: r.error ?? null,
                  });
                  return '';
                }
                return r.hits.map((h) => `- ${h.content}`).join('\n');
              },
            }
          : {}),
      });

      const res = await writer.draft(plan as never);
      if (!res.ok) {
        throw new AppError(
          ErrorCode.MODEL_TIMEOUT,
          res.error?.message ?? `场景 ${res.failedSceneIndex ?? '?'} 生成失败`,
        );
      }
      const d = res.draft!;
      return {
        draftPath: d.draftPath,
        contentHash: hashOfArtifact(d.draftPath) ?? '',
        wordCount: d.totalChars,
        sceneCount: d.scenes.length,
        // ⚠ deviation 由 Writer 结果带出，上层决定单独存档（§十一）
        deviations: d.scenes.flatMap((s) => s.deviations ?? []),
      };
    },

    // ── 6. 审查 ──
    //
    // 与旧 IPC 一致：确定性检查（ContinuityChecker）先跑，
    // 再让模型审阅，两者合并。状态由 issues 机械推导。
    async review(input) {
      const ch = needChapter(deps, input.chapterId);
      const ws = workspaceFor(ch.chapter_number);
      const draft = ws.readText('draft');
      if (draft === null) {
        throw new AppError(
          ErrorCode.TOOL_VALIDATION_ERROR,
          `第 ${ch.chapter_number} 章还没有草稿 —— 请先写正文`,
        );
      }

      const checker = new ContinuityChecker({
        repos: deps.repos,
        logger: deps.logger.child('continuity'),
        bookId: ch.book_id,
      });
      const plan = deps.repos.chapters.readPlan<unknown>(ch.id);
      const cReport = checker.check({
        chapterNumber: ch.chapter_number,
        draftText: draft,
        ...(plan !== null ? { plan: plan as never } : {}),
      });
      const deterministic: ReviewIssue[] = cReport.issues.map((i) => ({
        id: i.id,
        severity: i.severity === 'BLOCKING' ? 'BLOCKING' : 'MAJOR',
        category: 'CONTINUITY' as const,
        claim: i.message,
        evidence: [i.sourceRef],
        suggestions: [],
      }));

      // ── 字数偏离提示（P2-1，软约束）──────────────────────
      //
      // ⚠ 刻意用 NOTE 级（最低），**永不用 BLOCKING** ——
      //   用户明确要求「允许浮动，偏离超阈值时提示我（不阻断）」。
      //   这也是技术上的正确选择：硬卡字数会激励模型为凑数注水，
      //   正是 ADR-0007 与 naturalness/detectors.ts 一直在防的事。
      //   一章 1800 字紧凑完整，好过 3000 字全是"他深吸一口气"。
      //
      // ⚠ 只对**已设定目标**的书提示：未设定时用默认值算出来的偏离
      //   是"系统猜的"，拿去提醒作者会像无故指责。
      const book = deps.repos.books.get(ch.book_id);
      if (book.target_words_per_chapter !== null) {
        const dev = checkWordCountDeviation(
          draft.length,
          book.target_words_per_chapter,
          book.word_count_tolerance_pct,
        );
        if (!dev.withinTolerance) {
          deterministic.push({
            id: `wc_dev_${ch.id}`,
            severity: 'NOTE',
            category: 'PACING' as const,
            claim: `本章字数偏离目标：${dev.message}`,
            evidence: [`target:${dev.target}`, `actual:${dev.actual}`],
            suggestions: [],
          });
        }
      }

      const model = deps.runtime;
      const reviewer = new Reviewer({
        structured: model
          ? (req) => model.structured('reviewer', req) as never
          : async () => ({
              ok: false as const,
              error: { code: ErrorCode.MODEL_AUTH_FAILED, message: '尚未配置模型' },
              attempts: 0,
              usedFallback: false,
            }),
        logger: deps.logger.child('reviewer'),
      });

      // ⚠ 证据级检索（P0-3）：Reviewer 要判"这条指控有没有依据"，
      //   必须给它**可引用的证据条目**，而不是小说片段。
      //   空 contextText 会让它只能凭感觉判，无法回溯。
      let evidenceText = '';
      if (deps.retrieval) {
        const ev = deps.retrieval.gatherEvidenceLevel({
          bookId: ch.book_id,
          chapterNumber: ch.chapter_number,
          query: `第 ${ch.chapter_number} 章审查依据`,
          stage: 'reviewer',
          limit: 10,
        });
        if (ev.retrieved && ev.hits.length > 0) {
          evidenceText =
            '可引用的证据条目（判断问题时请优先引用它们）：\n' +
            ev.hits.map((h) => `- [${h.sourceRef}] ${h.content}`).join('\n');
        } else if (!ev.retrieved) {
          log.warn('证据级检索不可用（审查缺少可引用证据）', { error: ev.error ?? null });
        }
      }

      const review = await reviewer.review({
        chapterNumber: ch.chapter_number,
        draftText: draft,
        contextText: evidenceText,
        deterministicIssues: deterministic,
      });

      const saved = await deps.tools.invoke(
        'review.run',
        { chapterId: ch.id, review: { overallStatus: review.status, issues: review.issues } },
        adminContext(deps, ''),
      );
      if (!saved.ok) {
        throw new AppError(
          saved.error.code as never,
          `审查结果落库失败：${saved.error.message}`,
        );
      }

      // ⚠ 同上：审查报告也要真落盘。此前 review.json 只由 Reviser 写，
      //   而 review 阶段在 Reviser 之前 —— 记录下来的路径同样是假的。
      ws.writeJson('review', {
        chapterNumber: ch.chapter_number,
        overallStatus: review.status,
        issues: review.issues,
      });
      return {
        reportPath: ws.pathOf('review'),
        contentHash: hashOfArtifact(ws.pathOf('review')) ?? '',
        blockingCount: review.issues.filter((i) => i.severity === 'BLOCKING').length,
        issueCount: review.issues.length,
      };
    },

    // ── 7. 改稿 ──
    async revision(input) {
      const ch = needChapter(deps, input.chapterId);
      const model = needModel(deps, '改稿');
      const ws = workspaceFor(ch.chapter_number);
      const draft = ws.readText('draft');
      if (draft === null) {
        throw new AppError(ErrorCode.WORKSPACE_CORRUPTED, '工作区里没有草稿，无法改稿');
      }
      const report = deps.repos.chapters.readReview<{ issues: ReviewIssue[] }>(ch.id);
      if (report === null) {
        throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '没有审查报告，无法改稿');
      }
      const issues = report.issues ?? [];

      const reviser = new Reviser({
        // 改稿走结构化输出（替换指令），由 Reviser 程序化应用 ——
        // 模型无法触碰它没明确引用的文字（"改稿毁稿"的机制防线）
        structured: (req) => model.structured('writer', req) as never,
        workspace: ws,
        logger: deps.logger.child('reviser'),
      });

      const res = await reviser.revise({
        chapterNumber: ch.chapter_number,
        draftText: draft,
        issues,
      });

      if (!res.ok) {
        throw new AppError(
          ErrorCode.MODEL_TIMEOUT,
          res.error?.message ?? '改稿失败',
        );
      }

      return {
        revisionPath: ws.pathOf('revision'),
        contentHash: hashOfArtifact(ws.pathOf('revision')) ?? '',
        applied: res.appliedEdits ?? 0,
        needsRegeneration: (res.rejectedEdits ?? 0) > (res.appliedEdits ?? 0),
      };
    },

    // ── 8. 连续性检查 ──
    async continuity(input) {
      const ch = needChapter(deps, input.chapterId);
      const ws = workspaceFor(ch.chapter_number);
      const draft = ws.readText('draft');
      if (draft === null) {
        throw new AppError(ErrorCode.WORKSPACE_CORRUPTED, '工作区里没有草稿，无法做连续性检查');
      }
      const checker = new ContinuityChecker({
        repos: deps.repos,
        logger: deps.logger.child('continuity'),
        bookId: ch.book_id,
      });
      const plan = deps.repos.chapters.readPlan<unknown>(ch.id);
      const report = checker.check({
        chapterNumber: ch.chapter_number,
        draftText: draft,
        ...(plan !== null ? { plan: plan as never } : {}),
      });

      // ⚠ P1：结果必须落盘（durable），否则进程重启后要重跑昂贵的检查
      ws.writeJson('continuity', report);

      // ── 检查依据（P0-3）────────────────────────────────
      //
      // ⚠ 结构化真值**优先**：连续性结论是断言，必须有确定性依据。
      //   全文检索是概率性的（查不到不代表没有），只作补充。
      //
      // ⚠ 返回 `[]` 会让人以为"什么都没对照" —— 必须如实填实际读到的来源。
      const checkedAgainst: string[] = [];
      const structuredWarnings: string[] = [];
      if (deps.retrieval) {
        const r = deps.retrieval.gatherForContinuity({
          bookId: ch.book_id,
          chapterNumber: ch.chapter_number,
          query: `第 ${ch.chapter_number} 章连续性检查`,
          stage: 'continuity',
          limit: 50,
        });
        // 按来源层级去重统计（回答"依据的是哪几层"）
        const byRetriever = new Map<string, number>();
        for (const h of r.hits) {
          byRetriever.set(h.retriever, (byRetriever.get(h.retriever) ?? 0) + 1);
        }
        for (const [k, n] of byRetriever) checkedAgainst.push(`${k}(${n})`);
        if (r.error) structuredWarnings.push(r.error);
      } else {
        structuredWarnings.push('检索服务未注入：连续性检查缺少结构化真值依据');
      }

      // 确定性检查本身也是"依据"（它读的是 Canon/角色状态）
      checkedAgainst.push(`deterministic_checker(issues=${report.issues.length})`);

      return {
        reportPath: ws.pathOf('continuity'),
        contentHash: hashOfArtifact(ws.pathOf('continuity')) ?? '',
        // ⚠ ContinuityChecker 的 severity 只有 BLOCKING / WARNING（无 HIGH）——
        //   实测确认。写 HIGH 会让这个判断永远为假，静默漏掉阻塞问题。
        blockingCount: report.issues.filter((i) => i.severity === 'BLOCKING').length,
        checkedAgainst,
        structuredWarnings,
      };
    },

    // ── 9. 状态结算（§六 P0-4）──
    //
    // 完整链路：提取（模型）→ 落提议(PROPOSED) → 验证（代码）→
    //          应用（**只有 VERIFIED 才允许**）
    //
    // ⚠ 硬约束：没有 VERIFIED 的 State Proposal 不得进入 Canon。
    //   验证是**代码判定**（引文能否在正文里精确定位），不调模型 ——
    //   模型既当运动员又当裁判会把"我推断的"当成"我验证过的"。
    async settleState(input) {
      const ch = needChapter(deps, input.chapterId);
      const ws = workspaceFor(ch.chapter_number);
      const draft = ws.readText('draft');
      if (draft === null) {
        throw new AppError(
          ErrorCode.WORKSPACE_CORRUPTED,
          '工作区里没有草稿，无法做状态结算',
        );
      }

      // 已有候选事实（canon.extract 的产物）—— 纳入同一条提议，
      // 让**一个门禁管住所有进 Canon 的东西**。
      const savedFacts = ws.readJson<{ facts: never[] }>('proposedFacts');
      const proposedFacts = savedFacts?.facts ?? [];

      const chars = deps.repos.characters
        .listByBook(ch.book_id)
        .map((c) => ({ id: c.id, name: c.name, aliases: [] as string[] }));

      // 上一章结束时各角色状态（帮助模型判断"变了没有"）
      const previousStates = chars
        .map((c) => {
          const st = deps.repos.characters.latestState(c.id);
          if (!st) return null;
          let status = '';
          try {
            const v = JSON.parse(st.state_json) as Record<string, unknown>;
            if (typeof v['status'] === 'string') status = v['status'];
          } catch {
            /* 解析失败则跳过该角色 */
          }
          return status ? { characterName: c.name, status } : null;
        })
        .filter((x): x is { characterName: string; status: string } => x !== null);

      const model = deps.runtime;
      const extractor = new StateExtractor({
        // 抽取是结构化小任务，走 utility 槽位（§54 任务路由）
        structured: model
          ? (req) => model.structured('utility', req) as never
          : async () => ({
              ok: false as const,
              error: { code: ErrorCode.MODEL_AUTH_FAILED, message: '尚未配置模型' },
              attempts: 0,
            }),
        logger: deps.logger.child('state-extractor'),
        bookId: ch.book_id,
        characters: chars,
      });

      const settlement = new StateSettlement({
        repos: deps.repos,
        db: deps.db,
        logger: deps.logger.child('state'),
        bookId: ch.book_id,
        extractor,
        proposedFacts: proposedFacts as never,
        sourceRef: `chapters/${String(ch.chapter_number).padStart(3, '0')}.md`,
      });

      const r = await settlement.settle({
        chapterId: ch.id,
        chapterNumber: ch.chapter_number,
        draftText: draft,
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
        ...(previousStates.length > 0 ? { previousStates } : {}),
      });

      // ⚠ 只有 VERIFIED 才应用。REJECTED 时**如实不写**，把原因带回上层
      //   —— 静默跳过会让"这一章的状态没进 Canon"变成查不出的现象。
      let applied = {
        factsWritten: 0,
        characterStatesWritten: 0,
        timelineEventsWritten: 0,
        foreshadowingWritten: 0,
        skipped: [] as readonly string[],
      };
      if (r.verified) {
        applied = settlement.apply({
          proposalId: r.proposalId,
          chapterNumber: ch.chapter_number,
          draftText: draft,
        });
      } else {
        log.warn('状态提议未通过验证 → 不写入 Canon（§六硬约束）', {
          chapterId: ch.id,
          proposalId: r.proposalId,
          rejected: r.rejected.length,
        });
      }

      return {
        proposalId: r.proposalId,
        verified: r.verified,
        factCount: applied.factsWritten,
        characterStateCount: applied.characterStatesWritten,
        timelineEventCount: applied.timelineEventsWritten,
        foreshadowingCount: applied.foreshadowingWritten,
        rejected: [...r.rejected, ...applied.skipped],
      };
    },

    // ── 10. Commit 前置门禁 ──
    //
    // ⚠ 实现提示词 §十二 的硬要求：
    //   summary != empty AND summary_approved == 1，否则拒绝 Commit。
    async readyToCommit(input) {
      const ch = needChapter(deps, input.chapterId);
      const ws = workspaceFor(ch.chapter_number);
      const missing: string[] = [];
      /**
       * FORCE 模式下被跳过的检查项（**提示**，不阻塞）。
       *
       * ⚠ 与 missing 分开存放，而不是塞进 missing 再过滤：
       *   混在一起就得靠字符串前缀区分，而"前缀约定"一旦写错
       *   就会把阻塞项当提示放行。两个数组在类型层面就不可能混淆。
       */
      const forcedNotes: string[] = [];

      // ⚠ FORCE：显式绕过硬性前置检查（P1 / §十二）。
      //
      // 只有**摘要批准**这一项可以被绕过 —— 审阅 BLOCKING 与时间线冲突
      // 是内容正确性问题，绕过它们等于提交已知错误的正文。
      // 摘要批准不同：它是"记忆源头是否可用"的关口，作者有权决定
      // 这一章不要摘要（例如过渡章、试验章）。
      //
      // ⚠ 绕过不是"不检查"，而是"检查结果降级为提示并留审计"。
      //   审计记录由 commit 工具写入（那里才有 chapter 与 manifest 上下文）。
      const forced = input.params?.['commitMode'] === 'FORCE';

      if (ws.readText('draft') === null) missing.push('工作区没有草稿');

      const report = deps.repos.chapters.readReview<{ issues: ReviewIssue[] }>(ch.id);
      if (report === null) {
        missing.push('没有审查报告');
      } else {
        const blocking = (report.issues ?? []).filter((i) => i.severity === 'BLOCKING').length;
        if (blocking > 0) missing.push(`仍有 ${blocking} 个 BLOCKING 问题未解决`);
      }

      // §十二：摘要必须存在且已批准
      //
      // ⚠ 此前这里**只**挡 missing，且与 commit-tools 里的检查重复。
      //   两处判断必须语义一致（"存在且已批准"），否则会出现
      //   "门禁说能提交、工具却拒绝"这种自相矛盾 —— 用户看到的是
      //   两个地方给出不同答案。
      const summary = ch.summary;
      const hasSummary = summary !== null && summary !== undefined && String(summary).trim() !== '';
      const approved = ch.summary_approved === 1;

      if (forced) {
        // FORCE：不阻塞，但要如实记录**跳过了什么**
        log.warn('Commit 门禁被 FORCE 绕过（摘要批准检查降级为提示）', {
          chapterId: ch.id,
          summaryPresent: hasSummary,
          summaryApproved: approved,
        });
        // ⚠ 注意：这里**只**跳过摘要这一项。
        //   草稿缺失、审阅 BLOCKING、时间线冲突**仍然阻塞** ——
        //   它们是内容正确性问题，绕过等于提交已知错误的正文。
        //   （不要清空整个 missing 数组：那会把真实阻塞一起放行。）
        if (!hasSummary) {
          forcedNotes.push('摘要为空（已 FORCE 忽略）');
        } else if (!approved) {
          forcedNotes.push('摘要尚未人工批准（已 FORCE 忽略）');
        }
      } else if (!hasSummary) {
        missing.push('章节摘要为空（Commit 需要摘要）');
      } else if (!approved) {
        missing.push('章节摘要尚未人工批准（§十二：summary_approved != 1）');
      }

      // ── P0-5：时间线不可能事件（Commit 前必须能发现）──
      //
      // 验收用例：「ch12 21:30 离开医院、ch13 21:20 还在医院」→
      // Commit 前必须能发现。只有 BLOCKING（角色两地同时出现、
      // 死后仍有行动）才挡提交 —— 顺序倒退只报 WARNING/INFO，
      // 因为倒叙/插叙是正常写法，挡住它们等于把检查器关掉。
      const tl = new TimelineChecker({
        repo: deps.repos.timeline,
        logger: deps.logger.child('timeline'),
        bookId: ch.book_id,
      });
      const tlReport = tl.check();
      const tlBlocking = TimelineChecker.blockingOf(tlReport);
      for (const issue of tlBlocking) {
        missing.push(`时间线冲突（${issue.code}）：${issue.message}`);
      }
      if (tlReport.warningCount > 0 || tlBlocking.length > 0) {
        log.warn('时间线检查发现问题', {
          chapterId: ch.id,
          blocking: tlBlocking.length,
          warning: tlReport.warningCount,
          events: tlReport.eventCount,
        });
      }

      return { ok: missing.length === 0, missing, forcedNotes };
    },

    // ── 11. 提交 ──
    async commit(input) {
      return deps.commitChapter({
        chapterId: input.chapterId,
        chapterNumber: input.chapterNumber,
        params: input.params,
      });
    },

    // ── 12. 提交后校验 ──
    async verifyCommit(input) {
      const ch = needChapter(deps, input.chapterId);
      const problems: string[] = [];
      if (ch.status !== 'COMMITTED') {
        problems.push(`章节状态是 ${ch.status}，不是 COMMITTED`);
      }
      const ws = workspaceFor(ch.chapter_number);
      if (ws.readText('draft') === null) problems.push('工作区草稿丢失');
      return { ok: problems.length === 0, problems };
    },
  };
}
