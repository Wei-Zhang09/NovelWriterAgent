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
import {
  Logger,
  AppError,
  ErrorCode,
  bookId,
  perSceneWords,
  evaluateSettingsGate,
  hashSettings,
  evaluateBlueprintGate,
  BLUEPRINT_STEP_LABELS,
  measureText,
  sha256Text,
  chapterRel,
  type ErrorCodeValue,
} from '@nwa/core';
import {
  CorpusRepository,
  Database,
  MIGRATIONS,
  canProcess,
  confirmBookSettings,
  createRepositories,
  evaluateBookBlueprintGate,
  blueprintStateOf,
  confirmBookBlueprint,
  assertBlueprintStep,
  ensureBookDirs,
  filterSkillsByGenre,
  migrateLegacyLayout,
  needsLayoutMigration,
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
  DEFAULT_SUMMARY_MAX_CHARS,
  renderCharacterBlock,
  toCharacterBrief,
  selectRelevantCharacters,
  selectWorldSettings,
  toWorldBrief,
  WorkflowEngine,
  WorkflowRepository,
  createNovelWorkflowStages,
  stageOrdinals,
  summarizeStages,
} from '@nwa/harness';
import { createWorkflowServices, type WorkflowModel } from './workflow-services.js';
import type { NovelWorkflowServices } from '@nwa/harness';
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
import { FtsIndex, ManuscriptRepository } from '@nwa/storage';
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
  /**
   * 工作流服务（含开书向导的生成入口，W7）。
   *
   * ⚠ 此前 services 是**内联创建后即丢弃**的 —— 只有工作流引擎拿到它。
   *   于是向导的生成方法在 IPC 层**够不着**（没有引用），
   *   作者在界面上无法触发任何向导生成。
   */
  services: NovelWorkflowServices;
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
/**
 * 计划工具的门禁断言（W6 开书向导）。
 *
 * ⚠ 与 `workflow-services` 里的 `assertBlueprintGate` **同一判定**，
 *   但**不能共用** —— 那一份是闭包在 services 里的私有函数，
 *   而工具层在 `@nwa/harness`，不该依赖 `@nwa/storage` 的门禁装配细节。
 *   所以这里注入一个薄回调，判定逻辑仍是 `evaluateBookBlueprintGate`
 *   （唯一实现），只是由 app 层负责调用。
 *
 * ⚠ 用传入的 bookId，**不做"当前书"解析** ——
 *   P0-4 记录过：按 created_at 取 [0] 会拿到最旧的书，
 *   导致"给 B 书写的计划被 A 书的门禁放行"。
 */
function assertBlueprintGateForTool(repos: Repositories, bookId: string): void {
  const verdict = evaluateBookBlueprintGate(repos, bookId);
  if (!verdict.allowed) {
    throw new AppError(ErrorCode.BLUEPRINT_NOT_CONFIRMED, verdict.message, {
      details: { bookId, reason: verdict.reason, unfinished: verdict.unfinished },
    });
  }
}


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

/**
 * 应用级偏好（**跨项目、跨重启**）。
 *
 * ## 为什么要有它
 *
 * 主题（浅/暗）与"上次在写哪本书"都是**用户级**状态，不是项目内容：
 * 换个项目不该换主题，而"当前书"是"用户正在写哪一本"的记忆。
 *
 * 之前两者都不落盘 —— `selectedBookId` 是 renderer 的内存变量，
 * 主题同理。后果：关掉软件重开，主题回到默认、当前书回到**最老那本**，
 * 作者每次启动都要手动切回去。
 *
 * ## ⚠ 为什么放用户级目录而不是项目目录
 *
 * 放项目目录的话：① 主题会随项目变（不是用户预期）；
 * ② 备份/导出会把"界面偏好"当成项目内容带走。
 * 所以放在 `NWA_USER_*` 同族的用户级位置（可用环境变量覆盖，
 * 与 `userModelsConfigPath()` 同一套隔离思路）。
 *
 * ⚠ 这里**不存任何密钥**，只存界面偏好与最后打开的书 id。
 */
interface AppPrefs {
  /** 主题：'dark' 为默认（长时间写作） */
  theme?: 'dark' | 'light';
  /** 上次正在写的书 id —— 重启后恢复"当前书" */
  lastBookId?: string;
  /** 上次打开的项目目录 */
  lastProjectDir?: string;
}

function userPrefsPath(): string {
  return (
    process.env['NWA_USER_PREFS_PATH'] ??
    join(homedir(), 'NovelWriterProjects', 'prefs.json')
  );
}

function loadPrefs(): AppPrefs {
  const p = userPrefsPath();
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    return raw as AppPrefs;
  } catch (err) {
    // ⚠ 偏好文件坏了不该让软件起不来 —— 退回默认值，但如实记日志
    logger.warn('prefs.json 解析失败，使用默认偏好', { path: p, error: String(err) });
    return {};
  }
}

