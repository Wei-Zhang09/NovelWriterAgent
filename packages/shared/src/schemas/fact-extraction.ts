/**
 * Fact 抽取契约（施工文档 §10.8 / §11 / §55 Rule 9）
 *
 * ## §55 Rule 9："不能把模型自然语言输出直接当事实"
 *
 * 落地方式：`proposed_facts.json` 与 `facts` 表是**两张不同结构**，
 * 中间必须经过两道关卡：
 *
 *   1. Zod 校验（本文件的 schema）
 *   2. **evidence 可回溯校验** —— quote 必须能在原文中精确找到
 *
 * 不满足则**整批拒绝**，不允许"部分写入"。
 * 为什么整批而不是部分：部分写入会让"哪些进了、哪些没进"变得无法解释，
 * 而事实层一旦有说不清的来源，后面所有对账都失去基准。
 *
 * ## evidence 的三字段是硬要求（研究报告 R4）
 *
 *   sourceRef  指哪一章
 *   quote      原文片段
 *   offsets    在原文中的 [start, end)
 *
 * 三者必须自洽：原文.slice(start,end) === quote。
 * 这条在 EvidenceRepository.create 里已强制，
 * 抽取层还要再校验一次 —— 因为模型经常"记得大概"，引文并不存在。
 */
import { z } from 'zod';
import { FactStatus } from './enums.js';

/** 事实主体类型。MVP 只用 CHARACTER / WORLD；LOCATION 归入 WORLD */
export const FACT_SUBJECT_TYPES = ['CHARACTER', 'WORLD', 'ITEM'] as const;
export type FactSubjectType = (typeof FACT_SUBJECT_TYPES)[number];

/**
 * 单条抽取事实。
 *
 * ⚠ `quote` 必填且必须能在原文找到 —— 这是"可回溯"的物理含义。
 *   允许模型不写 quote 就等于允许它凭印象编造事实。
 */
export const ExtractedFactSchema = z.object({
  /** 主体类型 */
  subjectType: z.enum(FACT_SUBJECT_TYPES),
  /**
   * 主体 id（角色 id 等）。模型通常不知道内部 id，
   * 所以允许用 `subjectName` 代替，由服务层解析成 id。
   */
  subjectId: z.string().optional(),
  /** 主体名称（人类可读，用于解析成 id 与展示） */
  subjectName: z.string().min(1).max(100),
  /** 谓词：状态/位置/能力/关系等，如「失明」「已死」「在城中」 */
  predicate: z.string().min(1).max(100),
  /** 取值 */
  objectValue: z.string().min(1).max(500),
  /**
   * ⚠ 原文引文 —— 必须能在本章正文中**精确找到**。
   *   这是事实可回溯性的唯一保证。
   */
  quote: z.string().min(1).max(500),
  /** 模型自评置信度 */
  confidence: z.number().min(0).max(1),
  /**
   * 是否属于"定义性事实"（一旦成立就约束后续所有章节）。
   * 例：失明、死亡。非定义性的（今天心情不好）不该进 Canon。
   */
  isDefining: z.boolean().default(false),
});

/** 一次抽取的完整输出（§32 同款：一次性提交，不做分片拼装） */
export const FactExtractionOutputSchema = z.object({
  facts: z.array(ExtractedFactSchema),
});

export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;
export type FactExtractionOutput = z.infer<typeof FactExtractionOutputSchema>;

/**
 * 待写入的事实候选（落在 proposed_facts.json）。
 *
 * 与 ExtractedFact 的区别：这里已经过**引文校验**，
 * 带上了解析后的 subjectId、精确 offset 与目标状态。
 */
