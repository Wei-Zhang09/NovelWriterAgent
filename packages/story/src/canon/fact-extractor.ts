/**
 * Fact 抽取器（施工文档 §10.8 / §11 / STEP 9）
 *
 * 链路：
 *
 *   草稿正文
 *     → 模型抽取（结构化输出，一次性提交）
 *     → Zod 校验
 *     → **引文校验**（每条 fact 的 quote 必须真的在原文里）
 *     → 主体解析（名称 → id）
 *     → 冲突检测（与已有 Canon 比对）
 *     → 写 proposed_facts.json（**只 propose，不写库**）
 *
 * ## 三条硬约束
 *
 * 1. **只 propose，不写库**（STEP 9 交付物原话）
 *    本类的构造参数里**没有** repositories —— 它在物理上无法写 facts 表。
 *    写库由后续的 promote 流程负责，且必须经过 promoteToCanon() 的证据校验。
 *
 * 2. **整批拒绝，不允许部分写入**
 *    只要有一条引文校验失败，整批不产出 —— 而不是"跳过坏的、留下好的"。
 *    理由：部分写入会让"哪些进了、哪些没进"无法解释，
 *    而事实层一旦有说不清的来源，后面所有对账都失去基准。
 *
 * 3. **模型不能把推断写成 CANON**
 *    targetStatus 恒为 PROVISIONAL。这是编译期就固定的事，
 *    不依赖模型自觉。
 */
import { ErrorCode, Logger } from '@nwa/core';
import {
  FactExtractionOutputSchema,
  verifyQuote,
  isDefiningPredicate,
  type ExtractedFact,
  type ProposedFact,
} from '@nwa/shared';
import { factId } from '@nwa/core';

/** 结构化调用（与 gateway 解耦） */
export type ExtractStructuredCaller = <T>(req: {
  readonly schema: import('zod').ZodType<T, import('zod').ZodTypeDef, unknown>;
  readonly schemaName: string;
  readonly messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}) => Promise<
  | { ok: true; data: T; attempts: number }
  | { ok: false; error: { code: string; message: string }; attempts: number; rawText?: string }
>;

/** 已知角色（用于把名称解析成 id） */
export interface KnownCharacter {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
}

export interface FactExtractorOptions {
  readonly structured: ExtractStructuredCaller;
  readonly logger: Logger;
  readonly bookId: string;
  /** 已知角色列表（提供名称→id 解析） */
  readonly characters: readonly KnownCharacter[];
  /** 是否允许主体未解析时仍产出候选（默认 false —— 宁可拒绝） */
  readonly allowUnresolvedSubject?: boolean;
}

/** 抽取结果 */
export interface ExtractionResult {
  readonly ok: boolean;
  /** 校验通过的候选事实（**尚未写库**） */
  readonly proposed: readonly ProposedFact[];
  /** 被拒绝的条目及原因（用于人工复核与 prompt 迭代） */
  readonly rejected: readonly { fact: ExtractedFact; reason: string }[];
  /** 与已有 Canon 冲突的候选（不阻断，但标记出来） */
  readonly conflicts: readonly {
    readonly fact: ProposedFact;
    readonly existingValue: string;
    readonly existingFactId: string;
  }[];
  readonly error?: { code: string; message: string; details?: unknown };
  readonly attempts: number;
}

export interface ExtractionRequest {
  readonly chapterNumber: number;
  readonly draftText: string;
  /** 已有 Canon（用于冲突检测与提示模型不要重复抽取） */
  readonly existingCanon?: readonly {
    readonly id: string;
    readonly subjectName: string;
    readonly predicate: string;
    readonly objectValue: string;
  }[];
}

export class FactExtractor {
  private readonly structured: ExtractStructuredCaller;
  private readonly logger: Logger;
  private readonly bookId: string;
  private readonly characters: readonly KnownCharacter[];
  private readonly allowUnresolved: boolean;

  constructor(opts: FactExtractorOptions) {
    this.structured = opts.structured;
    this.logger = opts.logger;
    this.bookId = opts.bookId;
    this.characters = opts.characters;
    this.allowUnresolved = opts.allowUnresolvedSubject ?? false;
  }

  /**
   * 从一章草稿抽取事实候选。
   *
   * ⚠ 全程不写库：返回的是候选列表，由调用方写入 proposed_facts.json。
   */
  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    const res = await this.structured<{ facts: ExtractedFact[] }>({
      schema: FactExtractionOutputSchema,
      schemaName: 'FactExtractionOutput',
      messages: buildMessages(req),
      maxTokens: 4096,
      temperature: 0.1, // 抽取要稳，不要发挥
    });

    if (!res.ok) {
      this.logger.warn('事实抽取失败', { chapterNumber: req.chapterNumber, error: res.error.message });
      return {
        ok: false,
        proposed: [],
        rejected: [],
        conflicts: [],
        error: {
          code: res.error.code,
          message: res.error.message,
          details: { rawTextHead: (res.rawText ?? '').slice(0, 300) },
        },
        attempts: res.attempts,
      };
    }

    const accepted: ProposedFact[] = [];
    const rejected: { fact: ExtractedFact; reason: string }[] = [];

