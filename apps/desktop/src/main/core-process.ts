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
import { Logger, AppError, ErrorCode, bookId, type ErrorCodeValue } from '@nwa/core';
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
  ContextEngine,
  conservativeTokenCounter,
  type CryptoBackend,
  type ModelProfile,
  type ModelSlot,
  type SecretStore,
} from '@nwa/harness';
import { z } from 'zod';
import { Planner, Writer, Reviewer } from '@nwa/writing';
import { ChapterWorkspace, ContinuityChecker, FactExtractor, CanonPromoter } from '@nwa/story';
import { CommitEngine } from '@nwa/harness';
import type { ReviewIssue } from '@nwa/shared';
import { TransitionGate } from '@nwa/harness';
import type { ToolContext } from '@nwa/shared';
import type { AgentHandler, ContextEntry, SlotName } from '@nwa/harness';

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
    // ⚠ commit 工具需要项目目录（写 chapters/ 等），只能在 project.open 注册
    for (const tool of createAllTools(repos, {
      logger: logger.child('tools'),
      commit: {
        db,
        rootDir: dir,
        // 工作区读取由 app 层注入，避免 @nwa/harness 依赖 @nwa/story
        readWorkspaceText: (chapterNumber, name) => {
          const ws = new ChapterWorkspace({
            rootDir: dir,
            chapterNumber,
            logger: logger.child('workspace'),
          });
          return ws.readText(name);
        },
      },
    })) {
      tools.register(tool);
    }

    const events = new EventBus({ runs: repos.runs, logger: logger.child('events') });
    const project: OpenProject = { dir, db, repos, tools, events, runtime: null };
    project.runtime = buildRuntime(project);
    opened = project;
    logger.info('项目已打开', { dir, tools: tools.list().length, agentReady: project.runtime !== null });

    // ⚠ ADR-0002 v2 步骤 0：打开项目即检查上次是否有未完成事务并收尾。
    //   必须在任何新提交之前执行，否则残留状态会污染后续判定。
    let recovery: { scanned: number; repaired: number; needsHuman: number } | null = null;
    try {
      const r = new CommitEngine({
        db,
        repos,
        rootDir: dir,
        logger: logger.child('commit'),
      }).recoverOnStartup();
      recovery = { scanned: r.scanned, repaired: r.repaired.length, needsHuman: r.needsHuman.length };
      if (r.scanned > 0) {
        logger.warn('启动时发现未完成事务并已处理', recovery);
      }
    } catch (e) {
      logger.error('启动恢复失败（不阻断打开项目）', {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    return {
      dir,
      toolCount: tools.list().length,
      agentReady: project.runtime !== null,
      recovery,
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

  // ── Planner（STEP 6） ─────────────────────────────────────

  /**
   * 用真实上下文规划一章。
   *
   * 链路：Context Engine 装配上下文 → Planner 结构化调用 → 语义校验
   *      → 有阻塞问题则自我修复重试 → 落库为章节计划。
   *
   * ⚠ 全程不写正文：只写 chapters.plan_json（由 chapter.plan 工具保证）。
   */
  'planner.planChapter': async (params: { chapterId: string; userInstruction?: string }) => {
    const p = requireProject();
    if (!p.runtime) {
      throw new AppError(ErrorCode.MODEL_AUTH_FAILED, '尚未配置模型，无法规划');
    }
    const chapter = p.repos.chapters.get(params.chapterId);

    // 1) Context Engine 装配上下文（沿用 STEP 5 的保护式预算）
    const engine = new ContextEngine({ logger: logger.child('context') });
    const slots: Partial<Record<SlotName, ContextEntry[]>> = {
      system: [
        {
          id: 'sys_identity',
          sourceType: 'PROFILE',
          sourceRef: 'system/identity.md',
          content: '你是长篇小说写作助手。Canon 是事实来源，不确定时不要自行创造。',
          priority: 100,
          isProtected: true,
        },
      ],
      chapterPlan: [
        {
          id: `plan_target_${chapter.chapter_number}`,
          sourceType: 'PLAN',
          sourceRef: chapter.id,
          content: `本次要为第 ${chapter.chapter_number} 章生成计划。`,
          priority: 100,
          isProtected: true,
        },
      ],
      protectedCanon: [],
      topMemory: [],
    };

    const bookId = p.repos.books.listByProject(
      p.repos.projects.list()[0]!.id,
    )[0]?.id;
    if (bookId) {
      for (const f of p.repos.facts.listByStatus(bookId, 'CANON').slice(0, 50)) {
        slots.protectedCanon!.push({
          id: f.id,
          sourceType: 'FACT',
          sourceRef: f.evidence_id ?? f.id,
          content: `${f.subject_type}:${f.subject_id ?? '-'} ${f.predicate} = ${f.object_value}`,
          priority: Math.round(f.confidence * 10),
          isProtected: true,
        });
      }
      for (const c of p.repos.chapters.listByStatus(bookId, 'COMMITTED')) {
        if (!c.summary || c.chapter_number >= chapter.chapter_number) continue;
        slots.topMemory!.push({
          id: `summary_${c.chapter_number}`,
          sourceType: 'SUMMARY',
          sourceRef: c.body_path ?? `chapters/${c.chapter_number}.md`,
          content: `第 ${c.chapter_number} 章摘要：${c.summary}`,
          priority: c.chapter_number,
        });
      }
    }

    const assembled = engine.assemble({
      budget: { inputTokens: 128_000, outputReserveTokens: 16_000, protectedMaxTokens: 64_000 },
      slots,
    });

    // 2) Planner：结构化输出 + 语义自我修复
    const planner = new Planner({
      structured: (req) => p.runtime!.plannerStructured(req),
      logger: logger.child('planner'),
    });

    const prevSummary = p.repos.chapters
      .listByStatus(bookId ?? '', 'COMMITTED')
      .filter((c) => c.chapter_number < chapter.chapter_number)
      .sort((a, b) => b.chapter_number - a.chapter_number)[0]?.summary;

    const res = await planner.plan({
      chapterNumber: chapter.chapter_number,
      contextText: assembled.text,
      ...(prevSummary ? { previousSummary: prevSummary } : {}),
      ...(params.userInstruction ? { userInstruction: params.userInstruction } : {}),
    });

    if (!res.ok || !res.plan) {
      return {
        ok: false,
        attempts: res.attempts,
        issues: res.issues ?? [],
        error: res.error ?? { code: ErrorCode.MODEL_STRUCTURED_EMPTY, message: '规划失败' },
        contextTokens: assembled.report.totalTokens,
      };
    }

    // 3) 落库（经 chapter.plan 工具，受权限与 schema 双重校验）
    const saved = await p.tools.invoke(
      'chapter.plan',
      { chapterId: chapter.id, plan: res.plan },
      toolContext('ADMIN'),
    );

    return {
      ok: saved.ok,
      attempts: res.attempts,
      issues: res.issues ?? [],
      contextTokens: assembled.report.totalTokens,
      brief: res.plan.brief,
      scenes: res.plan.scenes.map((sc) => ({ sceneId: sc.sceneId, purpose: sc.purpose })),
      saveResult: saved.ok ? saved.data : null,
      ...(saved.ok ? {} : { saveError: saved.error }),
    };
  },

  /** 读取已保存的章节计划（UI 展示） */
  'planner.getPlan': (params: { chapterId: string }) => {
    const p = requireProject();
    const plan = p.repos.chapters.readPlan<unknown>(params.chapterId);
    return { chapterId: params.chapterId, hasPlan: plan !== null, plan };
  },

  /** 读取工作区快照（UI 展示用） */
  'writer.workspace': (params: { chapterId: string }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.get(params.chapterId);
    const ws = new ChapterWorkspace({
      rootDir: p.dir,
      chapterNumber: chapter.chapter_number,
      logger: logger.child('workspace'),
    });
    return ws.snapshot();
  },

  /**
   * 按已保存的计划生成草稿（STEP 7）。
   *
   * ⚠ 产物只进工作区：正文写 workspace/chapter-NNN/draft.md，
   *   正式章节与 Canon 都不会被碰（§9.1）。真正的迁移在 STEP 11 的 Commit。
   */
  'writer.draft': async (params: { chapterId: string; wordsPerScene?: number }) => {
    const p = requireProject();
    if (!p.runtime) {
      throw new AppError(ErrorCode.MODEL_AUTH_FAILED, '尚未配置模型，无法生成正文');
    }
    const chapter = p.repos.chapters.get(params.chapterId);
    const plan = p.repos.chapters.readPlan<unknown>(params.chapterId);
    if (plan === null) {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '该章节还没有计划，请先规划');
    }

    const workspace = new ChapterWorkspace({
      rootDir: p.dir,
      chapterNumber: chapter.chapter_number,
      logger: logger.child('workspace'),
    });
    workspace.ensure();

    const writer = new Writer({
      complete: (req) => p.runtime!.completeText('writer', req),
      workspace,
      logger: logger.child('writer'),
      ...(params.wordsPerScene ? { wordsPerScene: params.wordsPerScene } : {}),
    });

    const res = await writer.draft(plan as never);
    if (!res.ok) {
      return {
        ok: false,
        failedSceneIndex: res.failedSceneIndex ?? null,
        error: res.error ?? { code: ErrorCode.MODEL_TIMEOUT, message: '生成失败' },
      };
    }

    const d = res.draft!;
    return {
      ok: true,
      chapterNumber: d.chapterNumber,
      sceneCount: d.scenes.length,
      totalChars: d.totalChars,
      usage: d.usage,
      draftPath: d.draftPath,
      preview: d.text.slice(0, 300),
      // 本次生成只进工作区 —— 明确回报，避免误解为已落库
      committed: false,
    };
  },

  /**
   * 一致性检查（STEP 8）。
   *
   * 读工作区草稿 + 已保存计划 → 与 Canon 对账。
   * ⚠ 纯只读：不修改草稿、不写库。修复是后续步骤的职责。
   */
  'continuity.check': (params: { chapterId: string }) => {
    const p = requireProject();
    const projectId = p.repos.projects.list()[0]?.id;
    const bookId = projectId ? p.repos.books.listByProject(projectId)[0]?.id : undefined;
    if (!bookId) {
      throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, '当前项目还没有书');
    }
    const chapter = p.repos.chapters.get(params.chapterId);

    const ws = new ChapterWorkspace({
      rootDir: p.dir,
      chapterNumber: chapter.chapter_number,
      logger: logger.child('workspace'),
    });
    const draft = ws.readText('draft');
    if (draft === null) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `第 ${chapter.chapter_number} 章还没有草稿 —— 请先点「生成草稿」`,
      );
    }

    const plan = p.repos.chapters.readPlan<unknown>(params.chapterId);
    const checker = new ContinuityChecker({
      repos: p.repos,
      logger: logger.child('continuity'),
      bookId,
    });
    const report = checker.check({
      chapterNumber: chapter.chapter_number,
      draftText: draft,
      ...(plan !== null ? { plan: plan as never } : {}),
    });

    return {
      chapterNumber: report.chapterNumber,
      ok: report.ok,
      blockingCount: report.blockingCount,
      warningCount: report.warningCount,
      checked: report.checked,
      issues: report.issues.map((i) => ({
        code: i.code,
        dimension: i.dimension,
        severity: i.severity,
        message: i.message,
        sourceRef: i.sourceRef,
      })),
      // 明确回报"未修改任何数据"，避免误解为已自动修复
      mutated: false,
    };
  },

  /**
   * 审阅当前章（STEP 8）。
   *
   * 链路：确定性检查（Continuity Checker）→ 模型审阅 → 合并 → 落库。
   * ⚠ 状态由 issues 机械推导，不采信模型填的 overallStatus。
   */
  'review.run': async (params: { chapterId: string }) => {
    const p = requireProject();
    const projectId = p.repos.projects.list()[0]?.id;
    const bookId = projectId ? p.repos.books.listByProject(projectId)[0]?.id : undefined;
    if (!bookId) throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, '当前项目还没有书');

    const chapter = p.repos.chapters.get(params.chapterId);
    const ws = new ChapterWorkspace({
      rootDir: p.dir,
      chapterNumber: chapter.chapter_number,
      logger: logger.child('workspace'),
    });
    const draft = ws.readText('draft');
    if (draft === null) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `第 ${chapter.chapter_number} 章还没有草稿 —— 请先点「生成草稿」`,
      );
    }

    // 1) 确定性检查（不需要模型，结论可直接采信）
    const checker = new ContinuityChecker({
      repos: p.repos,
      logger: logger.child('continuity'),
      bookId,
    });
    const plan = p.repos.chapters.readPlan<unknown>(params.chapterId);
    const cReport = checker.check({
      chapterNumber: chapter.chapter_number,
      draftText: draft,
      ...(plan !== null ? { plan: plan as never } : {}),
    });
    const deterministic: ReviewIssue[] = cReport.issues.map((i) => ({
      id: i.id,
      severity: i.severity === 'BLOCKING' ? 'BLOCKING' : 'MAJOR',
      category: 'CONTINUITY' as const,
      claim: i.message,
      evidence: [i.sourceRef],
      suggestions: [],
    }));

    // 2) 模型审阅（需要配模型才有）
    let modelNote = '';
    if (!p.runtime) {
      modelNote = '（未配置模型，本次仅做确定性检查）';
    }
    const reviewer = new Reviewer({
      structured: p.runtime
        ? (req) => p.runtime!.structured('reviewer', req)
        : async () => ({
            ok: false as const,
            error: { code: ErrorCode.MODEL_AUTH_FAILED, message: '尚未配置模型' },
            attempts: 0,
            usedFallback: false,
          }),
      logger: logger.child('reviewer'),
    });

    const review = await reviewer.review({
      chapterNumber: chapter.chapter_number,
      draftText: draft,
      contextText: '',
      deterministicIssues: deterministic,
    });

    // 3) 落库（经 review.run 工具，受 schema 校验）
    const saved = await p.tools.invoke(
      'review.run',
      { chapterId: chapter.id, review: { overallStatus: review.status, issues: review.issues } },
      toolContext('ADMIN'),
    );

    return {
      ok: review.ok,
      modelOk: review.modelOk,
      status: review.status,
      canCommit: review.canCommit,
      issueCount: review.issues.length,
      blockingCount: review.summary.bySeverity.BLOCKING,
      bySeverity: review.summary.bySeverity,
      byCategory: review.summary.byCategory,
      issues: review.issues.map((i) => ({
        id: i.id,
        severity: i.severity,
        category: i.category,
        claim: i.claim,
        evidence: i.evidence,
      })),
      deterministicChecked: cReport.checked,
      modelNote,
      saved: saved.ok ? saved.data : null,
      ...(saved.ok ? {} : { saveError: saved.error }),
    };
  },

  /** 读取已保存的审阅结果 + 门禁判定 */
  'review.get': (params: { chapterId: string }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.get(params.chapterId);
    const review = p.repos.chapters.readReview<unknown>(params.chapterId);
    return {
      chapterId: chapter.id,
      review,
      reviewStatus: chapter.review_status ?? null,
      hasBlocking: p.repos.chapters.hasBlockingReview(params.chapterId),
      canCommit: !p.repos.chapters.hasBlockingReview(params.chapterId),
    };
  },

  /**
   * 迁移门禁预检（STEP 8）：告诉 UI「现在还差什么才能提交」。
   * ⚠ 只判断，不执行迁⟪HERMES-CONTEXT-COMPRESSION: 452 of 652 chars omitted here by Hermes's context compressor. This is NOT part of the original tool call and must never be reproduced in new output — always write full, never truncate.⟫

  /** 各槽位规格与默认预算（UI 展示与调参用） */
  'context.slots': () => {
    const engine = new ContextEngine({ logger: logger.child('context') });
    return {
      slots: engine.slotSpecs().map((s) => ({
        name: s.name,
        isProtected: s.isProtected,
        budgetTokens: s.budgetTokens,
        fillPolicy: s.fillPolicy,
        description: s.description,
      })),
    };
  },

  /**
   * 用真实数据装配一次上下文（STEP 5 的端到端验证入口）。
   *
   * 数据来源：受保护的 Canon 来自真实 facts 表，记忆来自章节摘要。
   * 这样可以直观看到「Protected 超预算会报错」与「无来源条目被拒」。
   */
  'context.assemble': (params: { budget?: { inputTokens?: number; outputReserveTokens?: number; protectedMaxTokens?: number } }) => {
    const p = requireProject();
    const bookId = p.repos.projects.list()[0]?.id
      ? p.repos.books.listByProject(p.repos.projects.list()[0]!.id)[0]?.id
      : undefined;

    const canonEntries: ContextEntry[] = [];
    const memoryEntries: ContextEntry[] = [];

    if (bookId) {
      // 受保护 Canon：已确认为 CANON 的事实（含来源引用 —— §11 要求）
      for (const f of p.repos.facts.listByStatus(bookId, 'CANON').slice(0, 50)) {
        canonEntries.push({
          id: f.id,
          sourceType: 'FACT',
          sourceRef: f.evidence_id ?? f.id, // 有证据用证据，否则用事实自身 ID（仍可追溯）
          content: `${f.subject_type}:${f.subject_id ?? '-'} ${f.predicate} = ${f.object_value}`,
          priority: Math.round(f.confidence * 10),
          isProtected: true, // 已是 CANON，属 §12.2 的受保护内容
        });
      }

      // 可裁剪记忆：章节摘要
      for (const c of p.repos.chapters.listByStatus(bookId, 'COMMITTED')) {
        if (!c.summary) continue;
        memoryEntries.push({
          id: `summary_${c.chapter_number}`,
          sourceType: 'SUMMARY',
          sourceRef: c.body_path ?? `chapters/${c.chapter_number}.md`,
          content: `第 ${c.chapter_number} 章摘要：${c.summary}`,
          priority: c.chapter_number, // 越新越优先
        });
      }
    }

    const engine = new ContextEngine({ logger: logger.child('context') });
    const budget = {
      inputTokens: params.budget?.inputTokens ?? 128_000,
      outputReserveTokens: params.budget?.outputReserveTokens ?? 16_000,
      protectedMaxTokens: params.budget?.protectedMaxTokens ?? 32_000,
    };

    const slots: Partial<Record<SlotName, ContextEntry[]>> = {
      system: [
        {
          id: 'sys_identity',
          sourceType: 'PROFILE',
          sourceRef: 'system/identity.md',
          content: '你是长篇小说写作助手。Canon 是事实来源，不确定时不要自行创造。',
          priority: 100,
          isProtected: true,
        },
      ],
      protectedCanon: canonEntries,
      topMemory: memoryEntries,
    };

    const assembled = engine.assemble({ budget, slots });

    return {
      ok: true,
      budget,
      report: assembled.report,
      textPreview: assembled.text.slice(0, 1200),
      textTokens: conservativeTokenCounter.estimate(assembled.text),
      counts: {
        canon: canonEntries.length,
        memory: memoryEntries.length,
      },
    };
  },

  /**
   * 演示「Protected 超预算」与「无来源条目」如何被拒绝。
   *
   * 这两个是 §5 的核心约束，做成可点击的演示比写在文档里更有说服力。
   */
  'context.demoRejection': (params: { kind: 'overBudget' | 'rootless' }) => {
    const engine = new ContextEngine({ logger: logger.child('context') });
    const baseBudget = { inputTokens: 100_000, outputReserveTokens: 1_000, protectedMaxTokens: 50_000 };

    try {
      if (params.kind === 'overBudget') {
        engine.assemble({
          budget: { ...baseBudget },
          slots: {
            protectedCanon: [
              {
                id: 'huge',
                sourceType: 'FACT',
                sourceRef: 'fact_huge',
                content: '字'.repeat(20_000), // 超过 protectedCanon 默认 16000 预算
                priority: 1,
                isProtected: true,
              },
            ],
          },
        });
      } else {
        engine.assemble({
          budget: { ...baseBudget },
          slots: {
            topMemory: [
              {
                id: 'ghost',
                sourceType: 'MEMORY',
                sourceRef: '', // 无来源 → 必须被拒
                content: '一条没有来源的记忆',
                priority: 1,
              },
            ],
          },
        });
      }
      return { ok: false, error: { code: 'UNEXPECTED_PASS', message: '预期被拒绝，但装配成功了' } };
    } catch (err) {
      const e = AppError.from(err);
      return { ok: true, rejected: true, error: { code: e.code, message: e.message, details: e.details } };
    }
  },

  /**
   * 迁移门禁预检（STEP 8）：告诉 UI「还差什么才能提交」。
   * ⚠ 只判断，不执行迁移 —— 执行由 WorkflowEngine 负责。
   */
  'gate.check': (params: { chapterId: string; from?: string; to?: string }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.get(params.chapterId);
    const ws = new ChapterWorkspace({
      rootDir: p.dir,
      chapterNumber: chapter.chapter_number,
      logger: logger.child('workspace'),
    });
    const gate = new TransitionGate({
      repos: p.repos,
      logger: logger.child('gate'),
      hasDraft: () => ws.has('draft'),
    });
    const from = (params.from ?? chapter.status) as never;
    const to = (params.to ?? 'COMMITTING') as never;
    return { chapterId: chapter.id, from, to, ...gate.check({ chapterId: chapter.id, from, to }) };
  },

  /**
   * 从当前章草稿抽取事实候选（STEP 9）。
   *
   * ⚠ **只 propose，不写库**：产物落工作区 proposed_facts.json。
   *   真正入库由 canon.promote 触发，且必须经过 evidence 校验。
   */
  'canon.extract': async (params: { chapterId: string }) => {
    const p = requireProject();
    if (!p.runtime) {
      throw new AppError(ErrorCode.MODEL_AUTH_FAILED, '尚未配置模型，无法抽取事实');
    }
    const projectId = p.repos.projects.list()[0]?.id;
    const bookId = projectId ? p.repos.books.listByProject(projectId)[0]?.id : undefined;
    if (!bookId) throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, '当前项目还没有书');

    const chapter = p.repos.chapters.get(params.chapterId);
    const ws = new ChapterWorkspace({
      rootDir: p.dir,
      chapterNumber: chapter.chapter_number,
      logger: logger.child('workspace'),
    });
    const draft = ws.readText('draft');
    if (draft === null) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `第 ${chapter.chapter_number} 章还没有草稿 —— 请先点「生成草稿」`,
      );
    }

    const chars = p.repos.characters
      .listByBook(bookId)
      .map((c) => ({ id: c.id, name: c.name, aliases: [] as string[] }));
    const existingCanon = p.repos.facts.listByStatus(bookId, 'CANON').map((f) => {
      const sub = p.repos.characters.listByBook(bookId).find((c) => c.id === f.subject_id);
      return {
        id: f.id,
        subjectName: sub?.name ?? f.subject_id ?? '未知',
        predicate: f.predicate,
        objectValue: f.object_value,
      };
    });

    const extractor = new FactExtractor({
      // 槽位选 utility：抽取是「结构化小任务」，不需要写作级模型（§54 任务路由）
      structured: (req) => p.runtime!.structured('utility', req),
      logger: logger.child('extractor'),
      bookId,
      characters: chars,
      // 没登记的角色也允许抽出（否则新角色首次出场的事实全丢）
      allowUnresolvedSubject: true,
    });

    const res = await extractor.extract({
      chapterNumber: chapter.chapter_number,
      draftText: draft,
      existingCanon,
    });

    // 成功时落盘工作区（不写库）
    if (res.ok && res.proposed.length > 0) {
      ws.writeJson('proposedFacts', {
        chapterNumber: chapter.chapter_number,
        generatedAt: new Date().toISOString(),
        facts: res.proposed,
        conflicts: res.conflicts,
      });
    }

    return {
      ok: res.ok,
      proposedCount: res.proposed.length,
      rejectedCount: res.rejected.length,
      conflictCount: res.conflicts.length,
      facts: res.proposed.map((f) => ({
        id: f.id,
        subjectName: f.subjectName,
        predicate: f.predicate,
        objectValue: f.objectValue,
        confidence: f.confidence,
        isDefining: f.isDefining,
        quote: f.quote,
      })),
      rejected: res.rejected.slice(0, 5).map((r) => ({
        predicate: r.fact.predicate,
        reason: r.reason,
      })),
      conflicts: res.conflicts.map((c) => ({
        predicate: c.fact.predicate,
        incoming: c.fact.objectValue,
        existing: c.existingValue,
      })),
      // 明确回报"未写入事实库"
      persisted: false,
      error: res.error ?? null,
    };
  },

  /** 把工作区的候选事实提升入库（STEP 9）—— 这是唯一写 facts 的入口 */
  'canon.promote': async (params: { chapterId: string }) => {
    const p = requireProject();
    const projectId = p.repos.projects.list()[0]?.id;
    const bookId = projectId ? p.repos.books.listByProject(projectId)[0]?.id : undefined;
    if (!bookId) throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, '当前项目还没有书');

    const chapter = p.repos.chapters.get(params.chapterId);
    const ws = new ChapterWorkspace({
      rootDir: p.dir,
      chapterNumber: chapter.chapter_number,
      logger: logger.child('workspace'),
    });
    const saved = ws.readJson<{ facts: never[] }>('proposedFacts');
    if (saved === null || saved.facts.length === 0) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        '工作区中没有候选事实 —— 请先点「抽取事实」',
      );
    }
    const draft = ws.readText('draft') ?? '';

    const promoter = new CanonPromoter({
      repos: p.repos,
      logger: logger.child('promoter'),
      bookId,
    });
    const report = promoter.promote(saved.facts, {
      draftText: draft,
      sourceRef: `chapters/${String(chapter.chapter_number).padStart(3, '0')}.md`,
    });

    return {
      canonCount: report.canonCount,
      provisionalCount: report.provisionalCount,
      contradictedCount: report.contradictedCount,
      skippedCount: report.skippedCount,
      outcomes: report.outcomes.map((o) => ({
        predicate: o.predicate,
        status: o.status,
        reason: o.reason,
      })),
    };
  },

  /** 列出当前 Canon 与待裁决项（STEP 9 UI） */
  'canon.list': () => {
    const p = requireProject();
    const projectId = p.repos.projects.list()[0]?.id;
    const bookId = projectId ? p.repos.books.listByProject(projectId)[0]?.id : undefined;
    if (!bookId) return { canon: [], provisional: [], contradicted: [], conflicts: [] };

    const chars = p.repos.characters.listByBook(bookId);
    const nameOf = (id: string | null) => chars.find((c) => c.id === id)?.name ?? '—';
    const map = (f: { id: string; subject_id: string | null; predicate: string; object_value: string }) => ({
      id: f.id,
      subject: nameOf(f.subject_id),
      predicate: f.predicate,
      objectValue: f.object_value,
    });

    return {
      canon: p.repos.facts.listByStatus(bookId, 'CANON').map(map),
      provisional: p.repos.facts.listByStatus(bookId, 'PROVISIONAL').map(map),
      contradicted: p.repos.facts.listByStatus(bookId, 'CONTRADICTED').map(map),
      conflicts: p.repos.facts.findCanonConflicts(bookId),
    };
  },

  /**
   * 提交预检（STEP 11）：走 workspace.proposeCommit 工具。
   * ⚠ 只读，不写任何东西。
   */
  'commit.propose': async (params: { chapterId: string }) => {
    const p = requireProject();
    const r = await p.tools.invoke('workspace.proposeCommit', { chapterId: params.chapterId }, toolContext('ADMIN'));
    if (!r.ok) throw new AppError(r.error.code as ErrorCodeValue, r.error.message, { details: r.error.details });
    return r.data;
  },

  /** 执行提交（STEP 11）—— 权限 COMMIT 级 */
  'commit.run': async (params: { chapterId: string; commitMode?: 'clean' | 'with_debt' }) => {
    const p = requireProject();
    const input: { chapterId: string; commitMode?: 'clean' | 'with_debt' } = {
      chapterId: params.chapterId,
    };
    if (params.commitMode) input.commitMode = params.commitMode;
    const r = await p.tools.invoke('workspace.commit', input, toolContext('ADMIN'));
    if (!r.ok) {
      // 提交失败是可预期结果（门禁/冲突），以数据返回而不是抛错，便于 UI 展示
      return { ok: false, error: { code: r.error.code, message: r.error.message } };
    }
    return r.data;
  },

  /** 启动恢复（STEP 11）：扫描未完成事务 */
  'commit.recover': async () => {
    const p = requireProject();
    const r = await p.tools.invoke('workspace.recover', {}, toolContext('ADMIN'));
    if (!r.ok) throw new AppError(r.error.code as ErrorCodeValue, r.error.message);
    return r.data;
  },

  /** 提交历史 */
  'commit.list': async (params: { chapterId?: string }) => {
    const p = requireProject();
    const input = params.chapterId ? { chapterId: params.chapterId } : {};
    const r = await p.tools.invoke('workspace.listCommits', input, toolContext('ADMIN'));
    if (!r.ok) throw new AppError(r.error.code as ErrorCodeValue, r.error.message);
    return r.data;
  },

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
  // bootstrap 阶段还没有项目目录，故不注册 commit 工具
  // （commit 工具在 project.open 时随 dir 一起注册）
  for (const tool of createAllTools(repos, { logger: logger.child('tools') })) {
      tools.register(tool);
    }
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
