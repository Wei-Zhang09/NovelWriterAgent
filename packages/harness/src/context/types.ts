/**
 * Context Engine 契约（施工文档 §28 / §12.3 / §11）
 *
 * 三条硬约束（都来自参考项目的失败教训）：
 *
 *   1. **保护式预算**（研究报告 R3）：
 *      webnovel-writer 的 Context Budget 是纯数值截断 —— 超限就按
 *      (active, 新鲜度, updated_at) 排序取前 N，**其余直接丢弃**，
 *      没有任何条目是「不可裁剪」的。后果：一条 200 章前埋下的主线核心伏笔
 *      只要总量超限就会被截断；「人物已死亡」这类事实被裁掉后，
 *      模型会在后续章节让死者复活。
 *      → 我们的 Protected 装不下时**报错**，绝不静默丢弃。
 *
 *   2. **禁止无根记忆**（§11）：
 *      每个进入 Context 的条目必须带 sourceType + sourceRef，
 *      缺失即抛错。不允许「模型自己记得但说不出来源」的内容进入上下文。
 *
 *   3. **装配报告可断言**（研究报告 §2.2 差异 5）：
 *      输出「每个槽位装了什么、裁了什么」，让装配结果成为可测试的一等对象。
 *      参考项目把装配做成多级截断的拼接产物，最终注入什么难以预测。
 */
/**
 * Context 槽位（施工文档 §28 的 12 层，MVP 实现 9 层）。
 *
 * `protected: true` 表示该槽位**不参与裁剪**，装不下直接报错。
 */
export interface SlotSpec {
  readonly name: SlotName;
  /** 是否受保护：true 时不可裁剪 */
  readonly isProtected: boolean;
  /** 该槽位的 token 预算上限（protected 槽位也会被检查，超出即报错） */
  readonly budgetTokens: number;
  /**
   * 填充策略：
   *   all       —— 全部装入（protected 槽位用；超预算即报错）
   *   topK      —— 按优先级取前 K 条
   *   truncate  —— 按段落边界截断（保留首尾，中间省略并显式告知）
   */
  readonly fillPolicy: 'all' | 'topK' | 'truncate';
  readonly description: string;
}

export const SLOT_NAMES = [
  'system',
  'projectProfile',
  'chapterPlan',
  'scenePlan',
  'protectedCanon',
  'characterState',
  'relevantTimeline',
  'activeForeshadowing',
  'topMemory',
  'topSkills',
  'evidence',
  'styleProfile',
] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

/**
 * 一条进入 Context 的条目。
 *
 * ⚠ `sourceRef` 是**必填**的（§11）—— 没有来源的内容不允许进入上下文。
 *   这从数据结构上杜绝了「无根记忆」，而不是靠 Prompt 提醒模型别编。
 */
export interface ContextEntry {
  readonly id: string;
  /** 来源类型：让模型知道这条信息的权威级别 */
  readonly sourceType: 'CANON' | 'FACT' | 'EVIDENCE' | 'SUMMARY' | 'PLAN' | 'SKILL' | 'MEMORY' | 'PROFILE';
  /** 来源引用（文件路径 / 事实 ID / 章节号）；**必填** */
  readonly sourceRef: string;
  /** 内容 */
  readonly content: string;
  /** 优先级：数值越大越先装入（裁剪时从低往高丢） */
  readonly priority: number;
  /** 为何被检索出来（§11 的 whyMatched，可空但字段存在） */
  readonly whyMatched?: string;
  /** 是否为受保护条目（Protected 槽位内仍可细粒度标记） */
  readonly isProtected?: boolean;
}

/** 单条 Token 估算器（可注入，便于测试与替换为真实 tokenizer） */
export interface TokenCounter {
  estimate(text: string): number;
}

/** 槽位装配结果 */
export interface SlotReport {
  readonly slot: SlotName;
  readonly isProtected: boolean;
  readonly budgetTokens: number;
  /** 实际装入的 token 估算 */
  readonly usedTokens: number;
  /** 装入的条目数 */
  readonly includedCount: number;
  /** 被裁剪掉的条目数 */
  readonly droppedCount: number;
  /** 被裁剪条目的 id（可审计：知道丢了什么） */
  readonly droppedIds: readonly string[];
  /** 是否发生了截断（内容被砍掉一部分） */
  readonly truncated: boolean;
  /** 裁剪/截断的说明，会进入 Prompt 让模型知道上下文不完整 */
  readonly note?: string;
}

/** 整次装配的报告 */
export interface AssemblyReport {
  readonly totalTokens: number;
  readonly budgetTokens: number;
  readonly slots: readonly SlotReport[];
  /** Protected 槽位总占用 */
  readonly protectedTokens: number;
  readonly protectedBudgetTokens: number;
  /** 是否所有 Protected 都装下了（false 时本不该返回成功） */
  readonly allProtectedSatisfied: boolean;
}

export interface AssembledContext {
  /** 按槽位顺序拼好的文本 */
  readonly text: string;
  /** 结构化视图（便于测试与 UI 展示） */
  readonly entriesBySlot: Readonly<Record<string, readonly ContextEntry[]>>;
  readonly report: AssemblyReport;
}

export interface ContextRequest {
  readonly budget: import('@nwa/core').ContextBudget;
  /** 各槽位的数据（由调用方从 Canon / Memory / Retrieval 取出） */
  readonly slots: Partial<Record<SlotName, readonly ContextEntry[]>>;
  /** 需要覆盖默认槽位规格时传入 */
  readonly overrides?: Partial<Record<SlotName, Partial<SlotSpec>>>;
}
