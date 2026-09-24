/**
 * 章节摘要生成（ADR-0006 约束 C，补缺口）
 *
 * ## 为什么必须有这一步
 *
 * 实测踩到：**全代码库里没有生成章节摘要的逻辑**。`commit-tools.ts` 直接拿
 * `chapters.summary`，而该字段永远为 NULL，于是 fallback 成标题「第 1 章」。
 *
 * 后果是长程记忆**整条断裂**：
 *   第 1 章摘要 = "第 1 章"（只有标题）
 *   → 第 2 章检索到的前情只有这三个字
 *   → 模型拿不到任何信息，只能另起炉灶
 *
 * 实测证据：第 1 章主角「林渊」，第 2 章变成「林秋」，妹妹的名字与设定全丢。
 * 这**不是模型发挥**，是链路断了一环。
 *
 * ## 为什么摘要必须只抽取、不创作（R5 / ADR-0006）
 *
 * ADR-0006 原话："摘要是长程记忆的源头，错一条污染后面几百章"。
 *
 * 因此本模块的 prompt 与校验都围绕一条纪律：
 *   **摘要只能陈述正文中已发生的事，不得推断、不得添加未出现的设定。**
 * 若模型编了一个"妹妹其实是被掳走的"而正文没写，这条虚假记忆会进入
 * 后续所有章节的上下文，而且**无法追溯**（因为它看起来就是一条正常摘要）。
 *
 * ## 与人工关口的关系
 *
 * 本模块**只生成候选**，状态为 `summary_approved = 0`。
 * 按 ADR-0006 约束 C，只有作者确认后才进 FTS 与后续 Context
 * （由 SummaryIndexer 强制）。生成与确认是两件事，不能合并。
 */
import { ErrorCode, Logger, SUMMARY_MAX_CHARS } from '@nwa/core';
import { z } from 'zod';

/** 结构化调用（与 gateway 解耦） */
export type SummaryStructuredCaller = <T>(req: {
  readonly schema: import('zod').ZodType<T, import('zod').ZodTypeDef, unknown>;
  readonly schemaName: string;
  readonly messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}) => Promise<
  | { ok: true; data: T; attempts: number }
  | { ok: false; error: { code: string; message: string }; attempts: number; rawText?: string }
>;

/** 摘要输出契约 */
export interface ChapterSummary {
  /** 一段式摘要（100-300 字），用于后续章节的上下文 */
  readonly summary: string;
  /**
   * 本章确立/改变的关键事实（供 Canon 抽取参考）。
   * ⚠ 只是**提示**，不直接写库 —— 事实入库走 fact 抽取流程。
   */
  readonly keyFacts: readonly string[];
  /** 结尾处的状态（下一章从这里继续） */
  readonly endState: string;
}

export interface SummaryRequest {
  readonly chapterNumber: number;
  readonly draftText: string;
  /** 本章计划（用于判断 requiredEvents 是否落实） */
  readonly planText?: string;
  /** 前几章的摘要（保持叙述连贯，避免重复交代） */
  readonly previousSummaries?: readonly string[];
}

export interface SummaryResult {
  readonly ok: boolean;
  readonly summary?: ChapterSummary;
  readonly error?: { code: string; message: string; details?: unknown };
  readonly attempts: number;
  /**
   * 校验失败但**内容仍然可用**的候选摘要（P1）。
   *
   * ## 为什么必须带回来
   *
   * 实测卡死路径：模型给出 505 字（上限 500），压缩重试也没压下来 →
   * `generate` 返回 ok:false，候选摘要**被整个丢弃**。
   * 于是作者无路可走：
   *   ① 重新生成 → 同样的超长
   *   ② `summary.approve` → summary 为 null，抛「还没有摘要，无法确认」
   *   ③ UI 无手写入口
   *   ④ `commit` → §十二 要求 approved=1，拒绝
   * → 该章**永久无法提交**，没有任何界面操作能改变。
   *
   * 但这份摘要的**内容本身是有价值的**（只是长了 1%）——
   * 让作者删两句就能用，比逼他重跑一次模型（还可能再超长）合理得多。
   *
   * ⚠ 只在**纯长度问题**时带回。含占位符/未来时的摘要说明模型没读懂
   *   正文，把它交给作者"改一改就确认"会诱使占位符进入长程记忆 ——
   *   那正是 ADR-0006 要防的"错一条污染后面几百章"。
   */
  readonly rejectedCandidate?: ChapterSummary;
}

/**
 * 摘要字数上限（默认值）。
 *
 * ⚠ 值定义在 `@nwa/core`（见 summary.ts）—— `approveSummary` 也要用它
 *   拦一次，而 storage 不能依赖 harness。这里只做 re-export 与默认值，
 *   避免两处阈值漂移。
 */
export const DEFAULT_SUMMARY_MAX_CHARS = SUMMARY_MAX_CHARS;

