/**
 * 选题方向生成器（开书向导 Phase 1）
 *
 * ## 用户诉求
 *
 * > 「应该配置 ai 生成大纲角色等等相关功能，再由用户进行**选择**、修改，
 * >    最后确认一切前置信息后，再开始写作呀」
 *
 * 本模块负责"生成"，选择与修改由界面承担。
 *
 * ## 参考项目 oh-story-claudecode 的 Phase 1
 *
 * 它先问作者「想让读者什么感觉 / 有没有对标 / 你的优势是什么」，
 * 再按优势映射题材方向。本生成器把这套问法作为**输入**（`ConceptRequest`），
 * 而不是在提示词里重问一遍 —— 界面已经问过了。
 *
 * ## ⚠ 结构照抄 Planner（不另发明）
 *
 * `Planner` 已经解决了同类问题的几个坑，直接复用它的形状：
 *   1. `structured` 由外部注入 —— 便于单测替换为确定性替身，
 *      也让本模块与具体模型解耦（不 import gateway）
 *   2. **语义问题自我修复重试**：schema 通过但业务约束不过时，
 *      把问题回灌给模型重试，而不是直接失败
 *   3. 重试次数有上限（默认 1），与 §33 的 `maxRevisionAttempts` 精神一致
 *
 * ## ⚠ 为什么"候选全同题材"要走重试而不是静默接受
 *
 * `validateConceptSemantics` 会检出"三个候选都是都市"这类情况。
 * 这不只是形式问题：作者的任务是**选择**，而没有差异的候选
 * 让"选择"这个动作不存在 —— 界面显示"生成了 3 个候选"，
 * 作者却挑不出东西，比只生成 1 个更让人困惑。
 *
 * 但重试**不保证成功**：模型可能第二次还是给同题材。
 * 所以重试耗尽后**不抛错**，而是把 `issues` 返回给调用方 ——
 * 由界面决定"提示作者候选相似"还是"直接展示"。
 * 把判断权交给界面，是因为"相似到什么程度算不可接受"是产品决策，
 * 不是本模块该替作者做的决定。
 */
import { Logger } from '@nwa/core';
import {
  ConceptOutputSchema,
  CONCEPT_SHAPE_HINT,
  validateConceptSemantics,
  type ConceptOutput,
} from '@nwa/shared';
import type { StructuredResult } from '@nwa/harness';
import {
  AGENT_CONCEPT,
  TASK_CONCEPT,
  buildMessages,
  structuredTaskBlock,
} from '../prompts/index.js';

/**
 * 生成请求。
 *
 * ⚠ 三个偏好字段全部可选：作者可能什么都不说就要几个方向。
 *   「信息不足就由你决定」是本项目的既定原则（见 AGENT_PLANNER 的
 *   「材料不足」条款），不要因为字段空着就拒绝生成。
 */
export interface ConceptRequest {
  /** 想让读者产生的感觉（对标 oh-story 的"你想让读者什么感觉"） */
  readonly desiredEmotion?: string;
  /** 作者自认的优势（脑洞好/文笔好/节奏感好/生活经验丰富） */
  readonly strengths?: string;
  /** 想对标的作品或方向 */
  readonly reference?: string;
  /** 作者已有的具体想法（有则不再发散，围绕它给候选） */
  readonly existingIdea?: string;
  /** 作者指定的题材（有则候选应围绕它，但仍要给不同冲突方向） */
  readonly genre?: string;
  /** 这本书的标题（若已建书）—— 让候选与书名相称 */
  readonly bookTitle?: string;
}

/** 结构化输出器（与 Planner 同一形状，由 Agent Runtime 注入） */
export type ConceptStructuredCaller = <T>(req: {
  schema: import('zod').ZodType<T, import('zod').ZodTypeDef, unknown>;
  schemaName: string;
  messages: readonly import('@nwa/harness').ChatMessage[];
}) => Promise<StructuredResult<T>>;

export interface ConceptGeneratorOptions {
  readonly structured: ConceptStructuredCaller;
  readonly logger?: Logger;
  /** 语义修复的最大重试次数（默认 1） */
  readonly maxSemanticRepair?: number;
}

export interface ConceptResult {
  readonly ok: boolean;
  readonly output?: ConceptOutput;
  /**
   * 语义问题（重试后仍存在的）。
   *
   * ⚠ 与 `ok` 的关系：`ok = true` 但 `issues` 非空是**合法状态** ——
   *   表示 schema 通过、候选可用，但质量有瑕疵（如题材相近）。
   *   调用方应把 issues 显示给作者，而不是丢弃整个结果。
   *   这与 Planner 不同（那里 issues 非空 = 不 ok），因为
   *   "候选相近"不是"计划不可执行"。
   */
  readonly issues?: readonly string[];
  readonly attempts: number;
  readonly error?: { code: string; message: string; details?: unknown };
}

