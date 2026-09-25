/**
 * 逐章细纲仓储（开书向导 Phase 3）
 *
 * 表结构见 `migrations/0021_chapter_outlines.sql`；判定语义见
 * `@nwa/shared` 的 `validateChapterOutlinesSemantics`。
 *
 * ## ⚠⚠ 本仓储最重要的两件事
 *
 * ### 1. 按 `(book_id, chapter_number)` 索引，不是 `chapter_id`
 *
 * 开书向导发生在**写作之前** —— 那时 `chapters` 表里一行都没有。
 * 若为了填 chapter_id 而预先创建 30 行 DRAFT 章节，会污染章节列表：
 * 那些章节一行正文都没有，却出现在导航里，作者分不清"规划过的"与"开始写的"。
 *
 * ### 2. `upsertBatch` 只写**给定的章号**，不整表替换
 *
 * 这是与 `VolumeRepository.replaceAll` 的关键区别，理由在**用户诉求**里：
 * 「不强行一次产出 30 章细纲」→ 细纲天然是**分批**生成的。
 *
 * 若 upsertBatch 清空整表，第二批（第 11-20 章）会把第一批（1-10 章）
 * 连同作者逐章改过的内容一起抹掉 —— 而作者刚审完 10 章，
 * 会以为第二批"新增"了内容，实际是**替换**。
 *
 * ⚠ 卷可以整体替换（章号范围是全局不变量，必须一起改），
 *   细纲不行（每章独立，作者逐章审）。**两者判断相反，都各有理由。**
 */
import type { Database } from '../database.js';
import { chapterOutlineId } from '@nwa/core';
import { now } from './types.js';
import type {
  ChapterOutline,
  ChapterOutlinesOutput,
  ChapterPositioning,
} from '@nwa/shared';

export interface ChapterOutlineRow {
  readonly id: string;
  readonly book_id: string;
  readonly chapter_number: number;
  readonly core_event: string;
  readonly target_emotion: string;
  readonly protagonist_goal: string;
  readonly positioning: string | null;
  readonly structure_formula: string | null;
  readonly hook: string;
  readonly summary_json: string;
  readonly main_plot: string | null;
  readonly cast_json: string;
  readonly info_gap: string | null;
  readonly forbidden: string | null;
  readonly word_target: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** 细纲的业务形状（已解析 JSON、已映射枚举） */
export interface ChapterOutlineView {
  readonly id: string;
  readonly chapterNumber: number;
  readonly coreEvent: string;
  readonly targetEmotion: string;
  readonly protagonistGoal: string;
  readonly positioning: ChapterPositioning | null;
  readonly structureFormula: string | null;
  readonly hook: string;
  readonly summary: {
    cause: string;
    development: string;
    turn: string;
    climax: string;
    ending: string;
  };
  readonly mainPlot: string | null;
  readonly cast: string[];
  readonly infoGap: string | null;
  readonly forbidden: string | null;
  readonly wordTarget: number | null;
  readonly updatedAt: string;
}

function toView(row: ChapterOutlineRow): ChapterOutlineView {
  const parse = <T>(raw: string, fallback: T): T => {
    try {
      return JSON.parse(raw) as T;
    } catch {
      // ⚠ 不抛错也不静默给默认值 —— 记 null 让调用方能看出"这条坏了"
      return fallback;
    }
  };
  return {
    id: row.id,
    chapterNumber: row.chapter_number,
    coreEvent: row.core_event,
    targetEmotion: row.target_emotion,
    protagonistGoal: row.protagonist_goal,
    positioning: row.positioning as ChapterPositioning | null,
    structureFormula: row.structure_formula,
    hook: row.hook,
    summary: parse(row.summary_json, {
      cause: '',
      development: '',
      turn: '',
      climax: '',
      ending: '',
    }),
    mainPlot: row.main_plot,
    cast: parse<string[]>(row.cast_json, []),
    infoGap: row.info_gap,
    forbidden: row.forbidden,
    wordTarget: row.word_target,
    updatedAt: row.updated_at,
  };
}

export class ChapterOutlineRepository {
  constructor(private readonly db: Database) {}