export interface SummaryGeneratorOptions {
  readonly structured: SummaryStructuredCaller;
  readonly logger: Logger;
  /**
   * 摘要字数上限（默认 500）。
   *
   * ⚠ 这个值要与 prompt 里的要求**一致**。实测踩到：prompt 写"100-250 字"
   * 而校验是 300 —— 模型给了 444 字，直接被拒。中文摘要要同时容纳
   * 人名/地名/物品/时间跨度/已改变处境，300 字确实偏紧。
   */
  readonly maxChars?: number;
}

/** 摘要输出契约（运行时校验，不信任模型输出形状） */
export const ChapterSummarySchema = z.object({
  // ⚠ 下限设 1 而不是 20：让"太短/只有标题"由 validateSummary 给出
  //   **可读的原因**，而不是在 schema 层报一句笼统的校验错误。
  //   实测踩到：min(20) 会让"第 1 章"这类摘要停在 schema 失败，
  //   用户看不到"缺少实质内容"这个真正的问题。
  summary: z.string().min(1).max(1200),
  keyFacts: z.array(z.string().min(2).max(200)).default([]),
  endState: z.string().min(2).max(500),
});

export class SummaryGenerator {
  private readonly structured: SummaryStructuredCaller;
  private readonly logger: Logger;
  private readonly maxChars: number;

  constructor(opts: SummaryGeneratorOptions) {
    this.structured = opts.structured;
    this.logger = opts.logger;
    this.maxChars = opts.maxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
  }

  /**
   * 从一章正文生成摘要候选。
   *
   * ⚠ 产物**未经确认**，不得直接进入检索（见 SummaryIndexer）。
   */
  async generate(req: SummaryRequest): Promise<SummaryResult> {
    const res = await this.structured<ChapterSummary>({
      schema: ChapterSummarySchema,
      schemaName: 'ChapterSummary',
      messages: buildMessages(req),
      maxTokens: 1200,
      // 摘要要稳、要忠实，不要创造性
      temperature: 0.1,
    });

    if (!res.ok) {
      this.logger.warn('摘要生成失败', {
        chapterNumber: req.chapterNumber,
        error: res.error.message,
      });
      return {
        ok: false,
        error: {
          code: res.error.code,
          message: res.error.message,
          details: { rawTextHead: (res.rawText ?? '').slice(0, 300) },
        },
        attempts: res.attempts,
      };
    }

    // 后置校验：长度与"不创作"的基本检查
    let data = res.data;
    let violations = validateSummary(data, req.draftText, this.maxChars);
    let attempts = res.attempts;

    // ⚠ 仅因"略超字数"而丢弃整段摘要是不划算的 ——
    //   实测：520 字 vs 上限 500 字（超出 4%），却让整章无法提交。
    //   这类问题**压缩一下就解决**，因此做一次定向重试。
    //   注意只对**纯长度问题**重试：含占位符/未来时说明模型没读懂正文，
    //   重试没有意义（那些必须让人看到并处理）。
    if (violations.length > 0 && violations.every((v) => v.includes('超出上限'))) {
      this.logger.info('摘要超字数，做一次压缩重试', {
        chapterNumber: req.chapterNumber,
        chars: data.summary.length,
        maxChars: this.maxChars,
      });

      const retry = await this.structured<ChapterSummary>({
        schema: ChapterSummarySchema,
        schemaName: 'ChapterSummary',
        messages: buildCompressMessages(req, data, this.maxChars),
        maxTokens: 1200,
        temperature: 0.1,
      });

      if (retry.ok) {
        const retryViolations = validateSummary(retry.data, req.draftText, this.maxChars);
        attempts += retry.attempts;
        // 压缩重试的结果更好才采纳（避免越改越差）
        if (retryViolations.length === 0) {
          data = retry.data;
          violations = [];
        } else {
          // 仍不合规：若压缩后只剩长度问题且更短，采纳更短的那份
          const shorter =
            retry.data.summary.length < data.summary.length ? retry.data : data;
          if (retryViolations.every((v) => v.includes('超出上限'))) {
            data = shorter;
            violations = validateSummary(data, req.draftText, this.maxChars);
          }
        }
      }
    }

    if (violations.length > 0) {
      this.logger.warn('摘要未通过校验', {
        chapterNumber: req.chapterNumber,
        violations,
        chars: data.summary.length,
      });
      // ⚠ 纯长度问题 → 把候选摘要带回给调用方（见 rejectedCandidate 的说明）。
      //   只在**全部违规都是长度**时带回：含占位符/未来时说明模型没读懂
      //   正文，交给作者"改一改就确认"会诱使它们进入长程记忆。
      const onlyLength = violations.every((v) => v.includes('超出上限'));
      return {
        ok: false,
        error: {
          code: ErrorCode.MODEL_STRUCTURED_EMPTY,
          message: `摘要校验未通过：${violations.join('；')}`,
          details: { violations, chars: data.summary.length },
        },
        ...(onlyLength ? { rejectedCandidate: data } : {}),
        attempts,
      };
    }

    this.logger.info('摘要生成完成', {
      chapterNumber: req.chapterNumber,
      chars: data.summary.length,
      keyFacts: data.keyFacts.length,
    });

    return { ok: true, summary: data, attempts };
  }
}

