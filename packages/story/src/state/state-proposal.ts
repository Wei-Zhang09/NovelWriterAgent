/**
 * 状态提议持久化（§六 P0-4）。
 *
 * `state_proposals` 表在 0010 迁移里已建，本文件是它的读写入口 ——
 * 在此之前**全仓无代码使用它**（"有表无链"的第 N 次）。
 *
 * ## 为什么提议要落库而不是只放内存/工作区文件
 *
 * 硬约束「没有 VERIFIED 的 State Proposal 不得进入 Canon」需要
 * **可查证的门禁依据**。若提议只在内存里，进程重启后：
 *   - 无法回答"这一章的状态结算做过没有"
 *   - 无法回答"为什么这条事实进了 Canon"（依据的提议已经没了）
 *   - 重启后的工作流无法从"已验证但未应用"继续
 *
 * 所以 status 必须持久化，且写入 Canon 前必须重新读它 ——
 * 这正是"门禁"与"约定"的区别。
 */
import { now } from '@nwa/storage';
import type { Database } from '@nwa/storage';
import type { Logger } from '@nwa/core';
import type {
  ProposedCharacterState,
  ProposedForeshadowing,
  ProposedTimelineEvent,
  StateProposalStatus,
  StateVerificationReport,
} from '@nwa/shared';

