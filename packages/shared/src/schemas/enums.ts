/**
 * 集中定义的枚举（研究报告 R8：禁止在各处散落字符串）
 */
import { z } from 'zod';

/** 章节状态机（施工文档 §8.1 的 12 态 + 异常 6 态） */
export const ChapterStatus = z.enum([
  'DRAFT',
  'PLANNING',
  'CONTEXT_READY',
  'WRITING',
  'DRAFT_READY',
  'REVIEWING',
  'REVIEW_READY',
  'REVISING',
  'REVISION_READY',
  'CONTINUITY_CHECKING',
  'READY_TO_COMMIT',
  'COMMITTING',
  'COMMITTED',
  // 异常态
  'PAUSED',
  'RESUMING',
  'FAILED',
  'RETRYING',
  'ROLLING_BACK',
]);
export type ChapterStatus = z.infer<typeof ChapterStatus>;

/** 事实状态（施工文档 §10.8） */
export const FactStatus = z.enum(['CANON', 'PROVISIONAL', 'CONTRADICTED', 'RETIRED']);
export type FactStatus = z.infer<typeof FactStatus>;

/** Review 严重级别（施工文档 §33） */
export const ReviewSeverity = z.enum(['BLOCKING', 'MAJOR', 'MINOR', 'NOTE']);
export type ReviewSeverity = z.infer<typeof ReviewSeverity>;

/** Review 分类（施工文档 §33 的 15 类，MVP 实现 11 类） */
export const ReviewCategory = z.enum([
  'PLOT', 'CHARACTER', 'CONTINUITY', 'TIMELINE', 'WORLD_RULE', 'FORESHADOWING',
  'PACING', 'DIALOGUE', 'EMOTION', 'DESCRIPTION', 'REPETITION',
  // Full 阶段启用（依赖 Style DNA）
  'NATURALNESS', 'AI_LIKE_PATTERN', 'STYLE_ALIGNMENT', 'HOOK',
]);
export type ReviewCategory = z.infer<typeof ReviewCategory>;

/** 工具权限（施工文档 §6.4） */
export const ToolPermission = z.enum(['READ', 'PROPOSE_WRITE', 'WRITE', 'COMMIT', 'ADMIN']);
export type ToolPermission = z.infer<typeof ToolPermission>;

/** Run 事件类型（ADR-0006 约束 B：集中 enum，禁止自由字符串） */
export const RunEventType = z.enum([
  'RUN_STARTED', 'WORKFLOW_STARTED', 'STEP_STARTED',
  'CONTEXT_BUILT', 'MODEL_CALL_STARTED', 'MODEL_CALL_COMPLETED',
  'TOOL_CALL_STARTED', 'TOOL_CALL_COMPLETED',
  'PLAN_CREATED', 'DRAFT_CREATED', 'REVIEW_COMPLETED', 'REVISION_CREATED',
  'CONTINUITY_COMPLETED', 'STATE_PROPOSED',
  'COMMIT_STARTED', 'COMMIT_COMPLETED', 'COMMIT_REPAIRED',
  'CHECKPOINT_CREATED', 'RUN_PAUSED', 'RUN_RESUMED', 'RUN_FAILED', 'RUN_CANCELLED',
  'SKILL_INJECTED', 'QUALITY_DEBT_RECORDED',
  // ── Workflow stage 级事件（v1.0 闭环提示词 §二十）──
  //
  // ⚠ 为什么需要这三个：原事件表只有"阶段产物"事件（PLAN_CREATED 等），
  //   没有"阶段开始/结束"事件。UI 要显示「✓ Context / ● Plan / ○ Write」
  //   这种逐阶段进度，就必须知道某个 stage **何时开始**（而不只是
  //   它产出了什么）—— 否则只能等产物出现才知道在跑哪一步，
  //   长 stage（Write 可能几分钟）期间界面是完全静止的。
  'STAGE_STARTED', 'STAGE_COMPLETED', 'STAGE_SKIPPED',
  // 工作流终态事件（与 RUN_* 区分：RUN_* 是 agent run，这两个是 workflow）
  'RUN_COMPLETED',
  // 状态结算的验证结果（§六：VERIFIED 才能进 Canon，故必须有事件可审计）
  'STATE_VERIFIED', 'STATE_REJECTED',
  // Timeline（P0-5）
  'TIMELINE_UPDATED', 'TIMELINE_CONFLICT',
]);
export type RunEventType = z.infer<typeof RunEventType>;

/** 事件的保留分类（ADR-0006 约束 B） */
export const EventCategory = z.enum(['OBSERVABILITY', 'STATE']);
export type EventCategory = z.infer<typeof EventCategory>;

/** 事实状态 → 事件类型 的保留分类映射（单一来源，不得散落） */
export const STATE_EVENT_TYPES: readonly RunEventType[] = [
  'PLAN_CREATED', 'DRAFT_CREATED', 'REVIEW_COMPLETED', 'REVISION_CREATED',
  'CONTINUITY_COMPLETED', 'STATE_PROPOSED',
  'COMMIT_STARTED', 'COMMIT_COMPLETED', 'COMMIT_REPAIRED',
  'RUN_STARTED', 'RUN_PAUSED', 'RUN_RESUMED', 'RUN_FAILED', 'RUN_CANCELLED',
  // ⚠ 状态结算与时间线改变的是**正史**，必须长期保留（ADR-0006 约束 B）。
  //   STAGE_STARTED/STAGE_COMPLETED 属 OBSERVABILITY（过程噪声，可过期）。
  'STATE_VERIFIED', 'STATE_REJECTED', 'TIMELINE_UPDATED', 'TIMELINE_CONFLICT',
];

export function categorizeEvent(type: RunEventType): EventCategory {
  return STATE_EVENT_TYPES.includes(type) ? 'STATE' : 'OBSERVABILITY';
}
