/**
 * 伏笔仓储（施工文档 §14，表见 0001_init.sql:265）
 *
 * ## 六态机（研究报告 §2.2 差异 2）
 *
 *   PLANNED → PLANTED → DEVELOPING → READY → PAID_OFF
 *                                        ↘ ABANDONED
 *
 * 参考项目的伏笔全代际只有 2-3 个状态且没有推进规则 —— 结果是
 * "埋了没管"和"重复回收"都查不出来。六态 + 显式推进规则让状态可追溯。
 *
 * ⚠ 状态推进只能沿合法路径，不能跳级或倒退（除 ABANDONED）。
 *   本仓储在 `advance()` 里强制校验，非法推进直接抛错 ——
 *   而不是静默改成目标态（那会让伏笔账目失真）。
 */
import { AppError, ErrorCode, type Nullable } from '@nwa/core';
import type { Database } from '../database.js';
import { now } from './types.js';

export const FORESHADOW_STATUSES = [
  'PLANNED',
  'PLANTED',
  'DEVELOPING',
  'READY',
  'PAID_OFF',
  'ABANDONED',
] as const;
export type ForeshadowStatus = (typeof FORESHADOW_STATUSES)[number];

export const FORESHADOW_TIERS = ['CORE', 'SIDE', 'DECOR'] as const;
export type ForeshadowTier = (typeof FORESHADOW_TIERS)[number];

export interface ForeshadowingRow {
  readonly id: string;
  readonly book_id: string;
  readonly name: string;
  readonly setup_chapter: number | null;
  readonly expected_payoff_chapter: number | null;
  readonly status: string;
  readonly tier: string;
  readonly importance: number | null;
  readonly description: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  /** 实际回收章（PAID_OFF 后写入） */
  readonly payoff_chapter?: number | null;
  /** 证据 id 的 JSON 数组（回答「这条伏笔来自正文哪一句」） */
  readonly evidence_ids_json?: string | null;
}

/**
 * 合法推进路径。
 *
 * ⚠ 这是"状态不可失真"的保证：伏笔是长篇的账目，
 *   账目可以推进但不能凭空跳级（否则查不出"该埋没埋"）。
 */
const LEGAL_TRANSITIONS: Readonly<Record<ForeshadowStatus, readonly ForeshadowStatus[]>> = {
  PLANNED: ['PLANTED', 'ABANDONED'],
  PLANTED: ['DEVELOPING', 'READY', 'ABANDONED'],
  DEVELOPING: ['READY', 'PAID_OFF', 'ABANDONED'],
  READY: ['PAID_OFF', 'ABANDONED'],
  // 终态：不可再变
  PAID_OFF: [],
  ABANDONED: [],
};

export class ForeshadowingRepository {
  constructor(private readonly db: Database) {}

