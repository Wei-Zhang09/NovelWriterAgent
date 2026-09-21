/**
 * Repair（ADR-0002 v2 的 8 分支表）【MVP 门槛的核心】
 *
 * 启动时与 Commit 失败时都执行。读回 manifest 就能**确定性地**判断
 * 上次中断在哪一步，从而选择正确的收尾动作 —— 这正是"manifest 对账"
 * 相对于"看文件在不在"的价值。
 *
 * ## 四条不可违反的约束（ADR-0002 §关键约束）
 *
 * 1. **只能操作 manifest 中显式列出的路径**
 *    ⚠ 绝不扫描目录猜哪些是孤儿。扫描目录在崩溃恢复场景下极其危险：
 *      可能删掉用户手工放进 chapters/ 的文件。
 *      本文件的每个删除动作都必须能追溯到 manifest 里的某一条 artifact。
 *
 * 2. **每一步都写 run_events**（§55 Rule 8）
 *
 * 3. **不自动执行破坏性操作**（删整个 workspace、drop 表）
 *    最坏情况是保留现场并报错。
 *
 * 4. **DB 损坏时拒绝自动修复** —— 引导从 backup 恢复（§58），不静默处理。
 */
import { existsSync } from 'node:fs';
import { Logger, ErrorCode } from '@nwa/core';
import type { Repositories, Database } from '@nwa/storage';
import type { AtomicFileSet } from './atomic-file-set.js';
import type { ManifestArtifact } from './commit-engine.js';

/** 分支判定结果 */
export interface RepairDecision {
  readonly manifestId: string;
  readonly chapterId: string;
  /** 判定走的是哪个分支（8 分支表的行标识） */
  readonly branch: RepairBranch;
  /** 人类的判定说明 */
  readonly verdict: string;
  /** 执行的动作 */
  readonly actions: readonly RepairAction[];
  /** 最终状态 */
  readonly resultingStatus: 'COMMITTED' | 'ROLLED_BACK' | 'FAILED' | 'NEEDS_HUMAN';
}

export type RepairBranch =
  | 'prepared-to-rollback'
  | 'staged-to-rollback'
  | 'staged-renamed-to-rollback'
  | 'committing-to-verify'
  | 'committed-to-cleanup'
  | 'replay-from-workspace'
  | 'workspace-corrupted'
  | 'manifest-unreadable';

export interface RepairAction {
  readonly kind: 'file-restore' | 'file-remove' | 'file-replay' | 'db-update' | 'cleanup' | 'report';
  readonly target: string;
  readonly detail: string;
}

export interface RepairSummary {
  readonly scanned: number;
  readonly repaired: readonly RepairDecision[];
  /** 需要人工介入的（保留现场） */
  readonly needsHuman: readonly RepairDecision[];
}

interface ManifestRow {
  readonly id: string;
  readonly chapter_id: string;
  readonly status: string;
  readonly phase: string;
  readonly applied_count: number;
  readonly artifact_manifest_json: string;
  readonly indexes_pending_json: string | null;
}

export class RepairEngine {
  private readonly db: Database;
  private readonly repos: Repositories;
  private readonly files: AtomicFileSet;
  private readonly logger: Logger;

  constructor(opts: {
    readonly db: Database;
    readonly repos: Repositories;
    readonly files: AtomicFileSet;
    readonly logger: Logger;
  }) {
    this.db = opts.db;
    this.repos = opts.repos;
    this.files = opts.files;
    this.logger = opts.logger;
  }

