/**
 * Planner 相关的 Agent 工具（施工文档 §6.3 的 chapter.plan）
 *
 * 权限：`chapter.plan` 声明为 PROPOSE_WRITE —— 它产出计划但不写正式正文。
 * 这与会话文档 §6.4 的分级一致：计划属于"提议"，不是"提交"。
 */
import { z } from 'zod';
import { AppError, ErrorCode } from '@nwa/core';
import { PlanOutputSchema, type AnyToolDefinition, type ToolDefinition } from '@nwa/shared';
import type { Repositories } from '@nwa/storage';

/**
 * 保存计划的工具。
 *
 * ⚠ 注意：这里保存的是**章节计划**（chapters.plan_json），不是正文。
 *   正文路径 body_path 由 STEP 11 的 Commit 流程独占，本工具无权触碰。
 */
export function createPlanTools(
  repos: Repositories,
  opts?: {
    /**
     * 门禁检查（由调用方注入，与 commit-tools 同一形状）。
     *
     * ⚠ 必须注入：本工具**直接写库**（`repos.chapters.savePlan`），
     *   不经过 workflow-services 的服务层门禁。若不在这里拦，
     *   Agent 可以绕开开书向导门禁把计划写进去 ——
     *   而计划一旦落库，Writer 就会按它写。
     *   这是"同一件事有两条写入路径，只拦了一条"的典型。
     */
    readonly assertGateOpen?: (bookId: string) => void;
  },
): AnyToolDefinition[] {
  const chapterPlan: ToolDefinition<
    { chapterId: string; plan?: unknown; expectedChapterNumber?: number },
    { chapterId: string; chapterNumber: number; sceneCount: number; saved: true }
  > = {
    name: 'chapter.plan',
    description: '保存章节计划（brief + scenes）。不写正文，不改 Canon。',
    inputSchema: z.object({
      chapterId: z.string().min(1),
      /**
       * 计划内容。
       *
       * ⚠ 关于可选性：`unknown` 包含 undefined，因此 Zod 会把它视为**可选**字段。
       *   与其对抗类型系统，不如与之保持一致 —— 签名声明为可选，
       *   但在 execute 内**强制校验存在**（缺失即报 TOOL_VALIDATION_ERROR）。
       *   形状校验由 PlanOutputSchema 负责（宿主不信任调用方传入的结构）。
       */
      plan: z.custom<unknown>(() => true),
      expectedChapterNumber: z.number().int().positive().optional(),
    }),
    outputSchema: z.object({
      chapterId: z.string(),
      chapterNumber: z.number().int().positive(),
      sceneCount: z.number().int().min(1),
      saved: z.literal(true),
    }),
    permission: 'PROPOSE_WRITE',
    errorCodes: [
      ErrorCode.TOOL_VALIDATION_ERROR,
      ErrorCode.STORAGE_QUERY_FAILED,
      ErrorCode.COMMIT_FAILED,
    ],
    execute: (input) => {
      // 存在性校验：z.unknown() 允许 undefined，这里显式拦截
      if (input.plan === undefined) {
        throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '缺少 plan 参数');
      }
      // 用 PlanOutput schema 校验模型产出的计划（不信任调用方传入的形状）
      const parsed = PlanOutputSchema.safeParse(input.plan);
      if (!parsed.success) {
        throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '计划不符合 PlanOutput 契约', {
          details: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
      }

      const chapter = repos.chapters.get(input.chapterId);

      // 章号一致性：计划声明的章号必须与数据库中的章节一致
      if (
        input.expectedChapterNumber !== undefined &&
        parsed.data.brief.chapterNumber !== input.expectedChapterNumber
      ) {
        throw new AppError(
          ErrorCode.TOOL_VALIDATION_ERROR,
          `计划声明的章号（${parsed.data.brief.chapterNumber}）与期望（${input.expectedChapterNumber}）不一致`,
        );
      }
      if (parsed.data.brief.chapterNumber !== chapter.chapter_number) {
        throw new AppError(
          ErrorCode.TOOL_VALIDATION_ERROR,
          `计划声明的章号（${parsed.data.brief.chapterNumber}）与目标章节（${chapter.chapter_number}）不一致`,
        );
      }

      // ⚠ 已提交的章节不允许改计划 —— 那会让正文与计划失配
      if (chapter.status === 'COMMITTED' || chapter.status === 'COMMITTING') {
        throw new AppError(
          ErrorCode.COMMIT_FAILED,
          `拒绝为已提交/提交中的章节覆盖计划（当前状态 ${chapter.status}）`,
          { details: { chapterId: chapter.id, status: chapter.status } },
        );
      }

      // ⚠ 开书向导门禁（W6）：这条路径**绕过服务层**，必须在这里拦。
      //   用 chapter 自己的 book_id，不用任何"当前书"解析 ——
      //   那正是 P0-4 记录过的"给 B 书写、拦的是 A 书"。
      if (opts?.assertGateOpen) opts.assertGateOpen(chapter.book_id);

      repos.chapters.savePlan(input.chapterId, parsed.data);

      return {
        chapterId: chapter.id,
        chapterNumber: chapter.chapter_number,
        sceneCount: parsed.data.scenes.length,
        saved: true as const,
      };
    },
  };

  /** 读取已保存的计划（供 UI 与 Writer 使用） */
  const chapterGetPlan: ToolDefinition<
    { chapterId: string },
    { chapterId: string; plan?: unknown }
  > = {
    name: 'chapter.getPlan',
    description: '读取章节已保存的计划；不存在时 plan 为 null',
    inputSchema: z.object({ chapterId: z.string().min(1) }),
    outputSchema: z.object({
      chapterId: z.string(),
      plan: z.custom<unknown>(() => true).nullable(),
    }),
    permission: 'READ',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
    execute: ({ chapterId }) => {
      const chapter = repos.chapters.get(chapterId);
      const plan = repos.chapters.readPlan<unknown>(chapterId);
      return { chapterId: chapter.id, plan };
    },
  };

  return [chapterPlan, chapterGetPlan];
}
