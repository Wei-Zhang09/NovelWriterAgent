/**
 * 工作流持久化仓储（P0-2 的核心）
 *
 * ## 这一层为什么存在
 *
 * 提示词 §四 的要求：
 *
 *   > 不要依赖内存中的 Map / Set / AbortController / latestCheckpoint
 *   > 作为唯一恢复依据。内存状态只能作为运行时缓存。
 *
 * 原实现恰好相反 —— 恢复依据全在内存：
 *
 *   private readonly active = new Map<string, ActiveRun>();
 *   private readonly paused = new Set<string>();
 *   state.lastCompletedStage
 *
 * 进程一关全部丢失。重启后既不知道跑到哪，也不知道哪些昂贵 LLM 阶段
 * 已经完成，只能从头再跑一遍（提示词 §四 明确禁止）。
 *
 * 所以恢复依据必须落库，本仓储就是那个"依据"的读写口。
 *
 * ## 为什么 DONE 判定要在这里做
 *
 * 「DONE 的 Stage 永远不会重复执行」是 P0-2 的硬要求。它由数据库的
 * `UNIQUE(workflow_id, stage_id)` 提供最终保证，本仓储负责读写。
 */
import { AppError, ErrorCode, Logger, type Nullable } from '@nwa/core';
import type { Database } from '@nwa/storage';
import type {
  StageId,
  StageStatus,
  WorkflowArtifactRef,
  WorkflowRecord,
  WorkflowStageRecord,
  WorkflowStatus,
} from './workflow-types.js';

interface WorkflowRow {
  readonly id: string;
  readonly project_id: string;
  readonly book_id: string;
  readonly chapter_id: Nullable<string>;
  readonly chapter_number: Nullable<number>;
  readonly workflow_type: string;
  readonly status: string;
  readonly current_stage: Nullable<string>;
  readonly resume_cursor: Nullable<string>;
  readonly stage_inputs_json: string;
  readonly stage_outputs_json: string;
  readonly artifact_refs_json: string;
  readonly checkpoint_json: Nullable<string>;
  readonly error_json: Nullable<string>;
  readonly created_at: string;
  readonly updated_at: string;
}

interface StageRow {
  readonly id: string;
  readonly workflow_id: string;
  readonly stage_id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly started_at: Nullable<string>;
  readonly ended_at: Nullable<string>;
  readonly attempts: number;
  readonly output_json: Nullable<string>;
  readonly artifact_refs_json: string;
  readonly error_json: Nullable<string>;
}

