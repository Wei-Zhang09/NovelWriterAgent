/**
 * Novel Workflow 类型定义（v1.0 闭环施工提示词 §三 / §二十一 / §二十二）
 *
 * ## 为什么要有这一层
 *
 * 现状是 UI 通过 IPC **逐个直连**调用 Planner/Writer/Reviewer/Continuity：
 *
 *   UI → writer.draft → review.run → revision.run → continuity.check → commit.run
 *
 * 提示词 §三 明确禁止这个形态，理由不是"架构不优雅"，而是三个**具体的**
 * 失效模式：
 *
 *   1. **顺序无人负责**：谁先谁后写在调用方（UI 与验证脚本）里。加一个
 *      stage 就要改所有调用方，漏一个就出现"跳过了 Review 直接 Commit"。
 *   2. **跳过无法阻止**：调用方可以直接 `commit.run`，没有任何代码会说
 *      "你还没 Review"。§33 要求"状态迁移必须由代码执行"，直连形态下
 *      代码根本没参与编排。
 *   3. **失败无处恢复**：没有 Workflow 记录，进程一关就不知道跑到哪了。
 *
 * 所以这一层的职责是：**把编排从调用方收回到代码里**。
 *
 * ## 关于 stage 列表的取舍
 *
 * 提示词 §三 给了 12 个 stage，§四 给了 16 个状态。二者不是一一对应 ——
 * 有些状态（PAUSED/FAILED/CANCELLED/DONE）是**工作流级**的，不是 stage。
 * 这里严格按提示词的 stage 划分，不自行合并或拆分。
 */
import type { Nullable } from '@nwa/core';

/**
 * 工作流状态（提示词 §三 的 16 态，一个不多一个不少）。
 *
 * ⚠ `PAUSED` 与 `CANCELLED` 是**不同**的终态语义：
 *   - `PAUSED` 可 `resume` 继续
 *   - `CANCELLED` 不可恢复
 *
 * 这个区分正是 P0-2 要修的 bug —— 原实现里 `pause()` 最终落到
 * `CANCELLED`，于是"暂停"变成了"取消"，无法恢复。
 */
export type WorkflowStatus =
  | 'CREATED'
  | 'BUILDING_CONTEXT'
  | 'PLANNING'
  | 'VERIFYING_PLAN'
  | 'WRITING'
  | 'REVIEWING'
  | 'REVISING'
  | 'CHECKING_CONTINUITY'
  | 'SETTLING_STATE'
  | 'READY_TO_COMMIT'
  | 'COMMITTING'
  | 'VERIFYING_COMMIT'
  | 'DONE'
  | 'FAILED'
  | 'PAUSED'
  | 'CANCELLED';

/** stage 级状态。注意与 `WorkflowStatus` 不同 —— stage 没有 PAUSED */
export type StageStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';

/** 12 个 stage 的标识（提示词 §三 stages/ 目录的 12 个文件） */
export type StageId =
  | 'create_chapter'
  | 'build_context'
  | 'plan'
  | 'plan_verify'
  | 'write'
  | 'review'
  | 'revision'
  | 'continuity'
  | 'state_settlement'
  | 'ready_to_commit'
  | 'commit'
  | 'verify';

/**
 * stage 执行顺序（唯一权威）。
 *
 * ⚠ 顺序必须由代码定义，不能靠调用方传数组 —— 否则又回到"编排在调用方"。
 *   恢复时按这个数组跳过已 DONE 的 stage。
 */
export const STAGE_ORDER: readonly StageId[] = [
  'create_chapter',
  'build_context',
  'plan',
  'plan_verify',
  'write',
  'review',
  'revision',
  'continuity',
  'state_settlement',
  'ready_to_commit',
  'commit',
  'verify',
];

/** stage → 进入该 stage 时的工作流状态 */
export const STAGE_STATUS: Readonly<Record<StageId, WorkflowStatus>> = {
  create_chapter: 'CREATED',
  build_context: 'BUILDING_CONTEXT',
  plan: 'PLANNING',
  plan_verify: 'VERIFYING_PLAN',
  write: 'WRITING',
  review: 'REVIEWING',
  revision: 'REVISING',
  continuity: 'CHECKING_CONTINUITY',
  state_settlement: 'SETTLING_STATE',
  ready_to_commit: 'READY_TO_COMMIT',
  commit: 'COMMITTING',
  verify: 'VERIFYING_COMMIT',
};

/** 终态（不再前进） */
export const TERMINAL_STATUSES: readonly WorkflowStatus[] = ['DONE', 'FAILED', 'CANCELLED'];

/** 可从该状态恢复 */
export function isResumable(status: WorkflowStatus): boolean {
  return status === 'PAUSED';
}

