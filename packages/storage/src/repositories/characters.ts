/**
 * characters / character_states 仓储（施工文档 §10.4 / §10.5）
 *
 * 关键语义：character_states 是**按章快照**，读取「当前状态」= 取最大章节号那一条。
 * 不维护可变的 current_state 字段 —— 那会在 Commit 回滚时留下不一致。
 */
import { AppError, ErrorCode } from '@nwa/core';
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

  /**
   * 更新角色档案。
   *
   * ⚠ **可以改 name / aliases**（P2-4c 扩）。此前只能改 role/currentStatus/
   * profile —— 而作者最常需要改的恰恰是**打错的名字**：角色名是正文里
   * 识别"谁是谁"的键，错一个字会让连续性检查认不出同一个角色，
   * 表现为"凭空冒出一个人"或"角色从未出场"。
   *
   * ⚠ 改 name/aliases 必须**拒绝与其他角色撞名**：`findByName` 是角色
   * 解析的键，两个同名角色会让解析结果取决于查询顺序（不可复现）。
   * 这是数据完整性约束，不是用户体验偏好。
   */
  update(
    id: string,
    patch: {
      name?: string;
      aliases?: readonly string[] | null;
      role?: string | null;
      profile?: unknown;
      currentStatus?: string | null;
    },
  ): CharacterRow {
    const cur = this.get(id);

    if (patch.name !== undefined && patch.name !== cur.name) {
      const clash = this.findByName(cur.book_id, patch.name);
      if (clash && clash.id !== id) {
        throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, `角色名「${patch.name}」已被占用`, {
          details: { conflictingCharacterId: clash.id },
        });
      }
    }

    this.db.run(
      `UPDATE characters SET name = ?, aliases_json = ?, role = ?, profile_json = ?,
         current_status = ?, updated_at = ? WHERE id = ?`,
      patch.name === undefined ? cur.name : patch.name,
      patch.aliases === undefined ? cur.aliases_json : serializeJsonColumn(patch.aliases),
      patch.role === undefined ? cur.role : patch.role,
      patch.profile === undefined ? cur.profile_json : serializeJsonColumn(patch.profile),
      patch.currentStatus === undefined ? cur.current_status : patch.currentStatus,
      now(),
      id,
    );
    return this.get(id);
  }

  /**
   * 删除角色。
   *
   * ⚠ 三处连带影响，缺一不可（P2-4c）：
   *
   * 1. **`character_states`**：由 `ON DELETE CASCADE` 清理（依赖
   *    `PRAGMA foreign_keys` 生效，`database.ts:17` 已强制）。
   * 2. **`facts.subject_id` 是软引用**（`subject_id TEXT`，**无 FK**）——
   *    删角色**不会**清掉指向它的事实，留下悬空 subject_id：
   *    连续性检查找不到角色名，却仍会拿这些事实判冲突，
   *    报出的问题无法定位到任何人。
   * 3. 因此：**有 CANON 事实的角色拒绝删除**。
   *    已进入正史的角色被删掉，等于让"已发生的事"失去主体；
   *    作者的诉求通常是改名，改名请用 `update()`。
   *    确需删除时，先 `facts.retire()` 退役相关事实 —— 退役是可追溯的
   *    状态变更，而删除不可追溯。
   *
   * 非 CANON（PROVISIONAL / CONTRADICTED / RETIRED）事实不阻断，
   * 但它们指向已删除角色的记录**会被清掉**，避免悬空引用。
   */
  remove(id: string): { removed: boolean; detachedFacts: number } {
    const cur = this.get(id);
    const related = this.db.all<{ status: string }>(
      `SELECT status FROM facts WHERE subject_type = 'CHARACTER' AND subject_id = ?`,
      id,
    );
    const canonCount = related.filter((f) => f.status === 'CANON').length;
    if (canonCount > 0) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `「${cur.name}」有 ${canonCount} 条已进入正史的事实，不能删除；` +
          `如要改名请用编辑，确需删除请先退役相关事实`,
        { details: { canonFacts: canonCount } },
      );
    }

    return this.db.transaction(() => {
      const detachedFacts = this.db.run(
        `DELETE FROM facts WHERE subject_type = 'CHARACTER' AND subject_id = ?`,
        id,
      ).changes;
      this.db.run('DELETE FROM characters WHERE id = ?', id);
      return { removed: true, detachedFacts };
    });
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
