/**
 * @nwa/writing —— 写作流水线
 *
 * 进度：
 *   STEP 5  Naturalness 检测器（11 个零成本正则）
 *   STEP 6  Prompt 模块化 + Planner（当前）
 *   待办    Writer（7）、Reviewer（8）、Continuity（10）
 */
export * from './naturalness/detectors.js';
export { detectAiPatterns, AI_RULES } from './naturalness/ai-patterns.js';
export type { AiPatternCode, AiPatternHit } from './naturalness/ai-patterns.js';

// ── Prompt 模块化（§31） ─────────────────────────────────────
export * from './prompts/index.js';

// ── Planner（STEP 6） ───────────────────────────────────────
export { Planner } from './planner/planner.js';
export { Writer, assembleChapter, extractDeviations, stripDeviationNotes } from './writer/writer.js';

// ── Skill Engine（STEP 18 / §25） ──────────────────────────
//
// ⚠ 引擎在 writing 而非 distillation：技能的**生产**（挖掘+编译）是离线链路，
//   技能的**使用**只需要读 storage。运行时不该拖进整条蒸馏链路。
export { SkillEngine, parseSkillRow, renderSkill } from './skills/engine.js';
export {
  resolveSkillConflicts,
  detectRuleConflict,
  SCOPE_RANK,
  type ConflictResolution,
  type SameScopeConflict,
  type ResolvedSkillSet,
  type ResolvableSkill,
} from './skills/conflict-resolver.js';
export type {
  SceneContext,
  SkillEngineOptions,
  SelectedSkill,
  SkillSelection,
} from './skills/engine.js';
export { Reviewer } from './reviewer/reviewer.js';
export { Reviser } from './reviser/reviser.js';
export { RevisionEditSchema, RevisionOutputSchema } from './reviser/reviser.js';
export type {
  RevisionStructuredCaller,
  RevisionOptions,
  RevisionResult,
  RevisionEdit,
  EditOutcome,
} from './reviser/reviser.js';
export type {
  ReviewerOptions,
  ReviewStructuredCaller,
  ReviewRequest,
  ReviewResult,
} from './reviewer/reviewer.js';
export type {
  WriterOptions,
  TextCompleter,
  SceneDraft,
  ChapterDraft,
  DraftResult,
} from './writer/writer.js';
export type { PlannerOptions, PlanRequest, PlanResult, StructuredCaller } from './planner/planner.js';
