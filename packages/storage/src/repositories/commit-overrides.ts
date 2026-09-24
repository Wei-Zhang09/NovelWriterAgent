/**
 * Commit 绕过审计仓储（P1 / §十二）
 *
 * ## 为什么需要它
 *
 * §十二 要求 Commit 前 `summary_approved == 1`。但硬性检查总会有
 * 必须绕过的现实情形（作者确认这章不要摘要、紧急修复已发布章节）。
 *
 * ⚠ 关键判断：**没有正规绕过通道，不等于不会绕过** ——
 *   那只会让绕过变成"改代码"或"直接改库"，且**不留痕**。
 *   事后无法回答"这章为什么没有摘要"，也无人可追责。
 *
 * 所以设计成：绕过被允许，但必须
 *   1. 显式传 `commitMode: 'FORCE'`（默认 'clean' 不允许绕过）；
 *   2. 在 `commit_overrides` 留一条记录，含**当时状态的快照**。
 *
 * ## 为什么快照而不是 boolean
 *
 * 只记 `overrode = true` 无法区分两种责任完全不同的情况：
 *   - 当时摘要根本是空的（摘要生成步骤没跑）
 *   - 当时摘要存在但作者没批准（流程走到最后一步忘了点确认）
 *
 * 因此记录 `summary_present_at_override` 与 `summary_approved_at_override`
 * 两个原始值，而不是一个合成后的标志。
 */
import type { Database } from '../database.js';

export interface CommitOverrideRow {
  readonly id: string;
  readonly chapter_id: string;
  readonly manifest_id: string | null;
  readonly overridden_check: string;
  readonly summary_approved_at_override: number;
  readonly summary_present_at_override: number;
  readonly reason: string | null;
  readonly created_at: string;
}

/** 被绕过的检查项（闭集 —— 自由字符串会让统计与查询失效） */
export type OverriddenCheck = 'SUMMARY_APPROVAL';

export class CommitOverrideRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * 记录一次绕过。
   *
   * ⚠ `id` 由调用方生成（与全仓 id 生成方式一致），不在这里用随机数 ——
   *   便于测试断言与日志追踪。
   */
  record(input: {
    readonly id: string;
    readonly chapterId: string;
    readonly manifestId?: string | null;
    readonly check: OverriddenCheck;
    /** 绕过时的**原始**状态快照，不要传合成后的布尔值 */
    readonly summaryApprovedAtOverride: boolean;
    readonly summaryPresentAtOverride: boolean;
    readonly reason?: string | null;
    readonly createdAt: string;
  }): CommitOverrideRow {
    this.db.run(
      `INSERT INTO commit_overrides
         (id, chapter_id, manifest_id, overridden_check,
          summary_approved_at_override, summary_present_at_override, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.chapterId,
      input.manifestId ?? null,
      input.check,
      input.summaryApprovedAtOverride ? 1 : 0,
      input.summaryPresentAtOverride ? 1 : 0,
      input.reason ?? null,
      input.createdAt,
    );
    return this.get(input.id)!;
  }

  get(id: string): CommitOverrideRow | null {
    const row = this.db.prepare('SELECT * FROM commit_overrides WHERE id = ?').get(id) as
      | CommitOverrideRow
      | undefined;
    return row ?? null;
  }

  /** 某章的全部绕过记录（按时间正序）—— UI 与审计都从这里读 */
  listByChapter(chapterId: string): readonly CommitOverrideRow[] {
    return this.db
      .prepare('SELECT * FROM commit_overrides WHERE chapter_id = ? ORDER BY created_at, id')
      .all(chapterId) as unknown as CommitOverrideRow[];
  }

  /**
   * 某章是否曾因摘要未批准而被绕过。
   *
   * ⚠ 用这个回答"这章该不该有摘要" —— 而不是看 summary 是否为空，
   *   因为绕过提交的章节摘要本来就可能是空的（那是绕过的前提）。
   */
  hasSummaryApprovalOverride(chapterId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS x FROM commit_overrides
          WHERE chapter_id = ? AND overridden_check = 'SUMMARY_APPROVAL'
          LIMIT 1`,
      )
      .get(chapterId) as { x?: number } | undefined;
    return row !== undefined;
  }
}
