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
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { Logger, AppError, ErrorCode, bookId, type ErrorCodeValue } from '@nwa/core';
import {
  CorpusRepository,
  Database,
  MIGRATIONS,
  canProcess,
  createRepositories,
  filterSkillsByGenre,
  normalizeGenre,
  type Repositories,
} from '@nwa/storage';
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
import { Planner, Writer, Reviewer, Reviser, SkillEngine } from '@nwa/writing';
import {
  ChapterWorkspace,
  ContinuityChecker,
  FactExtractor,
  CanonPromoter,
  exportProject,
  restoreBackup,
  rebuildFts,
  verifyExport,
} from '@nwa/story';
import {
  CommitEngine,
  SummaryIndexer,
  MemoryGatherer,
  SummaryGenerator,
  WorkflowEngine,
  WorkflowRepository,
  createNovelWorkflowStages,
  stageOrdinals,
  summarizeStages,
} from '@nwa/harness';
import { createWorkflowServices, type WorkflowModel } from './workflow-services.js';
import {
  PatternMiner,
  PatternStore,
  SceneAnnotator,
  ScenePersister,
  SkillCompiler,
  SkillStore,
  analyzeCrossWork,
  corpusOverview,
  documentChaptersDir,
  importCorpusFile,
  planDeprecations,
  segmentScenes,
} from '@nwa/distillation';
import type { CorpusSceneRow, SkillRow } from '@nwa/storage';
import { FtsIndex } from '@nwa/storage';
import { bigramTokenizer, Retriever, buildMatchExpression } from '@nwa/retrieval';
import type { ReviewIssue } from '@nwa/shared';
import { TransitionGate, RetrievalService } from '@nwa/harness';
import { StateProposalRepository, TimelineService } from '@nwa/story';
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
  /** FTS 索引器（补缺口：检索可用） */
  readonly fts: FtsIndex;
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

/**
 * 用户级模型配置的规范位置。
 *
 * ⚠ 为什么需要它：`models.json` 目前放在项目目录下，但**模型配置是
 *   用户级的**（换个项目不会换模型）。这带来一个真实问题：
 *   隔离目录（验证脚本用的 `NWA_PROJECTS_ROOT`）里没有 models.json，
 *   于是 `buildRuntime` 返回 null、`agentReady=false`，所有需要模型的
 *   功能静默不可用。实测踩到。
 *
 * 因此读取时按顺序尝试：项目目录 → 用户规范位置。
 * 写入仍写入项目目录（保持既有行为不变）。
 */
function userModelsConfigPath(): string {
  // 允许覆盖：GUI 结构验证需要"无模型"的环境，避免为了测界面而真实调用 LLM
  // （实测踩到：隔离目录仍回退到用户真实配置，导致界面验证消耗真实配额、
  //   且 poll 窗口不够长而假失败）
  return process.env['NWA_USER_MODELS_PATH'] ?? join(homedir(), 'NovelWriterProjects', 'models.json');
}

function loadModelsConfig(dir: string): ModelsConfig | null {
  // 项目目录优先；找不到则回退到用户级位置
  const candidates = [modelsConfigPath(dir)];
  const userPath = userModelsConfigPath();
  if (userPath !== candidates[0]) candidates.push(userPath);

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as ModelsConfig;
      if (raw && typeof raw === 'object' && Array.isArray(raw.profiles) && raw.profiles.length > 0) {
        return raw;
      }
    } catch (err) {
      logger.warn('models.json 解析失败，尝试下一个位置', { path: p, error: String(err) });
    }
  }
  return null;
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

