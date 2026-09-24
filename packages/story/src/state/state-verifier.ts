/**
 * 状态验证器（§六 P0-4 第二步）—— **本任务的核心**。
 *
 * ## 硬约束
 *
 * > 没有 VERIFIED 的 State Proposal 不得进入 Canon。
 *
 * 本文件是这条约束的**唯一执行点**。它做的是**代码判定**，
 * 不调用模型 —— 模型既当运动员又当裁判会把"我推断的"当成"我验证过的"。
 *
 * ## 代码能验证什么（以及为什么这就够了）
 *
 * 模型无法伪造的是**引文与偏移是否真的对应原文**：
 *
 * ```
 * draftText.slice(startOffset, endOffset) === quote
 * ```
 *
 * 这条看起来弱，但它挡住了最关键的一类错误：**模型凭印象编造**。
 * 一个"角色状态变化"如果连引文都找不到，那它就不是从正文提取的，
 * 而是模型脑补的 —— 让它进 Canon 会污染后续所有章节的对账基准。
 *
 * 与 evidence 的 R4 机制同一原理（`evidence` 表的 CHECK 也是靠这条）。
 *
 * ## 逐条验证的规则
 *
 * | 项 | 验证条件 |
 * |---|---|
 * | characterState | 引文可回溯 + characterId 非 null |
 * | timelineEvent  | 引文可回溯 + title/description 非空 |
 * | foreshadowing  | 引文可回溯 + name 非空 |
 *
 * ⚠ 全部失败时整体标 REJECTED，但**逐条结论都保留** ——
 *   只报"整体失败"会让"哪一条为什么被拒"无法回答，
 *   而那正是人工复核与 prompt 迭代需要的输入。
 */

import { Logger } from '@nwa/core';
import type {
  ProposedFact,
  ItemVerdict,
  ProposedCharacterState,
  ProposedForeshadowing,
  ProposedTimelineEvent,
  StateVerificationReport,
} from '@nwa/shared';

export interface StateVerifierOptions {
  readonly logger: Logger;
}

export interface VerifyInput {
  readonly draftText: string;
  /**
   * 候选事实。
   *
   * ⚠ 必须一起验证 —— 否则事实可以绕过门禁进 Canon。
   *   实测发现 `canon.promote` 此前**直接**调 `CanonPromoter.promote()`，
   *   完全没有经过任何提议/验证；把事实纳入同一份提议，
   *   "一个门禁管住所有进 Canon 的东西"才成立。
   */
  readonly facts?: readonly ProposedFact[];
  readonly characterStates?: readonly ProposedCharacterState[];
  readonly timelineEvents?: readonly ProposedTimelineEvent[];
  readonly foreshadowing?: readonly ProposedForeshadowing[];
}

/**
 * 引文可回溯校验。
 *
 * ⚠ 校验**偏移**而不是"在全文里搜一遍引文"。
 *   搜全文会放过偏移写错的条目，而偏移正是"这条来自正文哪一句"的
 *   精确定位 —— 允许偏移错就等于允许 evidence 表存错误的 [start,end)，
 *   下游引用它时指到别的地方。
 *
 * 同时校验偏移本身合法（start < end 且在正文范围内）。
 */
/**
 * 由引文在正文中定位偏移。
 *
 * ⚠ 为什么需要它：**模型给不出可靠的字偏移**。实测模型能正确引用原文，
 *   但 `startOffset`/`endOffset` 一律返回 0 —— 于是每一章的状态都被
 *   门禁拒掉，"拦住了"变成"永远拦"。一个永远拒绝的门禁和不存在的门禁一样没用。
 *
 * 分工：模型负责**引用原文**（它擅长），偏移由代码 `indexOf` 定位
 * （代码擅长且可验证）。"引文必须逐字存在"这条约束完整保留 ——
 * 模型仍然无法凭空编造一条引文。
 *
 * 返回首个匹配位置；找不到返回 null（调用方据此判定失败）。
 */
export function resolveQuoteSpan(
  draftText: string,
  quote: string,
): { start: number; end: number } | null {
  const i = draftText.indexOf(quote);
  if (i < 0) return null;
  return { start: i, end: i + quote.length };
}

