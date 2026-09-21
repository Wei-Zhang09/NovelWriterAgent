/**
 * Model Gateway（施工文档 §37 / §38 / §54）
 *
 * 职责：
 *   1. 按 profile id 路由到对应 Provider 实例（缓存，避免重复构造）
 *   2. 统一重试（指数退避 + 抖动，只重试 retryable 错误）
 *   3. 结构化输出：解析失败 → 重试 → 退到备用 profile（研究报告 R11）
 *   4. Token 与耗时记录（§57 的 9 个字段）
 *
 * 任务槽位（§54 收敛为 4 个）：
 *   architect / writer / reviewer / utility
 *   Editor 与 Continuity 复用 writer / utility，不单独占槽。
 */
import { AppError, ErrorCode, Logger } from '@nwa/core';
import type { z } from 'zod';
import { backoffDelayMs, isRetryable } from './errors.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import type {
  ChatRequest,
  ChatResponse,
  ModelProfile,
  ModelProvider,
  SecretStore,
  StructuredRequest,
  StructuredResult,
} from './types.js';

export type ModelSlot = 'architect' | 'writer' | 'reviewer' | 'utility';

export interface GatewayOptions {
  readonly profiles: readonly ModelProfile[];
  /** 槽位 → profile id（§54） */
  readonly slots: Record<ModelSlot, string>;
  readonly secrets: SecretStore;
  readonly logger?: Logger;
  readonly fetchImpl?: typeof fetch;
  /** 测试可注入，避免真实等待 */
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * 单次模型调用记录。
 *
 * 字段对齐施工文档 §57 要求的 9 项：runId / agentType / model /
 * startTime / endTime / inputTokens / outputTokens / latency / toolRefs。
 * runId 与 agentType 由调用方（Agent Runtime）提供；STEP 3 尚无 Agent 层，
 * 因此允许为 undefined，但结构保留，避免 STEP 4 改签名。
 */
export interface ModelCallRecord {
  readonly runId?: string;
  readonly agentType?: string;
  readonly profileId: string;
  readonly slot: ModelSlot;
  readonly model: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly attempts: number;
  readonly toolRefs?: readonly string[];
}

export class ModelGateway {
  private readonly providers = new Map<string, ModelProvider>();
  private readonly profiles = new Map<string, ModelProfile>();
  private readonly opts: GatewayOptions;
  private readonly logger: Logger;
  private readonly calls: ModelCallRecord[] = [];

  constructor(opts: GatewayOptions) {
    this.opts = opts;
    this.logger = opts.logger ?? new Logger('harness:models');
    for (const p of opts.profiles) {
      if (this.profiles.has(p.id)) {
        throw new AppError(ErrorCode.MODEL_AUTH_FAILED, `profile id 重复：${p.id}`);
      }
      this.profiles.set(p.id, p);
    }
  }

  /** 已记录的调用（供 Run 可观测性读取，§57） */
  callLog(): readonly ModelCallRecord[] {
    return this.calls;
  }

  profileFor(slot: ModelSlot): ModelProfile {
    const id = this.opts.slots[slot];
    const p = id ? this.profiles.get(id) : undefined;
    if (!p) {
      throw new AppError(
        ErrorCode.MODEL_AUTH_FAILED,
        `槽位 ${slot} 未配置有效 profile（当前指向 ${id ?? '(空)'}）`,
        { details: { slot, profileId: id } },
      );
    }
    return p;
  }

  private providerFor(profile: ModelProfile): ModelProvider {
    const cached = this.providers.get(profile.id);
    if (cached) return cached;
    let created: ModelProvider;
    switch (profile.provider) {
      case 'openai-compatible':
        created = new OpenAiCompatibleProvider(profile, {
          secrets: this.opts.secrets,
          ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        });
        break;
      case 'ollama':
        // Ollama 的 OpenAI 兼容端点（/v1）与 openai-compatible 协议一致，
        // 因此复用同一适配器实现，仅端点与鉴权不同。
        created = new OpenAiCompatibleProvider(profile, {
          secrets: this.opts.secrets,
          ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        });
        break;
      default: {
        const never: never = profile.provider;
        throw new AppError(ErrorCode.NOT_IMPLEMENTED, `未支持的 provider：${String(never)}`);
      }
    }
    this.providers.set(profile.id, created);
    return created;
  }

  /**
   * 带重试的聊天调用。
   *
   * 只重试 retryable 错误（超时 / 429 / 5xx）。
   * 认证失败与 4xx 立即抛出 —— 重试它们只会浪费配额并推迟真正的报错。
   */
  async chat(slot: ModelSlot, input: Omit<ChatRequest, 'model'>): Promise<ChatResponse> {
    const profile = this.profileFor(slot);
    const provider = this.providerFor(profile);
    const maxAttempts = Math.max(1, profile.retryPolicy.maxAttempts);
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = new Date().toISOString();
      try {
        const res = await provider.chat({ ...input, model: profile.model });
        this.record(profile, slot, startedAt, res, attempt);
        return res;
      } catch (err) {
        lastErr = err;
        const retryable = isRetryable(err);
        const isLast = attempt >= maxAttempts;
        this.logger.warn('模型调用失败', {
          profileId: profile.id,
          slot,
          attempt,
          maxAttempts,
          retryable,
          code: AppError.isAppError(err) ? err.code : 'UNKNOWN',
        });
        if (!retryable || isLast) break;
        await this.sleep(backoffDelayMs(attempt));
      }
    }
    throw AppError.from(lastErr);
  }