function savePrefs(patch: AppPrefs): AppPrefs {
  const merged: AppPrefs = { ...loadPrefs() };
  // ⚠ 逐键合并，`undefined` 的语义是**不改动**，不是"删除"。
  //
  //   直接 `{...old, ...patch}` 再删 undefined 键是错的：那会把
  //   `{lastBookId: undefined}` 解释成"忘掉当前书" —— 调用方本意
  //   通常只是"这次不设置这个字段"，结果把用户的记忆清掉了。
  //   偏好是**静默失效**类数据，丢了不会报错，只会让人每次重切一遍。
  //   （`merged[k] = patch[k]` 这种写法 TS 无法把联合键与联合值关联起来，
  //     所以经 Record 写入；值的类型仍由 AppPrefs 约束。）
  const out = merged as Record<string, unknown>;
  for (const k of Object.keys(patch) as (keyof AppPrefs)[]) {
    const v = patch[k];
    if (v !== undefined) out[k] = v;
  }
  const p = userPrefsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
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
 * 用户正文仓储（M3）。
 *
 * ⚠ 每次现建而不是缓存：`rootDir` 随项目切换而变，缓存会让切项目后
 *   正文写到**上一个项目**的目录里 —— 那正是"多书隔离"最怕的形态。
 *   构造开销只是存两个引用，不值得为省这点开销引入跨书污染的风险。
 */
function manuscriptRepo(): ManuscriptRepository {
  const p = requireProject();
  return new ManuscriptRepository({
    db: p.db,
    rootDir: p.dir,
    logger: logger.child('manuscript'),
  });
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
 * ## 两级接口（读路径用严格版，别用宽松版）
 *
 * - `requireBookId()` —— **严格**：项目里一本书都没有就明确报错。
 * - `resolveBookId()` —— **宽松**：没有书时返回 `undefined`。
 *
 * ⚠ 曾经的问题：`timeline.query` / `state.evidence` 用严格版，
 *   而 `summary.pending` / `search.query` / `canon.list` /
 *   `context.assemble` / `retrieval.truth` 用宽松版 —— 同一个概念
 *   两套行为。宽松版的 `undefined` 往下走会静默变成空串
 *   （`undefined ?? ''`），查询按 `book_id = ''` 过滤返回 0 条：
 *   用户看到"这本书没有内容"，而不是"还没选书"。
 *   两者要采取的行动完全不同。
 *
 *   现已**统一为严格版**。新增读路径请一律用 `requireBookId()`。
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

/**
 * 建工作流服务（W7）。
 *
 * ⚠ 抽成独立函数是必需的：向导 IPC 与工作流引擎**都要**它，
 *   而 buildWorkflowEngine 是懒调用（只在启动工作流时）。
 *   若只在 engine 里建，向导在没跑工作流时就用不了。
 *
 * ⚠ 只建一次并挂在 `p.services` 上：建两份会让向导生成用的 repos
 *   与工作流用的不是同一套对象（当前 repos 无缓存，但这是靠不住的假设）。
 */
function createWorkflowServicesFor(p: OpenProject): NovelWorkflowServices {
  const model: WorkflowModel | null = p.runtime
    ? {
        plannerStructured: (req) => p.runtime!.plannerStructured(req as never),
        structured: (slot, req) => p.runtime!.structured(slot as never, req as never),
        completeText: (slot, req) => p.runtime!.completeText(slot as never, req as never),
      }
    : null;
  return createWorkflowServices({
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
          //
          // ⚠ 此前这里传的是 `mode: input.params['mode'] ?? 'NORMAL'` ——
          //   而 `commit.run` 读的是 **commitMode**，不是 mode。
          //   于是这个参数被**静默丢弃**：无论 workflow 传什么，
          //   提交都以缺省 'clean' 执行。
          //   （同 llm-generation-pipelines「声明了却没人读的参数」一类。）
          const r = await handlers['commit.run']!({
            chapterId: input.chapterId,
            commitMode: input.params['commitMode'] ?? 'clean',
            ...(input.params['forceReason'] ? { forceReason: input.params['forceReason'] } : {}),
          } as never);
          const rec = r as { manifestPath?: string; contentHash?: string; ok?: boolean };
          return {
            manifestPath: rec.manifestPath ?? '',
            contentHash: rec.contentHash ?? '',
            committed: rec.ok !== false,
          };
        },
  });
}

/**
 * 建工作流引擎（复用已建好的 services）。
 *
 * ⚠ 必须复用 `p.services` —— 若这里再建一份，向导生成与工作流会
 *   持有两套不同的服务对象（今天 repos 无缓存所以看不出问题，
 *   但那是靠不住的假设；且未来任何一处加缓存都会变成静默分叉）。
 */
function buildWorkflowEngine(p: OpenProject): WorkflowEngine {
  const engine = new WorkflowEngine({
    repo: new WorkflowRepository(p.db, logger.child('workflow-repo')),
    events: p.events,
    logger: logger.child('workflow'),
  });
  engine.registerAll(createNovelWorkflowStages(p.services));
  return engine;
}

const handlers: Record<string, (params: never) => Promise<unknown> | unknown> = {
  /**
   * 应用偏好（主题 / 上次在写的书 / 上次项目）。
   *
   * ⚠ 读写都**不依赖已打开的项目** —— 主题在项目打开前就要能用，
   *   否则启动瞬间会闪一下默认主题。
   */
  'prefs.get': () => loadPrefs(),

  'prefs.set': (params: { theme?: 'dark' | 'light'; lastBookId?: string; lastProjectDir?: string }) =>
    savePrefs({
      ...(params.theme !== undefined ? { theme: params.theme } : {}),
      ...(params.lastBookId !== undefined ? { lastBookId: params.lastBookId } : {}),
      ...(params.lastProjectDir !== undefined ? { lastProjectDir: params.lastProjectDir } : {}),
    }),

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

    // ⚠ 老项目迁移：旧布局（chapters/001.md，不含书）→ 新布局
    //   （books/<bookId>/chapters/001.md）。
    //
    //   不做这一步的后果不是报错，而是**旧正文突然"消失"**：
    //   读取路径换了，而 DB 里 body_path 仍写着 'chapters/001.md'
    //   → 章节列表显示已提交、点开是空的。用户会以为数据丢了。
    //
    //   ⚠ 必须在 `createRepositories` **之前**做：迁移要用 DB 里的
    //     chapters.book_id 判定归属，而 DB 本身不受布局影响。
    //     迁移是幂等的（有标记文件即跳过），因此每次打开都调。
    try {
      if (needsLayoutMigration(dir)) {
        const report = migrateLegacyLayout(dir, db, logger.child('layout'));
        logger.info('旧布局迁移完成', {
          movedFiles: report.movedFiles,
          books: report.byBook.length,
          unresolved: report.unresolved.length,
        });
      }
    } catch (e) {
      // ⚠ 迁移失败**不阻断打开项目**：用户仍能打开、看到章节列表；
      //   失败只影响旧文件的可见性，而阻断打开会让整个项目不可用。
      //   但必须留下明确日志，不能静默。
      logger.error('旧布局迁移失败（项目仍可打开，但旧正文可能不可见）', e, { dir });
    }

    const repos = createRepositories(db);
    const tools = new ToolRegistry(logger.child('tools'));
    // FTS 索引器（补缺口：检索可用）
    const fts = new FtsIndex({ db, tokenizer: bigramTokenizer, logger: logger.child('fts') });

    // ⚠ commit 工具需要项目目录（写 chapters/ 等），只能在 project.open 注册
    for (const tool of createAllTools(repos, {
      logger: logger.child('tools'),
      // ⚠ 计划工具直接写库，绕过服务层门禁 —— 必须在这里也拦（W6）
      planGate: { assertGateOpen: (bookId) => assertBlueprintGateForTool(repos, bookId) },
      commit: {
        db,
        rootDir: dir,
        indexer: {
          indexChapter: (input) => {
            fts.indexChapter({
              chapterId: input.chapterId,
              // ⚠ bookId 由提交链路从 `chapters.book_id` 传下来（权威），
              //   **不再用 resolveBookId()** —— 那个解析器在未指定时
              //   回退到"最近创建的书"，与"本章属于哪本书"无关。
              //   用它的后果：给 B 书提交，正文被索引到 A 书名下，
              //   而 search() 按 book_id 过滤 → 搜 B 书搜出 A 书正文。
              bookId: input.bookId,
              chapterNumber: input.chapterNumber,
              sourceRef: input.sourceRef,
              text: input.body,
            });
          },
        },
        // 工作区读取由 app 层注入，避免 @nwa/harness 依赖 @nwa/story
        // ⚠ 第一个参数是 bookId（工作区按书隔离，P0-1）。
        //   提交引擎手里有 `req.bookId`（来自 chapters.book_id），传下来即可。
        readWorkspaceText: (bookId, chapterNumber, name) => {
          const ws = new ChapterWorkspace({
            rootDir: dir,
            bookId,
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
    // ⚠⚠ services 必须在**打开项目时**就建好，不能等 buildWorkflowEngine。
    //   实测：buildWorkflowEngine 只在**启动工作流**时懒调用（两处），
    //   而向导 IPC（blueprint.generate*）在没跑工作流时也会被调用 ——
    //   若 services 那时是 undefined，向导一用就崩，且崩在"生成"这一步，
    //   看起来像模型坏了。
    const project = { dir, db, repos, tools, events, runtime: null, fts } as OpenProject;
    // ⚠⚠ 顺序有讲究：**先建 runtime，再建 services**。
    //   createWorkflowServicesFor 会读 `p.runtime` 来决定模型网关，
    //   若反了，services 拿到的永远是 null —— 向导一用就报
    //   "尚未配置模型"，而模型其实配好了（指向错误的排查方向）。
    project.runtime = buildRuntime(project);
    // 建一次，工作流引擎复用同一个（两份会让向导与工作流用不同缓存）
    project.services = createWorkflowServicesFor(project);
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
        // ⚠ 字数目标必须一起返回：UI 的「篇幅目标」面板靠它回显当前设定，
        //   不返回的话面板永远显示空值，作者会以为设定没保存成功。
        targetWordsPerChapter: b.target_words_per_chapter,
        wordCountTolerancePct: b.word_count_tolerance_pct,
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
    // ⚠ 建这本书的三个目录（P0-1 起路径按书隔离）。
    //   不建的话第一章的工作区父目录不存在，而 `scaffoldProjectDir`
    //   只建"项目自带的初始书"那一本。
    ensureBookDirs(p.dir, row.id);
    logger.info('书目已创建', { bookId: row.id, title: row.title });
    return { id: row.id, projectId: row.project_id, title: row.title, currentChapter: row.current_chapter };
  },

  /**
   * 设定每章字数目标（P2-1，软约束）。
   *
   * ⚠ 只影响 Writer 的篇幅提示与审稿的 NOTE 级偏离提醒，**永不阻断提交**。
   *   用户决策：「允许浮动，偏离超阈值时提示我（不阻断）」。
   */
  'book.setWordTarget': (params: {
    bookId: string;
    targetWords: number | null;
    tolerancePct?: number;
  }) => {
    const p = requireProject();
    const row = p.repos.books.setWordTarget(
      params.bookId,
      params.targetWords,
      params.tolerancePct,
    );
    logger.info('每章字数目标已更新', {
      bookId: row.id,
      targetWords: row.target_words_per_chapter,
      tolerancePct: row.word_count_tolerance_pct,
    });
    return {
      bookId: row.id,
      targetWords: row.target_words_per_chapter,
      tolerancePct: row.word_count_tolerance_pct,
    };
  },

  // ── 设定确认门禁（P2-3）────────────────────────────────────

  /**
   * 确认设定：把全部设定标记为 CONFIRMED，并记录**当时的内容指纹**。
   *
   * ⚠ 指纹用 `hashAfterConfirm` 的语义（全部按 CONFIRMED 计算）——
   *   否则"刚确认完指纹就对不上"，门禁会永远拦着自己。
   */
  'settings.confirm': (params: { bookId: string }) => {
    const p = requireProject();
    // ⚠ 走仓储层唯一实现（与测试同一条路径），不在 IPC 里重写三步序列
    const { count, hash } = confirmBookSettings(p.repos, params.bookId);
    logger.info('设定已确认', { bookId: params.bookId, count, hash });
    return { bookId: params.bookId, confirmed: true, count, hash };
  },

  /** 撤回确认（设定改回未确认状态，Agent 再次停写） */
  'settings.revoke': (params: { bookId: string }) => {
    const p = requireProject();
    const row = p.repos.books.revokeSettingsConfirmation(params.bookId);
    logger.info('设定确认已撤回', { bookId: params.bookId });
    return { bookId: row.id, confirmed: false };
  },

  /**
   * 查询设定门禁状态（供 UI 显示"现在能不能写"）。
   *
   * ⚠ 返回**判定结果**而不只是原始字段：UI 不该自己重算门禁逻辑 ——
   *   两处实现迟早分叉，而分叉的后果是"界面说能写、后端拒绝"。
   */
  'settings.status': (params: { bookId: string }) => {
    const p = requireProject();
    const book = p.repos.books.get(params.bookId);
    const entities = p.repos.world.listByBook(params.bookId);
    const entries = p.repos.world.snapshot(params.bookId);
    const verdict = evaluateSettingsGate({
      gateEnabled: book.settings_gate_enabled === 1,
      confirmedHash: book.settings_confirmed_hash,
      currentHash: hashSettings(entries),
      entryCount: entries.length,
    });
    return {
      bookId: book.id,
      gateEnabled: book.settings_gate_enabled === 1,
      confirmedAt: book.settings_confirmed_at,
      entryCount: entries.length,
      confirmedCount: entities.filter((e) => e.status === 'CONFIRMED').length,
      allowed: verdict.allowed,
      reason: verdict.reason,
      message: verdict.message,
      entities: entities.map((e) => ({
        id: e.id,
        type: e.type,
        name: e.name,
        description: e.description,
        status: e.status,
      })),
    };
  },

  /** 开关设定门禁（老项目 / 想直接开写的作者） */
  'settings.setGate': (params: { bookId: string; enabled: boolean }) => {
    const p = requireProject();
    const row = p.repos.books.setSettingsGate(params.bookId, params.enabled);
    logger.info('设定门禁已切换', { bookId: params.bookId, enabled: params.enabled });
    return { bookId: row.id, gateEnabled: row.settings_gate_enabled === 1 };
  },

  // ── 开书向导（W6 统一确认门禁）──────────────────────────────
  //
  // ⚠ 这四个 handler 是「最后确认一切前置信息」这句诉求的**唯一入口**。
  //   W1–W5 建好了数据层与生成层，但没有任何 IPC —— 也就是说
  //   作者在界面上**够不着**统一确认。规则 30：没入口的能力等于不存在。

  /**
   * 查询向导状态（供 UI 显示"走到哪一步、还差什么"）。
   *
   * ⚠ 返回**判定结果**而不只是原始字段：UI 不该自己重算门禁逻辑 ——
   *   两处实现迟早分叉，分叉的后果是"界面说能写、后端拒绝"。
   */
  'blueprint.status': (params: { bookId: string }) => {
    const p = requireProject();
    const state = blueprintStateOf(p.repos, params.bookId);
    const verdict = evaluateBlueprintGate(state);
    return {
      bookId: params.bookId,
      gateEnabled: state.gateEnabled,
      confirmedAt: p.repos.blueprint.blueprintOf(params.bookId).confirmed_at,
      steps: state.steps.map((st) => ({
        step: st.step,
        label: BLUEPRINT_STEP_LABELS[st.step],
        status: st.status,
      })),
      allowed: verdict.allowed,
      reason: verdict.reason,
      message: verdict.message,
      unfinished: verdict.unfinished,
    };
  },

  /**
   * 统一确认全部前置信息（用户说的「最后确认一切前置信息」）。
   *
   * ⚠ 走 `confirmBookBlueprint` 这个**唯一实现**（与测试同一条路径），
   *   不在 IPC 里重写序列 —— 否则"IPC 里写错了"测试照样绿
   *   （`confirmBookSettings` 的注释记着这个教训）。
   */
  'blueprint.confirmAll': (params: { bookId: string }) => {
    const p = requireProject();
    const { hash, steps } = confirmBookBlueprint(p.repos, params.bookId);
    logger.info('开书向导前置信息已统一确认', { bookId: params.bookId, steps, hash });
    return { bookId: params.bookId, confirmed: true, steps, hash };
  },

  /** 撤回统一确认（前置内容改动后重新走一遍） */
  'blueprint.revokeConfirm': (params: { bookId: string }) => {
    const p = requireProject();
    p.repos.blueprint.revokeConfirm(params.bookId);
    logger.info('开书向导统一确认已撤回', { bookId: params.bookId });
    return { bookId: params.bookId, confirmed: false };
  },

  /** 开关向导门禁（与 settings 门禁分开，理由见 0022 迁移注释） */
  'blueprint.setGate': (params: { bookId: string; enabled: boolean }) => {
    const p = requireProject();
    const row = p.repos.books.setBlueprintGate(params.bookId, params.enabled);
    logger.info('开书向导门禁已切换', { bookId: params.bookId, enabled: params.enabled });
    return { bookId: row.id, gateEnabled: row.blueprint_gate_enabled === 1 };
  },

  // ── 开书向导：生成与编辑（W7 接线）────────────────────────
  //
  // ⚠⚠ 这一段是 W2–W5 生成器**唯一**的 UI 可达路径。
  //   W7 端到端测试实测发现：四个生成器在 apps/ 里零引用 ——
  //   也就是说向导"能生成但无法落库"，四步永远 NOT_STARTED，
  //   门禁判 NOT_USED → **永远放行**，prompt 也永远读不到前置内容。
  //   规则 33：分阶段测试查不出阶段之间的接线缺失，只有按文档顺序
  //   真的跑一遍才发现。

  /** Phase 1：生成选题方向（不落库 —— 候选要等作者选） */
  'blueprint.generateConcept': async (params: { bookId: string; params?: Record<string, unknown> }) => {
    const p = requireProject();
    return p.services.blueprint.generateConcept({
      bookId: params.bookId,
      params: params.params ?? {},
    });
  },

  /** 作者选定一个候选 → 落库为 CONCEPT 步草稿 */
  'blueprint.chooseConcept': async (params: { bookId: string; candidate: unknown }) => {
    const p = requireProject();
    return p.services.blueprint.chooseConcept({
      bookId: params.bookId,
      candidate: params.candidate,
    });
  },

  /** Phase 2：生成核心设定 + 角色（落库为草稿，等作者逐条决定） */
  'blueprint.generateSettings': async (params: { bookId: string; params?: Record<string, unknown> }) => {
    const p = requireProject();
    return p.services.blueprint.generateSettings({
      bookId: params.bookId,
      params: params.params ?? {},
    });
  },

  /** 把作者对冲突的决定落进正式表（characters / world_entities） */
  'blueprint.materializeSettings': async (params: {
    bookId: string;
    output: unknown;
    decisions: Record<string, string>;
    knownConflicts: string[];
  }) => {
    const p = requireProject();
    return p.services.blueprint.materializeSettings({
      bookId: params.bookId,
      output: params.output,
      decisions: params.decisions,
      knownConflicts: params.knownConflicts,
    });
  },

  /** Phase 3：生成卷级大纲（整体替换落库） */
  'blueprint.generateOutline': async (params: { bookId: string; params?: Record<string, unknown> }) => {
    const p = requireProject();
    return p.services.blueprint.generateOutline({
      bookId: params.bookId,
      params: params.params ?? {},
    });
  },

  /** Phase 3：生成逐章细纲（分批，按章 upsert） */
  'blueprint.generateChapterOutlines': async (params: {
    bookId: string;
    startChapter: number;
    endChapter: number;
    params?: Record<string, unknown>;
  }) => {
    const p = requireProject();
    return p.services.blueprint.generateChapterOutlines({
      bookId: params.bookId,
      startChapter: params.startChapter,
      endChapter: params.endChapter,
      params: params.params ?? {},
    });
  },

  /** 作者编辑某一步（存 edited，不覆盖 AI 原稿） */
  'blueprint.saveStep': async (params: { bookId: string; step: string; content: unknown }) => {
    const p = requireProject();
    return p.services.blueprint.saveStep({
      bookId: params.bookId,
      step: params.step,
      content: params.content,
    });
  },

  /** 读某一步当前内容（界面渲染用；SETTINGS 步读正式表） */
  'blueprint.getStep': (params: { bookId: string; step: string }) => {
    const p = requireProject();
    const row = p.repos.blueprint.findStep(params.bookId, assertBlueprintStep(params.step));
    return {
      step: row.step,
      status: row.status,
      // ⚠ 有效内容 = edited ?? draft（作者改过的优先）
      content: p.repos.blueprint.effectiveContent(row),
    };
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
          sourceRef: c.body_path ?? chapterRel(bookId, c.chapter_number),
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
      // ⚠ 此前这里只投影 `{ sceneId, purpose }`，把其余字段**全部丢掉**。
      //   后果：任何"模型有没有填某个字段"的验证都必然得到 0/N ——
      //   数据在库里是对的，只是返回值看不见。
      //   验证脚本因此会报出一个**不存在的问题**（比漏报更费时间：
      //   会让人去改 prompt，而 prompt 本来是对的）。
      //   现在原样返回整个场景对象（它已通过 schema 校验）。
      scenes: res.plan.scenes,
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
      // ⚠ 按书隔离（P0-1）：用章节行自己的 book_id，不用"当前书"
      bookId: chapter.book_id,
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
      bookId: chapter.book_id,
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

    // ── 角色设定（P2-2）────────────────────────────────────
    // ⚠ 与 workflow 的 write stage 用同一套筛选逻辑（按计划里出现的名字），
    //   保证两条写作路径行为一致。
    let legacyCharCtx = '';
    try {
      const allChars = p.repos.characters
        .listByBook(chapter.book_id)
        .map(toCharacterBrief);
      if (allChars.length > 0) {
        legacyCharCtx = renderCharacterBlock(
          selectRelevantCharacters(allChars, [JSON.stringify(plan)]),
        );
      }
    } catch (e) {
      logger.warn('角色设定读取失败（本次不注入角色）', {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // ── 世界观设定（P2-3）──────────────────────────────────
    // ⚠ 与 workflow 的 write stage 共用同一筛选（只注入 CONFIRMED）。
    //   旧路径不接线会造成"用工作流写有设定、用逐步按钮写没设定" ——
    //   同一个功能两种行为是最难查的那类缺陷（P2-2 已踩过同一个坑）。
    let legacyWorldCtx = '';
    try {
      const allWorld = p.repos.world.listByBook(chapter.book_id).map(toWorldBrief);
      if (allWorld.length > 0) {
        const sel = selectWorldSettings(allWorld);
        legacyWorldCtx = sel.block;
        if (sel.skippedDrafts > 0) {
          logger.info('有草稿状态的设定未注入（未确认）', {
            bookId: chapter.book_id,
            used: sel.usedCount,
            skippedDrafts: sel.skippedDrafts,
          });
        }
      }
    } catch (e) {
      logger.warn('世界观设定读取失败（本次不注入设定）', {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // ── 每章字数目标（P2-1，软约束）────────────────────────
    // ⚠ 显式传 wordsPerScene 时以调用方为准（精细控制优先）；
    //   否则按书的目标换算。未设定目标时走 Writer 默认值。
    const bookRow = p.repos.books.get(chapter.book_id);
    const explicitScene = params.wordsPerScene;
    const sceneWords =
      explicitScene ??
      (bookRow.target_words_per_chapter !== null
        ? perSceneWords(
            bookRow.target_words_per_chapter,
            Math.max(1, (plan as { scenes?: unknown[] }).scenes?.length ?? 1),
          )
        : undefined);

    const writer = new Writer({
      complete: (req) => p.runtime!.completeText('writer', req),
      workspace,
      logger: logger.child('writer'),
      ...(sceneWords !== undefined ? { wordsPerScene: sceneWords } : {}),
      ...(skillEngine ? { skillEngine } : {}),
      skillRows,
      genre: skillGenre,
      // ⚠ 角色设定（P2-2）：旧路径同样要注入，否则"用工作流写有设定、
      //   用逐步按钮写没设定"—— 同一个功能两种行为是最难查的那类缺陷。
      ...(legacyCharCtx.trim().length > 0 ? { characterContext: legacyCharCtx } : {}),
      ...(legacyWorldCtx.trim().length > 0 ? { worldContext: legacyWorldCtx } : {}),
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
    // ── M6：AI_DRAFT 版本节点（ADR-0008 §6）──
    //
    // ⚠ 这条路径（逐步按钮 writer.write）与 workflow-services 的 write
    //   是**同一个功能的两条入口**。只给其中一条建版本，会让"用工作流写
    //   有版本、用逐步按钮写没版本"—— 正是上一段注释里说的
    //   "同一个功能两种行为是最难查的那类缺陷"。
    //
    // ⚠ 用 workspace.readText('draft') 而不是 d.text：版本必须与磁盘上的
    //   draft.md 逐字相同，否则"版本"与"产物"是两个东西。
    try {
      manuscriptRepo().createVersion({
        bookId: chapter.book_id,
        chapterId: chapter.id,
        chapterNumber: chapter.chapter_number,
        text: workspace.readText('draft') ?? d.text,
        sourceType: 'AI_DRAFT',
      });
    } catch (e) {
      // 版本是辅助能力，写入失败不该让整章生成失败；但要留日志，
      // 否则"版本历史缺一段"会变成无法解释的现象。
      logger.warn('版本节点创建失败（不影响生成）', {
        chapterNumber: chapter.chapter_number,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // ⚠ 偏离说明要回报给上层：模型自报"我偏离了计划"是给人工复核的
    //   信号，但只有**显示出来**才有用。此前它只落在
    //   workflow-services 的返回值里，UI 完全看不到 ——
    //   等于模型说了、系统记了、没人知道。
    const deviations = d.scenes.flatMap((s) => s.deviations ?? []);
    return {
      ok: true,
      chapterNumber: d.chapterNumber,
      sceneCount: d.scenes.length,
      totalChars: d.totalChars,
      usage: d.usage,
      draftPath: d.draftPath,
      preview: d.text.slice(0, 300),
      // ⚠ 已从正文剥离（见 Writer），这里只回报数量与内容供复核
      deviations,
      deviationCount: deviations.length,
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
      // ⚠ 按书隔离（P0-1）：用章节行自己的 book_id，不用"当前书"
      bookId: chapter.book_id,
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
      // ⚠ 按书隔离（P0-1）：用章节行自己的 book_id，不用"当前书"
      bookId: chapter.book_id,
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
      // ⚠ 模型审阅失败时**必须**把原因透出。
      //
      //   此前这里丢掉了 `review.error`，于是 ok=false 却没有任何理由 ——
      //   UI 显示成 `undefined：`（实测：verify:writing 的
      //   「第 2 章审稿 — undefined：」），排查时完全不知道是模型超时、
      //   schema 不符，还是没配模型。
      //
      //   `modelOk=false` 只说明"模型那半没成功"，回答不了"为什么"。
      //   而这两种情况的处置完全不同：超时→重试；schema 不符→改提示词；
      //   未配模型→去配置。
      ...(review.error
        ? { error: { code: review.error.code, message: review.error.message } }
        : {}),
      attempts: review.attempts,
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
      // ⚠ 按书隔离（P0-1）：用章节行自己的 book_id，不用"当前书"
      bookId: chapter.book_id,
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

    // ── M6：AI_REVISION 版本节点 ──
    // ⚠ 记的是 revision.md（AI 的修订建议），不是 manuscript ——
    //   §15 要求 AI 修订不得自动覆盖用户正文，所以 revision 只是候选版本。
    try {
      manuscriptRepo().createVersion({
        bookId: chapter.book_id,
        chapterId: chapter.id,
        chapterNumber: chapter.chapter_number,
        text: ws.readText('revision') ?? '',
        sourceType: 'AI_REVISION',
        note: `应用 ${String(res.appliedEdits ?? 0)} 处替换`,
      });
    } catch (e) {
      logger.warn('版本节点创建失败（不影响改稿）', {
        chapterNumber: chapter.chapter_number,
        error: e instanceof Error ? e.message : String(e),
      });
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

  // ────────── M3：Manuscript 创作工作台（§三十四 / §三十五）──────────
  //
  // ⚠ Renderer **不直接读磁盘**（§三十四）。所有正文读写都经这里 ——
  //   这不是"多一层"，而是让"UI 里看到的那份正文"与"提交时会用的那份"
  //   由**同一个仓储**产出，两者不可能分叉。
  //
  // ⚠ `manuscript.*` 系列**绝不触碰 Canon**（§二 SAVE != COMMIT）。
  //   边界由 `ManuscriptRepository` 的代码结构保证，并由
  //   `tests/integration/manuscript-save.test.ts` 的证伪测试固化。

  /** 打开章节：正文 + 自动保存恢复检测（**只检测不恢复**，§十一） */
  'manuscript.open': (params: { chapterId: string }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.get(params.chapterId);
    const repo = manuscriptRepo();
    const opened = repo.open(chapter.book_id, chapter.chapter_number);
    return {
      chapterId: chapter.id,
      chapterNumber: chapter.chapter_number,
      title: chapter.title,
      text: opened.text,
      sourceHash: opened.sourceHash,
      recovery: opened.recovery,
      // §三十：UI 必须能一眼看出"这份正文是不是已经是正史"
      committed: repo.isCommitted(chapter.id),
    };
  },

  /** 读正文（不带恢复检测，供刷新/轮询用） */
  'manuscript.get': (params: { chapterId: string }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.get(params.chapterId);
    const repo = manuscriptRepo();
    const text = repo.get(chapter.book_id, chapter.chapter_number);
    return {
      chapterId: chapter.id,
      chapterNumber: chapter.chapter_number,
      text,
      sourceHash: text === null ? null : sha256Text(text),
      committed: repo.isCommitted(chapter.id),
    };
  },

  /**
   * 保存正文（§十：Ctrl+S 与「保存」按钮都走这里）。
   *
   * ⚠ 只写 manuscript.md。**不触发 Commit、不写 Canon、不改章节状态。**
   *   §二 是本阶段最重要的原则，这条边界由证伪测试固化。
   */
  'manuscript.save': (params: { chapterId: string; text: string }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.get(params.chapterId);
    const repo = manuscriptRepo();
    const res = repo.save(chapter.book_id, chapter.chapter_number, params.text);
    // ⚠ 保存成功后清掉待恢复的 autosave —— 用户已经显式保存了，
    //   再留着副本会让下次打开又提示"发现未恢复的编辑内容"。
    if (res.changed) repo.clearAutosave(chapter.book_id, chapter.chapter_number);

    // ── M6：手动保存建 USER_EDIT 版本节点（ADR-0008 §6）──
    //
    // ⚠ 只在 `changed` 时建：`createVersion` 内部也按内容 hash 判重，
    //   但这里先判一次能省掉一次查询 —— 更重要的是语义清楚：
    //   "内容没变的手动保存"不产生版本，这一层就把话说死了。
    //
    // ⚠ 版本创建失败**不让保存失败**：保存是用户的核心诉求
    //   （"别丢我的字"），版本是附加能力。为一个附加能力让保存报错，
    //   代价完全不成比例。
    let version: unknown = null;
    if (res.changed) {
      try {
        version = repo.createVersion({
          bookId: chapter.book_id,
          chapterId: chapter.id,
          chapterNumber: chapter.chapter_number,
          text: params.text,
          sourceType: 'USER_EDIT',
        });
      } catch (e) {
        logger.warn('版本节点创建失败（保存已成功）', {
          chapterId: chapter.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { ...res, chapterId: chapter.id, version };
  },

  // ── M6：版本节点（§十三 §十四）──

  /**
   * 列出某章的版本（新的在前）。
   *
   * ⚠ 不返回正文内容：一章节几十个版本，全带上会让列表 IPC
   *   变成几百 KB 的传输，而列表只需要元信息。
   */
  'manuscript.listVersions': (params: { chapterId: string }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.get(params.chapterId);
    return {
      chapterId: chapter.id,
      versions: manuscriptRepo().listVersions(chapter.id),
    };
  },

  /**
   * §43 章节流水线进度：`Planning ✓ Writing ✓ Review ✓ Revision ● Continuity ○ Commit ○`
   *
   * ## ⚠ 数据来源必须是**产物事实**，不是任何"任务进度"字段
   *
   * 研究报告 §3.1 决策 1：状态由产物驱动，不由任务状态驱动。
   * 所以这里逐项检查**工作区里那个产物文件在不在**，以及章节行自己的状态。
   * 不看 workflows 表 —— 那会把"工作流跑到哪一步"当成"这一章写到哪一步"，
   * 两者不是一回事（用逐步按钮写出来的章节根本没有工作流记录）。
   *
   * | 显示步 | 判据 |
   * |---|---|
   * | Planning   | workspace/plan.json 存在 |
   * | Writing    | workspace/draft.md 存在 |
   * | Review     | workspace/review.json 存在 |
   * | Revision   | workspace/revision.md 存在 |
   * | Continuity | workspace/continuity.json 存在 |
   * | Commit     | chapters.status === 'COMMITTED' |
   *
   * ⚠ 缺文件与"有文件但坏了"要区分：产物文件解析失败会让整条流水线
   *   看起来"没做过"，所以这里用 `has()` 判存在性，不解析内容。
   */
  'manuscript.pipeline': (params: { chapterId: string }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.get(params.chapterId);

    const ws = new ChapterWorkspace({
      rootDir: p.dir,
      // ⚠ 按书隔离（P0-1）：用章节行自己的 book_id，不用"当前书"
      bookId: chapter.book_id,
      chapterNumber: chapter.chapter_number,
      logger: logger.child('workspace'),
    });

    // 顺序即 §43 的显示顺序
    const steps = [
      { id: 'planning', label: 'Planning', file: 'plan' as const },
      { id: 'writing', label: 'Writing', file: 'draft' as const },
      { id: 'review', label: 'Review', file: 'review' as const },
      { id: 'revision', label: 'Revision', file: 'revision' as const },
      { id: 'continuity', label: 'Continuity', file: 'continuity' as const },
    ];

    const committed = chapter.status === 'COMMITTED';

    // 第一个未完成的步骤 = 当前所处阶段（§43 用 ● 表示）
    const currentIndex = steps.findIndex((s) => !ws.has(s.file));

    const list = steps.map((s, i) => ({
      id: s.id,
      label: s.label,
      done: ws.has(s.file),
      // ⚠ 只有"前面的都完成了、它自己还没完成"的那一步才是 ●
      //   —— 否则中间缺一步会让后面每一步都显示成"进行中"
      current: !committed && currentIndex === i,
    }));
    list.push({
      id: 'commit',
      label: 'Commit',
      done: committed,
      current: !committed && currentIndex === -1,
    });

    return {
      chapterId: chapter.id,
      chapterNumber: chapter.chapter_number,
      status: chapter.status,
      committed,
      steps: list,
      /** 完成了几个（含 Commit）—— 给调用方做进度概览 */
      doneCount: list.filter((s) => s.done).length,
      total: list.length,
    };
  },

  /** 读某个版本的正文（用户点开某一版时调用） */
  /**
   * M7：取两个版本（或当前正文）的文本，供渲染层做段落对齐 + 词级染色。
   *
   * ## ⚠ 为什么返回**原文**而不是算好的 hunk
   *
   * diff 算法是**纯函数**，放在渲染层（`renderer/manuscript/diff.js`）。
   * 这样它可以被穷举测试（施工计划指定的验收方式），而 IPC 只负责取文本。
   * 若把算法搬到主进程，测试就得拉起整个 core 进程 —— 穷举测试会变得很贵，
   * 于是没人写，于是"只改一个词却被整段标红"（F7）这类缺陷查不出来。
   *
   * ## ⚠ `from` 的三形态
   *
   *   `{ versionId }` —— 与某个历史版本比
   *   `'current'`     —— 与**当前正文**比（最常见的用法：我这轮改了哪些）
   *   省略            —— 同 'current'
   *
   * `to` 同理。两边都可以是 versionId 或 'current'，所以能对比
   * 「v001 vs v003」「v002 vs 当前」等任意组合。
   *
   * ## ⚠ 文件缺失必须如实报告，不能当成空文本
   *
   * 版本文件可能被人工清理（§十四 明确版本可丢弃）。若把缺失当成空串，
   * diff 会显示成"整个版本被删光了" —— 而实际是文件不在了。
   * 两者对作者的含义完全不同：一个是"我改没了"，一个是"文件丢了"。
   */
  'manuscript.getDiff': (params: {
    chapterId: string;
    from?: string;
    to?: string;
  }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.get(params.chapterId);
    const repo = manuscriptRepo();

    const readSide = (ref: string | undefined) => {
      if (!ref || ref === 'current') {
        return {
          ref: 'current',
          text: repo.get(chapter.book_id, chapter.chapter_number),
          missing: false,
        };
      }
      const text = repo.readVersion(ref);
      return { ref, text, missing: text === null };
    };

    const from = readSide(params.from);
    const to = readSide(params.to);

    return {
      chapterId: chapter.id,
      chapterNumber: chapter.chapter_number,
      from: { ref: from.ref, text: from.text, missing: from.missing },
      to: { ref: to.ref, text: to.text, missing: to.missing },
      // ⚠ 任一侧缺失时**不假装**成空文本 —— 界面据此显示"文件缺失"
      //   而不是"内容被删光了"
      usable: !from.missing && !to.missing,
    };
  },

  'manuscript.readVersion': (params: { versionId: string }) => {
    requireProject();
    const text = manuscriptRepo().readVersion(params.versionId);
    if (text === null) {
      // ⚠ 文件缺失（可能被人工清理，§十四 明确版本可丢弃）——
      //   返回明确原因而不是抛错：抛错会让整个版本面板打不开。
      return { versionId: params.versionId, text: null, missing: true };
    }
    return { versionId: params.versionId, text, missing: false };
  },

  /**
   * 恢复到某个版本（§十三，用户显式动作）。
   *
   * ⚠ 恢复**不删除**中间版本 —— 作者恢复后往往还要再对比回来，
   *   删掉等于替用户做了不可逆的决定。
   */
  'manuscript.restoreVersion': (params: { versionId: string }) => {
    requireProject();
    const r = manuscriptRepo().restoreVersion(params.versionId);
    if (r === null) {
      throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, '版本不存在或内容文件缺失，无法恢复');
    }
    return {
      versionId: params.versionId,
      restoredFrom: r.restoredFrom,
      version: r.version,
      // ⚠ 恢复只改正文，**不碰 Canon**（§二 SAVE != COMMIT 同样适用）
      saved: r.saved,
      // ⚠ 按书读正文（P0-1）。优先用版本行自己的 bookId；老版本行没有
      //   该字段时退回 restoredFrom（同一个版本的另一种视图）。
      text: (() => {
        const bid = r.version.bookId ?? r.restoredFrom.bookId;
        if (bid === null) {
          throw new AppError(
            ErrorCode.WORKSPACE_CORRUPTED,
            `版本 ${params.versionId} 无法确定所属书，拒绝猜测`,
          );
        }
        return manuscriptRepo().get(bid, r.restoredFrom.chapterNumber);
      })(),
    };
  },

  /**
   * 自动保存（§八：由 main 进程 debounce 落盘）。
   *
   * ⚠ 写的是**旁路副本**，正式正文一个字节都不动（§十二 切章保护的前提）。
   *   autosave 由 main 而非 renderer 负责，是因为 renderer 崩溃
   *   （OOM / 页面异常）恰是最常见的丢失场景 —— 由它发起就救不了自己。
   */
  'manuscript.autosave': (params: {
    chapterId: string;
    text: string;
    cursor?: number;
    selectionStart?: number;
    selectionEnd?: number;
    scrollTop?: number;
  }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.get(params.chapterId);
    const repo = manuscriptRepo();
    const hasState =
      params.cursor !== undefined ||
      params.selectionStart !== undefined ||
      params.scrollTop !== undefined;
    const res = repo.autosave(
      chapter.book_id,
      chapter.chapter_number,
      params.text,
      hasState
        ? {
            cursor: params.cursor ?? 0,
            selectionStart: params.selectionStart ?? params.cursor ?? 0,
            selectionEnd: params.selectionEnd ?? params.cursor ?? 0,
            scrollTop: params.scrollTop ?? 0,
          }
        : undefined,
    );
    return { chapterId: chapter.id, chapterNumber: chapter.chapter_number, ...res };
  },

  /** 保存状态（§九）：dirty / 最后保存时间 / 是否有待恢复的 autosave */
  'manuscript.getSaveStatus': (params: { chapterId: string; editorText?: string }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.get(params.chapterId);
    const repo = manuscriptRepo();
    const st = repo.getSaveStatus(chapter.book_id, chapter.chapter_number, params.editorText);
    return { chapterId: chapter.id, ...st };
  },

  /** 检测未恢复的编辑内容（§十一）。⚠ 只检测，不改任何东西 */
  'manuscript.checkRecovery': (params: { chapterId: string }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.get(params.chapterId);
    const repo = manuscriptRepo();
    return {
      chapterId: chapter.id,
      chapterNumber: chapter.chapter_number,
      ...repo.checkRecovery(chapter.book_id, chapter.chapter_number),
    };
  },

  /**
   * 恢复自动保存（用户点「恢复」）。
   * ⚠ 必须由用户显式触发 —— §十一 明令"不要直接静默覆盖"。
   */
  'manuscript.recoverAutosave': (params: { chapterId: string }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.get(params.chapterId);
    const repo = manuscriptRepo();
    const res = repo.acceptAutosave(chapter.book_id, chapter.chapter_number);
    if (res === null) {
      return { chapterId: chapter.id, recovered: false, reason: '没有待恢复的编辑内容' };
    }
    return { ...res, chapterId: chapter.id, recovered: true };
  },

  /** 放弃自动保存（用户点「放弃」） */
  'manuscript.discardAutosave': (params: { chapterId: string }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.get(params.chapterId);
    manuscriptRepo().clearAutosave(chapter.book_id, chapter.chapter_number);
    return { chapterId: chapter.id, discarded: true };
  },

  /**
   * 文本度量（§二十八 / §二十九）。
   *
   * ⚠ 度量**必须**由这里算（core 的 `measureText`），不能在 renderer 里
   *   再写一遍计数。在 renderer 里数就是"第二套口径"——
   *   编辑器显示 4,328 字、章节目标判定 3,912 字，两个数字都"对"，
   *   但没人能解释差在哪。这类争议无解，因为它不是算法错。
   *
   * `text` 可选：传了就算传入的文本（编辑器里还没保存的当前内容），
   * 不传就算磁盘上的正文。
   */
  'manuscript.metrics': (params: { chapterId: string; text?: string }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.get(params.chapterId);
    const body = params.text ?? manuscriptRepo().get(chapter.book_id, chapter.chapter_number) ?? '';
    return { chapterId: chapter.id, ...measureText(body) };
  },

  /**
   * 编辑器状态（光标 / 选区 / 滚动位置，§十一）。
   * 单独一个入口而不是塞进 autosave 的返回值：恢复时要**先拿到状态再渲染**，
   * 而 autosave 的返回值只在"刚保存完"那一刻有意义。
   */
  'manuscript.getEditorState': (params: { chapterId: string }) => {
    const p = requireProject();
    const chapter = p.repos.chapters.get(params.chapterId);
    return {
      chapterId: chapter.id,
      state: manuscriptRepo().readEditorState(chapter.book_id, chapter.chapter_number),
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
    const bookId = requireBookId(params.bookId);

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
          sourceRef: c.body_path ?? chapterRel(bookId, c.chapter_number),
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
      // ⚠ 按书隔离（P0-1）：用章节行自己的 book_id，不用"当前书"
      bookId: chapter.book_id,
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
      // ⚠ 按书隔离（P0-1）：用章节行自己的 book_id，不用"当前书"
      bookId: chapter.book_id,
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
      // ⚠ 按书隔离（P0-1）：用章节行自己的 book_id，不用"当前书"
      bookId: chapter.book_id,
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
      sourceRef: chapterRel(chapter.book_id, chapter.chapter_number),
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
    const bookId = requireBookId(params.bookId);
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
  'commit.run': async (params: {
    chapterId: string;
    /** FORCE 显式绕过硬性前置检查（会写审计记录） */
    commitMode?: 'clean' | 'with_debt' | 'FORCE';
    forceReason?: string;
  }) => {
    const p = requireProject();
    const input: { chapterId: string; commitMode?: 'clean' | 'with_debt' | 'FORCE'; forceReason?: string } = {
      chapterId: params.chapterId,
    };
    if (params.commitMode) input.commitMode = params.commitMode;
    if (params.forceReason) input.forceReason = params.forceReason;
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
    const bookId = requireBookId(params.bookId);

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
    const bookId = requireBookId(params.bookId);
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
      // ⚠ 按书隔离（P0-1）：用章节行自己的 book_id，不用"当前书"
      bookId: chapter.book_id,
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
      // ⚠ P1：纯长度超限时，候选摘要**不丢弃** —— 存下来让作者删两句再用。
      //   此前直接 return ok:false，摘要内容随之消失，而作者无路可走：
      //   重新生成可能同样超长、approve 因 summary 为 null 抛错、UI 无手写
      //   入口、commit 要求 approved=1 → 该章永久无法提交。
      //   内容本身是有价值的（只是长了几个百分点），让作者编辑比逼他重跑合理。
      //   存的是**候选**（summary_approved 仍为 0），确认仍须经 approve。
      if (res.rejectedCandidate) {
        p.repos.chapters.setSummaryCandidate(chapter.id, res.rejectedCandidate.summary);
        return {
          ok: false,
          error: res.error ?? { code: ErrorCode.MODEL_STRUCTURED_EMPTY, message: '摘要生成失败' },
          /**
           * 已保留超长候选，作者可编辑后确认。
           * ⚠ 与 error 并存：调用方既要能报错，也要知道"有可编辑的草稿"。
           */
          salvaged: true,
          candidate: res.rejectedCandidate.summary,
          maxChars: DEFAULT_SUMMARY_MAX_CHARS,
        };
      }
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
    // ⚠ 预算检查在 repos.chapters.approveSummary 内部（真正的收口处，
    //   换调用方也绕不过）。这里不重复实现，避免两处阈值漂移。
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

    // ⚠ 更新已存在的 profile 时**保持原位置**，不能"删掉再追加"。
    //
    //   原来的 `[...filter(id !== next.id), next]` 会把被编辑的 profile
    //   挪到数组末尾。渲染端 prefill 取 `profiles[0]`，于是用户改完
    //   profile A 点保存后，表单会跳到 profile B —— 看起来像"我的修改
    //   保存到了别的 profile 上"，或者"刚填的东西被覆盖了"。
    //   实测：A、B 两个 profile，编辑 A 保存 → 表单显示 B。
    const prev = existing?.profiles ?? [];
    const at = prev.findIndex((x) => x.id === next.id);
    const profiles =
      at >= 0
        ? prev.map((x, i) => (i === at ? next : x))   // 原位替换
        : [...prev, next];                            // 新增才追加
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
   * 伏笔列表（§41 导航「伏笔」入口；施工文档 §42 页面清单）。
   *
   * ⚠ 此前只有仓储、**没有任何 IPC** —— 后端建好了但 UI 够不到，
   *   与 `character.create`（存储层完整、工具缺失）、`detectProseIssues`
   *   （写了没接线）是同一类缺陷：底层齐备，使用者看不见。
   */
  'foreshadow.list': (params: { bookId?: string }) => {
    const p = requireProject();
    const bookId = requireBookId(params.bookId);
    const rows = p.repos.foreshadowing.listByBook(bookId);
    return {
      bookId,
      count: rows.length,
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        tier: r.tier,
        importance: r.importance,
        setupChapter: r.setup_chapter,
        expectedPayoffChapter: r.expected_payoff_chapter,
        description: r.description,
        updatedAt: r.updated_at,
      })),
    };
  },

  /**
   * 推进伏笔状态（§41 伏笔入口的**唯一**写操作）。
   *
   * ⚠ 合法性由仓储的六态机判定，非法推进抛错而不是静默接受 ——
   *   伏笔账目失真属于"事后最难修复"的数据，静默接受会让它悄悄烂掉。
   *   这里**不重复实现**状态机，只把仓储的判断透出去。
   */
  'foreshadow.advance': (params: {
    foreshadowId: string;
    to: 'PLANNED' | 'PLANTED' | 'DEVELOPING' | 'READY' | 'PAID_OFF' | 'ABANDONED';
    chapter?: number;
  }) => {
    const p = requireProject();
    const row = p.repos.foreshadowing.advance(
      params.foreshadowId,
      params.to,
      params.chapter === undefined ? {} : { chapter: params.chapter },
    );
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      updatedAt: row.updated_at,
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
    const bookId = requireBookId(params.bookId);
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

  /** ⚠ 仅测试用（见下方注释）：GUI 验证流程注入审阅结论 */
  'review.__seed': (params: { chapterId: string; review: unknown; status: string }) =>
    seedReviewForFlow(params),
};

/**
 * ⚠ 仅测试用：注入一份审阅结论（**只允许在 GUI 验证流程里启用**）。
 *
 * ## 为什么必须有这个口子
 *
 * M8（点 Issue 定位到正文）的验收要求"真点 Issue → 断言编辑器选区命中"。
 * 但审阅结论只能由 `review.run` 产出，而它要真实调用模型 ——
 * GUI 验证脚本刻意把模型路径指向不存在的文件（避免消耗配额、
 * 拖慢、引入超时假失败），所以流程里**永远拿不到**一份带 location 的结论。
 *
 * 两条死路都试过，都不通：
 *   ① 直接改 `window.nwa` 注入假数据 —— preload 用 `contextBridge`，
 *      暴露的对象在页面里是冻结的（改不动，静默失败）。
 *   ② 直接写 project.db 的 `chapters.review_json` —— 库开着 WAL，
 *      外部进程的写不一定被运行中的应用看见，结果不稳定。
 *
 * 所以走这条路：由主进程自己写。它不是"测试后门绕过生产路径"——
 * 写入用的是生产仓储 `chapters.saveReview`（与 `review.run` 同一个方法），
 * 写入之后**所有读取路径都是真的**：`review.get` → 渲染 → 点击 → 定位。
 * 被替换掉的只有"模型产出一份结论"这一步，而那一步与 M8 无关。
 *
 * ⚠ 用 `NWA_GUI_FLOW` 而不是另立环境变量：这个能力**只在验证流程里**有意义，
 *   复用一个开关就少一个能被误开的口子。生产启动时该变量不存在。
 */
function seedReviewForFlow(params: { chapterId: string; review: unknown; status: string }): {
  ok: true;
} {
  if (process.env['NWA_GUI_FLOW'] !== '1') {
    throw new AppError(
      ErrorCode.TOOL_VALIDATION_ERROR,
      'review.__seed 仅在 GUI 验证流程（NWA_GUI_FLOW=1）中可用',
    );
  }
  const p = requireProject();
  // ⚠ 用生产仓储写入，不直接写库 —— 否则"写入成功但读取路径不认"
  //   这类问题会被验证掩盖
  p.repos.chapters.saveReview(params.chapterId, params.review, params.status);
  return { ok: true };
}

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
  for (const tool of createAllTools(repos, {
      logger: logger.child('tools'),
      planGate: { assertGateOpen: (bookId) => assertBlueprintGateForTool(repos, bookId) },
    })) {
      tools.register(tool);
    }
  const events = new EventBus({ runs: repos.runs, logger: logger.child('events') });
  const bootFts = new FtsIndex({ db, tokenizer: bigramTokenizer, logger: logger.child('fts') });
  // ⚠ services 由 buildWorkflowEngine 填充（同一理由：避免建两份）
  const project = {
    dir: PROJECTS_ROOT,
    db,
    repos,
    tools,
    events,
    runtime: null,
    fts: bootFts,
  } as OpenProject;
  project.runtime = buildRuntime(project);
  // ⚠ 同 project.open：runtime 先建，services 才能拿到模型网关
  project.services = createWorkflowServicesFor(project);
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