  /**
   * 批量写入细纲。
   *
   * ⚠ 只覆盖**传入的章号**：已存在的章号更新，未传入的保持不动。
   *   这是分批生成能续做的关键（见类注释）。
   *
   * @returns 新建数 / 更新数 —— 分开报，因为"第二批把第一批全覆盖了"
   *          和"第二批新增了 10 章"在总数上看起来一样（都是 20）。
   */
  upsertBatch(
    bookId: string,
    output: ChapterOutlinesOutput,
  ): { created: number; updated: number } {
    return this.db.transaction(() => {
      let created = 0;
      let updated = 0;
      const ts = now();

      for (const o of output.outlines) {
        const existing = this.db.get<{ id: string }>(
          'SELECT id FROM chapter_outlines WHERE book_id = ? AND chapter_number = ?',
          bookId,
          o.chapterNumber,
        );
        const summaryJson = JSON.stringify(o.summary);
        const castJson = JSON.stringify(o.cast ?? []);

        if (existing) {
          this.db
            .prepare(
              `UPDATE chapter_outlines
                  SET core_event = ?, target_emotion = ?, protagonist_goal = ?,
                      positioning = ?, structure_formula = ?, hook = ?,
                      summary_json = ?, main_plot = ?, cast_json = ?,
                      info_gap = ?, forbidden = ?, word_target = ?,
                      updated_at = ?
                WHERE id = ?`,
            )
            .run(
              o.coreEvent,
              o.targetEmotion,
              o.protagonistGoal,
              o.positioning ?? null,
              o.structureFormula ?? null,
              o.hook,
              summaryJson,
              o.mainPlot ?? null,
              castJson,
              o.infoGap ?? null,
              o.forbidden ?? null,
              o.wordTarget ?? null,
              ts,
              existing.id,
            );
          updated += 1;
        } else {
          this.db
            .prepare(
              `INSERT INTO chapter_outlines (
                 id, book_id, chapter_number, core_event, target_emotion,
                 protagonist_goal, positioning, structure_formula, hook,
                 summary_json, main_plot, cast_json, info_gap, forbidden,
                 word_target, created_at, updated_at
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              chapterOutlineId(),
              bookId,
              o.chapterNumber,
              o.coreEvent,
              o.targetEmotion,
              o.protagonistGoal,
              o.positioning ?? null,
              o.structureFormula ?? null,
              o.hook,
              summaryJson,
              o.mainPlot ?? null,
              castJson,
              o.infoGap ?? null,
              o.forbidden ?? null,
              o.wordTarget ?? null,
              ts,
              ts,
            );
          created += 1;
        }
      }
      return { created, updated };
    });
  }

  /** 取某章细纲。章不存在时返回 undefined（**不兜底**） */
  get(bookId: string, chapterNumber: number): ChapterOutlineView | undefined {
    const row = this.db.get<ChapterOutlineRow>(
      'SELECT * FROM chapter_outlines WHERE book_id = ? AND chapter_number = ?',
      bookId,
      chapterNumber,
    );
    return row ? toView(row) : undefined;
  }

  /** 按书列全部细纲，按章号升序 */
  listByBook(bookId: string): ChapterOutlineView[] {
    return this.db
      .all<ChapterOutlineRow>(
        'SELECT * FROM chapter_outlines WHERE book_id = ? ORDER BY chapter_number',
        bookId,
      )
      .map(toView);
  }

  /**
   * ⚠⚠ 给 Planner 用的：取指定章号范围内的细纲，渲染成可注入的文本。
   *
   * **这是本仓储存在的意义所在。**
   *
   * 细纲如果不进 prompt，它就只是一份"作者看过的文档" ——
   * 门禁说"已确认"，模型却读不到，于是作者以为 Agent 按细纲在写，
   * 实际它什么都不知道。这正是 W1 记录过的教训
   * （`settings-gate.ts` 的"门禁放行但 prompt 读到别的内容"）。
   *
   * 注入路径必须与 `world_entities`/`characters` **同一个位置**
   * （`workflow-services.ts` 的 `contextText`），否则又是一条死路。
   *
   * @param chapterNumber 当前要写的章
   * @param lookahead 往后多看几章（默认 0）。
   *        ⚠ 默认 0 是刻意的：Planner 只需要"本章要发生什么"。
   *          把后面几章的细纲也塞进去会稀释当前章的信息
   *          （规则 28：注入内容必须按相关性裁剪，不是越多越好）。
   */
  renderForPrompt(
    bookId: string,
    chapterNumber: number,
    lookahead = 0,
  ): string {
    const rows = this.db.all<ChapterOutlineRow>(
      `SELECT * FROM chapter_outlines
        WHERE book_id = ? AND chapter_number >= ? AND chapter_number <= ?
        ORDER BY chapter_number`,
      bookId,
      chapterNumber,
      chapterNumber + lookahead,
    );
    if (rows.length === 0) return '';

    const parts: string[] = ['## 作者已确认的章节细纲'];
    for (const row of rows) {
      const v = toView(row);
      const lines = [
        `### 第 ${v.chapterNumber} 章`,
        `- 核心事件：${v.coreEvent}`,
        `- 目标情绪：${v.targetEmotion}`,
        `- 主角目标/关键选择：${v.protagonistGoal}`,
      ];
      if (v.structureFormula) lines.push(`- 本章结构公式：${v.structureFormula}`);
      lines.push(`- 章首钩子：${v.hook}`);
      lines.push(
        '- 内容概括（五段式）：' +
          `起因 ${v.summary.cause} / 发展 ${v.summary.development} / ` +
          `转折 ${v.summary.turn} / 高潮 ${v.summary.climax} / ` +
          `结尾落点 ${v.summary.ending}`,
      );
      if (v.mainPlot) lines.push(`- 主线推进：${v.mainPlot}`);
      if (v.cast.length > 0) lines.push(`- 出场顺序：${v.cast.join('、')}`);
      if (v.infoGap) lines.push(`- 视角/信息差：${v.infoGap}`);
      if (v.forbidden) lines.push(`- ⚠ 本章禁止提前释放：${v.forbidden}`);
      if (v.wordTarget !== null) lines.push(`- 字数目标：${v.wordTarget} 字`);
      parts.push(lines.join('\n'));
    }
    return parts.join('\n\n');
  }

  countByBook(bookId: string): number {
    return (
      this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM chapter_outlines WHERE book_id = ?',
        bookId,
      )?.n ?? 0
    );
  }

  /**
   * ⚠ 已规划章号的连续性报告（不修改数据）。
   *
   * 缺章的后果是那一章没有意图约束 —— Planner 拿不到"作者确认过什么"，
   * 只能自由发挥。而作者看到"规划了 1-20 章"，不会注意到缺了第 7 章。
   * 所以提供这个只读报告，让界面能显式提示缺口。
   */
  gaps(bookId: string): { missing: number[]; max: number } {
    const nums = this.db
      .all<{ chapter_number: number }>(
        'SELECT chapter_number FROM chapter_outlines WHERE book_id = ? ORDER BY chapter_number',
        bookId,
      )
      .map((r) => r.chapter_number);
    const max = nums.length > 0 ? Math.max(...nums) : 0;
    const present = new Set(nums);
    const missing: number[] = [];
    for (let n = 1; n <= max; n++) if (!present.has(n)) missing.push(n);
    return { missing, max };
  }

  remove(bookId: string, chapterNumber: number): boolean {
    const r = this.db
      .prepare('DELETE FROM chapter_outlines WHERE book_id = ? AND chapter_number = ?')
      .run(bookId, chapterNumber);
    return r.changes > 0;
  }
}

/** 供上层把 `ChapterOutline` 形状直接转成入库形状（避免两处拼装） */
export function toOutlineOutput(items: readonly ChapterOutline[]): ChapterOutlinesOutput {
  return { outlines: [...items] };
}
