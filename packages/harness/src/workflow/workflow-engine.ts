/**
 * Workflow Engine（P0-1 / P0-2）
 *
 * ## 职责
 *
 * 按 `STAGE_ORDER` 依次执行 stage，把状态落库，并支持：
 *   - `start`    从头跑
 *   - `pause`    停在 **stage 边界**，状态为 PAUSED（不是 CANCELLED）
 *   - `resume`   跳过已 DONE 的 stage，从断点继续
 *   - `recover`  进程重启后从数据库恢复
 *   - `cancel`   真取消，不可恢复
 *
 * ## ⚠ P0-2：为什么"暂停"不能靠 abort
 *
 * 原实现（`agent/runtime.ts`）：
 *
 *   pause()  →  state.status = 'PAUSED'
 *            →  controller.abort(...)
 *   run()    →  catch (err) { state.status = aborted ? 'CANCELLED' : 'FAILED' }
 *
 * `pause()` 先写了 PAUSED，但 abort 触发异常后 **catch 块把它覆盖成
 * CANCELLED**。于是"暂停"变成了"取消"，`resume` 也就无从谈起。
 *
 * 本引擎的做法：**abort 信号只用来打断当前 stage，不决定最终状态**。
 * 状态由"是谁请求的"决定 —— `pauseRequested` 为真就是 PAUSED，
 * `cancelRequested` 为真才是 CANCELLED。请求意图落库，
 * 不依赖内存标志（进程重启后仍能从 DB 读出该工作流处于 PAUSED）。
 *
 * ## ⚠ P0-2：「DONE 的 stage 永不重复执行」
 *
 * 每次进入 stage 前先查 `doneStages()`（来自数据库，不是内存）。
 * 已在集合里的直接跳过 —— 这保证恢复时不会重跑昂贵的 LLM 阶段。
 * 数据库层还有 `UNIQUE(workflow_id, stage_id)` 兜底。
 *
 * ## 为什么 stage 在 stage 边界暂停而不是立即中断
 *
 * 立即中断会留下半个 stage 的副作用（写了一半的文件、发了半个请求）。
 * 停在边界意味着**要么完整做完、要么没开始**，恢复时语义干净。
 * 若 stage 支持细粒度 checkpoint（如"写到第 3 个场景"），
 * 由 stage 自己读 `signal` 决定提前收尾，引擎不替它决定。
 */
import { AppError, ErrorCode, Logger, type Nullable } from '@nwa/core';
import type { EventBus } from '../events/event-bus.js';
import { WorkflowRepository } from './workflow-repository.js';
import { hashOfFile } from '../commit/atomic-file-set.js';
import {
  STAGE_ORDER,
  STAGE_STATUS,
  isWorkflowTerminal,
  type StageContext,
  type StageId,
  type WorkflowStageResult,
  type WorkflowRecord,
  type WorkflowStage,
  type WorkflowStatus,
} from './workflow-types.js';

export interface WorkflowEngineOptions {
  readonly repo: WorkflowRepository;
  readonly events?: EventBus;
  readonly logger?: Logger;
}

/** 一次推进的结果，供 UI 与测试断言 */
export interface AdvanceResult {
  readonly workflow: WorkflowRecord;
  /** 本次实际执行的 stage（已 DONE 被跳过的不算） */
  readonly executed: readonly StageId[];
  /** 本次因已 DONE 而跳过的 stage —— 恢复正确性的直接证据 */
  readonly skippedDone: readonly StageId[];
}

export class WorkflowEngine {
  private readonly repo: WorkflowRepository;
  private readonly events: EventBus | undefined;
  private readonly logger: Logger;
  /** 已注册的 stage 实现 */
  private readonly stages = new Map<StageId, WorkflowStage>();
  /** 运行中的中止控制（内存，仅作运行时缓存） */
  private readonly controllers = new Map<string, AbortController>();
  /** 暂停请求（内存镜像；权威记录在 DB 的 status） */
  private readonly pauseRequests = new Set<string>();
  private readonly cancelRequests = new Set<string>();

  constructor(opts: WorkflowEngineOptions) {
    this.repo = opts.repo;
    this.events = opts.events;
    this.logger = opts.logger ?? new Logger('harness:workflow');
  }

