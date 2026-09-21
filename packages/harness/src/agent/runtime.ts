/**
 * Agent Runtime（施工文档 §6.2）
 *
 * 四方法：run / pause / resume / cancel。
 *
 * 设计约束：
 *   1. **状态迁移由代码执行**（§8.2）—— Agent 不能自己改章节状态
 *   2. **权限按 agentType 下发**（研究报告 §2.1）—— 审查类 Agent 只读
 *   3. **异常必写 run_events**（§55 Rule 8）—— 由 EventBus 保证，不吞
 *   4. **checkpoint 是阶段级的**（研究报告 R2）—— 恢复时不重跑已完成的昂贵调用
 *
 * 这是对 InkOS 的刻意不同（§1.3 差异 2）：它有 `resumeCursor` 字段但
 * 找不到读取它的代码，崩溃后任务直接丢失。我们要求 resume 从最近完成的
 * 阶段继续，**不重跑已完成的 LLM 调用**。
 */
import { AppError, ErrorCode, Logger, runId as newRunId } from '@nwa/core';
import type { RunEventType, ToolContext } from '@nwa/shared';
import type { RunRepository, CheckpointRow } from '@nwa/storage';
import { EventBus, type EmittedEvent } from '../events/event-bus.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ModelGateway, ModelSlot } from '../models/gateway.js';
import type {
  StructuredRequest,
  StructuredResult,
  ChatRequest,
  ChatResponse,
} from '../models/types.js';
import { AGENT_PERMISSIONS, type AgentHandler, type AgentRunInput, type AgentRunResult, type AgentRunStatus } from './types.js';

export interface AgentRuntimeOptions {
  readonly runs: RunRepository;
  readonly tools: ToolRegistry;
  readonly models: ModelGateway;
  readonly events?: EventBus;
  readonly logger?: Logger;
  /** 当前 schema 版本，写入 checkpoint 用于恢复时校验兼容性 */
  readonly schemaVersion: string;
}

interface ActiveRun {
  readonly input: AgentRunInput;
  status: AgentRunStatus;
  readonly controller: AbortController;
  readonly handler: AgentHandler;
  startedAt: string;
  endedAt?: string;
  output?: unknown;
  artifacts: string[];
  error?: { code: string; message: string; details?: unknown };
  /** 最近一次成功完成的阶段，用于 resume */
  lastCompletedStage: string | null;
}

/** Agent 类型 → 模型槽位（§54 的 4 槽位） */
const SLOT_FOR_AGENT: Record<string, ModelSlot> = {
  planner: 'architect',
  writer: 'writer',
  reviewer: 'reviewer',
  continuity: 'reviewer',
  editor: 'writer',
};

export class AgentRuntime {
  private readonly runs: RunRepository;
  private readonly tools: ToolRegistry;
  private readonly models: ModelGateway;
  private readonly events: EventBus;
  private readonly logger: Logger;
  private readonly schemaVersion: string;
  private readonly handlers = new Map<string, AgentHandler>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly paused = new Set<string>();

  constructor(opts: AgentRuntimeOptions) {
    this.runs = opts.runs;
    this.tools = opts.tools;
    this.models = opts.models;
    this.logger = opts.logger ?? new Logger('harness:agent');
    this.schemaVersion = opts.schemaVersion;
    this.events =
      opts.events ?? new EventBus({ runs: opts.runs, logger: this.logger.child('events') });
  }

  /** EventBus 暴露给 UI 订阅（也便于测试读取） */
  get eventBus(): EventBus {
    return this.events;
  }

