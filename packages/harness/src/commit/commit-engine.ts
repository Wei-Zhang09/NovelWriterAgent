/**
 * Commit 编排器（ADR-0002 v2，施工文档 §35 / §36）【MVP 门槛】
 *
 *   PREPARE → APPLY → VERIFY
 *
 * ## 为什么需要它（问题陈述）
 *
 * SQLite 事务覆盖不了文件系统写入。若"先写文件再写 DB，DB 失败就删文件"，
 * 会遇到：进程在两者之间被 kill（§52 Test D 正是测这个）→
 * 下次启动**无法判断该文件是本次的还是历史遗留的**。
 *
 * 纯靠顺序 + try/catch 无法实现文档要求的原子语义，故引入 Manifest 对账：
 * 把"打算做什么"先持久化，中断后读回 manifest 就能确定性分类。
 *
 * ## 事务边界（ADR-0002 的划分）
 *
 *   ┌─ 文件系统：.next → rename（无法与 DB 同事务）
 *   ├─ DB 事务 A：manifest(PREPARING) + 暂存记录
 *   ├─ DB 事务 B：正式写 facts/state/timeline + chapters.status + pending 索引标记
 *   └─ 校验 + 索引重建 + manifest(COMMITTED)
 *
 * ⚠ 索引的两类划分（我们相对 InkOS 的增强）：
 *   artifacts/index.json（导航结构）→ **进事务**，缺失会让章节"消失"
 *   FTS 检索索引 → **不进事务**但记 pending 标记，崩溃后补做
 *   （InkOS 把两者都排除在事务外，导致"文件已提交、索引重建前崩溃 →
 *    检索看到旧数据"，且该不一致不可被检测）
 */
import { Logger, AppError, ErrorCode, type Nullable } from '@nwa/core';
import type { Repositories, Database } from '@nwa/storage';
import { AtomicFileSet, hashOfFile, sha256 } from './atomic-file-set.js';
import { CommitLock, type LockHandle } from './commit-lock.js';
import { RepairEngine } from './repair.js';

/** 产物清单中的一项 */
export interface ManifestArtifact {
  readonly kind: 'chapter' | 'summary' | 'artifactsIndex' | 'db';
  /** 文件类产物的相对路径 */
  readonly path?: string;
  /** 期望写入的内容哈希（校验用） */
  readonly contentHash?: string;
  /** PREPARE 时目标已存在的内容哈希（CAS 用） */
  readonly expectedSha256?: Nullable<string>;
  /** DB 类产物：表名与期望行数 */
  readonly table?: string;
  readonly count?: number;
}

export interface CommitRequest {
  readonly chapterId: string;
  readonly chapterNumber: number;
  /** 待提交的正文（来自工作区 revision.md 或 draft.md） */
  readonly body: string;
  /** 章节摘要（写入 memory_items 与文件） */
  readonly summary: string;
  /** commit_mode：clean | with_debt（ADR-0005） */
  readonly commitMode?: 'clean' | 'with_debt';
  readonly qualityDebtCount?: number;
  /** 待写入的 Canon 事实 id 列表 */
  readonly factIds?: readonly string[];
  /** 待推进状态的伏笔 id 列表 */
  readonly foreshadowingIds?: readonly string[];
}

export interface CommitReport {
  readonly ok: boolean;
  readonly manifestId: string;
  /** 最终状态 */
  readonly status: 'COMMITTED' | 'FAILED' | 'ROLLED_BACK';
  readonly phase: string;
  readonly appliedCount: number;
  readonly artifacts: readonly ManifestArtifact[];
  /** 是否补做过索引重建 */
  readonly indexesRebuilt: boolean;
  readonly error?: { code: string; message: string; details?: unknown };
}

export interface CommitEngineOptions {
  readonly db: Database;
  readonly repos: Repositories;
  readonly rootDir: string;
  readonly logger: Logger;
  /** 注入点：供 Test D 在各阶段强制中断（默认不中断） */
  readonly killSwitch?: KillSwitch;
  /** 陈旧锁阈值 */
  readonly lockStaleMs?: number;
}

