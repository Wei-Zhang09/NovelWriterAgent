/**
 * 统一错误码（施工文档 §56）
 *
 * 约定：错误码是稳定契约，前端与日志依赖它做分支，因此只增不改。
 * 新增错误码必须同时在 docs/adr/ 或施工计划中登记用途。
 */
export const ErrorCode = {
  // ---- 模型层（§37 / §57） ----
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  MODEL_AUTH_FAILED: 'MODEL_AUTH_FAILED',
  MODEL_RATE_LIMIT: 'MODEL_RATE_LIMIT',
  /** v1.0 新增（研究报告 R11）：结构化输出为空或不可解析时使用 */
  MODEL_STRUCTURED_EMPTY: 'MODEL_STRUCTURED_EMPTY',

  // ---- 工具与上下文 ----
  TOOL_VALIDATION_ERROR: 'TOOL_VALIDATION_ERROR',
  TOOL_PERMISSION_DENIED: 'TOOL_PERMISSION_DENIED',
  CONTEXT_BUILD_FAILED: 'CONTEXT_BUILD_FAILED',
  /** v1.0 新增（研究报告 R3）：Protected 内容超出预算，绝不静默裁剪 */
  CONTEXT_BUDGET_EXCEEDED: 'CONTEXT_BUDGET_EXCEEDED',

  // ---- 故事一致性 ----
  CANON_CONFLICT: 'CANON_CONFLICT',
  CONTINUITY_BLOCKED: 'CONTINUITY_BLOCKED',
  EVIDENCE_NOT_FOUND: 'EVIDENCE_NOT_FOUND',
  EVIDENCE_QUOTE_MISMATCH: 'EVIDENCE_QUOTE_MISMATCH',

  // ---- 提交与恢复（ADR-0002 v2） ----
  COMMIT_FAILED: 'COMMIT_FAILED',
  /** CAS 前置条件失败：目标文件在读取与替换之间被外部修改 */
  COMMIT_CONFLICT: 'COMMIT_CONFLICT',
  /** 同一项目目录已有进行中的 Commit */
  COMMIT_LOCKED: 'COMMIT_LOCKED',
  /** 检测到硬链接/短路径别名，拒绝事务 */
  COMMIT_ALIAS_DETECTED: 'COMMIT_ALIAS_DETECTED',
  WORKSPACE_CORRUPTED: 'WORKSPACE_CORRUPTED',
  CHECKPOINT_NOT_FOUND: 'CHECKPOINT_NOT_FOUND',

  // ---- 蒸馏（v1.0 未启用，错误码预留） ----
  CORPUS_PARSE_FAILED: 'CORPUS_PARSE_FAILED',
  DISTILLATION_SCHEMA_FAILED: 'DISTILLATION_SCHEMA_FAILED',
  SKILL_VALIDATION_FAILED: 'SKILL_VALIDATION_FAILED',

  // ---- 存储 ----
  STORAGE_MIGRATION_FAILED: 'STORAGE_MIGRATION_FAILED',
  STORAGE_QUERY_FAILED: 'STORAGE_QUERY_FAILED',

  // ---- 运行控制（§40：长任务必须支持 pause / resume / cancel） ----
  /** 用户主动取消：与超时语义不同，重试没有意义 */
  RUN_CANCELLED: 'RUN_CANCELLED',

  // ---- 通用 ----
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * 错误对象（施工文档 §56）
 *
 * recoverable / retryable 的区别：
 *   recoverable = 系统能自行回到一致状态（如回滚）
 *   retryable   = 重试同样的输入有可能成功（如超时、限流）
 */
export interface AppErrorShape {
  readonly code: ErrorCodeValue;
  readonly message: string;
  readonly recoverable: boolean;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly cause?: unknown;
}

/** 每个错误码的默认可恢复 / 可重试语义 */
const ERROR_SEMANTICS: Record<ErrorCodeValue, { recoverable: boolean; retryable: boolean }> = {
  MODEL_TIMEOUT: { recoverable: true, retryable: true },
  MODEL_AUTH_FAILED: { recoverable: false, retryable: false },
  MODEL_RATE_LIMIT: { recoverable: true, retryable: true },
  MODEL_STRUCTURED_EMPTY: { recoverable: true, retryable: true },

  TOOL_VALIDATION_ERROR: { recoverable: true, retryable: false },
  TOOL_PERMISSION_DENIED: { recoverable: false, retryable: false },
  CONTEXT_BUILD_FAILED: { recoverable: true, retryable: false },
  CONTEXT_BUDGET_EXCEEDED: { recoverable: false, retryable: false },

  CANON_CONFLICT: { recoverable: true, retryable: false },
  CONTINUITY_BLOCKED: { recoverable: true, retryable: false },
  EVIDENCE_NOT_FOUND: { recoverable: true, retryable: false },
  EVIDENCE_QUOTE_MISMATCH: { recoverable: true, retryable: false },

  COMMIT_FAILED: { recoverable: true, retryable: true },
  COMMIT_CONFLICT: { recoverable: false, retryable: false },
  COMMIT_LOCKED: { recoverable: true, retryable: true },
  COMMIT_ALIAS_DETECTED: { recoverable: false, retryable: false },
  WORKSPACE_CORRUPTED: { recoverable: false, retryable: false },
  CHECKPOINT_NOT_FOUND: { recoverable: false, retryable: false },

  CORPUS_PARSE_FAILED: { recoverable: true, retryable: false },
  DISTILLATION_SCHEMA_FAILED: { recoverable: true, retryable: true },
  SKILL_VALIDATION_FAILED: { recoverable: true, retryable: false },

  STORAGE_MIGRATION_FAILED: { recoverable: false, retryable: false },
  STORAGE_QUERY_FAILED: { recoverable: false, retryable: true },

  RUN_CANCELLED: { recoverable: true, retryable: false },

  NOT_IMPLEMENTED: { recoverable: false, retryable: false },
};

/**
 * 应用错误。
 *
 * 施工文档 §55 Rule 8 要求「禁止 try/catch 吞异常」——
 * 使用本类时必须在抛出点携带足够定位信息，禁止 `throw new AppError(code, '')`。
 */
export class AppError extends Error implements AppErrorShape {
  readonly code: ErrorCodeValue;
  readonly recoverable: boolean;
  readonly retryable: boolean;
  readonly details?: unknown;
  override readonly cause?: unknown;

  constructor(
    code: ErrorCodeValue,
    message: string,
    options: { details?: unknown; cause?: unknown; recoverable?: boolean; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    const dflt = ERROR_SEMANTICS[code];
    this.recoverable = options.recoverable ?? dflt.recoverable;
    this.retryable = options.retryable ?? dflt.retryable;
    this.details = options.details;
    this.cause = options.cause;
  }

  /** 序列化为可写入 run_events.payload_json 的普通对象 */
  toJSON(): AppErrorShape {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }

  static isAppError(value: unknown): value is AppError {
    return value instanceof AppError;
  }

  /** 把任意 unknown 收敛成 AppError（用于 catch 边界，避免丢信息） */
  static from(value: unknown, fallbackCode: ErrorCodeValue = ErrorCode.STORAGE_QUERY_FAILED): AppError {
    if (value instanceof AppError) return value;
    if (value instanceof Error) {
      return new AppError(fallbackCode, value.message, { cause: value });
    }
    return new AppError(fallbackCode, String(value), { details: value });
  }
}

/** 通用的「可能为 null」标注 —— 与 undefined 区分：null 表示"明确查过但没有" */
export type Nullable<T> = T | null;