/**
 * 解析并校验一条可回溯项。
 *
 * ⚠ 接受两种来源：
 *   1. 模型给的偏移**能用**（slice 精确等于 quote）→ 用它
 *   2. 偏移不能用（模型给 0、给错、越界）→ 用 `indexOf` 重新定位
 *   3. 引文在正文里根本不存在 → 失败（编造的内容进不去）
 *
 * 这样既保留了"偏移必须精确"的强校验（当模型给对时），
 * 又不会因为模型不擅长数偏移而让门禁永久失效。
 */
export function resolveAndVerifySpan(
  draftText: string,
  quote: string,
  startOffset: number | undefined,
  endOffset: number | undefined,
): { ok: true; start: number; end: number; source: 'model' | 'located' } | { ok: false; reason: string } {
  // 先试模型给的偏移（没给就跳过这一步）
  if (startOffset !== undefined && endOffset !== undefined) {
    const direct = verifyQuoteSpan(draftText, quote, startOffset, endOffset);
    if (direct.ok) {
      return { ok: true, start: startOffset, end: endOffset, source: 'model' };
    }
  }
  // 回落到代码定位
  const located = resolveQuoteSpan(draftText, quote);
  if (located) {
    return { ok: true, start: located.start, end: located.end, source: 'located' };
  }
  // 引文根本不在正文里 → 拒绝（这是"不能编造"的那条）
  return {
    ok: false,
    reason:
      `引文在正文中找不到${startOffset !== undefined ? `（模型给的偏移 ${startOffset}-${endOffset} 也不匹配）` : ''}：` +
      `「${quote.slice(0, 40)}」`,
  };
}

export function verifyQuoteSpan(
  draftText: string,
  quote: string,
  startOffset: number,
  endOffset: number,
): { ok: boolean; reason?: string } {
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) {
    return { ok: false, reason: '偏移必须是整数' };
  }
  if (startOffset < 0) {
    return { ok: false, reason: `startOffset 为负（${startOffset}）` };
  }
  if (endOffset <= startOffset) {
    return { ok: false, reason: `endOffset(${endOffset}) 必须大于 startOffset(${startOffset})` };
  }
  if (endOffset > draftText.length) {
    return {
      ok: false,
      reason: `endOffset(${endOffset}) 超出正文长度(${draftText.length})`,
    };
  }
  const slice = draftText.slice(startOffset, endOffset);
  if (slice !== quote) {
    return {
      ok: false,
      reason:
        `引文与正文偏移不匹配：原文 [${startOffset},${endOffset}) 是 ` +
        `「${slice.slice(0, 40)}」，但提议写的是「${quote.slice(0, 40)}」`,
    };
  }
  return { ok: true };
}

export class StateVerifier {
  private readonly logger: Logger;

  constructor(opts: StateVerifierOptions) {
    this.logger = opts.logger;
  }

