/**
 * corpus 层共享类型
 */

/** 单条清洗规则的统计 */
export interface CleanRuleStat {
  /** 规则名（人类可读） */
  readonly name: string;
  /** 命中次数 */
  readonly count: number;
  /** 删除的字符数 */
  readonly removedChars: number;
}

/**
 * 清洗报告。
 *
 * ⚠ 清洗是**破坏性**操作，必须可审计：每条规则的删除量都记录，
 *   并附样例供人工核对"是否误删正文"。
 */
export interface CleanReport {
  readonly removedChars: number;
  /** 删除占比（0~1） */
  readonly removedRatio: number;
  readonly rules: readonly CleanRuleStat[];
  /** 每条规则一个样例（人工核对用） */
  readonly samples: readonly { readonly rule: string; readonly sample: string }[];
}
