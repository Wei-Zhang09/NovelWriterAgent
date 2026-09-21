/**
 * @nwa/harness —— Novel Harness
 *
 * 组件（施工文档 §6.1）：Model Gateway / Tool Registry / Agent Runtime /
 * Context Engine / Skill Engine / Workflow Engine / Event Bus / Checkpoint /
 * Verification / Artifact Manager。
 *
 * 当前进度：Tool Registry（STEP 2）+ Model Gateway（STEP 3）。
 * 待实现：Agent Runtime / Workflow / Event Bus（STEP 4）。
 *
 * 关键约束：
 *   - 结构化输出走「单次工具调用提交」，宿主**绝不**从 assistant 文本抠 JSON
 *     （研究报告 §1.2 决策 4）
 *   - 审查类 Agent（Reviewer / Continuity）**只读**，不给 Write 权限
 *     （研究报告 §2.1 采纳 5）
 *   - 状态迁移由代码执行，模型只能 request_transition（§8.2）
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