  /**
   * 结构化输出（研究报告 R11 的核心实现）。
   *
   * 三级降级：
   *   1. 主 profile 解析成功 → 返回
   *   2. 主 profile 解析失败但仍有文本 → 重试（最多 retryPolicy.maxAttempts）
   *   3. 配了 structuredFallbackProfileId → 用备用 profile 再试一轮
   *   4. 全部失败 → MODEL_STRUCTURED_EMPTY（携带 rawText 便于人工排查）
   *
   * ⚠ 这里**不做**「从散文里抠 JSON」的容错（研究报告 §1.2 决策 4）：
   *   宿主绝不 scrape。要么模型按 schema 返回，要么明确失败。
   */
  async structured<T>(slot: ModelSlot, req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    let attempts = 0;
    let usedFallback = false;
    let lastRaw = '';
    let lastErr: { code: string; message: string; details?: unknown } | undefined;

    const tryOnce = async (profile: ModelProfile): Promise<z.SafeParseReturnType<unknown, T>> => {
      attempts++;
      const provider = this.providerFor(profile);
      const res = await provider.chat({
        model: profile.model,
        messages: req.messages,
        temperature: req.temperature ?? profile.temperature,
        maxTokens: req.maxTokens ?? profile.maxTokens,
        ...(req.signal ? { signal: req.signal } : {}),
      });
      lastRaw = res.text;
      return req.schema.safeParse(extractJson(res.text));
    };

    const primary = this.profileFor(slot);
    const maxAttempts = Math.max(1, primary.retryPolicy.maxAttempts);

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const parsed = await tryOnce(primary);
        if (parsed.success) return { ok: true, data: parsed.data, attempts, usedFallback };
        lastErr = {
          code: ErrorCode.MODEL_STRUCTURED_EMPTY,
          message: `${req.schemaName} 校验失败：${describeIssues(parsed.error)}`,
        };
      } catch (err) {
        const e = AppError.from(err);
        lastErr = e.toJSON();
        // 不可重试的错误（如鉴权失败）直接进入 fallback，不浪费剩余尝试
        if (!e.retryable) break;
      }
      if (i < maxAttempts - 1) await this.sleep(backoffDelayMs(i + 1));
    }

    // 备用 profile
    const fallbackId = primary.retryPolicy.structuredFallbackProfileId;
    if (fallbackId) {
      const fb = this.profiles.get(fallbackId);
      if (!fb) {
        this.logger.warn('structuredFallbackProfileId 指向不存在的 profile', { fallbackId });
      } else {
        usedFallback = true;
        this.logger.info('结构化输出降级到备用 profile', { from: primary.id, to: fb.id });
        try {
          const parsed = await tryOnce(fb);
          if (parsed.success) return { ok: true, data: parsed.data, attempts, usedFallback };
          lastErr = {
            code: ErrorCode.MODEL_STRUCTURED_EMPTY,
            message: `备用 profile 校验失败：${describeIssues(parsed.error)}`,
          };
        } catch (err) {
          lastErr = AppError.from(err).toJSON();
        }
      }
    }

    return {
      ok: false,
      error: lastErr ?? {
        code: ErrorCode.MODEL_STRUCTURED_EMPTY,
        message: `${req.schemaName} 结构化输出失败`,
      },
      attempts,
      usedFallback,
      rawText: lastRaw,
    };
  }

  private record(
    profile: ModelProfile,
    slot: ModelSlot,
    startTime: string,
    res: ChatResponse,
    attempts: number,
  ): void {
    const rec: ModelCallRecord = {
      profileId: profile.id,
      slot,
      model: res.model,
      startTime,
      endTime: new Date().toISOString(),
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      latencyMs: res.latencyMs,
      attempts,
    };
    this.calls.push(rec);
    // §57：LLM 请求必须可观测；Logger 内部会做密钥脱敏
    this.logger.modelCall({
      runId: rec.runId ?? 'unassigned',
      agentType: rec.agentType ?? rec.slot,
      model: rec.model,
      startTime: rec.startTime,
      endTime: rec.endTime,
      inputTokens: rec.inputTokens,
      outputTokens: rec.outputTokens,
      latencyMs: rec.latencyMs,
      toolRefs: rec.toolRefs ?? [],
    });
  }

  private async sleep(ms: number): Promise<void> {
    if (this.opts.sleepImpl) return this.opts.sleepImpl(ms);
    await new Promise((r) => setTimeout(r, ms));
  }
}

/**
 * 从模型输出中提取 JSON。
 *
 * 允许剥离 markdown 代码围栏（```json ... ```）—— 这是**格式噪声**，
 * 不是「从散文里抠 JSON」。若文本里没有完整 JSON 对象，返回 undefined 让校验失败。
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  // 直接是 JSON
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 继续尝试剥离围栏 */
  }

  // ```json ... ``` 或 ``` ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* 继续 */
    }
  }

  // 最外层花括号
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* 放弃 */
    }
  }
  return undefined;
}

function describeIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 4)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('；');
}
