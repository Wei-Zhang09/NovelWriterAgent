/**
 * 配置（施工文档 §0.1「本地优先」+ §66 性能目标）
 *
 * 设计原则：
 *  - **contextBudget 为必填**（研究报告 R3）—— 缺失时不得静默退化为「无预算」
 *  - 模型 Provider 不硬编码（§37），配置项与密钥引用分离
 */
import { AppError, ErrorCode } from './errors.js';

/** 模型 Provider 类型（§38 的统一适配器） */
export interface ModelProfile {
  readonly id: string;
  readonly provider: 'openai-compatible' | 'ollama';
  readonly endpoint: string;
  readonly model: string;
  /** 密钥引用名，**不是**密钥本身（§38：API Key 不放数据库明文） */
  readonly apiKeyRef?: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly contextWindow: number;
  readonly timeoutMs: number;
  readonly retryPolicy: {
    readonly maxAttempts: number;
    /** 结构化输出失败时的备用模型 profile id（研究报告 R11） */
    readonly structuredFallbackProfileId?: string;
  };
}

/**
 * 模型任务槽位（研究报告 R9：6 → 4 个槽位）
 *
 * Editor / Continuity 复用 writer / utility，不单独占槽。
 */
export type ModelSlot = 'architect' | 'writer' | 'reviewer' | 'utility';

/**
 * 上下文预算（研究报告 R3：必须是「保护式」）
 *
 * 语义：protected 部分**不参与裁剪**；若 protected 本身超预算，
 * 系统抛 CONTEXT_BUDGET_EXCEEDED，而不是丢弃 —— 「宁可报错，不要静默丢失 Canon」。
 */
export interface ContextBudget {
  /** 本次调用可用的输入 token 上限（必填） */
  readonly inputTokens: number;
  /** 预留给输出（用于估算是否溢出） */
  readonly outputReserveTokens: number;
  /** Protected 部分允许占用的上限；超出即报错 */
  readonly protectedMaxTokens: number;
}

export interface ProjectConfig {
  /** 默认生成语言，影响分词器与 prompt */
  readonly language: 'zh-CN';
  readonly contextBudget: ContextBudget;
  readonly models: {
    readonly slots: Record<ModelSlot, string>;
    readonly profiles: readonly ModelProfile[];
  };
  readonly review: {
    /** Revision 最大尝试次数（研究报告 R6：硬性限次，超限进入人工终态） */
    readonly maxRevisionAttempts: number;
    /** 净提升门槛：修稿得分提升不足此值则放弃修订（InkOS NET_IMPROVEMENT_EPSILON = 3） */
    readonly netImprovementEpsilon: number;
  };
  readonly commit: {
    /** 同目录允许并发 Commit 数，v1.0 恒为 1（ADR-0002 v2 排他锁） */
    readonly maxConcurrent: 1;
    /** 陈旧锁超时（毫秒），超时自动回收（ADR-0002 v2 约束 7） */
    readonly staleLockTimeoutMs: number;
  };
  readonly retrieval: {
    /** 分词器（ADR-0004） */
    readonly tokenizer: 'jieba' | 'bigram';
    readonly jiebaDictVersion: string;
    /** 单次检索返回上限 */
    readonly topK: number;
  };
  /** 外部网络默认关闭（§60） */
  readonly allowNetwork: boolean;
}

/** 校验并返回配置；任何缺失的必需项立即报错，不做隐式默认 */
export function validateConfig(input: unknown): ProjectConfig {
  const cfg = input as Partial<ProjectConfig> | null | undefined;
  if (!cfg || typeof cfg !== 'object') {
    throw new AppError(ErrorCode.CONTEXT_BUILD_FAILED, '配置为空或不是对象');
  }
  const cb = cfg.contextBudget;
  if (!cb || typeof cb.inputTokens !== 'number' || cb.inputTokens <= 0) {
    // 研究报告 R3：不得静默退化为无预算
    throw new AppError(
      ErrorCode.CONTEXT_BUDGET_EXCEEDED,
      'contextBudget.inputTokens 必填且必须为正数（不允许缺失时静默退化为无预算）',
      { details: { received: cb } },
    );
  }
  if (typeof cb.protectedMaxTokens !== 'number' || cb.protectedMaxTokens <= 0) {
    throw new AppError(ErrorCode.CONTEXT_BUDGET_EXCEEDED, 'contextBudget.protectedMaxTokens 必填且必须为正数');
  }
  if (cb.protectedMaxTokens > cb.inputTokens) {
    throw new AppError(
      ErrorCode.CONTEXT_BUDGET_EXCEEDED,
      'protectedMaxTokens 不得大于 inputTokens（Protected 装不下应当报错而非裁剪，此处配置本身矛盾）',
      { details: { protectedMaxTokens: cb.protectedMaxTokens, inputTokens: cb.inputTokens } },
    );
  }
  return cfg as ProjectConfig;
}

/**
 * v1.0 默认配置。
 * 注意：默认模型 profile 不含真实密钥；apiKeyRef 指向 OS 凭据存储。
 */
export const DEFAULT_CONFIG: ProjectConfig = {
  language: 'zh-CN',
  contextBudget: {
    inputTokens: 128_000,
    outputReserveTokens: 16_000,
    protectedMaxTokens: 32_000,
  },
  models: {
    slots: {
      architect: 'architect-default',
      writer: 'writer-default',
      reviewer: 'reviewer-default',
      utility: 'utility-default',
    },
    profiles: [],
  },
  review: {
    maxRevisionAttempts: 1,
    netImprovementEpsilon: 3,
  },
  commit: {
    maxConcurrent: 1,
    staleLockTimeoutMs: 5 * 60 * 1000,
  },
  retrieval: {
    tokenizer: 'jieba',
    jiebaDictVersion: '2.0.3',
    topK: 20,
  },
  allowNetwork: false,
};
