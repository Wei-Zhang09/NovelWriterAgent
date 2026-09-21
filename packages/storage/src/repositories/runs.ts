/**
 * runs / run_events / checkpoints 仓储（施工文档 §10.16 - §10.18 + ADR-0006）
 *
 * ADR-0006 约束 B：run_events 必须带 category。
 *   STATE         —— 审计与恢复必需，长期保留
 *   OBSERVABILITY —— 调试与统计，可过期删除
 * 分类由 @nwa/shared 的 categorizeEvent() 单一来源决定，此处只做持久化。
 */
import type { Database } from '../database.js';
import { categorizeEvent, type RunEventType } from '@nwa/shared';
import { now, parseJsonColumn, requireRow, serializeJsonColumn } from './types.js';

export interface RunRow {
  readonly id: string;
  readonly project_id: string;
  readonly workflow_type: string;
  readonly status: string;
  readonly current_step: string | null;
  readonly model_profile_id: string | null;
  readonly input_json: string | null;
  readonly output_json: string | null;
  readonly error_json: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
}

export interface RunEventRow {
  readonly id: string;
  readonly run_id: string;
  readonly event_type: string;
  readonly category: string;
  readonly step: string | null;
  readonly payload_json: string | null;
  readonly created_at: string;
}

export interface CheckpointRow {
  readonly id: string;
  readonly run_id: string;
  readonly stage: string;
  readonly state_json: string;
  readonly artifact_manifest_json: string;
  readonly schema_version: string;
  readonly created_at: string;
}

export class RunRepository {
  constructor(private readonly db: Database) {}

  create(input: {
    id: string;
    projectId: string;
    workflowType: string;
    modelProfileId?: string | null;
    input?: unknown;
    status?: string;
  }): RunRow {
    this.db.run(
      `INSERT INTO runs
         (id, project_id, workflow_type, status, current_step, model_profile_id,
          input_json, output_json, error_json, started_at, ended_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, NULL)`,
      input.id,
      input.projectId,
      input.workflowType,
      input.status ?? 'RUNNING',
      input.modelProfileId ?? null,
      serializeJsonColumn(input.input ?? null),
      now(),
    );
    return this.get(input.id);
  }

  get(id: string): RunRow {
    return requireRow(this.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', id), 'run', id);
  }

  setStep(id: string, step: string): void {
    this.db.run('UPDATE runs SET current_step = ? WHERE id = ?', step, id);
  }

  finish(id: string, status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED', output?: unknown, error?: unknown): RunRow {
    this.db.run(
      'UPDATE runs SET status = ?, output_json = ?, error_json = ?, ended_at = ? WHERE id = ?',
      status,
      serializeJsonColumn(output ?? null),
      serializeJsonColumn(error ?? null),
      now(),
      id,
    );
    return this.get(id);
  }

  listActive(projectId: string): RunRow[] {
    return this.db.all<RunRow>(
      "SELECT * FROM runs WHERE project_id = ? AND status = 'RUNNING' ORDER BY started_at DESC",
      projectId,
    );
  }

  // ── run_events ─────────────────────────────────────────────

  /**
   * 追加事件。category 由事件类型派生（唯一来源在 @nwa/shared）。
   *
   * 施工文档 §55 Rule 8 要求「禁止 try/catch 吞异常」——
   * 因此异常路径必须调用本方法记录，且本方法本身不得吞错。
   */
  appendEvent(input: {
    id: string;
    runId: string;
    eventType: RunEventType;
    step?: string | null;
    payload?: unknown;
  }): RunEventRow {
    const category = categorizeEvent(input.eventType);
    this.db.run(
      `INSERT INTO run_events (id, run_id, event_type, category, step, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.runId,
      input.eventType,
      category,
      input.step ?? null,
      serializeJsonColumn(input.payload ?? null),
      now(),
    );
    return requireRow(
      this.db.get<RunEventRow>('SELECT * FROM run_events WHERE id = ?', input.id),
      'run_event',
      input.id,
    );
  }

  listEvents(runId: string, category?: 'STATE' | 'OBSERVABILITY'): RunEventRow[] {
    if (category) {
      return this.db.all<RunEventRow>(
        'SELECT * FROM run_events WHERE run_id = ? AND category = ? ORDER BY created_at',
        runId,
        category,
      );
    }
    return this.db.all<RunEventRow>(
      'SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at',
      runId,
    );
  }

  countEvents(runId: string, category: 'STATE' | 'OBSERVABILITY'): number {
    const r = this.db.get<{ c: number }>(
      'SELECT count(*) AS c FROM run_events WHERE run_id = ? AND category = ?',
      runId,
      category,
    );
    return r?.c ?? 0;
  }

  // ── checkpoints ────────────────────────────────────────────

  /**
   * 写入阶段级 checkpoint（研究报告 R2）。
   *
   * InkOS 的 `resumeCursor` 字段存在但无读取代码，崩溃后任务直接丢失。
   * 我们要求恢复时能从最近完成的阶段继续，**不重跑已完成的昂贵 LLM 调用**。
   */
  saveCheckpoint(input: {
    id: string;
    runId: string;
    stage: string;
    state: unknown;
    artifactManifest: unknown;
    schemaVersion: string;
  }): CheckpointRow {
    this.db.run(
      `INSERT INTO checkpoints
         (id, run_id, stage, state_json, artifact_manifest_json, schema_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.runId,
      input.stage,
      JSON.stringify(input.state),
      JSON.stringify(input.artifactManifest),
      input.schemaVersion,
      now(),
    );
    return requireRow(
      this.db.get<CheckpointRow>('SELECT * FROM checkpoints WHERE id = ?', input.id),
      'checkpoint',
      input.id,
    );
  }

  /** 取最近 checkpoint（恢复入口） */
  latestCheckpoint(runId: string): CheckpointRow | undefined {
    return this.db.get<CheckpointRow>(
      'SELECT * FROM checkpoints WHERE run_id = ? ORDER BY created_at DESC LIMIT 1',
      runId,
    );
  }

  readCheckpoint<T>(row: CheckpointRow): { state: T; manifest: unknown } {
    return {
      state: parseJsonColumn<T>(row.state_json, 'state_json', row.id) as T,
      manifest: parseJsonColumn<unknown>(row.artifact_manifest_json, 'artifact_manifest_json', row.id),
    };
  }
}
