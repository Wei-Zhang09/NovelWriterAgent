/**
 * 状态机门禁（施工文档 §8.1 / §33，STEP 8 + STEP 10）
 *
 * ## 为什么门禁必须独立成一个模块
 *
 * §8.2 要求"状态迁移必须由代码执行"。但仅有状态机还不够 ——
 * 状态机只知道"REVIEW_READY 能否到 CONTINUITY_CHECKING"，
 * 不知道"这一章是否真的已经没有 BLOCKING 问题"。
 *
 * 门禁把**业务前置条件**翻译成状态机需要的 `preconditionsMet`：
 *
 *   REVIEWING  → REVIEW_READY      必须有 review 产物
 *   REVIEW_READY → CONTINUITY_CHECKING  必须 BLOCKING = 0
 *   CONTINUITY_CHECKING → READY_TO_COMMIT  必须无连续性阻塞
 *   READY_TO_COMMIT → COMMITTING    必须有草稿且无阻塞
 *
 * ⚠ 门禁**只读**：它判断能否迁移，不执行迁移。
 *   执行由 WorkflowEngine 调用状态机完成 —— 职责不混。
 */
import { Logger, type Nullable } from '@nwa/core';
import type { ChapterStatus } from '@nwa/shared';
import type { Repositories } from '@nwa/storage';

/** 一次门禁检查的结果 */
export interface GateResult {
  /** 前置条件是否满足 */
  readonly met: boolean;
  /** 未满足的条件（人话，用于报错与 UI） */
  readonly missing: readonly string[];
  /** 机器码，供测试与审计断言 */
  readonly code?: string;
}

export interface GateContext {
  readonly chapterId: string;
  readonly from: ChapterStatus;
  readonly to: ChapterStatus;
}

export class TransitionGate {
  private readonly repos: Repositories;
  private readonly logger: Logger;
  /** 工作区草稿是否存在（由调用方注入，因为门禁不该碰文件系统） */
  private readonly hasDraft: (chapterId: string) => boolean;

  constructor(opts: {
    readonly repos: Repositories;
    readonly logger: Logger;
    readonly hasDraft: (chapterId: string) => boolean;
  }) {
    this.repos = opts.repos;
    this.logger = opts.logger;
    this.hasDraft = opts.hasDraft;
  }

  /**
   * 检查某个迁移是否满足业务前置条件。
   *
   * 不在表里的迁移一律放行（由状态机自己的合法性校验负责）——
   * 门禁只加业务约束，不重复状态机的职责。
   */
  check(ctx: GateContext): GateResult {
    const key = `${ctx.from}->${ctx.to}`;
    const result = this.dispatch(key, ctx);
    if (!result.met) {
      this.logger.warn('迁移门禁未通过', { ...ctx, code: result.code, missing: result.missing });
    }
    return result;
  }

  private dispatch(key: string, ctx: GateContext): GateResult {
    switch (key) {
      case 'DRAFT_READY->REVIEWING':
        return this.requireDraft(ctx);

      case 'REVIEWING->REVIEW_READY':
        return this.requireReviewArtifact(ctx);

      // ⚠ §33 的核心约束：只有 BLOCKING = 0 才能离开 REVIEW_READY
      case 'REVIEW_READY->CONTINUITY_CHECKING':
        return this.requireNoBlockingReview(ctx);

      case 'REVISION_READY->CONTINUITY_CHECKING':
        // 修订后必须重新审阅，确保改稿没有引入新问题
        return this.requireReviewArtifact(ctx);

      case 'CONTINUITY_CHECKING->READY_TO_COMMIT':
        return this.requireContinuityClear(ctx);

      case 'READY_TO_COMMIT->COMMITTING':
        return this.requireReadyToCommit(ctx);

      case 'COMMITTING->COMMITTED':
        return { met: true, missing: [] };

      default:
        return { met: true, missing: [] };
    }
  }

  private requireDraft(ctx: GateContext): GateResult {
    if (this.hasDraft(ctx.chapterId)) return { met: true, missing: [] };
    return {
      met: false,
      code: 'GATE_NO_DRAFT',
      missing: ['工作区中不存在草稿（draft.md）—— 请先生成正文'],
    };
  }

