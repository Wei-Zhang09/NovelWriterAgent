/**
 * Reviewer（施工文档 §32 / §33，STEP 8）
 *
 * ## 职责与边界
 *
 *   Writer 写出文字 → **Reviewer 找出问题** → Revision 按问题改稿
 *
 * 三条必须守住的线：
 *
 * 1. **只输出问题，不输出分数**（§32）
 *    模型若返回 `{"score": 88}` 这类形状，**视为 schema 失败**，
 *    不做"从分数反推问题"的容错 —— 那会让"自证成功"重新溜回来。
 *
 * 2. **状态由 issues 推导，不信任模型的 overallStatus**
 *    模型可能一边列 BLOCKING 一边写 PASSED。用 deriveStatus() 机械推导，
 *    "只有 BLOCKING = 0 才能提交"才真的成立。
 *
 * 3. **需要依据的类别必须给出依据**
 *    CONTINUITY / TIMELINE / WORLD_RULE / FORESHADOWING / CHARACTER
 *    这几类的断言若没有 evidence id，整批拒绝。没有依据的断言等于
 *    "我觉得"，而"我觉得"不该阻塞别人的稿子。
 *
 * ## 与 Continuity Checker 的分工（重要）
 *
 * - **Continuity Checker**（STEP 10 已实现）：**确定性**检查，
 *   程序对账，结论可机械验证（死者出场、失明者看书）。
 * - **Reviewer**（本文件）：**模型判断**，覆盖无法机械判定的维度
 *   （剧情推进是否合理、对话是否像真人、节奏是否拖沓）。
 *
 * 两者结果**合并**成一份 issue 列表，但对它们的信任方式不同：
 * Checker 的结论直接采信；Reviewer 的结论需要 evidence 才能采信。
 */
import { Logger } from '@nwa/core';
import {
  ReviewOutputSchema,
  deriveStatus,
  sortIssues,
  findEvidenceViolations,
  summarizeIssues,
  type ReviewIssue,
  type ReviewOutput,
  type ReviewStatus,
} from '@nwa/shared';

/** 结构化调用（与 gateway 解耦） */
export type ReviewStructuredCaller = <T>(req: {
  readonly schema: import('zod').ZodType<T, import('zod').ZodTypeDef, unknown>;
  readonly schemaName: string;
  readonly messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}) => Promise<
  | { ok: true; data: T; attempts: number; usedFallback: boolean }
  | { ok: false; error: { code: string; message: string }; attempts: number; usedFallback: boolean; rawText?: string }
>;

export interface ReviewRequest {
  readonly chapterNumber: number;
  /** 待审正文 */
  readonly draftText: string;
  /** 装配好的上下文（Canon / 计划 / 前情） */
  readonly contextText: string;
  /** 计划（可选，用于检查是否落实） */
  readonly planText?: string;
  /** Checker 已确定的问题（合并进最终报告，且不参与"依据"校验） */
  readonly deterministicIssues?: readonly ReviewIssue[];
}

export interface ReviewResult {
  readonly ok: boolean;
  /** 合并后的全部问题（确定性 + 模型判断），已按严重度排序 */
  readonly issues: readonly ReviewIssue[];
  readonly status: ReviewStatus;
  /** 是否允许进入 Commit：唯一条件 BLOCKING = 0 */
  readonly canCommit: boolean;
  readonly summary: ReturnType<typeof summarizeIssues>;
  /** 模型部分是否成功（确定性检查可能仍有效） */
  readonly modelOk: boolean;
  readonly error?: { code: string; message: string; details?: unknown };
  readonly attempts: number;
}

export interface ReviewerOptions {
  readonly structured: ReviewStructuredCaller;
  readonly logger: Logger;
  /** 是否强制"需要依据的类别必须有 evidence"（默认 true） */
  readonly requireEvidence?: boolean;
}

export class Reviewer {
  private readonly structured: ReviewStructuredCaller;
  private readonly logger: Logger;
  private readonly requireEvidence: boolean;

  constructor(opts: ReviewerOptions) {
    this.structured = opts.structured;
    this.logger = opts.logger;
    this.requireEvidence = opts.requireEvidence ?? true;
  }

