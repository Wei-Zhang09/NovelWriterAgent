/**
 * 世界观设定仓储（P2-3）
 *
 * ## ⚠ 为什么补这个文件
 *
 * `world_entities` 表在 `0001_init.sql:214` 就建好了，但**全仓零引用** ——
 * 没有仓储、没有工具、没有界面。P2-3 核查实测：引用次数 = 0。
 *
 * 这与 `timeline_events`（P0-5 补上）、`characters`（P2-2 补上）是
 * 同一类缺陷：**建了表没接线**。ADR-0003 当时把这三张表列为
 * 「Schema 预留，MVP 不写入」—— 预留本身是合理的，但到了 Full 阶段
 * 就成了"表在那里，没人用"。
 *
 * ## 设计要点
 *
 * 1. **复用既有表，不新建**
 *    世界观就是 `world_entities`（type + name + description + data_json）。
 *    另建一张"设定表"会让世界观存在两处，迟早分叉。
 *
 * 2. **状态在实体上，不在书级布尔量上**
 *    `status` 是每个实体自己的字段（DRAFT / CONFIRMED）。
 *    书级只存"确认时的整体指纹"（`books.settings_confirmed_hash`）。
 *    这样"确认后又改了设定"能被指纹自然检出，不需要每个写入口
 *    都记得清标记（详见 `@nwa/core` 的 settings-gate 模块注释）。
 *
 * 3. **不生成 id 的业务规则放在工具层**
 *    仓储只接受显式 id（同 CharacterRepository）—— id 生成策略
 *    （内容派生 vs 随机）属于业务决策，不该由仓储替调用方决定。
 */
import { AppError, ErrorCode, hashAfterConfirm } from '@nwa/core';
import type { Database } from '../database.js';
import type { BookRepository } from './projects.js';
import { now, parseJsonColumn, requireRow, serializeJsonColumn, type Timestamped } from './types.js';

export interface WorldEntityRow extends Timestamped {
  readonly id: string;
  readonly book_id: string;
  /** 实体种类，如 WORLD_RULE / LOCATION / FACTION / ITEM / CONCEPT */
  readonly type: string;
  readonly name: string;
  readonly description: string | null;
  readonly data_json: string | null;
  /** DRAFT = 草稿；CONFIRMED = 作者已定稿 */
  readonly status: string;
  /** 作者书写的顺序（势力列表、地理层级等顺序有意义） */
  readonly ord: number;
}

export interface CreateWorldEntityInput {
  readonly id: string;
  readonly bookId: string;
  readonly type: string;
  readonly name: string;
  readonly description?: string | null;
  readonly data?: unknown;
}

/**
 * 确认一本书的设定（P2-3）。
 *
 * ⚠ **必须是唯一实现**：这个三步序列（标记 CONFIRMED → 算确认后指纹 → 落库）
 *   此前内联在 IPC handler 里，于是测试只能自己重写一遍同样的三步 ——
 *   而那意味着"IPC 里那三步写错了"测试照样绿（实测：把 `hashAfterConfirm`
 *   换成 `hashSettings`，20 条测试全部通过，门禁变成永远拦自己）。
 *
 *   抽到这里之后，IPC 与测试走同一条路径，缺陷无处可藏。
 *
 * ⚠ 指纹必须按**确认后**的状态计算（`hashAfterConfirm`）：确认动作本身会把
 *   status 改成 CONFIRMED，若按确认前算，刚确认完就对不上 —— 门禁永远拦自己。
 */
export function confirmBookSettings(
  repos: { world: WorldRepository; books: BookRepository },
  bookId: string,
): { count: number; hash: string } {
  const count = repos.world.confirmAll(bookId);
  const hash = hashAfterConfirm(repos.world.snapshot(bookId));
  repos.books.confirmSettings(bookId, hash);
  return { count, hash };
}

