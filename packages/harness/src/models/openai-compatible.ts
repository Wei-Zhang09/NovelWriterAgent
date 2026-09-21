/**
 * OpenAI-compatible 适配器（施工文档 §38）
 *
 * 统一覆盖：OpenAI / DeepSeek / Qwen / Kimi / LM Studio / 任意兼容端点。
 * Anthropic / Gemini 的原生协议差异较大，v1.0 不做（§38 允许后续补专用适配器）。
 *
 * 实现约束：
 *   - 不硬编码任何 endpoint 或模型名（§37）—— 全部来自 ModelProfile
 *   - 密钥通过 SecretStore 注入，**绝不写入日志**（§57）
 *   - 尊重 AbortSignal，支撑 §40 的 pause / cancel
 */
import { AppError, ErrorCode } from '@nwa/core';
import type {
  ChatRequest,
  ChatResponse,
  ChatUsage,
  EmbedRequest,
  EmbedResponse,
  ModelProfile,
  ModelProvider,
  SecretStore,
} from './types.js';
import { classifyHttpFailure } from './errors.js';

/** OpenAI-compatible 的最小响应形状（只声明我们真正读取的字段） */
interface OaiChatChoice {
  readonly message?: { readonly content?: string | null };
  readonly finish_reason?: string | null;
}
interface OaiUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}
interface OaiChatResponse {
  readonly model?: string;
  readonly choices?: readonly OaiChatChoice[];
  readonly usage?: OaiUsage;
  readonly error?: { readonly message?: string; readonly type?: string };
}

export interface OpenAiAdapterOptions {
  /** 取密钥；返回 undefined 表示该 profile 无需密钥 */
  readonly secrets: SecretStore;
  /** 注入 fetch 便于测试替身 */
  readonly fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly kind = 'openai-compatible' as const;
  readonly id: string;

  private readonly profile: ModelProfile;
  private readonly opts: OpenAiAdapterOptions;

  constructor(profile: ModelProfile, opts: OpenAiAdapterOptions) {
    this.profile = profile;
    this.id = profile.id;
    this.opts = opts;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (!this.profile.apiKeyRef) return headers;
    const key = await this.opts.secrets.get(this.profile.apiKeyRef);
    if (!key) {
      throw new AppError(
        ErrorCode.MODEL_AUTH_FAILED,
        `找不到密钥引用 ${this.profile.apiKeyRef}（请在设置中录入）`,
        { details: { apiKeyRef: this.profile.apiKeyRef } },
      );
    }
    headers.authorization = `Bearer ${normalizeBearer(key)}`;
    return headers;
  }

  async chat(input: ChatRequest): Promise<ChatResponse> {
    const f = this.opts.fetchImpl ?? fetch;
    const url = `${this.profile.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const started = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.profile.timeoutMs);
    // 把外部的 abort（pause/cancel）与超时合并
    if (input.signal) {
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let res: Response;
    try {
      res = await f(url, {
        method: 'POST',
        headers: await this.authHeaders(),
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          temperature: input.temperature,
          max_tokens: input.maxTokens,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        // 区分「超时」与「用户取消」，两者语义完全不同
        const byUser = input.signal?.aborted === true;
        throw new AppError(
          byUser ? ErrorCode.RUN_CANCELLED : ErrorCode.MODEL_TIMEOUT,
          byUser ? '请求被取消' : `请求超时（${this.profile.timeoutMs}ms）`,
          { cause: err, retryable: !byUser },
        );
      }
      throw new AppError(ErrorCode.MODEL_TIMEOUT, `网络请求失败：${String(err)}`, {
        cause: err,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }

    const bodyText = await res.text();
    if (!res.ok) {
      throw classifyHttpFailure({ status: res.status, bodyText }, `模型调用失败 ${this.profile.id}`);
    }

    let parsed: OaiChatResponse;
    try {
      parsed = JSON.parse(bodyText) as OaiChatResponse;
    } catch (cause) {
      throw new AppError(ErrorCode.MODEL_STRUCTURED_EMPTY, '响应不是合法 JSON', {
        cause,
        details: { head: bodyText.slice(0, 300) },
      });
    }

    // 有些兼容实现在 HTTP 200 里返回 error 字段
    if (parsed.error) {
      throw new AppError(
        ErrorCode.MODEL_TIMEOUT,
        `上游返回错误：${parsed.error.message ?? parsed.error.type ?? '未知'}`,
        { details: parsed.error, retryable: false },
      );
    }

    const text = parsed.choices?.[0]?.message?.content ?? '';
    return {
      text,
      model: parsed.model ?? input.model,
      finishReason: parsed.choices?.[0]?.finish_reason ?? null,
      latencyMs: Date.now() - started,
      usage: toUsage(parsed.usage),
    };
  }

  async embed(input: EmbedRequest): Promise<EmbedResponse> {
    const f = this.opts.fetchImpl ?? fetch;
    const url = `${this.profile.endpoint.replace(/\/+$/, '')}/embeddings`;
    const res = await f(url, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({ model: input.model, input: input.input }),
    });
    const bodyText = await res.text();
    if (!res.ok) throw classifyHttpFailure({ status: res.status, bodyText }, '向量化失败');
    const parsed = JSON.parse(bodyText) as {
      data?: { embedding?: number[] }[];
      usage?: OaiUsage;
    };
    return {
      vectors: (parsed.data ?? []).map((d) => d.embedding ?? []),
      usage: toUsage(parsed.usage),
    };
  }
}

function toUsage(u: OaiUsage | undefined): ChatUsage {
  const input = u?.prompt_tokens ?? 0;
  const output = u?.completion_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    // 有些实现不给 total_tokens，自行相加以免统计出 0
    totalTokens: u?.total_tokens ?? input + output,
  };
}

/**
 * 归一化密钥：剥掉用户可能一起粘贴进来的 `Bearer ` 前缀。
 *
 * 实测常见的用户输入是直接从文档/抓包结果里复制的 `Bearer sk-xxx`，
 * 若不再处理，会拼成 `Authorization: Bearer Bearer sk-xxx`，
 * 服务端一律 401 —— 而错误信息只会说"凭据被拒"，排查成本很高。
 */
export function normalizeBearer(key: string): string {
  return key.trim().replace(/^Bearer\s+/i, '');
}
