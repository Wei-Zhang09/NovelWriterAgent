/**
 * core utilityProcess —— Novel Harness 的运行宿主（ADR-0001）
 *
 * 这里才是执行 SQLite 查询与（未来的）LLM 调用的地方。
 * 与主进程通过 MessagePort 通信，崩溃不会带走 UI（这是 Test D 的测试手段）。
 *
 * 进度：
 *   STEP 0  打通 IPC + 打开 DB + 验证迁移
 *   STEP 1  挂载仓储层
 *   STEP 2  挂载 Tool Registry + 项目生命周期管理（当前）
 *   STEP 3  挂载 Model Gateway
 *   STEP 4  挂载 Agent Runtime / Workflow / Event Bus
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { Logger, AppError, ErrorCode, bookId } from '@nwa/core';
import { Database, MIGRATIONS, createRepositories, type Repositories } from '@nwa/storage';
import { ToolRegistry, createAllTools } from '@nwa/harness';
import type { ToolContext } from '@nwa/shared';

const logger = new Logger('core');

/** Electron 在 utilityProcess 中注入的 parentPort（不是 worker_threads 的） */
const parentPort = process.parentPort;

/** 请求处理方法表。 */
type RawResult = { readonly __raw: true; readonly payload: unknown };

interface CoreRequest {
  readonly kind: 'request';
  readonly requestId: string;
  readonly method: string;
  readonly params?: unknown;
}

/** 项目状态的单例（v1.0 同一时刻只打开一个项目） */
interface OpenProject {
  readonly dir: string;
  readonly db: Database;
  readonly repos: Repositories;
  readonly tools: ToolRegistry;
}

let opened: OpenProject | null = null;

function requireProject(): OpenProject {
  if (!opened) {
    throw new AppError(ErrorCode.WORKSPACE_CORRUPTED, '尚未打开项目');
  }
  return opened;
}

/** 项目根目录：用户可见、可检查（§0.1「文件和数据库可检查」） */
const PROJECTS_ROOT = join(homedir(), 'NovelWriterProjects');

/** 统一的工具调用上下文 —— 由宿主构造，模型无法伪造 */
function toolContext(callerPermission: ToolContext['callerPermission'] = 'ADMIN'): ToolContext {
  const ctx: ToolContext = {
    runId: 'core-direct',
    projectId: opened ? (opened.repos.projects.list()[0]?.id ?? 'unknown') : 'unknown',
    callerPermission,
    emit: (eventType, payload) => {
      // STEP 4 会替换为真正的 Event Bus；当前先转发给 UI
      parentPort.postMessage({
        kind: 'event',
        requestId: 'tool-event',
        payload: { type: 'TOOL_EVENT', eventType, payload },
      });
    },
  };
  return ctx;
}

/**
 * 请求处理方法表。
 *
 * 约定：每个方法返回 `{ ok: true, data }` 或 `{ ok: false, error }`，
 * 异常不得穿透到 MessagePort（§55 Rule 8：禁止吞异常，必须转成结构化错误）。
 */