/** 汇总类型隔离的排除原因（按原因分组计数） */
function summarizeReasons(
  excluded: readonly { readonly reason: string }[],
): { reason: string; count: number }[] {
  const m = new Map<string, number>();
  for (const e of excluded) m.set(e.reason, (m.get(e.reason) ?? 0) + 1);
  return [...m.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function requireProject(): OpenProject {
  if (!opened) {
    throw new AppError(ErrorCode.WORKSPACE_CORRUPTED, '尚未打开项目');
  }
  return opened;
}

/**
 * ⚠ 语料库（NDE 知识来源）**独立于创作项目**。
 *
 * ## 为什么不能复用 `opened.repos.corpus`
 *
 * 创作项目的库是"这本书的数据"；语料库是"所有参考作品的共享知识"。
 * 两者生命周期完全不同：
 *   - 项目库随项目创建/删除
 *   - 语料库跨项目长期存在（用户导入一次，所有书共用）
 *
 * 实测踩坑：`annotate.progress` 用项目库查询 → 永远返回 0 条，
 * 因为语料文档根本不在项目库里。
 *
 * ## 路径
 *
 * 默认 `C:/Users/zw/NovelWriterCorpus/corpus.db`，可用
 * `NWA_CORPUS_ROOT` 覆盖（验证脚本用）。
 */
let corpusHandle: { db: Database; repo: CorpusRepository } | null = null;

function corpusRoot(): string {
  return process.env['NWA_CORPUS_ROOT'] ?? 'C:/Users/zw/NovelWriterCorpus';
}

function corpusRepo(): CorpusRepository {
  if (!corpusHandle) {
    const dbPath = join(corpusRoot(), 'corpus.db');

    // ⚠ **不存在就创建**，而不是报错。
    //
    //   原实现遇到不存在的库直接抛错，理由是"先导入语料"—— 但这就成了
    //   死循环：**导入语料正是要往这个库里写**。全新安装的用户第一次
    //   点「导入」必然失败，报"语料库不存在，请先导入语料"。
    //
    //   实测：verify:corpus-import 在干净沙盒里第一步就撞上这个。
    //   这与"首次使用无法创建项目"是同一类问题 —— 初始化路径不能
    //   依赖已经初始化完成。
    //
    //   `Database` 构造会跑迁移（migrate），因此首次创建即得到完整表结构。
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database({ path: dbPath, migrations: MIGRATIONS });
    corpusHandle = { db, repo: new CorpusRepository(db) };
    logger.info(existsSync(dbPath) ? '已打开语料库' : '已创建语料库', { path: dbPath });
  }
  return corpusHandle.repo;
}


/**
 * ⚠ 解析**目标书**（多书隔离的唯一入口）。
 *
 * ## 为什么必须有这个函数
 *
 * 曾经有 10 处写操作写成 `books.listByProject(pid)[0]?.id` —— 而
 * `listByProject` 按 `created_at` 排序，`[0]` 是**最老的那本**。
 * 后果（真实事故）：
 *   - 「新建章节」永远加到旧书上，用户看不到变化 → 再建一本 → 24 本同名书
 *   - Planner/Writer 装配上下文时取的是最老那本的 facts/摘要 →
 *     **A 书的设定污染 B 书的正文**
 *
 * 因此这里要求**显式传 bookId**；只有调用方确实没传时才回退，
 * 且回退目标是**最近创建的书**（`listByProject` 的最后一个），
 * 而不是最老的那本。
 *
 * @param explicit 调用方指定的 bookId（优先）
 */
/**
 * 严格版 `resolveBookId`：解析不到就**明确报错**。
 *
 * ⚠ 为什么需要它：`resolveBookId()` 在没有任何书时返回 `undefined`，
 *   而 `undefined ?? ''` 会静默变成空字符串 —— 后续查询按 `book_id = ''`
 *   过滤，返回 0 条。调用方看到的是"这本书没有时间线事件"，
 *   而不是"还没选书"。两者要采取的行动完全不同。
 */
function requireBookId(explicit?: string | null): string {
  const id = resolveBookId(explicit);
  if (!id) {
    throw new AppError(
      ErrorCode.TOOL_VALIDATION_ERROR,
      '未指定书目，且当前项目里没有可用的书 —— 请先创建或选择一本书',
    );
  }
  return id;
}

function resolveBookId(explicit?: string | null): string | undefined {
  const p = requireProject();
  if (explicit) {
    // 校验该书确实存在，避免把操作指向不存在的书
    const ok = p.repos.books.listByProject(p.repos.projects.list()[0]?.id ?? '').some((b) => b.id === explicit);
    if (ok) return explicit;
    throw new AppError(
      ErrorCode.TOOL_VALIDATION_ERROR,
      `指定的书目不存在：${explicit} —— 请先在左栏选择书目`,
    );
  }
  // 未指定：回退到**最近创建**的书（不是最老的）
  const pid = p.repos.projects.list()[0]?.id;
  if (!pid) return undefined;
  const books = p.repos.books.listByProject(pid);
  return books.length > 0 ? books[books.length - 1]!.id : undefined;
}


/** 项目根目录：用户可见、可检查（§0.1「文件和数据库可检查」） */
/**
 * 项目根目录。
 *
 * ⚠ 支持环境变量覆盖（`NWA_PROJECTS_ROOT`）—— 这是**测试隔离**的必需品。
 *
 * 实测踩到：验证脚本（verify-gui / verify-writing）走真实 IPC，
 * 而 IPC 又用这个常量，于是每次验证都往用户的**真实项目**里写数据。
 * 结果是 24 本重名的「测试小说」和 23 个重复的「第1章」。
 * 验证脚本污染用户数据是不可接受的 —— 因此必须可隔离。
 */
const PROJECTS_ROOT = process.env['NWA_PROJECTS_ROOT'] ?? join(homedir(), 'NovelWriterProjects');

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
/**
 * ── Novel Workflow（P0-1 / P0-2）──
 *
 * ## 为什么 workflow 实例按工作流缓存
 *
 * `WorkflowEngine` 持有内存里的 AbortController 与暂停标志（运行时缓存）。
 * 但**权威状态在数据库**（`workflows.status`）—— 所以即使这里缓存丢失
 * （进程重启），`workflow.resume` 仍能从库里恢复。
 *
 * 缓存的作用只是"同一进程内 pause 能打断正在跑的 stage"。
 */
const workflowEngines = new Map<string, WorkflowEngine>();

function buildWorkflowEngine(p: OpenProject): WorkflowEngine {
  const repo = new WorkflowRepository(p.db, logger.child('workflow-repo'));
  const engine = new WorkflowEngine({
    repo,
    events: p.events,
    logger: logger.child('workflow'),
  });
  const model: WorkflowModel | null = p.runtime
    ? {
        plannerStructured: (req) => p.runtime!.plannerStructured(req as never),
        structured: (slot, req) => p.runtime!.structured(slot as never, req as never),
        completeText: (slot, req) => p.runtime!.completeText(slot as never, req as never),
      }
    : null;

  engine.registerAll(
    createNovelWorkflowStages(
      createWorkflowServices({
        dir: p.dir,
        db: p.db,
        repos: p.repos,
        tools: p.tools,
        logger,
        runtime: model,
        loadSkills: () => {
          try {
            const rows = corpusRepo().listSkills();
            return { rows, genre: null };
          } catch {
            return { rows: [], genre: null };
          }
        },
        // ── 分层检索服务（P0-3）──────────────────────────
        //
        // ⚠ 构造失败时传 null，让各 stage 如实报告"检索层不可用" ——
        //   不是"没有相关记忆"。两者混淆会让模型以为史上没发生过
        //   相关的事，从而自行编造。
        retrieval: (() => {
          try {
            return new RetrievalService({
              db: p.db,
              logger: logger.child('retrieval'),
              // ⚠ 与索引侧同一分词口径（ADR-0004 的 bigram 补丁）
              buildMatch: (q) => buildMatchExpression(bigramTokenizer.query(q)),
              // 检索痕迹落库 —— 使「为什么这一章引用了那个旧章节」可回答
              recordTraces: (rows) => {
                try {
                  return new WorkflowRepository(p.db, logger.child('workflow')).addRetrievalTraces(rows);
                } catch (e) {
                  logger.warn('检索痕迹落库失败（不阻断）', {
                    error: e instanceof Error ? e.message : String(e),
                  });
                  return 0;
                }
              },
            });
          } catch (e) {
            logger.warn('检索服务构造失败：上下文将缺少长程记忆', {
              error: e instanceof Error ? e.message : String(e),
            });
            return null;
          }
        })(),
        commitChapter: async (input) => {
          // 复用既有 commit 路径（含 Manifest 对账与 Repair）
          const r = await handlers['commit.run']!({
            chapterId: input.chapterId,
            mode: input.params['mode'] ?? 'NORMAL',
          } as never);
          const rec = r as { manifestPath?: string; contentHash?: string; ok?: boolean };
          return {
            manifestPath: rec.manifestPath ?? '',
            contentHash: rec.contentHash ?? '',
            committed: rec.ok !== false,
          };
        },
      }),
    ),
  );
  return engine;
}

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
  'project.open': (params: { dir?: string; rootDir?: string; name?: string }) => {
    // ⚠ `rootDir` 是**兼容别名**，必须接受。
    //
    //   实测事故：本方法只读 `params.dir`，而 8 个 verify 脚本传的是
    //   `rootDir` —— 参数被**静默忽略**，脚本以为在临时目录里跑，
    //   实际全部打开了用户的真实项目目录（`~/NovelWriterProjects`），
    //   往里面写测试书目/章节/导出物。
    //
    //   这是"声明了却不生效的参数"的又一次翻车（前例：maxGroups、
    //   detectProseIssues）。修法两条：
    //     1. 接受别名，让既有调用方立刻正确（而不是等它们逐个改）
    //     2. 两个都给且不一致时报错，不猜
    if (params.dir && params.rootDir && params.dir !== params.rootDir) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `dir 与 rootDir 不一致（${params.dir} vs ${params.rootDir}），拒绝猜测用哪个`,
      );
    }
    if (opened) {
      opened.db.close();
      opened = null;
    }
    const dir = params.dir ?? params.rootDir ?? PROJECTS_ROOT;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'project.db');

    const db = new Database({ path: dbPath, migrations: MIGRATIONS });
    const repos = createRepositories(db);
    const tools = new ToolRegistry(logger.child('tools'));
    // FTS 索引器（补缺口：检索可用）
    const fts = new FtsIndex({ db, tokenizer: bigramTokenizer, logger: logger.child('fts') });

    // ⚠ commit 工具需要项目目录（写 chapters/ 等），只能在 project.open 注册
    for (const tool of createAllTools(repos, {
      logger: logger.child('tools'),
      commit: {
        db,
        rootDir: dir,
        indexer: {
          indexChapter: (input) => {
            fts.indexChapter({
              chapterId: input.chapterId,
              bookId: resolveBookId() ?? '',
              chapterNumber: input.chapterNumber,
              sourceRef: input.sourceRef,
              text: input.body,
            });
          },
        },
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
    const project: OpenProject = { dir, db, repos, tools, events, runtime: null, fts };
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

    // ⚠ 必须用**本章所属的书**，不能取"第一本书" ——
    //   否则 A 书的 Canon/摘要会进入 B 书的正文（跨书污染）。
    const bookId = chapter.book_id;
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
  'writer.draft': async (params: {
    chapterId: string;
    wordsPerScene?: number;
    /** 写什么类型的小说（技能检索的类型隔离依据，§21） */
    genre?: string | null;
    /** 最多注入几个技能（§25 默认 2~5） */
    maxSkills?: number;
    /** 是否允许 STYLE 技能（§21：默认 false） */
    allowStyle?: boolean;
  }) => {
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

    // ── §25 Skill Engine：把蒸馏出的技能接入 Writer ──
    //
    // ⚠ 技能库可能不存在（用户还没做蒸馏）—— 此时 Writer 照常工作。
    //   技能是**增强**不是前置依赖，所以这里容忍失败而不抛错。
    let skillEngine: SkillEngine | undefined;
    let skillRows: readonly SkillRow[] = [];
    const skillGenre: string | null = params.genre ?? null;
    try {
      const repo = corpusRepo();
      // 技能按类型隔离取用（§21）。未指定类型时取全部，
      // 让 filterSkillsByGenre 内部的规则决定（GENRE 技能需要同类型才命中）
      skillRows = repo.listSkills();
      skillEngine = new SkillEngine({
        maxSkills: params.maxSkills ?? 4,
        allowStyle: params.allowStyle ?? false,
      });
      logger.info('技能库已载入', { total: skillRows.length, genre: skillGenre });
    } catch (e) {
      logger.warn('技能库不可用（本次不注入技能）', {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    const writer = new Writer({
      complete: (req) => p.runtime!.completeText('writer', req),
      workspace,
      logger: logger.child('writer'),
      ...(params.wordsPerScene ? { wordsPerScene: params.wordsPerScene } : {}),
      ...(skillEngine ? { skillEngine } : {}),
      skillRows,
      genre: skillGenre,
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
  'continuity.check': (params: { bookId?: string | null; chapterId: string }) => {
    const p = requireProject();
    // ⚠ 用本章所属的书（chapter.book_id），不用"当前书" —— 防跨书污染
    const chapter = p.repos.chapters.get(params.chapterId);
    const bookId = chapter.book_id;

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
  'review.run': async (params: { bookId?: string | null; chapterId: string }) => {
    const p = requireProject();
    // ⚠ 用本章所属的书（chapter.book_id），不用"当前书" —— 防跨书污染
    const chapter = p.repos.chapters.get(params.chapterId);
    const bookId = chapter.book_id;
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

  /**
   * 按审稿问题定向改稿（补缺口）。
   *
   * ⚠ 写 revision.md，**不覆盖 draft.md** —— 改坏了要能退回去。
   * ⚠ 改完**不自动通过**：必须重新审稿（改稿可能引入新问题），
   *   由门禁决定能否提交。
   */
  'revision.run': async (params: { chapterId: string; force?: boolean }) => {
    const p = requireProject();
    if (!p.runtime) {
      throw new AppError(ErrorCode.MODEL_AUTH_FAILED, '尚未配置模型，无法改稿');
    }
    const chapter = p.repos.chapters.get(params.chapterId);

    const ws = new ChapterWorkspace({
      rootDir: p.dir,
      chapterNumber: chapter.chapter_number,
      logger: logger.child('workspace'),
    });
    const draft = ws.readText('revision') ?? ws.readText('draft');
    if (draft === null) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `第 ${chapter.chapter_number} 章没有正文可改 —— 请先生成草稿`,
      );
    }

    // 取审稿结果作为改稿依据
    const review = p.repos.chapters.readReview<{ issues?: ReviewIssue[] }>(params.chapterId);
    const issues = review?.issues ?? [];
    if (issues.length === 0) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        '本章还没有审稿结果，无法确定要改什么 —— 请先点「审阅当前章」',
      );
    }

    // ⚠ 无阻塞问题时**拒绝改稿**（除非调用方显式要求）。
    //
    // 实测 6 次真实运行的数据：
    //   改稿前阻塞 0 → 改稿后阻塞 0：2 次
    //   改稿前阻塞 0 → 改稿后阻塞 1：4 次（**把好稿改坏了**）
    //
    // 也就是说"本来就能提交"时改稿是负收益：模型会顺手改掉没被指出的
    // 地方，引入新的矛盾；而复审只看新稿，**发现不了"这是改稿引入的"**。
    // 只有存在阻塞问题（稿子本来提交不了）时，这个风险才值得冒。
    const blocking = issues.filter((i) => i.severity === 'BLOCKING').length;
    if (blocking === 0 && params.force !== true) {
      return {
        ok: true,
        skipped: true,
        reason:
          `本章没有阻塞问题（${issues.length} 个非阻塞问题），无需改稿 —— ` +
          '改稿在"本来就能提交"时是负收益（实测 4/6 次把好稿改坏）。' +
          '若确要改写，请显式传 force=true。',
        appliedEdits: 0,
        rejectedEdits: 0,
        totalTargets: 0,
        resolved: 0,
        deltaChars: 0,
        totalChars: draft.length,
        passes: [],
        rolledBack: 0,
        outcomes: [],
        needsReReview: false,
      };
    }

    const reviser = new Reviser({
      // 改稿走结构化输出（替换指令），由 Reviser 程序化应用 ——
      // 这样模型无法触碰它没明确引用的文字（"改稿毁稿"的机制防线）
      structured: (req) => p.runtime!.structured('writer', req),
      workspace: ws,
      logger: logger.child('reviser'),
    });

    const res = await reviser.revise({
      chapterNumber: chapter.chapter_number,
      draftText: draft,
      issues,
    });

    if (!res.ok) {
      return { ok: false, error: res.error ?? { code: 'REVISION_FAILED', message: '改稿失败' } };
    }

    return {
      ok: true,
      appliedEdits: res.appliedEdits,
      rejectedEdits: res.rejectedEdits,
      totalTargets: res.outcomes.length,
      resolved: res.outcomes.filter((o) => o.applied).length,
      deltaChars: res.deltaChars ?? 0,
      totalChars: res.totalChars ?? 0,
      passes: res.passes.map((p2) => ({
        pass: p2.pass,
        appliedEdits: p2.appliedEdits,
        resolved: p2.resolved,
        attempted: p2.attempted,
      })),
      rolledBack: res.rolledBackGroups.length,
      outcomes: res.outcomes.map((o) => ({
        severity: o.severity,
        category: o.category,
        applied: o.applied,
        editCount: o.editCount,
        canonical: o.canonical ?? null,
        skippedReason: o.skippedReason ?? null,
      })),
      // ⚠ 改稿修不了时如实报出（需重新生成正文）
      needsRegeneration: res.needsRegeneration === true,
      regenerationReason: res.regenerationReason ?? null,
      // ⚠ 明确标注：改完必须重新审稿
      needsReReview: true,
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
  'context.assemble': (params: { bookId?: string | null; budget?: { inputTokens?: number; outputReserveTokens?: number; protectedMaxTokens?: number } }) => {
    const p = requireProject();
    const bookId = resolveBookId(params.bookId);

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
  'canon.extract': async (params: { bookId?: string | null; chapterId: string }) => {
    const p = requireProject();
    if (!p.runtime) {
      throw new AppError(ErrorCode.MODEL_AUTH_FAILED, '尚未配置模型，无法抽取事实');
    }
    // ⚠ 用本章所属的书（chapter.book_id），不用"当前书" —— 防跨书污染
    const chapter = p.repos.chapters.get(params.chapterId);
    const bookId = chapter.book_id;
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
  'canon.promote': async (params: { bookId?: string | null; chapterId: string }) => {
    const p = requireProject();
    // ⚠ 用本章所属的书（chapter.book_id），不用"当前书" —— 防跨书污染
    const chapter = p.repos.chapters.get(params.chapterId);
    const bookId = chapter.book_id;
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
  'canon.list': (params: { bookId?: string | null } = {}) => {
    const p = requireProject();
    const bookId = resolveBookId(params.bookId);
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

  /**
   * 场景切分（STEP 15，规则层，**不调用模型**）。
   *
   * ⚠ 只做规则切分，免费且确定 —— 用于先看切分质量，
   *   再决定是否值得花模型额度做语义标注。
   */
  'annotate.segment': (params: { text: string; minParagraphs?: number; maxParagraphs?: number }) => {
    const scenes = segmentScenes(params.text, {
      ...(params.minParagraphs !== undefined ? { minParagraphs: params.minParagraphs } : {}),
      ...(params.maxParagraphs !== undefined ? { maxParagraphs: params.maxParagraphs } : {}),
    });
    return {
      scenes: scenes.map((s) => ({
        index: s.index,
        paragraphCount: s.paragraphs.length,
        chars: s.paragraphs.reduce((n, p) => n + p.text.length, 0),
        reason: s.reason,
        evidence: s.evidence,
        uncertain: s.uncertain,
        firstParagraph: s.paragraphs[0]?.text.slice(0, 100) ?? '',
      })),
    };
  },

  /**
   * 场景语义标注（STEP 15，**调用真实模型**）。
   *
   * ⚠ 机械指标（pacing/prose）由代码算；语义字段由模型给。
   *   模型失败时该场景 annotated=false 且语义字段为空 ——
   *   **不填默认值**（否则模式挖掘会把伪造数据当统计事实）。
   */
  'annotate.scenes': async (params: {
    text: string;
    documentId: string;
    genre?: string | null;
    maxScenes?: number;
  }) => {
    const p = requireProject();
    if (!p.runtime) {
      throw new AppError(ErrorCode.MODEL_AUTH_FAILED, '尚未配置模型，无法做语义标注');
    }
    const annotator = new SceneAnnotator({
      logger: logger.child('annotate'),
      // 语义标注走 utility 槽位（与写作/审稿分开，避免占用创作额度）
      structured: (req) => p.runtime!.structured('utility', req),
    });
    const result = await annotator.annotateChapter({
      chapterNumber: null,
      text: params.text,
      documentId: params.documentId,
      ...(params.genre !== undefined ? { genre: params.genre } : {}),
    });

    const max = params.maxScenes ?? result.scenes.length;
    const scenes = result.scenes.slice(0, max).map((s) => ({
      sceneId: s.sceneId,
      sceneIndex: s.sceneIndex,
      paragraphCount: s.paragraphCount,
      chars: s.chars,
      boundaryReason: s.boundaryReason,
      boundaryEvidence: s.boundaryEvidence,
      boundaryUncertain: s.boundaryUncertain,
      text: s.text.slice(0, 400),
      annotation: s.annotation,
      annotated: s.annotated,
      annotationError: s.annotationError ?? null,
    }));

    return {
      sceneCount: result.sceneCount,
      annotatedCount: result.annotatedCount,
      unannotatedCount: result.unannotatedCount,
      uncertainBoundaries: result.uncertainBoundaries,
      scenes,
    };
  },

  /**
   * 场景标注**批量落库**（STEP 15 → STEP 16 的衔接）。
   *
   * ⚠ 逐章跑真实模型标注并落库。**会消耗模型额度** ——
   *   调用方应先用少量章节验证，再决定是否全量。
   */
  'annotate.persistDocument': async (params: {
    documentId: string;
    corpusRoot?: string;
    maxChapters?: number;
    onProgressEvery?: number;
    /** 跳过已标注章节（默认 true）—— 断点续跑 */
    skipAnnotated?: boolean;
  }) => {
    const p = requireProject();
    if (!p.runtime) {
      throw new AppError(ErrorCode.MODEL_AUTH_FAILED, '尚未配置模型，无法标注');
    }
    const root = params.corpusRoot ?? 'C:/Users/zw/NovelWriterCorpus';
    const doc = corpusRepo().get(params.documentId);

    // ⚠ §61 强制：许可不明的语料**不得进入自动处理链**。
    //
    //   实测发现：`canProcess` / `PROCESSABLE_USAGE` 定义在仓储层，
    //   但**全仓无任何调用** —— 也就是说"UNKNOWN 禁止进自动链"此前
    //   只写在文档与 register 的入参校验里，**运行时没有强制**。
    //   已登记为 RETRIEVAL_ONLY 的语料照样能被标注/挖掘/编译。
    //
    //   这里补上运行时闸门（这是"定义了却没接线"的第 5 次出现）。
    if (!canProcess(doc, 'DISTILLATION_ONLY')) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `语料「${doc.title}」的许可为 ${doc.allowed_usage}，不允许进入自动蒸馏链。` +
          '§61 要求：许可不明（UNKNOWN）或仅限检索的内容不得用于分析/蒸馏。' +
          '若你确认有权分析该文本，请重新导入并登记正确的许可。',
      );
    }

    // ⚠ 用集中提供的路径函数，不自己拼 —— 自己拼会与导入端不一致
    //   （实测 bug：导入写 <root>/<docId>/，标注读 <root>/documents/<docId>/）
    const chDir = documentChaptersDir(root, params.documentId);
    if (!existsSync(chDir)) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `未找到章节目录：${chDir}（语料是否已导入？）`,
      );
    }
    const files = readdirSync(chDir).filter((f) => f.endsWith('.md')).sort();
    const limit = params.maxChapters ?? files.length;
    const selected = files.slice(0, limit);

    // ⚠ 断点续跑：跳过已标注的章节。
    //
    //   全量标注 108 章耗时以十分钟计，任何中断（超时/网络/手动停）
    //   都不该让前 45 章白跑。判据是"该章**所有**场景都已落库且已标注" ——
    //   只按章号跳过会让"标注到一半中断的章"永远补不上。
    const repo0 = corpusRepo();
    const perChapter = new Map<number, { total: number; annotated: number }>();
    for (const r of repo0.listScenesByDocument(params.documentId)) {
      if (r.chapter_number === null) continue;
      const e = perChapter.get(r.chapter_number) ?? { total: 0, annotated: 0 };
      e.total++;
      if (r.annotated === 1) e.annotated++;
      perChapter.set(r.chapter_number, e);
    }
    // ⚠ 判据是"该章**所有**场景都已标注"，不是"有任一场景已标注"。
    //
    //   早先用 `r.annotated === 1` 判断 → 一章里只要有一个场景标成功，
    //   整章就被算作已完成 → **该章失败的场景永远不会重试**。
    //   实测《清纯校花》第 103/177/182/204/220/245 章就是这样被跳过的。
    const doneChapters = new Set<number>();
    for (const [ch, e] of perChapter) {
      if (e.total > 0 && e.annotated === e.total) doneChapters.add(ch);
    }
    const todo = selected
      .map((f, i) => ({ file: f, chapterNumber: i + 1 }))
      .filter((x) => !doneChapters.has(x.chapterNumber));

    if (params.skipAnnotated !== false && todo.length < selected.length) {
      logger.info('断点续跑：跳过已标注章节', {
        total: selected.length,
        skipped: selected.length - todo.length,
        remaining: todo.length,
      });
    }
    const effective = params.skipAnnotated === false ? selected.map((f, i) => ({ file: f, chapterNumber: i + 1 })) : todo;

    const annotator = new SceneAnnotator({
      logger: logger.child('annotate'),
      structured: (req) => p.runtime!.structured('utility', req),
    });
    const persister = new ScenePersister({
      repo: corpusRepo(),
      // ⚠ 与导入端同一根：ScenePersister 内部拼 documents/<id>/scenes
      corpusRoot: root,
      logger: logger.child('persist'),
    });

    const chapters = effective.map((x) => ({
      chapterNumber: x.chapterNumber,
      text: readFileSync(join(chDir, x.file), 'utf8'),
    }));

    // ⚠ 逐章进度日志：全量标注 108 章耗时以十分钟计，
    //   没有进度输出就无法判断"卡住了"还是"正常在跑"。
    const every = params.onProgressEvery ?? 1;
    let done = 0;
    let scenesSoFar = 0;
    let failedSoFar = 0;

    const summary = await persister.persistMany({
      documentId: params.documentId,
      genre: doc.genre,
      chapters,
      annotate: async (ch) => {
        const r = await annotator.annotateChapter({
          chapterNumber: ch.chapterNumber,
          text: ch.text,
          documentId: params.documentId,
          genre: doc.genre,
        });
        done++;
        scenesSoFar += r.sceneCount;
        failedSoFar += r.unannotatedCount;
        if (done % every === 0 || done === chapters.length) {
          logger.info(`标注进度 ${done}/${chapters.length}`, {
            chapter: ch.chapterNumber,
            scenes: r.sceneCount,
            totalScenes: scenesSoFar,
            failed: failedSoFar,
          });
        }
        return r;
      },
    });

    const progress = corpusRepo().annotationProgress(params.documentId);
    logger.info('标注落库完成', { ...summary, ...progress });
    return { ...summary, progress };
  },

  /**
   * 列出语料文档（含类型，供 UI 与验证脚本选择"写什么类型"）。
   *
   * ⚠ 类型归一化后返回，便于调用方按大类匹配（仙侠/修仙/修真 同类）。
   */
  'corpus.listDocuments': (params: { genre?: string | null } = {}) => {
    const repo = corpusRepo();
    const docs = params.genre
      ? repo.listProcessableByGenre(params.genre)
      : repo.listProcessable();
    return {
      documents: docs.map((d) => ({
        documentId: d.id,
        title: d.title,
        genre: d.genre,
        subgenre: d.subgenre ?? null,
        normalizedGenre: normalizeGenre(d.genre),
        allowedUsage: d.allowed_usage,
        hasSynopsis: Boolean(d.synopsis),
      })),
      /** 可用类型及文档数（供 UI 选择"我要写什么类型"） */
      genres: repo.listGenres(),
    };
  },

  /** 标注进度（如实报告未标注数，便于判断样本是否够用） */
  'annotate.progress': (params: { documentId?: string } = {}) => {
    const repo = corpusRepo();
    const docs = params.documentId ? [repo.get(params.documentId)] : repo.list();
    return {
      documents: docs.map((d) => ({
        documentId: d.id,
        title: d.title,
        genre: d.genre,
        ...repo.annotationProgress(d.id),
      })),
    };
  },

  /**
   * 场景功能分布（STEP 16 模式挖掘的基础统计）。
   *
   * ⚠ 只统计**已标注**场景 —— 未标注的语义字段为空，
   *   那是"没标注"而非"没有该功能"，混入会让统计失真。
   */
  'annotate.sceneFunctionStats': (params: { documentId?: string; genre?: string | null } = {}) => {
    const stats = corpusRepo().sceneFunctionStats(params.documentId);
    return { stats, total: stats.reduce((s, x) => s + x.count, 0) };
  },

  /**
   * 跨作品覆盖分析（§21）。
   *
   * ⚠ 先做这一步再挖掘：**单作品组挖出的模式必然带作者风格**，
   *   落库时该降档为 STYLE，不该冒充类型规律。
   *   这一步是免费的分析（不调模型），可先跑看数据够不够。
   */
  'mine.crossWorkAnalysis': (params: { genre?: string | null } = {}) => {
    const repo = corpusRepo();
    const all = repo.listAnnotatedScenesByGenre(params.genre ?? null);
    const analysis = analyzeCrossWork(all);
    return { ...analysis, totalScenes: all.length };
  },

  /**
   * 模式挖掘（§20 七槽 + §21 跨作品分层）。
   *
   * ⚠ 会消耗模型额度：按 sceneFunction 分组，每组一次调用。
   */
  'mine.run': async (params: {
    genre?: string | null;
    scenesPerGroup?: number;
    maxGroups?: number;
    /** 每条模式的最大场景字符数 */
    maxSceneChars?: number;
    /** 只挖指定场景功能（调试用） */
    onlyFunction?: string;
  }) => {
    const p = requireProject();
    if (!p.runtime) {
      throw new AppError(ErrorCode.MODEL_AUTH_FAILED, '尚未配置模型，无法挖掘');
    }
    const repo = corpusRepo();
    const root = corpusRoot();
    const all = repo.listAnnotatedScenesByGenre(params.genre ?? null);

    // ⚠ 同 annotate：挖掘也属自动处理链，逐个文档校验许可（§61）
    const blocked = [
      ...new Set(
        all
          .map((sc) => repo.get(sc.document_id))
          .filter((d) => !canProcess(d, 'DISTILLATION_ONLY'))
          .map((d) => `${d.title}(${d.allowed_usage})`),
      ),
    ];
    if (blocked.length > 0 && blocked.length === new Set(all.map((x) => x.document_id)).size) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `全部语料都不允许进入自动蒸馏链：${blocked.join('、')}（§61）`,
      );
    }

    if (all.length === 0) {
      throw new AppError(
        ErrorCode.STORAGE_QUERY_FAILED,
        `没有已标注的场景可用于挖掘（类型：${params.genre ?? '全部'}）。` +
          '请先运行 annotate.persistDocument。',
      );
    }

    let scenes = all;
    if (params.onlyFunction) {
      scenes = scenes.filter((x) => x.scene_function === params.onlyFunction);
    }

    const miner = new PatternMiner({
      logger: logger.child('mine'),
      structured: (req) => p.runtime!.structured('utility', req),
      scenesPerGroup: params.scenesPerGroup ?? 8,
      maxSceneChars: params.maxSceneChars ?? 2000,
    });
    const store = new PatternStore({ logger: logger.child('mine'), repo });

    // ⚠ 场景正文从文件读（DB 只存路径，§46）
    const textOf = (sc: CorpusSceneRow): string => {
      if (!sc.text_path) return '';
      const abs = join(root, sc.text_path.replace(/\//g, '\\'));
      try {
        return readFileSync(abs, 'utf8');
      } catch {
        return '';
      }
    };

    const r = await store.mineAndPersist({
      miner,
      textOf,
      genre: params.genre ?? null,
      scenes,
      maxGroups: params.maxGroups,
      onProgress: (done, total, fn) => {
        logger.info(`挖掘进度 ${done}/${total}`, { sceneFunction: fn });
      },
    });

    logger.info('模式挖掘完成', {
      genre: params.genre,
      groups: r.mine.groups,
      failedGroups: r.mine.failedGroups,
      patterns: r.mine.patterns.length,
      written: r.written,
      downgraded: r.downgraded,
    });

    return {
      genre: params.genre ?? null,
      scenesUsed: scenes.length,
      // P0-6：逐条 scope 判定依据（供 verify 脚本与人工核对）
      scopeEvidence: r.scopeEvidence ?? [],
      groups: r.mine.groups,
      failedGroups: r.mine.failedGroups,
      failures: r.mine.failures,
      patterns: r.mine.patterns.length,
      written: r.written,
      downgraded: r.downgraded,
      analysis: r.analysis,
    };
  },

  /** 列出挖掘出的模式（Writer 消费入口的预览） */
  'mine.listPatterns': (params: {
    genre?: string | null;
    sceneFunction?: string;
    includeStyle?: boolean;
    minConfidence?: number;
    limit?: number;
  } = {}) => {
    const repo = corpusRepo();
    const rows = repo.listPatterns({
      genre: params.genre ?? null,
      sceneFunction: params.sceneFunction,
      includeStyle: params.includeStyle ?? false,
      minConfidence: params.minConfidence,
    });
    return {
      total: rows.length,
      stats: repo.patternStats(),
      byFunction: repo.patternStatsByFunction(),
      patterns: rows.slice(0, params.limit ?? 50).map((r) => ({
        id: r.id,
        sceneFunction: r.scene_function,
        genre: r.genre,
        scope: r.scope,
        confidence: r.confidence,
        sampleCount: r.sample_count,
        trigger: safeJson(r.trigger_json),
        pattern: safeJson(r.pattern_json),
        mechanism: r.mechanism,
        evidenceRefs: safeJson(r.evidence_refs_json),
        // P0-6：scope 判定依据。⚠ null 表示"当时没记录"（0011 之前写入的行），
        //   不等于"依据为空" —— 不能当默认值用。
        scopeEvidence: safeJson(r.scope_evidence_json ?? ''),
      })),
    };
  },

  /**
   * 技能编译（§23 / §24）—— 把已验证的模式编译成可执行技能。
   *
   * ⚠ 会消耗模型额度：按 sceneFunction 分组，每组一次调用。
   */
  'skill.compile': async (params: {
    genre?: string | null;
    maxSkillsPerGroup?: number;
    minPatternConfidence?: number;
  }) => {
    const p = requireProject();
    if (!p.runtime) {
      throw new AppError(ErrorCode.MODEL_AUTH_FAILED, '尚未配置模型，无法编译技能');
    }
    const repo = corpusRepo();
    const genre = params.genre ?? null;

    // ⚠ 只吃**已通过跨作品校验**的模式（GENRE/UNIVERSAL）。
    //   STYLE 是单作品证据，编译成技能会让 Writer 套用某位作者的习惯 ——
    //   §21 明确要求默认不用作者特有策略。
    const patterns = repo
      .listPatterns({
        genre,
        includeStyle: false,
        minConfidence: params.minPatternConfidence ?? 0,
      })
      .filter((x) => x.scope === 'GENRE' || x.scope === 'UNIVERSAL');

    if (patterns.length === 0) {
      throw new AppError(
        ErrorCode.STORAGE_QUERY_FAILED,
        `没有可用于编译的跨作品模式（类型：${genre ?? '全部'}）。` +
          '请先运行 mine.run，且需要至少两部同类型作品。',
      );
    }

    const scenes = repo.listAnnotatedScenesByGenre(genre);

    const compiler = new SkillCompiler({
      logger: logger.child('compile'),
      structured: (req) => p.runtime!.structured('utility', req),
      maxSkillsPerGroup: params.maxSkillsPerGroup ?? 3,
    });
    const store = new SkillStore({ logger: logger.child('compile'), repo });

    const r = await store.compileAndPersist({
      compiler,
      patterns,
      scenes,
      genre,
      onProgress: (done, total, fn) => {
        logger.info(`技能编译进度 ${done}/${total}`, { sceneFunction: fn });
      },
    });

    return {
      genre,
      patternsUsed: patterns.length,
      scenesUsed: scenes.length,
      groups: r.groups,
      persisted: r.persisted,
      usable: r.usable,
      unusable: r.unusable,
      problems: r.problems,
      failures: r.failures,
    };
  },

  /**
   * 列出技能（§21 类型隔离 + §24 可检索）。
   *
   * ⚠ 走 `filterSkillsByGenre` —— 类型隔离的唯一入口。
   *   STYLE 默认不返回（§21：Writer 默认不用作者特有策略）。
   */
  'skill.list': (params: {
    genre?: string | null;
    allowStyle?: boolean;
    status?: string;
    limit?: number;
  } = {}) => {
    const repo = corpusRepo();
    const all = repo.listSkills();
    const filtered = filterSkillsByGenre(all, {
      genre: params.genre ?? null,
      allowStyle: params.allowStyle ?? false,
    });

    let kept = filtered.kept;
    if (params.status) kept = kept.filter((s) => s.status === params.status);

    return {
      total: kept.length,
      stats: repo.skillStats(),
      /** ⚠ 被类型隔离挡掉的（如实报告，便于诊断"为什么没用到某技能"） */
      excludedCount: filtered.excluded.length,
      excludedReasons: summarizeReasons(filtered.excluded),
      skills: kept.slice(0, params.limit ?? 50).map((s) => ({
        id: s.id,
        name: s.name,
        category: s.category,
        summary: s.summary,
        scope: s.scope,
        genre: s.genre,
        status: s.status,
        version: s.version,
        confidence: s.confidence,
        trigger: safeJson(s.trigger_json),
        rules: safeJson(s.rules_json),
        antiPatterns: safeJson(s.anti_patterns_json),
        evidenceRefs: safeJson(s.evidence_refs_json),
        sourceDocumentIds: safeJson(s.source_document_ids_json),
      })),
    };
  },

  /**
   * 清理库里的近重复技能（标记 DEPRECATED，不删除）。
   *
   * ⚠ 用于清理"去重功能上线前"编译的历史残留。
   *   用 DEPRECATED 而非 DELETE：可逆、可审计、不破坏证据链。
   */
  'skill.pruneDuplicates': (params: { threshold?: number; dryRun?: boolean } = {}) => {
    const repo = corpusRepo();
    const rows = repo.listSkills();
    const plan = planDeprecations(rows, params.threshold ?? 0.40);

    if (params.dryRun !== false) {
      // ⚠ 默认只预览，不真改 —— 批量改状态是破坏性操作，
      //   调用方必须显式传 dryRun: false 才执行。
      return {
        dryRun: true,
        total: rows.length,
        wouldDeprecate: plan.deprecate.length,
        kept: plan.kept.length,
        deprecated: plan.deprecate,
      };
    }

    let changed = 0;
    for (const id of plan.deprecate) {
      if (repo.setSkillStatus(id, 'DEPRECATED')) changed++;
    }
    logger.info('已下架近重复技能', { changed, kept: plan.kept.length });
    return { dryRun: false, deprecated: changed, kept: plan.kept.length, ids: plan.deprecate };
  },

  /**
   * 预览技能检索结果（§25）—— **不调模型**，只看会注入什么。
   *
   * ⚠ 这个入口的价值：技能检索是"静默"的 —— 注入错了不会报错，
   *   只会让正文质量悄悄变差。能单独查看"某个场景会拿到哪些技能、
   *   落选的为什么落选"，才谈得上调试。
   */
  'skill.retrieve': (params: {
    genre?: string | null;
    sceneFunction?: string | null;
    emotionIntensity?: number | null;
    maxSkills?: number;
    allowStyle?: boolean;
  } = {}) => {
    const repo = corpusRepo();
    const rows = repo.listSkills();
    const engine = new SkillEngine({
      maxSkills: params.maxSkills ?? 4,
      allowStyle: params.allowStyle ?? false,
    });
    const sel = engine.retrieve(rows, {
      sceneFunction: params.sceneFunction ?? null,
      genre: params.genre ?? null,
      emotionIntensity: params.emotionIntensity ?? null,
    });
    return {
      considered: sel.considered,
      selectedCount: sel.selected.length,
      blockChars: sel.block.length,
      selected: sel.selected.map((x) => ({
        id: x.skill.id,
        name: x.skill.name,
        score: Math.round(x.score * 100) / 100,
        reasons: x.reasons,
        truncated: x.truncated,
        category: x.skill.category,
        scope: x.skill.scope,
        confidence: x.skill.confidence,
      })),
      rejected: sel.rejected,
      /** ⚠ 真正会被注入的文本（人工核对用） */
      block: sel.block,
    };
  },

  /** 启用/废弃技能（§24 的"禁用"能力） */
  'skill.setStatus': (params: { skillId: string; status: string }) => {
    const repo = corpusRepo();
    const ok = repo.setSkillStatus(params.skillId, params.status as never);
    if (!ok) {
      throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, `技能不存在：${params.skillId}`);
    }
    return { skillId: params.skillId, status: params.status };
  },

  /**
   * 语料库概览（§16）—— 有哪些语料、各自能否进蒸馏链。
   *
   * ⚠ 必须显示 `processable`：许可不明（UNKNOWN）的语料只能检索、
   *   不能蒸馏（§61）。不显示的话，用户会在标注失败时莫名其妙。
   */
  'corpus.overview': () => corpusOverview(corpusRepo()),

  /**
   * 导入一份语料（§16 / §58 / §61）。
   *
   * ⚠ 这是此前**完全缺失**的产品能力 —— 导入只存在于验证脚本
   *   （`verify-books.mjs` 硬编码书单），用户无法导入自己的小说。
   *
   * 用户选择：允许 UNKNOWN 许可导入但弹提示 → 自动降级为
   * RETRIEVAL_ONLY（可检索、不可蒸馏），并在返回里给出 licenseWarning。
   */
  'corpus.import': (params: {
    filePath: string;
    title?: string;
    author?: string | null;
    genre?: string | null;
    subgenre?: string | null;
    licenseType?: string;
    sourceType?: string;
    allowedUsage?: string;
    licenseBasis?: string;
    clean?: boolean;
  }) => {
    const r = importCorpusFile(
      { repo: corpusRepo(), corpusRoot: corpusRoot(), logger: logger.child('corpus') },
      params,
    );
    if (!r.ok) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        r.error?.message ?? '导入失败',
      );
    }
    logger.info('语料已导入', {
      title: r.title,
      chapters: r.chapterCount,
      licenseWarning: Boolean(r.licenseWarning),
    });
    return r;
  },

  /**
   * 一键跑完整条蒸馏链：导入 → 标注 → 挖掘 → 编译技能。
   *
   * ⚠ 用户明确要求"全程进度可见"。因此：
   *   - 每阶段通过 `onProgress` 回报（UI 侧轮询或监听日志）
   *   - **逐阶段记录结果**，任一阶段失败时返回**已完成到哪一步**
   *     （而不是一个笼统的失败）—— 长任务失败后能续跑，不白跑
   *   - 标注阶段沿用既有的断点续跑（已标注章节会跳过）
   *
   * ⚠ 会消耗大量模型额度（标注按场景计费）。调用方应先用小章节数验证。
   */
  'corpus.distill': async (params: {
    documentId: string;
    genre?: string | null;
    /** 最多标注多少章（先小量验证用；不传=全部） */
    maxChapters?: number;
    /** 是否继续挖矿与编译技能（默认 true） */
    runMining?: boolean;
    /** 是否继续编译技能（默认 true） */
    runCompile?: boolean;
  }) => {
    const p = requireProject();
    if (!p.runtime) {
      throw new AppError(ErrorCode.MODEL_AUTH_FAILED, '尚未配置模型，无法蒸馏');
    }
    const repo = corpusRepo();
    const root = corpusRoot();
    const stages: {
      stage: string;
      ok: boolean;
      detail?: string;
      data?: unknown;
    }[] = [];

    // ⚠ `handlers` 是异构表（每个 handler 入参类型不同），互调时需放宽类型。
    //   用局部宽松别名，而不是把整张表标成 any —— 后者会让**所有**
    //   handler 失去类型检查。
    const callHandler = handlers as unknown as Record<
      string,
      (p: unknown) => Promise<unknown>
    >;

    // ── 阶段 1：标注（含许可闸门，annotate.persistDocument 内部已校验）──
    try {
      const ann = await callHandler['annotate.persistDocument']!({
        documentId: params.documentId,
        corpusRoot: root,
        ...(params.maxChapters !== undefined ? { maxChapters: params.maxChapters } : {}),
      });
      stages.push({ stage: 'annotate', ok: true, data: ann });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      stages.push({ stage: 'annotate', ok: false, detail: msg });
      // ⚠ 标注失败就**停在这里**，不继续挖掘 —— 没有标注数据，
      //   挖掘只会产出垃圾，白耗额度。
      return { ok: false, stages, stoppedAt: 'annotate' };
    }

    const genre = params.genre ?? null;

    // ── 阶段 2：挖掘 ──
    if (params.runMining !== false) {
      try {
        const m = await callHandler['mine.run']!({ genre, maxGroups: 0 });
        stages.push({ stage: 'mine', ok: true, data: m });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        stages.push({ stage: 'mine', ok: false, detail: msg });
        return { ok: false, stages, stoppedAt: 'mine' };
      }
    }

    // ── 阶段 3：编译技能 ──
    if (params.runCompile !== false) {
      try {
        const c = await callHandler['skill.compile']!({ genre });
        stages.push({ stage: 'compile', ok: true, data: c });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        stages.push({ stage: 'compile', ok: false, detail: msg });
        return { ok: false, stages, stoppedAt: 'compile' };
      }
    }

    const progress = repo.annotationProgress(params.documentId);
    logger.info('蒸馏链完成', { documentId: params.documentId, progress });
    return { ok: true, stages, progress };
  },

  /**
   * 导出项目（§58）—— 真源 + 用户资产，附 manifest 与校验和。
   *
   * ⚠ 不含 FTS 索引（§59 派生数据）与 workspace（未验证中间产物）。
   */
  'backup.export': (params: { outDir?: string; includeCorpus?: boolean } = {}) => {
    const p = requireProject();
    const r = exportProject({
      rootDir: p.dir,
      logger: logger.child('backup'),
      ...(params.outDir ? { outDir: params.outDir } : {}),
      ...(params.includeCorpus !== undefined ? { includeCorpus: params.includeCorpus } : {}),
    });
    return {
      ok: r.ok,
      outDir: r.outDir,
      files: r.manifest.totals.files,
      bytes: r.manifest.totals.bytes,
      excluded: r.manifest.excluded,
    };
  },

  /** 校验导出物完整性（对照 manifest 的 sha256）—— 不读项目，只读备份目录 */
  'backup.verify': (params: { dir: string }) => {
    const r = verifyExport(params.dir);
    return { ok: r.ok, checked: r.checked, problems: r.problems };
  },

  /**
   * 从备份恢复（§58）。
   *
   * ⚠ 破坏性操作：目标已存在时必须显式 `overwrite: true`，
   *   且会先把现状移到 `.pre-restore-*`（可回滚）。
   */
  'backup.restore': (params: {
    backupDir: string;
    targetDir?: string;
    overwrite?: boolean;
  }) => {
    const p = requireProject();
    const targetDir = params.targetDir ?? p.dir;
    const r = restoreBackup({
      backupDir: params.backupDir,
      targetDir,
      logger: logger.child('backup'),
      // ⚠ 传分词器才能重建 FTS；不传会如实报告"未重建"
      tokenizer: bigramTokenizer,
      ...(params.overwrite !== undefined ? { overwrite: params.overwrite } : {}),
    });
    return {
      ok: r.ok,
      targetDir: r.targetDir,
      verified: r.verified,
      previousMovedTo: r.previousMovedTo,
      ftsRebuilt: r.ftsRebuilt,
      warnings: r.warnings,
      error: r.error ?? null,
    };
  },

  /**
   * 重建 FTS 索引（§59：派生数据可重建）。
   *
   * ⚠ 独立入口是必要的：索引损坏或恢复后忘记重建时，
   *   检索会**静默返回空**（看起来像"没有匹配内容"，不报错）。
   */
  'backup.rebuildFts': () => {
    const p = requireProject();
    // ⚠ 分词器取全项目唯一来源 bigramTokenizer（ADR-0004：必须带 bigram 补丁），
    //   不要从 runtime 取 —— runtime 没有这个字段，而且分词器不该由它持有。
    const r = rebuildFts(p.dir, bigramTokenizer, logger.child('backup'));
    return r;
  },

  /**
   * 检索（补缺口）：走 FTS + bm25，结果带 sourceRef。
   * ⚠ 只读。
   */
  'search.query': (params: { bookId?: string | null; query: string; limit?: number }) => {
    const p = requireProject();
    const bookId = resolveBookId(params.bookId);

    const retriever = new Retriever({ runner: p.fts, tokenizer: bigramTokenizer });
    const chapterTrace = retriever.retrieve({
      query: params.query,
      limit: params.limit ?? 10,
      ...(bookId ? { filter: { bookId } } : {}),
    });

    const gatherer = new MemoryGatherer({
      retriever,
      memoryIndex: p.fts,
      buildMatch: (q) => buildMatchExpression(bigramTokenizer.query(q)),
      logger: logger.child('memory'),
    });
    const mem = gatherer.gather(params.query, {
      limit: params.limit ?? 10,
      ...(bookId ? { bookId } : {}),
      includeMemoryIndex: true,
    });

    return {
      query: params.query,
      engine: chapterTrace.engine,
      tookMs: chapterTrace.tookMs,
      matchedTokens: chapterTrace.matchedTokens,
      chapters: chapterTrace.hits.map((h) => ({
        id: h.id,
        sourceRef: h.sourceRef,
        score: Number(h.score.toFixed(3)),
      })),
      memories: mem.entries.map((e) => ({
        id: e.id,
        sourceRef: e.sourceRef,
        score: Number(e.score.toFixed(3)),
      })),
      retrieved: mem.retrieved,
    };
  },

  /** 待确认摘要清单（ADR-0006 约束 C 的验收卡） */
  'summary.pending': (params: { bookId?: string | null } = {}) => {
    const p = requireProject();
    const bookId = resolveBookId(params.bookId);
    if (!bookId) return { pending: [], approvedCount: 0 };
    const indexer = new SummaryIndexer({
      repos: p.repos,
      fts: p.fts,
      logger: logger.child('summary'),
    });
    return {
      pending: indexer.pendingSummaries(bookId),
      approvedCount: p.repos.chapters.listApprovedSummaries(bookId).length,
    };
  },

  /**
   * 生成章节摘要候选（ADR-0006 约束 C）。
   *
   * ⚠ 这一步是长程记忆的**唯一入口**。此前全代码库没有它 ——
   *   `chapters.summary` 永远是 NULL，Commit 只能 fallback 成标题
   *   「第 N 章」，导致后续章节检索到的前情只有三个字，
   *   模型只能另起炉灶（实测：第1章主角"林渊"→第2章变成"林秋"）。
   *
   * ⚠ 生成后 summary_approved 仍为 0 —— **不进检索**，
   *   必须由作者在界面上确认（ADR-0006："错一条污染后面几百章"）。
   */
  'summary.generate': async (params: { chapterId: string }) => {
    const p = requireProject();
    if (!p.runtime) {
      throw new AppError(ErrorCode.MODEL_AUTH_FAILED, '尚未配置模型，无法生成摘要');
    }
    const chapter = p.repos.chapters.get(params.chapterId);

    // 取正文：优先 revision，退回 draft
    const ws = new ChapterWorkspace({
      rootDir: p.dir,
      chapterNumber: chapter.chapter_number,
      logger: logger.child('workspace'),
    });
    const body = ws.readText('revision') ?? ws.readText('draft');
    if (body === null) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `第 ${chapter.chapter_number} 章还没有正文 —— 无法生成摘要`,
      );
    }

    // 前情摘要（已确认的），供模型保持连贯
    const prior = p.repos.chapters
      .listApprovedSummaries(chapter.book_id)
      .filter((c) => c.chapter_number < chapter.chapter_number)
      .map((c) => c.summary ?? '')
      .filter((x) => x.trim().length > 0);

    const plan = p.repos.chapters.readPlan<unknown>(params.chapterId);

    const gen = new SummaryGenerator({
      structured: (req) => p.runtime!.structured('utility', req),
      logger: logger.child('summary-gen'),
    });

    const res = await gen.generate({
      chapterNumber: chapter.chapter_number,
      draftText: body,
      ...(plan !== null ? { planText: JSON.stringify(plan).slice(0, 4000) } : {}),
      ...(prior.length > 0 ? { previousSummaries: prior } : {}),
    });

    if (!res.ok || !res.summary) {
      return {
        ok: false,
        error: res.error ?? { code: ErrorCode.MODEL_STRUCTURED_EMPTY, message: '摘要生成失败' },
      };
    }

    // 写入候选（保持未确认状态）
    p.repos.chapters.setSummaryCandidate(chapter.id, res.summary.summary);

    return {
      ok: true,
      summary: res.summary.summary,
      keyFacts: res.summary.keyFacts,
      endState: res.summary.endState,
      // 明确回报：尚未进检索
      approved: false,
    };
  },

  /** 确认摘要（可同时改写内容）→ 才进检索索引 */
  'summary.approve': (params: { chapterId: string; edited?: string }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.approveSummary(
      params.chapterId,
      params.edited,
    );
    const indexer = new SummaryIndexer({
      repos: p.repos,
      fts: p.fts,
      logger: logger.child('summary'),
    });
    const r = indexer.indexChapter(chapter.id);
    return { chapterId: chapter.id, indexed: r.indexed, reason: r.reason ?? null };
  },

  /** 撤回摘要确认（发现写错时） */
  'summary.revoke': (params: { chapterId: string }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.revokeSummaryApproval(params.chapterId);
    const indexer = new SummaryIndexer({
      repos: p.repos,
      fts: p.fts,
      logger: logger.child('summary'),
    });
    // ⚠ 撤回同时清理索引，避免旧内容继续被检索到
    const r = indexer.indexChapter(chapter.id);
    return { chapterId: chapter.id, indexed: r.indexed, reason: r.reason ?? null };
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
  /**
   * 暂停一个 Run（补缺口：Pause 的 UI 入口）。
   *
   * ⚠ 已完成的 checkpoint **保留**，因此 resume 不必重跑已完成步骤
   *   （研究报告 R8：不重跑昂贵的 LLM 调用）。
   */
  'run.pause': async (params: { runId: string }) => {
    const p = requireProject();
    if (!p.runtime) {
      throw new AppError(ErrorCode.MODEL_AUTH_FAILED, '尚未配置模型，无运行中的 Agent');
    }
    await p.runtime.pause(params.runId);
    logger.info('Run 已暂停', { runId: params.runId });
    return { ok: true, runId: params.runId, paused: true };
  },

  /**
   * 恢复一个 Run。
   *
   * ⚠ 返回 resumeFrom（上次完成的 checkpoint 阶段），让调用方知道
   *   "从哪继续" —— 而不是重跑全部。
   */
  'run.resume': async (params: { runId: string }) => {
    const p = requireProject();
    if (!p.runtime) {
      throw new AppError(ErrorCode.MODEL_AUTH_FAILED, '尚未配置模型，无运行中的 Agent');
    }
    const r = await p.runtime.resume(params.runId);
    logger.info('Run 已恢复', { runId: params.runId, resumeFrom: r.resumeFrom });
    return { ok: true, runId: r.runId, resumeFrom: r.resumeFrom };
  },

  /** 取消一个 Run（不可恢复，与 pause 语义不同） */
  'run.cancel': async (params: { runId: string }) => {
    const p = requireProject();
    if (!p.runtime) {
      throw new AppError(ErrorCode.MODEL_AUTH_FAILED, '尚未配置模型，无运行中的 Agent');
    }
    await p.runtime.cancel(params.runId);
    logger.info('Run 已取消', { runId: params.runId });
    return { ok: true, runId: params.runId, cancelled: true };
  },

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
      // ⚠ 默认 180 秒而不是 60 秒：写正文要生成多个上千字的场景，
      //   60 秒几乎必然超时（实测踩到"请求超时（60000ms）"）。
      timeoutMs: prof.timeoutMs ?? 180000,
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

    // ⚠ 保存后必须**重建 Runtime** —— 否则 agentReady 一直为 false。
    //
    // 实测 bug：runtime 只在 project.open 时构建一次。用户在界面里配好模型后，
    // p.runtime 仍是 null，于是「规划当前章节」等入口全部报
    // "尚未配置模型"，看起来像配置没生效。
    // 配置是热更新的（无需重开项目），因此这里同步重建。
    const rebuild = (() => {
      try {
        p.runtime = buildRuntime(p);
        return { agentReady: p.runtime !== null };
      } catch (e) {
        // 配置写对了但 gateway 构建失败（如 profile 非法）→ 不静默，
        // 明确回报，否则用户会再次陷入"配了却用不了"
        logger.error('模型配置已保存，但 Runtime 重建失败', {
          error: e instanceof Error ? e.message : String(e),
        });
        return { agentReady: false, rebuildError: e instanceof Error ? e.message : String(e) };
      }
    })();

    logger.info('模型配置已保存', {
      profileId: next.id,
      slots,
      configPath: modelsConfigPath(p.dir),
      agentReady: rebuild.agentReady,
    });
    return { ok: true, profileId: next.id, apiKeyRef, slots, ...rebuild };
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

  // ────────────────────────────────────────────────
  // Novel Workflow（P0-1 / P0-2）
  //
  // ⚠ 这些是 UI 的**唯一**写作入口。原先是 UI 逐个调用
  //   chapter.plan → writer.draft → review.run → ... ，
  //   编排在调用方手里 —— 提示词 §三 明确禁止。
  //   旧 IPC 保留（调试/验证脚本用），但正常流程走 workflow。
  // ────────────────────────────────────────────────

  /**
   * 启动一个 Novel Workflow（"写下一章"）。
   *
   * 用户只需给 bookId（chapterId 可省 —— 会自动建下一章）。
   * 后续 12 个 stage 由 WorkflowEngine 按 STAGE_ORDER 驱动，
   * 调用方无法跳过任何一步。
   */
  'workflow.start': async (params: {
    bookId: string;
    chapterId?: string | null;
    chapterNumber?: number | null;
    userInstruction?: string;
  }) => {
    const p = requireProject();

    // ⚠ 显式校验，而不是让 undefined 一路走到 SQLite。
    //   实测：bookId 为 undefined 时报的是
    //   "Provided value cannot be bound to SQLite parameter 3" ——
    //   完全看不出是哪个参数、哪一步错，排查成本很高。
    if (!params.bookId || String(params.bookId).trim() === '') {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        'workflow.start 需要 bookId（要写哪本书）',
      );
    }

    // 项目行（workflow 与 runs 都需要它）
    const projectId = p.repos.projects.list()[0]?.id;
    if (!projectId) {
      throw new AppError(
        ErrorCode.STORAGE_QUERY_FAILED,
        '当前项目库里没有项目行 —— 请先在界面里新建项目',
      );
    }

    const repo = new WorkflowRepository(p.db, logger.child('workflow-repo'));
    const wfId = `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    // ⚠ 同时建一条 `runs` 行。
    //
    //   原因：`run_events.run_id` 有外键指向 `runs(id)`。工作流的事件
    //   （§二十 要求 STAGE_STARTED/STAGE_COMPLETED 等）都要挂在一个
    //   run 上，否则 INSERT 会 FOREIGN KEY constraint failed。
    //
    //   用同一个 id 让"工作流"与"run"一一对应 —— UI 订阅事件流时
    //   用 workflowId 即可，不需要记两个 id。
    p.repos.runs.create({
      id: wfId,
      projectId,
      workflowType: 'novel',
      input: { bookId: params.bookId },
    });

    const wf = repo.create({
      id: wfId,
      projectId,
      bookId: params.bookId,
      chapterId: params.chapterId ?? null,
      chapterNumber: params.chapterNumber ?? null,
      stageInputs: {
        ...(params.userInstruction ? { userInstruction: params.userInstruction } : {}),
        bookId: params.bookId,
      },
    });
    repo.initStages(wf.id, stageOrdinals());

    const engine = buildWorkflowEngine(p);
    workflowEngines.set(wf.id, engine);

    // ⚠ 不 await 跑完再返回 —— 一章要几分钟，UI 需要立刻拿到 workflowId
    //   去订阅进度。错误通过 workflow 记录暴露，不靠抛异常。
    void engine
      .advance(wf.id, { bookId: params.bookId, ...(params.userInstruction ? { userInstruction: params.userInstruction } : {}) })
      .catch((e) => logger.error('Workflow 执行异常', e, { workflowId: wf.id }));

    return { workflowId: wf.id, status: 'CREATED' };
  },

  /** 查询工作流状态与逐 stage 进度（UI 用） */
  'workflow.get': (params: { workflowId: string }) => {
    const p = requireProject();
    const repo = new WorkflowRepository(p.db);
    const wf = repo.get(params.workflowId);
    if (!wf) {
      throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, `工作流不存在：${params.workflowId}`);
    }
    const stages = repo.listStages(params.workflowId);
    return {
      workflowId: wf.id,
      status: wf.status,
      currentStage: wf.currentStage,
      resumeCursor: wf.resumeCursor,
      chapterId: wf.chapterId,
      chapterNumber: wf.chapterNumber,
      error: wf.error,
      progress: summarizeStages(stages),
      stages: stages.map((s) => ({
        stageId: s.stageId,
        ordinal: s.ordinal,
        status: s.status,
        attempts: s.attempts,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        error: s.error?.message ?? null,
        output: s.output,
        artifactRefs: s.artifactRefs,
      })),
      artifacts: repo.listArtifacts(params.workflowId),
    };
  },

  /** 暂停（可恢复）—— 与取消语义不同 */
  'workflow.pause': (params: { workflowId: string }) => {
    const p = requireProject();
    const engine = workflowEngines.get(params.workflowId);
    if (!engine) {
      // 进程重启后内存里没有引擎 —— 但状态在库里，直接改库即可
      const repo = new WorkflowRepository(p.db);
      repo.updateStatus(params.workflowId, 'PAUSED');
      return { ok: true, status: 'PAUSED', note: '引擎已不在内存中，仅更新持久化状态' };
    }
    engine.pause(params.workflowId);
    return { ok: true, status: 'PAUSED' };
  },

  /** 恢复（进程重启后也能用 —— 只依赖数据库） */
  'workflow.resume': async (params: { workflowId: string }) => {
    const p = requireProject();
    const engine = buildWorkflowEngine(p);
    workflowEngines.set(params.workflowId, engine);
    void engine
      .resume(params.workflowId, {})
      .catch((e) => logger.error('Workflow 恢复异常', e, { workflowId: params.workflowId }));
    return { ok: true, status: 'RESUMING' };
  },

  /** 取消（不可恢复） */
  'workflow.cancel': (params: { workflowId: string }) => {
    const p = requireProject();
    const engine = workflowEngines.get(params.workflowId);
    if (engine) {
      engine.cancel(params.workflowId);
    } else {
      new WorkflowRepository(p.db).updateStatus(params.workflowId, 'CANCELLED');
    }
    return { ok: true, status: 'CANCELLED' };
  },

  /**
   * 列出可恢复的工作流（进程启动后的恢复入口）。
   *
   * ⚠ 只报告不自动执行 —— 自动跑会在用户没预期时消耗模型额度。
   */
  'workflow.recoverable': () => {
    const p = requireProject();
    const repo = new WorkflowRepository(p.db);
    const list = repo.listUnfinished();
    return {
      count: list.length,
      workflows: list.map((w) => ({
        workflowId: w.id,
        status: w.status,
        chapterNumber: w.chapterNumber,
        currentStage: w.currentStage,
        resumeCursor: w.resumeCursor,
        updatedAt: w.updatedAt,
      })),
    };
  },

  /**
   * 状态提议（§六 P0-4）—— 回答「这一章的状态结算做了什么、为什么没进 Canon」。
   *
   * ⚠ 门禁的判据是**库里那条记录的 status**，所以必须能查到它 ——
   *   查不到的话，"某条状态为什么没进 Canon"就永远无法回答。
   */
  'state.proposals': (params: { chapterId?: string; status?: string }) => {
    const p = requireProject();
    const repo = new StateProposalRepository(p.db, logger.child('state'));
    const rows = params.chapterId
      ? repo.listByChapter(params.chapterId)
      : params.status
        ? repo.listByStatus(params.status as never)
        : [];
    return {
      count: rows.length,
      proposals: rows.map((r) => ({
        id: r.id,
        chapterId: r.chapterId,
        workflowId: r.workflowId,
        status: r.status,
        factCount: r.facts.length,
        characterStateCount: r.characterStates.length,
        timelineEventCount: r.timelineEvents.length,
        foreshadowingCount: r.foreshadowing.length,
        verifiedCount: r.verification?.verifiedCount ?? 0,
        rejectedCount: r.verification?.rejectedCount ?? 0,
        rejectedReasons: (r.verification?.verdicts ?? [])
          .filter((v) => !v.verified)
          .map((v) => `${v.label}：${v.reason ?? '未通过'}`),
        createdAt: r.createdAt,
      })),
    };
  },

  /**
   * 时间线（P0-5）—— 回答「故事时间上发生了什么、有没有不可能的顺序」。
   *
   * ⚠ 与 `state.proposals` 一样，检查结果必须能查 —— 否则
   *   「Commit 前发现时间线冲突」这句话无法被验证。
   */
  'timeline.query': (params: {
    bookId?: string;
    character?: string;
    location?: string;
    chapter?: number;
    check?: boolean;
  }) => {
    const p = requireProject();
    const bookId = requireBookId(params.bookId);
    const svc = new TimelineService({
      repo: p.repos.timeline,
      logger: logger.child('timeline'),
      bookId,
    });

    let events = svc.listByBook();
    if (params.character) events = events.filter((e) => e.characters.includes(params.character!));
    if (params.location) events = events.filter((e) => e.location === params.location);
    if (params.chapter !== undefined) events = events.filter((e) => e.chapter === params.chapter);

    const report = params.check === false ? null : svc.check();

    return {
      bookId,
      count: events.length,
      // ⚠ 可比较数必须单独报：全是"不可比较"时事件看着很多，
      //   但顺序检查实际什么都没做 —— 不报出来会误以为检查通过了。
      comparableCount: report?.comparableCount ?? null,
      events: events.map((e) => ({
        id: e.id,
        chapter: e.chapter,
        title: e.title,
        storyDisplay: e.storyDisplay,
        storyHours: e.storyHours,
        dayUnknown: e.dayUnknown,
        characters: e.characters,
        location: e.location,
        narrativeMode: e.narrativeMode,
      })),
      issues: report
        ? report.issues.map((i) => ({
            code: i.code,
            severity: i.severity,
            message: i.message,
            chapters: i.chapters,
          }))
        : [],
      blockingCount: report?.blockingCount ?? 0,
      warningCount: report?.warningCount ?? 0,
      limitations: report?.limitations ?? [],
    };
  },

  /**
   * 状态证据（§六 P0-4）—— 回答「这条状态/事件/伏笔来自正文哪一句」。
   *
   * ⚠ 这是"可回溯"的验证入口。只报"有多少条状态"不叫可回溯，
   *   必须能查出**每条指向正文的哪一段**、且那段文本确实等于引文。
   */
  'state.evidence': (params: { bookId?: string }) => {
    const p = requireProject();
    const bookId = requireBookId(params.bookId);
    const rows = p.db.all<{
      id: string;
      source_type: string;
      source_ref: string;
      quote: string;
      start_offset: number;
      end_offset: number;
      note: string | null;
    }>(
      `SELECT id, source_type, source_ref, quote, start_offset, end_offset, note
         FROM evidence WHERE book_id = ? ORDER BY created_at, id`,
      bookId,
    );

    // ⚠ 引用完整性：证据写了却没人引用 = 写了白写。
    //   核对 foreshadowing.evidence_ids_json 与 timeline_events.data_json.evidenceId
    //   真正指向了哪些证据，算出"孤儿证据"数量。
    const referenced = new Set<string>();
    for (const r of p.db.all<{ evidence_ids_json: string | null }>(
      'SELECT evidence_ids_json FROM foreshadowing WHERE book_id = ?',
      bookId,
    )) {
      if (!r.evidence_ids_json) continue;
      try {
        const v = JSON.parse(r.evidence_ids_json) as unknown;
        if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') referenced.add(x);
      } catch {
        /* 解析失败则忽略 */
      }
    }
    for (const r of p.db.all<{ data_json: string }>(
      'SELECT data_json FROM timeline_events WHERE book_id = ?',
      bookId,
    )) {
      try {
        const v = JSON.parse(r.data_json) as { evidenceId?: string };
        if (v.evidenceId) referenced.add(v.evidenceId);
      } catch {
        /* 解析失败则忽略 */
      }
    }
    const orphanCount = rows.filter((r) => !referenced.has(r.id)).length;

    return {
      bookId,
      count: rows.length,
      referencedCount: rows.filter((r) => referenced.has(r.id)).length,
      orphanCount,
      bySource: Object.entries(
        rows.reduce<Record<string, number>>((acc, r) => {
          acc[r.source_ref] = (acc[r.source_ref] ?? 0) + 1;
          return acc;
        }, {}),
      ).map(([sourceRef, n]) => ({ sourceRef, count: n })),
      samples: rows.slice(0, 5).map((r) => ({
        id: r.id,
        sourceRef: r.source_ref,
        note: r.note,
        quote: r.quote.slice(0, 40),
        span: [r.start_offset, r.end_offset],
      })),
    };
  },

  /**
   * 检索痕迹（P0-3）—— 回答「为什么这一章引用了那个旧章节」。
   *
   * ⚠ 三种查法都要支持：
   *   workflowId —— "这一步检索了什么"（按 stage 分）
   *   hitId      —— "这个旧章节被谁引用过"（反向追溯）
   *   stage      —— "所有 Writer 阶段的检索"
   */
  'retrieval.traces': (params: {
    workflowId?: string;
    stage?: string;
    hitId?: string;
    limit?: number;
  }) => {
    const p = requireProject();
    const repo = new WorkflowRepository(p.db);
    const rows = repo.listRetrievalTraces({
      ...(params.workflowId ? { workflowId: params.workflowId } : {}),
      ...(params.stage ? { stage: params.stage } : {}),
      ...(params.hitId ? { hitId: params.hitId } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    });
    return {
      count: rows.length,
      traces: rows.map((r) => ({
        id: r.id,
        workflowId: r.workflowId,
        stage: r.stage,
        query: r.query,
        retriever: r.retriever,
        hitId: r.hitId,
        score: r.score,
        sourceRef: r.sourceRef,
        reason: r.reason,
        createdAt: r.createdAt,
      })),
    };
  },

  /**
   * 结构化真相快照（P0-3）—— 连续性检查的依据来源。
   *
   * ⚠ 只读，不改任何状态。让 UI 能展示"这次检查对照了哪些真值"。
   */
  'retrieval.truth': (params: { bookId?: string | null; chapterNumber: number }) => {
    const p = requireProject();
    const bookId = resolveBookId(params.bookId);
    if (!bookId) {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '没有可用的书（请先创建或打开一本书）');
    }
    const svc = new RetrievalService({
      db: p.db,
      logger: logger.child('retrieval'),
      buildMatch: (q) => buildMatchExpression(bigramTokenizer.query(q)),
    });
    const truth = svc.readStructuredTruth({
      bookId,
      chapterNumber: params.chapterNumber,
    });
    return {
      canonFacts: truth.canonFacts.length,
      characterStates: truth.characterStates.length,
      timeline: truth.timeline.length,
      foreshadowing: truth.foreshadowing.length,
      warnings: truth.warnings,
      // 明细也带出来，便于 UI 展示与人工核对
      detail: {
        canonFacts: truth.canonFacts.slice(0, 50),
        characterStates: truth.characterStates.slice(0, 50),
        timeline: truth.timeline.slice(0, 50),
        foreshadowing: truth.foreshadowing.slice(0, 50),
      },
    };
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
  const bootFts = new FtsIndex({ db, tokenizer: bigramTokenizer, logger: logger.child('fts') });
  const project: OpenProject = {
    dir: PROJECTS_ROOT,
    db,
    repos,
    tools,
    events,
    runtime: null,
    fts: bootFts,
  };
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
