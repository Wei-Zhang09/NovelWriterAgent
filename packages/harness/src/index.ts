/**
 * @nwa/harness —— Novel Harness
 *
 * 组件（施工文档 §6.1）：Model Gateway / Tool Registry / Agent Runtime /
 * Context Engine / Skill Engine / Workflow Engine / Event Bus / Checkpoint /
 * Verification / Artifact Manager。
 *
 * 进度：
 *   STEP 2  Tool Registry
 *   STEP 3  Model Gateway + 加密密钥
 *   STEP 4  Agent Runtime + Event Bus + 状态机
 *   STEP 5  Context Engine
 *   STEP 6  Plan 工具
 *   待办    Workflow 编排、Verification
 *
 * 关键约束（每条都有对应实现，不靠约定）：
 *   - 状态迁移由代码执行，模型只能 request_transition（§8.2 → state-machine.ts）
 *   - 审查类 Agent 只读（研究报告 §2.1 → AGENT_PERMISSIONS）
 *   - 异常必写 run_events，绝不吞（§55 Rule 8 → event-bus.ts）
 *   - 结构化输出走工具提交，宿主绝不从 assistant 文本抠 JSON（研究报告 §1.2 决策 4）
 *   - checkpoint 是阶段级的，resume 不重跑已完成调用（研究报告 R2 → runtime.ts）
 */
export { ToolRegistry } from './tools/registry.js';
export type { RegisteredTool } from './tools/registry.js';
export { createProjectTools, createChapterTools, createAllTools } from './tools/project-tools.js';
export { createPlanTools } from './tools/plan-tools.js';
export { createContinuityTools } from './tools/continuity-tools.js';
export { createReviewTools } from './tools/review-tools.js';
export { createFactTools } from './tools/fact-tools.js';
export { createCharacterTools } from './tools/character-tools.js';
export { createWorldTools, WORLD_TYPES } from './tools/world-tools.js';
export { createTimelineTools } from './tools/timeline-tools.js';
export type { TimelineToolOptions } from './tools/timeline-tools.js';
export { createBookTools } from './tools/book-tools.js';
export {
  createCommitTools,
  COMMIT_SOURCE_ORDER,
  COMMIT_SOURCE_FILE,
} from './tools/commit-tools.js';
export type { CommitSourceKey } from './tools/commit-tools.js';
export type { AnyToolDefinition } from '@nwa/shared';

// ── Model Gateway（STEP 3） ──────────────────────────────────
export { ModelGateway, extractJson } from './models/gateway.js';
export type { ModelSlot, GatewayOptions, ModelCallRecord } from './models/gateway.js';
export { OpenAiCompatibleProvider, normalizeBearer } from './models/openai-compatible.js';
export {
  FileSecretStore,
  InMemorySecretStore,
  defaultCredentialsPath,
} from './models/secret-store.js';
export type { CryptoBackend } from './models/secret-store.js';
export { classifyHttpFailure, extractErrorText, isRetryable, backoffDelayMs } from './models/errors.js';
export { buildStructuredContract, describeSchemaFields, unwrapSchema } from './models/structured-contract.js';
export type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatUsage,
  EmbedRequest,
  EmbedResponse,
  ModelProfile,
  ModelProvider,
  SecretStore,
  StructuredRequest,
  StructuredResult,
} from './models/types.js';

// ── Event Bus（STEP 4） ──────────────────────────────────────
export { EventBus } from './events/event-bus.js';
export type { EmittedEvent, EventBusOptions } from './events/event-bus.js';

// ── 状态机（STEP 4） ────────────────────────────────────────
export {
  canTransition,
  assertTransition,
  allowedTargets,
  isTerminal,
  isAbnormal,
} from './workflow/state-machine.js';
export type { TransitionRequest, TransitionDecision } from './workflow/state-machine.js';

