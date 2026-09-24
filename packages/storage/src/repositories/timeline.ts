/**
 * 时间线仓储（P0-5）。
 *
 * `timeline_events` 表在 `0001_init.sql:227` 就建好了（含
 * `idx_timeline_book_chapter` / `idx_timeline_story_time` 两个索引），
 * 但此前**全仓无任何代码使用它** —— 「建了表没接线」。
 *
 * ⚠ 本文件**不另建表、不加迁移**：表结构已比提示词建议的更好
 *   （`story_time_value` 可计算 + `narrative_order` 叙述序，
 *   把「故事时间」与「叙事顺序」分开），重建只会丢掉已有设计。
 */
import { AppError, ErrorCode } from '@nwa/core';
import type { Database } from '@nwa/storage';
import { now, requireRow } from '@nwa/storage';

export interface TimelineEventRow {
  readonly id: string;
  readonly book_id: string;
  readonly story_time_value: number | null;
  readonly story_time_unit: string | null;
  readonly story_time_display: string | null;
  readonly narrative_chapter: number | null;
  readonly narrative_offset: number | null;
  readonly title: string;
  readonly description: string;
  readonly importance: number | null;
  readonly data_json: string | null;
  readonly created_at: string;
}

export interface CreateTimelineEventInput {
  readonly id: string;
  readonly bookId: string;
  readonly title: string;
  readonly description: string;
  /** 故事世界内的时间（可计算，配合 unit） */
  readonly storyTimeValue?: number | null;
  readonly storyTimeUnit?: string | null;
  /** 自由文本时间补充（"第三天傍晚"）—— 不是主字段，用于展示与解析 */
  readonly storyTimeDisplay?: string | null;
  readonly narrativeChapter?: number | null;
  readonly narrativeOffset?: number | null;
  readonly importance?: number;
  /** 附加信息（quote / characters / location / narrativeMode / timeSource） */
  readonly data?: unknown;
}

export interface TimelineQuery {
  readonly bookId: string;
  /** 角色名（匹配 data_json.characters） */
  readonly character?: string;
  /** 地点（匹配 data_json.location） */
  readonly location?: string;
  readonly chapter?: number;
  /** 故事时间区间（**小时**，与 timeline-types.toHours 同一口径） */
  readonly fromHours?: number;
  readonly toHours?: number;
  readonly limit?: number;
}

