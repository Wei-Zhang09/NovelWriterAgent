/**
 * 摘要预算（ADR-0006 / §12）
 *
 * 摘要是长程记忆的源头：每章摘要都会进 FTS 与后续章节的上下文。
 * 单条摘要过长会挤占后面每一章的上下文预算 —— 所以有硬上限。
 *
 * ⚠ 这个常量放在 `@nwa/core`（最底层、无内部依赖），因为**确认摘要的
 *   唯一入口** `chapters.approveSummary()` 在 `@nwa/storage`，
 *   而 storage 不能依赖 harness（harness 依赖 storage，反向会成环）。
 *   校验必须落在真正的收口处，否则换个调用方就能绕过。
 */
import { AppError, ErrorCode } from './errors.js';

/**
 * 章节摘要字数上限。
 *
 * ⚠ 与 `SummaryGenerator` 的默认 maxChars、以及生成 prompt 里的要求
 *   必须**一致**。实测踩到：prompt 写"100-250 字"而校验是 300 ——
 *   模型给了 444 字，直接被拒。
 */
export const SUMMARY_MAX_CHARS = 500;

/**
 * 校验摘要是否在预算内；超长则抛错。
 *
 * ⚠ 为什么"确认"这一步也要拦：
 *   摘要因**纯长度**超限而生成失败时，候选内容会被保留下来供作者编辑
 *   （否则该章永久无法提交）。但保留 ≠ 可以直接确认 —— 未删减就确认
 *   等于绕过预算检查，超长摘要照样进检索，正是上限要防的事。
 *   作者把内容删到上限内即可通过。
 *
 * @param text      待确认的摘要内容（可能是作者改写后的）
 * @param chapterNumber 用于错误信息定位（可选）
 */
export function assertSummaryWithinBudget(text: string, chapterNumber?: number): void {
  if (text.length <= SUMMARY_MAX_CHARS) return;
  const where = chapterNumber === undefined ? '摘要' : `第 ${chapterNumber} 章摘要`;
  throw new AppError(
    ErrorCode.TOOL_VALIDATION_ERROR,
    `${where} ${text.length} 字超出上限 ${SUMMARY_MAX_CHARS} 字，请删减后再确认` +
      '（超长摘要会挤占后续章节的上下文预算）',
  );
}
