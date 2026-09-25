/**
 * Commit 工具（施工文档 §35 / §36，ADR-0002）【MVP 门槛】
 *
 * 权限全部是 **COMMIT** 级 —— 这是整个系统里唯一能改变"正式章节"的操作。
 * 与其他工具的分级差异是刻意的：
 *   Writer 写工作区（PROPOSE_WRITE）
 *   Commit 把工作区产物迁移成正式章节（COMMIT）
 *
 * ⚠ proposeCommit 与 commit 分成两个工具，而不是一个带参数的：
 *   前者只**预检并生成 manifest**（不写文件），后者才真正执行。
 *   这样 UI 可以先告诉用户"会发生什么"，用户确认后再执行 ——
 *   提交是不可逆的，不该一键完成。
 */
import { z } from 'zod';
import { AppError, ErrorCode, chapterRel, summaryRel } from '@nwa/core';
import { commitOverrideId } from '@nwa/core';
import type { AnyToolDefinition, ToolDefinition } from '@nwa/shared';
import type { Repositories, Database } from '@nwa/storage';
import { CommitEngine } from '../commit/commit-engine.js';

/**
 * 提交源优先级链（ADR-0008）。
 *
 * ⚠ 顺序不可调换：manuscript 是**用户当前正文**，必须优先于
 *   revision（AI 修订建议）与 draft（AI 初稿）。
 *
 * 在此之前的提交源是 `revision ?? draft` —— **从不读用户正文**，
 * 用户改完点提交会被静默丢弃，且不报错（revision 总能取到值）。
 * 这是"看起来全绿、实际丢数据"，比直接失败危险得多。
 */
export const COMMIT_SOURCE_ORDER = ['manuscript', 'revision', 'draft'] as const;

/** 提交源的候选键 */
export type CommitSourceKey = (typeof COMMIT_SOURCE_ORDER)[number];

/** 提交源对应的文件名（写入 manifest.source，可追溯"这次提交的是哪份稿"） */
export const COMMIT_SOURCE_FILE: Readonly<Record<CommitSourceKey, string>> = {
  manuscript: 'manuscript.md',
  revision: 'revision.md',
  draft: 'draft.md',
};

/**
 * 按优先级链取**当前正文**（ADR-0008）。
 *
 * 顺序：manuscript ?? revision ?? draft
 *
 * ⚠ 抽成单一实现而非在各处各写一遍 —— 预览、真实提交、审阅、连续性检查、
 *   状态结算**必须针对同一份文本**，否则"审阅通过"这句话描述的是另一份稿子。
 *   那是与 F1 同一类的缺陷：检查的对象 ≠ 提交的对象，
 *   门禁看起来在工作，实际管着别的东西。
 *
 * ⚠ 导出而不是留在本文件内部：M1 之后 app 层的 review / continuity /
 *   settleState 都用它取正文，三者与 commit 由**同一个函数**决定"当前正文是哪份"。
 */
export function pickCommitSource(
  deps: {
    /**
     * ⚠ `bookId` 是**第一个**参数：工作区按书隔离（P0-1），
     *   不带书就读到别的书的稿子。设为必填让"忘记传书"编译期暴露。
     */
    readonly readWorkspaceText: (
      bookId: string,
      chapterNumber: number,
      name: CommitSourceKey,
    ) => string | null;
  },
  bookId: string,
  chapterNumber: number,
): { body: string | null; source: string } {
  for (const key of COMMIT_SOURCE_ORDER) {
    const text = deps.readWorkspaceText(bookId, chapterNumber, key);
    if (text !== null) {
      return { body: text, source: COMMIT_SOURCE_FILE[key] };
    }
  }
  // 三份都不存在：body=null 由调用方决定怎么报错（dryRun 报 blocker，
  // 真实提交抛 AppError）。source 回落到 draft.md 只是为了类型完整，
  // 此时它没有语义 —— 调用方必须在 body===null 时忽略 source。
  return { body: null, source: COMMIT_SOURCE_FILE.draft };
}

