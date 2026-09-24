/**
 * 状态结算契约（§六 P0-4）。
 *
 * ## 这条链要解决的问题
 *
 * 正文写完之后，故事世界"变了"：角色状态变了、发生了新事件、埋下/回收了伏笔。
 * 这些变化必须**从正文里提取出来**，再决定哪些可以进入 Canon。
 *
 * 之前的实现缺的就是这条链 —— `facts` / `character_states` /
 * `foreshadowing` 表都在，但没有任何代码从正文提取并写入它们
 * （`appendState()` 全仓无调用方）。
 *
 * ## 硬约束：没有 VERIFIED 的 State Proposal 不得进入 Canon
 *
 * 这是本契约存在的**唯一理由**。落地方式：
 *
 * ```
 * 正文
 *   ↓ 提取（模型）        → StateProposal(status=PROPOSED)
 *   ↓ 验证（代码，不是模型）→ 每条带 verdict；整体 → VERIFIED / REJECTED
 *   ↓ 应用（只有 VERIFIED 才允许）→ facts / character_states / timeline / foreshadowing
 * ```
 *
 * ⚠ 为什么验证必须是**代码**而不是模型：
 *   模型既当运动员又当裁判，会把"我推断的"当成"我验证过的"。
 *   代码能验证的是**引文是否真在原文里** —— 这条模型无法伪造
 *   （与 evidence 的 R4 机制同一个原理）。
 *
 * ⚠ 为什么每条都要 `quote` + 偏移：
 *   "角色在这一章变成了什么状态"必须有原文依据。允许无引文就等于
 *   允许模型凭印象给角色编状态，而状态会进 Canon 影响后续所有章节。
 */

import { z } from 'zod';

/** 提议状态（与 state_proposals.status 的 CHECK 一致） */
export const StateProposalStatus = z.enum(['PROPOSED', 'VERIFIED', 'REJECTED']);
export type StateProposalStatus = z.infer<typeof StateProposalStatus>;

/**
 * 一条提议项共有的可回溯字段。
 *
 * ⚠ 三个字段必须自洽：`draftText.slice(startOffset, endOffset) === quote`。
 *   这条在验证阶段被强制（`state-verifier`）。
 *
 * ⚠⚠ `startOffset` / `endOffset` **是可选的，而且模型不应该填**。
 *   实测（verify:state 真跑）：模型能逐字正确引用原文，但字偏移一律返回 0
 *   —— 于是每一条都被验证拒掉，"拦住了"退化成"永远拦"。
 *   一个永远拒绝的门禁和不存在的门禁一样没用。
 *
 *   现在的分工：
 *   - **模型**只负责 `quote`（引用原文，它擅长，且"不能编造"的约束完整保留）
 *   - **代码**用 `indexOf` 定位偏移（它擅长且可验证），存进 `resolvedSpan`
 *
 *   两个字段保留为可选：若将来某个模型确实能给出精确偏移，
 *   验证器会优先采用（`resolveAndVerifySpan` 的 `source: 'model'`）。
 */
export const TraceableSchema = z.object({
  /** 原文片段（必须逐字出现在正文中，否则该条被拒） */
  quote: z.string().min(1),
  /** 模型给的字偏移；**可以不填**，由代码定位 */
  startOffset: z.number().int().min(0).optional(),
  endOffset: z.number().int().min(0).optional(),
});
export type Traceable = z.infer<typeof TraceableSchema>;

/** 角色状态变化 */
export const ProposedCharacterStateSchema = TraceableSchema.extend({
  /**
   * 角色 id；提取时按名称解析，解析不到为 null（该条会被验证拒绝）。
   *
   * ⚠ 必须 `.optional()`：模型经常**整字段省略**而不是写 null。
   *   实测：一次真跑里两条角色状态没带该字段 → 整次提取 schema 校验失败 →
   *   stage FAILED → 连时间线/伏笔（本来完全合格）也一起丢了。
   *   一条不合格不该拖垮整批 —— 让校验放行，由验证器逐条拒。
   */
  characterId: z.string().nullable().optional(),
  characterName: z.string().min(1),
  /** 变化后的状态（自由文本，进 character_states.state_json） */
  status: z.string().min(1),
  /** 为什么发生这个变化（供人工复核） */
  reason: z.string().optional(),
});
export type ProposedCharacterState = z.infer<typeof ProposedCharacterStateSchema>;

/** 时间线事件 */
export const ProposedTimelineEventSchema = TraceableSchema.extend({
  title: z.string().min(1),
  description: z.string().min(1),
  /** 故事世界内的时间（可选，相对值） */
  storyTimeValue: z.number().nullable().optional(),
  storyTimeUnit: z.string().nullable().optional(),
  /**
   * ⚠ 展示用的时间文本（"第三天傍晚"、"21:30"）。
   *
   * 这个字段**必须存在于契约里**，否则 P0-5 的时间线检查在真实数据上失效：
   * 实测模型填 `storyTimeValue` 的可靠性很差（与"给不出字偏移"同一类问题 ——
   * 模型擅长引用，不擅长计算），代码需要从展示文本解析出可比较的时间。
   * 契约里没有它，模型就不会给，解析路径永远拿不到输入。
   */
  storyTimeDisplay: z.string().nullable().optional(),
  /** 涉及的角色名（用于「同一角色两地同时出现」检查） */
  characters: z.array(z.string()).optional(),
  /** 地点（同上） */
  location: z.string().nullable().optional(),
  /**
   * 叙事模式。
   *
   * ⚠ 枚举值必须逐字列出（模型无法猜出 FLASHBACK 是合法值）：
   *   FOREGROUND  顺叙（默认）
   *   FLASHBACK   回忆/倒叙 —— 故事时间倒退是正常的
   *   ANTICIPATION 预告/前瞻 —— 故事时间超前是正常的
   */
  narrativeMode: z.enum(['FOREGROUND', 'FLASHBACK', 'ANTICIPATION']).optional(),
  importance: z.number().int().min(1).max(5).optional(),
});
export type ProposedTimelineEvent = z.infer<typeof ProposedTimelineEventSchema>;

