/**
 * Agent Runtime 契约（施工文档 §6.2）
 */
import type { ToolPermissionSchema } from '@nwa/shared';
import type { z } from 'zod';

/** Agent 类型（施工文档 §7，MVP 实现 4 个） */
export const AGENT_TYPES = ['planner', 'writer', 'reviewer', 'continuity', 'editor'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

/**
 * 每个 Agent 的权限上限。
 *
 * ⚠ 关键约束（研究报告 §2.1 采纳 5）：**审查类 Agent 只读**。
 *   webnovel-writer 的 reviewer 配置是 `tools: Read, Grep, Bash`（无 Write），
 *   理由是「避免『自己改、自己说通过』的闭环偏差」。
 *   我们在这里用数据声明，而不是靠调用方记得少传工具。
 */
export const AGENT_PERMISSIONS: Record<AgentType, z.infer<typeof ToolPermissionSchema>> = {
  planner: 'WRITE',        // 产出计划与章节骨架
  writer: 'PROPOSE_WRITE', // 只产出草稿到 workspace，不写正式文件
  reviewer: 'READ',        // 只读：只报问题，不改稿
  continuity: 'READ',      // 只读：只报一致性问题
  editor: 'PROPOSE_WRITE', // 产出修订稿到 workspace
};

export interface AgentRunInput {
  readonly runId: string;
  readonly agentType: AgentType;
  readonly goal: string;
  readonly projectId: string;
  readonly workflowId?: string;
  readonly contextRefs?: readonly string[];
  readonly skillRefs?: readonly string[];
  readonly modelProfileId?: string;
  readonly mode: 'interactive' | 'workflow';
}

/** Agent 执行体：由具体 Agent 实现，宿主负责生命周期与事件 */
export interface AgentHandler {
  readonly agentType: AgentType;
  /**
   * 执行主体。
   *
   * 约定（研究报告 §1.2 决策 4）：结构化结果必须经**工具调用**提交，
   * 而不是从 assistant 文本里抠 JSON。handler 收到的 result 已经是
   * 经 schema 校验的对象。
   */
  execute(ctx: AgentExecutionContext): Promise<AgentExecutionResult>;
}

export interface AgentExecutionContext {
  readonly runId: string;
  readonly input: AgentRunInput;
  /** 已校验的工具调用器（权限已按 agentType 限制） */
  readonly toolContext: import('@nwa/shared').ToolContext;
  /** 结构化输出请求器（内部走 Model Gateway 的三级降级） */
  readonly structured: <T>(req: {
    // 同 StructuredRequest：Input 必须是 unknown，否则带 default 的 schema 传不进来
    schema: import('zod').ZodType<T, import('zod').ZodTypeDef, unknown>;
    schemaName: string;
    messages: readonly import('../models/types.js').ChatMessage[];
  }) => Promise<import('../models/types.js').StructuredResult<T>>;
  /** 检查点写入 */
  readonly checkpoint: (stage: string, state: unknown, artifacts?: unknown) => void;
  /** 用于长任务的分段暂停/取消检查 */
  readonly signal: AbortSignal;
}

export interface AgentExecutionResult {
  /** 执行产出的结构化数据（可选，取决于 Agent 类型） */
  readonly output?: unknown;
  /** 产出的文件/数据引用，写入 artifact manifest */
  readonly artifacts?: readonly string[];
}

export type AgentRunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'PAUSED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export interface AgentRunResult {
  readonly runId: string;
  readonly status: AgentRunStatus;
  readonly output?: unknown;
  readonly artifacts: readonly string[];
  readonly error?: { code: string; message: string; details?: unknown };
  readonly startedAt: string;
  readonly endedAt: string;
}