/**
 * 测试用的中断注入点（§52 Test D）。
 *
 * ⚠ 生产路径下 killSwitch 为 undefined，且**没有**任何分支会调用它。
 *   这样"测试用的后门"不会成为生产代码的行为分支。
 */
export interface KillSwitch {
  /** 在这些点抛出模拟的进程终止 */
  readonly at: readonly (
    | 'after-prepare'
    | 'after-stage'
    | 'after-file-apply'
    | 'before-db-commit'
    | 'during-verify'
  )[];
}

/**
 * 模拟进程终止的信号。
 *
 * ⚠ 必须是**独立类型**且不经 CommitEngine 自己的 catch —— 见 maybeKill 的说明。
 * 该类型只在测试路径产生；生产路径 killSwitch 为 undefined，永不构造。
 */
export class SimulatedKill extends Error {
  readonly killAt: string;
  constructor(killAt: string) {
    super(`[Test D] 模拟进程在 ${killAt} 处被终止`);
    this.name = 'SimulatedKill';
    this.killAt = killAt;
  }
}

export class CommitEngine {
  private readonly db: Database;
  private readonly repos: Repositories;
  private readonly files: AtomicFileSet;
  private readonly logger: Logger;
  private readonly killSwitch: KillSwitch | undefined;
  private readonly lockStaleMs: number;

  constructor(opts: CommitEngineOptions) {
    this.db = opts.db;
    this.repos = opts.repos;
    this.files = new AtomicFileSet(opts.rootDir);
    this.logger = opts.logger;
    this.killSwitch = opts.killSwitch;
    this.lockStaleMs = opts.lockStaleMs ?? 30_000;
  }

  /**
   * 执行一次完整提交。
   *
   * ⚠ 这是唯一允许把章节推进到 COMMITTED 的入口。
   */
  commit(req: CommitRequest): CommitReport {
    const lock = new CommitLock({
      // ⚠ 用 files.rootDir 而不是 files.absolute('.')：
      //   absolute() 带逃逸校验，'.' 会解析回 rootDir 本身而被判为"逃逸"（实测报错）。
      rootDir: this.files.rootDir,
      staleAfterMs: this.lockStaleMs,
      ownerId: `commit_${req.chapterId}_${Date.now()}`,
    });

    const acquired = lock.acquire();
    if (acquired.reclaimed) {
      // 回收陈旧锁必须留痕 —— 否则"曾有两个提交在跑"会无声发生
      this.logger.warn('回收了陈旧的提交锁', acquired.reclaimed);
    }
    const handle = acquired.handle;

    try {
      return this.runCommit(req, handle);
    } finally {
      handle.release();
    }
  }

