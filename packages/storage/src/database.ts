/**
 * @nwa/storage —— SQLite 层的**唯一**访问入口
 *
 * ⚠ 本文件是 ADR-0002 v2 / 施工计划 §3.6 的核心防护点：
 *
 *   陷阱：`node:sqlite` 的 `DatabaseSync.exec(sql, param)` **不接受参数绑定**，
 *        参数被静默忽略 → 语句写入 NULL 或空值，且**不报错**。
 *
 *   因此：所有写操作必须走 prepare().run()，并统一经此处封装。
 *   `scripts/check-storage-exec.mjs` 会在 CI 中扫描违规用法。
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { AppError, ErrorCode } from '@nwa/core';

/** 一次连接的 PRAGMA 设置（连接级，必须每次建连都执行） */
const CONNECTION_PRAGMAS = [
  'PRAGMA foreign_keys = ON',      // 连接级：漏设会静默失去外键约束
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA busy_timeout = 5000',
] as const;

export interface DatabaseOptions {
  /** 数据库文件路径；':memory:' 用于测试 */
  readonly path: string;
  /** 迁移 SQL（按顺序执行）；测试可传空 */
  readonly migrations?: readonly Migration[];
}

export interface Migration {
  readonly id: string;
  readonly sql: string;
}

export class Database {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(options: DatabaseOptions) {
    try {
      this.db = new DatabaseSync(options.path);
    } catch (cause) {
      throw new AppError(ErrorCode.STORAGE_MIGRATION_FAILED, `无法打开数据库：${options.path}`, { cause });
    }
    this.applyPragmas();
    if (options.migrations?.length) this.migrate(options.migrations);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, '数据库连接已关闭');
    }
  }

  private applyPragmas(): void {
    for (const p of CONNECTION_PRAGMAS) {
      this.db.exec(p);
    }
    // 断言外键确实生效 —— 连接级设置失败时必须在启动阶段暴露
    const fk = this.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined;
    if (fk?.foreign_keys !== 1) {
      throw new AppError(
        ErrorCode.STORAGE_MIGRATION_FAILED,
        'PRAGMA foreign_keys 未生效，拒绝以可能失效的外键约束运行',
        { details: fk },
      );
    }
  }

  /**
   * 建表 / 迁移。**只执行 DDL 与 schema_migrations 记录，不接触业务数据。**
   *
   * v1.0 不做 down 迁移：本地单机 + 备份恢复（§58）已足够。
   */
  private migrate(migrations: readonly Migration[]): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const applied = new Set(
      this.db.prepare('SELECT id FROM schema_migrations').all().map((r) => (r as { id: string }).id),
    );
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      try {
        this.db.exec('BEGIN');
        this.db.exec(m.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
          .run(m.id, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (cause) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // 回滚本身失败时不掩盖原始错误（ADR-0002 精神）
        }
        throw new AppError(ErrorCode.STORAGE_MIGRATION_FAILED, `迁移失败：${m.id}`, { cause });
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // 查询 API：全部走 prepare()，不接受裸 SQL 写操作
  // ────────────────────────────────────────────────────────────

  /** 准备一条语句（读或写皆可） */
  prepare(sql: string): StatementSync {
    this.assertOpen();
    return this.db.prepare(sql);
  }

  /** 只读查询，返回多行 */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    this.assertOpen();
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  /** 只读查询，返回单行或 undefined */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    this.assertOpen();
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  /** 写操作：**必须**用 prepare().run()，绝不使用 exec 传参 */
  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    this.assertOpen();
    const r = this.db.prepare(sql).run(...(params as never[]));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  /**
   * 执行不含参数的语句（DDL / PRAGMA / 多语句脚本）。
   * **禁止**用本方法执行带占位符的 INSERT/UPDATE —— 参数会被静默忽略。
   */
  exec(sql: string): void {
    this.assertOpen();
    if (/\?\d*/.test(sql) && /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) {
      throw new AppError(
        ErrorCode.STORAGE_QUERY_FAILED,
        'exec() 不支持参数绑定；写操作请使用 run()。此调用已被拦截以防静默写入空值。',
        { details: { sql: sql.slice(0, 200) } },
      );
    }
    this.db.exec(sql);
  }

  /** 事务包装：fn 抛错则回滚（ADR-0002 的 DB 侧原子性基础） */
  transaction<T>(fn: () => T): T {
    this.assertOpen();
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 不掩盖原始错误
      }
      throw cause;
    }
  }

  /** FTS5 全量重建（§59：FTS 是 Derived，必须可幂等重建） */
  rebuildFts(table: string, sourceSql: string): void {
    this.transaction(() => {
      this.db.exec(`DELETE FROM ${table}`);
      this.db.exec(`INSERT INTO ${table} ${sourceSql}`);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
