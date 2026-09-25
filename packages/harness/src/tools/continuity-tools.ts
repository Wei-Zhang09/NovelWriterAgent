/**
 * Continuity 工具（施工文档 §7.6，STEP 8）
 *
 * ⚠ 权限声明为 READ —— 一致性检查**纯只读**。
 *   这不是习惯问题：检查会把草稿与 Canon 对账，任何"顺手修正"
 *   都会让检查结论失去可信度（检查者改了被检查对象）。
 *   修复由独立的 Repair 步骤负责。
 */
import { z } from 'zod';
import { AppError, ErrorCode } from '@nwa/core';
import { ContinuityChecker, CONTINUITY_DIMENSIONS } from '@nwa/story';
import type { AnyToolDefinition, ToolDefinition } from '@nwa/shared';
import type { Repositories } from '@nwa/storage';
import { PlanOutputSchema } from '@nwa/shared';

export function createContinuityTools(
  repos: Repositories,
  opts: { readonly resolveBookId: () => string; readonly logger: import('@nwa/core').Logger },
): AnyToolDefinition[] {
  const check: ToolDefinition<
    { chapterNumber: number; draftText: string; plan?: unknown },
    {
      ok: boolean;
      blockingCount: number;
      warningCount: number;
      issues: readonly {
        code: string;
        dimension: string;
        severity: string;
        message: string;
        sourceRef: string;
      }[];
      /** M1 / §20：本次检查所依据的正文内容哈希（stale 判定锚点） */
      sourceHash: string;
      checked: {
        canonFacts: number;
        characters: number;
        scenes: number;
        /** P2-4：参与检查的已确认世界规则数（0 = 作者尚未确认规则，非"都通过"） */
        worldRules: number;
      };
    }
  > = {
    name: 'continuity.check',
    description:
      '把草稿与 Canon 对账，返回一致性报告。只读，不修改草稿与任何数据。',
    inputSchema: z.object({
      chapterNumber: z.number().int().positive(),
      draftText: z.string(),
      plan: z.custom<unknown>(() => true).optional(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      blockingCount: z.number().int(),
      warningCount: z.number().int(),
      issues: z.array(
        z.object({
          code: z.string(),
          dimension: z.string(),
          severity: z.string(),
          message: z.string(),
          sourceRef: z.string(),
        }),
      ),
      // M1 / §20：stale 判定的锚点（必填，见 ContinuityReport.sourceHash）
      sourceHash: z.string(),
      checked: z.object({
        canonFacts: z.number().int(),
        characters: z.number().int(),
        scenes: z.number().int(),
        // P2-4：世界规则维度。⚠ 必填而非 optional —— 缺字段会让
        //   "没检查"与"检查了 0 条"无法区分。
        worldRules: z.number().int(),
      }),
    }),
    permission: 'READ',
    errorCodes: [ErrorCode.TOOL_VALIDATION_ERROR, ErrorCode.STORAGE_QUERY_FAILED],
    execute: (input) => {
      // 计划若提供，必须符合契约 —— 不信任传入形状
      let plan: ReturnType<typeof PlanOutputSchema.parse> | undefined;
      if (input.plan !== undefined) {
        const parsed = PlanOutputSchema.safeParse(input.plan);
        if (!parsed.success) {
          throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '提供的 plan 不符合 PlanOutput 契约', {
            details: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          });
        }
        plan = parsed.data;
      }

      const bookId = opts.resolveBookId();
      const checker = new ContinuityChecker({ repos, logger: opts.logger, bookId });
      const report = checker.check({
        chapterNumber: input.chapterNumber,
        draftText: input.draftText,
        ...(plan ? { plan } : {}),
      });

      return {
        ok: report.ok,
        blockingCount: report.blockingCount,
        warningCount: report.warningCount,
        issues: report.issues.map((i) => ({
          code: i.code,
          dimension: i.dimension,
          severity: i.severity,
          message: i.message,
          sourceRef: i.sourceRef,
        })),
        sourceHash: report.sourceHash,
        checked: report.checked,
      };
    },
  };

  /**
   * 列出十维度说明（UI 展示"检查了什么"）。
   *
   * ⚠ 这个工具实际不会失败，但注册表要求声明错误码（§55 Rule 4）——
   *   该规则的用意是"每个工具都要交代自己可能怎么坏"。
   *   这里声明 TOOL_VALIDATION_ERROR：唯一可能的失败是入参形状不对
   *   （由 Registry 的 schema 关卡产生），而非业务失败。
   *   不为了绕过规则而删掉这条声明 —— 规则本身是对的。
   */
  const dimensions: ToolDefinition<Record<string, never>, { dimensions: readonly string[] }> = {
    name: 'continuity.dimensions',
    description: '返回一致性检查覆盖的十个维度',
    inputSchema: z.object({}),
    outputSchema: z.object({ dimensions: z.array(z.string()) }),
    permission: 'READ',
    errorCodes: [ErrorCode.TOOL_VALIDATION_ERROR],
    execute: () => ({
      dimensions: [...CONTINUITY_DIMENSIONS],
    }),
  };

  return [check, dimensions];
}
