/**
 * Model Gateway 契约（施工文档 §37 / §38）
 *
 * 设计原则（§37）：**不要硬编码 Provider**。
 *   OpenAI-compatible 是统一基础协议，专用适配器只处理协议差异，
 *   任务路由（§54，收敛为 4 个槽位）决定用哪个 profile。
 */
import type { z } from 'zod';

/** 聊天消息 */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature: number;
  readonly maxTokens: number;
  /** 结构化输出：要求模型以 JSON 返回并按其校验 */
  readonly responseSchemaName?: string;
  /** 中止信号 —— 支撑 §40 的 pause/cancel */
  readonly signal?: AbortSignal;
}

export interface ChatUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface ChatResponse {
  readonly text: string;
  readonly usage: ChatUsage;
  readonly latencyMs: number;
  /** 实际使用的模型名（服务端可能改写成带日期的快照名） */
  readonly model: string;
  readonly finishReason: string | null;
}

export interface EmbedRequest {
  readonly model: string;
  readonly input: readonly string[];
}

export interface EmbedResponse {
  readonly vectors: readonly (readonly number[])[];
  readonly usage: ChatUsage;
}

/** Provider 统一接口（§37） */
export interface ModelProvider {
  readonly id: string;
  readonly kind: 'openai-compatible' | 'ollama';
  chat(input: ChatRequest): Promise<ChatResponse>;
  embed?(input: EmbedRequest): Promise<EmbedResponse>;
}

/** Model Profile（§38 的 9 个字段） */
export interface ModelProfile {
  readonly id: string;
  readonly provider: 'openai-compatible' | 'ollama';
  readonly endpoint: string;
  readonly model: string;
  /** 密钥**引用名**，不是密钥本身（§38：API Key 不放数据库明文） */
  readonly apiKeyRef?: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly contextWindow: number;
  readonly timeoutMs: number;
  readonly retryPolicy: {
    readonly maxAttempts: number;
    /** 结构化输出失败时的备用 profile（研究报告 R11） */
    readonly structuredFallbackProfileId?: string;
  };
}

/**
 * 结构化输出结果（研究报告 R11）
 *
 * 来源教训：AI-Novel-Writing-Assistant 的 release notes 记录了
 * 「DeepSeek 等支持原生 JSON 的模型生成结构化结果时返回空内容」的反复踩坑。
 * 我们的 Architect / Planner / Reviewer 都依赖结构化输出，这个坑一定会踩。
 * 因此：解析失败 → 重试 → 退到备用 profile → 仍失败则报 MODEL_STRUCTURED_EMPTY。
 */
export type StructuredResult<T> =
  | { readonly ok: true; readonly data: T; readonly attempts: number; readonly usedFallback: boolean }
  | {
      readonly ok: false;
      readonly error: { code: string; message: string; details?: unknown };
      readonly attempts: number;
      readonly usedFallback: boolean;
      readonly rawText: string;
    };

export interface StructuredRequest<T> {
  /**
   * ⚠ 输入类型必须是 unknown（而不是 T）。
   *
   * 原因：`z.ZodType<T>` 会把 Input 与 Output 都约束成 T，
   * 但带 `.default()` / `.transform()` 的 schema 两者并不相等 ——
   * 例如 `z.array(z.string()).default([])` 的 Input 是 `string[] | undefined`，
   * Output 是 `string[]`。用 `ZodType<T>` 会导致调用方无法传递这类 schema
   * （实测在 Planner 上触发类型错误）。
   */
  readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  readonly schemaName: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

/** 密钥读取接口：由宿主注入（Electron safeStorage / 测试替身） */
export interface SecretStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
  readonly backend: string;
}