  register(handler: AgentHandler): void {
    if (this.handlers.has(handler.agentType)) {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, `Agent 重复注册：${handler.agentType}`);
    }
    this.handlers.set(handler.agentType, handler);
  }

  /** run 状态查询（UI 用） */
  status(runId: string): AgentRunStatus | undefined {
    return this.active.get(runId)?.status;
  }

  listActive(): { runId: string; agentType: string; status: AgentRunStatus }[] {
    return [...this.active.entries()].map(([runId, r]) => ({
      runId,
      agentType: r.input.agentType,
      status: r.status,
    }));
  }

  /** 执行一次 Agent Run */
  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const handler = this.handlers.get(input.agentType);
    if (!handler) {
      throw new AppError(
        ErrorCode.NOT_IMPLEMENTED,
        `未注册的 Agent 类型：${input.agentType}`,
        { details: { registered: [...this.handlers.keys()] } },
      );
    }

    const runId = input.runId || newRunId();
    const startedAt = new Date().toISOString();
    const controller = new AbortController();

    // 落库 Run（§10.16）
    this.runs.create({
      id: runId,
      projectId: input.projectId,
      workflowType: input.agentType,
      modelProfileId: input.modelProfileId ?? null,
      input: { goal: input.goal, mode: input.mode },
    });

    const state: ActiveRun = {
      input: { ...input, runId },
      status: 'RUNNING',
      controller,
      handler,
      startedAt,
      artifacts: [],
      lastCompletedStage: null,
    };
    this.active.set(runId, state);

    this.events.emit({ runId, type: 'RUN_STARTED', payload: { agentType: input.agentType, goal: input.goal } });

    try {
      const permission = AGENT_PERMISSIONS[input.agentType];

      const toolContext: ToolContext = {
        runId,
        projectId: input.projectId,
        // 权限按 Agent 类型下发，**不是**调用方传入 —— 调用方无法提权
        callerPermission: permission,
        emit: (eventType, payload) => {
          this.events.emit({ runId, type: eventType as RunEventType, payload });
        },
      };

      const slot = SLOT_FOR_AGENT[input.agentType] ?? 'utility';

      const result = await handler.execute({
        runId,
        input: { ...input, runId },
        toolContext,
        structured: (req) => this.models.structured(slot, req),
        checkpoint: (stage, s, artifacts) => {
          this.runs.saveCheckpoint({
            id: `${runId}-${stage}-${Date.now()}`,
            runId,
            stage,
            state: s,
            artifactManifest: artifacts ?? {},
            schemaVersion: this.schemaVersion,
          });
          state.lastCompletedStage = stage;
          this.events.emit({ runId, type: 'CHECKPOINT_CREATED', step: stage, payload: { stage } });
        },
        signal: controller.signal,
      });

      state.artifacts = [...(result.artifacts ?? [])];
      state.output = result.output;
      state.status = controller.signal.aborted ? 'CANCELLED' : 'SUCCEEDED';
      state.endedAt = new Date().toISOString();

      this.runs.finish(
        runId,
        state.status === 'CANCELLED' ? 'CANCELLED' : 'SUCCEEDED',
        result.output ?? null,
        null,
      );
      this.events.emit({
        runId,
        type: state.status === 'CANCELLED' ? 'RUN_CANCELLED' : 'STEP_STARTED',
        payload: { finalStatus: state.status, artifacts: state.artifacts },
      });

      return this.toResult(state);
    } catch (err) {
      // §55 Rule 8：异常必须落 run_events，绝不吞
      const appErr = AppError.from(err);
      state.error = appErr.toJSON();
      state.status = controller.signal.aborted ? 'CANCELLED' : 'FAILED';
      state.endedAt = new Date().toISOString();

      if (state.status === 'CANCELLED') {
        this.events.emit({ runId, type: 'RUN_CANCELLED', payload: { reason: appErr.message } });
        this.runs.finish(runId, 'CANCELLED', null, appErr.toJSON());
      } else {
        this.events.emitFailure({
          runId,
          error: err,
          lastKnownStatus: state.lastCompletedStage ?? undefined,
        });
        this.runs.finish(runId, 'FAILED', null, appErr.toJSON());
      }
      this.logger.error(`Agent Run 失败：${input.agentType}`, err, { runId });
      return this.toResult(state);
    } finally {
      this.active.delete(runId);
      this.paused.delete(runId);
    }
  }

  /**
   * 暂停。
   *
   * 语义：中止当前的 await（LLM 调用会被 AbortSignal 打断），
   * 但**已完成的 checkpoint 保留**，因此 resume 不必重跑。
   */
  async pause(runId: string): Promise<void> {
    const state = this.requireActive(runId, '暂停');
    if (state.status !== 'RUNNING') {
      throw new AppError(ErrorCode.RUN_CANCELLED, `Run 当前状态为 ${state.status}，无法暂停`);
    }
    this.paused.add(runId);
    state.status = 'PAUSED';
    state.controller.abort(new AppError(ErrorCode.RUN_CANCELLED, '用户暂停'));
    this.events.emit({
      runId,
      type: 'RUN_PAUSED',
      payload: { lastCompletedStage: state.lastCompletedStage },
    });
    this.logger.info('Run 已暂停', { runId, lastCompletedStage: state.lastCompletedStage });
  }

  /**
   * 从最近的 checkpoint 恢复。
   *
   * ⚠ resume 需要调用方重新提供 handler（进程重启后内存状态已丢失），
   *   因此这里返回恢复上下文，由调用方重新发起 run —— 
   *   但**不会**让调用方重跑已完成的阶段：`lastCompletedStage` 已告知进度。
   */
  async resume(runId: string): Promise<{ runId: string; resumeFrom: string | null; state: unknown }> {
    const ckpt = this.runs.latestCheckpoint(runId);
    if (!ckpt) {
      throw new AppError(ErrorCode.CHECKPOINT_NOT_FOUND, `找不到可恢复的 checkpoint：${runId}`, {
        details: { runId },
      });
    }
    // 校验 schema 版本兼容性 —— 版本不一致时不能盲目续跑
    if (ckpt.schema_version !== this.schemaVersion) {
      throw new AppError(
        ErrorCode.WORKSPACE_CORRUPTED,
        `checkpoint 的 schema 版本（${ckpt.schema_version}）与当前（${this.schemaVersion}）不一致，拒绝恢复`,
        { details: { checkpointVersion: ckpt.schema_version, current: this.schemaVersion } },
      );
    }
    const { state } = this.runs.readCheckpoint<unknown>(ckpt);
    this.events.emit({
      runId,
      type: 'RUN_RESUMED',
      payload: { fromStage: ckpt.stage },
    });
    this.logger.info('Run 恢复', { runId, fromStage: ckpt.stage });
    return { runId, resumeFrom: ckpt.stage, state };
  }

  /** 取消：与暂停的区别是**不保留可恢复性**（用户明确放弃） */
  async cancel(runId: string): Promise<void> {
    const state = this.requireActive(runId, '取消');
    state.status = 'CANCELLED';
    state.controller.abort(new AppError(ErrorCode.RUN_CANCELLED, '用户取消'));
    this.events.emit({ runId, type: 'RUN_CANCELLED', payload: { byUser: true } });
    this.logger.info('Run 已取消', { runId });
  }

  /** 读取某个 Run 的全部事件（测试与 UI） */
  eventsFor(runId: string): EmittedEvent[] {
    return this.events.list(runId);
  }

  /**
   * 供 Planner 等「非 Agent Run」场景使用的结构化输出器。
   *
   * 为什么需要它：Planner 目前由 UI 直接触发（不经 Agent Runtime 的 run 循环），
   * 但仍需要 Model Gateway 的三级降级能力。这里把 gateway 的能力原样暴露，
   * **不**注入任何 Agent 上下文 —— 调用方自己决定权限与事件记录。
   */
  plannerStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return this.models.structured('architect', req);
  }

  /** 通用结构化输出（指定槽位） */
  structured<T>(slot: ModelSlot, req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return this.models.structured(slot, req);
  }

  /**
   * 供 Writer 等场景使用的纯文本补全。
   *
   * 与 plannerStructured 同理：把 gateway 的能力原样暴露，
   * 不做 Agent 上下文注入 —— Writer 只需要模型把文字写出来。
   */
  completeText(
    slot: ModelSlot,
    req: {
      readonly messages: ChatRequest['messages'];
      readonly maxTokens?: number | undefined;
      readonly temperature?: number | undefined;
    },
  ): Promise<ChatResponse> {
    // ChatRequest 把 temperature/maxTokens 声明为必填，但那是 gateway 内部
    // 与 provider 之间的约定。调用方（Writer）只关心内容，不应被迫
    // 知道模型的默认温度 —— 这里用与 gateway 一致的默认值补齐。
    return this.models.chat(slot, {
      messages: req.messages,
      temperature: req.temperature ?? 0.7,
      maxTokens: req.maxTokens ?? 4096,
    });
  }

  /** 最近一次 checkpoint（恢复入口的只读查询） */
  lastCheckpoint(runId: string): CheckpointRow | undefined {
    return this.runs.latestCheckpoint(runId);
  }

  private requireActive(runId: string, action: string): ActiveRun {
    const state = this.active.get(runId);
    if (!state) {
      throw new AppError(ErrorCode.CHECKPOINT_NOT_FOUND, `${action}失败：Run ${runId} 不在运行中`);
    }
    return state;
  }

  private toResult(state: ActiveRun): AgentRunResult {
    return {
      runId: state.input.runId,
      status: state.status,
      ...(state.output === undefined ? {} : { output: state.output }),
      artifacts: state.artifacts,
      ...(state.error === undefined ? {} : { error: state.error }),
      startedAt: state.startedAt,
      endedAt: state.endedAt ?? new Date().toISOString(),
    };
  }
}
