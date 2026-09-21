/**
 * chapters 仓储（施工文档 §10.3）
 *
 * 关键约束：章节正文的**正式文件**（chapters/NNN.md）只在 Commit 后存在，
 * 因此 body_path 在 COMMITTED 之前必须为 NULL。此约束在代码层强制。
 */
import type { Database } from '../database.js';
import { AppError, ErrorCode } from '@nwa/core';
import { now, parseJsonColumn, requireRow, serializeJsonColumn, type Timestamped } from './types.js';

export interface ChapterRow extends Timestamped {
  readonly id: string;
  readonly book_id: string;
  readonly chapter_number: number;
  readonly title: string | null;
  readonly status: string;
  readonly plan_json: string | null;
  readonly body_path: string | null;
  readonly summary: string | null;
}

export class ChapterRepository {
  constructor(private readonly db: Database) {}

  create(input: {
    id: string;
    bookId: string;
    chapterNumber: number;
    title?: string | null;
    status?: string;
  }): ChapterRow {
    const ts = now();
    this.db.run(
      `INSERT INTO chapters
         (id, book_id, chapter_number, title, status, plan_json, body_path, summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      input.id,
      input.bookId,
      input.chapterNumber,
      input.title ?? null,
      input.status ?? 'DRAFT',
      ts,
      ts,
    );
    return this.get(input.id);
  }

  /** 按书 + 章节号查（最常用路径，走 UNIQUE(book_id, chapter_number) 索引） */
  getByNumber(bookId: string, chapterNumber: number): ChapterRow | undefined {
    return this.db.get<ChapterRow>(
      'SELECT * FROM chapters WHERE book_id = ? AND chapter_number = ?',
      bookId,
      chapterNumber,
    );
  }

  get(id: string): ChapterRow {
    return requireRow(
      this.db.get<ChapterRow>('SELECT * FROM chapters WHERE id = ?', id),
      'chapter',
      id,
    );
  }

  listByBook(bookId: string): ChapterRow[] {
    return this.db.all<ChapterRow>(
      'SELECT * FROM chapters WHERE book_id = ? ORDER BY chapter_number',
      bookId,
    );
  }

  listByStatus(bookId: string, status: string): ChapterRow[] {
    return this.db.all<ChapterRow>(
      'SELECT * FROM chapters WHERE book_id = ? AND status = ? ORDER BY chapter_number',
      bookId,
      status,
    );
  }

  /**
   * 已提交章节数。
   *
   * 这是「进度只信物理产物」的落地点之一：不读 runs 表、不读模型输出，
   * 只数 COMMITTED 的章节行（研究报告 §1.2 决策 3）。
   */
  countCommitted(bookId: string): number {
    const row = this.db.get<{ c: number }>(
      "SELECT count(*) AS c FROM chapters WHERE book_id = ? AND status = 'COMMITTED'",
      bookId,
    );
    return row?.c ?? 0;
  }

  updateStatus(id: string, status: string): ChapterRow {
    this.db.run('UPDATE chapters SET status = ?, updated_at = ? WHERE id = ?', status, now(), id);
    return this.get(id);
  }

  savePlan(id: string, plan: unknown): ChapterRow {
    this.db.run(
      'UPDATE chapters SET plan_json = ?, updated_at = ? WHERE id = ?',
      serializeJsonColumn(plan),
      now(),
      id,
    );
    return this.get(id);
  }

  readPlan<T>(id: string): T | null {
    const row = this.get(id);
    return parseJsonColumn<T>(row.plan_json, 'plan_json', id);
  }

  /**
   * 写入正式正文路径。
   *
   * ⚠ 只允许在 Commit 的 APPLY 阶段调用，且 status 必须是 COMMITTING。
   *   这是 §9.1「正文未验证之前不得覆盖正式章节」的代码层强制点，
   *   不依赖调用方自觉。
   */
  setCommittedBody(id: string, bodyPath: string, summary: string): ChapterRow {
    const chapter = this.get(id);
    if (chapter.status !== 'COMMITTING' && chapter.status !== 'COMMITTED') {
      throw new AppError(
        ErrorCode.COMMIT_FAILED,
        `拒绝在状态 ${chapter.status} 写入正式正文（仅允许 COMMITTING/COMMITTED）`,
        { details: { chapterId: id, status: chapter.status } },
      );
    }
    this.db.run(
      'UPDATE chapters SET body_path = ?, summary = ?, status = ?, updated_at = ? WHERE id = ?',
      bodyPath,
      summary,
      'COMMITTED',
      now(),
      id,
    );
    return this.get(id);
  }

  /** Commit 回滚时清空正文路径（配合 ADR-0002 的 ROLLED_BACK） */
  clearCommittedBody(id: string): ChapterRow {
    this.db.run(
      "UPDATE chapters SET body_path = NULL, summary = NULL, status = 'DRAFT_READY', updated_at = ? WHERE id = ?",
      now(),
      id,
    );
    return this.get(id);
  }
}