const handlers: Record<string, (params: never) => Promise<unknown> | unknown> = {
  /** 健康检查 */
  'core.health': () => ({
    pid: process.pid,
    node: process.versions.node,
    sqlite: 'ready',
    projectOpen: opened !== null,
  }),

  'core.migrations': () => {
    const p = requireProject();
    return {
      applied: p.db.all<{ id: string; applied_at: string }>(
        'SELECT id, applied_at FROM schema_migrations ORDER BY id',
      ),
    };
  },

  'core.schema.stats': () => {
    const d = requireProject().db;
    const tables = d.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const indexes = d.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const fts = d.all<{ name: string }>(
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

  'core.verify.constraints': () => {
    const d = requireProject().db;
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

  'core.fts.probe': () => {
    const d = requireProject().db;
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

  // ── 项目生命周期 ──────────────────────────────────────────

  /**
   * 打开（或按需创建）一个项目。
   *
   * 约束：v1.0 同一时刻只允许一个打开的项目。重复打开不同项目会先关闭前一个，
   * 避免多连接并发写同一批文件（ADR-0002 v2 的排他锁在 STEP 11 补）。
   */
  'project.open': (params: { dir?: string; name?: string }) => {
    if (opened) {
      opened.db.close();
      opened = null;
    }
    const dir = params.dir ?? PROJECTS_ROOT;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'project.db');

    const db = new Database({ path: dbPath, migrations: MIGRATIONS });
    const repos = createRepositories(db);
    const tools = new ToolRegistry(logger.child('tools'));
    for (const tool of createAllTools(repos)) tools.register(tool);

    opened = { dir, db, repos, tools };
    logger.info('项目已打开', { dir, tables: tools.list().length });

    return {
      dir,
      toolCount: tools.list().length,
      projectCount: repos.projects.list().length,
      bookCount: repos.projects.list().length === 0 ? 0 : repos.books.listByProject(repos.projects.list()[0]!.id).length,
    };
  },

  'project.info': () => {
    const p = requireProject();
    return {
      dir: p.dir,
      tools: p.tools.list(),
      permissions: p.tools.permissionReport(),
      projects: p.repos.projects.list().map((r) => ({
        id: r.id,
        name: r.name,
        genre: r.genre,
        createdAt: r.created_at,
      })),
    };
  },

  'book.list': (params: { projectId: string }) => {
    const p = requireProject();
    return {
      books: p.repos.books.listByProject(params.projectId).map((b) => ({
        id: b.id, projectId: b.project_id, title: b.title, currentChapter: b.current_chapter,
      })),
    };
  },

  /**
   * 新建书目。
   *
   * 注意：这条不走 Tool Registry —— 施工文档 §6.3 的工具清单里没有 book.create
   * （书是项目的 1:1 附属物，不单独作为 Agent 工具暴露）。
   * 它属于桌面 UI 的项目管理能力，权限由 IPC 层保证（本地可信）。
   */
  'book.create': (params: { projectId: string; title: string }) => {
    const p = requireProject();
    if (!params.title || params.title.trim().length === 0) {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '书名不得为空');
    }
    const row = p.repos.books.create({
      id: bookId(),
      projectId: params.projectId,
      title: params.title.trim(),
    });
    logger.info('书目已创建', { bookId: row.id, title: row.title });
    return { id: row.id, projectId: row.project_id, title: row.title, currentChapter: row.current_chapter };
  },

  // ── 通过 Tool Registry 调用（统一走权限与校验门禁） ────────

  /**
   * 工具调用入口。
   *
   * ⚠ 返回类型是 `RawResult`（带标记），由 handle() 直接透传，
   *   不再套一层 {ok,data} —— 否则渲染进程会收到
   *   `{ok:true, data:{ok:true, data:{...}}}` 的双层包装，
   *   导致 `r.data.name` 读成 undefined（曾在本流程验证中真实触发）。
   */
  'tool.invoke': async (params: { name: string; input: unknown; permission?: string }): Promise<RawResult> => {
    const p = requireProject();
    const permission = (params.permission ?? 'ADMIN') as ToolContext['callerPermission'];
    const result = await p.tools.invoke(params.name, params.input, toolContext(permission));
    return { __raw: true, payload: result };
  },

  'tool.list': () => requireProject().tools.list(),
};

async function handle(req: CoreRequest): Promise<void> {
  const fn = handlers[req.method];
  let result: unknown;
  if (!fn) {
    result = { ok: false, error: { code: 'NOT_IMPLEMENTED', message: `未知方法：${req.method}` } };
  } else {
    try {
      const data = await fn(req.params as never);
      // 透传标记：handler 已自行构造完整结果（如 tool.invoke），不再套一层
      result =
        data && typeof data === 'object' && '__raw' in data
          ? (data as RawResult).payload
          : { ok: true, data };
    } catch (err) {
      // 结构化错误，不让异常穿透 MessagePort
      const appErr = AppError.from(err);
      logger.error(`处理失败：${req.method}`, err);
      result = { ok: false, error: appErr.toJSON() };
    }
  }
  parentPort.postMessage({ kind: 'response', requestId: req.requestId, payload: result });
}

function bootstrap(): void {
  logger.info('core 启动', { projectsRoot: PROJECTS_ROOT });
  mkdirSync(PROJECTS_ROOT, { recursive: true });

  // 启动即打开默认项目，让 UI 一进来就有可用上下文
  const dbPath = join(PROJECTS_ROOT, 'project.db');
  const db = new Database({ path: dbPath, migrations: MIGRATIONS });
  const repos = createRepositories(db);
  const tools = new ToolRegistry(logger.child('tools'));
  for (const tool of createAllTools(repos)) tools.register(tool);
  opened = { dir: PROJECTS_ROOT, db, repos, tools };
  logger.info('迁移完成', { applied: MIGRATIONS.map((m) => m.id), tools: tools.list().length });

  parentPort.on('message', (e: { data: CoreRequest }) => {
    void handle(e.data);
  });

  parentPort.postMessage({
    kind: 'event',
    requestId: 'boot',
    payload: { type: 'CORE_READY', projectsRoot: PROJECTS_ROOT, toolCount: tools.list().length },
  });
}

bootstrap();
