/**
 * 卷级大纲生成（开书向导 Phase 3）
 *
 * ## 用户诉求
 * > 「配置 AI 生成大纲角色等等相关功能，再由用户进行**选择**、修改」
 *
 * ## 参考项目 oh-story-claudecode 的 Phase 3（`workflow-setup.md`）
 *
 * 卷纲前置是「全书体量与阶段总览」：全书总章节数 / 目标字数 / 情绪曲线 +
 * 四阶段划分（开篇期 10-15% / 发展期 50-60% / 高潮期 20-25% / 收尾期 5-10%），
 * 然后才写「卷级大纲」：每卷的功能 / 所属阶段 / 卷契约 / 核心事件 /
 * 起始状态 → 结束状态。
 *
 * ⚠ 原文明说「比例只作默认参考，**必须按题材、目标字数和对标节奏调整，
 *   不能机械套模板**」—— 所以本实现**不把百分比写进提示词当硬约束**，
 *   而是把作者确认的 estimatedChapters 作为总量锚点交给模型。
 *
 * ## ⚠ 本阶段的输出有一处与其他阶段不同的风险：**全局不变量**
 *
 * 卷的章号范围必须从 1 开始、首尾相接、不重叠、覆盖到 totalChapters。
 * 这三条**逐卷校验查不出来**（每卷单独看都合法），只有整体看才不成立。
 * 而它们一旦不成立，后果是静默的：细纲按章号查"我在哪一卷"，
 * 查不到的章被当成"不属于任何卷"，于是那一章失去卷级约束 —— 不报错，
 * 只是写得跑偏。
 *
 * 所以 `validateOutlineSemantics` 会先按 chapterStart 排序再整体检查，
 * 且这里是**最主要的修复重试场景**（模型给出断开的章号范围很常见）。
 */
import { Logger } from '@nwa/core';
import {
  OutlineOutputSchema,
  OUTLINE_SHAPE_HINT,
  validateOutlineSemantics,
  VOLUME_STAGE_LABELS,
  type OutlineOutput,
} from '@nwa/shared';
import type { StructuredResult } from '@nwa/harness';
import {
  AGENT_OUTLINE,
  TASK_OUTLINE,
  buildMessages,
  structuredTaskBlock,
} from '../prompts/index.js';

/**
 * 生成请求：承接 Phase 2 已确认的设定。
 *
 * ⚠ `settings` 必填：卷纲是"从核心设定出发排全书结构"，
 *   没有设定就没法排（哪一卷该揭开什么真相，取决于设定里有什么）。
 */
export interface OutlineRequest {
  readonly settings: {
    readonly logline: string;
    readonly coreConflict: string;
    readonly characters: readonly { name: string; role: string | null }[];
    readonly worldEntities: readonly { name: string; description: string }[];
  };
  readonly bookTitle?: string;
  /**
   * ⚠ 全书预计章数（来自 Phase 1 确认的选题）。
   *
   *   这是**总量锚点**：卷的章号范围之和必须等于它。
   *   不给这个锚点，模型给的 totalChapters 会与各卷范围不自洽
   *   （声称 200 章但卷范围只到 150），而那条不变量是必需的。
   */
  readonly estimatedChapters: number;
  /** 作者对结构的要求（如"三卷就够"） */
  readonly userInstruction?: string;
}

export type OutlineStructuredCaller = <T>(req: {
  schema: import('zod').ZodType<T, import('zod').ZodTypeDef, unknown>;
  schemaName: string;
  messages: readonly import('@nwa/harness').ChatMessage[];
}) => Promise<StructuredResult<T>>;

export interface OutlineGeneratorOptions {
  readonly structured: OutlineStructuredCaller;
  readonly logger?: Logger;
  readonly maxSemanticRepair?: number;
}

export interface OutlineResult {
  readonly ok: boolean;
  readonly output?: OutlineOutput;
  readonly issues?: readonly string[];
  readonly attempts: number;
  readonly error?: { code: string; message: string; details?: unknown };
}