export function createCommitTools(
  deps: {
    readonly db: Database;
    readonly repos: Repositories;
    readonly rootDir: string;
    readonly logger: import('@nwa/core').Logger;
    /** 读取工作区正文（由调用方注入，避免 harness 依赖 story） */
    readonly readWorkspaceText: (
      bookId: string,
      chapterNumber: number,
      name: CommitSourceKey,
    ) => string | null;
    /** 门禁检查（由调用方注入 TransitionGate 的结果） */
    readonly assertGateOpen?: (chapterId: string) => void;
    /**
     * FTS 索引器（可选）。由 app 层注入 —— harness 不依赖 @nwa/retrieval。
     * 缺省时提交仍成功，但 manifest 保留 pending 标记。
     */
    readonly indexer?: {
      indexChapter(input: {
        chapterId: string;
        bookId: string;
        chapterNumber: number;
        body: string;
        sourceRef: string;
      }): void;
    };
  },
): AnyToolDefinition[] {
  /**
   * 提交前预检：门禁 + 产物 + 工作区状态。
   * ⚠ 不写任何东西 —— 只回答"能不能提交、会发生什么"。
   */
  const proposeCommit: ToolDefinition<
    { chapterId: string },
    {
      chapterId: string;
      chapterNumber: number;
      ready: boolean;
      blockers: readonly string[];
      willWrite: readonly { path: string; bytes: number }[];
      source: string;
    }
  > = {
    name: 'workspace.proposeCommit',
    description: '提交前预检：报告阻塞项与将要写入的文件。不修改任何数据。',
    inputSchema: z.object({ chapterId: z.string().min(1) }),
    outputSchema: z.object({
      chapterId: z.string(),
      chapterNumber: z.number().int(),
      ready: z.boolean(),
      blockers: z.array(z.string()),
      willWrite: z.array(z.object({ path: z.string(), bytes: z.number().int() })),
      source: z.string(),
    }),
    permission: 'READ',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED, ErrorCode.TOOL_VALIDATION_ERROR],
    execute: ({ chapterId }) => {
      const chapter = deps.repos.chapters.get(chapterId);

      // 源优先级链（ADR-0008）：manuscript ?? revision ?? draft
      //
      // ⚠ 用户正文优先。此前是 `revision ?? draft`，**从不读用户正文**，
      //   用户改完点提交会被静默丢弃且不报错 —— 见 COMMIT_SOURCE_ORDER 注释。
      const picked = pickCommitSource(deps, chapter.book_id, chapter.chapter_number);
      const body = picked.body;
      const source = picked.source;

      const blockers: string[] = [];
      if (body === null) blockers.push('工作区没有正文可提交（revision.md / draft.md 都不存在）');
      if (deps.repos.chapters.hasBlockingReview(chapterId)) {
        blockers.push('审阅存在 BLOCKING 问题（§33：只有 BLOCKING = 0 才能提交）');
      }
      if (deps.assertGateOpen) {
        try {
          deps.assertGateOpen(chapterId);
        } catch (e) {
          blockers.push(e instanceof Error ? e.message : String(e));
        }
      }

      // ⚠ 预览路径必须与真实落盘**同一个来源**（chapterRel/summaryRel），
      //   否则"将要写入"与实际写入会漂移，而这个预览正是用户点提交前看的。
      const willWrite = [
        {
          path: chapterRel(chapter.book_id, chapter.chapter_number),
          bytes: body ? Buffer.byteLength(body, 'utf8') : 0,
        },
        {
          path: summaryRel(chapter.book_id, chapter.chapter_number),
          bytes: chapter.summary ? Buffer.byteLength(chapter.summary, 'utf8') : 0,
        },
        { path: 'artifacts/index.json', bytes: 0 },
      ];

      return {
        chapterId: chapter.id,
        chapterNumber: chapter.chapter_number,
        ready: blockers.length === 0,
        blockers,
        willWrite,
        source,
      };
    },
  };

  /**
   * 执行提交。
   *
   * ⚠ 权限 COMMIT —— 唯一能把章节变成正式章节的入口。
   */
  const commit: ToolDefinition<
    { chapterId: string; commitMode?: 'clean' | 'with_debt' | 'FORCE'; forceReason?: string },
    {
      ok: boolean;
      manifestId: string;
      status: string;
      phase: string;
      appliedCount: number;
      chapterPath: string;
      error?: { code: string; message: string };
    }
  > = {
    name: 'workspace.commit',
    description:
      '执行原子提交：把工作区正文写入正式章节并更新状态。三阶段 PREPARE→APPLY→VERIFY，可恢复。',
    inputSchema: z.object({
      chapterId: z.string().min(1),
      /**
       * clean      —— 正常提交（默认）
       * with_debt  —— 带着已知质量债提交（ADR-0005）
       * FORCE      —— **显式绕过硬性前置检查**（P1 / §十二）。
       *               ⚠ 与 with_debt 语义不同，不可混用：with_debt 承认
       *               "有问题但可接受"，FORCE 是"我知道这检查不过，仍要提交"。
       *               使用它会写一条 commit_overrides 审计记录。
       */
      commitMode: z.enum(['clean', 'with_debt', 'FORCE']).optional(),
      /** 绕过的理由（仅在 commitMode='FORCE' 时有意义，记入审计） */
      forceReason: z.string().max(500).optional(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      manifestId: z.string(),
      status: z.string(),
      phase: z.string(),
      appliedCount: z.number().int(),
      chapterPath: z.string(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    }),
    permission: 'COMMIT',
    errorCodes: [
      ErrorCode.COMMIT_FAILED,
      ErrorCode.TOOL_VALIDATION_ERROR,
      ErrorCode.STORAGE_QUERY_FAILED,
    ],
    execute: (input) => {
      const chapter = deps.repos.chapters.get(input.chapterId);
      // ⚠ 按书隔离（P0-1）：用章节行自己的 book_id，不用任何"当前书"解析
      const chapterPath = chapterRel(chapter.book_id, chapter.chapter_number);

      // 门禁必须开
      if (deps.assertGateOpen) deps.assertGateOpen(input.chapterId);
      if (deps.repos.chapters.hasBlockingReview(input.chapterId)) {
        throw new AppError(
          ErrorCode.COMMIT_FAILED,
          '拒绝提交：审阅仍有 BLOCKING 问题（§33）',
          { details: { chapterId: input.chapterId } },
        );
      }

      const picked = pickCommitSource(deps, chapter.book_id, chapter.chapter_number);
      const body = picked.body;
      if (body === null) {
        throw new AppError(
          ErrorCode.TOOL_VALIDATION_ERROR,
          `第 ${chapter.chapter_number} 章工作区没有正文可提交`,
        );
      }

      // ⚠ 摘要必须**已人工批准**（§十二）才允许提交。
      //
      // 这里此前只检查 `summary` 非空 —— 但「摘要存在」≠「摘要已批准」。
      // 摘要生成后 summary_approved 仍为 0，必须由作者在 UI 确认；
      // 未确认的摘要**不进 FTS / Context**（summary-indexer 明确跳过），
      // 所以让它提交等于：这一章在库里，但它对后续章节的记忆贡献为零，
      // 而系统显示"提交成功"。跨章记忆会静默断裂。
      //
      // ⚠ 允许绕过，但必须显式且留痕（见 commit_overrides 表）：
      //   缺省 commitMode='clean' 不允许绕过；只有 'FORCE' 才跳过。
      //   没有正规通道的硬检查，绕过方式会变成改代码或直接改库 ——
      //   那样连"这章为什么没摘要"都查不出来。
      const summary = chapter.summary;
      const hasSummary = summary !== null && summary !== undefined && summary.trim().length > 0;
      const approved = chapter.summary_approved === 1;
      const forced = input.commitMode === 'FORCE';

      if (!hasSummary && !forced) {
        throw new AppError(
          ErrorCode.TOOL_VALIDATION_ERROR,
          `第 ${chapter.chapter_number} 章还没有摘要，拒绝提交。` +
            '摘要是后续章节的长程记忆来源（ADR-0006），缺失会导致跨章记忆断裂。' +
            '请先点「生成摘要」并在「摘要确认」面板中确认。' +
            '（确需无摘要提交：显式传 commitMode="FORCE"，会记入审计）',
          { details: { chapterId: chapter.id, missing: 'summary' } },
        );
      }

      if (hasSummary && !approved && !forced) {
        throw new AppError(
          ErrorCode.TOOL_VALIDATION_ERROR,
          `第 ${chapter.chapter_number} 章的摘要尚未人工批准，拒绝提交。` +
            '未批准的摘要不会进入检索与后续章节的上下文（§十二），' +
            '提交会让这一章的记忆贡献静默为零。' +
            '请先在「摘要确认」面板确认，或显式传 commitMode="FORCE"（会记入审计）。',
          { details: { chapterId: chapter.id, missing: 'summary_approved' } },
        );
      }

      // ⚠ 绕过必须留审计记录 —— 而且要在**真正提交之前**写。
      //   若先提交再记，提交过程中断就会留下一次无记录的绕过。
      if (forced && !approved) {
        deps.repos.commitOverrides.record({
          id: commitOverrideId(),
          chapterId: chapter.id,
          check: 'SUMMARY_APPROVAL',
          // ⚠ 记原始状态，不记合成布尔值：事后要能区分
          //   "当时摘要根本是空的" 与 "当时有摘要但没批准"。
          summaryPresentAtOverride: hasSummary,
          summaryApprovedAtOverride: approved,
          reason: input.forceReason ?? null,
          createdAt: new Date().toISOString(),
        });
        deps.logger.warn('Commit 强制绕过了摘要批准检查（已记审计）', {
          chapterId: chapter.id,
          chapterNumber: chapter.chapter_number,
          summaryPresent: hasSummary,
          summaryApproved: approved,
        });
      }

      const engine = new CommitEngine({
        db: deps.db,
        repos: deps.repos,
        rootDir: deps.rootDir,
        logger: deps.logger,
        ...(deps.indexer ? { indexer: deps.indexer } : {}),
      });

      const report = engine.commit({
        chapterId: chapter.id,
        // ⚠ 用章节行自己的 book_id（权威），不用 resolveBookId() 回退
        bookId: chapter.book_id,
        chapterNumber: chapter.chapter_number,
        body,
        // ⚠ 摘要必须**已有内容**才允许提交。
        //
        // 原先这里是 `chapter.summary ?? \`第 N 章\`` —— fallback 成标题，
        // 提交照常成功，于是 chapters.summary 恒为"第 N 章"，
        // 后续章节检索到的前情只有三个字，长程记忆**整条断裂**
        // （实测：第1章主角"林渊"→第2章变成"林秋"）。
        //
        // 那种"静默降级"比直接失败更糟：它让系统看起来在工作。
        // 因此改为**拒绝提交**，并明确告知缺哪一步。
        //
        // ⚠ FORCE 绕过时摘要可能为空：此时传空串而不是编造一个标题 ——
        //   编造标题正是上面那段注释描述的原始 bug。空摘要会被
        //   summary-indexer 跳过（它只索引已批准的非空摘要），
        //   于是"没有记忆"是可见且可解释的。
        summary: hasSummary ? summary : '',
        commitMode: input.commitMode ?? 'clean',
        // 记录正文取自哪份稿（ADR-0008）：验证「AI 不覆盖用户正文」
        // 是否被遵守，唯一办法就是看提交记录里写的是哪份。
        source: picked.source,
      });

      return {
        ok: report.ok,
        manifestId: report.manifestId,
        status: report.status,
        phase: report.phase,
        appliedCount: report.appliedCount,
        chapterPath,
        ...(report.error ? { error: { code: report.error.code, message: report.error.message } } : {}),
      };
    },
  };

  /** 启动恢复：检测并收尾未完成事务 */
  const recover: ToolDefinition<
    Record<string, never>,
    {
      scanned: number;
      repairedCount: number;
      needsHumanCount: number;
      repaired: readonly { manifestId: string; branch: string; verdict: string; resultingStatus: string }[];
      needsHuman: readonly { manifestId: string; branch: string; verdict: string }[];
    }
  > = {
    name: 'workspace.recover',
    description: '扫描未完成的提交事务并给出确定性判定与收尾。启动时自动调用。',
    inputSchema: z.object({}),
    outputSchema: z.object({
      scanned: z.number().int(),
      repairedCount: z.number().int(),
      needsHumanCount: z.number().int(),
      repaired: z.array(
        z.object({
          manifestId: z.string(),
          branch: z.string(),
          verdict: z.string(),
          resultingStatus: z.string(),
        }),
      ),
      needsHuman: z.array(
        z.object({ manifestId: z.string(), branch: z.string(), verdict: z.string() }),
      ),
    }),
    permission: 'COMMIT',
    errorCodes: [ErrorCode.COMMIT_FAILED, ErrorCode.STORAGE_QUERY_FAILED],
    execute: () => {
      const engine = new CommitEngine({
        db: deps.db,
        repos: deps.repos,
        rootDir: deps.rootDir,
        logger: deps.logger,
      });
      const r = engine.recoverOnStartup();
      return {
        scanned: r.scanned,
        repairedCount: r.repaired.length,
        needsHumanCount: r.needsHuman.length,
        repaired: r.repaired.map((d) => ({
          manifestId: d.manifestId,
          branch: d.branch,
          verdict: d.verdict,
          resultingStatus: d.resultingStatus,
        })),
        needsHuman: r.needsHuman.map((d) => ({
          manifestId: d.manifestId,
          branch: d.branch,
          verdict: d.verdict,
        })),
      };
    },
  };

  /** 列出提交历史（UI 展示） */
  const listManifests: ToolDefinition<
    { chapterId?: string },
    { manifests: readonly { manifestId: string; chapterId: string; status: string; phase: string; commitMode: string }[] }
  > = {
    name: 'workspace.listCommits',
    description: '列出提交记录（manifest）',
    inputSchema: z.object({ chapterId: z.string().optional() }),
    outputSchema: z.object({
      manifests: z.array(
        z.object({
          manifestId: z.string(),
          chapterId: z.string(),
          status: z.string(),
          phase: z.string(),
          commitMode: z.string(),
        }),
      ),
    }),
    permission: 'READ',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
    execute: (input) => {
      const rows = input.chapterId
        ? deps.db.all<{ id: string; chapter_id: string; status: string; phase: string; commit_mode: string }>(
            'SELECT id, chapter_id, status, phase, commit_mode FROM commit_manifests WHERE chapter_id = ? ORDER BY created_at DESC',
            input.chapterId,
          )
        : deps.db.all<{ id: string; chapter_id: string; status: string; phase: string; commit_mode: string }>(
            'SELECT id, chapter_id, status, phase, commit_mode FROM commit_manifests ORDER BY created_at DESC LIMIT 50',
          );
      return {
        manifests: rows.map((r) => ({
          manifestId: r.id,
          chapterId: r.chapter_id,
          status: r.status,
          phase: r.phase,
          commitMode: r.commit_mode,
        })),
      };
    },
  };

  return [proposeCommit, commit, recover, listManifests];
}