export class TimelineRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateTimelineEventInput): TimelineEventRow {
    if (!input.title.trim()) {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '时间线事件的 title 不能为空');
    }
    if (!input.description.trim()) {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '时间线事件的 description 不能为空');
    }
    this.db.run(
      `INSERT INTO timeline_events
         (id, book_id, story_time_value, story_time_unit, story_time_display,
          narrative_chapter, narrative_offset, title, description, importance,
          data_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      input.id,
      input.bookId,
      input.storyTimeValue ?? null,
      input.storyTimeUnit ?? null,
      input.storyTimeDisplay ?? null,
      input.narrativeChapter ?? null,
      input.narrativeOffset ?? null,
      input.title,
      input.description,
      input.importance ?? 1,
      input.data === undefined ? null : JSON.stringify(input.data),
      now(),
    );
    return this.get(input.id);
  }

  get(id: string): TimelineEventRow {
    return requireRow(
      this.db.get<TimelineEventRow>('SELECT * FROM timeline_events WHERE id = ?', id),
      'timeline_event',
      id,
    );
  }

  find(id: string): TimelineEventRow | undefined {
    return this.db.get<TimelineEventRow>('SELECT * FROM timeline_events WHERE id = ?', id);
  }

  /**
   * 某本书的全部事件，按**叙述顺序**（读者看到的顺序）。
   *
   * ⚠ 排序带 `id` 兜底：同一章同一偏移的两条事件否则顺序不确定，
   *   会让"时间线检查"的结果在两次运行间变化。
   */
  listByBook(bookId: string, limit?: number): TimelineEventRow[] {
    return this.db.all<TimelineEventRow>(
      `SELECT * FROM timeline_events WHERE book_id = ?
         ORDER BY narrative_chapter, narrative_offset, id
         LIMIT ?`,
      bookId,
      limit ?? -1,
    );
  }

  listByChapter(bookId: string, chapter: number): TimelineEventRow[] {
    return this.db.all<TimelineEventRow>(
      `SELECT * FROM timeline_events WHERE book_id = ? AND narrative_chapter = ?
         ORDER BY narrative_offset, id`,
      bookId,
      chapter,
    );
  }

  /**
   * 通用查询。
   *
   * ⚠ 角色 / 地点存在 `data_json` 里，用 `json_extract` / `json_each` 过滤。
   *   代价：数据量大时这里会慢（无索引可用），届时应加生成列 + 索引。
   *   现在如实说明，不做提前优化 —— 提前优化会让 schema 复杂化，
   *   而"慢"目前还不是问题。
   */
  query(q: TimelineQuery): TimelineEventRow[] {
    const where: string[] = ['book_id = ?'];
    const params: unknown[] = [q.bookId];

    if (q.chapter !== undefined) {
      where.push('narrative_chapter = ?');
      params.push(q.chapter);
    }
    if (q.location !== undefined) {
      where.push("json_extract(data_json, '$.location') = ?");
      params.push(q.location);
    }
    if (q.character !== undefined) {
      // 角色是数组 → 用 json_each 展开匹配
      where.push(
        `EXISTS (SELECT 1 FROM json_each(json_extract(data_json, '$.characters')) je
                  WHERE je.value = ?)`,
      );
      params.push(q.character);
    }
    const rangeFilter = q.fromHours !== undefined || q.toHours !== undefined;
    if (rangeFilter) {
      // 粗筛：区间比较需要能算出小时数（有值 + 有单位）。
      // ⚠ 真正的换算在代码里做 —— 单位换算表是应用层口径，
      //   写进 SQL 会变成两套口径，而两套口径必然漂移。
      where.push('story_time_value IS NOT NULL AND story_time_unit IS NOT NULL');
    }

    const rows = this.db.all<TimelineEventRow>(
      `SELECT * FROM timeline_events WHERE ${where.join(' AND ')}
         ORDER BY narrative_chapter, narrative_offset, id
         LIMIT ?`,
      ...params,
      q.limit ?? -1,
    );

    if (!rangeFilter) return rows;
    return rows.filter((r) => {
      const hours = toComparableHours(r);
      if (hours === null) return false;
      if (q.fromHours !== undefined && hours < q.fromHours) return false;
      if (q.toHours !== undefined && hours > q.toHours) return false;
      return true;
    });
  }

  listByCharacter(bookId: string, character: string): TimelineEventRow[] {
    return this.query({ bookId, character });
  }

  listByLocation(bookId: string, location: string): TimelineEventRow[] {
    return this.query({ bookId, location });
  }

  listByStoryRange(bookId: string, fromHours: number, toHours: number): TimelineEventRow[] {
    return this.query({ bookId, fromHours, toHours });
  }

  count(bookId: string): number {
    const r = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM timeline_events WHERE book_id = ?',
      bookId,
    );
    return r?.n ?? 0;
  }

  delete(id: string): void {
    this.db.run('DELETE FROM timeline_events WHERE id = ?', id);
  }
}

/**
 * 取可比较的故事小时数（仓储侧口径）。
 *
 * ⚠ 必须与 `packages/story/src/timeline/timeline-types.ts` 的 `toHours`
 *   **完全一致**（同一张换算表）。这里单独写一份是因为仓储层不该依赖
 *   story 包的解析形态；两处口径的一致性由测试锁定 —— 不一致会让
 *   「按区间查」与「顺序检查」用不同的时间基准，报出互相矛盾的结论。
 */
export function toComparableHours(row: {
  story_time_value: number | null;
  story_time_unit: string | null;
}): number | null {
  const v = row.story_time_value;
  const u = row.story_time_unit;
  if (v === null || !Number.isFinite(v) || u === null) return null;
  const table: Readonly<Record<string, number>> = {
    minute: 1 / 60,
    hour: 1,
    day: 24,
    week: 168,
    month: 720,
    year: 8760,
  };
  const k = table[u.trim().toLowerCase()];
  return k === undefined ? null : v * k;
}
