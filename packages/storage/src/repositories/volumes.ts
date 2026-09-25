/**
 * 卷级大纲仓储（开书向导 Phase 3）
 *
 * 表结构见 `migrations/0020_volumes.sql`；判定语义见
 * `@nwa/shared` 的 `validateOutlineSemantics`。
 *
 * ## ⚠ 本仓储的核心约束：卷只能**整体替换**，不能逐卷合并
 *
 * 角色可以逐条合并（W3 的 keep_existing / use_new / keep_both）——
 * 每个角色是独立的。卷**不是**：
 *
 *   `chapter_start` / `chapter_end` 必须**从 1 开始、首尾相接、不重叠**。
 *   这是全局不变量。逐卷合并会让它失去意义：
 *     保留旧的第 2 卷（第 31-60 章）+ 用新的第 3 卷（第 55-90 章）
 *     → 范围重叠，而每一卷单独看都合法。
 *
 *   所以 `replaceAll()` 是唯一的写入方式，且要求调用方**显式声明**
 *   会覆盖已有卷 —— 不静默覆盖（作者可能逐卷改过）。
 *
 * ## 为什么写入前要重算 ord
 *
 * 调用方给的顺序不可信（模型输出的顺序、界面拖拽后的顺序都可能乱）。
 * `ord` 由 `chapterStart` 排序后重算 —— 与 `validateOutlineSemantics`
 * 同一口径（先排序再检查），保证库里存的就是校验过的那份顺序。
 */
import { AppError, ErrorCode, volumeId } from '@nwa/core';
import type { OutlineOutput, VolumeProposal } from '@nwa/shared';
import type { Database } from '../database.js';
import { now, type Timestamped } from './types.js';

export interface VolumeRow extends Timestamped {
  readonly id: string;
  readonly book_id: string;
  readonly ord: number;
  readonly name: string;
  readonly function: string;
  readonly stage: string;
  readonly contract: string | null;
  readonly core_event: string;
  readonly start_state: string | null;
  readonly end_state: string | null;
  readonly chapter_start: number;
  readonly chapter_end: number;
  readonly word_target: number | null;
}

export class VolumeRepository {
  constructor(private readonly db: Database) {}

  /** 取某本书的全部卷，按章号顺序 */
  listByBook(bookId: string): VolumeRow[] {
    return this.db.all<VolumeRow>(
      'SELECT * FROM volumes WHERE book_id = ? ORDER BY ord',
      bookId,
    );
  }

  countByBook(bookId: string): number {
    const r = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM volumes WHERE book_id = ?',
      bookId,
    );
    return r?.n ?? 0;
  }

  /**
   * 查某一章属于哪一卷。
   *
   * ⚠ 这是 W5（细纲）与 Planner 的主要查询入口 ——
   *   用绝对坐标的 BETWEEN，而不是累加前几卷的章数。
   *   累加逻辑写错一处就会静默错位（"第 40 章被算进第 2 卷"），
   *   而 BETWEEN 不可能算错。
   *
   * 返回 undefined 表示这一章**不属于任何卷** —— 调用方必须处理，
   * 不能当成"第一卷"（那会让越界的章悄悄获得卷级约束）。
   */
  volumeOfChapter(bookId: string, chapterNumber: number): VolumeRow | undefined {
    return this.db.get<VolumeRow>(
      `SELECT * FROM volumes
        WHERE book_id = ? AND chapter_start <= ? AND chapter_end >= ?
        ORDER BY ord LIMIT 1`,
      bookId,
      chapterNumber,
      chapterNumber,
    );
  }

  /**
   * 整体替换一本书的卷纲。
   *
   * ⚠ 必须显式传 `replaceExisting: true` 才会覆盖已有的卷。
   *   作者可能逐卷改过 —— 静默覆盖会丢掉那些修改，
   *   而且作者不会收到任何提示（他以为只是"重新生成"）。
   */
  replaceAll(
    bookId: string,
    output: OutlineOutput,
    opts: { readonly replaceExisting: boolean },
  ): { replaced: number; created: number } {
    const existing = this.countByBook(bookId);
    if (existing > 0 && !opts.replaceExisting) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `本书已有 ${existing} 卷大纲。整体替换会覆盖作者已有的修改，` +
          '请显式确认后再执行（replaceExisting: true）。',
      );
    }

    // ⚠ 先排序再写：调用方给的顺序不可信（模型输出/界面拖拽都可能乱）
    const sorted = [...output.volumes].sort((a, b) => a.chapterStart - b.chapterStart);

    const ts = now();
    // 事务：中途失败不能留下"删了旧的、新的写一半"的状态
    this.db.transaction(() => {
      this.db.run('DELETE FROM volumes WHERE book_id = ?', bookId);
      sorted.forEach((v, i) => this.insert(bookId, v, i + 1, ts));
    });

    return { replaced: existing, created: sorted.length };
  }

  private insert(bookId: string, v: VolumeProposal, ord: number, ts: string): void {
    this.db.run(
      `INSERT INTO volumes
         (id, book_id, ord, name, function, stage, contract, core_event,
          start_state, end_state, chapter_start, chapter_end, word_target,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      volumeId(),
      bookId,
      ord,
      v.name,
      v.function,
      v.stage,
      v.contract ?? null,
      v.coreEvent,
      v.startState ?? null,
      v.endState ?? null,
      v.chapterStart,
      v.chapterEnd,
      v.wordTarget ?? null,
      ts,
      ts,
    );
  }

  /**
   * 更新单卷的**内容字段**（作者逐卷修改）。
   *
   * ⚠ 刻意**不允许**改 chapter_start / chapter_end：
   *   改范围会破坏"首尾相接"的全局不变量，而单卷更新无法检查它
   *   （它需要看到全部卷）。要改范围请走 `replaceAll` 整体重排。
   *   这是"让非法状态不可表达"的落地 —— 比"允许改然后校验"可靠。
   */
  update(
    id: string,
    patch: {
      name?: string;
      function?: string;
      stage?: string;
      contract?: string | null;
      coreEvent?: string;
      startState?: string | null;
      endState?: string | null;
      wordTarget?: number | null;
    },
  ): VolumeRow {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    const push = (col: string, val: string | number | null | undefined): void => {
      if (val !== undefined) {
        sets.push(`${col} = ?`);
        args.push(val);
      }
    };
    push('name', patch.name);
    push('function', patch.function);
    push('stage', patch.stage);
    push('contract', patch.contract);
    push('core_event', patch.coreEvent);
    push('start_state', patch.startState);
    push('end_state', patch.endState);
    push('word_target', patch.wordTarget);

    if (sets.length === 0) {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '没有要更新的字段');
    }
    sets.push('updated_at = ?');
    args.push(now());

    this.db.run(`UPDATE volumes SET ${sets.join(', ')} WHERE id = ?`, ...args, id);
    return this.get(id);
  }

  get(id: string): VolumeRow {
    const row = this.db.get<VolumeRow>('SELECT * FROM volumes WHERE id = ?', id);
    if (!row) {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, `卷不存在：${id}`);
    }
    return row;
  }

  removeAll(bookId: string): void {
    this.db.run('DELETE FROM volumes WHERE book_id = ?', bookId);
  }
}