  private requireReviewArtifact(ctx: GateContext): GateResult {
    const chapter = this.repos.chapters.get(ctx.chapterId);
    if (chapter.review_json !== null && chapter.review_json !== undefined) {
      return { met: true, missing: [] };
    }
    return {
      met: false,
      code: 'GATE_NO_REVIEW',
      missing: ['尚未审阅本章 —— 没有 review 产物不得标记为审阅完成'],
    };
  }

  /**
   * ⚠ §33：只有 BLOCKING = 0 才能进入一致性检查（进而提交）。
   *
   * 这条是"质量门禁"的物理实现点。若只写在文档里，
   * 只要有一个调用点忘了检查，门禁就形同虚设。
   */
  private requireNoBlockingReview(ctx: GateContext): GateResult {
    const missing: string[] = [];

    const chapter = this.repos.chapters.get(ctx.chapterId);
    if (chapter.review_json === null || chapter.review_json === undefined) {
      missing.push('尚未审阅本章');
    } else if (this.repos.chapters.hasBlockingReview(ctx.chapterId)) {
      const blocking = this.countBlocking(ctx.chapterId);
      missing.push(`存在 ${blocking} 个 BLOCKING 级审阅问题（§33：只有 BLOCKING = 0 才能提交）`);
    }

    if (missing.length === 0) return { met: true, missing: [] };
    return { met: false, code: 'GATE_BLOCKING_REVIEW', missing };
  }

  /**
   * 一致性检查通过门禁。
   *
   * 复用 STEP 10 的连续性结论：若上一轮检查有 BLOCKING_CONTINUITY_ERROR，
   * 不允许进入 READY_TO_COMMIT（应当先去 REVISING 修稿）。
   */
  private requireContinuityClear(ctx: GateContext): GateResult {
    const missing: string[] = [];

    if (this.repos.chapters.hasBlockingReview(ctx.chapterId)) {
      missing.push('审阅仍有 BLOCKING 问题');
    }

    const lastReport = this.lastContinuityReport(ctx.chapterId);
    if (lastReport === null) {
      missing.push('尚未做一致性检查');
    } else if (lastReport.blockingCount > 0) {
      missing.push(`一致性检查发现 ${lastReport.blockingCount} 个阻塞问题`);
    }

    if (missing.length === 0) return { met: true, missing: [] };
    return { met: false, code: 'GATE_CONTINUITY_BLOCKED', missing };
  }

  private requireReadyToCommit(ctx: GateContext): GateResult {
    const missing: string[] = [];

    if (!this.hasDraft(ctx.chapterId)) missing.push('工作区中不存在草稿');
    if (this.repos.chapters.hasBlockingReview(ctx.chapterId)) {
      missing.push('审阅仍有 BLOCKING 问题（不得提交）');
    }

    const lastReport = this.lastContinuityReport(ctx.chapterId);
    if (lastReport === null) {
      missing.push('尚未做一致性检查');
    } else if (lastReport.blockingCount > 0) {
      missing.push('一致性检查有未解决的阻塞问题');
    }

    if (missing.length === 0) return { met: true, missing: [] };
    return { met: false, code: 'GATE_NOT_READY', missing };
  }

  // ── 读取辅助 ──────────────────────────────────────────────

  /**
   * 统计 BLOCKING 数量。
   *
   * 直接解析 review_json 而不复用 hasBlockingReview 的布尔结果，
   * 是为了给出"有 3 个阻塞问题"这样的可操作信息。
   */
  private countBlocking(chapterId: string): number {
    const review = this.repos.chapters.readReview<{
      issues?: readonly { severity?: string }[];
    }>(chapterId);
    if (!review?.issues) return 0;
    return review.issues.filter((i) => i.severity === 'BLOCKING').length;
  }

  /**
   * 最近一次一致性检查报告。
   *
   * MVP 阶段从工作区产物读（工作区是"未验证缓冲区"，检查报告属于中间产物）。
   * 由调用方通过 setContinuityReport 注入，避免门禁依赖文件系统。
   */
  private continuityReports = new Map<string, { blockingCount: number }>();

  setContinuityReport(chapterId: string, report: { blockingCount: number }): void {
    this.continuityReports.set(chapterId, report);
  }

  lastContinuityReport(chapterId: string): Nullable<{ blockingCount: number }> {
    return this.continuityReports.get(chapterId) ?? null;
  }

  clearContinuityReport(chapterId: string): void {
    this.continuityReports.delete(chapterId);
  }
}
