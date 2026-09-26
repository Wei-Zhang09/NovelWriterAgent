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
  sha256Text,
  chapterRel,
} from '@nwa/core';
import type { Repositories, Database } from '@nwa/storage';
import { evaluateBookBlueprintGate } from '@nwa/storage';
import { ManuscriptRepository } from '@nwa/storage';
import type { ManuscriptVersionSource } from '@nwa/storage';
import type { ToolRegistry, NovelWorkflowServices } from '@nwa/harness';
import { pickCommitSource } from '@nwa/harness';
import {
  ConceptGenerator,
  SettingsGenerator,
  OutlineGenerator,
  ChapterOutlineGenerator,
  materializeSettings,
  detectSettingsConflicts,
} from '@nwa/writing';
import { assertBlueprintStep } from '@nwa/storage';
import type { CommitSourceKey } from '@nwa/harness';
import { hashOfFile } from '@nwa/harness';
import { evaluateSettingsGate, hashSettings, renderWorldRulesForReview } from '@nwa/core';
import {
  renderCharacterBlock,
  toCharacterBrief,
  selectRelevantCharacters,
  selectWorldSettings,
  toWorldBrief,
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

/**
 * 取全书预计章数（卷纲/细纲的**总量锚点**）。
 *
 * ⚠ 这是 Phase 1 选题里作者确认过的数字，是卷的章号范围必须自洽的基准。
 *   **绝不编造**：取不到就明确报错。
 *   若给一个假的总数，模型会按它划分卷范围 —— 而那个总数是编的，
 *   于是"200 章"这条不变量建立在虚构之上，且没有任何地方能发现。
 *   （llm-generation-pipelines 规则 17：确定性字段由代码算，
 *     取不到就是 absent，不给默认值。）
 */
function needEstimatedChapters(
  deps: WorkflowServicesDeps,
  bookId: string,
  params: Record<string, unknown>,
): number {
  // ① 调用方显式指定
  if (params['estimatedChapters']) {
    const n = Number(params['estimatedChapters']);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  // ② 从 Phase 1 选定的选题里取（作者确认过的那个数）
  const concept = deps.repos.blueprint.effectiveContent(
    deps.repos.blueprint.findStep(bookId, 'CONCEPT'),
  ) as { estimatedChapters?: unknown } | null;
  const fromConcept = concept?.estimatedChapters;
  if (typeof fromConcept === 'number' && fromConcept > 0) return fromConcept;

  throw new AppError(
    ErrorCode.BLUEPRINT_NOT_CONFIRMED,
    '无法确定全书预计章数 —— 请先在向导第一步选定选题方向（其中含预计章数），' +
      '或显式指定 estimatedChapters。这个数字是卷纲章号范围的基准，不能猜。',
    { details: { bookId, step: 'CONCEPT' } },
  );
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
 * 构造本章的世界观设定块（P2-3）。
 *
 * ⚠ 与角色块分开成两个函数，因为**筛选规则不同**：
 *   角色按"本章谁出场"筛（按章不同），
 *   世界观是整本书的不变量（第 3 章和第 30 章同样成立），不按章筛。
 *
 * ⚠ 只注入 CONFIRMED 的条目 —— 草稿是"作者还在改，先别当准"。
 *   草稿条数记入日志，作者能在界面上看到"有几条没生效"。
 */
/**
 * 逐章细纲注入（W5 开书向导 Phase 3）。
 *
 * ⚠ 与 `buildWorldContext` 同一判断：细纲是**增强**不是前置依赖 ——
 *   读细纲失败不该让整章写不出来（作者可能压根没用向导）。
 *
 * ⚠ 只注入**当前章**，不做 lookahead。
 *   把后面几章的细纲也塞进去会稀释当前章的信息
 *   （llm-generation-pipelines 规则 28：注入内容必须按相关性裁剪）。
 */
function buildChapterOutlineContext(
  deps: WorkflowServicesDeps,
  bookId: string,
  chapterNumber: number,
): string {
  try {
    return deps.repos.chapterOutlines.renderForPrompt(bookId, chapterNumber);
  } catch (e) {
    deps.logger.warn('章节细纲读取失败（本次不注入细纲）', {
      bookId,
      chapterNumber,
      error: e instanceof Error ? e.message : String(e),
    });
    return '';
  }
}

function buildWorldContext(deps: WorkflowServicesDeps, bookId: string): string {
  try {
    const all = deps.repos.world.listByBook(bookId).map(toWorldBrief);
    if (all.length === 0) return '';
    const sel = selectWorldSettings(all);
    if (sel.skippedDrafts > 0) {
      deps.logger.info('有草稿状态的设定未注入（未确认）', {
        bookId,
        used: sel.usedCount,
        skippedDrafts: sel.skippedDrafts,
      });
    }
    return sel.block;
  } catch (e) {
    // ⚠ 设定是**增强**不是前置依赖：读设定失败不该让整章写不出来
    //   （同 buildCharacterContext 的判断）。
    deps.logger.warn('世界观设定读取失败（本次不注入设定）', {
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

/**
 * 断言开书向导门禁已通过（W6）。
 *
 * ⚠ 这是**硬门禁**（用户决策：「最后确认一切前置信息后，再开始写作」）。
 *   判定逻辑本身在 `@nwa/core` 的 `evaluateBlueprintGate`（纯函数、可穷举单测），
 *   状态装配在 `@nwa/storage` 的 `blueprintStateOf`（唯一实现，与统一确认共用），
 *   这里只负责：读当前状态 → 判定 → 不通过时抛错。
 *
 * ⚠ 与 `assertSettingsGate` **并存不替代**：两道门禁管不同的事 ——
 *   那个拦"世界设定改了没确认"，这个拦"向导用了但没走完统一确认"。
 *
 * ⚠ 与 settings 门禁同样在 **plan 与 write 两处**都调用：
 *   只拦 write 的话，作者可以在前置未确认时先规划 —— 而计划一旦落库，
 *   Writer 就会按它写。门禁必须在"开始动脑"那一步就生效。
 */
function assertBlueprintGate(deps: WorkflowServicesDeps, bookId: string): void {
  let verdict;
  try {
    verdict = evaluateBookBlueprintGate(deps.repos, bookId);
  } catch (e) {
    // ⚠ 读状态失败是存储问题，不是门禁问题 —— 交给后续步骤报真正的错。
    //   在这里抛错会把"数据库坏了"报成"前置没确认"，指错方向。
    deps.logger.warn('开书向导门禁状态读取失败（本次不拦）', {
      bookId,
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  if (!verdict.allowed) {
    throw new AppError(ErrorCode.BLUEPRINT_NOT_CONFIRMED, verdict.message, {
      details: {
        bookId,
        reason: verdict.reason,
        unfinished: verdict.unfinished,
      },
    });
  }
}

export function createWorkflowServices(deps: WorkflowServicesDeps): NovelWorkflowServices {
  const log = deps.logger.child('workflow-services');

  /**
   * 章节工作区（按书隔离，P0-1）。
   *
   * ⚠ `bookId` 必填：工作区路径是 `books/<bookId>/workspace/chapter-NNN`，
   *   不带书就会落到别的书的工作区 —— 写 B 书会覆盖 A 书未提交的产物。
   */
  const workspaceFor = (bookId: string, chapterNumber: number): ChapterWorkspace => {
    const ws = new ChapterWorkspace({
      rootDir: deps.dir,
      bookId,
      chapterNumber,
      logger: deps.logger.child('workspace'),
    });
    ws.ensure();
    return ws;
  };

  /**
   * 用户正文仓储（M6 起在此建版本节点）。
   *
   * ⚠ 与 `workspaceFor` 是**两个不同的东西**，不要合并：
   *   ChapterWorkspace 管工作区产物（draft / revision / review…），
   *   ManuscriptRepository 管用户正文与版本节点。
   *   合并会让"AI 的产出"与"用户的产出"在代码层失去区分，
   *   而那正是 §15（AI 不得覆盖用户正文）要守住的东西。
   */
  const manuscriptRepo = (): ManuscriptRepository =>
    new ManuscriptRepository({
      db: deps.db,
      rootDir: deps.dir,
      logger: deps.logger.child('manuscript'),
    });

  /**
   * 建版本节点，**失败不阻断主流程**（M6）。
   *
   * ⚠ 为什么吞掉异常：版本记录是**辅助能力**，而调用它的是
   *   "生成草稿""改稿"这类主流程。若版本写入失败就让整章生成失败，
   *   等于用一个附加功能把核心功能拖垮 —— 代价完全不成比例。
   *
   *   但**必须留日志**：静默吞掉会让"版本历史缺了一段"变成
   *   无法解释的现象（作者只会看到版本列表少了几条）。
   */
  const recordVersion = (input: {
    /** 章节所属的书（版本内容路径按书隔离，P0-1） */
    bookId: string;
    chapterId: string;
    chapterNumber: number;
    text: string | null;
    sourceType: ManuscriptVersionSource;
    note?: string;
  }): void => {
    if (input.text === null) return;
    try {
      manuscriptRepo().createVersion({
        bookId: input.bookId,
        chapterId: input.chapterId,
        chapterNumber: input.chapterNumber,
        text: input.text,
        sourceType: input.sourceType,
        ...(input.note === undefined ? {} : { note: input.note }),
      });
    } catch (e) {
      log.warn('版本节点创建失败（不阻断主流程）', {
        chapterNumber: input.chapterNumber,
        sourceType: input.sourceType,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /**
   * 读**当前正文**（M1 / ADR-0008）。
   *
   * 顺序：manuscript ?? revision ?? draft —— 与提交源**同一个函数**
   * （`pickCommitSource`）决定。
   *
   * ⚠ 为什么必须共用：此前 review / continuity / settleState 各自读
   *   `draft`，而 commit 取 `manuscript ?? revision ?? draft`。
   *   用户改过正文后，这两者**不是同一份文本** ——
   *   "审阅通过"描述的是 AI 初稿，提交的却是用户手改稿。
   *   门禁看起来在工作，实际管着另一个对象。
   *   与 F1（提交源不读用户正文）是同一类缺陷，只是更深一层。
   *
   * ⚠ 不在这里抛"没有正文"：各 stage 的报错文案不同
   *   （"请先写正文" / "无法做连续性检查"），由调用方决定。
   */
  const readCurrentBody = (
    bookId: string,
    chapterNumber: number,
  ): { body: string | null; source: string } => {
    return pickCommitSource(
      {
        readWorkspaceText: (b: string, n: number, name: CommitSourceKey) =>
          workspaceFor(b, n).readText(name),
      },
      bookId,
      chapterNumber,
    );
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
    // ── 开书向导（W7 接线）──────────────────────────────────
    //
    // ⚠⚠ 这一段是 W2–W5 生成器**唯一的**生产入口。
    //   没有它，向导"能生成但不能落库" → 四步永远 NOT_STARTED →
    //   门禁判 NOT_USED → 永远放行。作者以为走完了向导，
    //   而门禁从没拦过，prompt 也从没读到过前置内容。
    blueprint: {
      async generateConcept(input) {
        const model = needModel(deps, '生成选题方向');
        const book = deps.repos.books.get(input.bookId);
        const gen = new ConceptGenerator({
          structured: (req) => model.structured('architect', req) as never,
          logger: log.child('concept'),
        });
        const res = await gen.generate({
          ...(input.params['desiredEmotion']
            ? { desiredEmotion: String(input.params['desiredEmotion']) }
            : {}),
          ...(input.params['strengths'] ? { strengths: String(input.params['strengths']) } : {}),
          ...(input.params['reference'] ? { reference: String(input.params['reference']) } : {}),
          ...(input.params['existingIdea']
            ? { existingIdea: String(input.params['existingIdea']) }
            : {}),
          ...(input.params['genre'] ? { genre: String(input.params['genre']) } : {}),
          bookTitle: book.title,
        });
        if (!res.ok || !res.output) {
          throw new AppError(
            ErrorCode.MODEL_STRUCTURED_EMPTY,
            res.error?.message ?? '选题方向生成失败',
            { details: { issues: res.issues ?? [] } },
          );
        }
        // ⚠ 不落库：候选要等作者选（用户诉求「再由用户进行选择」）
        return {
          candidates: res.output.candidates,
          ...(res.issues ? { issues: res.issues } : {}),
          attempts: res.attempts,
        };
      },

      async chooseConcept(input) {
        // ⚠ 作者选定 → 存 draft（不存 edited：这是 AI 原稿，作者还没改）
        const row = deps.repos.blueprint.saveDraft(input.bookId, 'CONCEPT', input.candidate);
        log.info('选题方向已选定', { bookId: input.bookId });
        return { step: row.step, status: row.status };
      },

      async generateSettings(input) {
        const model = needModel(deps, '生成核心设定');
        // ⚠ 依赖 CONCEPT 步：Phase 2 必须围绕作者选定的方向，
        //   否则生成出来的设定与选题无关（作者会以为是模型跑偏）
        const conceptRow = deps.repos.blueprint.findStep(input.bookId, 'CONCEPT');
        const concept = deps.repos.blueprint.effectiveContent(conceptRow);
        if (!concept) {
          throw new AppError(
            ErrorCode.BLUEPRINT_NOT_CONFIRMED,
            '还没有选定选题方向 —— 请先在向导第一步生成并选择一个方向',
            { details: { bookId: input.bookId, step: 'CONCEPT' } },
          );
        }
        const gen = new SettingsGenerator({
          structured: (req) => model.structured('architect', req) as never,
          logger: log.child('settings'),
        });
        // 作者已手写的角色/设定要传进去（避免模型提议同名项）
        // ⚠ 形状是 {name, summary} —— 传进去让模型"别重复提议这些名字"。
        //   光靠提示词不够（模型仍可能重复），所以冲突检出是必需的机制。
        const existingCharacters = deps.repos.characters.listByBook(input.bookId).map((c) => ({
          name: c.name,
          summary: c.role ?? c.current_status ?? '',
        }));
        const existingWorld = deps.repos.world.listByBook(input.bookId).map((w) => ({
          name: w.name,
          summary: w.description ?? '',
        }));

        const res = await gen.generate({
          concept: concept as never,
          bookTitle: deps.repos.books.get(input.bookId).title,
          existingCharacters,
          existingWorld,
        });
        if (!res.ok || !res.output) {
          throw new AppError(
            ErrorCode.MODEL_STRUCTURED_EMPTY,
            res.error?.message ?? '核心设定生成失败',
            { details: { issues: res.issues ?? [] } },
          );
        }
        // ⚠ 落库为草稿：作者要逐条决定冲突之后才物化进正式表
        deps.repos.blueprint.saveDraft(input.bookId, 'SETTINGS', res.output);
        // ⚠ 冲突**现算**（SettingsOutput 里没有 conflicts 字段）：
        //   作者要逐条决定的就是这些。不传给界面的话，
        //   物化时会因"决定缺失"而保守跳过 —— 看起来像"生成成功但没落库"。
        const conflicts = detectSettingsConflicts(res.output, {
          characters: existingCharacters,
          world: existingWorld,
        });
        return {
          characters: res.output.characters,
          worldEntities: res.output.worldEntities,
          conflicts,
          ...(res.issues ? { issues: res.issues } : {}),
          attempts: res.attempts,
        };
      },

      async materializeSettings(input) {
        // ⚠ 只执行作者的决定，不做决定（决定权在作者）
        const r = materializeSettings(deps.repos, {
          bookId: input.bookId,
          output: input.output as never,
          decisions: input.decisions as never,
          knownConflicts: input.knownConflicts,
        });
        log.info('设定已物化进正式表', {
          bookId: input.bookId,
          characters: r.charactersCreated.length,
          world: r.worldCreated.length,
          skipped: r.skipped.length,
          vanished: r.vanished.length,
          newConflicts: r.newConflicts.length,
        });
        return {
          charactersCreated: r.charactersCreated,
          worldCreated: r.worldCreated,
          skipped: r.skipped,
          renamed: r.renamed,
          vanished: r.vanished,
          newConflicts: r.newConflicts,
        };
      },

      async generateOutline(input) {
        const model = needModel(deps, '生成卷级大纲');
        const gen = new OutlineGenerator({
          structured: (req) => model.structured('architect', req) as never,
          logger: log.child('outline'),
        });
        // 设定从正式表现取（那才是 prompt 读的）
        const res = await gen.generate({
          settings: {
            logline: String(input.params['logline'] ?? ''),
            coreConflict: String(input.params['coreConflict'] ?? ''),
            characters: deps.repos.characters
              .listByBook(input.bookId)
              .map((c) => ({ name: c.name, role: c.role })),
            worldEntities: deps.repos.world
              .listByBook(input.bookId)
              .map((w) => ({ name: w.name, description: w.description ?? '' })),
          },
          estimatedChapters: needEstimatedChapters(deps, input.bookId, input.params),
          bookTitle: deps.repos.books.get(input.bookId).title,
        });
        if (!res.ok || !res.output) {
          throw new AppError(
            ErrorCode.MODEL_STRUCTURED_EMPTY,
            res.error?.message ?? '卷级大纲生成失败',
            { details: { issues: res.issues ?? [] } },
          );
        }
        // ⚠ 卷**整体替换**（章号范围是全局不变量）—— 但已有卷时必须显式声明。
        //   首次生成时库里是空的，所以 replaceExisting: true 是安全的；
        //   重新生成会覆盖作者的逐卷修改，故记日志让这件事可审计。
        const had = deps.repos.volumes.countByBook(input.bookId);
        deps.repos.volumes.replaceAll(input.bookId, res.output, { replaceExisting: had > 0 });
        if (had > 0) {
          log.warn('卷级大纲被整体替换（原卷与作者的逐卷修改已覆盖）', {
            bookId: input.bookId,
            previousVolumes: had,
            newVolumes: res.output.volumes.length,
          });
        }
        deps.repos.blueprint.saveDraft(input.bookId, 'OUTLINE', res.output);
        return {
          volumes: res.output.volumes,
          ...(res.issues ? { issues: res.issues } : {}),
          attempts: res.attempts,
        };
      },

      async generateChapterOutlines(input) {
        const model = needModel(deps, '生成逐章细纲');
        const gen = new ChapterOutlineGenerator({
          structured: (req) => model.structured('architect', req) as never,
          logger: log.child('detail'),
        });
        const book = deps.repos.books.get(input.bookId);
        const res = await gen.generate({
          settings: {
            logline: String(input.params['logline'] ?? ''),
            coreConflict: String(input.params['coreConflict'] ?? ''),
            // ⚠ 这个 request 的字段是**可选**（`role?: string`），
            //   而 DB 给的是 `string | null` —— null 要转成 undefined，
            //   否则类型不匹配（null 是"明确没有"，undefined 是"没提供"）。
            characters: deps.repos.characters.listByBook(input.bookId).map((c) => ({
              name: c.name,
              ...(c.role !== null ? { role: c.role } : {}),
            })),
            worldEntities: deps.repos.world.listByBook(input.bookId).map((w) => ({
              name: w.name,
              ...(w.description !== null ? { description: w.description } : {}),
            })),
          },
          startChapter: input.startChapter,
          endChapter: input.endChapter,
          ...(input.params['estimatedChapters']
            ? { estimatedChapters: Number(input.params['estimatedChapters']) }
            : {}),
          bookTitle: book.title,
        });
        if (!res.ok || !res.output) {
          throw new AppError(
            ErrorCode.MODEL_STRUCTURED_EMPTY,
            res.error?.message ?? '逐章细纲生成失败',
            { details: { issues: res.issues ?? [] } },
          );
        }
        // ⚠ 按章 upsert（分批不互相覆盖 —— 与卷相反）
        const w = deps.repos.chapterOutlines.upsertBatch(input.bookId, res.output);
        deps.repos.blueprint.saveDraft(input.bookId, 'DETAIL', res.output);
        return {
          outlines: res.output.outlines,
          created: w.created,
          updated: w.updated,
          ...(res.issues ? { issues: res.issues } : {}),
          attempts: res.attempts,
        };
      },

      async saveStep(input) {
        // ⚠ 存 edited（不覆盖 draft）—— 作者点"重新生成"时不能丢掉自己改过的内容
        const row = deps.repos.blueprint.saveEdited(
          input.bookId,
          assertBlueprintStep(input.step),
          input.content,
        );
        return { step: row.step, status: row.status };
      },
    },

    async plan(input) {
      const ch = needChapter(deps, input.chapterId);
      // ⚠ 设定门禁（P2-3）：在"开始动脑"这一步就拦，而不是等写完再拦
      assertSettingsGate(deps, ch.book_id);
      // ⚠ 开书向导门禁（W6）：前置内容未统一确认 → 不许开始规划。
      //   与 settings 门禁同处调用，理由相同：计划一旦落库，
      //   Writer 就会按它写 —— 门禁必须在"开始动脑"那一步生效。
      assertBlueprintGate(deps, ch.book_id);
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
      // ⚠ 世界观设定（P2-3）：只注入作者**已确认**的条目。
      //   确认这个动作的意义就在这里 —— 不然它只是"让 Agent 别拦我"，
      //   而不是"让 Agent 按设定写"。
      const worldContext = buildWorldContext(deps, ch.book_id);
      // ⚠ 逐章细纲（W5）：作者在开书向导里确认过的本章意图。
      //
      //   这是细纲存在的**唯一意义** —— 它必须进 prompt，否则只是
      //   一份"作者看过的文档"：门禁说"已确认"，模型却读不到，
      //   于是作者以为 Agent 按细纲在写，实际它什么都不知道。
      //   （W1 记录过的同一教训：`settings-gate` 的"门禁放行但 prompt
      //     读到别的内容"。）
      //
      //   注入位置与 world/character 相同（都进 contextText），
      //   因为这是 Planner 实际读取的那一个字段。
      //
      //   ⚠ 排在最前：细纲是"作者对本章的意图"，是**指令**；
      //     世界规则与角色卡是**约束**。意图先于约束读，
      //     模型才不会把细纲当成"众多参考之一"。
      const outlineContext = buildChapterOutlineContext(deps, ch.book_id, ch.chapter_number);
      // ⚠ 世界观排在角色之前：世界规则是"这个世界的物理定律"，
      //   人物是在定律之内活动的。顺序反了会让模型先定人物再迁就规则。
      const contextText = [outlineContext, worldContext, characterContext]
        .filter((s) => s.trim().length > 0)
        .join('\n\n');
      if (contextText.length > 0) {
        log.info('已注入设定（规划）', {
          chapterNumber: ch.chapter_number,
          outlineChars: outlineContext.length,
          worldChars: worldContext.length,
          charChars: characterContext.length,
        });
      }

      const res = await planner.plan({
        chapterNumber: ch.chapter_number,
        contextText,
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

      const ws = workspaceFor(ch.book_id, ch.chapter_number);
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
      // M6：版本节点需要这两个值，且必须与 save/listVersions 用的是**同一组**
      //   （chapterId 是主键、chapterNumber 决定文件路径，混用会写到别的章目录）
      const chapterId = ch.id;
      const chapterNumber = ch.chapter_number;
      // ⚠ 设定门禁（P2-3）：与 plan 一样要拦 —— 计划可能是门禁前就落库的
      assertSettingsGate(deps, ch.book_id);
      // ⚠ 开书向导门禁（W6）：与 plan 处同因 —— 两道都拦，
      //   否则"先规划再绕开"仍能写出与前置不符的正文。
      assertBlueprintGate(deps, ch.book_id);
      const model = needModel(deps, '生成正文');
      const plan = deps.repos.chapters.readPlan<unknown>(ch.id);
      if (!plan) {
        throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '该章节还没有计划，请先规划');
      }
      const ws = workspaceFor(ch.book_id, ch.chapter_number);
      const { rows: skillRows, genre } = deps.loadSkills();

      // ⚠ 角色设定（P2-2）：与 plan stage 共用同一个 helper，
      //   否则"规划时知道有谁"但"写作时忘了" —— 计划与正文对不上。
      //
      // ⚠ 提示文本用**本章计划**（含 brief.mainCharacters 与场景 purpose）：
      //   计划里点名的人正是这一章要写的人，比"上一章摘要"更准。
      const characterContext = buildCharacterContext(deps, ch.book_id, [
        JSON.stringify(plan),
      ]);
      // ⚠ 世界观设定（P2-3）：与 plan stage 共用同一 helper，保证
      //   "规划时遵守的规则"与"写作时遵守的规则"是同一套。
      const worldContext = buildWorldContext(deps, ch.book_id);

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
        ...(worldContext.trim().length > 0 ? { worldContext } : {}),
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
      // M6：Writer 出稿 → AI_DRAFT 版本节点（ADR-0008 §6）
      //
      // ⚠ 用 `readText('draft')` 而不是拼 `d.scenes` ——
      //   版本必须与**磁盘上的 draft.md 逐字相同**，
      //   否则"版本"与"产物"是两个东西，恢复出来的内容对不上。
      recordVersion({
        bookId: ch.book_id,
        chapterId,
        chapterNumber,
        text: ws.readText('draft'),
        sourceType: 'AI_DRAFT',
      });
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
      const ws = workspaceFor(ch.book_id, ch.chapter_number);
      // ⚠ 检查对象 = 提交对象（M1 / ADR-0008）：读当前正文而非固定读 draft。
      const current = readCurrentBody(ch.book_id, ch.chapter_number);
      const draft = current.body;
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

      // ⚠ 世界规则清单（P2-4）：机械判据只能覆盖"不可逆被推翻"这类
      //   明确情形，其余规则（"灵力稀薄""贵族不得经商"）需要模型结合
      //   上下文判断。把规则**原文 + id** 给出去，模型才能引用规则 id
      //   报 WORLD_RULE 问题（可复核），而不是凭感觉说"好像违反了世界观"。
      const confirmedWorldRules = deps.repos.world
        .listByBook(ch.book_id)
        .filter((r) => r.status === 'CONFIRMED')
        .map((r) => ({ id: r.id, name: r.name, description: r.description ?? '' }));
      const rulesText = renderWorldRulesForReview(confirmedWorldRules);

      const review = await reviewer.review({
        chapterNumber: ch.chapter_number,
        draftText: draft,
        contextText: [rulesText, evidenceText].filter((t) => t.trim().length > 0).join('\n\n'),
        deterministicIssues: deterministic,
      });

      const saved = await deps.tools.invoke(
        'review.run',
        {
          chapterId: ch.id,
          review: { overallStatus: review.status, issues: review.issues },
          // ⚠ 锚点从**实际被检查的文本**算出（与 draftText 同源），
          //   不由模型提供 —— 见 review-tools.ts 的强制覆盖。
          sourceHash: sha256Text(draft),
        },
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
        // M1 / §19：工作区副本与库内记录必须带**同一个**锚点，
        // 否则从文件读和从库读会得出不同的 stale 结论。
        sourceHash: sha256Text(draft),
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
      const ws = workspaceFor(ch.book_id, ch.chapter_number);
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

      // M6：Agent 修订产出 → AI_REVISION 版本节点
      //
      // ⚠ 这里记的是 **revision.md**（AI 的修订建议），不是 manuscript ——
      //   §15 要求 AI 修订不得自动覆盖用户正文，所以 revision 只是
      //   一个"候选版本"，作者显式接受后才会成为新的正文版本。
      //   把 revision 记成版本正是为了让作者能对比与接受。
      recordVersion({
        bookId: ch.book_id,
        chapterId: ch.id,
        chapterNumber: ch.chapter_number,
        text: ws.readText('revision'),
        sourceType: 'AI_REVISION',
        note: `应用 ${String(res.appliedEdits ?? 0)} 处替换`,
      });

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
      const ws = workspaceFor(ch.book_id, ch.chapter_number);
      // ⚠ 检查对象 = 提交对象（M1）：读当前正文，不固定读 draft。
      const draft = readCurrentBody(ch.book_id, ch.chapter_number).body;
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
      const ws = workspaceFor(ch.book_id, ch.chapter_number);
      // ⚠ 结算对象 = 提交对象（M1）：读当前正文，不固定读 draft。
      //   否则"提议已验证"针对的是 AI 初稿，而提交的是用户手改稿 ——
      //   进 Canon 的状态与正文实际发生的事对不上。
      const draft = readCurrentBody(ch.book_id, ch.chapter_number).body;
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
        sourceRef: chapterRel(ch.book_id, ch.chapter_number),
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
      const ws = workspaceFor(ch.book_id, ch.chapter_number);
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
      const ws = workspaceFor(ch.book_id, ch.chapter_number);
      if (ws.readText('draft') === null) problems.push('工作区草稿丢失');
      return { ok: problems.length === 0, problems };
    },
  };
}
