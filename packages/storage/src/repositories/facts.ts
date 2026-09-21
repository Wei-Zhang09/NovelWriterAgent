/**
 * facts 仓储（施工文档 §10.8 / 研究报告 R7）
 *
 * 关键语义：
 *   1. id 由 factId() 内容派生，因此写入用 INSERT ... ON CONFLICT 做幂等
 *      —— 重放一次投影不得产生重复事实。
 *   2. **不得直接写 CANON**。CANON 只能由 Commit 流程推进，
 *      正常写入路径产出的是 PROVISIONAL。
 */
import type { Database } from '../database.js';
import { AppError, ErrorCode } from '@nwa/core';
import { now, requireRow, type Timestamped } from './types.js';

export type FactStatus = 'CANON' | 'PROVISIONAL' | 'CONTRADICTED' | 'RETIRED';

export interface FactRow extends Timestamped {
  readonly id: string;
  readonly book_id: string;
  readonly subject_type: string;
  readonly subject_id: string | null;
  readonly predicate: string;
  readonly object_value: string;
  readonly status: FactStatus;
  readonly confidence: number;
  readonly source_chapter_id: string | null;
  readonly evidence_id: string | null;
}

export interface ProposeFactInput {
  readonly id: string;
  readonly bookId: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly predicate: string;
  readonly objectValue: string;
  readonly confidence: number;
  readonly sourceChapterId: string | null;
  readonly evidenceId: string | null;
}

export class FactRepository {
  constructor(private readonly db: Database) {}

  /**
   * 提出事实（PROVISIONAL）。
   *
   * 幂等：同一内容派生 id 再次写入不会产生新行（ON CONFLICT DO UPDATE），
   * 只更新 confidence / evidence（因为事实本身没变）。
   *
   * ⚠ 不接受 status 参数 —— CANON 的推进是 promoteToCanon() 的职责，
   *   避免任意调用点把未验证的推断写成权威事实。
   */
  propose(input: ProposeFactInput): FactRow {
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `confidence 必须在 [0,1] 内，收到 ${input.confidence}`,
      );
    }
    const ts = now();
    this.db.run(
      `INSERT INTO facts
         (id, book_id, subject_type, subject_id, predicate, object_value,
          status, confidence, source_chapter_id, evidence_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PROVISIONAL', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         confidence   = excluded.confidence,
         evidence_id  = COALESCE(excluded.evidence_id, facts.evidence_id),
         updated_at   = excluded.updated_at`,
      input.id,
      input.bookId,
      input.subjectType,
      input.subjectId,
      input.predicate,
      input.objectValue,
      input.confidence,
      input.sourceChapterId,
      input.evidenceId,
      ts,
      ts,
    );
    return this.get(input.id);
  }

  /**
   * 推进为 CANON。
   *
   * 前置条件（研究报告 R4）：**必须有可回溯证据**。
   * 无 evidence 的事实不得成为 CANON —— 这条在代码层强制，不靠流程纪律。
   */
  promoteToCanon(id: string): FactRow {
    const fact = this.get(id);
    if (fact.status === 'CANON') return fact;
    if (!fact.evidence_id) {
      throw new AppError(
        ErrorCode.EVIDENCE_NOT_FOUND,
        `事实缺少证据，拒绝推进为 CANON：${id}`,
        { details: { factId: id, predicate: fact.predicate } },
      );
    }
    this.db.run("UPDATE facts SET status = 'CANON', updated_at = ? WHERE id = ?", now(), id);
    return this.get(id);
  }

  /** 标记与已有 Canon 冲突（不覆盖，保留两侧以便人工裁决） */
  markContradicted(id: string, note?: string): FactRow {
    this.db.run(
      "UPDATE facts SET status = 'CONTRADICTED', updated_at = ? WHERE id = ?",
      now(),
      id,
    );
    const row = this.get(id);
    return note ? { ...row } : row;
  }

  retire(id: string): FactRow {
    this.db.run("UPDATE facts SET status = 'RETIRED', updated_at = ? WHERE id = ?", now(), id);
    return this.get(id);
  }

  get(id: string): FactRow {
    return requireRow(this.db.get<FactRow>('SELECT * FROM facts WHERE id = ?', id), 'fact', id);
  }

  /** 取某书中某主体某谓词的当前事实（用于冲突检测） */
  find(subjectType: string, subjectId: string | null, predicate: string, objectValue: string): FactRow | undefined {
    return this.db.get<FactRow>(
      `SELECT * FROM facts
       WHERE subject_type = ? AND COALESCE(subject_id,'') = COALESCE(?,'')
         AND predicate = ? AND object_value = ?`,
      subjectType,
      subjectId,
      predicate,
      objectValue,
    );
  }

  listByStatus(bookId: string, status: FactStatus): FactRow[] {
    return this.db.all<FactRow>(
      'SELECT * FROM facts WHERE book_id = ? AND status = ? ORDER BY created_at',
      bookId,
      status,
    );
  }

  /**
   * 检测矛盾：同一主体 + 同一谓词，但 object 不同且都已是 CANON。
   *
   * 这是 §13 Continuity 的基础查询（如「张三 状态 DEAD」与「张三 状态 ALIVE」并存）。
   */
  findCanonConflicts(bookId: string): { subjectType: string; subjectId: string | null; predicate: string; values: string[] }[] {
    // 注意：别名不能叫 `values` —— 那是 SQLite 保留字（报 near "values": syntax error）
    return this.db.all<{ subject_type: string; subject_id: string | null; predicate: string; val_list: string }>(
      `SELECT subject_type, subject_id, predicate, GROUP_CONCAT(object_value) AS val_list
       FROM facts
       WHERE book_id = ? AND status = 'CANON'
       GROUP BY subject_type, subject_id, predicate
       HAVING COUNT(DISTINCT object_value) > 1`,
      bookId,
    ).map((r) => ({
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      predicate: r.predicate,
      values: String(r.val_list).split(','),
    }));
  }

  listBySubject(bookId: string, subjectType: string, subjectId: string): FactRow[] {
    return this.db.all<FactRow>(
      'SELECT * FROM facts WHERE book_id = ? AND subject_type = ? AND subject_id = ? ORDER BY created_at',
      bookId,
      subjectType,
      subjectId,
    );
  }
}