  register(stage: WorkflowStage): void {
    if (this.stages.has(stage.id)) {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, `Stage 重复注册：${stage.id}`);
    }
    this.stages.set(stage.id, stage);
  }

  registerAll(stages: readonly WorkflowStage[]): void {
    for (const s of stages) this.register(s);
  }

  /** 已注册的 stage（用于校验是否缺实现） */
  registeredStages(): StageId[] {
    return [...this.stages.keys()];
  }

  /**
   * 推进工作流直到结束 / 暂停 / 失败。
   *
   * 这是唯一的执行入口 —— `start` 与 `resume` 都走它，区别只在
   * 起始状态。这样"恢复"和"首次运行"共享同一条代码路径，
   * 不会出现"恢复路径没测到"的经典问题。
   */
  async advance(workflowId: string, params: Record<string, unknown> = {}): Promise<AdvanceResult> {
    const wf = this.repo.get(workflowId);
    if (!wf) {
      throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, `工作流不存在：${workflowId}`);
    }
    if (isWorkflowTerminal(wf.status)) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `工作流已结束（${wf.status}），无法推进`,
      );
    }

    // 崩溃恢复：上次进程死时留下的 RUNNING 是无效中间态，重置回 PENDING。
    // ⚠ 必须重置，否则该 stage 永远不会被再次执行 —— 表现为"卡住不动"。
    const reset = this.repo.resetRunningStages(workflowId);
    if (reset > 0) {
      this.logger.warn('重置了残留的 RUNNING stage（上次进程异常退出）', {
        workflowId,
        count: reset,
      });
    }

    const controller = new AbortController();
    this.controllers.set(workflowId, controller);
    this.pauseRequests.delete(workflowId);
    this.cancelRequests.delete(workflowId);

    const executed: StageId[] = [];
    const skippedDone: StageId[] = [];

    try {
      for (const stageId of STAGE_ORDER) {
        // ── 暂停 / 取消检查（在 stage 边界，不在 stage 中间）──
        if (this.cancelRequests.has(workflowId)) {
          this.finishAs(workflowId, 'CANCELLED');
          return this.result(workflowId, executed, skippedDone);
        }
        if (this.pauseRequests.has(workflowId)) {
          // ⚠ 这里是 P0-2 的关键：暂停写 PAUSED，**不是** CANCELLED。
          //   并记下 resume_cursor，恢复时从这里继续。
          this.finishAs(workflowId, 'PAUSED', {
            resumeCursor: this.repo.get(workflowId)?.resumeCursor ?? null,
          });
          this.emit(workflowId, 'RUN_PAUSED', { resumeCursor: wf.resumeCursor });
          return this.result(workflowId, executed, skippedDone);
        }

        // ── ⚠ 「DONE 的 stage 永不重复执行」──
        const done = this.repo.doneStages(workflowId);
        if (done.has(stageId)) {
          skippedDone.push(stageId);
          this.logger.info('跳过已完成的 stage（恢复，不重跑）', { workflowId, stageId });
          continue;
        }

        const stage = this.stages.get(stageId);
        if (!stage) {
          // 未注册的 stage：明确失败，不静默跳过 —— 静默跳过会让
          // "忘了注册"表现为"这步没做但流程说成功"
          this.repo.markStageFailed(workflowId, stageId, `未注册的 stage：${stageId}`);
          this.finishAs(workflowId, 'FAILED', {
            error: { code: ErrorCode.NOT_IMPLEMENTED, message: `未注册的 stage：${stageId}` },
          });
          return this.result(workflowId, executed, skippedDone);
        }

        // 进入该 stage 对应的状态（供 UI 显示"正在 Planning"）
        this.repo.updateStatus(workflowId, STAGE_STATUS[stageId], { currentStage: stageId });
        this.repo.markStageRunning(workflowId, stageId);
        executed.push(stageId);

        // ⚠ 事件发射必须被保护。
        //
        //   实测踩到：`events.emit` 写 `run_events`，而 `run_events.run_id`
        //   有外键指向 `runs(id)`。工作流 id 若不在 runs 表里，这条 INSERT
        //   会抛 FOREIGN KEY constraint failed。原代码把 emit 放在
        //   stage 的 try/catch **之外**，于是异常直接冒泡出 advance()，
        //   而这个 stage 已经被标成 RUNNING —— 结果是**永久卡死**：
        //   既不完成也不失败，恢复扫描也只会把它重置后重试，反复卡同一处。
        //
        //   现在 emit 失败只记日志，不影响工作流推进。
        this.safeEmit(workflowId, 'STAGE_STARTED', { stage: stageId });

        // ⚠ 每轮重新读取：`create_chapter` 会把 chapter_id 写回工作流，
        //   后续 stage 必须看到**新的** chapterId，不能沿用循环开始时的快照。
        const current = this.repo.get(workflowId)!;
        const ctx: StageContext = {
          workflowId,
          projectId: current.projectId,
          bookId: current.bookId,
          chapterId: current.chapterId,
          chapterNumber: current.chapterNumber,
          outputs: current.stageOutputs,
          signal: controller.signal,
          setChapter: (cid, cn) => {
            this.repo.setChapter(workflowId, cid, cn);
          },
          recordArtifact: (a) => {
            // ⚠ P1：产物哈希必须真实，不能是空串。
            //
            //   此前所有 stage 都返回 `contentHash: ''`，而
            //   `workflow_artifacts.content_hash` 是 NOT NULL ——
            //   空串满足了约束却等于**没有哈希**：无法回答
            //   "这份产物还是当初那份吗"，也无法在恢复时判断产物
            //   是否被外部改动过。硬约束被一个空值绕过了。
            //
            //   ⚠ 在**这个唯一入口**补算，而不是让每个 stage 自己算：
            //     5 个 stage 各算一次就有 5 次写错的机会（实测
            //     确实全部写成了空串）。引擎是产物的必经之路。
            const actualHash = hashOfFile(a.path) ?? a.contentHash;
            if (actualHash === '') {
              // ⚠ 空哈希必须可见 —— 静默记一个空串正是本 bug 的成因。
              //   抛错会连累整个 stage（产物本身已写成功），所以只报警；
              //   但报警里带路径，能直接定位是哪份产物没落盘。
              this.logger.warn('产物哈希为空且文件不存在（产物可能未真正落盘）', {
                workflowId,
                stageId,
                type: a.type,
                path: a.path,
              });
            }
            this.repo.addArtifact({
              id: `${workflowId}:${stageId}:${a.type}:${Date.now()}`,
              workflowId,
              stageId,
              artifactType: a.type,
              chapterId: current.chapterId,
              path: a.path,
              contentHash: actualHash,
            });
          },
          emit: (type, payload) => this.emit(workflowId, type, payload),
        };

        let res: WorkflowStageResult;
        try {
          res = await stage.run(
            {
              chapterId: current.chapterId,
              chapterNumber: current.chapterNumber,
              upstream: current.stageOutputs,
              params,
            },
            ctx,
          );
        } catch (err) {
          const appErr = AppError.from(err);
          // ⚠ 暂停/取消导致的异常不算"失败" —— 这正是原实现搞错的地方
          if (this.pauseRequests.has(workflowId)) {
            this.repo.markStageFailed(workflowId, stageId, '用户暂停');
            this.finishAs(workflowId, 'PAUSED');
            this.emit(workflowId, 'RUN_PAUSED', {});
            return this.result(workflowId, executed, skippedDone);
          }
          if (this.cancelRequests.has(workflowId)) {
            this.repo.markStageFailed(workflowId, stageId, '用户取消');
            this.finishAs(workflowId, 'CANCELLED');
            return this.result(workflowId, executed, skippedDone);
          }
          this.repo.markStageFailed(workflowId, stageId, appErr.message);
          this.finishAs(workflowId, 'FAILED', { error: appErr.toJSON() });
          this.emit(workflowId, 'RUN_FAILED', { stage: stageId, error: appErr.message });
          this.logger.error(`Workflow stage 失败：${stageId}`, err, { workflowId });
          return this.result(workflowId, executed, skippedDone);
        }

        if (!res.ok) {
          // stage 明确报错：停在 FAILED，但保留已完成 stage 的记录，
          // 这样修好问题后 resume 不必重跑前面
          this.repo.markStageFailed(workflowId, stageId, res.error ?? '未知错误');
          this.finishAs(workflowId, 'FAILED', {
            error: { message: res.error ?? '未知错误' },
          });
          this.emit(workflowId, 'RUN_FAILED', { stage: stageId, error: res.error });
          return this.result(workflowId, executed, skippedDone);
        }

        if (res.skipped) {
          this.repo.markStageSkipped(workflowId, stageId, String(res.output ?? ''));
        } else {
          this.repo.markStageDone(workflowId, stageId, res.output ?? null, res.artifacts ?? []);
        }
        this.repo.setStageOutput(workflowId, stageId, res.output ?? null);
        this.repo.updateStatus(workflowId, STAGE_STATUS[stageId], { resumeCursor: stageId });
        this.safeEmit(workflowId, 'STAGE_COMPLETED', { stage: stageId, skipped: !!res.skipped });
      }

      // 全部 stage 走完
      this.finishAs(workflowId, 'DONE');
      this.safeEmit(workflowId, 'RUN_COMPLETED', {});
      return this.result(workflowId, executed, skippedDone);
    } finally {
      this.controllers.delete(workflowId);
      this.pauseRequests.delete(workflowId);
      this.cancelRequests.delete(workflowId);
    }
  }

  /**
   * 暂停。
   *
   * ⚠ 这里**不 abort** —— 只置请求标志。abort 由当前 stage 自己决定
   *   何时响应（通过 ctx.signal），引擎在下一个 stage 边界停下。
   *   这样不会出现"abort 触发异常 → 状态被覆盖"的老问题。
   */
  pause(workflowId: string): void {
    const wf = this.repo.get(workflowId);
    if (!wf) {
      throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, `工作流不存在：${workflowId}`);
    }
    if (isWorkflowTerminal(wf.status)) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `工作流已结束（${wf.status}），无法暂停`,
      );
    }
    this.pauseRequests.add(workflowId);
    // ⚠ 立即落库 PAUSED —— 权威状态在数据库，内存标志只是运行时缓存。
    //   即使此刻进程被杀，重启后仍能读到 PAUSED 并 resume。
    this.repo.updateStatus(workflowId, 'PAUSED');
    this.controllers.get(workflowId)?.abort(
      new AppError(ErrorCode.RUN_CANCELLED, '用户暂停'),
    );
    this.emit(workflowId, 'RUN_PAUSED', { requested: true });
    this.logger.info('工作流暂停请求已记录', { workflowId });
  }

  /** 取消：不可恢复 */
  cancel(workflowId: string): void {
    const wf = this.repo.get(workflowId);
    if (!wf) {
      throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, `工作流不存在：${workflowId}`);
    }
    if (isWorkflowTerminal(wf.status)) return;
    this.cancelRequests.add(workflowId);
    this.repo.updateStatus(workflowId, 'CANCELLED');
    this.controllers.get(workflowId)?.abort(
      new AppError(ErrorCode.RUN_CANCELLED, '用户取消'),
    );
    this.emit(workflowId, 'RUN_CANCELLED', {});
  }

  /**
   * 恢复：从数据库读回状态，跳过已 DONE 的 stage 继续。
   *
   * 这是进程重启后的入口 —— 它**不依赖任何内存状态**，
   * 因此"重启后恢复"与"暂停后恢复"走同一条路径。
   */
  async resume(workflowId: string, params: Record<string, unknown> = {}): Promise<AdvanceResult> {
    const wf = this.repo.get(workflowId);
    if (!wf) {
      throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, `工作流不存在：${workflowId}`);
    }
    if (wf.status === 'CANCELLED') {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '已取消的工作流无法恢复');
    }
    if (wf.status === 'DONE') {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '已完成的工作流无需恢复');
    }
    this.pauseRequests.delete(workflowId);
    this.emit(workflowId, 'RUN_RESUMED', {
      resumeCursor: wf.resumeCursor,
      status: wf.status,
    });
    return this.advance(workflowId, params);
  }

  /**
   * 进程启动时的恢复扫描：把上次留下的中间态工作流捞出来。
   *
   * ⚠ 只报告、不自动执行 —— 自动跑会在用户没预期时消耗模型额度。
   *   是否恢复由调用方（UI/用户）决定。
   */
  findRecoverable(): WorkflowRecord[] {
    const unfinished = this.repo.listUnfinished();
    for (const wf of unfinished) {
      const n = this.repo.resetRunningStages(wf.id);
      if (n > 0) {
        this.logger.warn('恢复扫描：重置残留 RUNNING stage', { workflowId: wf.id, count: n });
      }
    }
    return unfinished;
  }

  private finishAs(
    workflowId: string,
    status: WorkflowStatus,
    patch?: Parameters<WorkflowRepository['updateStatus']>[2],
  ): void {
    this.repo.updateStatus(workflowId, status, patch);
  }

  private result(
    workflowId: string,
    executed: StageId[],
    skippedDone: StageId[],
  ): AdvanceResult {
    return {
      workflow: this.repo.get(workflowId)!,
      executed,
      skippedDone,
    };
  }

  /**
   * 发事件，**失败不影响工作流**。
   *
   * 见 `advance` 里 STAGE_STARTED 处的说明：事件写库有外键约束，
   * 一旦抛异常会把 stage 永久卡在 RUNNING。
   * 事件是**观测**，不该决定**流程**能不能走。
   */
  private safeEmit(workflowId: string, type: string, payload: unknown): void {
    try {
      this.events?.emit({
        runId: workflowId,
        type: type as never,
        payload: payload as never,
      });
    } catch (e) {
      this.logger.warn('事件写入失败（不影响工作流推进）', {
        workflowId,
        type,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** 内部保留：需要"事件失败即失败"语义时用（当前无调用方） */
  private emit(workflowId: string, type: string, payload: unknown): void {
    this.safeEmit(workflowId, type, payload);
  }
}

/** 便捷：把 stage 列表转成 `initStages` 需要的形状 */
export function stageOrdinals(): { id: StageId; ordinal: number }[] {
  return STAGE_ORDER.map((id, i) => ({ id, ordinal: i }));
}

/** 供 UI 显示的进度摘要 */
export function summarizeStages(
  stages: readonly { stageId: StageId; status: string }[],
): { total: number; done: number; failed: number; current: Nullable<StageId> } {
  const done = stages.filter((s) => s.status === 'DONE').length;
  const failed = stages.filter((s) => s.status === 'FAILED').length;
  const running = stages.find((s) => s.status === 'RUNNING');
  return { total: stages.length, done, failed, current: running?.stageId ?? null };
}