/** 是否已结束（不可再推进） */
export function isWorkflowTerminal(status: WorkflowStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Stage 统一接口（提示词 §二十一）。
 *
 * Stage **不直接操作 UI**，只返回结构化结果 + artifact 引用 + metadata。
 */
export interface StageContext {
  readonly workflowId: string;
  readonly projectId: string;
  readonly bookId: string;
  readonly chapterId: Nullable<string>;
  readonly chapterNumber: Nullable<number>;
  /** 已完成的 stage 输出（供后续 stage 读取上游结果） */
  readonly outputs: Readonly<Record<string, unknown>>;
  /** 中止信号：pause/cancel 时触发 */
  readonly signal: AbortSignal;
  /** 记录 artifact（落 workflow_artifacts 表） */
  readonly recordArtifact: (a: {
    type: string;
    path: string;
    contentHash: string;
  }) => void;
  /**
   * 把章节绑定到工作流（落库）。
   *
   * ⚠ 为什么必须有这个方法：`create_chapter` stage 的职责就是"确定写哪一章"，
   *   但在它跑之前，工作流记录里的 `chapter_id` 是 NULL（用户可能只说
   *   "写下一章"，章节还没建）。若不把它写回工作流，
   *   **下游每一个 stage 读到的 chapterId 都还是 NULL** ——
   *   实测就是这个表现：全部 stage 在 `build_context` 处失败，
   *   报"工作流缺少 chapterId"，而 create_chapter 明明成功了。
   *
   *   让 stage 显式调用（而不是引擎去猜输出结构），是因为"绑定章节"
   *   是**状态变更**，不该藏在输出对象的形状约定里。
   */
  readonly setChapter: (chapterId: string, chapterNumber: number) => void;
  /** 发出事件（§二十 事件系统） */
  readonly emit: (type: string, payload?: unknown) => void;
}

/**
 * Stage 输出（提示词 §二十一）。
 *
 * ⚠ 必须结构化。反例是 Writer 只返回一个长字符串 —— 那样下游无法知道
 *   草稿有多少字、有几个场景、有没有 deviation，只能重新解析文本。
 */
export interface WorkflowStageResult {
  readonly ok: boolean;
  /** 结构化输出，会被存进 stage_outputs_json 供下游读取 */
  readonly output?: unknown;
  /** 产物引用（§二十二 Artifact First） */
  readonly artifacts?: readonly { type: string; path: string; contentHash: string }[];
  /** 失败原因（人话） */
  readonly error?: string;
  /**
   * 是否可跳过该 stage 继续（如"没有 continuity 阻塞"）。
   *
   * 与 `ok: false` 的区别：`skippable` 表示"这个 stage 没做事但不算失败"。
   */
  readonly skipped?: boolean;
}

export interface WorkflowStage {
  readonly id: StageId;
  run(input: StageInput, ctx: StageContext): Promise<WorkflowStageResult>;
}

/** 传给 stage 的输入（来自 workflow 记录 + 上游 stage 输出） */
export interface StageInput {
  readonly chapterId: Nullable<string>;
  readonly chapterNumber: Nullable<number>;
  /** 上游 stage 的结构化输出 */
  readonly upstream: Readonly<Record<string, unknown>>;
  /** 调用方传入的额外参数（如 maxScenes、styleGenre） */
  readonly params: Readonly<Record<string, unknown>>;
}

/** 工作流记录（对应 workflows 表） */
export interface WorkflowRecord {
  readonly id: string;
  readonly projectId: string;
  readonly bookId: string;
  readonly chapterId: Nullable<string>;
  readonly chapterNumber: Nullable<number>;
  readonly workflowType: string;
  readonly status: WorkflowStatus;
  readonly currentStage: Nullable<StageId>;
  readonly resumeCursor: Nullable<StageId>;
  readonly stageInputs: Record<string, unknown>;
  readonly stageOutputs: Record<string, unknown>;
  readonly artifactRefs: readonly WorkflowArtifactRef[];
  readonly checkpoint: Nullable<Record<string, unknown>>;
  readonly error: Nullable<{ code?: string; message: string }>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowArtifactRef {
  readonly type: string;
  readonly path: string;
  readonly contentHash: string;
}

/** stage 记录（对应 workflow_stages 表） */
export interface WorkflowStageRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly stageId: StageId;
  readonly ordinal: number;
  readonly status: StageStatus;
  readonly startedAt: Nullable<string>;
  readonly endedAt: Nullable<string>;
  readonly attempts: number;
  readonly output: Nullable<unknown>;
  readonly artifactRefs: readonly WorkflowArtifactRef[];
  readonly error: Nullable<{ message: string }>;
}