  /**
   * 逐条验证提议项。
   *
   * ⚠ 返回的报告里**每条都有结论**，包括被拒的原因 ——
   *   调用方据此决定整体 status，但不应丢弃逐条信息。
   */
  verify(input: VerifyInput): StateVerificationReport {
    const verdicts: ItemVerdict[] = [];

    (input.characterStates ?? []).forEach((cs, index) => {
      const label = `${cs.characterName} → ${cs.status}`;
      // ① 引文可回溯
      const q = resolveAndVerifySpan(input.draftText, cs.quote, cs.startOffset, cs.endOffset);
      if (!q.ok) {
        verdicts.push({ kind: 'characterState', index, label, verified: false, reason: q.reason });
        return;
      }
      const span = { start: q.start, end: q.end };
      // ② 角色必须能解析成 id
      //    ⚠ 解析不到就拒绝，而不是写一个 NULL 的 character_id ——
      //      那条状态将永远无法被"查某个角色的状态"读到，等于写了没用。
      if (!cs.characterId) {
        verdicts.push({
          kind: 'characterState',
          index,
          label,
          verified: false,
          reason: `角色「${cs.characterName}」未解析到 id（未登记）`,
        });
        return;
      }
      // ③ 状态必须具体（含糊状态无法与后文对账）
      if (cs.status.trim().length < 2) {
        verdicts.push({
          kind: 'characterState',
          index,
          label,
          verified: false,
          reason: '状态过于含糊（少于 2 字）',
        });
        return;
      }
      verdicts.push({ kind: 'characterState', index, label, verified: true, resolvedSpan: span });
    });

    (input.facts ?? []).forEach((f, index) => {
      const label = `${f.subjectName}.${f.predicate}=${f.objectValue}`;
      const q = resolveAndVerifySpan(input.draftText, f.quote, f.startOffset, f.endOffset);
      if (!q.ok) {
        verdicts.push({ kind: 'fact', index, label, verified: false, reason: q.reason });
        return;
      }
      // ⚠ 主体必须解析到 id：解析不到的 facts 会被 CanonPromoter 拒，
      //   在这里提前标出原因，让"为什么这条没进 Canon"可回答。
      if (!f.subjectId && f.subjectType === 'CHARACTER') {
        verdicts.push({
          kind: 'fact',
          index,
          label,
          verified: false,
          reason: `主体「${f.subjectName}」未解析到 id`,
        });
        return;
      }
      verdicts.push({
        kind: 'fact',
        index,
        label,
        verified: true,
        resolvedSpan: { start: q.start, end: q.end },
      });
    });

    (input.timelineEvents ?? []).forEach((ev, index) => {
      const label = ev.title;
      const q = resolveAndVerifySpan(input.draftText, ev.quote, ev.startOffset, ev.endOffset);
      if (!q.ok) {
        verdicts.push({ kind: 'timelineEvent', index, label, verified: false, reason: q.reason });
        return;
      }
      if (ev.description.trim().length === 0) {
        verdicts.push({
          kind: 'timelineEvent',
          index,
          label,
          verified: false,
          reason: '事件缺少描述',
        });
        return;
      }
      verdicts.push({
        kind: 'timelineEvent',
        index,
        label,
        verified: true,
        resolvedSpan: { start: q.start, end: q.end },
      });
    });

    (input.foreshadowing ?? []).forEach((fs, index) => {
      const label = `${fs.name}(${fs.action})`;
      const q = resolveAndVerifySpan(input.draftText, fs.quote, fs.startOffset, fs.endOffset);
      if (!q.ok) {
        verdicts.push({ kind: 'foreshadowing', index, label, verified: false, reason: q.reason });
        return;
      }
      if (fs.name.trim().length === 0) {
        verdicts.push({
          kind: 'foreshadowing',
          index,
          label,
          verified: false,
          reason: '伏笔缺少名称（无法与已有伏笔匹配）',
        });
        return;
      }
      verdicts.push({
        kind: 'foreshadowing',
        index,
        label,
        verified: true,
        resolvedSpan: { start: q.start, end: q.end },
      });
    });

    const byKind: Record<string, { verified: number; rejected: number }> = {};
    for (const v of verdicts) {
      byKind[v.kind] ??= { verified: 0, rejected: 0 };
      if (v.verified) byKind[v.kind]!.verified += 1;
      else byKind[v.kind]!.rejected += 1;
    }

    const report: StateVerificationReport = {
      verifiedCount: verdicts.filter((v) => v.verified).length,
      rejectedCount: verdicts.filter((v) => !v.verified).length,
      byKind,
      verdicts,
      draftLength: input.draftText.length,
      verifiedAt: new Date().toISOString(),
    };

    this.logger.info('状态验证完成', {
      verified: report.verifiedCount,
      rejected: report.rejectedCount,
      byKind,
    });

    return report;
  }
}

/**
 * 由验证报告决定整体状态。
 *
 * ⚠ 规则：**至少一条通过即为 VERIFIED**，一条都没通过为 REJECTED。
 *
 * 为什么不是"必须全部通过"：一条引文写错不该让同一章其他 9 条正确的
 * 状态变化全部作废 —— 那会让提取变得不可用（模型偶尔写错偏移是常态）。
 * 被拒的条目**不会**被应用（逐条结论里已标明），所以整体 VERIFIED
 * 不意味着"所有条目都进库了"。
 *
 * 为什么不是"部分通过就应用部分"而仍需一个整体状态：
 * `state_proposals.status` 是 Canon 写入路径的**门禁判据**，
 * 门禁必须是一个明确的布尔值，不能是"部分"。
 */
export function overallStatus(
  report: StateVerificationReport,
): 'VERIFIED' | 'REJECTED' {
  return report.verifiedCount > 0 ? 'VERIFIED' : 'REJECTED';
}
