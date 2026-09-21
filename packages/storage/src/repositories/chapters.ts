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
  /** 审阅结果 JSON（§32 ReviewOutput）；迁移 0004 引入 */
  readonly review_json?: string | null;
  /** 审阅推导状态 PASSED / NEEDS_REVISION / BLOCKED；NULL 表示未审阅 */
  readonly review_status?: string | null;
  /** 摘要是否经作者确认（ADR-0006 约束 C）；0 表示待确认 */
  readonly summary_approved?: number | null;
  readonly summary_approved_at?: string | null;
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
   * 保存审阅结果（§32）。
   *
   * ⚠ `status` 由调用方（review.run 工具）用 deriveStatus() 机械推导后传入，
   *   **不是**模型填的 overallStatus —— 见 STEP 8 的设计说明。
   *   冗余存到 review_status 列，便于状态机门禁在不解析 JSON 的情况下判断。
   */
  saveReview(id: string, review: unknown, status: string): ChapterRow {
    this.db.run(
      'UPDATE chapters SET review_json = ?, review_status = ?, updated_at = ? WHERE id = ?',
      serializeJsonColumn(review),
      status,
      now(),
      id,
    );
    return this.get(id);
  }

  readReview<T>(id: string): T | null {
    const row = this.get(id);
    return parseJsonColumn<T>(row.review_json ?? null, 'review_json', id);
  }

  /**
   * 是否有阻塞级审阅问题。
   *
   * 状态机门禁用它判断"能否进入 Commit"（§33：只有 BLOCKING = 0 才允许）。
   * ⚠ 未审阅（review_status 为 NULL）视为**不可提交** —— 宁严不宽：
   *   没审过就提交等于跳过质量关口。
   */
  hasBlockingReview(id: string): boolean {
    const row = this.get(id);
    if (row.review_status === null || row.review_status === undefined) return true; // 未审阅 → 阻塞
    return row.review_status === 'BLOCKED';
  }

  // ── 摘要人工确认（ADR-0006 约束 C） ──────────────────────

  /**
   * 作者确认摘要（可同时修改内容）。
   *
   * ⚠ 只有确认后的摘要才进 FTS 与后续 Context —— 见 listApprovedSummaries。
   *   "摘要是长程记忆的源头，错一条污染后面几百章"。
   */
  approveSummary(id: string, edited?: string): ChapterRow {
    const chapter = this.get(id);
    if (chapter.summary === null) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `第 ${chapter.chapter_number} 章还没有摘要，无法确认`,
      );
    }
    const ts = now();
    if (edited !== undefined && edited !== chapter.summary) {
      // 作者改过内容 → 更新并记录确认时间
      this.db.run(
        'UPDATE chapters SET summary = ?, summary_approved = 1, summary_approved_at = ?, updated_at = ? WHERE id = ?',
        edited,
        ts,
        ts,
        id,
      );
    } else {
      this.db.run(
        'UPDATE chapters SET summary_approved = 1, summary_approved_at = ?, updated_at = ? WHERE id = ?',
        ts,
        ts,
        id,
      );
    }
    return this.get(id);
  }

  /** 撤回确认（作者发现摘要有问题时） */
  revokeSummaryApproval(id: string): ChapterRow {
    this.db.run(
      'UPDATE chapters SET summary_approved = 0, summary_approved_at = NULL, updated_at = ? WHERE id = ?',
      now(),
      id,
    );
    return this.get(id);
  }

  /**
   * 已确认摘要的章节（**唯一**允许进入 FTS / Context 的摘要来源）。
   *
   * ⚠ 刻意只返回 approved=1 的：未确认摘要不进记忆链路。
   */
  listApprovedSummaries(bookId: string): ChapterRow[] {
    return this.db.all<ChapterRow>(
      `SELECT * FROM chapters
        WHERE book_id = ? AND status = 'COMMITTED'
          AND summary IS NOT NULL AND summary_approved = 1
        ORDER BY chapter_number`,
      bookId,
    );
  }

  /** 待确认摘要的章节（UI 展示用；可见才不会静默丢失） */
  listPendingSummaries(bookId: string): ChapterRow[] {
    return this.db.all<ChapterRow>(
      `SELECT * FROM chapters
        WHERE book_id = ? AND status = 'COMMITTED'
          AND summary IS NOT NULL AND summary_approved = 0
        ORDER BY chapter_number`,
      bookId,
    );
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