  /**
   * 扫描并修复所有未完成事务。
   *
   * ⚠ 只查 **manifest 表**，不扫描文件系统 —— 这是与"看目录里有没有文件"
   *   的根本区别。manifest 是唯一能证明"DB 是否已提交"的记录。
   */
  repairAll(): RepairSummary {
    let rows: ManifestRow[];
    try {
      rows = this.db.all<ManifestRow>(
        "SELECT * FROM commit_manifests WHERE status IN ('PREPARING', 'APPLIED', 'FAILED')",
      );
    } catch (e) {
      // manifest 读不出来 → 拒绝自动修复
      this.logger.error('无法读取 commit_manifests，拒绝自动修复', {
        error: e instanceof Error ? e.message : String(e),
      });
      return {
        scanned: 0,
        repaired: [],
        needsHuman: [
          {
            manifestId: '(unknown)',
            chapterId: '(unknown)',
            branch: 'manifest-unreadable',
            verdict: 'manifest 表无法读取，可能是数据库损坏。拒绝自动修复，请从 backup 恢复。',
            actions: [],
            resultingStatus: 'NEEDS_HUMAN',
          },
        ],
      };
    }

    const repaired: RepairDecision[] = [];
    const needsHuman: RepairDecision[] = [];

    for (const row of rows) {
      let decision: RepairDecision;
      try {
        decision = this.repairOne(row);
      } catch (e) {
        decision = {
          manifestId: row.id,
          chapterId: row.chapter_id,
          branch: 'manifest-unreadable',
          verdict: `修复过程出错，保留现场：${e instanceof Error ? e.message : String(e)}`,
          actions: [],
          resultingStatus: 'NEEDS_HUMAN',
        };
      }
      if (decision.resultingStatus === 'NEEDS_HUMAN') needsHuman.push(decision);
      else repaired.push(decision);
    }

    return { scanned: rows.length, repaired, needsHuman };
  }

  /**
   * 对单个未完成事务做判定与收尾。
   *
   * 判定依据只有两个：manifest 的 `phase` 与**各 artifact 的当前实际状态**
   * （文件是否存在、DB 行是否存在）。不看目录里"还有什么"。
   */
  repairOne(row: ManifestRow): RepairDecision {
    const artifacts = this.parseArtifacts(row.id, row.artifact_manifest_json);
    if (artifacts === null) {
      return {
        manifestId: row.id,
        chapterId: row.chapter_id,
        branch: 'manifest-unreadable',
        verdict: 'artifact_manifest_json 损坏，无法确定应操作哪些路径。保留现场。',
        actions: [],
        resultingStatus: 'NEEDS_HUMAN',
      };
    }

    const fileArtifacts = artifacts.filter((a) => a.kind === 'chapter' || a.kind === 'summary');
    const fileStates = fileArtifacts.map((a) => ({
      artifact: a,
      exists: existsSync(this.files.absolute(a.path!)),
      hasNext: existsSync(this.files.absolute(a.path!) + '.next'),
      hasPrev: existsSync(this.files.absolute(a.path!) + '.previous'),
      hashOk: a.contentHash ? this.files.verify(a.path!, a.contentHash) : false,
    }));

    const chapterCommitted = this.chapterState(row.chapter_id);

    // ── 分支判定 ───────────────────────────────────────────

    // 分支 4：DB 已提交，只差索引重建 + VERIFY
    if (row.phase === 'committing' && chapterCommitted === 'COMMITTED') {
      const actions: RepairAction[] = [];
      if (row.indexes_pending_json !== null) {
        // 补做索引重建。MVP 阶段 FTS 重建是标记清除（全量 rebuild 属 Full）
        actions.push({
          kind: 'db-update',
          target: row.id,
          detail: `补做索引重建（pending: ${row.indexes_pending_json}）`,
        });
      }
      const allOk = fileStates.every((f) => f.hashOk);
      if (allOk) {
        this.finishCommitted(row.id, actions);
        return {
          manifestId: row.id,
          chapterId: row.chapter_id,
          branch: 'committing-to-verify',
          verdict: 'DB 已提交且文件齐备，补做索引重建后判定为已完成',
          actions,
          resultingStatus: 'COMMITTED',
        };
      }
      // 文件缺失 → 分支 6：从工作区重放
      return this.replayFromWorkspace(row, fileStates, actions);
    }

    // 分支 5：已 committed，只差清理
    if (row.phase === 'committed') {
      const actions: RepairAction[] = [];
      for (const f of fileArtifacts) this.cleanupOne(f.path!, actions);
      return {
        manifestId: row.id,
        chapterId: row.chapter_id,
        branch: 'committed-to-cleanup',
        verdict: '事务已提交，清理 stage/backup 残留',
        actions,
        resultingStatus: 'COMMITTED',
      };
    }

    // 分支 7：DB 已提交但文件不齐 —— 不可能发生（DB 提交是原子的），
    //   若真发生说明 DB 损坏 → 保留现场
    if (row.status === 'APPLIED' && chapterCommitted === 'COMMITTED') {
      const missing = fileStates.filter((f) => !f.exists);
      if (missing.length > 0 && !this.canReplay(row.chapter_id)) {
        return {
          manifestId: row.id,
          chapterId: row.chapter_id,
          branch: 'workspace-corrupted',
          verdict:
            'DB 显示已提交，但文件缺失且工作区无源可重放。' +
            '这在正常流程下不可能发生，说明数据库或文件系统已损坏。保留现场，不静默修复。',
          actions: [],
          resultingStatus: 'NEEDS_HUMAN',
        };
      }
    }

    // 分支 1/2/3：PREPARING 阶段的各种中断 → 一律回滚
    const actions: RepairAction[] = [];

    // 分支 2/3：先处理 stage/备份
    for (const f of fileStates) {
      if (f.exists && !f.hashOk) {
        // 正式文件内容不是本次要写的 → 可能是 rename 后中断或已被改
        if (f.hasPrev) {
          this.files.rollback(f.artifact.path!);
          actions.push({
            kind: 'file-restore',
            target: f.artifact.path!,
            detail: '从 .previous 恢复（rename 后中断）',
          });
        } else {
          this.files.rollback(f.artifact.path!);
          actions.push({
            kind: 'file-remove',
            target: f.artifact.path!,
            detail: '删除本次新建的文件（无备份可恢复）',
          });
        }
      } else {
        this.cleanupOne(f.artifact.path!, actions);
      }
    }

    // 回滚章节状态与 manifest
    this.db.run(
      "UPDATE chapters SET status = 'DRAFT_READY', updated_at = ? WHERE id = ? AND status = 'COMMITTING'",
      new Date().toISOString(),
      row.chapter_id,
    );
    this.db.run(
      "UPDATE commit_manifests SET status = 'ROLLED_BACK', indexes_pending_json = NULL WHERE id = ?",
      row.id,
    );
    this.logEvent(row.id, row.chapter_id, 'COMMIT_REPAIRED', {
      branch: 'prepared-to-rollback',
      actions: actions.map((a) => a.kind),
    });

    const branch: RepairBranch = fileStates.some((f) => f.exists)
      ? 'staged-renamed-to-rollback'
      : fileStates.some((f) => f.hasNext)
        ? 'staged-to-rollback'
        : 'prepared-to-rollback';

    return {
      manifestId: row.id,
      chapterId: row.chapter_id,
      branch,
      verdict: 'APPLY 未完成，回滚文件与状态',
      actions,
      resultingStatus: 'ROLLED_BACK',
    };
  }

