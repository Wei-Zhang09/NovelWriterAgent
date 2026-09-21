/**
 * 分层日志（施工文档 §57）
 *
 * 关键约定：
 *  - LLM 请求必须记录 runId / agentType / model / 时间 / token / latency（§57）
 *  - **默认不把 API Key 写入日志**（§38 / §57）—— 由 redactSecret() 强制
 *  - 日志不是真源：真源是 run_events 表。此处只做进程内可观测性输出。
 */
import { AppError } from './errors.js';

export const LogLevel = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
  TRACE: 4,
} as const;

export type LogLevelName = keyof typeof LogLevel;
export type LogLevelValue = (typeof LogLevel)[keyof typeof LogLevel];

export interface LogRecord {
  readonly level: LogLevelName;
  readonly time: string;
  readonly scope: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
  readonly error?: ReturnType<AppError['toJSON']>;
}

/** 单个 LLM 调用的记录形状（§57 的 9 个字段） */
export interface ModelCallLog {
  readonly runId: string;
  readonly agentType: string;
  readonly model: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly toolRefs: readonly string[];
}

export interface LoggerOptions {
  readonly level?: LogLevelValue;
  /** 输出目标，默认 process.stderr；测试中可注入内存收集器 */
  readonly sink?: (record: LogRecord) => void;
}

/**
 * 脱敏：把疑似密钥的值替换为占位符。
 *
 * 保守策略 —— 宁可多脱敏，也不冒泄漏风险。命中任一模式即替换：
 *   sk-xxx / Bearer xxx / sk-ant-xxx / 长随机串出现在 key/token/secret 字段里
 */
export function redactSecret(value: unknown): unknown {
  if (typeof value === 'string') {
    return (
      value
        // ⚠ 顺序要紧：更具体的规则必须放在更宽泛的前面。
        //   否则 `sk-ant-xxx` 会先被 `sk-` 规则匹配成 `sk-***`，
        //   导致专用的 sk-ant 规则成为永不生效的死代码（实测发现）。
        .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, 'sk-ant-***')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***')
        .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***')
        .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'jwt-***')
    );
  }
  if (Array.isArray(value)) return value.map(redactSecret);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretLikeKey(k) ? '***' : redactSecret(v);
    }
    return out;
  }
  return value;
}

/**
 * 判断字段名是否像「承载密钥的字段」。
 *
 * ⚠ 必须排除计量类字段：`inputTokens` / `outputTokens` / `totalTokens` / `maxTokens`
 *   这些是 §57 要求记录的观测数据，数值本身就是日志内容。
 *   早期版本用 `/token/i` 粗暴匹配，把 token **计数**也打成了 `***`，
 *   直接破坏了「Token 使用」这一可观测性指标（实测发现）。
 */
function isSecretLikeKey(key: string): boolean {
  // 计量字段白名单：即便含 token 字样也不是密钥
  if (/^(inputTokens|outputTokens|totalTokens|maxTokens|contextWindow|tokenBudget)$/i.test(key)) {
    return false;
  }
  return /^(api[_-]?key|.*[_-]?key|token|.*token|secret|.*secret|password|authorization|credential|bearer)$/i.test(
    key,
  );
}

export class Logger {
  private level: LogLevelValue;
  private readonly sink: (record: LogRecord) => void;

  constructor(scope: string, options: LoggerOptions = {}) {
    this.scope = scope;
    this.level = options.level ?? LogLevel.INFO;
    this.sink = options.sink ?? defaultSink;
  }

  private readonly scope: string;

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, { level: this.level, sink: this.sink });
  }

  setLevel(level: LogLevelValue): void {
    this.level = level;
  }

  private emit(level: LogLevelName, message: string, data?: Record<string, unknown>, error?: unknown): void {
    if (LogLevel[level] > this.level) return;
    const record: LogRecord = {
      level,
      time: new Date().toISOString(),
      scope: this.scope,
      message,
      ...(data === undefined ? {} : { data: redactSecret(data) as Record<string, unknown> }),
      ...(error === undefined ? {} : { error: AppError.from(error).toJSON() }),
    };
    this.sink(record);
  }

  error(message: string, error?: unknown, data?: Record<string, unknown>): void {
    this.emit('ERROR', message, data, error);
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.emit('WARN', message, data);
  }
  info(message: string, data?: Record<string, unknown>): void {
    this.emit('INFO', message, data);
  }
  debug(message: string, data?: Record<string, unknown>): void {
    this.emit('DEBUG', message, data);
  }
  trace(message: string, data?: Record<string, unknown>): void {
    this.emit('TRACE', message, data);
  }

  /** LLM 调用专用：自动脱敏 + 固定字段（§57） */
  modelCall(info: ModelCallLog): void {
    this.info('model.call', { ...info });
  }
}

function defaultSink(record: LogRecord): void {
  const line = JSON.stringify(record);
  if (record.level === 'ERROR' || record.level === 'WARN') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const rootLogger = new Logger('nwa');
