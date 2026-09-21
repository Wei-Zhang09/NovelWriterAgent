/**
 * 模型错误的分类与重试语义（施工文档 §56）
 *
 * 关键：**区分「可重试」与「不可重试」**。
 *   超时 / 限流 / 5xx  → 可重试（指数退避）
 *   401 / 403          → 不可重试（凭据问题，重试只会浪费配额）
 *   400 / schema 不符  → 不可重试（同样的输入还会失败）
 */
import { AppError, ErrorCode } from '@nwa/core';

export interface HttpFailure {
  readonly status: number;
  readonly bodyText: string;
}

/** 把 HTTP 状态码映射到统一错误码 */
export function classifyHttpFailure(f: HttpFailure, context: string): AppError {
  const head = f.bodyText.slice(0, 300);

  if (f.status === 401 || f.status === 403) {
    return new AppError(ErrorCode.MODEL_AUTH_FAILED, `${context}：凭据被拒（HTTP ${f.status}）`, {
      details: { status: f.status, body: head },
    });
  }
  if (f.status === 429) {
    return new AppError(ErrorCode.MODEL_RATE_LIMIT, `${context}：触发限流（HTTP 429）`, {
      details: { status: f.status, body: head },
    });
  }
  if (f.status >= 500) {
    // 服务端错误可重试
    return new AppError(ErrorCode.MODEL_TIMEOUT, `${context}：服务端错误（HTTP ${f.status}）`, {
      details: { status: f.status, body: head },
      retryable: true,
    });
  }
  return new AppError(ErrorCode.MODEL_TIMEOUT, `${context}：请求被拒（HTTP ${f.status}）`, {
    details: { status: f.status, body: head },
    retryable: false,
  });
}

/** 判断错误是否值得重试（读 AppError 的 retryable） */
export function isRetryable(err: unknown): boolean {
  if (AppError.isAppError(err)) return err.retryable;
  return false;
}

/**
 * 指数退避 + 抖动。
 *
 * 抖动是必要的：多个并发 Run 同时被限流时，无抖动的固定退避会让它们
 * 永远同步重试，形成节拍性冲击。
 */
export function backoffDelayMs(attempt: number, baseMs = 500, capMs = 8000): number {
  const exp = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp * (0.7 + Math.random() * 0.6));
}