export class OutlineGenerator {
  private readonly structured: OutlineStructuredCaller;
  private readonly logger: Logger;
  private readonly maxSemanticRepair: number;

  constructor(opts: OutlineGeneratorOptions) {
    this.structured = opts.structured;
    this.logger = opts.logger ?? new Logger('writing:outline');
    this.maxSemanticRepair = opts.maxSemanticRepair ?? 2;
  }

  async generate(req: OutlineRequest): Promise<OutlineResult> {
    const messages = buildMessages({
      agent: AGENT_OUTLINE,
      contextText: renderOutlineRequest(req),
      task: [TASK_OUTLINE, structuredTaskBlock('OutlineOutput', OUTLINE_SHAPE_HINT)],
    });

    let lastIssues: readonly string[] = [];
    let lastOutput: OutlineOutput | undefined;
    let attempts = 0;

    for (let i = 0; i <= this.maxSemanticRepair; i++) {
      attempts++;
      const res = await this.structured<OutlineOutput>({
        schema: OutlineOutputSchema,
        schemaName: 'OutlineOutput',
        messages,
      });

      if (!res.ok) {
        this.logger.warn('卷纲结构化输出失败', {
          code: res.error.code,
          attempts: res.attempts,
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
      const issues = validateOutlineSemantics(res.data);
      if (issues.length === 0) {
        return { ok: true, output: res.data, attempts };
      }

      lastIssues = issues;
      this.logger.warn('卷纲语义问题，尝试修复', { attempt: attempts, issues });

      if (i < this.maxSemanticRepair) {
        messages.push({
          role: 'user',
          content: [
            '上一轮的卷纲有以下问题，请修正后重新输出完整 JSON：',
            ...issues.map((x) => `- ${x}`),
            '',
            `注意：全书共 ${req.estimatedChapters} 章。`,
            '各卷的章号范围必须**从第 1 章开始、首尾相接、不重叠**，',
            `且最后一卷必须结束于第 ${req.estimatedChapters} 章。`,
            '例如三卷 200 章应为：1-40、41-140、141-200。',
          ].join('\n'),
        });
      }
    }

    // 重试耗尽：返回结果 + issues，不抛错（判断权交给界面）
    return { ok: true, output: lastOutput!, issues: lastIssues, attempts };
  }
}

/**
 * 把请求渲染成上下文文本。
 *
 * ⚠ 设定（角色/世界观）要**全量列出**：卷纲的职责是安排"什么时候揭开
 *   哪条设定"，不知道有哪些设定就排不出结构。
 *   这与 Context Engine 的预算裁剪不同 —— 那是写作时按章裁剪，
 *   这里是"排全书结构"，必须看到全貌（而核心设定本来就只有几条）。
 */
export function renderOutlineRequest(req: OutlineRequest): string {
  const lines: string[] = [];

  if (req.bookTitle) lines.push(`书名：${req.bookTitle}`);
  lines.push('');
  lines.push('【已确认的核心设定】');
  lines.push(`- 一句话梗概：${req.settings.logline}`);
  lines.push(`- 主线矛盾：${req.settings.coreConflict}`);
  lines.push('');
  lines.push(`- 全书预计章数：${req.estimatedChapters} 章`);

  if (req.settings.characters.length > 0) {
    lines.push('');
    lines.push('【角色】');
    for (const c of req.settings.characters) {
      lines.push(`- ${c.name}${c.role ? `（${c.role}）` : ''}`);
    }
  }

  if (req.settings.worldEntities.length > 0) {
    lines.push('');
    lines.push('【世界观设定】');
    for (const w of req.settings.worldEntities) {
      lines.push(`- ${w.name}：${w.description}`);
    }
  }

  if (req.userInstruction && req.userInstruction.trim().length > 0) {
    lines.push('');
    lines.push(`【作者对结构的要求】\n${req.userInstruction.trim()}`);
  }

  return lines.join('\n');
}

/** 把 stage 枚举渲染成中文（界面用） */
export function volumeStageLabel(stage: string): string {
  return (VOLUME_STAGE_LABELS as Record<string, string>)[stage] ?? stage;
}
