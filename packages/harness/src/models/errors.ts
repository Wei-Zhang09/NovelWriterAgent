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

/**
 * 把 HTTP 状态码映射到统一错误码。
 *
 * ⚠ 4xx 里 400 与 401/403/429 语义完全不同，不能混为一谈。
 *
 * 实测踩到：400 原本落到 MODEL_TIMEOUT（"请求被拒"用了超时错误码），
 * 于是界面上显示 "MODEL_TIMEOUT: 请求被拒（HTTP 400）" ——
 * 用户看到"超时"会去查网络，而真实原因是请求体不合法（模型名错、
 * max_tokens 超限、参数不被支持）。分类错误会把排查引向错误方向。
 */
export function classifyHttpFailure(f: HttpFailure, context: string): AppError {
  const head = f.bodyText.slice(0, 800);

  // 400 单独归类为 MODEL_REQUEST_INVALID（不可重试：同样的请求还会失败）
  if (f.status === 400 || f.status === 422) {
    return new AppError(
      ErrorCode.MODEL_REQUEST_INVALID,
      `${context}：请求被拒（HTTP ${f.status}）—— ${extractErrorText(head)}`,
      {
        details: { status: f.status, body: head },
        retryable: false,
      },
    );
  }

  if (f.status === 401 || f.status === 403) {
    return new AppError(ErrorCode.MODEL_AUTH_FAILED, `${context}：凭据被拒（HTTP ${f.status}）`, {
      details: { status: f.status, body: head },
    });
  }
  if (f.status === 404) {
    // 常见于 endpoint 路径写错（如漏了 /v1）
    return new AppError(
      ErrorCode.MODEL_REQUEST_INVALID,
      `${context}：接口不存在（HTTP 404）—— 请检查 endpoint 是否为 OpenAI 兼容路径（通常以 /v1 结尾）`,
      { details: { status: f.status, body: head }, retryable: false },
    );
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
  return new AppError(
    ErrorCode.MODEL_REQUEST_INVALID,
    `${context}：请求被拒（HTTP ${f.status}）—— ${extractErrorText(head)}`,
    { details: { status: f.status, body: head }, retryable: false },
  );
}

/**
 * 从错误响应体里抽出人类可读的原因。
 *
 * 兼容三种常见形状：
 *   { "error": { "message": "..." } }   OpenAI / DeepSeek
 *   { "detail": "..." }                 FastAPI / vLLM 等
 *   { "message": "..." }                部分网关
 *
 * ⚠ 这是把"HTTP 400"变成"model 'xxx' does not exist"的关键 ——
 *   否则用户只知道被拒，不知道为何被拒。
 */
export function extractErrorText(bodyText: string): string {
  const raw = bodyText.trim();
  if (raw.length === 0) return '（响应体为空）';
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const err = j['error'];
    if (typeof err === 'string' && err.length > 0) return err;
    if (err && typeof err === 'object') {
      const m = (err as Record<string, unknown>)['message'];
      if (typeof m === 'string' && m.length > 0) return m;
    }
    for (const k of ['detail', 'message', 'msg', 'reason']) {
      const v = j[k];
      if (typeof v === 'string' && v.length > 0) return v;
      // FastAPI 的 detail 可能是数组（校验错误列表）
      if (Array.isArray(v) && v.length > 0) {
        const first = v[0] as Record<string, unknown> | undefined;
        const m = first?.['msg'] ?? first?.['message'];
        if (typeof m === 'string') return m;
        return JSON.stringify(v).slice(0, 200);
      }
    }
  } catch {
    // 非 JSON：直接返回原文片段
  }
  return raw.slice(0, 200);
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