  /**
   * 审阅一章草稿。
   *
   * ⚠ 合并两类来源：
   *   - deterministicIssues（Checker 的机械判定）—— 直接采信
   *   - 模型输出的 issues —— 需要 evidence 才采信
   *   两者的 id 前缀不同（ci_ vs ri_），便于区分来源。
   */
  async review(req: ReviewRequest): Promise<ReviewResult> {
    const deterministic = req.deterministicIssues ?? [];

    const res = await this.structured<ReviewOutput>({
      schema: ReviewOutputSchema,
      schemaName: 'ReviewOutput',
      messages: buildMessages(req),
      maxTokens: 4096,
      temperature: 0.2, // 审稿要稳定，不要创造性
    });

    if (!res.ok) {
      // ⚠ 模型失败时**不**降级成"没问题"—— 那是最危险的失败模式
      //   （审稿没跑却当成通过）。返回明确失败，由调用方决定。
      this.logger.warn('模型审阅失败，仅返回确定性检查结果', {
        chapterNumber: req.chapterNumber,
        error: res.error.message,
        deterministicIssues: deterministic.length,
      });
      return {
        ok: false,
        issues: sortIssues(deterministic),
        status: deriveStatus(deterministic),
        canCommit: false, // 审稿未完成 → 不允许提交
        summary: summarizeIssues(deterministic),
        modelOk: false,
        error: {
          code: res.error.code,
          message: res.error.message,
          details: { rawTextHead: (res.rawText ?? '').slice(0, 300), deterministicIssues: deterministic.length },
        },
        attempts: res.attempts,
      };
    }

    // 依据校验：需要依据的类别缺 evidence → 整批拒绝
    if (this.requireEvidence) {
      const violations = findEvidenceViolations(res.data.issues);
      if (violations.length > 0) {
        this.logger.warn('审阅结果缺少依据，拒绝整批', {
          violations: violations.length,
          categories: violations.map((v) => v.category),
        });
        return {
          ok: false,
          issues: sortIssues(deterministic),
          status: deriveStatus(deterministic),
          canCommit: false,
          summary: summarizeIssues(deterministic),
          modelOk: false,
          error: {
            code: 'REVIEW_EVIDENCE_MISSING',
            message:
              `审阅结果中有 ${violations.length} 条断言缺少依据（类别：` +
              `${[...new Set(violations.map((v) => v.category))].join('、')}）。` +
              '这些类别的判断必须引用具体 Canon / 计划 id，否则无法复核。',
            details: { violations },
          },
          attempts: res.attempts,
        };
      }
    }

    // ⚠ 合并：确定性结论直接采信，模型结论已过依据校验
    const merged = sortIssues([...deterministic, ...res.data.issues]);
    const status = deriveStatus(merged);

    // 若模型声称的 status 与推导结果不符，以推导结果为准并记录
    if (res.data.overallStatus !== status) {
      this.logger.warn('模型声称的整体状态与 issues 推导结果不符，以推导结果为准', {
        modelSaid: res.data.overallStatus,
        derived: status,
        issueCount: merged.length,
      });
    }

    this.logger.info('审阅完成', {
      chapterNumber: req.chapterNumber,
      status,
      issues: merged.length,
      blocking: merged.filter((i) => i.severity === 'BLOCKING').length,
      deterministic: deterministic.length,
    });

    return {
      ok: true,
      issues: merged,
      status,
      canCommit: !merged.some((i) => i.severity === 'BLOCKING'),
      summary: summarizeIssues(merged),
      modelOk: true,
      attempts: res.attempts,
    };
  }
}

/**
 * 构造审阅消息。
 *
 * §31：模块化 prompt，不写大 Prompt。
 * 这里三段：身份与规则 / 输出契约 / 待审材料。
 */
function buildMessages(req: ReviewRequest): { role: 'system' | 'user'; content: string }[] {
  const system = [
    '你是中文长篇小说的审稿人。你的任务是找出这一章的具体问题。',
    '',
    '硬性要求：',
    '- 只报告问题，**不要给分数、不要给评级、不要总结优点**。',
    '- 每个问题必须指出：它是什么（claim）、在哪（location）、为什么（evidence）。',
    '- CONTINUITY / TIMELINE / WORLD_RULE / FORESHADOWING / CHARACTER 这几类，',
    '  evidence 必须填至少一个依据 id（Canon 事实 id、章节 id 或伏笔 id）。',
    '  没有依据就不要报这一类问题 —— 无依据的断言无法复核。',
    '- 没有问题就返回空的 issues 数组。不要为了凑数而报问题。',
    '- 不要报"文笔优美"这类无法验证的观察。',
    '',
    '不要做的事：',
    '- 不要重写正文，不要给出整段替换文本。你只负责指出问题。',
    '- 不要复述剧情。',
  ].join('\n');

  const contract = [
    '请以 ReviewOutput 结构一次性返回。',
    '',
    'severity 取值：BLOCKING（必须改，否则不能提交）/ MAJOR / MINOR / NOTE',
    'category 取值：' +
      'PLOT, CHARACTER, CONTINUITY, TIMELINE, WORLD_RULE, FORESHADOWING, ' +
      'PACING, DIALOGUE, EMOTION, DESCRIPTION, REPETITION, NATURALNESS, ' +
      'AI_LIKE_PATTERN, HOOK',
    '',
    'severity 的判定标准：',
    '- BLOCKING：与既定事实矛盾、人物失真到影响理解、情节无法成立',
    '  （例：已死亡的角色正常活动、已失明的角色在阅读）',
    '- MAJOR：明显削弱质量但不影响理解（例：节奏拖沓、对话像念稿）',
    '- MINOR：局部问题（例：用词重复、描写单薄）',
    '- NOTE：可选的改进建议',
  ].join('\n');

  const material = [
    `【第 ${req.chapterNumber} 章 正文】`,
    req.draftText,
    '',
    ...(req.planText ? ['【本章计划（用于检查是否落实）】', req.planText, ''] : []),
    '【既定事实与上下文】',
    req.contextText,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'system', content: contract },
    { role: 'user', content: material },
  ];
}