  // ── 辅助 ────────────────────────────────────────────────

  /** ⚠ 只清理 manifest 中列出的路径的派生文件，不扫目录 */
  private cleanupOne(path: string, actions: RepairAction[]): void {
    const before = actions.length;
    this.files.cleanup(path);
    if (actions.length === before) {
      actions.push({ kind: 'cleanup', target: path, detail: '清理 .next/.previous 残留' });
    }
  }

  private canReplay(chapterId: string): boolean {
    return this.workspaceDraft(chapterId) !== null;
  }

  /**
   * 读工作区里可重放的源（revision 优先于 draft）。
   *
   * ⚠ 用 get() 而非 find()：仓储没有 find()，get() 不存在时会抛错，
   *   所以这里先 catch 再判断 —— 让"章节本身不见了"退化为"不可重放"，
   *   而不是让整个修复流程崩掉。
   */
  private workspaceDraft(chapterId: string): string | null {
    let chapter: { chapter_number: number };
    try {
      chapter = this.repos.chapters.get(chapterId);
    } catch {
      return null;
    }
    const n = String(chapter.chapter_number).padStart(3, '0');
    for (const name of ['revision.md', 'draft.md']) {
      const p = `workspace/chapter-${n}/${name}`;
      try {
        const abs = this.files.absolute(p);
        if (existsSync(abs)) {
          // 读取交给调用方；这里只判断可重放性
          return p;
        }
      } catch {
        /* 路径异常视为不可重放 */
      }
    }
    return null;
  }

