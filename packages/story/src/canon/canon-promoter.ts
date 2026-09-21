/**
 * Canon 提升服务（施工文档 §10.8 / §13 / STEP 9）
 *
 * ## 职责：把「候选事实」变成「库里的事实」，且全程可回溯
 *
 *   proposed_facts.json（工作区产物，未写库）
 *     → 逐条写入 evidence（引文必须精确匹配，由 EvidenceRepository 强制）
 *     → proposeFact（状态恒为 PROVISIONAL）
 *     → 冲突检测：与已有 Canon 冲突 → 标记 CONTRADICTED，**不覆盖**
 *     → 仅"定义性且高置信且无冲突"的才 promoteToCanon
 *
 * ## 为什么冲突要标记而不是覆盖（STEP 9 的验收项）
 *
 *   「Fact 与已有 Canon 冲突时标记为 CONTRADICTED 而非覆盖」
 *
 * 覆盖会**静默丢失**旧事实 —— 如果旧的其实是对的（模型这次抽错了），
 * 就再也查不出问题出在哪。标记则保留两侧，交给人裁决。
 * 这正是施工文档 §10.8 的 CONTRADICTED 状态存在的意义。
 *
 * ## 为什么 promote 要卡"定义性 + 高置信"
 *
 * Canon 是长篇的事实基准。噪声进得越多，Continuity 检查的误报就越多，
 * 而误报多了之后用户会开始无视检查结果 —— 那比没有检查更糟。
 */
import { AppError, ErrorCode, Logger, evidenceId } from '@nwa/core';
import type { ProposedFact } from '@nwa/shared';
import type { Repositories } from '@nwa/storage';

/** 提升门槛 */
export interface PromotePolicy {
  /** 成为 CANON 的最低置信度（默认 0.9） */
  readonly minConfidenceForCanon: number;
  /** 是否只允许定义性事实进 Canon（默认 true） */
  readonly definingOnly: boolean;
}

const DEFAULT_POLICY: PromotePolicy = {
  minConfidenceForCanon: 0.9,
  definingOnly: true,
};

/** 单条候选的处理结果 */
export interface PromoteOutcome {
  readonly factId: string;
  readonly predicate: string;
  readonly status: 'CANON' | 'PROVISIONAL' | 'CONTRADICTED' | 'SKIPPED';
  /** 结果说明（人话，用于 UI 与审计） */
  readonly reason: string;
  readonly evidenceId: string | null;
}

export interface PromoteReport {
  readonly outcomes: readonly PromoteOutcome[];
  readonly canonCount: number;
  readonly provisionalCount: number;
  readonly contradictedCount: number;
  readonly skippedCount: number;
}

export class CanonPromoter {
  private readonly repos: Repositories;
  private readonly logger: Logger;
  private readonly bookId: string;
  private readonly policy: PromotePolicy;

  constructor(opts: {
    readonly repos: Repositories;
    readonly logger: Logger;
    readonly bookId: string;
    readonly policy?: Partial<PromotePolicy>;
  }) {
    this.repos = opts.repos;
    this.logger = opts.logger;
    this.bookId = opts.bookId;
    this.policy = { ...DEFAULT_POLICY, ...opts.policy };
  }

  /**
   * 把候选事实写入库。
   *
   * ⚠ 这是**唯一**允许写 facts 的入口。抽取器（FactExtractor）没有 repos，
   *   所以"只 propose 不写库"是物理保证而非约定。
   *
   * ⚠ sourceRef 必须对应真实存在的正文，否则 evidence 的引文校验会失败 ——
   *   这是"每一条 CANON 都可回溯"的强制点。
   */
  promote(
    proposed: readonly ProposedFact[],
    opts: {
      /** 正文内容（用于 evidence 的引文校验） */
      readonly draftText: string;
      /** 章节在项目中的相对路径，作为 evidence.sourceRef */
      readonly sourceRef: string;
    },
  ): PromoteReport {
    const outcomes: PromoteOutcome[] = [];

    for (const p of proposed) {
      outcomes.push(this.promoteOne(p, opts));
    }

    const report: PromoteReport = {
      outcomes,
      canonCount: outcomes.filter((o) => o.status === 'CANON').length,
      provisionalCount: outcomes.filter((o) => o.status === 'PROVISIONAL').length,
      contradictedCount: outcomes.filter((o) => o.status === 'CONTRADICTED').length,
      skippedCount: outcomes.filter((o) => o.status === 'SKIPPED').length,
    };

    this.logger.info('Canon 提升完成', {
      total: proposed.length,
      canon: report.canonCount,
      provisional: report.provisionalCount,
      contradicted: report.contradictedCount,
      skipped: report.skippedCount,
    });

    return report;
  }