  create(input: {
    id: string;
    bookId: string;
    name: string;
    tier?: ForeshadowTier;
    importance?: number;
    description?: string;
    setupChapter?: number;
    expectedPayoffChapter?: number;
    /** 证据 id（回答「这条伏笔来自正文哪一句」） */
    evidenceIds?: readonly string[];
  }): ForeshadowingRow {
    this.db.run(
      `INSERT INTO foreshadowing
         (id, book_id, name, setup_chapter, expected_payoff_chapter,
          status, tier, importance, description, evidence_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.bookId,
      input.name,
      input.setupChapter ?? null,
      input.expectedPayoffChapter ?? null,
      'PLANNED',
      input.tier ?? 'SIDE',
      input.importance ?? 1,
      input.description ?? null,
      input.evidenceIds && input.evidenceIds.length > 0
        ? JSON.stringify(input.evidenceIds)
        : null,
      now(),
      now(),
    );
    return this.get(input.id);
  }

  get(id: string): ForeshadowingRow {
    const row = this.find(id);
    if (!row) {
      throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, `伏笔不存在：${id}`, {
        details: { entity: 'foreshadowing', id },
      });
    }
    return row;
  }

  find(id: string): Nullable<ForeshadowingRow> {
    return this.db.get<ForeshadowingRow>('SELECT * FROM foreshadowing WHERE id = ?', id) ?? null;
  }

  findByName(bookId: string, name: string): Nullable<ForeshadowingRow> {
    return (
      this.db.get<ForeshadowingRow>(
        'SELECT * FROM foreshadowing WHERE book_id = ? AND name = ?',
        bookId,
        name,
      ) ?? null
    );
  }

  listByBook(bookId: string): ForeshadowingRow[] {
    return this.db.all<ForeshadowingRow>(
      'SELECT * FROM foreshadowing WHERE book_id = ? ORDER BY importance DESC, name',
      bookId,
    );
  }

  listByStatus(bookId: string, status: ForeshadowStatus): ForeshadowingRow[] {
    return this.db.all<ForeshadowingRow>(
      'SELECT * FROM foreshadowing WHERE book_id = ? AND status = ? ORDER BY name',
      bookId,
      status,
    );
  }

  /**
   * 推进伏笔状态。
   *
   * ⚠ 非法推进抛错而不是静默接受 —— 静默接受会让伏笔账目失真，
   *   而伏笔账目是长篇里最难事后修复的数据之一。
   */
  /**
   * 追加证据 id（不覆盖已有的）。
   *
   * 用途：伏笔在后续章节被推进/回收时，把当次的引文证据也挂上 ——
   * 一条伏笔的来龙去脉因此可回溯，而不是只有首次埋设的那一句。
   */
  appendEvidence(id: string, evidenceIds: readonly string[]): void {
    if (evidenceIds.length === 0) return;
    const row = this.get(id);
    let existing: string[] = [];
    try {
      const v = JSON.parse(row.evidence_ids_json ?? '[]') as unknown;
      if (Array.isArray(v)) existing = v.filter((x): x is string => typeof x === 'string');
    } catch {
      /* 解析失败当作空 */
    }
    const merged = [...new Set([...existing, ...evidenceIds])];
    this.db.run(
      'UPDATE foreshadowing SET evidence_ids_json = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(merged),
      now(),
      id,
    );
  }

  advance(id: string, to: ForeshadowStatus, opts?: { chapter?: number }): ForeshadowingRow {
    const row = this.get(id);
    const from = row.status as ForeshadowStatus;

    if (from === to) {
      throw new AppError(ErrorCode.COMMIT_FAILED, `伏笔「${row.name}」已处于 ${to} 状态`, {
        details: { from, to },
      });
    }

    const allowed = LEGAL_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new AppError(
        ErrorCode.COMMIT_FAILED,
        `伏笔「${row.name}」不允许从 ${from} 推进到 ${to}` +
          (allowed.length === 0 ? '（已是终态）' : `；合法目标：${allowed.join(' / ')}`),
        { details: { from, to, allowed } },
      );
    }

    // 回收时必须记下回收章 —— 否则事后无法回答"第几章收的"
    if (to === 'PAID_OFF' && opts?.chapter === undefined) {
      throw new AppError(ErrorCode.COMMIT_FAILED, `推进到 PAID_OFF 必须提供回收章号`);
    }

    if (to === 'PAID_OFF') {
      this.db.run(
        'UPDATE foreshadowing SET status = ?, payoff_chapter = ?, updated_at = ? WHERE id = ?',
        to,
        opts!.chapter!,
        now(),
        id,
      );
    } else {
      this.db.run('UPDATE foreshadowing SET status = ?, updated_at = ? WHERE id = ?', to, now(), id);
    }
    return this.get(id);
  }

  /** 登记埋设章（PLANTED 时用） */
  setSetupChapter(id: string, chapter: number): ForeshadowingRow {
    this.db.run(
      'UPDATE foreshadowing SET setup_chapter = ?, updated_at = ? WHERE id = ?',
      chapter,
      now(),
      id,
    );
    return this.get(id);
  }
}