    for (const fact of res.data.facts) {
      // ① 引文校验 —— 编造的引文一律拒绝
      const v = verifyQuote(req.draftText, fact.quote);
      if (!v.ok) {
        rejected.push({ fact, reason: v.reason ?? '引文校验失败' });
        continue;
      }

      // ② 主体解析（名称 → id）
      const resolved = this.resolveSubject(fact);
      if (resolved === null && !this.allowUnresolved) {
        rejected.push({
          fact,
          reason: `主体「${fact.subjectName}」在已知角色中找不到，且未提供 subjectId`,
        });
        continue;
      }

      accepted.push({
        // 内容派生 id：同一事实重复抽取不会产生多条（幂等）
        id: factId({
          subjectType: fact.subjectType,
          subjectId: resolved?.id ?? fact.subjectName,
          predicate: fact.predicate,
          objectValue: fact.objectValue,
        }),
        bookId: this.bookId,
        subjectType: fact.subjectType,
        subjectId: resolved?.id ?? null,
        subjectName: resolved?.name ?? fact.subjectName,
        predicate: fact.predicate,
        objectValue: fact.objectValue,
        confidence: fact.confidence,
        isDefining: isDefiningPredicate(fact.predicate, fact.isDefining),
        sourceChapter: req.chapterNumber,
        quote: v.quote,
        startOffset: v.startOffset,
        endOffset: v.endOffset,
        // ⚠ 编译期固定：抽取阶段永远只能是 PROVISIONAL
        targetStatus: 'PROVISIONAL',
      });
    }

    // ⚠ 整批拒绝：有任何拒绝项就不产出候选
    if (rejected.length > 0) {
      this.logger.warn('事实抽取存在不合法条目，整批拒绝', {
        chapterNumber: req.chapterNumber,
        accepted: accepted.length,
        rejected: rejected.length,
        reasons: rejected.slice(0, 3).map((r) => r.reason),
      });
      return {
        ok: false,
        proposed: [],
        rejected,
        conflicts: [],
        error: {
          code: 'FACT_EXTRACTION_QUOTE_MISMATCH',
          message:
            `${rejected.length} 条事实未通过校验（共抽取 ${res.data.facts.length} 条），` +
            '按"不允许部分写入"策略整批拒绝。首条原因：' + (rejected[0]?.reason ?? ''),
          details: { rejected: rejected.map((r) => ({ predicate: r.fact.predicate, reason: r.reason })) },
        },
        attempts: res.attempts,
      };
    }

    const conflicts = this.detectConflicts(accepted, req.existingCanon ?? []);

    this.logger.info('事实抽取完成', {
      chapterNumber: req.chapterNumber,
      proposed: accepted.length,
      conflicts: conflicts.length,
    });

    return { ok: true, proposed: accepted, rejected: [], conflicts, attempts: res.attempts };
  }

  /** 名称 → 角色 id（支持别名） */
  private resolveSubject(fact: ExtractedFact): KnownCharacter | null {
    if (fact.subjectId) {
      const byId = this.characters.find((c) => c.id === fact.subjectId);
      if (byId) return byId;
    }
    const name = fact.subjectName.trim();
    return (
      this.characters.find((c) => c.name === name) ??
      this.characters.find((c) => c.aliases?.includes(name)) ??
      null
    );
  }

  /**
   * 与已有 Canon 比对，找出取值冲突的候选。
   *
   * ⚠ 冲突**不阻断**产出 —— 冲突本身是有价值的信息（可能是剧情反转，
   *   也可能是模型写错了）。标记出来交给人/后续流程裁决，
   *   而不是在这里替用户决定谁对。
   */
  private detectConflicts(
    proposed: readonly ProposedFact[],
    existing: readonly {
      readonly id: string;
      readonly subjectName: string;
      readonly predicate: string;
      readonly objectValue: string;
    }[],
  ): ExtractionResult['conflicts'] {
    const out: { fact: ProposedFact; existingValue: string; existingFactId: string }[] = [];
    for (const p of proposed) {
      const hit = existing.find(
        (e) =>
          e.subjectName === p.subjectName &&
          e.predicate === p.predicate &&
          e.objectValue !== p.objectValue,
      );
      if (hit) {
        out.push({ fact: p, existingValue: hit.objectValue, existingFactId: hit.id });
      }
    }
    return out;
  }
}

// ── Prompt 构造（§31：模块化） ──────────────────────────────

function buildMessages(req: ExtractionRequest): { role: 'system' | 'user'; content: string }[] {
  const system = [
    '你是长篇小说的事实抽取器。从给定正文中提取**确定的、会影响后续章节的**事实。',
    '',
    '硬性要求：',
    '- 每条事实必须附上正文中的**原文引文**（quote），必须逐字来自正文。',
    '  不要改写、不要拼接、不要凭印象写 —— 引文必须能在正文中原样找到。',
    '- 只抽取正文**明确写出**的事实。不要推断。',
    '- 只抽取"定义性"事实：身份、能力、生死的改变、位置变动、关系确立、',
    '  重要物品的得失与损毁。',
    '- **不要**抽取临时状态：心情、天气、此刻的动作、日常对话内容。',
    '- 没有可抽取的事实就返回空数组。宁可少抽，不要凑数。',
    '',
    'predicate 用简短的词，如：失明、已死、在城中、继承掌门、持有玉佩、与李四结盟。',
    'objectValue 填具体取值，如：失明 / 已死 / 城中 / 掌门 / 玉佩 / 盟友。',
  ].join('\n');

  const known = req.existingCanon?.length
    ? [
        '',
        '【已知事实（不要重复抽取，除非正文明确改变了它）】',
        ...req.existingCanon.map((c) => `- ${c.subjectName} | ${c.predicate} = ${c.objectValue}`),
      ].join('\n')
    : '';

  const user = [
    `【第 ${req.chapterNumber} 章 正文】`,
    req.draftText,
    known,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export { ErrorCode };