export interface ProposedFact {
  readonly id: string;
  readonly bookId: string;
  readonly subjectType: FactSubjectType;
  /** 解析后的主体 id；解析不到时为 null（该条不会被 promote） */
  readonly subjectId: string | null;
  readonly subjectName: string;
  readonly predicate: string;
  readonly objectValue: string;
  readonly confidence: number;
  readonly isDefining: boolean;
  /** 来源章号 */
  readonly sourceChapter: number;
  /** 引文（已校验存在于原文） */
  readonly quote: string;
  /** 引文在正文中的偏移 */
  readonly startOffset: number;
  readonly endOffset: number;
  /**
   * 目标状态。
   *
   * ⚠ 抽取阶段**永远**是 PROVISIONAL —— 模型不能把推断直接写成 CANON。
   *   推进为 CANON 必须经过 promoteToCanon()（要求有 evidence）。
   */
  readonly targetStatus: Extract<z.infer<typeof FactStatus>, 'PROVISIONAL'>;
}

/** 引文校验结果 */
export interface QuoteVerification {
  readonly ok: boolean;
  readonly quote: string;
  readonly startOffset: number;
  readonly endOffset: number;
  /** 失败原因（人话） */
  readonly reason?: string;
}

/**
 * 校验引文是否真的存在于原文。
 *
 * ## 为什么要容错"空白差异"
 *
 * 模型复制引文时常把换行压成空格、把全角空格写成半角。
 * 这类差异**不是编造**，只是转录噪声，不应让整条事实作废。
 * 但"引文根本不存在"必须拒绝 —— 那才是编造。
 *
 * 策略：先精确匹配；失败则把两边空白归一化后重试；
 * 再失败才判定为编造。返回值里的 offsets 始终指向**原文**的真实位置。
 */
export function verifyQuote(sourceText: string, quote: string): QuoteVerification {
  const q = quote.trim();
  if (q.length === 0) {
    return { ok: false, quote, startOffset: -1, endOffset: -1, reason: '引文为空' };
  }

  // 1) 精确匹配（最常见且最快）
  const exact = sourceText.indexOf(q);
  if (exact >= 0) {
    return { ok: true, quote: q, startOffset: exact, endOffset: exact + q.length };
  }

  // 2) 空白归一化后匹配
  const norm = (s: string) => s.replace(/[\s\u3000]+/g, '');
  const target = norm(q);
  if (target.length === 0) {
    return { ok: false, quote: q, startOffset: -1, endOffset: -1, reason: '引文只有空白' };
  }

  // 逐字符扫描，跳过空白，找到连续匹配的起止
  let ti = 0;
  let start = -1;
  for (let i = 0; i < sourceText.length && ti < target.length; i++) {
    const ch = sourceText[i]!;
    if (/\s|\u3000/.test(ch)) continue;
    if (ch === target[ti]) {
      if (ti === 0) start = i;
      ti++;
    } else {
      // 失配：回退到本次起始处之后继续找
      if (start >= 0) {
        i = start; // 下一轮 i++ 从 start+1 开始
        start = -1;
        ti = 0;
      }
    }
  }
  if (ti === target.length && start >= 0) {
    // 回溯到真实结束位置（含中间空白）
    let end = start;
    let count = 0;
    while (end < sourceText.length && count < target.length) {
      if (!/\s|\u3000/.test(sourceText[end]!)) count++;
      end++;
    }
    return { ok: true, quote: sourceText.slice(start, end), startOffset: start, endOffset: end };
  }

  return {
    ok: false,
    quote: q,
    startOffset: -1,
    endOffset: -1,
    reason: '引文在本章正文中找不到（模型可能凭印象编造）',
  };
}

/** 整批校验的结果 */
export interface BatchVerification {
  readonly accepted: readonly ProposedFact[];
  readonly rejected: readonly { fact: ExtractedFact; reason: string }[];
  /** 只要有拒绝项即为 false —— 整批拒绝策略 */
  readonly allValid: boolean;
}

/**
 * 判断谓词是否属于"定义性事实"。
 *
 * 定义性事实会约束后续所有章节（失明、死亡、身份），
 * 非定义性的临时状态（心情、天气）不该进 Canon ——
 * 否则 Canon 会被噪声淹没，对账时全是误报。
 */
export function isDefiningPredicate(predicate: string, isDefining: boolean): boolean {
  if (isDefining) return true;
  return /(失明|失聪|失语|瘫痪|残疾|死亡|已死|身亡|断臂|断腿|修为尽失|身份|血统|婚配|掌门|继承)/.test(
    predicate,
  );
}
