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
import { AppError, ErrorCode, Logger } from '@nwa/core';
import type { Repositories, Database } from '@nwa/storage';
import type { ToolRegistry, NovelWorkflowServices } from '@nwa/harness';
import type { ToolContext } from '@nwa/shared';
import { ChapterWorkspace, ContinuityChecker } from '@nwa/story';
import { Writer, Reviewer, Reviser, Planner } from '@nwa/writing';
import type { ReviewIssue } from '@nwa/shared';

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
      const n = existing.reduce((m, c) => Math.max(m, c.chapter_number), 0) + 1;
      const id = `chapter_${bookId}_${String(n).padStart(3, '0')}`;
      const ch = deps.repos.chapters.create({
        id,
        bookId,
        chapterNumber: n,
        title: `第 ${n} 章`,
        status: 'DRAFT',
      });
      log.info('已创建章节', { chapterId: ch.id, chapterNumber: n });
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

      let hitCount = 0;
      try {
        const terms = query.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
        if (terms.length > 0) {
          const rows = deps.db.all<{ chapter_id: string; score: number }>(
            `SELECT c.id AS chapter_id, bm25(chapter_fts) AS score
               FROM chapter_fts
               JOIN chapters c ON c.rowid = chapter_fts.rowid
              WHERE chapter_fts MATCH ? AND c.book_id = ?
              ORDER BY score LIMIT 8`,
            terms,
            ch.book_id,
          );
          hitCount = rows.length;
          for (const r of rows) {
            trace.push({
              query,
              retriever: 'chapter_fts',
              hitId: r.chapter_id,
              score: r.score,
              sourceRef: `chapter:${r.chapter_id}`,
              reason: 'BM25 章节级检索命中',
            });
          }
        }
      } catch (e) {
        // ⚠ 检索失败不阻断写作（FTS 可能未建索引），但必须如实记录
        log.warn('章节级检索失败（不阻断写作）', {
          error: e instanceof Error ? e.message : String(e),
        });
      }

      return {
        contextSummary: {
          chapterId: ch.id,
          chapterNumber: ch.chapter_number,
          query,
          retrievalHits: hitCount,
        },
        retrievalTrace: trace,
      };
    },

    // ── 3. 规划 ──
    async plan(input) {
      const ch = needChapter(deps, input.chapterId);
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

      const res = await planner.plan({
        chapterNumber: ch.chapter_number,
        contextText: '',
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
      return {
        planPath: ws.pathOf('plan'),
        sceneCount: res.plan.scenes.length,
        contentHash: '',
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
      const model = needModel(deps, '生成正文');
      const plan = deps.repos.chapters.readPlan<unknown>(ch.id);
      if (!plan) {
        throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '该章节还没有计划，请先规划');
      }
      const ws = workspaceFor(ch.chapter_number);
      const { rows: skillRows, genre } = deps.loadSkills();

      const writer = new Writer({
        complete: (req) => model.completeText('writer', req) as never,
        workspace: ws,
        logger: deps.logger.child('writer'),
        skillRows: skillRows as never,
        genre,
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
        contentHash: '',
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

      const review = await reviewer.review({
        chapterNumber: ch.chapter_number,
        draftText: draft,
        contextText: '',
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

      return {
        reportPath: ws.pathOf('review'),
        contentHash: '',
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
        contentHash: '',
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

      return {
        reportPath: ws.pathOf('continuity'),
        contentHash: '',
        // ⚠ ContinuityChecker 的 severity 只有 BLOCKING / WARNING（无 HIGH）——
        //   实测确认。写 HIGH 会让这个判断永远为假，静默漏掉阻塞问题。
        blockingCount: report.issues.filter((i) => i.severity === 'BLOCKING').length,
        checkedAgainst: [],
      };
    },

    // ── 9. 状态结算（P0-4 的接口位；完整实现属该任务）──
    //
    // ⚠ 现在如实返回"未实现"，**不假装成功**。
    //   若这里返回 verified:true 而实际没验证，就会让未验证的状态
    //   被当成已验证而进入 Canon —— 那正是 P0-4 要防的事。
    async settleState(input) {
      const ch = needChapter(deps, input.chapterId);
      log.warn('状态结算尚未实现（P0-4 待办），如实标为未验证', { chapterId: ch.id });
      return {
        proposalId: null,
        verified: false,
        factCount: 0,
        characterStateCount: 0,
        timelineEventCount: 0,
        rejected: ['状态结算未实现（P0-4）：本阶段不做任何状态提取'],
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

      if (ws.readText('draft') === null) missing.push('工作区没有草稿');

      const report = deps.repos.chapters.readReview<{ issues: ReviewIssue[] }>(ch.id);
      if (report === null) {
        missing.push('没有审查报告');
      } else {
        const blocking = (report.issues ?? []).filter((i) => i.severity === 'BLOCKING').length;
        if (blocking > 0) missing.push(`仍有 ${blocking} 个 BLOCKING 问题未解决`);
      }

      // §十二：摘要必须存在且已批准
      const summary = ch.summary;
      if (summary === null || summary === undefined || String(summary).trim() === '') {
        missing.push('章节摘要为空（Commit 需要摘要）');
      } else if (ch.summary_approved !== 1) {
        missing.push('章节摘要尚未人工批准（§十二：summary_approved != 1）');
      }

      return { ok: missing.length === 0, missing };
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
