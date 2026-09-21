/**
 * core utilityProcess —— Novel Harness 的运行宿主（ADR-0001）
 *
 * 这里才是执行 SQLite 查询与（未来的）LLM 调用的地方。
 * 与主进程通过 MessagePort 通信，崩溃不会带走 UI。
 *
 * STEP 0 范围：打通 IPC 通路 + 打开数据库 + 验证迁移。
 * STEP 1 起在此挂载仓储，STEP 4 挂载 Harness。
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { Logger } from '@nwa/core';
import { Database, MIGRATIONS } from '@nwa/storage';

const logger = new Logger('core');

/** Electron 在 utilityProcess 中注入的 parentPort（不是 worker_threads 的） */
const parentPort = process.parentPort;

interface CoreRequest {
  readonly kind: 'request';
  readonly requestId: string;
  readonly method: string;
  readonly params?: unknown;
}

let db: Database | null = null;

function getDb(): Database {
  if (!db) throw new Error('数据库未初始化');
  return db;
}

/**
 * 请求处理方法表。
 *
 * 约定：每个方法返回 `{ ok: true, data }` 或 `{ ok: false, error }`，
 * 异常不得穿透到 MessagePort（§55 Rule 8：禁止吞异常，必须转成结构化错误）。
 */
const handlers: Record<string, (params: unknown) => Promise<unknown> | unknown> = {
  /** 健康检查：用于启动时验证 IPC 与 DB 通路 */
  'core.health': () => ({
    pid: process.pid,
    node: process.versions.node,
    sqlite: db ? 'ready' : 'unavailable',
  }),

  /** STEP 0 验证用：列出已应用的迁移 */
  'core.migrations': () => ({
    applied: getDb().all<{ id: string; applied_at: string }>(
      'SELECT id, applied_at FROM schema_migrations ORDER BY id',
    ),
  }),

  /** STEP 0 验证用：统计已建表数量与索引数量 */
  'core.schema.stats': () => {
    const tables = getDb().all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const indexes = getDb().all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const fts = getDb().all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%USING fts5%'",
    );
    return {
      tableCount: tables.length,
      indexCount: indexes.length,
      ftsCount: fts.length,
      tables: tables.map((t) => t.name),
      ftsTables: fts.map((t) => t.name),
    };
  },

  /** STEP 0 验证用：外键约束是否真正生效（连接级 PRAGMA 必须落实） */
  'core.verify.constraints': () => {
    const d = getDb();
    d.exec('CREATE TABLE IF NOT EXISTS _fk_parent (id TEXT PRIMARY KEY)');
    d.exec(
      'CREATE TABLE IF NOT EXISTS _fk_child (id TEXT PRIMARY KEY, pid TEXT REFERENCES _fk_parent(id) ON DELETE CASCADE)',
    );
    d.run('DELETE FROM _fk_child');
    d.run('DELETE FROM _fk_parent');
    d.run('INSERT INTO _fk_parent (id) VALUES (?)', 'p1');

    let enforced = false;
    let message = '';
    try {
      d.run('INSERT INTO _fk_child (id, pid) VALUES (?, ?)', 'c_bad', 'missing');
    } catch (err) {
      enforced = true;
      message = err instanceof Error ? err.message.slice(0, 60) : String(err);
    }
    d.exec('DROP TABLE _fk_child');
    d.exec('DROP TABLE _fk_parent');
    return { foreignKeyEnforced: enforced, message };
  },

  /** STEP 0 验证用：FTS5 + BM25 可用性（ADR-0004 的基础） */
  'core.fts.probe': () => {
    const d = getDb();
    // 注意：DDL 走 exec（无参数，合法）；写入走 run（参数绑定）
    d.exec("CREATE VIRTUAL TABLE IF NOT EXISTS _probe_fts USING fts5(body, tokenize='unicode61')");
    d.run('DELETE FROM _probe_fts');
    d.run('INSERT INTO _probe_fts(body) VALUES (?)', 'hello world');
    d.run('INSERT INTO _probe_fts(body) VALUES (?)', 'goodbye moon');
    const rows = d.all<{ body: string; score: number }>(
      'SELECT body, bm25(_probe_fts) AS score FROM _probe_fts WHERE _probe_fts MATCH ? ORDER BY score',
      'hello',
    );
    d.exec('DROP TABLE _probe_fts');
    return { fts5: true, bm25Works: rows.length === 1, rows };
  },
};

async function handle(req: CoreRequest): Promise<void> {
  const fn = handlers[req.method];
  let result: unknown;
  if (!fn) {
    result = { ok: false, error: { code: 'NOT_IMPLEMENTED', message: `未知方法：${req.method}` } };
  } else {
    try {
      result = { ok: true, data: await fn(req.params) };
    } catch (err) {
      // 结构化错误，不让异常穿透 MessagePort
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : 'STORAGE_QUERY_FAILED';
      logger.error(`处理失败：${req.method}`, err);
      result = { ok: false, error: { code, message } };
    }
  }
  parentPort.postMessage({ kind: 'response', requestId: req.requestId, payload: result });
}

function bootstrap(): void {
  // STEP 0 用临时库验证迁移；STEP 1 改为按项目目录打开
  const dataDir = join(tmpdir(), 'nwa-core');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'bootstrap.db');

  logger.info('打开数据库', { dbPath, migrations: MIGRATIONS.length });
  db = new Database({ path: dbPath, migrations: MIGRATIONS });
  logger.info('迁移完成', { applied: MIGRATIONS.map((m) => m.id) });

  parentPort.on('message', (e: { data: CoreRequest }) => {
    void handle(e.data);
  });

  // 通知主进程 core 已就绪
  parentPort.postMessage({ kind: 'event', requestId: 'boot', payload: { type: 'CORE_READY', dbPath } });
}

bootstrap();
