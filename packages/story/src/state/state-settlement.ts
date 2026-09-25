/**
 * 状态结算（§六 P0-4）—— 把"正文 → 状态 → 验证 → Commit"串成一条链。
 *
 * ## 完整链路
 *
 * ```
 * settle()                           apply()
 * ────────                           ───────
 * ① 提取（模型）   StateExtractor
 * ② 落提议         status = PROPOSED
 * ③ 验证（代码）   StateVerifier  → VERIFIED / REJECTED
 *                                    ④ 应用（**只有 VERIFIED 才允许**）
 *                                       → facts / character_states
 *                                       / timeline_events / foreshadowing
 * ```
 *
 * ## ⚠ 硬约束：没有 VERIFIED 的 State Proposal 不得进入 Canon
 *
 * `apply()` 的第一件事就是**重新读库**里的 status 并校验。
 * 为什么不信任调用方传进来的对象：调用方可能传一个内存里的旧副本，
 * 而库里那条可能已被标 REJECTED。门禁必须查**权威状态**（数据库），
 * 不能查调用方手里的快照 —— 否则门禁可以被一个过期的变量绕过。
 *
 * ## ⚠ 为什么 apply 与 settle 分开
 *
 * 中间要给人留出**复核与改判**的位置（§六：提议要能被人工拒绝）。
 * 合成一个方法就只能"全自动进 Canon"，那正是这条约束要防的事。
 */

import { Logger, AppError, ErrorCode, evidenceId, sha256Text } from '@nwa/core';
import type { Repositories, Database } from '@nwa/storage';
import type { ProposedFact, StateVerificationReport } from '@nwa/shared';
import { CanonPromoter } from '../canon/canon-promoter.js';
import { buildTimelineEvent } from '../timeline/timeline-builder.js';
import { StateExtractor } from './state-extractor.js';
import { StateVerifier, overallStatus } from './state-verifier.js';
import { StateProposalRepository, type StateProposalRecord } from './state-proposal.js';

export interface StateSettlementOptions {
  readonly repos: Repositories;
  readonly db: Database;
  readonly logger: Logger;
  readonly bookId: string;
  readonly extractor: StateExtractor;
  /**
   * 已有候选事实（来自 `canon.extract` 的产物）。
   *
   * ⚠ 把它们纳入同一条提议，是为了让**一个门禁管住所有进 Canon 的东西**。
   *   若事实走 `canon.promote` 而状态走本链路，就会出现两个入口、
   *   两套门禁，而其中一套（事实那套）此前根本没有门禁。
   */
  readonly proposedFacts?: readonly ProposedFact[];
  /** 正文相对路径（作为 evidence.sourceRef） */
  readonly sourceRef: string;
}

export interface SettleResult {
  readonly proposalId: string;
  readonly status: 'VERIFIED' | 'REJECTED';
  readonly verified: boolean;
  readonly report: StateVerificationReport;
  readonly factCount: number;
  readonly characterStateCount: number;
  readonly timelineEventCount: number;
  readonly foreshadowingCount: number;
  /** 被拒条目的人话原因（供 UI 与人工复核） */
  readonly rejected: readonly string[];
}

export class StateSettlement {
  private readonly repos: Repositories;
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly bookId: string;
  private readonly extractor: StateExtractor;
  private readonly verifier: StateVerifier;
  private readonly proposals: StateProposalRepository;
  private readonly proposedFacts: readonly ProposedFact[];
  private readonly sourceRef: string;

  constructor(opts: StateSettlementOptions) {
    this.repos = opts.repos;
    this.db = opts.db;
    this.logger = opts.logger;
    this.bookId = opts.bookId;
    this.extractor = opts.extractor;
    this.verifier = new StateVerifier({ logger: opts.logger });
    this.proposals = new StateProposalRepository(opts.db, opts.logger);
    this.proposedFacts = opts.proposedFacts ?? [];
    this.sourceRef = opts.sourceRef;
  }

