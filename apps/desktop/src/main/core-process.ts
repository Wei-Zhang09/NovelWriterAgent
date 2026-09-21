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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Logger, AppError, ErrorCode, bookId } from '@nwa/core';
import { Database, MIGRATIONS, createRepositories, type Repositories } from '@nwa/storage';
import {
  ToolRegistry,
  createAllTools,
  ModelGateway,
  AgentRuntime,
  EventBus,
  AGENT_PERMISSIONS,
  canTransition,
  allowedTargets,
  type CryptoBackend,
  type ModelProfile,
  type ModelSlot,
  type SecretStore,
} from '@nwa/harness';
import { z } from 'zod';
import type { ToolContext } from '@nwa/shared';
import type { AgentHandler } from '@nwa/harness';

const logger = new Logger('core');

/** Electron 在 utilityProcess 中注入的 parentPort（不是 worker_threads 的） */
const parentPort = process.parentPort;

/** 请求处理方法表。 */
type RawResult = { readonly __raw: true; readonly payload: unknown };

interface CryptoResponse {
  readonly kind: 'crypto-response';
  readonly requestId: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

/** main 告知的加密后端状态（safeStorage 只有 main 能查询） */
interface EncryptionInfo {
  readonly kind: 'encryption-info';
  readonly available: boolean;
}

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
  /** STEP 4：Event Bus 与 Agent Runtime（模型未配置时 runtime 为 null） */
  readonly events: EventBus;
  runtime: AgentRuntime | null;
}

let opened: OpenProject | null = null;

/**
 * 加密后端：通过 IPC 委托给 main 进程的 Electron safeStorage。
 *
 * ⚠ 架构约束（ADR-0001）：`safeStorage` 是 **main 进程**模块，
 *   utilityProcess 拿不到它（实测报 "The requested module 'electron'
 *   does not provide an export named 'safeStorage'"）。因此加解密必须由
 *   main 提供，core 侧只做异步代理。
 *
 * 实测（STEP 3，在 main 侧）：Windows 后端为 DPAPI，
 * isEncryptionAvailable() === true，加解密往返正确且密文不含明文。
 *
 * ⚠ 若不可用，FileSecretStore 会**拒绝写入**而不是明文落盘 ——
 *   静默降级会让用户误以为已经加密（§38 的意图正是"不放明文"）。
 */
/**
 * 加密可用性由 main 在启动时告知（safeStorage 只有 main 能查询）。
 * null 表示尚未收到告知。
 */
let encryptionAvailable: boolean | null = null;

/** main 在启动时通过 event 告知加密可用性 */
function setEncryptionAvailable(v: boolean): void {
  encryptionAvailable = v;
}