export class ConceptGenerator {
  private readonly structured: ConceptStructuredCaller;
  private readonly logger: Logger;
  private readonly maxSemanticRepair: number;

  constructor(opts: ConceptGeneratorOptions) {
    this.structured = opts.structured;
    this.logger = opts.logger ?? new Logger('writing:concept');
    this.maxSemanticRepair = opts.maxSemanticRepair ?? 1;
  }

  async generate(req: ConceptRequest): Promise<ConceptResult> {
    const messages = buildMessages({
      agent: AGENT_CONCEPT,
      contextText: renderRequest(req),
      task: [TASK_CONCEPT, structuredTaskBlock('ConceptOutput', CONCEPT_SHAPE_HINT)],
    });

    let lastIssues: readonly string[] = [];
    let lastOutput: ConceptOutput | undefined;
    let attempts = 0;

    for (let i = 0; i <= this.maxSemanticRepair; i++) {
      attempts++;
      const res = await this.structured<ConceptOutput>({
        schema: ConceptOutputSchema,
        schemaName: 'ConceptOutput',
        messages,
      });

      if (!res.ok) {
        // ⚠ 结构化输出失败**不重试**：那是模型没按契约输出 JSON，
        //   重试同样的提示词多半还是失败（重试已由 gateway 负责）。
        //   语义问题才值得在这里重试。
        this.logger.warn('选题结构化输出失败', {
          code: res.error.code,
          attempts: res.attempts,
          usedFallback: res.usedFallback,
        });
        return {
          ok: false,
          attempts,
          error: {
            code: res.error.code,
            message: res.error.message,
            details: {
              schemaAttempts: res.attempts,
              usedFallback: res.usedFallback,
              rawTextHead: res.rawText.slice(0, 300),
            },
          },
        };
      }

      lastOutput = res.data;
      const issues = validateConceptSemantics(res.data);
      if (issues.length === 0) {
        return { ok: true, output: res.data, attempts };
      }

      lastIssues = issues;
      this.logger.warn('选题候选语义问题，尝试修复', {
        attempt: attempts,
        issues,
      });

      // 把问题回灌给模型（追加一轮 user 消息，保留原始上下文）
      if (i < this.maxSemanticRepair) {
        messages.push({
          role: 'user',
          content: [
            '上一轮的输出有以下问题，请修正后重新输出完整 JSON：',
            ...issues.map((x) => `- ${x}`),
            '',
            '注意：修正的是内容，不是格式。请给出真正不同的方向。',
          ].join('\n'),
        });
      }
    }

    // 重试耗尽：**返回结果 + issues**，不抛错。
    //
    // ⚠ 这里直接用最后一次成功的输出，**不再发一次模型调用** ——
    //   重试耗尽时再问一遍只是多烧一次配额，而且结果同样是"有瑕疵"的，
    //   不会因为多问一次就变好。
    //
    // ⚠ `ok: true` 但 `issues` 非空是**合法状态**（见 ConceptResult 注释）：
    //   "候选相近"不是"结果不可用"，判断权交给界面/作者。
    return { ok: true, output: lastOutput!, issues: lastIssues, attempts };
  }
}

/**
 * 把请求渲染成上下文文本。
 *
 * ⚠ 空字段**不渲染成"（未提供）"** —— 那会让模型把注意力放在
 *   "缺了什么"上，而不是"根据已有的给方向"。
 *   没有的项直接不出现。
 */
export function renderRequest(req: ConceptRequest): string {
  const lines: string[] = [];
  const push = (label: string, v?: string) => {
    if (v && v.trim().length > 0) lines.push(`${label}：${v.trim()}`);
  };
  push('书名', req.bookTitle);
  push('作者想让读者产生的感觉', req.desiredEmotion);
  push('作者自认的优势', req.strengths);
  push('想对标的作品或方向', req.reference);
  push('作者已有的具体想法', req.existingIdea);
  push('作者指定的题材', req.genre);

  if (lines.length === 0) {
    // 完全没给信息也要能生成 —— 这是"信息不足就由你决定"原则的落地。
    // 但要明确告诉模型"没有偏好约束"，否则它会以为漏读了上下文。
    return '作者未提供任何偏好信息。请完全自主地提出 2-3 个有市场依据的开书方向。';
  }
  return `作者提供的信息：\n\n${lines.join('\n')}`;
}
