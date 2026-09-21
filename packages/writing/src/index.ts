/**
 * @nwa/writing —— 写作流水线
 *
 * 进度：
 *   STEP 5  Naturalness 检测器（11 个零成本正则）
 *   STEP 6  Prompt 模块化 + Planner（当前）
 *   待办    Writer（7）、Reviewer（8）、Continuity（10）
 */
export * from './naturalness/detectors.js';

// ── Prompt 模块化（§31） ─────────────────────────────────────
export * from './prompts/index.js';

// ── Planner（STEP 6） ───────────────────────────────────────
export { Planner } from './planner/planner.js';
export type { PlannerOptions, PlanRequest, PlanResult, StructuredCaller } from './planner/planner.js';