  private promoteOne(
    p: ProposedFact,
    opts: { readonly draftText: string; readonly sourceRef: string },
  ): PromoteOutcome {
    // ① 主体未解析 → 跳过（写进去也无法与角色关联）
    if (p.subjectId === null) {
      return {
        factId: p.id,
        predicate: p.predicate,
        status: 'SKIPPED',
        reason: `主体「${p.subjectName}」未解析为角色 id，无法关联`,
        evidenceId: null,
      };
    }

    // ② 先建证据（引文必须能在正文中精确匹配，由仓储强制）
    let evidenceId: string;
    try {
      const ev = this.repos.evidence.create({
        id: evidenceIdOf(opts.sourceRef, p),
        bookId: this.bookId,
        sourceType: 'CHAPTER',
        sourceRef: opts.sourceRef,
        quote: p.quote,
        startOffset: p.startOffset,
        endOffset: p.endOffset,
        note: `第 ${p.sourceChapter} 章事实抽取`,
        sourceText: opts.draftText,
      });
      evidenceId = ev.id;
    } catch (e) {
      // 证据建不起来 → 这条事实没有可回溯依据，不能进库
      const msg = e instanceof Error ? e.message : String(e);
      return {
        factId: p.id,
        predicate: p.predicate,
        status: 'SKIPPED',
        reason: `证据写入失败，事实缺少可回溯依据：${msg}`,
        evidenceId: null,
      };
    }

    // ③ 冲突检测：同主体同谓词但取值不同
    const existing = this.repos.facts
      .listBySubject(this.bookId, p.subjectType, p.subjectId)
      .filter((f) => f.predicate === p.predicate && f.status === 'CANON');
    const conflicting = existing.find((f) => f.object_value !== p.objectValue);

    if (conflicting) {
      // ⚠ 标记 CONTRADICTED，**不覆盖**旧 Canon
      const row = this.repos.facts.propose({
        id: p.id,
        bookId: this.bookId,
        subjectType: p.subjectType,
        subjectId: p.subjectId,
        predicate: p.predicate,
        objectValue: p.objectValue,
        confidence: p.confidence,
        sourceChapterId: null,
        evidenceId,
      });
      this.repos.facts.markContradicted(
        row.id,
        `与已有 Canon 冲突：${conflicting.subject_type}:${conflicting.predicate} = ${conflicting.object_value}`,
      );
      this.logger.warn('事实与已有 Canon 冲突，标记为 CONTRADICTED（未覆盖）', {
        predicate: p.predicate,
        existing: conflicting.object_value,
        incoming: p.objectValue,
        existingFactId: conflicting.id,
      });
      return {
        factId: row.id,
        predicate: p.predicate,
        status: 'CONTRADICTED',
        reason: `与已有 Canon「${conflicting.object_value}」冲突，保留双方待人工裁决`,
        evidenceId,
      };
    }

    // ④ 写入（恒为 PROVISIONAL）
    const row = this.repos.facts.propose({
      id: p.id,
      bookId: this.bookId,
      subjectType: p.subjectType,
      subjectId: p.subjectId,
      predicate: p.predicate,
      objectValue: p.objectValue,
      confidence: p.confidence,
      sourceChapterId: null,
      evidenceId,
    });

    // ⑤ 是否够格成为 CANON
    const policyCheck = this.checkPolicy(p);
    if (!policyCheck.pass) {
      return {
        factId: row.id,
        predicate: p.predicate,
        status: 'PROVISIONAL',
        reason: policyCheck.reason,
        evidenceId,
      };
    }

    const canon = this.repos.facts.promoteToCanon(row.id);
    return {
      factId: canon.id,
      predicate: p.predicate,
      status: 'CANON',
      reason: `定义性事实，置信度 ${p.confidence} ≥ ${this.policy.minConfidenceForCanon}`,
      evidenceId,
    };
  }

  private checkPolicy(p: ProposedFact): { pass: boolean; reason: string } {
    if (this.policy.definingOnly && !p.isDefining) {
      return { pass: false, reason: '非定义性事实（临时状态不进 Canon）' };
    }
    if (p.confidence < this.policy.minConfidenceForCanon) {
      return {
        pass: false,
        reason: `置信度 ${p.confidence} 低于 Canon 门槛 ${this.policy.minConfidenceForCanon}`,
      };
    }
    return { pass: true, reason: '' };
  }

  /**
   * 提升前预检：哪些候选会被拒绝，为什么。
   *
   * ⚠ 只读，不写库 —— 供 UI 在真正 promote 前展示"会发生什么"。
   */
  preview(proposed: readonly ProposedFact[]): readonly PromoteOutcome[] {
    return proposed.map((p) => {
      if (p.subjectId === null) {
        return {
          factId: p.id,
          predicate: p.predicate,
          status: 'SKIPPED' as const,
          reason: `主体「${p.subjectName}」未解析为角色 id`,
          evidenceId: null,
        };
      }
      const policyCheck = this.checkPolicy(p);
      return {
        factId: p.id,
        predicate: p.predicate,
        status: policyCheck.pass ? ('CANON' as const) : ('PROVISIONAL' as const),
        reason: policyCheck.pass ? '将提升为 CANON' : policyCheck.reason,
        evidenceId: null,
      };
    });
  }
}

/** 证据 id：内容派生，重复 promote 不会产生重复证据 */
function evidenceIdOf(sourceRef: string, p: ProposedFact): string {
  // 复用 core 的 evidenceId 规则（sourceRef + 区间 + 引文前缀）
  return evidenceId({
    sourceRef,
    startOffset: p.startOffset,
    endOffset: p.endOffset,
    quote: p.quote,
  });
}

// 哨兵：这些符号在本模块的签名与错误处理中会被用到，
// 显式 re-export 便于调用方统一从 story 包引入错误类型
export { ErrorCode, AppError };
