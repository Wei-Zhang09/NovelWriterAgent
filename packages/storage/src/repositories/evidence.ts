/**
 * evidence 仓储（施工计划 §3.1c / 研究报告 R4）
 *
 * ⚠ 核心职责：**写入时校验 quote 能在原文中精确匹配**。
 *
 *   研究报告的教训：webnovel-writer 的 evidence 是字符串标签列表
 *   （`f"state_change:{entity}:{field}:{chapter}"`），
 *   **无法回答「这条事实对应原文哪一句话」** —— 靠审查员用 grep 找证据，
 *   而不是靠数据结构保证证据存在。
 *
 *   因此本仓储的 create() 必须接收 sourceText，并在写入前做区间校验。
 */
import type { Database } from '../database.js';
import { AppError, ErrorCode } from '@nwa/core';
import { now, requireRow } from './types.js';

export interface EvidenceRow {
  readonly id: string;
  readonly book_id: string;
  readonly source_type: string;
  readonly source_ref: string;
  readonly quote: string;
  readonly start_offset: number;
  readonly end_offset: number;
  readonly note: string | null;
  readonly created_at: string;
}

export interface CreateEvidenceInput {
  readonly id: string;
  readonly bookId: string;
  readonly sourceType: string;
  readonly sourceRef: string;
  readonly quote: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly note?: string | null;
  /**
   * 原文（用于校验 quote 与区间一致）。
   * 必传 —— 允许省略会让「证据可回溯」退化成一句口号。
   */
  readonly sourceText: string;
}

export class EvidenceRepository {
  constructor(private readonly db: Database) {}

  /**
   * 写入证据，并强制校验。
   *
   * 校验三件事：
   *   1. 区间合法（end > start，且在原文长度内）
   *   2. quote 非空
   *   3. sourceText[startOffset, endOffset) 必须**等于** quote
   *
   * 任一失败抛 EVIDENCE_QUOTE_MISMATCH —— 该 fact 不得成为 CANON。
   */
  create(input: CreateEvidenceInput): EvidenceRow {
    const { sourceText, startOffset, endOffset, quote } = input;

    if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) {
      throw new AppError(ErrorCode.EVIDENCE_QUOTE_MISMATCH, '偏移量必须是整数', {
        details: { startOffset, endOffset },
      });
    }
    if (startOffset < 0 || endOffset > sourceText.length || endOffset <= startOffset) {
      throw new AppError(
        ErrorCode.EVIDENCE_QUOTE_MISMATCH,
        `证据区间非法：[${startOffset}, ${endOffset})，原文长度 ${sourceText.length}`,
        { details: { startOffset, endOffset, sourceLength: sourceText.length } },
      );
    }
    if (quote.length === 0) {
      throw new AppError(ErrorCode.EVIDENCE_QUOTE_MISMATCH, '证据 quote 不得为空');
    }

    const actual = sourceText.slice(startOffset, endOffset);
    if (actual !== quote) {
      throw new AppError(
        ErrorCode.EVIDENCE_QUOTE_MISMATCH,
        '证据 quote 与原文区间不一致，拒绝写入',
        {
          details: {
            expected: quote.slice(0, 80),
            actual: actual.slice(0, 80),
            startOffset,
            endOffset,
          },
        },
      );
    }

    this.db.run(
      `INSERT INTO evidence
         (id, book_id, source_type, source_ref, quote, start_offset, end_offset, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.bookId,
      input.sourceType,
      input.sourceRef,
      quote,
      startOffset,
      endOffset,
      input.note ?? null,
      now(),
    );
    return this.get(input.id);
  }

  get(id: string): EvidenceRow {
    return requireRow(this.db.get<EvidenceRow>('SELECT * FROM evidence WHERE id = ?', id), 'evidence', id);
  }

  find(id: string): EvidenceRow | undefined {
    return this.db.get<EvidenceRow>('SELECT * FROM evidence WHERE id = ?', id);
  }

  listBySource(sourceType: string, sourceRef: string): EvidenceRow[] {
    return this.db.all<EvidenceRow>(
      'SELECT * FROM evidence WHERE source_type = ? AND source_ref = ? ORDER BY start_offset',
      sourceType,
      sourceRef,
    );
  }

  /**
   * 重新校验既有证据（数据完整性巡检用）。
   * 返回所有已失效的证据 —— 用于发现「正文被外部改动导致证据失锚」。
   */
  verifyAll(bookId: string, resolveSource: (sourceRef: string) => string | undefined): {
    id: string;
    reason: string;
  }[] {
    const broken: { id: string; reason: string }[] = [];
    for (const e of this.db.all<EvidenceRow>('SELECT * FROM evidence WHERE book_id = ?', bookId)) {
      const text = resolveSource(e.source_ref);
      if (text === undefined) {
        broken.push({ id: e.id, reason: `源文件缺失：${e.source_ref}` });
        continue;
      }
      if (text.slice(e.start_offset, e.end_offset) !== e.quote) {
        broken.push({ id: e.id, reason: '区间内容与 quote 不一致（源文可能被修改）' });
      }
    }
    return broken;
  }
}