export class WorldRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateWorldEntityInput): WorldEntityRow {
    const ts = now();
    // ord 取当前最大值 +1：作者按添加顺序排列，而不是按同一秒内不稳定的
    // created_at 排序。
    const max = this.db.get<{ m: number | null }>(
      'SELECT MAX(ord) AS m FROM world_entities WHERE book_id = ?',
      input.bookId,
    );
    const ord = (max?.m ?? -1) + 1;
    this.db.run(
      `INSERT INTO world_entities
         (id, book_id, type, name, description, data_json, status, ord, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)`,
      input.id,
      input.bookId,
      input.type,
      input.name,
      input.description ?? null,
      serializeJsonColumn(input.data ?? null),
      ord,
      ts,
      ts,
    );
    return this.get(input.id);
  }

  get(id: string): WorldEntityRow {
    return requireRow(
      this.db.get<WorldEntityRow>('SELECT * FROM world_entities WHERE id = ?', id),
      'world_entity',
      id,
    );
  }

  find(id: string): WorldEntityRow | undefined {
    return this.db.get<WorldEntityRow>('SELECT * FROM world_entities WHERE id = ?', id);
  }

  listByBook(bookId: string): WorldEntityRow[] {
    return this.db.all<WorldEntityRow>(
      'SELECT * FROM world_entities WHERE book_id = ? ORDER BY ord, created_at',
      bookId,
    );
  }

  /**
   * 更新设定内容。
   *
   * ⚠ **不在此处重置 status / 确认指纹**。
   *   状态回落靠"指纹对不上"在读时自然判定（见 settings-gate 模块），
   *   而不是靠每个写入口记得清标记。若这里顺手把 status 改回 DRAFT，
   *   就变成"靠调用方守规矩"——新增一个写入口就漏。
   */
  update(
    id: string,
    patch: { type?: string; name?: string; description?: string | null; data?: unknown },
  ): WorldEntityRow {
    const row = this.get(id);
    const sets: string[] = [];
    const args: (string | null)[] = [];
    if (patch.type !== undefined) {
      sets.push('type = ?');
      args.push(patch.type);
    }
    if (patch.name !== undefined) {
      sets.push('name = ?');
      args.push(patch.name);
    }
    if (patch.description !== undefined) {
      sets.push('description = ?');
      args.push(patch.description);
    }
    if (patch.data !== undefined) {
      sets.push('data_json = ?');
      args.push(serializeJsonColumn(patch.data));
    }
    if (sets.length === 0) {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '没有要更新的字段');
    }
    sets.push('updated_at = ?');
    args.push(now());
    this.db.run(`UPDATE world_entities SET ${sets.join(', ')} WHERE id = ?`, ...args, id);
    return this.get(row.id);
  }

  remove(id: string): void {
    const row = this.get(id);
    this.db.run('DELETE FROM world_entities WHERE id = ?', row.id);
  }

  /** 把一本书的全部设定标记为已确认（门禁的"确认"动作） */
  confirmAll(bookId: string): number {
    const ts = now();
    this.db.run(
      "UPDATE world_entities SET status = 'CONFIRMED', updated_at = ? WHERE book_id = ? AND status != 'CONFIRMED'",
      ts,
      bookId,
    );
    return this.listByBook(bookId).length;
  }

  /** 设定快照（供指纹计算）：只含参与判定的内容字段 */
  snapshot(bookId: string): { type: string; name: string; description: string; status: 'DRAFT' | 'CONFIRMED' }[] {
    return this.listByBook(bookId).map((r) => ({
      type: r.type,
      name: r.name,
      description: r.description ?? '',
      status: r.status === 'CONFIRMED' ? 'CONFIRMED' : 'DRAFT',
    }));
  }

  /**
   * 解析 data_json。
   *
   * ⚠ 不吞掉解析错误 —— `parseJsonColumn` 抛 WORKSPACE_CORRUPTED 是刻意的：
   *   静默返回 null 会把"数据损坏"伪装成"这个字段是空的"，
   *   作者会以为设定丢了，实际是库坏了（`types.ts` 的既定约定）。
   *   错误信息里带实体 id，作者能定位到具体哪一条。
   */
  dataOf(row: WorldEntityRow): unknown {
    if (!row.data_json) return null;
    return parseJsonColumn<unknown>(row.data_json, 'data_json', row.id);
  }
}
