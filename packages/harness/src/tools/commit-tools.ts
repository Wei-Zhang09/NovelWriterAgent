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
import { AppError, ErrorCode } from '@nwa/core';
import type { AnyToolDefinition, ToolDefinition } from '@nwa/shared';
import type { Repositories, Database } from '@nwa/storage';
import { CommitEngine } from '../commit/commit-engine.js';

export function createCommitTools(
  deps: {
    readonly db: Database;
    readonly repos: Repositories;
    readonly rootDir: string;
    readonly logger: import('@nwa/core').Logger;
    /** 读取工作区正文（由调用方注入，避免 harness 依赖 story） */
    readonly readWorkspaceText: (chapterNumber: number, name: 'draft' | 'revision') => string | null;
    /** 门禁检查（由调用方注入 TransitionGate 的结果） */
    readonly assertGateOpen?: (chapterId: string) => void;
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
      const n = String(chapter.chapter_number).padStart(3, '0');

      // 源优先取 revision（修订稿），退回 draft
      const revision = deps.readWorkspaceText(chapter.chapter_number, 'revision');
      const draft = deps.readWorkspaceText(chapter.chapter_number, 'draft');
      const body = revision ?? draft;
      const source = revision !== null ? 'revision.md' : 'draft.md';

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

      const willWrite = [
        { path: `chapters/${n}.md`, bytes: body ? Buffer.byteLength(body, 'utf8') : 0 },
        { path: `summaries/${n}.md`, bytes: chapter.summary ? Buffer.byteLength(chapter.summary, 'utf8') : 0 },
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
    { chapterId: string; commitMode?: 'clean' | 'with_debt' },
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
      commitMode: z.enum(['clean', 'with_debt']).optional(),
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
      const n = String(chapter.chapter_number).padStart(3, '0');
      const chapterPath = `chapters/${n}.md`;

      // 门禁必须开
      if (deps.assertGateOpen) deps.assertGateOpen(input.chapterId);
      if (deps.repos.chapters.hasBlockingReview(input.chapterId)) {
        throw new AppError(
          ErrorCode.COMMIT_FAILED,
          '拒绝提交：审阅仍有 BLOCKING 问题（§33）',
          { details: { chapterId: input.chapterId } },
        );
      }

      const revision = deps.readWorkspaceText(chapter.chapter_number, 'revision');
      const draft = deps.readWorkspaceText(chapter.chapter_number, 'draft');
      const body = revision ?? draft;
      if (body === null) {
        throw new AppError(
          ErrorCode.TOOL_VALIDATION_ERROR,
          `第 ${chapter.chapter_number} 章工作区没有正文可提交`,
        );
      }

      const engine = new CommitEngine({
        db: deps.db,
        repos: deps.repos,
        rootDir: deps.rootDir,
        logger: deps.logger,
      });

      const report = engine.commit({
        chapterId: chapter.id,
        chapterNumber: chapter.chapter_number,
        body,
        summary: chapter.summary ?? `第 ${chapter.chapter_number} 章`,
        commitMode: input.commitMode ?? 'clean',
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