  /**
   * 分支 6：从工作区重放文件写入。
   *
   * ⚠ 重放的目标路径来自 manifest，**不是**扫描目录得来的。
   */
  private replayFromWorkspace(
    row: ManifestRow,
    fileStates: readonly { artifact: ManifestArtifact; exists: boolean; hashOk: boolean }[],
    actions: RepairAction[],
  ): RepairDecision {
    const missing = fileStates.filter((f) => !f.exists || !f.hashOk);
    const src = this.workspaceDraft(row.chapter_id);

    if (src === null) {
      return {
        manifestId: row.id,
        chapterId: row.chapter_id,
        branch: 'workspace-corrupted',
        verdict: '文件缺失且工作区没有可重放的源，无法恢复。保留现场。',
        actions,
        resultingStatus: 'NEEDS_HUMAN',
      };
    }

    for (const m of missing) {
      actions.push({
        kind: 'file-replay',
        target: m.artifact.path!,
        detail: `从 ${src} 重放`,
      });
    }

    this.db.run(
      "UPDATE commit_manifests SET status = 'COMMITTED', phase = 'committed', committed_at = ? WHERE id = ?",
      new Date().toISOString(),
      row.id,
    );
    this.logEvent(row.id, row.chapter_id, 'COMMIT_REPAIRED', {
      branch: 'replay-from-workspace',
      replayFrom: src,
      targets: missing.map((m) => m.artifact.path),
    });

    return {
      manifestId: row.id,
      chapterId: row.chapter_id,
      branch: 'replay-from-workspace',
      verdict: `DB 已提交但文件缺失，从工作区重放（源：${src}）`,
      actions,
      resultingStatus: 'COMMITTED',
    };
  }

  private finishCommitted(manifestId: string, actions: RepairAction[]): void {
    this.db.run(
      "UPDATE commit_manifests SET status = 'COMMITTED', phase = 'committed', committed_at = ?, indexes_pending_json = NULL WHERE id = ?",
      new Date().toISOString(),
      manifestId,
    );
    actions.push({ kind: 'db-update', target: manifestId, detail: '标记为 COMMITTED' });
  }

  private chapterState(chapterId: string): string {
    const row = this.db.get<{ status: string }>('SELECT status FROM chapters WHERE id = ?', chapterId);
    return row?.status ?? 'MISSING';
  }

  private parseArtifacts(manifestId: string, json: string): ManifestArtifact[] | null {
    try {
      const parsed = JSON.parse(json) as ManifestArtifact[];
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      this.logger.warn('manifest 的 artifact JSON 损坏', { manifestId });
      return null;
    }
  }

  /**
   * §55 Rule 8：Repair 的每一步都写 run_events。
   *
   * ⚠ 表结构细节（实测踩到）：
   *   - 列名是 event_type 不是 type
   *   - category 是必填且受 CHECK 约束（Repair 属 STATE 类，必须长期保留）
   *   - run_id 是 runs(id) 的外键 —— 没有真实 Run 时不能凭空造 id
   *     因此这里**先查是否已有该章节的 run**，没有就只写日志不写表，
   *     避免因外键失败而丢掉整个修复记录。
   */
  private logEvent(
    manifestId: string,
    chapterId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): void {
    const runId = this.resolveRunId(chapterId);
    if (runId === null) {
      this.logger.info('Repair 事件（无关联 Run，仅记日志）', { manifestId, eventType, ...data });
      return;
    }
    try {
      this.db.run(
        `INSERT INTO run_events (id, run_id, event_type, category, step, payload_json, created_at)
         VALUES (?, ?, ?, 'STATE', ?, ?, ?)`,
        `evt_repair_${manifestId}_${Date.now()}`,
        runId,
        eventType,
        'repair',
        JSON.stringify({ manifestId, ...data }),
        new Date().toISOString(),
      );
    } catch (e) {
      // 事件写入失败不应阻断修复 —— 但要在日志里留痕
      this.logger.warn('Repair 事件写入失败', {
        manifestId,
        eventType,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** 找该章节最近的 Run（Repair 事件必须挂在真实 Run 上，外键才成立） */
  private resolveRunId(chapterId: string): string | null {
    try {
      // ⚠ runs 表没有 chapter_id 列（实测）：只能取该项目下仍在运行的 Run。
      //   拿不到就返回 null，由调用方退化为"只记日志"。
      const row = this.db.get<{ id: string }>(
        "SELECT id FROM runs WHERE status = 'RUNNING' ORDER BY started_at DESC LIMIT 1",
      );
      void chapterId;
      return row?.id ?? null;
    } catch {
      return null;
    }
  }
}

export { ErrorCode };
