/**
 * projects / books 仓储
 *
 * 施工文档 §10.1 / §10.2
 */
import type { Database } from '../database.js';
import { AppError, ErrorCode } from '@nwa/core';
import { now, requireRow, type Timestamped } from './types.js';

export interface ProjectRow extends Timestamped {
  readonly id: string;
  readonly name: string;
  readonly genre: string | null;
  readonly premise: string | null;
  readonly status: string;
}

export interface BookRow extends Timestamped {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly current_chapter: number;
  /** 每章字数目标；`null` = 未设定（回落到 DEFAULT_TARGET_WORDS_PER_CHAPTER） */
  readonly target_words_per_chapter: number | null;
  /** 偏离容忍度百分比（默认 40） */
  readonly word_count_tolerance_pct: number;
}

export interface CreateProjectInput {
  readonly id: string;
  readonly name: string;
  readonly genre?: string | null;
  readonly premise?: string | null;
  readonly status?: string;
}

export class ProjectRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateProjectInput): ProjectRow {
    const ts = now();
    this.db.run(
      `INSERT INTO projects (id, name, genre, premise, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.name,
      input.genre ?? null,
      input.premise ?? null,
      input.status ?? 'ACTIVE',
      ts,
      ts,
    );
    return this.get(input.id);
  }

  get(id: string): ProjectRow {
    return requireRow(
      this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id),
      'project',
      id,
    );
  }

  find(id: string): ProjectRow | undefined {
    return this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id);
  }

  list(): ProjectRow[] {
    return this.db.all<ProjectRow>('SELECT * FROM projects ORDER BY created_at DESC');
  }

  update(id: string, patch: Partial<Pick<ProjectRow, 'name' | 'genre' | 'premise' | 'status'>>): ProjectRow {
    const current = this.get(id);
    this.db.run(
      `UPDATE projects SET name = ?, genre = ?, premise = ?, status = ?, updated_at = ? WHERE id = ?`,
      patch.name ?? current.name,
      patch.genre === undefined ? current.genre : patch.genre,
      patch.premise === undefined ? current.premise : patch.premise,
      patch.status ?? current.status,
      now(),
      id,
    );
    return this.get(id);
  }

  /** 删除项目：子表由外键 ON DELETE CASCADE 连带清理（依赖 PRAGMA foreign_keys 生效） */
  delete(id: string): number {
    return this.db.run('DELETE FROM projects WHERE id = ?', id).changes;
  }
}

export class BookRepository {
  constructor(private readonly db: Database) {}

  create(input: { id: string; projectId: string; title: string }): BookRow {
    const ts = now();
    this.db.run(
      `INSERT INTO books (id, project_id, title, current_chapter, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
      input.id,
      input.projectId,
      input.title,
      ts,
      ts,
    );
    return this.get(input.id);
  }

  get(id: string): BookRow {
    return requireRow(this.db.get<BookRow>('SELECT * FROM books WHERE id = ?', id), 'book', id);
  }

  listByProject(projectId: string): BookRow[] {
    return this.db.all<BookRow>(
      'SELECT * FROM books WHERE project_id = ? ORDER BY created_at',
      projectId,
    );
  }

  /**
   * 推进当前章节号。
   *
   * 约束：只允许**单调递增**（研究报告 §1.2 决策 3：进度只信物理产物，
   * 不接受模型输出的任意数值回退）。
   */
  advanceTo(bookId: string, chapterNumber: number): BookRow {
    const book = this.get(bookId);
    if (chapterNumber <= book.current_chapter) {
      return book;
    }
    this.db.run(
      'UPDATE books SET current_chapter = ?, updated_at = ? WHERE id = ?',
      chapterNumber,
      now(),
      bookId,
    );
    return this.get(bookId);
  }

  // ── 每章字数目标（P2-1，软约束）──────────────────────────

  /**
   * 设定每章字数目标。
   *
   * ⚠ 这是**软约束**：只影响 Writer 的提示与审稿提示，永不阻断提交。
   *   字数是结果指标不是正确性指标，硬卡只会让模型为凑数注水
   *   （ADR-0007 Naturalness 明确防的就是这个）。
   *
   * @param targetWords 目标字数；`null` = 清除设定（回落到 Writer 默认值）
   * @param tolerancePct 偏离容忍度百分比（默认沿用库中现值）
   */
  setWordTarget(
    bookId: string,
    targetWords: number | null,
    tolerancePct?: number,
  ): BookRow {
    if (targetWords !== null && (!Number.isInteger(targetWords) || targetWords <= 0)) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `每章目标字数必须是正整数（收到 ${String(targetWords)}）—— 清空设定请传 null`,
      );
    }
    if (
      tolerancePct !== undefined &&
      (!Number.isInteger(tolerancePct) || tolerancePct < 0 || tolerancePct > 200)
    ) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `偏离容忍度必须在 0~200 之间（收到 ${String(tolerancePct)}）`,
      );
    }
    this.db.run(
      `UPDATE books
          SET target_words_per_chapter = ?,
              word_count_tolerance_pct = COALESCE(?, word_count_tolerance_pct),
              updated_at = ?
        WHERE id = ?`,
      targetWords,
      tolerancePct ?? null,
      now(),
      bookId,
    );
    return this.get(bookId);
  }
}