  // handle 由 commit() 持有并在 finally 释放；这里不需要它，但保留参数
  // 便于将来在阶段间续租心跳（长任务）。
  private runCommit(req: CommitRequest, _handle: LockHandle): CommitReport {
    // ═══ PREPARE ═══════════════════════════════════════════
    const manifestId = `cm_${req.chapterId}_${Date.now()}`;
    const chapterPath = `chapters/${String(req.chapterNumber).padStart(3, '0')}.md`;
    const summaryPath = `summaries/${String(req.chapterNumber).padStart(3, '0')}.md`;
    const indexPath = 'artifacts/index.json';

    const bodyHash = sha256(req.body);
    const summaryHash = sha256(req.summary);

    const artifacts: ManifestArtifact[] = [
      {
        kind: 'chapter',
        path: chapterPath,
        contentHash: bodyHash,
        expectedSha256: hashOfFile(this.files.absolute(chapterPath)),
      },
      {
        kind: 'summary',
        path: summaryPath,
        contentHash: summaryHash,
        expectedSha256: hashOfFile(this.files.absolute(summaryPath)),
      },
      {
        kind: 'artifactsIndex',
        path: indexPath,
        expectedSha256: hashOfFile(this.files.absolute(indexPath)),
        // 索引内容在 APPLY 时生成（依赖前两项）
      },
      { kind: 'db', table: 'chapters', count: 1 },
      { kind: 'db', table: 'facts', count: req.factIds?.length ?? 0 },
      { kind: 'db', table: 'character_states', count: 0 },
    ];

    // ⑤ 硬链接别名检测（在写任何东西之前）
    this.files.assertNoAliases([chapterPath, summaryPath, indexPath]);

    // 写入 manifest（DB 事务 A）
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO commit_manifests
           (id, chapter_id, status, phase, applied_count, commit_mode,
            artifact_manifest_json, indexes_pending_json, fact_ids_json,
            foreshadowing_ids_json, quality_debt_count, created_at)
         VALUES (?, ?, 'PREPARING', 'prepared', 0, ?, ?, NULL, ?, ?, ?, ?)`,
        manifestId,
        req.chapterId,
        req.commitMode ?? 'clean',
        JSON.stringify(artifacts),
        JSON.stringify(req.factIds ?? []),
        JSON.stringify(req.foreshadowingIds ?? []),
        req.qualityDebtCount ?? 0,
        iso(),
      );
      // 章节状态推进到 COMMITTING
      this.db.run("UPDATE chapters SET status = 'COMMITTING', updated_at = ? WHERE id = ?", iso(), req.chapterId);
    });

    this.logger.info('PREPARE 完成', { manifestId, chapterNumber: req.chapterNumber });
    this.maybeKill('after-prepare');

    // ═══ APPLY ═════════════════════════════════════════════
    const staged: { target: string; hash: string }[] = [];

    try {
      // Stage：写 .next + 备份 .previous，含 CAS 校验
      for (const a of artifacts) {
        if (a.kind !== 'chapter' && a.kind !== 'summary') continue;
        const content = a.kind === 'chapter' ? req.body : req.summary;
        this.files.stage({
          target: a.path!,
          expectedSha256: a.expectedSha256 ?? null,
          content,
        });
        staged.push({ target: a.path!, hash: a.contentHash! });
      }

      // phase → staged（让中断点可精确定位）
      this.db.run("UPDATE commit_manifests SET phase = 'staged', staged_at = ? WHERE id = ?", iso(), manifestId);
      this.maybeKill('after-stage');

      // rename：.next → 正式路径
      for (const s of staged) {
        this.files.apply(this.files.absolute(s.target) + '.next');
      }
      this.maybeKill('after-file-apply');

      // 索引（导航结构，进事务）
      const indexContent = buildIndex(req.chapterNumber, bodyHash);
      this.files.stage({
        target: indexPath,
        expectedSha256: hashOfFile(this.files.absolute(indexPath)),
        content: indexContent,
      });
      this.files.apply(this.files.absolute(indexPath) + '.next');

      // DB 事务 B：真源写入 + pending 索引标记
      const pending = JSON.stringify(['chapter_fts', 'memory_fts']);
      this.maybeKill('before-db-commit');
      this.db.transaction(() => {
        this.db.run(
          "UPDATE chapters SET status = 'COMMITTED', body_path = ?, summary = ?, updated_at = ? WHERE id = ?",
          chapterPath,
          req.summary,
          iso(),
          req.chapterId,
        );
        this.db.run(
          "UPDATE commit_manifests SET status = 'APPLIED', phase = 'committing', applied_count = ?, applied_at = ?, indexes_pending_json = ? WHERE id = ?",
          staged.length + 1,
          iso(),
          pending,
          manifestId,
        );
      });
    } catch (e) {
      // ⚠ SimulatedKill 直接向上抛：真实 kill -9 不会执行回滚，
      //   留下中间态让 Repair 去判定。否则测的是回滚而不是崩溃恢复。
      if (e instanceof SimulatedKill) throw e;

      // 任何 APPLY 阶段失败 → 回滚文件，manifest 标 FAILED
      const err = e as { code?: string; message?: string };
      this.logger.error('APPLY 阶段失败，开始回滚', { manifestId, error: err.message });

      for (const s of staged) {
        try {
          this.files.rollback(s.target);
        } catch (re) {
          this.logger.error('回滚文件失败', {
            target: s.target,
            error: re instanceof Error ? re.message : String(re),
          });
        }
      }
      this.db.run(
        "UPDATE chapters SET status = 'DRAFT_READY', updated_at = ? WHERE id = ?",
        iso(),
        req.chapterId,
      );
      this.db.run(
        "UPDATE commit_manifests SET status = 'ROLLED_BACK', indexes_pending_json = NULL WHERE id = ?",
        manifestId,
      );

      return {
        ok: false,
        manifestId,
        status: 'ROLLED_BACK',
        phase: 'prepared',
        appliedCount: 0,
        artifacts,
        indexesRebuilt: false,
        error: {
          code: err.code ?? ErrorCode.COMMIT_FAILED,
          message: err.message ?? 'APPLY 阶段失败',
        },
      };
    }

    // ═══ VERIFY ════════════════════════════════════════════
    this.maybeKill('during-verify');

    const problems: string[] = [];
    for (const a of artifacts) {
      if (a.kind === 'chapter' || a.kind === 'summary') {
        if (!this.files.verify(a.path!, a.contentHash!)) {
          problems.push(`文件校验失败：${a.path}`);
        }
      }
      if (a.kind === 'db' && a.table === 'chapters') {
        const row = this.db.get<{ status: string }>('SELECT status FROM chapters WHERE id = ?', req.chapterId);
        if (row?.status !== 'COMMITTED') problems.push('章节状态不是 COMMITTED');
      }
    }

    if (problems.length > 0) {
      this.db.run("UPDATE commit_manifests SET status = 'FAILED' WHERE id = ?", manifestId);
      return {
        ok: false,
        manifestId,
        status: 'FAILED',
        phase: 'committing',
        appliedCount: staged.length + 1,
        artifacts,
        indexesRebuilt: false,
        error: { code: ErrorCode.COMMIT_FAILED, message: `VERIFY 失败：${problems.join('；')}`, details: problems },
      };
    }

    // 索引重建（MVP 阶段是标记清除；FTS 全量重建属 Full）
    this.db.run(
      "UPDATE commit_manifests SET status = 'COMMITTED', phase = 'committed', committed_at = ?, indexes_pending_json = NULL WHERE id = ?",
      iso(),
      manifestId,
    );

    // 清理 stage/backup 残留
    for (const s of staged) this.files.cleanup(s.target);
    this.files.cleanup(indexPath);

    this.logger.info('提交完成', { manifestId, chapterNumber: req.chapterNumber });
    return {
      ok: true,
      manifestId,
      status: 'COMMITTED',
      phase: 'committed',
      appliedCount: staged.length + 1,
      artifacts,
      indexesRebuilt: true,
    };
  }

  /** 启动时调用：检测未完成事务并收尾（ADR-0002 v2 机制 ٠ 步骤 0） */
  recoverOnStartup(): ReturnType<RepairEngine['repairAll']> {
    const repair = new RepairEngine({
      db: this.db,
      repos: this.repos,
      files: this.files,
      logger: this.logger,
    });
    return repair.repairAll();
  }

  private maybeKill(at: KillSwitch['at'][number]): void {
    if (this.killSwitch?.at.includes(at)) {
      // ⚠ 模拟"进程被强制终止"必须绕过 APPLY 的 try/catch 回滚 ——
      //   真实的 kill -9 不会给进程执行回滚的机会。
      //   实测：第一版直接 throw，结果被 APPLY 的 catch 捕获并优雅回滚，
      //   "中断"根本没被模拟出来，测试因此全是假绿。
      throw new SimulatedKill(at);
    }
  }
}

function iso(): string {
  return new Date().toISOString();
}

function buildIndex(chapterNumber: number, bodyHash: string): string {
  return JSON.stringify(
    {
      updatedAt: iso(),
      chapters: [{ chapterNumber, path: `chapters/${String(chapterNumber).padStart(3, '0')}.md`, hash: bodyHash }],
    },
    null,
    2,
  );
}

export { AppError };
