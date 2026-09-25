/**
 * 逐章细纲生成（开书向导 Phase 3）
 *
 * ## 用户诉求
 * > 「配置 AI 生成大纲角色等等相关功能，再由用户进行**选择**、修改」
 *
 * ## 参考项目 oh-story-claudecode 的 Phase 3
 *
 * 原文铁律：**「不强行一次产出 30 章细纲；全书 ≤30 章且用户明确要全书细纲时，
 * 可分批连续交付。」**
 *
 * 本类据此把「一次生成多少章」变成**调用方必须指定的范围**，
 * 且上限 10 章（在代码里强制，不只写在提示词里）。
 *
 * ## ⚠ 本类最主要的修复场景：章号不连续
 *
 * 模型给出 10 章时，很常见地会漏掉其中一两章（尤其是"过渡章"）——
 * 它把 10 章的活干成 8 章，然后凑满数量。
 *
 * 后果是**静默的**：细纲按章号索引，缺章的那一章没有意图约束，
 * Planner 拿不到"作者确认过什么"，只能自由发挥。
 * 而作者看到"生成了 10 章细纲"，不会注意到缺了第 7 章。
 *
 * 所以 `validateChapterOutlinesSemantics` 把章号连续性作为主要检查，
 * 且修复指令必须**点名缺了哪几章** —— 只说"章号不连续"模型会再漏一次。
 */
import type { Logger } from '@nwa/core';
import { Logger as L } from '@nwa/core';
import type { ChatMessage, StructuredResult } from '@nwa/harness';
import {
  ChapterOutlinesOutputSchema,
  validateChapterOutlinesSemantics,
  CHAPTER_OUTLINE_SHAPE_HINT,
  type ChapterOutlinesOutput,
} from '@nwa/shared';
import { buildMessages, structuredTaskBlock } from '../prompts/index.js';
import { AGENT_OUTLINE_CHAPTERS, TASK_OUTLINE_CHAPTERS } from '../prompts/index.js';

/** 结构化输出器（与 Planner/ConceptGenerator 同一形状，由 Agent Runtime 注入） */
export type ChapterOutlineStructuredCaller = <T>(req: {
  schema: import('zod').ZodType<T, import('zod').ZodTypeDef, unknown>;
  schemaName: string;
  messages: readonly ChatMessage[];
}) => Promise<StructuredResult<T>>;

export interface ChapterOutlineRequest {
  /** 核心设定（Phase 2 已确认的内容） */
  readonly settings: {
    readonly logline: string;
    readonly coreConflict: string;
    readonly characters: readonly { name: string; role?: string }[];
    readonly worldEntities: readonly { name: string; description?: string }[];
  };
  /** 本批要生成的章号范围 */
  readonly startChapter: number;
  readonly endChapter: number;
  /** 所属卷（提供上下文；可空 —— 作者可能跳过卷纲直接排细纲） */
  readonly volume?: {
    readonly name: string;
    readonly coreEvent?: string;
    readonly startState?: string;
    readonly endState?: string;
  };
  /** 前一章的细纲（保证衔接；可空 —— 第一批没有前一章） */
  readonly previousOutline?: {
    readonly chapterNumber: number;
    readonly coreEvent: string;
    readonly ending: string;
  };
  /** 全书预计章数（总量锚点） */
  readonly estimatedChapters?: number;
  readonly bookTitle?: string;
}

export interface ChapterOutlineResult {
  readonly ok: boolean;
  readonly output?: ChapterOutlinesOutput;
  /**
   * 语义问题（重试后仍存在的）。
   *
   * ⚠ 与 `ok` 的关系：`ok = true` 但 `issues` 非空是**合法状态** ——
   *   表示 schema 通过、细纲可用，但质量有瑕疵（如缺了某几章）。
   *   调用方应把 issues 显示给作者，而不是丢弃整个结果：
   *   直接抛错会让作者丢掉已经生成好的 9 章。
   */
  readonly issues?: readonly string[];
  readonly attempts: number;
  readonly error?: { code: string; message: string; details?: unknown };
}

export interface ChapterOutlineGeneratorOptions {
  readonly structured: ChapterOutlineStructuredCaller;
  readonly logger?: Logger;
  /**
   * 语义修复的最大重试次数（默认 2）。
   *
   * ⚠ 比 ConceptGenerator 的 1 高：章号连续性是**机械约束**，
   *   模型拿到"缺了第 7、9 章"的具体反馈通常一次就能补齐
   *   （规则 11：机械性失败应触发定向修复，而不是丢弃结果）。
   */
  readonly maxSemanticRepair?: number;
  /** 单批上限（默认 10） */
  readonly maxBatch?: number;
}

