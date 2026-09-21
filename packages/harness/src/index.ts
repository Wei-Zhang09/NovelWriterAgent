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
 *   STEP 4  Agent Runtime + Event Bus + 状态机（当前）
 *   待办    Context Engine（5）、Workflow 编排（4 后半）、Verification
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
export { classifyHttpFailure, isRetryable, backoffDelayMs } from './models/errors.js';
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
