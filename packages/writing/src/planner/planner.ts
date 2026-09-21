/**
 * Planner（施工文档 §7.2）
 *
 * 职责：卷/章规划、Scene 切分、节奏、章末钩子。**Planner 不写正文。**
 *
 * 关键设计：
 *   1. **结构化输出走单次提交**（研究报告 §1.2 决策 4）：
 *      模型必须一次性给出 brief + 全部 scenes，宿主不做 JSON 抠取。
 *   2. **语义问题自我修复**：schema 通过但业务约束不过（如 startState === endState）
 *      时，把问题回灌给模型重试一次 —— 而不是直接失败整个 Run。
 *   3. **模型不能改 Canon**：Planner 只产出计划，不写任何正式文件。
 */
import { ErrorCode, Logger } from '@nwa/core';
import {
  PlanOutputSchema,
  validatePlanSemantics,
  splitPlanIssues,
  type PlanOutput,
} from '@nwa/shared';
import type { StructuredResult } from '@nwa/harness';
import {
  AGENT_PLANNER,
  PLAN_SHAPE_HINT,
  TASK_PLAN_CHAPTER,
  buildMessages,
  structuredTaskBlock,
} from '../prompts/index.js';

export interface PlanRequest {
  readonly chapterNumber: number;
  /** 由 Context Engine 装配好的上下文文本 */
  readonly contextText: string;
  /** 上一章摘要（便于承接） */
  readonly previousSummary?: string;
  /** 用户对本章的额外要求 */
  readonly userInstruction?: string;
}

/**
 * 结构化输出器：由 Agent Runtime 注入（走 Model Gateway 的三级降级）。
 *
 * 之所以注入而不是直接依赖 gateway：便于单测替换为确定性的替身，
 * 也让 Planner 与具体模型解耦。
 */
export type StructuredCaller = <T>(req: {
  schema: import('zod').ZodType<T, import('zod').ZodTypeDef, unknown>;
  schemaName: string;
  messages: readonly import('@nwa/harness').ChatMessage[];
}) => Promise<StructuredResult<T>>;

export interface PlannerOptions {
  readonly structured: StructuredCaller;
  readonly logger?: Logger;
  /** 语义修复的最大重试次数（默认 1 —— 与 §33 的 maxRevisionAttempts 精神一致） */
  readonly maxSemanticRepair?: number;
}

export interface PlanResult {
  readonly ok: boolean;
  readonly plan?: PlanOutput;
  readonly issues?: readonly string[];
  readonly attempts: number;
  readonly error?: { code: string; message: string; details?: unknown };
}

export class Planner {
  private readonly structured: StructuredCaller;
  private readonly logger: Logger;
  private readonly maxSemanticRepair: number;

  constructor(opts: PlannerOptions) {
    this.structured = opts.structured;
    this.logger = opts.logger ?? new Logger('writing:planner');
    this.maxSemanticRepair = opts.maxSemanticRepair ?? 1;
  }

  /**
   * 生成章节计划。
   *
   * 流程：
   *   schema 校验（由 gateway 的 structured 完成）
   *   → 语义校验（本模块）
   *   → 有阻塞问题则把问题回灌重试（最多 maxSemanticRepair 次）
   *   → 仍失败则返回 issues（调用方决定是否降级为质量债）
   */
  async plan(req: PlanRequest): Promise<PlanResult> {
    let attempts = 0;
    let repairHint = '';

    for (let round = 0; round <= this.maxSemanticRepair; round++) {
      attempts++;
      const task = [
        TASK_PLAN_CHAPTER,
        structuredTaskBlock('PlanOutput', PLAN_SHAPE_HINT),
      ];

      // 把上一轮发现的语义问题作为修复指令追加（这是"自我修复"的关键）
      const extra: string[] = [];
      if (req.userInstruction) extra.push(`作者补充要求：${req.userInstruction}`);
      if (repairHint) {
        extra.push(
          '上一次生成存在以下问题，请修正后重新输出完整 JSON：\\n' + repairHint,
        );
      }

      const messages = buildMessages({
        agent: AGENT_PLANNER,
        contextText: this.composeContext(req),
        task: extra.length > 0
          ? [...task, { id: 'task.extra', text: extra.join('\\n\\n') }]
          : task,
      });

      const res = await this.structured({
        schema: PlanOutputSchema,
        schemaName: 'PlanOutput',
        messages,
      });

      if (!res.ok) {
        // schema 层面就失败：直接返回，不再做语义修复（重试已由 gateway 负责）
        this.logger.warn('Plan 结构化输出失败', {
          chapter: req.chapterNumber,
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

      const issues = validatePlanSemantics(res.data);
      const { blocking, advisory } = splitPlanIssues(issues);

      if (blocking.length === 0) {
        this.logger.info('Plan 生成成功', {
          chapter: req.chapterNumber,
          scenes: res.data.scenes.length,
          attempts,
          advisory,
        });
        return {
          ok: true,
          plan: res.data,
          issues: advisory,
          attempts,
        };
      }

      this.logger.warn('Plan 语义校验未通过，准备修复重试', {
        chapter: req.chapterNumber,
        round,
        blocking,
      });
      repairHint = blocking.map((b) => `- ${b}`).join('\\n');

      if (round === this.maxSemanticRepair) {
        // 重试用尽：返回阻塞问题，由调用方决定（可降级为质量债，见 ADR-0005）
        return {
          ok: false,
          attempts,
          issues: blocking,
          error: {
            code: ErrorCode.MODEL_STRUCTURED_EMPTY,
            message: `Plan 语义校验在 ${attempts} 次尝试后仍未通过`,
            details: { blocking, advisory },
          },
        };
      }
    }

    // 理论不可达
    return {
      ok: false,
      attempts,
      error: { code: ErrorCode.MODEL_STRUCTURED_EMPTY, message: 'Plan 生成未产生结果' },
    };
  }

  /** 拼装上下文：把 Context Engine 的输出与上一章摘要合并 */
  private composeContext(req: PlanRequest): string {
    const parts: string[] = [];
    if (req.previousSummary) {
      parts.push(`## 上一章摘要\\n${req.previousSummary}`);
    }
    if (req.contextText.trim().length > 0) {
      parts.push(req.contextText);
    }
    parts.push(`## 本章章号\\n第 ${req.chapterNumber} 章`);
    return parts.join('\\n\\n');
  }
}
