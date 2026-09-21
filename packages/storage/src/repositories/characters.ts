/**
 * characters / character_states 仓储（施工文档 §10.4 / §10.5）
 *
 * 关键语义：character_states 是**按章快照**，读取「当前状态」= 取最大章节号那一条。
 * 不维护可变的 current_state 字段 —— 那会在 Commit 回滚时留下不一致。
 */
import type { Database } from '../database.js';
import { now, parseJsonColumn, requireRow, serializeJsonColumn, type Timestamped } from './types.js';

export interface CharacterRow extends Timestamped {
  readonly id: string;
  readonly book_id: string;
  readonly name: string;
  readonly aliases_json: string | null;
  readonly role: string | null;
  readonly current_status: string | null;
  readonly profile_json: string | null;
}

export interface CharacterStateRow {
  readonly id: string;
  readonly character_id: string;
  readonly chapter_number: number;
  readonly state_json: string;
  readonly source_fact_ids_json: string | null;
  readonly created_at: string;
}

export class CharacterRepository {
  constructor(private readonly db: Database) {}

  create(input: {
    id: string;
    bookId: string;
    name: string;
    aliases?: readonly string[];
    role?: string | null;
    profile?: unknown;
  }): CharacterRow {
    const ts = now();
    this.db.run(
      `INSERT INTO characters
         (id, book_id, name, aliases_json, role, current_status, profile_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      input.id,
      input.bookId,
      input.name,
      serializeJsonColumn(input.aliases ?? null),
      input.role ?? null,
      serializeJsonColumn(input.profile ?? null),
      ts,
      ts,
    );
    return this.get(input.id);
  }

  get(id: string): CharacterRow {
    return requireRow(
      this.db.get<CharacterRow>('SELECT * FROM characters WHERE id = ?', id),
      'character',
      id,
    );
  }

  listByBook(bookId: string): CharacterRow[] {
    return this.db.all<CharacterRow>(
      'SELECT * FROM characters WHERE book_id = ? ORDER BY created_at',
      bookId,
    );
  }

  /**
   * 按名字或别名查找。
   *
   * 实现说明：aliases 存在 JSON 列里，SQLite 无法直接索引。
   * 因此先用精确名匹配，再回退到 JSON 全扫（书内角色数量有限，代价可接受）。
   * 若将来角色数上千，应改为独立的 character_aliases 表。
   */
  findByName(bookId: string, name: string): CharacterRow | undefined {
    const exact = this.db.get<CharacterRow>(
      'SELECT * FROM characters WHERE book_id = ? AND name = ?',
      bookId,
      name,
    );
    if (exact) return exact;
    return this.db.all<CharacterRow>('SELECT * FROM characters WHERE book_id = ?', bookId).find((c) => {
      const aliases = parseJsonColumn<string[]>(c.aliases_json, 'aliases_json', c.id);
      return Array.isArray(aliases) && aliases.includes(name);
    });
  }

  updateProfile(id: string, patch: { role?: string | null; profile?: unknown; currentStatus?: string | null }): CharacterRow {
    const cur = this.get(id);
    this.db.run(
      `UPDATE characters SET role = ?, profile_json = ?, current_status = ?, updated_at = ? WHERE id = ?`,
      patch.role === undefined ? cur.role : patch.role,
      patch.profile === undefined ? cur.profile_json : serializeJsonColumn(patch.profile),
      patch.currentStatus === undefined ? cur.current_status : patch.currentStatus,
      now(),
      id,
    );
    return this.get(id);
  }

  // ── character_states ───────────────────────────────────────

  appendState(input: {
    id: string;
    characterId: string;
    chapterNumber: number;
    state: unknown;
    sourceFactIds?: readonly string[];
  }): CharacterStateRow {
    this.db.run(
      `INSERT INTO character_states
         (id, character_id, chapter_number, state_json, source_fact_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.id,
      input.characterId,
      input.chapterNumber,
      JSON.stringify(input.state),
      serializeJsonColumn(input.sourceFactIds ?? null),
      now(),
    );
    return requireRow(
      this.db.get<CharacterStateRow>('SELECT * FROM character_states WHERE id = ?', input.id),
      'character_state',
      input.id,
    );
  }

  /** 取某角色在指定章节（含）之前的最近一条状态 —— 支撑 as-of 查询 */
  stateAt(characterId: string, chapterNumber: number): CharacterStateRow | undefined {
    return this.db.get<CharacterStateRow>(
      `SELECT * FROM character_states
       WHERE character_id = ? AND chapter_number <= ?
       ORDER BY chapter_number DESC LIMIT 1`,
      characterId,
      chapterNumber,
    );
  }

  latestState(characterId: string): CharacterStateRow | undefined {
    return this.db.get<CharacterStateRow>(
      'SELECT * FROM character_states WHERE character_id = ? ORDER BY chapter_number DESC LIMIT 1',
      characterId,
    );
  }

  readState<T>(row: CharacterStateRow): T {
    return parseJsonColumn<T>(row.state_json, 'state_json', row.id) as T;
  }

  /** Commit 回滚时删除本章写入的状态快照（ADR-0002 的 DB 侧回滚） */
  deleteByChapter(characterId: string, chapterNumber: number): number {
    return this.db.run(
      'DELETE FROM character_states WHERE character_id = ? AND chapter_number = ?',
      characterId,
      chapterNumber,
    ).changes;
  }
}
