/**
 * 日志脱敏测试
 *
 * 背景：STEP 3 实测发现脱敏规则过宽 —— 用 `/token/i` 匹配字段名时，
 * `inputTokens` / `outputTokens` 这些**计量字段**也被打成 `***`，
 * 直接破坏了 §57 要求的「Token 使用」可观测性。
 *
 * 因此这里同时锁定两个方向：
 *   1. 真的密钥必须被遮
 *   2. 计量字段必须**原样保留**
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Logger, redactSecret } from '@nwa/core';

describe('redactSecret —— 值级脱敏', () => {
  it('遮住 sk- 开头的密钥', () => {
    expect(redactSecret('sk-abcdefghijklmnop')).toBe('sk-***');
  });

  it('遮住 Anthropic 风格密钥', () => {
    expect(redactSecret('sk-ant-abcdefghijklmnop')).toBe('sk-ant-***');
  });

  it('遮住 Bearer 令牌', () => {
    expect(String(redactSecret('Bearer abcdefghijklmnop.qrstuvwx'))).toContain('Bearer ***');
  });

  it('遮住 JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop';
    expect(redactSecret(jwt)).toBe('jwt-***');
  });

  it('普通文本原样返回', () => {
    expect(redactSecret('这是正文内容，不含密钥')).toBe('这是正文内容，不含密钥');
  });
});

describe('字段名级脱敏', () => {
  it('遮住 apiKey / secret / password / authorization', () => {
    const out = redactSecret({
      apiKey: 'whatever',
      secret: 'whatever',
      password: 'whatever',
      authorization: 'whatever',
      credential: 'whatever',
      api_key: 'whatever',
    }) as Record<string, unknown>;
    for (const k of Object.keys(out)) expect(out[k]).toBe('***');
  });

  it('⚠ 计量字段必须原样保留（曾被过度脱敏）', () => {
    const out = redactSecret({
      inputTokens: 1234,
      outputTokens: 567,
      totalTokens: 1801,
      maxTokens: 16000,
      contextWindow: 128000,
    }) as Record<string, number>;
    expect(out.inputTokens).toBe(1234);
    expect(out.outputTokens).toBe(567);
    expect(out.totalTokens).toBe(1801);
    expect(out.maxTokens).toBe(16000);
    expect(out.contextWindow).toBe(128000);
  });

  it('token / apiToken 这类无计量语义的字段仍被遮', () => {
    const out = redactSecret({ token: 'x', apiToken: 'y' }) as Record<string, unknown>;
    expect(out.token).toBe('***');
    expect(out.apiToken).toBe('***');
  });

  it('嵌套对象也被处理', () => {
    const out = redactSecret({
      request: { apiKey: 'k', inputTokens: 10, nested: { secret: 's' } },
    }) as { request: { apiKey: string; inputTokens: number; nested: { secret: string } } };
    expect(out.request.apiKey).toBe('***');
    expect(out.request.inputTokens).toBe(10);
    expect(out.request.nested.secret).toBe('***');
  });

  it('数组中的字符串值也被脱敏', () => {
    const out = redactSecret(['sk-abcdefghijklmnop', '普通']) as string[];
    expect(out[0]).toBe('sk-***');
    expect(out[1]).toBe('普通');
  });
});

describe('Logger 集成', () => {
  let records: { level: string; message: string; data?: Record<string, unknown> }[];

  beforeEach(() => {
    records = [];
  });

  function makeLogger() {
    return new Logger('test', {
      level: 4,
      sink: (r) => records.push(r as never),
    });
  }

  it('⚠ modelCall 记录里 token 计数必须是数字，不是 ***', () => {
    const logger = makeLogger();
    logger.modelCall({
      runId: 'run_1',
      agentType: 'writer',
      model: 'test-model',
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:00:01.000Z',
      inputTokens: 1200,
      outputTokens: 800,
      latencyMs: 1000,
      toolRefs: ['chapter.get'],
    });
    const data = records[0]!.data as Record<string, unknown>;
    expect(data.inputTokens).toBe(1200);
    expect(data.outputTokens).toBe(800);
    expect(data.toolRefs).toEqual(['chapter.get']);
  });

  it('日志里的密钥被遮住', () => {
    const logger = makeLogger();
    logger.error('调用失败', undefined, { apiKey: 'sk-realkey12345678' });
    const data = records[0]!.data as Record<string, unknown>;
    expect(data.apiKey).toBe('***');
  });

  it('错误对象被结构化记录（含 code 与 retryable）', () => {
    const logger = makeLogger();
    const err = Object.assign(new Error('boom'), { code: 'MODEL_TIMEOUT' });
    logger.error('失败', err);
    expect(records[0]!.error).toBeDefined();
    expect(records[0]!.error!.message).toBe('boom');
  });

  it('日志级别过滤生效', () => {
    const logger = new Logger('test', { level: 0, sink: (r) => records.push(r as never) });
    logger.info('不该出现');
    logger.error('该出现');
    expect(records).toHaveLength(1);
    expect(records[0]!.message).toBe('该出现');
  });

  it('child logger 继承级别并拼接 scope', () => {
    const logger = makeLogger();
    logger.child('sub').info('x');
    expect(records[0]!.scope).toBe('test:sub');
  });
});