/** 把请求渲染成上下文文本（纯函数，便于测试断言） */
export function renderChapterOutlineRequest(req: ChapterOutlineRequest): string {
  const ctx: string[] = [];

  if (req.bookTitle) ctx.push(`书名：${req.bookTitle}`);
  ctx.push(`一句话梗概：${req.settings.logline}`);
  ctx.push(`核心冲突：${req.settings.coreConflict}`);
  if (req.settings.characters.length > 0) {
    ctx.push(
      '主要角色：' +
        req.settings.characters
          .map((c) => (c.role ? `${c.name}（${c.role}）` : c.name))
          .join('、'),
    );
  }
  if (req.settings.worldEntities.length > 0) {
    ctx.push(
      '世界设定：' +
        req.settings.worldEntities
          .map((w) => (w.description ? `${w.name}（${w.description}）` : w.name))
          .join('、'),
    );
  }
  if (req.estimatedChapters) ctx.push(`全书预计：${req.estimatedChapters} 章`);

  if (req.volume) {
    const v = req.volume;
    const parts = [`所属卷：${v.name}`];
    if (v.coreEvent) parts.push(`卷核心事件：${v.coreEvent}`);
    if (v.startState && v.endState) {
      parts.push(`卷内状态变化：${v.startState} → ${v.endState}`);
    }
    ctx.push(parts.join('\n'));
  }

  if (req.previousOutline) {
    const p = req.previousOutline;
    ctx.push(
      `上一章（第 ${p.chapterNumber} 章）核心事件：${p.coreEvent}\n` +
        `上一章结尾落点：${p.ending}`,
    );
  }

  const count = req.endChapter - req.startChapter + 1;
  ctx.push(
    `\n本批任务：为第 ${req.startChapter} 章到第 ${req.endChapter} 章` +
      `（共 ${count} 章）逐章写出细纲。\n` +
      `⚠ 必须**一章不漏**地覆盖第 ${req.startChapter}-${req.endChapter} 章。`,
  );

  return ctx.join('\n');
}

export class ChapterOutlineGenerator {
  private readonly structured: ChapterOutlineStructuredCaller;
  private readonly logger: Logger;
  private readonly maxSemanticRepair: number;
  private readonly maxBatch: number;

  constructor(opts: ChapterOutlineGeneratorOptions) {
    this.structured = opts.structured;
    this.logger = opts.logger ?? new L('writing:outline-chapters');
    this.maxSemanticRepair = opts.maxSemanticRepair ?? 2;
    this.maxBatch = opts.maxBatch ?? 10;
  }

  async generate(req: ChapterOutlineRequest): Promise<ChapterOutlineResult> {
    // ⚠ 批量上限在**代码**里强制，不只在提示词里说 ——
    //   "一次最多 10 章"若只写在提示词里，模型在"生成 30 章"的任务下
    //   会照做（规则 4：prompt instruction is not a mechanism）。
    const count = req.endChapter - req.startChapter + 1;
    if (count < 1) {
      return {
        ok: false,
        attempts: 0,
        error: {
          code: 'INVALID_RANGE',
          message: `章号范围非法：${req.startChapter}-${req.endChapter}`,
        },
      };
    }
    if (count > this.maxBatch) {
      return {
        ok: false,
        attempts: 0,
        error: {
          code: 'BATCH_TOO_LARGE',
          message:
            `单批最多 ${this.maxBatch} 章，请求了 ${count} 章` +
            '（参考项目铁律：不强行一次产出全书细纲 —— 分批生成质量更高且可续做）',
        },
      };
    }

    const range = { startChapter: req.startChapter, endChapter: req.endChapter };
    const messages = buildMessages({
      agent: AGENT_OUTLINE_CHAPTERS,
      contextText: renderChapterOutlineRequest(req),
      task: [
        TASK_OUTLINE_CHAPTERS,
        structuredTaskBlock('ChapterOutlinesOutput', CHAPTER_OUTLINE_SHAPE_HINT),
      ],
    });

    let lastIssues: readonly string[] = [];
    let lastOutput: ChapterOutlinesOutput | undefined;
    let attempts = 0;

    for (let i = 0; i <= this.maxSemanticRepair; i++) {
      attempts++;
      const res = await this.structured<ChapterOutlinesOutput>({
        schema: ChapterOutlinesOutputSchema,
        schemaName: 'ChapterOutlinesOutput',
        messages,
      });

      if (!res.ok) {
        // ⚠ 结构化输出失败**不重试**：那是模型没按契约输出 JSON，
        //   重试同样的提示词多半还是失败（重试已由 gateway 负责）。
        //   语义问题才值得在这里重试。
        this.logger.warn('细纲结构化输出失败', {
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
      const issues = validateChapterOutlinesSemantics(res.data, range);
      if (issues.length === 0) {
        return { ok: true, output: res.data, attempts };
      }

      lastIssues = issues;
      this.logger.warn('细纲语义问题，尝试修复', { attempt: attempts, issues });

      // 把问题回灌给模型（追加一轮 user 消息，保留原始上下文）
      if (i < this.maxSemanticRepair) {
        // ⚠ 修复指令必须点名**具体缺了哪几章**。
        //   只说"章号不连续"，模型会再给一版同样缺章的。
        const missing = issues.filter((x) => x.startsWith('缺少第'));
        const hint =
          missing.length > 0
            ? `\n⚠ 你漏了这几章，必须补上：${missing.join('、')}`
            : '';
        messages.push({
          role: 'user',
          content: [
            '上一轮的输出有以下问题，请修正后重新输出完整 JSON：',
            ...issues.map((x) => `- ${x}`),
            hint,
            '',
            `⚠ 必须为第 ${req.startChapter}-${req.endChapter} 章的**每一章**` +
              '都写一条，一章不漏。输出前请自己数一遍条数。',
          ].join('\n'),
        });
      }
    }

    // 重试耗尽：**返回结果 + issues**，不抛错。
    //
    // ⚠ 直接用最后一次成功的输出，**不再发一次模型调用** ——
    //   重试耗尽时再问一遍只是多烧一次配额，结果同样是"有瑕疵"的。
    //
    // ⚠ `ok: true` 但 `issues` 非空是**合法状态**（见 ChapterOutlineResult 注释）：
    //   "缺了一两章"不是"细纲不可用"，作者可以在界面上补那一章。
    return { ok: true, output: lastOutput!, issues: lastIssues, attempts };
  }
}