/**
 * 伏笔动作。
 *
 * ⚠ 用"动作"而不是"状态"：提取时模型看到的是"这一段埋了个东西"或
 *   "这里回收了前面的东西"，而不是"伏笔当前处于 PLANTED 状态"。
 *   让模型直接给状态会让它猜——而状态机（六态）的推进规则在代码里，
 *   不在模型手里。
 */
export const ForeshadowAction = z.enum(['PLANT', 'ADVANCE', 'PAYOFF', 'ABANDON']);
export type ForeshadowAction = z.infer<typeof ForeshadowAction>;

export const ProposedForeshadowingSchema = TraceableSchema.extend({
  /** 伏笔名称（用于与已有伏笔匹配） */
  name: z.string().min(1),
  action: ForeshadowAction,
  tier: z.enum(['CORE', 'SIDE', 'DECOR']).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  description: z.string().optional(),
});
export type ProposedForeshadowing = z.infer<typeof ProposedForeshadowingSchema>;

/**
 * 模型抽取的原始输出（进 Zod 校验的那一层）。
 *
 * ⚠ 三个字段是 `unknown[]` 而**不是** `ProposedXxx[]`：
 *   逐条校验由提取器（`state-extractor`）用 `safeParse` 做，理由是
 *   **一条越界不该炸整批**。实测：模型给了 `importance: 8`（schema 要求 1–5），
 *   整个 `StateExtractionOutput` 校验失败 → stage FAILED →
 *   连同一批里完全合格的时间线/伏笔也一起丢了。
 *   一个字段越界毁掉整次提取，代价和收益完全不成比例。
 *
 *   这里只保证"是个数组"；元素形状在提取器里逐条判，
 *   不合格的条目被丢弃并记日志（丢弃必须可见，不能静默消失）。
 */
export const StateExtractionOutputSchema = z.object({
  characterStates: z.array(z.unknown()).default([]),
  timelineEvents: z.array(z.unknown()).default([]),
  foreshadowing: z.array(z.unknown()).default([]),
});
export type StateExtractionOutput = z.infer<typeof StateExtractionOutputSchema>;

/**
 * **校验后**的提取结果（元素形状已保证）。
 *
 * ⚠ 与 `StateExtractionOutput` 的区别很重要：
 *   - `StateExtractionOutput` 是**模型原始输出**（元素是 unknown，
 *     可能越界 —— 例如 importance: 8），只有"是个数组"是保证的；
 *   - `StateExtractionOutputValidated` 是提取器**逐条 safeParse 之后**的结果，
 *     元素形状可信。
 *   下游（落提议、验证、结算）一律用后者，避免把未校验的数据当已校验的用。
 */
export interface StateExtractionOutputValidated {
  readonly characterStates: readonly ProposedCharacterState[];
  readonly timelineEvents: readonly ProposedTimelineEvent[];
  readonly foreshadowing: readonly ProposedForeshadowing[];
}

/** 单条提议项的验证结论 */
export interface ItemVerdict {
  readonly kind: 'fact' | 'characterState' | 'timelineEvent' | 'foreshadowing';
  /** 项在各自数组里的下标（便于回溯到原始提议） */
  readonly index: number;
  /** 可读标识（角色名 / 事件标题 / 伏笔名 / 谓词） */
  readonly label: string;
  readonly verified: boolean;
  /** 未通过的原因（verified=false 时必填，不静默丢弃） */
  readonly reason?: string;
  /**
   * 代码解析出的引文位置（verified=true 时必有）。
   *
   * ⚠ 为什么不直接用模型给的偏移：**模型给不出可靠的字偏移**。
   *   实测：模型能正确写出引文，但 startOffset/endOffset 一律返回 0
   *   —— 结果每一章的状态都被门禁拒掉，"拦住了"变成"永远拦"。
   *   一个永远拒绝的门禁和不存在的门禁一样没用。
   *
   *   正确做法：模型只负责**引用原文**（它擅长），
   *   偏移由代码用 `indexOf` 定位（代码擅长，且可验证）。
   *   引文必须逐字存在于正文 —— 这条"不能编造"的性质完整保留。
   */
  readonly resolvedSpan?: { readonly start: number; readonly end: number };
}

/** 验证报告（落 state_proposals.verification_json） */
export interface StateVerificationReport {
  readonly verifiedCount: number;
  readonly rejectedCount: number;
  readonly byKind: Readonly<Record<string, { verified: number; rejected: number }>>;
  readonly verdicts: readonly ItemVerdict[];
  /** 用于验证的正文长度（便于事后判断"是不是草稿变了"） */
  readonly draftLength: number;
  readonly verifiedAt: string;
}

/** 应用报告（写库结果） */
export interface StateApplyReport {
  readonly factsWritten: number;
  readonly characterStatesWritten: number;
  readonly timelineEventsWritten: number;
  readonly foreshadowingWritten: number;
  readonly skipped: readonly string[];
}
