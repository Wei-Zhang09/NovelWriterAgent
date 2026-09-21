/**
 * Event Bus（施工文档 §39 / §55 Rule 8）
 *
 * 核心约束：**禁止 try/catch 吞异常** —— 任何异常路径都必须调用 emit()，
 * 把结构化错误写进 run_events。
 *
 * 设计要点：
 *   1. 事件类型用集中 enum（研究报告 R8：禁止散落字符串）
 *   2. 每个事件自带 category（STATE / OBSERVABILITY），为 §ADR-0006 的
 *      保留策略留出空间
 *   3. 事件 ID 内容派生（@nwa/core 的 eventId），重放不产生重复
 *   4. **落库失败不能静默**：那会让"可观测性"变成"看起来有日志"
 */
import { Logger, eventId, AppError } from '@nwa/core';
import { categorizeEvent, type RunEventType } from '@nwa/shared';
import type { RunRepository } from '@nwa/storage';

export interface EmittedEvent {
  readonly id: string;
  readonly runId: string;
  readonly type: RunEventType;
  readonly category: 'STATE' | 'OBSERVABILITY';
  readonly step?: string;
  readonly payload?: unknown;
  readonly at: string;
}

export interface EventBusOptions {
  readonly runs: RunRepository;
  readonly logger?: Logger;
  /** 订阅者：UI / 测试可实时收到事件 */
  readonly onEvent?: (e: EmittedEvent) => void;
}

export class EventBus {
  private readonly runs: RunRepository;
  private readonly logger: Logger;
  private readonly onEvent?: (e: EmittedEvent) => void;
  /** 每个 run 内的事件序号，保证 eventId 稳定可预测 */
  private readonly counters = new Map<string, number>();

  constructor(opts: EventBusOptions) {
    this.runs = opts.runs;
    this.logger = opts.logger ?? new Logger('harness:events');
    if (opts.onEvent) this.onEvent = opts.onEvent;
  }

  /**
   * 发出事件并落库。
   *
   * ⚠ 落库失败时**抛出**而不是吞掉：调用方必须知道可观测性已损坏。
   *   这与「日志文件写不进去也要继续跑」不同 —— run_events 是
   *   §40 恢复机制与 §67 指标的数据来源，属于系统状态的一部分。
   */
  emit(input: {
    runId: string;
    type: RunEventType;
    step?: string | undefined;
    payload?: unknown;
  }): EmittedEvent {
    const index = (this.counters.get(input.runId) ?? 0) + 1;
    this.counters.set(input.runId, index);

    const id = eventId({
      chapter: extractChapterNumber(input.payload),
      index,
      payload: { type: input.type, step: input.step ?? null, ...(asRecord(input.payload) ?? {}) },
    });

    const category = categorizeEvent(input.type);

    try {
      this.runs.appendEvent({
        id,
        runId: input.runId,
        eventType: input.type,
        step: input.step ?? null,
        payload: input.payload ?? null,
      });
    } catch (cause) {
      // 不吞：把原始错误包成 AppError 抛出，调用方需据此决定是否中止 Run
      const err = AppError.from(cause);
      this.logger.error('run_events 落库失败', cause, { runId: input.runId, type: input.type, eventId: id });
      throw new AppError(
        err.code,
        `事件落库失败（可观测性已损坏）：${input.type}`,
        { cause, details: { eventId: id, runId: input.runId } },
      );
    }

    const out: EmittedEvent = {
      id,
      runId: input.runId,
      type: input.type,
      category,
      ...(input.step === undefined ? {} : { step: input.step }),
      ...(input.payload === undefined ? {} : { payload: input.payload }),
      at: new Date().toISOString(),
    };

    this.logger.debug('event', { type: out.type, category: out.category, runId: out.runId });
    this.onEvent?.(out);
    return out;
  }

  /** 记录异常（§55 Rule 8 的统一入口，确保异常一定被记录且不被吞） */
  emitFailure(input: {
    runId: string;
    step?: string | undefined;
    error: unknown;
    /** 上次成功到达的状态，便于恢复 */
    lastKnownStatus?: string;
  }): EmittedEvent {
    const err = AppError.from(input.error);
    return this.emit({
      runId: input.runId,
      type: 'RUN_FAILED',
      step: input.step,
      payload: {
        error: err.toJSON(),
        ...(input.lastKnownStatus ? { lastKnownStatus: input.lastKnownStatus } : {}),
      },
    });
  }

  /** 读取某 Run 的事件（供测试与 UI） */
  list(runId: string, category?: 'STATE' | 'OBSERVABILITY'): EmittedEvent[] {
    return this.runs.listEvents(runId, category).map((r) => ({
      id: r.id,
      runId: r.run_id,
      type: r.event_type as RunEventType,
      category: r.category as 'STATE' | 'OBSERVABILITY',
      ...(r.step ? { step: r.step } : {}),
      ...(r.payload_json ? { payload: JSON.parse(r.payload_json) as unknown } : {}),
      at: r.created_at,
    }));
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function extractChapterNumber(payload: unknown): number {
  const rec = asRecord(payload);
  const n = rec?.chapterNumber ?? rec?.chapter;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}
