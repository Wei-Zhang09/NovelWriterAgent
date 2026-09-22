/**
 * @nwa/distillation —— Novel Distillation Engine（§15–§27）
 *
 * ## 现状
 *
 * STEP 14（语料导入）已实现；STEP 15–17 进行中。
 *
 * ⚠ 曾经的硬门槛（ADR-0003）**已满足**：STEP 11 的 Atomic Commit + Test D
 *   已通过（4 个 kill 注入点全过），因此 NDE 相关实现可以开始。
 *   保留 `NDE_DEFERRED_UNTIL_STEP_11` 作为历史标记，其语义已从
 *   "禁止实现"变为"门槛已解除"。
 *
 * ## 分层
 *
 * ```
 * corpus/     STEP 14 —— 导入、规范化、章节识别、权限登记
 * parse/      STEP 15 —— 场景切分、叙事标注
 * mine/       STEP 16 —— 模式挖掘、跨作品对比、对比蒸馏
 * skill/      STEP 17 —— 技能编译与校验
 * ```
 */

/** 历史标记：门槛已解除（STEP 11 的 Test D 4 个注入点全过） */
export const NDE_DEFERRED_UNTIL_STEP_11 = false;

// ── STEP 14：语料导入 ──────────────────────────────────────
export { normalizeText, normalizeWithStrip, contentHash, textStats } from './corpus/normalize.js';
export { stripBoilerplate } from './corpus/boilerplate.js';
export type { StripResult } from './corpus/boilerplate.js';
export type { TextStats } from './corpus/normalize.js';

export { detectChapters, parseChineseNumber, declaredNumberOf, summarizeGaps } from './corpus/chapter-detect.js';
export type { DetectedChapter, DetectResult, DetectStrategy, ChapterGap } from './corpus/chapter-detect.js';

export { cleanWebNovel, findExtrasStart, isPromoText } from './corpus/clean-web.js';
export type { CleanOptions, CleanResult } from './corpus/clean-web.js';
export type { CleanReport, CleanRuleStat } from './corpus/types.js';

export { CorpusImporter } from './corpus/import.js';
export type { ImportOptions, ImportRequest, ImportResult } from './corpus/import.js';