// ── Atomic Commit（STEP 11）【MVP 门槛】 ────────────────────
export { CommitEngine, SimulatedKill } from './commit/commit-engine.js';
export type { CommitRequest, CommitReport, CommitEngineOptions, ManifestArtifact, KillSwitch } from './commit/commit-engine.js';
export { AtomicFileSet, sha256, hashOfFile, findAliases, resolveInside } from './commit/atomic-file-set.js';
export type { StageOptions, StageResult, FileIdentity } from './commit/atomic-file-set.js';
export { CommitLock, LOCK_FILE_NAME } from './commit/commit-lock.js';
export type { CommitLockOptions, LockHandle, AcquireResult } from './commit/commit-lock.js';
export { RepairEngine } from './commit/repair.js';
export type { RepairDecision, RepairSummary, RepairBranch, RepairAction } from './commit/repair.js';

// ── 迁移门禁（STEP 8 + STEP 10） ────────────────────────────
export { TransitionGate } from './workflow/transition-gate.js';
export type { GateResult, GateContext } from './workflow/transition-gate.js';

// ── Context Engine（STEP 5） ────────────────────────────────
export { ContextEngine } from './context/engine.js';
export type { ContextEngineOptions } from './context/engine.js';
export { defaultTokenCounter, conservativeTokenCounter } from './context/token-counter.js';
export { MemoryGatherer } from './context/memory-gatherer.js';

// ── Novel Workflow（v1.0 闭环提示词 §三 P0-1 / §四 P0-2）──
export {
  WorkflowEngine,
  stageOrdinals,
  summarizeStages,
  type AdvanceResult,
  type WorkflowEngineOptions,
} from './workflow/workflow-engine.js';
export { WorkflowRepository, type CreateWorkflowInput } from './workflow/workflow-repository.js';
export {
  RetrievalService,
  type RetrievalTier,
  type TierHit,
  type TierResult,
  type StructuredTruth,
  type GatherTierInput,
  type RetrievalServiceDeps,
} from './retrieval/retrieval-service.js';
export {
  createNovelWorkflowStages,
  type NovelWorkflowServices,
} from './workflow/novel-workflow.js';
export {
  STAGE_ORDER,
  STAGE_STATUS,
  TERMINAL_STATUSES,
  isResumable,
  isWorkflowTerminal,
  type StageContext,
  type StageId,
  type StageInput,
  type WorkflowStageResult,
  type StageStatus,
  type WorkflowArtifactRef,
  type WorkflowRecord,
  type WorkflowStage,
  type WorkflowStageRecord,
  type WorkflowStatus,
} from './workflow/workflow-types.js';
export type {
  MemoryCandidate,
  GatherMemoryOptions,
  GatherMemoryResult,
  RetrieverLike,
  MemoryIndexLike,
  MatchExpressionBuilder,
  RetrievalHitLike,
  RetrievalTraceLike,
} from './context/memory-gatherer.js';
export { SummaryIndexer } from './context/summary-indexer.js';
export {
  renderCharacterBlock,
  toCharacterBrief,
  selectRelevantCharacters,
} from './context/character-block.js';
export type { CharacterBrief } from './context/character-block.js';
export {
  renderWorldBlock,
  selectWorldSettings,
  toWorldBrief,
  typeLabel,
} from './context/world-block.js';
export type { WorldBrief, WorldSelection } from './context/world-block.js';
export {
  SummaryGenerator,
  ChapterSummarySchema,
  validateSummary,
  DEFAULT_SUMMARY_MAX_CHARS,
} from './context/summary-generator.js';
export type {
  ChapterSummary,
  SummaryGeneratorOptions,
  SummaryStructuredCaller,
  SummaryRequest,
  SummaryResult,
} from './context/summary-generator.js';
export type { ReindexResult } from './context/summary-indexer.js';
export { SLOT_NAMES } from './context/types.js';
export type {
  AssembledContext,
  AssemblyReport,
  ContextEntry,
  ContextRequest,
  SlotName,
  SlotReport,
  SlotSpec,
  TokenCounter,
} from './context/types.js';

// ── Agent Runtime（STEP 4） ──────────────────────────────────
export { AgentRuntime } from './agent/runtime.js';
export type { AgentRuntimeOptions } from './agent/runtime.js';
export { AGENT_TYPES, AGENT_PERMISSIONS } from './agent/types.js';
export type {
  AgentType,
  AgentHandler,
  AgentExecutionContext,
  AgentExecutionResult,
  AgentRunInput,
  AgentRunResult,
  AgentRunStatus,
} from './agent/types.js';