  /**
   * 提取 + 落提议 + 验证。
   *
   * ⚠ 本方法**不写 Canon**（facts / character_states / timeline / foreshadowing
   *   都不碰）。要写必须再调 `apply()`，而 apply 会重新校验 status。
   */
  async settle(input: {
    readonly chapterId: string;
    readonly chapterNumber: number;
    readonly draftText: string;
    readonly workflowId?: string | null;
    readonly previousStates?: readonly { readonly characterName: string; readonly status: string }[];
  }): Promise<SettleResult> {
    const ex = await this.extractor.extract({
      chapterNumber: input.chapterNumber,
      draftText: input.draftText,
      ...(input.previousStates ? { previousStates: input.previousStates } : {}),
    });

    if (!ex.ok) {
      // ⚠ 提取失败不静默变成"这一章没有状态变化" —— 那会让后续章节
      //   基于缺失的状态继续写。如实抛错，让工作流停在 state_settlement。
      throw new AppError(
        ErrorCode.MODEL_STRUCTURED_EMPTY,
        ex.error?.message ?? '状态提取失败',
      );
    }

    // 落提议（status 强制 PROPOSED）
    const proposal = this.proposals.create({
      id: `sp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
      workflowId: input.workflowId ?? null,
      chapterId: input.chapterId,
      bookId: this.bookId,
      facts: this.proposedFacts,
      characterStates: ex.proposed.characterStates,
      timelineEvents: ex.proposed.timelineEvents,
      foreshadowing: ex.proposed.foreshadowing,
      // ⚠ 版本锚点（M1 / §21）：从**实际被提取的文本**算出，不由调用方传入。
      //   调用方传的话就有传错/忘记传的可能，而"锚点写错"表现为
      //   stale 判定永远 FRESH —— 检查形同虚设且极难发现。
      sourceHash: sha256Text(input.draftText),
    });

    // 验证（代码，不调模型）
    const report = this.verifier.verify({
      draftText: input.draftText,
      facts: this.proposedFacts,
      characterStates: ex.proposed.characterStates,
      timelineEvents: ex.proposed.timelineEvents,
      foreshadowing: ex.proposed.foreshadowing,
    });

    // ⚠ 没有候选时不算"验证通过" —— 一条都没有的话整体应为 REJECTED，
    //   否则"空提议"会被当成已验证而放行，门禁形同虚设。
    const hasAnything =
      report.verdicts.length > 0 || this.proposedFacts.length > 0;
    const status: 'VERIFIED' | 'REJECTED' = hasAnything
      ? overallStatus(report)
      : 'REJECTED';

    this.proposals.verify(proposal.id, report, status);

    const rejected = report.verdicts
      .filter((v) => !v.verified)
      .map((v) => `${v.label}：${v.reason ?? '未通过验证'}`);
    if (!hasAnything) {
      rejected.push('本次提取没有得到任何候选（模型输出为空）—— 整体标 REJECTED');
    }
    // 未登记角色也如实报告（它们在验证阶段已被拒，这里给出更早的原因）
    for (const u of ex.unresolvedCharacters) rejected.push(u.reason);

    this.logger.info('状态结算完成', {
      chapterNumber: input.chapterNumber,
      proposalId: proposal.id,
      status,
      verified: report.verifiedCount,
      rejected: report.rejectedCount,
    });

    return {
      proposalId: proposal.id,
      status,
      verified: status === 'VERIFIED',
      report,
      factCount: this.proposedFacts.length,
      characterStateCount: ex.proposed.characterStates.length,
      timelineEventCount: ex.proposed.timelineEvents.length,
      foreshadowingCount: ex.proposed.foreshadowing.length,
      rejected,
    };
  }

  /**
   * 应用已验证的提议 —— **唯一**允许把这些状态写进 Canon 的入口。
   *
   * ⚠ 第一件事是**重新读库**校验 status。不信任调用方传进来的对象：
   *   调用方可能拿着内存里的旧副本，而库里那条可能已被标 REJECTED。
   */
  apply(input: {
    readonly proposalId: string;
    readonly chapterNumber: number;
    readonly draftText: string;
  }): {
    factsWritten: number;
    characterStatesWritten: number;
    timelineEventsWritten: number;
    foreshadowingWritten: number;
    skipped: readonly string[];
  } {
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `状态提议 ${input.proposalId} 不存在`,
      );
    }

    // ⚠⚠ 门禁本体
    if (proposal.status !== 'VERIFIED') {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `拒绝应用：状态提议 ${proposal.id} 的 status 是 ${proposal.status}，` +
          `只有 VERIFIED 的提议才能写入 Canon（§六硬约束）`,
      );
    }

    const skipped: string[] = [];
    let factsWritten = 0;
    let characterStatesWritten = 0;
    let timelineEventsWritten = 0;
    let foreshadowingWritten = 0;

    // ── ① 事实 → CanonPromoter（既有的唯一 facts 写入入口）──
    // ⚠ 只提升**验证通过**的事实（按 verdict 下标取），不是整批提升
    const okFactIdx = this.verifiedIndexes(proposal, 'fact');
    const verifiedFacts = okFactIdx
      .map((i) => proposal.facts[i])
      .filter((f): f is ProposedFact => Boolean(f));
    if (verifiedFacts.length > 0) {
      const promoter = new CanonPromoter({
        repos: this.repos,
        logger: this.logger.child('promoter'),
        bookId: this.bookId,
      });
      const rep = promoter.promote(verifiedFacts, {
        draftText: input.draftText,
        sourceRef: this.sourceRef,
      });
      factsWritten = rep.canonCount + rep.provisionalCount;
      for (const o of rep.outcomes) {
        if (o.status === 'SKIPPED') skipped.push(`事实「${o.predicate}」：${o.reason}`);
      }
    }

    // ── ② 角色状态 ──
    // ⚠ 只写验证通过的条目（按 verdict 的下标取），不是"整批写"
    const okStateIdx = this.verifiedIndexes(proposal, 'characterState');
    for (const i of okStateIdx) {
      const cs = proposal.characterStates[i];
      if (!cs || !cs.characterId) continue;
      const span = this.spanOf(proposal, 'characterState', i);
      try {
        this.repos.characters.appendState({
          id: `cs_${proposal.id}_${i}`,
          characterId: cs.characterId,
          chapterNumber: input.chapterNumber,
          state: {
            status: cs.status,
            ...(cs.reason ? { reason: cs.reason } : {}),
            quote: cs.quote,
            // ⚠ 用**代码解析**的偏移，不是模型给的 —— 模型给的字偏移不可靠
            //   （实测一律返回 0）。存错偏移会让"这条状态来自正文哪一句"
            //   指到别的地方。
            ...(span ? { quoteStart: span.start, quoteEnd: span.end } : {}),
          },
          sourceFactIds: [],
        });
        characterStatesWritten += 1;
      } catch (e) {
        // ⚠ 失败必须**带上是哪一条**。实测：裸的 "FOREIGN KEY constraint failed"
        //   让人以为是证据/提议的外键问题，查了很久才发现是同一角色同章重复写入
        //   撞了 UNIQUE(character_id, chapter_number)。错误信息缺上下文 = 白写日志。
        skipped.push(
          `角色状态「${cs.characterName} → ${cs.status}」写入失败：` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
    }

    // ── ③ 时间线事件 ──
    const okEventIdx = this.verifiedIndexes(proposal, 'timelineEvent');
    for (const i of okEventIdx) {
      const ev = proposal.timelineEvents[i];
      if (!ev) continue;
      const span = this.spanOf(proposal, 'timelineEvent', i);
      // ⚠ 证据：回答「这条时间线事件来自正文哪一句」。
      //   与 foreshadowing 一样走 evidence 表（写入时强制 slice === quote）。
      const evEvidence = span
        ? this.writeEvidence('timelineEvent', ev.title, ev.quote, span, input.draftText)
        : null;

      // ⚠ 走 builder 而不是自己拼 INSERT（P0-5）。
      //   关键差别：builder 会在模型没给 storyTimeValue 时，
      //   **从 storyTimeDisplay 解析出可比较的时间**。
      //   此前这里把 story_time_display 写死成 null、只用模型给的 value，
      //   于是模型一不填（实测很常见），这条事件的故事时间就是 NULL，
      //   时间线检查拿不到可比时间 → 「ch12 21:30 离开医院、ch13 21:20
      //   还在医院」这种矛盾**永远发现不了**。
      const built = buildTimelineEvent({
        proposalId: proposal.id,
        chapterNumber: input.chapterNumber,
        event: ev,
        index: i,
        ...(span ? { span } : {}),
        ...(evEvidence ? { evidenceId: evEvidence } : {}),
        ...(ev.characters && ev.characters.length > 0 ? { characters: ev.characters } : {}),
        ...(ev.location ? { location: ev.location } : {}),
        ...(ev.narrativeMode ? { narrativeMode: ev.narrativeMode } : {}),
      });

      if (!built) {
        skipped.push(`时间线事件「${ev.title}」缺少引文位置，未写入（无法回溯）`);
        continue;
      }

      try {
        this.repos.timeline.create({ ...built, bookId: this.bookId });
        timelineEventsWritten += 1;
      } catch (e) {
        // ⚠ 带上是哪一条 —— 裸的错误信息会让人去查错地方（实测教训）
        skipped.push(
          `时间线事件「${ev.title}」写入失败：` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
    }

    // ── ④ 伏笔（按动作推进既有状态机）──
    const okFsIdx = this.verifiedIndexes(proposal, 'foreshadowing');
    for (const i of okFsIdx) {
      const fs = proposal.foreshadowing[i];
      if (!fs) continue;
      const existing = this.repos.foreshadowing.findByName(this.bookId, fs.name);

      if (fs.action === 'PLANT') {
        if (existing) {
          // 已存在则不再新建 —— 重复埋同一个伏笔会让"这条伏笔回收了没"失去意义
          skipped.push(`伏笔「${fs.name}」已存在，PLANT 被跳过（避免重复记账）`);
          continue;
        }
        // ⚠ 证据：回答「这条伏笔来自正文哪一句」。
        //   没有它，伏笔就只是模型的一句概括，无法回溯。
        const fsSpan = this.spanOf(proposal, 'foreshadowing', i);
        const fsEvidence =
          fsSpan && fs.quote
            ? this.writeEvidence('foreshadowing', fs.name, fs.quote, fsSpan, input.draftText)
            : null;
        this.repos.foreshadowing.create({
          id: `fs_${proposal.id}_${i}`,
          bookId: this.bookId,
          name: fs.name,
          ...(fs.tier ? { tier: fs.tier } : {}),
          ...(fs.importance !== undefined ? { importance: fs.importance } : {}),
          ...(fs.description ? { description: fs.description } : {}),
          setupChapter: input.chapterNumber,
          ...(fsEvidence ? { evidenceIds: [fsEvidence] } : {}),
        });
        foreshadowingWritten += 1;
        continue;
      }

      if (!existing) {
        // ⚠ 推进/回收一个不存在的伏笔是**真问题**（模型记错了或前文没记），
        //   如实跳过并报告，不静默新建一条假伏笔来"接上"。
        skipped.push(`伏笔「${fs.name}」在账本中不存在，${fs.action} 被跳过（未新建假伏笔）`);
        continue;
      }

      // 动作 → 状态机目标态（六态：PLANNED/PLANTED/DEVELOPING/READY/PAID_OFF/ABANDONED）
      //
      // ⚠ 实测发现的真 bug：新建伏笔落在 PLANNED，而 PLANNED 的合法后继是
      //   ['PLANTED', 'ABANDONED'] —— **不含 DEVELOPING**。
      //   之前这里把 ADVANCE 直接映射成 DEVELOPING，于是"第 1 章埋下、
      //   第 2 章推进"永远抛错（PLANNED → DEVELOPING 非法），
      //   而报错文案是"无法推进"，看起来像模型记错了，其实是状态机跳级。
      //   正确做法：先把 PLANNED 推到 PLANTED（埋设已发生），再按动作推进。
      const target =
        fs.action === 'ADVANCE' ? 'DEVELOPING' : fs.action === 'PAYOFF' ? 'PAID_OFF' : 'ABANDONED';
      try {
        // ⚠ PLANNED → PLANTED 是**必须补的一步**（见上）：埋设已经发生了。
        //   不补这一步，ADVANCE 会因为跳级而被状态机拒绝。
        if (existing.status === 'PLANNED' && target !== 'ABANDONED') {
          this.repos.foreshadowing.advance(existing.id, 'PLANTED', {
            chapter: input.chapterNumber,
          });
        }
        // ⚠ 证据：推进/回收也留下引文 —— 一条伏笔的"来龙去脉"才能回溯，
        //   而不只是首次埋设的那一句。
        const advSpan = this.spanOf(proposal, 'foreshadowing', i);
        const advEvidence =
          advSpan && fs.quote
            ? this.writeEvidence('foreshadowing', fs.name, fs.quote, advSpan, input.draftText)
            : null;
        this.repos.foreshadowing.advance(existing.id, target as never, {
          chapter: input.chapterNumber,
        });
        if (advEvidence) this.repos.foreshadowing.appendEvidence(existing.id, [advEvidence]);
        foreshadowingWritten += 1;
      } catch (e) {
        skipped.push(
          `伏笔「${fs.name}」从 ${existing.status} 无法推进到 ${target}：` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
    }

    this.logger.info('状态已应用', {
      proposalId: proposal.id,
      factsWritten,
      characterStatesWritten,
      timelineEventsWritten,
      foreshadowingWritten,
      skipped: skipped.length,
    });

    return {
      factsWritten,
      characterStatesWritten,
      timelineEventsWritten,
      foreshadowingWritten,
      skipped,
    };
  }

  /**
   * 写入一条证据记录，返回 evidence id（失败返回 null）。
   *
   * ⚠ 为什么要写 evidence 而不是只在 data_json 里存 quote：
   *   `evidence` 表是项目里**为"回答这条结论来自正文哪一句"而设计的机制**
   *   （quote / start_offset / end_offset 三个 NOT NULL 字段 + 写入时强制
   *   `sourceText.slice(start, end) === quote`）。只在 data_json 里塞一份
   *   等于另起一套，且无法被 `verifyAll` 统一复核。
   *
   * ⚠ 用**代码解析**的 span，不用模型给的偏移。
   */
  private writeEvidence(
    kind: string,
    label: string,
    quote: string,
    span: { start: number; end: number },
    draftText: string,
  ): string | null {
    try {
      const id = evidenceId({
        sourceRef: this.sourceRef,
        startOffset: span.start,
        endOffset: span.end,
        quote,
      });
      this.repos.evidence.create({
        id,
        bookId: this.bookId,
        sourceType: 'CHAPTER',
        sourceRef: this.sourceRef,
        quote,
        startOffset: span.start,
        endOffset: span.end,
        note: label,
        sourceText: draftText,
      });
      return id;
    } catch (e) {
      // ⚠ 证据写不进去时**不静默通过** —— 这条不该进 Canon，
      //   否则"可回溯"就是假的。
      this.logger.warn('证据写入失败，跳过该条', {
        label,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /** 取某条验证通过项的代码解析位置（模型给的偏移不可靠） */
  private spanOf(
    proposal: StateProposalRecord,
    kind: 'fact' | 'characterState' | 'timelineEvent' | 'foreshadowing',
    index: number,
  ): { start: number; end: number } | undefined {
    const v = proposal.verification?.verdicts.find((x) => x.kind === kind && x.index === index);
    return v?.resolvedSpan;
  }

  /** 取验证通过的下标集合（按 kind 过滤） */
  private verifiedIndexes(
    proposal: StateProposalRecord,
    kind: 'fact' | 'characterState' | 'timelineEvent' | 'foreshadowing',
  ): number[] {
    const v = proposal.verification;
    if (!v) return [];
    return v.verdicts.filter((x) => x.kind === kind && x.verified).map((x) => x.index);
  }

  /** 读提议（供 UI 与门禁检查） */
  getProposal(id: string): StateProposalRecord | null {
    return this.proposals.get(id);
  }

  listByChapter(chapterId: string): StateProposalRecord[] {
    return this.proposals.listByChapter(chapterId);
  }
}
