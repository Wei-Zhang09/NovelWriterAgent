/**
 * Model Gateway 集成测试（STEP 3 验收核心）
 *
 * 用**真实的 HTTP 服务器**（127.0.0.1 随机端口）而非 mock fetch，
 * 因为要验证的正是 HTTP 状态码映射、超时、AbortSignal 这些传输层行为 ——
 * 用 stub 替换 fetch 会把要测的东西测掉。
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import { ModelGateway, classifyHttpFailure, isRetryable, backoffDelayMs, extractJson, normalizeBearer } from '@nwa/harness';
import { AppError, ErrorCode } from '@nwa/core';
import type { ModelProfile, SecretStore } from '@nwa/harness';

// ── 测试用的 HTTP 替身 ───────────────────────────────────────

interface Handler {
  (req: { url: string; headers: Record<string, string | string[] | undefined>; body: unknown }):
    | { status: number; body: unknown; delayMs?: number }
    | Promise<{ status: number; body: unknown; delayMs?: number }>;
}

let server: Server;
let baseUrl = '';
let handler: Handler = () => ({ status: 200, body: {} });
const requests: { url: string; headers: Record<string, unknown>; body: unknown }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: unknown = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = raw;
      }
      requests.push({ url: req.url ?? '', headers: req.headers, body: parsed });
      const r = await handler({ url: req.url ?? '', headers: req.headers, body: parsed });
      const send = () => {
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      };
      if (r.delayMs) setTimeout(send, r.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  requests.length = 0;
  handler = () => ({ status: 200, body: {} });
});

// ── 测试替身 ─────────────────────────────────────────────────

const secrets: SecretStore = {
  backend: 'memory-test',
  get: async (ref) => (ref === 'test-key' ? 'sk-secret-value-123456' : undefined),
  set: async () => {},
  delete: async () => {},
};

function profile(over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'p1',
    provider: 'openai-compatible',
    endpoint: baseUrl,
    model: 'test-model',
    apiKeyRef: 'test-key',
    temperature: 0.8,
    maxTokens: 1000,
    contextWindow: 8000,
    timeoutMs: 3000,
    retryPolicy: { maxAttempts: 3 },
    ...over,
  };
}

function gateway(profiles: ModelProfile[], slots?: Partial<Record<string, string>>) {
  return new ModelGateway({
    profiles,
    slots: {
      architect: profiles[0]!.id,
      writer: profiles[0]!.id,
      reviewer: profiles[0]!.id,
      utility: profiles[0]!.id,
      ...slots,
    } as never,
    secrets,
    sleepImpl: async () => {}, // 不真实等待，让重试测试秒过
  });
}

const okChat = (content = '你好') => ({
  status: 200,
  body: {
    model: 'test-model',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  },
});

// ── 测试 ─────────────────────────────────────────────────────

describe('正常调用', () => {
  it('成功返回文本与 token 统计', async () => {
    handler = () => okChat('第一章的内容');
    const gw = gateway([profile()]);
    const res = await gw.chat('writer', {
      messages: [{ role: 'user', content: '写第一章' }],
      temperature: 0.8,
      maxTokens: 500,
    });
    expect(res.text).toBe('第一章的内容');
    expect(res.usage.inputTokens).toBe(10);
    expect(res.usage.outputTokens).toBe(5);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('请求携带 Bearer 鉴权头与正确的 endpoint', async () => {
    handler = () => okChat();
    const gw = gateway([profile()]);
    await gw.chat('writer', { messages: [{ role: 'user', content: 'x' }], temperature: 0.5, maxTokens: 10 });
    expect(requests[0]!.url).toBe('/chat/completions');
    expect(requests[0]!.headers.authorization).toBe('Bearer sk-secret-value-123456');
  });

  it('缺 total_tokens 时自行相加（避免统计成 0）', async () => {
    handler = () => ({
      status: 200,
      body: {
        model: 'm', choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      },
    });
    const res = await gateway([profile()]).chat('writer', {
      messages: [{ role: 'user', content: 'x' }], temperature: 0.5, maxTokens: 10,
    });
    expect(res.usage.totalTokens).toBe(10);
  });

  it('调用记录写入 callLog（§57 可观测性）', async () => {
    handler = () => okChat();
    const gw = gateway([profile()]);
    await gw.chat('architect', { messages: [{ role: 'user', content: 'x' }], temperature: 0.5, maxTokens: 10 });
    const log = gw.callLog();
    expect(log).toHaveLength(1);
    expect(log[0]!.slot).toBe('architect');
    expect(log[0]!.inputTokens).toBe(10);
  });
});

describe('HTTP 错误码映射（§56）', () => {
  it('401 → MODEL_AUTH_FAILED 且不可重试', () => {
    const e = classifyHttpFailure({ status: 401, bodyText: 'unauthorized' }, 'ctx');
    expect(e.code).toBe(ErrorCode.MODEL_AUTH_FAILED);
    expect(e.retryable).toBe(false);
  });

  it('429 → MODEL_RATE_LIMIT 且可重试', () => {
    const e = classifyHttpFailure({ status: 429, bodyText: 'slow down' }, 'ctx');
    expect(e.code).toBe(ErrorCode.MODEL_RATE_LIMIT);
    expect(e.retryable).toBe(true);
  });

  it('500 → 可重试', () => {
    expect(classifyHttpFailure({ status: 500, bodyText: 'boom' }, 'ctx').retryable).toBe(true);
  });

  it('400 → 不可重试（同样的输入还会失败）', () => {
    expect(classifyHttpFailure({ status: 400, bodyText: 'bad' }, 'ctx').retryable).toBe(false);
  });

  it('401 不触发重试（只请求一次）', async () => {
    handler = () => ({ status: 401, body: { error: { message: 'bad key' } } });
    const gw = gateway([profile()]);
    await expect(
      gw.chat('writer', { messages: [{ role: 'user', content: 'x' }], temperature: 0.5, maxTokens: 10 }),
    ).rejects.toThrow(/凭据被拒/);
    expect(requests).toHaveLength(1); // 未重试
  });

  it('429 触发重试，最终成功', async () => {
    let n = 0;
    handler = () => {
      n++;
      return n < 3 ? { status: 429, body: { error: { message: 'rate' } } } : okChat('终于成功');
    };
    const gw = gateway([profile({ retryPolicy: { maxAttempts: 3 } })]);
    const res = await gw.chat('writer', { messages: [{ role: 'user', content: 'x' }], temperature: 0.5, maxTokens: 10 });
    expect(res.text).toBe('终于成功');
    expect(requests).toHaveLength(3);
  });

  it('重试耗尽后抛出最后一个错误', async () => {
    handler = () => ({ status: 503, body: { error: { message: 'unavailable' } } });
    const gw = gateway([profile({ retryPolicy: { maxAttempts: 2 } })]);
    await expect(
      gw.chat('writer', { messages: [{ role: 'user', content: 'x' }], temperature: 0.5, maxTokens: 10 }),
    ).rejects.toThrow(/服务端错误/);
    expect(requests).toHaveLength(2);
  });

  it('HTTP 200 但 body 含 error 字段时也报错（兼容实现常见）', async () => {
    handler = () => ({ status: 200, body: { error: { message: 'quota exceeded' } } });
    await expect(
      gateway([profile()]).chat('writer', { messages: [{ role: 'user', content: 'x' }], temperature: 0.5, maxTokens: 10 }),
    ).rejects.toThrow(/quota exceeded/);
  });
});

describe('超时与取消', () => {
  it('超时抛 MODEL_TIMEOUT 且可重试', async () => {
    handler = () => ({ status: 200, body: okChat().body, delayMs: 500 });
    const gw = gateway([profile({ timeoutMs: 100, retryPolicy: { maxAttempts: 1 } })]);
    let err: unknown;
    try {
      await gw.chat('writer', { messages: [{ role: 'user', content: 'x' }], temperature: 0.5, maxTokens: 10 });
    } catch (e) {
      err = e;
    }
    expect(AppError.isAppError(err)).toBe(true);
    if (AppError.isAppError(err)) {
      expect(err.code).toBe(ErrorCode.MODEL_TIMEOUT);
      expect(err.retryable).toBe(true);
    }
  });

  it('⚠ 用户取消抛 RUN_CANCELLED 且不可重试（与超时区分）', async () => {
    handler = () => ({ status: 200, body: okChat().body, delayMs: 500 });
    const gw = gateway([profile({ timeoutMs: 5000, retryPolicy: { maxAttempts: 3 } })]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);

    let err: unknown;
    try {
      await gw.chat('writer', {
        messages: [{ role: 'user', content: 'x' }], temperature: 0.5, maxTokens: 10, signal: ac.signal,
      });
    } catch (e) {
      err = e;
    }
    expect(AppError.isAppError(err)).toBe(true);
    if (AppError.isAppError(err)) {
      expect(err.code).toBe(ErrorCode.RUN_CANCELLED);
      expect(err.retryable).toBe(false);
    }
    expect(requests.length).toBeLessThanOrEqual(1); // 取消后不再重试
  });
});

describe('结构化输出与三级降级（研究报告 R11）', () => {
  const Schema = z.object({ title: z.string(), scenes: z.array(z.string()) });

  const okStructured = (obj: unknown) => ({
    status: 200,
    body: {
      model: 'm',
      choices: [{ message: { content: JSON.stringify(obj) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    },
  });

  const req = { schema: Schema, schemaName: 'ChapterBrief', messages: [{ role: 'user' as const, content: 'plan' }] };

  it('一次成功', async () => {
    handler = () => okStructured({ title: '第1章', scenes: ['s1'] });
    const r = await gateway([profile()]).structured('architect', req);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.title).toBe('第1章');
      expect(r.attempts).toBe(1);
      expect(r.usedFallback).toBe(false);
    }
  });

  it('剥离 markdown 代码围栏（格式噪声，非"抠 JSON"）', async () => {
    handler = () => ({
      status: 200,
      body: {
        model: 'm',
        choices: [{ message: { content: '```json\n{"title":"T","scenes":[]}\n```' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    const r = await gateway([profile()]).structured('architect', req);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.title).toBe('T');
  });

  it('⚠ 校验失败时重试，重试内成功', async () => {
    let n = 0;
    handler = () => {
      n++;
      // 前两次返回缺字段的 JSON
      return n < 3
        ? okStructured({ title: 'T' })
        : okStructured({ title: 'T', scenes: ['ok'] });
    };
    const r = await gateway([profile({ retryPolicy: { maxAttempts: 3 } })]).structured('architect', req);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attempts).toBe(3);
  });

  it('⚠ 空内容也算失败并进入重试（DeepSeek 类模型的真实坑）', async () => {
    let n = 0;
    handler = () => {
      n++;
      return n < 2
        ? { status: 200, body: { model: 'm', choices: [{ message: { content: '' }, finish_reason: 'stop' }], usage: {} } }
        : okStructured({ title: 'OK', scenes: [] });
    };
    const r = await gateway([profile({ retryPolicy: { maxAttempts: 3 } })]).structured('architect', req);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attempts).toBe(2);
  });

  it('⚠ 主 profile 失败后降级到备用 profile', async () => {
    let n = 0;
    handler = () => {
      n++;
      return n === 1
        ? okStructured({ bad: 'shape' })  // 主 profile 首个响应不合 schema
        : okStructured({ title: '备用成功', scenes: ['s'] });
    };
    const primary = profile({ id: 'primary', retryPolicy: { maxAttempts: 1, structuredFallbackProfileId: 'backup' } });
    const backup = profile({ id: 'backup', retryPolicy: { maxAttempts: 1 } });
    const r = await gateway([primary, backup], { architect: 'primary' }).structured('architect', req);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.usedFallback).toBe(true);
      expect(r.data.title).toBe('备用成功');
    }
  });

  it('全部失败时返回 MODEL_STRUCTURED_EMPTY 并带 rawText', async () => {
    handler = () => ({
      status: 200,
      body: {
        model: 'm',
        choices: [{ message: { content: '这是散文，不是 JSON' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    const r = await gateway([profile({ retryPolicy: { maxAttempts: 2 } })]).structured('architect', req);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(ErrorCode.MODEL_STRUCTURED_EMPTY);
      expect(r.rawText).toContain('散文');
      expect(r.attempts).toBe(2);
    }
  });

  it('指向不存在的备用 profile 时不崩溃，仅记录警告', async () => {
    handler = () => okStructured({ bad: 1 });
    const primary = profile({ retryPolicy: { maxAttempts: 1, structuredFallbackProfileId: 'ghost' } });
    const r = await gateway([primary]).structured('architect', req);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.attempts).toBe(1);
  });
});

describe('槽位路由（§54 四槽位）', () => {
  it('不同槽位可用不同 profile', async () => {
    handler = () => okChat();
    const a = profile({ id: 'arch', model: 'reasoning-model' });
    const w = profile({ id: 'write', model: 'long-context-model' });
    const gw = gateway([a, w], { architect: 'arch', writer: 'write' });

    expect(gw.profileFor('architect').model).toBe('reasoning-model');
    expect(gw.profileFor('writer').model).toBe('long-context-model');
  });

  it('槽位指向不存在的 profile 时报错并说明原因', () => {
    const gw = gateway([profile()], { architect: 'no-such' });
    expect(() => gw.profileFor('architect')).toThrow(/槽位 architect 未配置有效 profile/);
  });

  it('profile id 重复注册被拒绝', () => {
    expect(() => gateway([profile({ id: 'dup' }), profile({ id: 'dup' })])).toThrow(/profile id 重复/);
  });

  it('缺密钥时抛 MODEL_AUTH_FAILED 并指明引用名', async () => {
    handler = () => okChat();
    const p = profile({ apiKeyRef: 'missing-key' });
    await expect(
      gateway([p]).chat('writer', { messages: [{ role: 'user', content: 'x' }], temperature: 0.5, maxTokens: 10 }),
    ).rejects.toThrow(/找不到密钥引用 missing-key/);
  });
});

describe('工具函数', () => {
  it('extractJson 处理裸 JSON / 围栏 / 内嵌对象', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('前言 {"a":3} 后语')).toEqual({ a: 3 });
  });

  it('extractJson 对无法解析的内容返回 undefined（不猜）', () => {
    expect(extractJson('纯散文，没有任何 JSON')).toBeUndefined();
    expect(extractJson('')).toBeUndefined();
    expect(extractJson('{"broken": ')).toBeUndefined();
  });

  it('isRetryable 只对 AppError.retryable 为 true 的返回 true', () => {
    expect(isRetryable(new AppError(ErrorCode.MODEL_TIMEOUT, 'x'))).toBe(true);
    expect(isRetryable(new AppError(ErrorCode.MODEL_AUTH_FAILED, 'x'))).toBe(false);
    expect(isRetryable(new Error('普通错误'))).toBe(false);
  });

  it('⚠ normalizeBearer 剥掉用户误粘贴的 Bearer 前缀', () => {
    // 直接从文档/抓包结果复制时很常见，不处理会拼成 "Bearer Bearer sk-x" → 401
    expect(normalizeBearer('Bearer sk-abc')).toBe('sk-abc');
    expect(normalizeBearer('bearer sk-abc')).toBe('sk-abc');
    expect(normalizeBearer('  Bearer   sk-abc  ')).toBe('sk-abc');
    expect(normalizeBearer('sk-abc')).toBe('sk-abc');
  });

  it('退避延迟有抖动且不超过上限', () => {
    const samples = Array.from({ length: 40 }, () => backoffDelayMs(3, 100, 1000));
    expect(Math.max(...samples)).toBeLessThanOrEqual(1000);
    // 有抖动 → 不应全部相等
    expect(new Set(samples).size).toBeGreaterThan(1);
  });
});