/** 安全解析 JSON —— 库里若有脏数据，不能因此炸掉恢复流程 */
function parseJson<T>(raw: Nullable<string>, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface CreateWorkflowInput {
  readonly id: string;
  readonly projectId: string;
  readonly bookId: string;
  readonly chapterId?: Nullable<string>;
  readonly chapterNumber?: Nullable<number>;
  readonly workflowType?: string;
  readonly stageInputs?: Record<string, unknown>;
}

export class WorkflowRepository {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger?: Logger) {
    this.db = db;
    this.logger = logger ?? new Logger('harness:workflow-repo');
  }

  create(input: CreateWorkflowInput): WorkflowRecord {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO workflows (
         id, project_id, book_id, chapter_id, chapter_number, workflow_type,
         status, current_stage, resume_cursor,
         stage_inputs_json, stage_outputs_json, artifact_refs_json,
         checkpoint_json, error_json, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      input.id,
      input.projectId,
      input.bookId,
      input.chapterId ?? null,
      input.chapterNumber ?? null,
      input.workflowType ?? 'novel',
      // ⚠ 初始状态是 CREATED，不是 RUNNING —— 引擎显式推进才进入
      //   第一个 stage 的状态。这样"创建了但没跑"与"正在跑"可区分。
      'CREATED',
      null,
      null,
      JSON.stringify(input.stageInputs ?? {}),
      '{}',
      '[]',
      null,
      null,
      now,
      now,
    );
    const created = this.get(input.id);
    if (!created) {
      throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, `工作流创建后读回失败：${input.id}`);
    }
    return created;
  }

  get(id: string): WorkflowRecord | undefined {
    const row = this.db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', id);
    return row ? this.toRecord(row) : undefined;
  }

  /** 列出未结束的工作流 —— 进程重启后用它捞回可恢复的任务 */
  listUnfinished(): WorkflowRecord[] {
    const rows = this.db.all<WorkflowRow>(
      `SELECT * FROM workflows
        WHERE status NOT IN ('DONE','FAILED','CANCELLED')
        ORDER BY created_at DESC`,
    );
    return rows.map((r) => this.toRecord(r));
  }

  listByBook(bookId: string, limit = 50): WorkflowRecord[] {
    const rows = this.db.all<WorkflowRow>(
      'SELECT * FROM workflows WHERE book_id = ? ORDER BY created_at DESC LIMIT ?',
      bookId,
      limit,
    );
    return rows.map((r) => this.toRecord(r));
  }

  /**
   * 推进工作流状态。
   *
   * ⚠ 不接受"从任意状态到任意状态" —— 合法性由 `WorkflowEngine` 判定后
   *   再调用本方法。这里只管持久化，不做策略。
   */
  updateStatus(
    id: string,
    status: WorkflowStatus,
    patch?: {
      currentStage?: Nullable<StageId>;
      resumeCursor?: Nullable<StageId>;
      error?: Nullable<{ code?: string; message: string }>;
      checkpoint?: Nullable<Record<string, unknown>>;
    },
  ): void {
    const now = new Date().toISOString();
    const sets: string[] = ['status = ?', 'updated_at = ?'];
    const args: unknown[] = [status, now];

    if (patch && 'currentStage' in patch) {
      sets.push('current_stage = ?');
      args.push(patch.currentStage ?? null);
    }
    if (patch && 'resumeCursor' in patch) {
      sets.push('resume_cursor = ?');
      args.push(patch.resumeCursor ?? null);
    }
    if (patch && 'error' in patch) {
      sets.push('error_json = ?');
      args.push(patch.error ? JSON.stringify(patch.error) : null);
    }
    if (patch && 'checkpoint' in patch) {
      sets.push('checkpoint_json = ?');
      args.push(patch.checkpoint ? JSON.stringify(patch.checkpoint) : null);
    }

    args.push(id);
    this.db.run(`UPDATE workflows SET ${sets.join(', ')} WHERE id = ?`, ...args);
  }

  /**
   * 绑定章节到工作流。
   *
   * 见 `StageContext.setChapter` 的说明 —— 没有这一步，下游 stage
   * 读到的 chapterId 会一直是 NULL。
   */
  setChapter(workflowId: string, chapterId: string, chapterNumber: number): void {
    this.db.run(
      'UPDATE workflows SET chapter_id = ?, chapter_number = ?, updated_at = ? WHERE id = ?',
      chapterId,
      chapterNumber,
      new Date().toISOString(),
      workflowId,
    );
  }

  /** 写入某个 stage 的输出快照（供下游 stage 与恢复读取） */
  setStageOutput(workflowId: string, stageId: StageId, output: unknown): void {
    const rec = this.get(workflowId);
    if (!rec) {
      throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, `工作流不存在：${workflowId}`);
    }
    const outputs = { ...rec.stageOutputs, [stageId]: output ?? null };
    this.db.run(
      'UPDATE workflows SET stage_outputs_json = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(outputs),
      new Date().toISOString(),
      workflowId,
    );
  }

  // ────────────── stage 级 ──────────────

  /**
   * 初始化全部 stage 行为 PENDING。
   *
   * ⚠ 幂等：已存在则不动（`INSERT OR IGNORE`）。否则 resume 时会把
   *   DONE 的 stage 重置回 PENDING —— 那等于抹掉恢复依据。
   */
  initStages(workflowId: string, stages: readonly { id: StageId; ordinal: number }[]): void {
    for (const s of stages) {
      this.db.run(
        `INSERT OR IGNORE INTO workflow_stages
           (id, workflow_id, stage_id, ordinal, status, attempts, artifact_refs_json)
         VALUES (?,?,?,?, 'PENDING', 0, '[]')`,
        `${workflowId}:${s.id}`,
        workflowId,
        s.id,
        s.ordinal,
      );
    }
  }

  listStages(workflowId: string): WorkflowStageRecord[] {
    const rows = this.db.all<StageRow>(
      'SELECT * FROM workflow_stages WHERE workflow_id = ? ORDER BY ordinal ASC',
      workflowId,
    );
    return rows.map((r) => this.toStage(r));
  }

  getStage(workflowId: string, stageId: StageId): WorkflowStageRecord | undefined {
    const row = this.db.get<StageRow>(
      'SELECT * FROM workflow_stages WHERE workflow_id = ? AND stage_id = ?',
      workflowId,
      stageId,
    );
    return row ? this.toStage(row) : undefined;
  }

  /**
   * 已 DONE 的 stage 集合 —— **恢复逻辑的唯一依据**。
   *
   * 提示词 §四：恢复时跳过 PLAN/WRITE/REVIEW，从 REVISION 继续。
   * 这个集合直接决定"跳过哪些"，因此它必须来自数据库而不是内存。
   */
  doneStages(workflowId: string): Set<StageId> {
    const rows = this.db.all<{ stage_id: string }>(
      "SELECT stage_id FROM workflow_stages WHERE workflow_id = ? AND status = 'DONE'",
      workflowId,
    );
    return new Set(rows.map((r) => r.stage_id as StageId));
  }

  markStageRunning(workflowId: string, stageId: StageId): void {
    this.db.run(
      `UPDATE workflow_stages
          SET status = 'RUNNING', started_at = COALESCE(started_at, ?),
              attempts = attempts + 1
        WHERE workflow_id = ? AND stage_id = ?`,
      new Date().toISOString(),
      workflowId,
      stageId,
    );
  }

  markStageDone(
    workflowId: string,
    stageId: StageId,
    output: unknown,
    artifacts: readonly WorkflowArtifactRef[],
  ): void {
    this.db.run(
      `UPDATE workflow_stages
          SET status = 'DONE', ended_at = ?, output_json = ?, artifact_refs_json = ?
        WHERE workflow_id = ? AND stage_id = ?`,
      new Date().toISOString(),
      JSON.stringify(output ?? null),
      JSON.stringify(artifacts),
      workflowId,
      stageId,
    );
  }

  markStageFailed(workflowId: string, stageId: StageId, message: string): void {
    this.db.run(
      `UPDATE workflow_stages
          SET status = 'FAILED', ended_at = ?, error_json = ?
        WHERE workflow_id = ? AND stage_id = ?`,
      new Date().toISOString(),
      JSON.stringify({ message }),
      workflowId,
      stageId,
    );
  }

  markStageSkipped(workflowId: string, stageId: StageId, reason: string): void {
    this.db.run(
      `UPDATE workflow_stages
          SET status = 'SKIPPED', ended_at = ?, output_json = ?
        WHERE workflow_id = ? AND stage_id = ?`,
      new Date().toISOString(),
      JSON.stringify({ skipped: reason }),
      workflowId,
      stageId,
    );
  }

  /** 重置 RUNNING → PENDING（崩溃恢复：上次进程死时留下的中间态） */
  resetRunningStages(workflowId: string): number {
    const res = this.db.run(
      `UPDATE workflow_stages SET status = 'PENDING'
        WHERE workflow_id = ? AND status = 'RUNNING'`,
      workflowId,
    );
    return res.changes;
  }

  // ────────────── artifact ──────────────

  addArtifact(a: {
    id: string;
    workflowId: string;
    stageId: string;
    artifactType: string;
    chapterId?: Nullable<string>;
    path: string;
    contentHash: string;
  }): void {
    this.db.run(
      `INSERT INTO workflow_artifacts
         (id, workflow_id, stage_id, artifact_type, chapter_id, path, content_hash, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      a.id,
      a.workflowId,
      a.stageId,
      a.artifactType,
      a.chapterId ?? null,
      a.path,
      a.contentHash,
      new Date().toISOString(),
    );
  }

  /**
   * 记录一条检索痕迹（P0-3）。
   *
   * ⚠ 为什么要落库：提示词要求最终能回答「为什么这一章会引用那个旧章节」。
   *   检索结果用完即弃的话，事后只能靠猜 —— 而"引用错了旧章节"恰恰是
   *   长篇最容易出、也最难复现的问题。
   *
   * ⚠ workflow_id 可空：单步调试（不经 workflow）也要能记录。
   */
  addRetrievalTraces(
    rows: readonly {
      readonly id: string;
      readonly workflowId: string | null;
      readonly runId?: string | null;
      readonly stage: string;
      readonly query: string;
      readonly retriever: string;
      readonly hitId: string;
      readonly score?: number | null;
      readonly sourceRef?: string | null;
      readonly reason?: string | null;
    }[],
  ): number {
    if (rows.length === 0) return 0;
    const now = new Date().toISOString();
    let n = 0;
    for (const r of rows) {
      try {
        this.db.run(
          `INSERT INTO retrieval_traces
             (id, workflow_id, run_id, stage, query, retriever, hit_id, score, source_ref, reason, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          r.id,
          r.workflowId,
          r.runId ?? null,
          r.stage,
          r.query,
          r.retriever,
          r.hitId,
          r.score ?? null,
          r.sourceRef ?? null,
          r.reason ?? null,
          now,
        );
        n += 1;
      } catch (e) {
        // ⚠ 痕迹写入失败**不能**让写作失败 —— 它是观测，不是流程的一部分。
        //   （同一个坑在 P0-1 已经踩过一次：事件写入把 stage 永久卡死。）
        this.logger.warn('检索痕迹写入失败（不阻断）', {
          stage: r.stage,
          hitId: r.hitId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return n;
  }

  /**
   * 查检索痕迹 —— 回答"这一章的某条引用是怎么来的"。
   *
   * 两种查法都支持：按 workflow+stage（"这一步检索了什么"），
   * 按 hitId（"这个旧章节被谁引用过"）。
   */
  listRetrievalTraces(q: {
    readonly workflowId?: string;
    readonly stage?: string;
    readonly hitId?: string;
    readonly limit?: number;
  }): {
    id: string;
    workflowId: string | null;
    stage: string;
    query: string;
    retriever: string;
    hitId: string;
    score: number | null;
    sourceRef: string | null;
    reason: string | null;
    createdAt: string;
  }[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.workflowId) {
      where.push('workflow_id = ?');
      args.push(q.workflowId);
    }
    if (q.stage) {
      where.push('stage = ?');
      args.push(q.stage);
    }
    if (q.hitId) {
      where.push('hit_id = ?');
      args.push(q.hitId);
    }
    const sql =
      `SELECT * FROM retrieval_traces` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY created_at ASC LIMIT ?`;
    args.push(q.limit ?? 200);

    const rows = this.db.all<{
      id: string;
      workflow_id: string | null;
      stage: string;
      query: string;
      retriever: string;
      hit_id: string;
      score: number | null;
      source_ref: string | null;
      reason: string | null;
      created_at: string;
    }>(sql, ...args);

    return rows.map((r) => ({
      id: r.id,
      workflowId: r.workflow_id,
      stage: r.stage,
      query: r.query,
      retriever: r.retriever,
      hitId: r.hit_id,
      score: r.score,
      sourceRef: r.source_ref,
      reason: r.reason,
      createdAt: r.created_at,
    }));
  }

  listArtifacts(workflowId: string): {
    stageId: string;
    artifactType: string;
    path: string;
    contentHash: string;
  }[] {
    const rows = this.db.all<{
      stage_id: string;
      artifact_type: string;
      path: string;
      content_hash: string;
    }>(
      `SELECT stage_id, artifact_type, path, content_hash
         FROM workflow_artifacts WHERE workflow_id = ? ORDER BY created_at ASC`,
      workflowId,
    );
    return rows.map((r) => ({
      stageId: r.stage_id,
      artifactType: r.artifact_type,
      path: r.path,
      contentHash: r.content_hash,
    }));
  }

  private toRecord(row: WorkflowRow): WorkflowRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      bookId: row.book_id,
      chapterId: row.chapter_id,
      chapterNumber: row.chapter_number,
      workflowType: row.workflow_type,
      status: row.status as WorkflowStatus,
      currentStage: row.current_stage as Nullable<StageId>,
      resumeCursor: row.resume_cursor as Nullable<StageId>,
      stageInputs: parseJson<Record<string, unknown>>(row.stage_inputs_json, {}),
      stageOutputs: parseJson<Record<string, unknown>>(row.stage_outputs_json, {}),
      artifactRefs: parseJson<WorkflowArtifactRef[]>(row.artifact_refs_json, []),
      checkpoint: parseJson<Nullable<Record<string, unknown>>>(row.checkpoint_json, null),
      error: parseJson<Nullable<{ code?: string; message: string }>>(row.error_json, null),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toStage(row: StageRow): WorkflowStageRecord {
    return {
      id: row.id,
      workflowId: row.workflow_id,
      stageId: row.stage_id as StageId,
      ordinal: row.ordinal,
      status: row.status as StageStatus,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      attempts: row.attempts,
      output: parseJson<Nullable<unknown>>(row.output_json, null),
      artifactRefs: parseJson<WorkflowArtifactRef[]>(row.artifact_refs_json, []),
      error: parseJson<Nullable<{ message: string }>>(row.error_json, null),
    };
  }
}