/**
 * 压缩重试的消息。
 *
 * ⚠ 把**实际字数与目标**明确告知，并保留原摘要作为改写对象 ——
 *   只说"太长了"模型往往会重新生成一份同样长的。
 */
function buildCompressMessages(
  req: SummaryRequest,
  prev: ChapterSummary,
  maxChars: number,
): { role: 'system' | 'user'; content: string }[] {
  const target = Math.floor(maxChars * 0.8); // 留出余量，别贴着上限
  const system = [
    '你是长篇小说的章节摘要器。上一次的摘要**超字数**，需要压缩。',
    '',
    '硬性要求：',
    `- summary 必须压缩到 **${target} 字以内**（当前 ${prev.summary.length} 字）。`,
    '- 压缩方式是**删冗余、并短句**，不是删事件。',
    '  必须保留：人物全名、地名、物品名、时间跨度、已改变的处境、章末钩子。',
    '- 仍然只陈述正文中已发生的事，不得推断、不得添加设定。',
    '- 仍然不要写"本章将""接下来会"这类预告，不要写占位符。',
    '- keyFacts 与 endState 保持原样即可（除非它们本身也需要缩短）。',
  ].join('\n');

  const user = [
    `【需要压缩的摘要（当前 ${prev.summary.length} 字，目标 ${target} 字以内）】`,
    prev.summary,
    '',
    '【本章正文（用于确认哪些信息不能丢）】',
    req.draftText,
    '',
    `请输出压缩后的摘要（summary 控制在 ${target} 字以内）。`,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * 摘要后置校验。
 *
 * ⚠ 这里的每一检查都对应一类"污染长程记忆"的具体失败：
 *   1. 过长 → 挤占后续章节预算，导致真正的正文被裁掉
 *   2. 含"待确认/TODO"等占位符 → 模型没读完正文就交差
 *   3. 含"本章将/接下来会"等**未来时** → 摘要是记录已发生的事，
 *      写成预告会让后续章节以为那些事已经发生了
 */
export function validateSummary(
  s: ChapterSummary,
  draftText: string,
  maxChars: number,
): string[] {
  const out: string[] = [];

  if (s.summary.length > maxChars) {
    out.push(`摘要 ${s.summary.length} 字超出上限 ${maxChars} 字（会挤占后续章节的上下文预算）`);
  }

  if (/待确认|待定|TODO|TBD|待填写|占位/.test(s.summary)) {
    out.push('摘要含占位符');
  }

  // 未来时：摘要必须记录已发生的事，不是预告
  if (/(本章将|接下来会|下一章将|后续将|将会|即将展开)/.test(s.summary)) {
    out.push('摘要使用了未来时（摘要应记录已发生的事，不是预告）');
  }

  if (/(本章将|接下来会|下一章将)/.test(s.endState)) {
    out.push('endState 使用了未来时');
  }

  // 只重复标题而无实质内容
  const stripped = s.summary.replace(/[第\d章节\s]/g, '');
  if (stripped.length < 15) {
    out.push('摘要缺少实质内容（疑似只回了标题）');
  }

  void draftText;
  return out;
}

// ── Prompt（§31：模块化） ───────────────────────────────────

function buildMessages(req: SummaryRequest): { role: 'system' | 'user'; content: string }[] {
  const system = [
    '你是长篇小说的章节摘要器。把给定正文压缩成一段供后续章节使用的摘要。',
    '',
    '硬性要求（摘要会作为后续章节的记忆源头，写错会污染几十章）：',
    '- **只陈述正文中已发生的事**。不得推断、不得添加正文没写的设定。',
    '- 用**过去时/完成体**记录，不要写"本章将""接下来会"这类预告。',
    '- 保留可延续的具体信息：人物全名、地名、物品名、时间跨度、已改变的处境。',
    '- 不要复述对话，不要评价文笔，不要总结"主题"。',
    '- 不要写"待确认""TODO"这类占位符。',
    '',
    '格式：',
    '- summary：一段话（200-400 字），按事件顺序叙述。务必控制在 400 字以内。',
    '- keyFacts：本章确立或改变的**具体事实**（如"林渊的妹妹林溪已失踪四天"），',
    '  每条一句话，只写正文明确写出的。',
    '- endState：本章结束时主角所处的新状态（下一章从这里继续）。',
  ].join('\n');

  const parts: string[] = [];
  if (req.previousSummaries?.length) {
    parts.push('【前情摘要（仅供保持连贯，不要重复叙述它们）】');
    parts.push(...req.previousSummaries.map((s, i) => `第 ${i + 1} 章：${s}`));
    parts.push('');
  }
  if (req.planText) {
    parts.push('【本章计划（用于确认要点是否落实）】', req.planText, '');
  }
  parts.push(`【本章正文】`, req.draftText);

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n') },
  ];
}

export { ErrorCode };