async function callMain<T>(op: string, payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const requestId = `crypto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      cryptoPending.delete(requestId);
      reject(new AppError(ErrorCode.MODEL_AUTH_FAILED, `主进程未响应加密请求：${op}`));
    }, 10_000);
    cryptoPending.set(requestId, { resolve: resolve as (v: unknown) => void, reject, timer });
    parentPort.postMessage({ kind: 'crypto-request', requestId, op, payload });
  });
}

const cryptoPending = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }
>();

/** main 侧回传加密结果时调用 */
function resolveCrypto(requestId: string, ok: boolean, value: unknown, error?: string): void {
  const entry = cryptoPending.get(requestId);
  if (!entry) return;
  cryptoPending.delete(requestId);
  clearTimeout(entry.timer);
  if (ok) entry.resolve(value);
  else entry.reject(new AppError(ErrorCode.MODEL_AUTH_FAILED, error ?? '加密操作失败'));
}

/**
 * 注意：FileSecretStore 的 CryptoBackend 接口是同步的，
 * 而 IPC 天然异步。因此这里**不使用** FileSecretStore，
 * 改用下方 AsyncSecretStore —— 由 main 进程直接持有密钥文件。
 */
const cryptoBackend: CryptoBackend = {
  name: 'main:electron-safeStorage',
  available: () => encryptionAvailable === true,
  encrypt: () => {
    throw new AppError(
      ErrorCode.MODEL_AUTH_FAILED,
      '加密在 main 进程执行；core 侧请使用 secretGet/secretSet 等异步接口',
    );
  },
  decrypt: () => {
    throw new AppError(
      ErrorCode.MODEL_AUTH_FAILED,
      '解密在 main 进程执行；core 侧请使用 secretGet/secretSet 等异步接口',
    );
  },
};

/** 模型配置存在项目目录下的 models.json（不含密钥，只含引用名） */
interface ModelsConfig {
  slots: Record<ModelSlot, string>;
  profiles: ModelProfile[];
}

function modelsConfigPath(dir: string): string {
  return join(dir, 'models.json');
}

function loadModelsConfig(dir: string): ModelsConfig | null {
  const p = modelsConfigPath(dir);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as ModelsConfig;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.profiles)) return null;
    return raw;
  } catch (err) {
    logger.warn('models.json 解析失败，忽略', { error: String(err) });
    return null;
  }
}

function saveModelsConfig(dir: string, cfg: ModelsConfig): void {
  writeFileSync(modelsConfigPath(dir), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/**
 * 密钥存储代理：真正的文件读写与加解密都在 main 进程完成。
 *
 * 为什么这样切：safeStorage 不可在 utilityProcess 使用（见上）。
 * core 只持有引用名，永远不接触密钥文件路径，也就无法绕过加密直接读盘。
 */
const secretsProxy: SecretStore = {
  get backend() {
    return 'main:electron-safeStorage';
  },
  get: (ref) => callMain<string | undefined>('get', { ref }),
  set: (ref, value) => callMain<void>('set', { ref, value }),
  delete: (ref) => callMain<void>('delete', { ref }),
};

/** 列出已保存的引用名（不含值） */
async function secretRefs(): Promise<string[]> {
  return callMain<string[]>('listRefs', {});
}

/** Model Gateway（有配置才构造；没有配置时相关 handler 返回友好错误） */
function gateway(): ModelGateway {
  const p = requireProject();
  const cfg = loadModelsConfig(p.dir);
  if (!cfg || cfg.profiles.length === 0) {
    throw new AppError(
      ErrorCode.MODEL_AUTH_FAILED,
      '尚未配置任何模型。请在「模型设置」中填写 endpoint、模型名与密钥。',
    );
  }
  return new ModelGateway({
    profiles: cfg.profiles,
    slots: cfg.slots,
    secrets: secretsProxy,
    logger: logger.child('models'),
  });
}

/** 当前 schema 版本（写入 checkpoint，恢复时校验兼容性） */
const SCHEMA_VERSION = '0002_checkpoint_seq';

/**
 * 构建 Agent Runtime。
 *
 * 模型未配置时返回 null —— 而不是塞一个坏掉的 gateway，
 * 这样 UI 能区分「没配模型」与「配了但连不上」。
 */
function buildRuntime(project: OpenProject): AgentRuntime | null {
  const cfg = loadModelsConfig(project.dir);
  if (!cfg || cfg.profiles.length === 0) return null;

  const gateway = new ModelGateway({
    profiles: cfg.profiles,
    slots: cfg.slots,
    secrets: secretsProxy,
    logger: logger.child('models'),
  });

  const rt = new AgentRuntime({
    runs: project.repos.runs,
    tools: project.tools,
    models: gateway,
    events: project.events,
    logger: logger.child('agent'),
    schemaVersion: SCHEMA_VERSION,
  });

  // 注册内置 Agent：STEP 4 只做「连通性 Agent」验证链路，
  // 真正的 Planner / Writer / Reviewer 在 STEP 6-8 实现。
  for (const h of createProbeAgents()) rt.register(h);
  return rt;
}

/**
 * STEP 4 的内置探针 Agent。
 *
 * 用途：在不实现写作逻辑的前提下，验证 Runtime 的四条约束真的生效
 * （权限下发、异常落事件、checkpoint、cancel/pause）。
 * STEP 6 起会被真正的 Planner/Writer 替换，探针保留用于自检。
 */
function createProbeAgents(): AgentHandler[] {
  return [
    {
      agentType: 'reviewer', // 只读 Agent：用于验证「审查类不能写」这条约束
      execute: async (ctx) => {
        const res = await ctx.structured({
          schema: z.object({ echo: z.string(), tokens: z.number().optional() }),
          schemaName: 'ProbeReview',
          messages: [
            { role: 'system', content: '你是审稿探针。只输出 JSON：{"echo": "ok"}' },
            { role: 'user', content: ctx.input.goal },
          ],
        });
        if (!res.ok) {
          throw new AppError(
            (res.error.code as never) ?? ErrorCode.MODEL_STRUCTURED_EMPTY,
            `审稿探针结构化输出失败：${res.error.message}`,
            {
              details: {
                attempts: res.attempts,
                usedFallback: res.usedFallback,
                rawText: res.rawText.slice(0, 300),
              },
            },
          );
        }
        ctx.checkpoint('REVIEWED', { ok: true }, { artifacts: [] });
        return { output: res.data, artifacts: [] };
      },
    },
  ];
}

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

    const events = new EventBus({ runs: repos.runs, logger: logger.child('events') });
    const project: OpenProject = { dir, db, repos, tools, events, runtime: null };
    project.runtime = buildRuntime(project);
    opened = project;
    logger.info('项目已打开', { dir, tools: tools.list().length, agentReady: project.runtime !== null });

    return {
      dir,
      toolCount: tools.list().length,
      agentReady: project.runtime !== null,
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

  // ── Agent Runtime / Run 可观测性（STEP 4） ────────────────

  /** Run 与 Agent 的当前状态（UI 右栏） */
  'run.status': () => {
    const p = requireProject();
    return {
      agentReady: p.runtime !== null,
      /** 各 Agent 类型的权限上限 —— UI 展示「谁只读」 */
      agentPermissions: AGENT_PERMISSIONS,
      active: p.runtime?.listActive() ?? [],
      recentRuns: p.repos.runs.listActive(p.repos.projects.list()[0]?.id ?? '').map((r) => ({
        id: r.id,
        workflowType: r.workflow_type,
        status: r.status,
        startedAt: r.started_at,
      })),
    };
  },

  /** 状态机的可迁移目标（UI 只显示能点的按钮） */
  'state.allowedTargets': (params: { from: string }) => ({
    from: params.from,
    allowed: allowedTargets(params.from as never),
  }),

  /** 预检一次状态迁移（不执行，仅告知是否允许） */
  'state.canTransition': (params: { from: string; to: string; reason?: string }) =>
    canTransition({
      from: params.from as never,
      to: params.to as never,
      reason: params.reason ?? 'precheck',
    }),

  /**
   * 触发一次探针 Agent Run（STEP 4 的端到端验证入口）。
   *
   * 会真实调用模型（若已配置），并产生可直接在右栏查看的事件流。
   */
  'agent.runProbe': async (params: { agentType?: string; goal?: string }) => {
    const p = requireProject();
    if (!p.runtime) {
      throw new AppError(ErrorCode.MODEL_AUTH_FAILED, '尚未配置模型，无法运行 Agent 探针');
    }
    const projectId = p.repos.projects.list()[0]?.id;
    if (!projectId) {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '还没有项目，请先创建');
    }
    const agentType = (params.agentType ?? 'reviewer') as AgentHandler['agentType'];
    const res = await p.runtime.run({
      runId: '',
      agentType,
      goal: params.goal ?? '请回复 ok',
      projectId,
      mode: 'interactive',
    });
    return { ...res, events: p.runtime.eventsFor(res.runId) };
  },

  /** 读取某 Run 的事件流（UI 展示「为什么走到这一步」） */
  'run.events': (params: { runId: string }) => {
    const p = requireProject();
    return { runId: params.runId, events: p.events.list(params.runId) };
  },

  /** 最近一次 checkpoint（恢复入口） */
  'run.lastCheckpoint': (params: { runId: string }) => {
    const p = requireProject();
    const ck = p.runtime?.lastCheckpoint(params.runId);
    if (!ck) return { runId: params.runId, checkpoint: null };
    return {
      runId: params.runId,
      checkpoint: { id: ck.id, stage: ck.stage, seq: ck.seq, createdAt: ck.created_at },
    };
  },

  // ── 模型设置（§38：密钥与配置分离） ────────────────────────

  /** 返回配置与密钥状态；**绝不返回密钥值** */
  'model.config.get': async () => {
    const p = requireProject();
    const cfg = loadModelsConfig(p.dir);
    const refs = await secretRefs();
    return {
      configured: (cfg?.profiles.length ?? 0) > 0,
      profiles: (cfg?.profiles ?? []).map((x) => ({
        id: x.id,
        provider: x.provider,
        endpoint: x.endpoint,
        model: x.model,
        apiKeyRef: x.apiKeyRef ?? null,
        temperature: x.temperature,
        maxTokens: x.maxTokens,
        timeoutMs: x.timeoutMs,
        maxAttempts: x.retryPolicy.maxAttempts,
        structuredFallbackProfileId: x.retryPolicy.structuredFallbackProfileId ?? null,
      })),
      slots: cfg?.slots ?? { architect: '', writer: '', reviewer: '', utility: '' },
      /** 已保存的密钥引用名（值不可读） */
      savedKeyRefs: refs,
      /** 加密后端状态 —— 由 main 告知（safeStorage 只有 main 能查询） */
      encryption: {
        available: encryptionAvailable === true,
        backend: 'electron-safeStorage (main process)',
      },
      configPath: modelsConfigPath(p.dir),
    };
  },

  /**
   * 保存一个模型 profile。
   *
   * 密钥分离：apiKey（明文）只进入 SecretStore 加密存储，
   * models.json 里只留 apiKeyRef —— 这样配置文件可以安全地被人查看。
   */
  'model.config.save': async (params: {
    profile: {
      id: string;
      endpoint: string;
      model: string;
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      maxAttempts?: number;
      structuredFallbackProfileId?: string | null;
    };
    /** 明文密钥；空/未提供表示不修改已存的密钥 */
    apiKey?: string | null;
    /** 是否把它设为全部槽位的默认 */
    useForAllSlots?: boolean;
    /** 指定槽位 */
    slots?: Partial<Record<ModelSlot, string>>;
  }) => {
    const p = requireProject();
    const prof = params.profile;
    if (!prof?.id || !prof.endpoint || !prof.model) {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, 'profile 的 id / endpoint / model 均为必填');
    }

    const apiKeyRef = `profile:${prof.id}`;
    if (params.apiKey && params.apiKey.trim().length > 0) {
      await secretsProxy.set(apiKeyRef, params.apiKey.trim());
      logger.info('已加密保存密钥', { ref: apiKeyRef, backend: cryptoBackend.name });
    }

    const existing = loadModelsConfig(p.dir);
    const next: ModelProfile = {
      id: prof.id,
      provider: 'openai-compatible',
      endpoint: prof.endpoint.replace(/\/+$/, ''),
      model: prof.model,
      apiKeyRef,
      temperature: prof.temperature ?? 0.8,
      maxTokens: prof.maxTokens ?? 4096,
      contextWindow: 128000,
      timeoutMs: prof.timeoutMs ?? 60000,
      retryPolicy: {
        maxAttempts: prof.maxAttempts ?? 3,
        ...(prof.structuredFallbackProfileId
          ? { structuredFallbackProfileId: prof.structuredFallbackProfileId }
          : {}),
      },
    };

    const profiles = [...(existing?.profiles ?? []).filter((x) => x.id !== next.id), next];
    const slots: Record<ModelSlot, string> = params.useForAllSlots
      ? { architect: next.id, writer: next.id, reviewer: next.id, utility: next.id }
      : {
          architect: params.slots?.architect ?? existing?.slots.architect ?? next.id,
          writer: params.slots?.writer ?? existing?.slots.writer ?? next.id,
          reviewer: params.slots?.reviewer ?? existing?.slots.reviewer ?? next.id,
          utility: params.slots?.utility ?? existing?.slots.utility ?? next.id,
        };

    saveModelsConfig(p.dir, { slots, profiles });
    logger.info('模型配置已保存', { profileId: next.id, slots, configPath: modelsConfigPath(p.dir) });
    return { ok: true, profileId: next.id, apiKeyRef, slots };
  },

  /** 删除密钥引用（不删除 profile 配置） */
  'model.secret.delete': async (params: { ref: string }) => {
    await secretsProxy.delete(params.ref);
    return { ok: true, ref: params.ref };
  },

  /**
   * 连通性测试：发一条最小的真实请求。
   *
   * 这是 STEP 3 的验收手段 —— 只有真实调用成功才算接通。
   * 返回值不回显任何密钥内容。
   */
  'model.test': async (params: { slot?: ModelSlot; prompt?: string }) => {
    const slot = params.slot ?? 'utility';
    const gw = gateway();
    const profile = gw.profileFor(slot);
    const started = Date.now();
    try {
      const res = await gw.chat(slot, {
        messages: [{ role: 'user', content: params.prompt ?? '请只回复两个字：连通' }],
        temperature: 0,
        maxTokens: 32,
      });
      return {
        ok: true,
        slot,
        profileId: profile.id,
        model: res.model,
        text: res.text.slice(0, 200),
        usage: res.usage,
        latencyMs: Date.now() - started,
        finishReason: res.finishReason,
      };
    } catch (err) {
      const e = AppError.from(err);
      logger.error('模型连通性测试失败', err, { slot, profileId: profile.id });
      return {
        ok: false,
        slot,
        profileId: profile.id,
        latencyMs: Date.now() - started,
        error: { code: e.code, message: e.message, retryable: e.retryable, details: e.details },
      };
    }
  },
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
  const events = new EventBus({ runs: repos.runs, logger: logger.child('events') });
  const project: OpenProject = { dir: PROJECTS_ROOT, db, repos, tools, events, runtime: null };
  project.runtime = buildRuntime(project);
  opened = project;
  logger.info('迁移完成', {
    applied: MIGRATIONS.map((m) => m.id),
    tools: tools.list().length,
    agentReady: project.runtime !== null,
  });

  parentPort.on('message', (e: { data: CoreRequest | CryptoResponse | EncryptionInfo }) => {
    const msg = e.data;
    if (msg && msg.kind === 'crypto-response') {
      resolveCrypto(msg.requestId, msg.ok, msg.value, msg.error);
      return;
    }
    if (msg && msg.kind === 'encryption-info') {
      setEncryptionAvailable(msg.available);
      logger.info('加密后端状态已同步', { available: msg.available });
      return;
    }
    void handle(msg as CoreRequest);
  });

  parentPort.postMessage({
    kind: 'event',
    requestId: 'boot',
    payload: { type: 'CORE_READY', projectsRoot: PROJECTS_ROOT, toolCount: tools.list().length },
  });
  // 单独发一个 ready 信号，main 收到后会把加密后端状态告知我们
  parentPort.postMessage({ kind: 'ready' });
}

bootstrap();
