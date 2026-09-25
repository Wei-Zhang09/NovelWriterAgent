/**
 * Review 工具（施工文档 §32/§33，STEP 8）
 *
 * `review.run` 的权限是 PROPOSE_WRITE —— 它产出审阅结论，不改正文。
 * 与 chapter.plan 同级：都是"提议"，不是"提交"。
 */
import { z } from 'zod';
import { AppError, ErrorCode } from '@nwa/core';
import {
  ReviewOutputSchema,
  MVP_REVIEW_CATEGORIES,
  deriveStatus,
  type AnyToolDefinition,
  type ToolDefinition,
} from '@nwa/shared';
import type { Repositories } from '@nwa/storage';

export function createReviewTools(repos: Repositories): AnyToolDefinition[] {
  /**
   * 保存审阅结果。
   *
   * ⚠ 关键约束：**只有 BLOCKING = 0 才允许把章节推进**。
   *   但本工具**不做**状态推进 —— 推进由状态机门禁负责（§8.1）。
   *   这里只落库 + 回报 canCommit，避免工具成为绕过门禁的后门。
   */
  const reviewRun: ToolDefinition<
    // ⚠ z.unknown() 被 Zod 推导为可选（unknown 含 undefined）→ 签名对齐，
    //   在 execute 内强制存在性校验（与 STEP 6 的 chapter.plan 同一处理）
    { chapterId: string; review?: unknown; sourceHash?: string | null },
    {
      chapterId: string;
      status: string;
      issueCount: number;
      blockingCount: number;
      canCommit: boolean;
      saved: true;
    }
  > = {
    name: 'review.run',
    description: '保存一章的审阅结果（issues 列表）。不修改正文，不推进状态。',
    inputSchema: z.object({
      chapterId: z.string().min(1),
      review: z.custom<unknown>(() => true),
      /**
       * 版本锚点（M1 / §19）：这份审阅所依据的正文内容哈希。
       *
       * ⚠ 由**宿主**提供（`review` 服务侧从它实际检查的文本算出），
       *   不从 `review` 参数里取 —— 见 execute 里的强制覆盖。
       *   缺省（老调用方未传）则锚点落 null，判定为 NO_ANCHOR。
       */
      sourceHash: z.string().nullish(),
    }),
    outputSchema: z.object({
      chapterId: z.string(),
      status: z.string(),
      issueCount: z.number().int(),
      blockingCount: z.number().int(),
      canCommit: z.boolean(),
      saved: z.literal(true),
    }),
    permission: 'PROPOSE_WRITE',
    errorCodes: [ErrorCode.TOOL_VALIDATION_ERROR, ErrorCode.STORAGE_QUERY_FAILED],
    execute: (input) => {
      if (input.review === undefined || input.review === null) {
        throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '缺少 review 参数');
      }

      // 不信任传入形状：按 §32 契约校验
      const parsed = ReviewOutputSchema.safeParse(input.review);
      if (!parsed.success) {
        throw new AppError(
          ErrorCode.TOOL_VALIDATION_ERROR,
          `审阅结果不符合 ReviewOutput 契约（§32）：${parsed.error.issues[0]?.message ?? ''}`,
          {
            details: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        );
      }

      const chapter = repos.chapters.get(input.chapterId);

      // 已提交的章节不允许再覆盖审阅结果
      if (chapter.status === 'COMMITTED' || chapter.status === 'COMMITTING') {
        throw new AppError(
          ErrorCode.COMMIT_FAILED,
          `拒绝为已提交/提交中的章节覆盖审阅结果（当前状态 ${chapter.status}）`,
          { details: { chapterId: chapter.id, status: chapter.status } },
        );
      }

      // ⚠ 状态由 issues 机械推导，不采信 review.overallStatus
      const status = deriveStatus(parsed.data.issues);

      // ⚠ 版本锚点（M1 / §19）：**无条件覆盖**，不采信传入的 review.sourceHash。
      //
      //   为什么必须覆盖：`review` 参数在 workflow 里是由**模型输出**构造的。
      //   模型若随手填一个 hash，stale 判定就会拿一个假锚点去比对 ——
      //   结果是"永远 FRESH"，比完全没有锚点更糟（有检查的样子，没有检查的作用）。
      //   宿主没给（老调用方）就置 null → NO_ANCHOR → 拒绝提交但如实说明。
      const anchoredReview = {
        ...parsed.data,
        overallStatus: status,
        sourceHash: input.sourceHash ?? null,
      };
      const blockingCount = parsed.data.issues.filter((i) => i.severity === 'BLOCKING').length;

      repos.chapters.saveReview(chapter.id, anchoredReview, status);

      return {
        chapterId: chapter.id,
        status,
        issueCount: parsed.data.issues.length,
        blockingCount,
        canCommit: blockingCount === 0,
        saved: true as const,
      };
    },
  };

  /** 读取已保存的审阅结果 */
  const reviewGet: ToolDefinition<
    { chapterId: string },
    { chapterId: string; review?: unknown; canCommit: boolean }
  > = {
    name: 'review.get',
    description: '读取章节的审阅结果；不存在时为 null',
    inputSchema: z.object({ chapterId: z.string().min(1) }),
    outputSchema: z.object({
      chapterId: z.string(),
      review: z.custom<unknown>(() => true).nullable(),
      canCommit: z.boolean(),
    }),
    permission: 'READ',
    errorCodes: [ErrorCode.TOOL_VALIDATION_ERROR, ErrorCode.STORAGE_QUERY_FAILED],
    execute: ({ chapterId }) => {
      const chapter = repos.chapters.get(chapterId);
      const raw = repos.chapters.readReview<unknown>(chapterId);

      let canCommit = false;
      if (raw !== null) {
        const parsed = ReviewOutputSchema.safeParse(raw);
        if (parsed.success) {
          canCommit = !parsed.data.issues.some((i) => i.severity === 'BLOCKING');
        }
        // 校验失败的旧数据 → canCommit 保持 false（宁严不宽）
      }

      return { chapterId: chapter.id, review: raw, canCommit };
    },
  };

  /** 列出 MVP 启用的审阅类别（UI 展示"检查了什么"） */
  const reviewCategories: ToolDefinition<Record<string, never>, { categories: readonly string[] }> = {
    name: 'review.categories',
    description: '返回 MVP 启用的审阅类别',
    inputSchema: z.object({}),
    outputSchema: z.object({ categories: z.array(z.string()) }),
    permission: 'READ',
    errorCodes: [ErrorCode.TOOL_VALIDATION_ERROR],
    execute: () => ({ categories: [...MVP_REVIEW_CATEGORIES] }),
  };

  return [reviewRun, reviewGet, reviewCategories];
}