export interface StateProposalRecord {
  readonly id: string;
  readonly workflowId: string | null;
  readonly chapterId: string;
  readonly bookId: string;
  readonly facts: readonly unknown[];
  readonly characterStates: readonly ProposedCharacterState[];
  readonly timelineEvents: readonly ProposedTimelineEvent[];
  readonly foreshadowing: readonly ProposedForeshadowing[];
  readonly status: StateProposalStatus;
  readonly verification: StateVerificationReport | null;
  /**
   * 版本锚点（M1 / §21）：这份提议所依据的**正文内容哈希**。
   *
   * null = 无法确认对应哪一版（0016 之前的老数据，或调用方未提供）。
   * ⚠ 判定时 null 按 NO_ANCHOR 处理（拒绝提交但如实说明原因），
   *   **不是**"没锚点就当新鲜"—— 那是没检查却说通过。
   */
  readonly sourceHash: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface Row {
  id: string;
  workflow_id: string | null;
  chapter_id: string;
  book_id: string;
  facts_json: string;
  character_states_json: string;
  timeline_events_json: string;
  foreshadowing_json: string;
  relationships_json: string;
  status: string;
  verification_json: string | null;
  source_hash: string | null;
  created_at: string;
  updated_at: string;
}

/** 安全解析 JSON 列；脏数据返回 []（不让一条坏记录炸掉整次结算） */
function parseArray<T>(raw: string, logger?: Logger, field?: string): T[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch (e) {
    logger?.warn('状态提议 JSON 列解析失败（按空处理）', {
      field,
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

export class StateProposalRepository {
  private readonly db: Database;
  private readonly logger?: Logger;

  constructor(db: Database, logger?: Logger) {
    this.db = db;
    if (logger) this.logger = logger;
  }

  create(input: {
    readonly id: string;
    readonly workflowId?: string | null;
    readonly chapterId: string;
    readonly bookId: string;
    readonly facts?: readonly unknown[];
    readonly characterStates?: readonly ProposedCharacterState[];
    readonly timelineEvents?: readonly ProposedTimelineEvent[];
    readonly foreshadowing?: readonly ProposedForeshadowing[];
    /**
     * 版本锚点（M1 / §21）：这份提议所依据的正文内容哈希。
     *
     * ⚠ 可选但**调用方应当传**：不传则落 null，之后该提议永远被判
     *   NO_ANCHOR 而不能用于提交。让"忘了传"表现为可发现的
     *   "这份提议没有版本锚点"，而不是静默当成新鲜。
     */
    readonly sourceHash?: string | null;
  }): StateProposalRecord {
    const ts = now();
    this.db.run(
      `INSERT INTO state_proposals
         (id, workflow_id, chapter_id, book_id, facts_json, character_states_json,
          timeline_events_json, foreshadowing_json, relationships_json,
          status, verification_json, source_hash, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      input.id,
      input.workflowId ?? null,
      input.chapterId,
      input.bookId,
      JSON.stringify(input.facts ?? []),
      JSON.stringify(input.characterStates ?? []),
      JSON.stringify(input.timelineEvents ?? []),
      JSON.stringify(input.foreshadowing ?? []),
      '[]',
      // ⚠ 新建的提议**永远是 PROPOSED**，不能由调用方指定。
      //   允许创建时就写 VERIFIED 等于给门禁开了一个后门。
      'PROPOSED',
      null,
      input.sourceHash ?? null,
      ts,
      ts,
    );
    return this.get(input.id)!;
  }

  get(id: string): StateProposalRecord | null {
    const row = this.db.get<Row>('SELECT * FROM state_proposals WHERE id = ?', id);
    return row ? this.toRecord(row) : null;
  }

  /**
   * 按章节取最新一条（一章可能重跑多次结算）。
   *
   * ⚠ 必须加 `rowid` 作为**次序兜底**：`created_at` 是毫秒精度，
   *   同一毫秒内建两条提议（重跑很快时完全可能）会打平，
   *   此时"最新一条"就是不确定的 —— 实测就撞上了这个：
   *   同一毫秒建了 sp_1 / sp_2，`ORDER BY created_at DESC` 返回了 sp_1。
   *   rowid 对插入是单调的，用它兜底才确定。
   */
  latestByChapter(chapterId: string): StateProposalRecord | null {
    const row = this.db.get<Row>(
      `SELECT * FROM state_proposals WHERE chapter_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      chapterId,
    );
    return row ? this.toRecord(row) : null;
  }

  listByChapter(chapterId: string): StateProposalRecord[] {
    return this.db
      .all<Row>(`SELECT * FROM state_proposals WHERE chapter_id = ? ORDER BY created_at ASC, rowid ASC`, chapterId)
      .map((r) => this.toRecord(r));
  }

  listByStatus(status: StateProposalStatus): StateProposalRecord[] {
    return this.db
      .all<Row>(`SELECT * FROM state_proposals WHERE status = ? ORDER BY created_at ASC, rowid ASC`, status)
      .map((r) => this.toRecord(r));
  }

  /**
   * 落验证结论并推进状态。
   *
   * ⚠ 只允许 PROPOSED → VERIFIED/REJECTED。不允许把 REJECTED 改回 VERIFIED ——
   *   那会让"重新验证"变成"改判"，而门禁的意义正在于结论不可随意翻转。
   *   要重新验证就**新建一条提议**（历史保留，可对比）。
   */
  verify(
    id: string,
    report: StateVerificationReport,
    status: 'VERIFIED' | 'REJECTED',
  ): StateProposalRecord {
    const cur = this.get(id);
    if (!cur) {
      throw new Error(`状态提议 ${id} 不存在`);
    }
    if (cur.status !== 'PROPOSED') {
      throw new Error(
        `状态提议 ${id} 已是 ${cur.status}，不可改判 —— 请新建一条提议重新验证`,
      );
    }
    this.db.run(
      `UPDATE state_proposals SET status = ?, verification_json = ?, updated_at = ? WHERE id = ?`,
      status,
      JSON.stringify(report),
      now(),
      id,
    );
    return this.get(id)!;
  }

  /** 按 workflow 取（供 UI 展示"这次结算做到哪一步"） */
  listByWorkflow(workflowId: string): StateProposalRecord[] {
    return this.db
      .all<Row>(`SELECT * FROM state_proposals WHERE workflow_id = ? ORDER BY created_at ASC, rowid ASC`, workflowId)
      .map((r) => this.toRecord(r));
  }

  private toRecord(r: Row): StateProposalRecord {
    let verification: StateVerificationReport | null = null;
    if (r.verification_json) {
      try {
        verification = JSON.parse(r.verification_json) as StateVerificationReport;
      } catch (e) {
        this.logger?.warn('验证报告解析失败（如实置空）', {
          id: r.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return {
      id: r.id,
      workflowId: r.workflow_id,
      chapterId: r.chapter_id,
      bookId: r.book_id,
      facts: parseArray<unknown>(r.facts_json, this.logger, 'facts_json'),
      characterStates: parseArray<ProposedCharacterState>(
        r.character_states_json, this.logger, 'character_states_json',
      ),
      timelineEvents: parseArray<ProposedTimelineEvent>(
        r.timeline_events_json, this.logger, 'timeline_events_json',
      ),
      foreshadowing: parseArray<ProposedForeshadowing>(
        r.foreshadowing_json, this.logger, 'foreshadowing_json',
      ),
      status: r.status as StateProposalStatus,
      verification,
      sourceHash: r.source_hash ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
