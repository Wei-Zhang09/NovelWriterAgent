/**
 * 模型错误分类测试（施工文档 §56）
 *
 * ## 触发这组测试的真实 bug
 *
 * 用户看到 "MODEL_TIMEOUT: 模型调用失败 default：请求被拒（HTTP 400）"。
 * 两个问题：
 *   1. **分类错误** —— 400 被映射到 MODEL_TIMEOUT（超时）。
 *      看到"超时"会去查网络，而真实原因是请求体不合法。
 *   2. **原因丢失** —— 服务端响应体里写了为什么被拒，但消息里没有，
 *      用户只知道"被拒"不知道"为何被拒"。
 *
 * 这组测试锁死这两点。
 */
import { describe, it, expect } from 'vitest';
import { classifyHttpFailure, extractErrorText } from '@nwa/harness';
import { ErrorCode } from '@nwa/core';

describe('⚠ 400 必须与超时区分（实测 bug）', () => {
  it('400 → MODEL_REQUEST_INVALID 而不是 MODEL_TIMEOUT', () => {
    const e = classifyHttpFailure(
      { status: 400, bodyText: JSON.stringify({ error: { message: 'model not found' } }) },
      '模型调用失败',
    );
    expect(e.code).toBe(ErrorCode.MODEL_REQUEST_INVALID);
    expect(e.code).not.toBe(ErrorCode.MODEL_TIMEOUT);
  });

  it('400 不可重试（同样的请求还会失败）', () => {
    const e = classifyHttpFailure({ status: 400, bodyText: '{}' }, 'ctx');
    expect(e.retryable).toBe(false);
  });

  it('422 同样归为请求不合法', () => {
    const e = classifyHttpFailure({ status: 422, bodyText: '{}' }, 'ctx');
    expect(e.code).toBe(ErrorCode.MODEL_REQUEST_INVALID);
  });

  it('超时仍归 MODEL_TIMEOUT 且可重试', () => {
    const e = classifyHttpFailure({ status: 503, bodyText: '' }, 'ctx');
    expect(e.code).toBe(ErrorCode.MODEL_TIMEOUT);
    expect(e.retryable).toBe(true);
  });
});

describe('⚠ 错误消息必须带出服务端给的原因', () => {
  it('OpenAI 形状 { error: { message } }', () => {
    const e = classifyHttpFailure(
      { status: 400, bodyText: JSON.stringify({ error: { message: "model 'foo' does not exist" } }) },
      '模型调用失败',
    );
    expect(e.message).toContain("model 'foo' does not exist");
  });

  it('FastAPI 形状 { detail: "..." }', () => {
    const e = classifyHttpFailure(
      { status: 400, bodyText: JSON.stringify({ detail: 'max_tokens too large' }) },
      'ctx',
    );
    expect(e.message).toContain('max_tokens too large');
  });

  it('FastAPI 校验错误数组 { detail: [{ msg }] }', () => {
    const e = classifyHttpFailure(
      { status: 422, bodyText: JSON.stringify({ detail: [{ msg: 'field required', loc: ['body'] }] }) },
      'ctx',
    );
    expect(e.message).toContain('field required');
  });

  it('裸字符串 error 字段', () => {
    const e = classifyHttpFailure({ status: 400, bodyText: JSON.stringify({ error: 'bad request' }) }, 'ctx');
    expect(e.message).toContain('bad request');
  });

  it('非 JSON 响应体直接带原文', () => {
    const e = classifyHttpFailure({ status: 400, bodyText: 'Bad Request: invalid model' }, 'ctx');
    expect(e.message).toContain('invalid model');
  });

  it('空响应体给出明确说明（而非留空）', () => {
    const e = classifyHttpFailure({ status: 400, bodyText: '' }, 'ctx');
    expect(e.message).toContain('响应体为空');
  });

  it('原始响应体保留在 details 里（供 UI 展开）', () => {
    const body = JSON.stringify({ error: { message: 'x' } });
    const e = classifyHttpFailure({ status: 400, bodyText: body }, 'ctx');
    const d = e.details as { status: number; body: string };
    expect(d.status).toBe(400);
    expect(d.body).toContain('x');
  });
});

describe('extractErrorText 的具体行为', () => {
  it('优先取 error.message 而非顶层 message', () => {
    const t = extractErrorText(
      JSON.stringify({ error: { message: 'inner' }, message: 'outer' }),
    );
    expect(t).toBe('inner');
  });

  it('无 error 字段时取 detail', () => {
    expect(extractErrorText(JSON.stringify({ detail: 'D' }))).toBe('D');
  });

  it('取 message 兜底', () => {
    expect(extractErrorText(JSON.stringify({ message: 'M' }))).toBe('M');
  });

  it('超长文本被截断（避免把整页 HTML 塞进消息）', () => {
    const t = extractErrorText('x'.repeat(5000));
    expect(t.length).toBeLessThanOrEqual(200);
  });
});

describe('404 给出可操作的提示', () => {
  it('404 提示检查 endpoint 路径', () => {
    const e = classifyHttpFailure({ status: 404, bodyText: '' }, 'ctx');
    expect(e.code).toBe(ErrorCode.MODEL_REQUEST_INVALID);
    expect(e.message).toContain('/v1');
  });
});

describe('鉴权与限流的分类不被破坏', () => {
  it('401/403 → MODEL_AUTH_FAILED 且不可重试', () => {
    for (const s of [401, 403]) {
      const e = classifyHttpFailure({ status: s, bodyText: '' }, 'ctx');
      expect(e.code).toBe(ErrorCode.MODEL_AUTH_FAILED);
      expect(e.retryable).toBe(false);
    }
  });

  it('429 → MODEL_RATE_LIMIT 且可重试', () => {
    const e = classifyHttpFailure({ status: 429, bodyText: '' }, 'ctx');
    expect(e.code).toBe(ErrorCode.MODEL_RATE_LIMIT);
    expect(e.retryable).toBe(true);
  });
});
