/**
 * Revision（改稿）—— 施工文档 §7.4 / §33【补最后一块功能缺口】
 *
 * ## 为什么需要它（真实运行暴露）
 *
 * 真实 2 章运行中，第 2 章的 Reviewer 准确报出 2 个**真实**问题：
 *   1. 同一场景被完整写了两遍（韩素离开的段落重复，前后矛盾）
 *   2. 刻痕日期前后不一致（十月十七 vs 九月十七）
 *
 * 门禁正确拦截（`可提交=false`）—— 但**没有自动改稿环节**，
 * 稿子就停在那里，只能人工改 `revision.md`。
 * Reviewer 已经给出了可执行的诊断（哪一段重复、哪个日期不一致），
 * 而下游没人消费它。这就是本模块要补的环节。
 *
 * ## 三条设计纪律（都针对"改稿比写稿更容易毁稿"）
 *
 * 1. **只改被指出的地方，不做整体重写**
 *    让模型自由重写整章会顺手改掉不该改的（人名、已确立的细节），
 *    而那些改动**不会被审稿发现**（因为审稿只看新稿）。
 *    因此这里是**逐 issue 定向修改**，且改完要能比对。
 *
 * 2. **写 revision.md，绝不覆盖 draft.md**
 *    原稿必须保留 —— 改坏了要能退回去。这也是 ChapterWorkspace
 *    早就规定的产物布局（§9）。
 *
 * 3. **改完不自动通过，必须重新审稿**
 *    改稿本身可能引入新问题。因此 Revision 只产出 revision.md，
 *    随后必须重跑 Reviewer，由门禁决定能否提交（Revising → Reviewing
 *    在状态机里是明确的回边）。
 */
import { ErrorCode, Logger } from '@nwa/core';
import type { ReviewIssue } from '@nwa/shared';
import type { ChapterWorkspace } from '@nwa/story';

/** 纯文本补全调用（与 gateway 解耦，失败抛错） */
export type RevisionCompleter = (req: {
  readonly messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}) => Promise<{
  readonly text: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}>;

export interface RevisionOptions {
  readonly complete: RevisionCompleter;
  readonly workspace: ChapterWorkspace;
  readonly logger: Logger;
  /** 一次最多处理多少个问题（默认 6）。过多会让模型失去焦点 */
  readonly maxIssuesPerPass?: number;
}

/** 单个 issue 的修改结果 */
export interface IssueOutcome {
  readonly issueId: string;
  readonly severity: string;
  readonly category: string;
  /** 是否让模型做了修改 */
  readonly revised: boolean;
  /** 模型对本次修改的说明（自报，供人工复核） */
  readonly note: string;
  /** 模型判断"不需修改"时的理由 */
  readonly skippedReason?: string;
}

export interface RevisionResult {
  readonly ok: boolean;
  /** 修订后的全文（已写入 revision.md） */
  readonly text?: string;
  readonly revisionPath?: string;
  readonly outcomes: readonly IssueOutcome[];
  readonly totalChars?: number;
  /** 相对原稿的变化量（字符数差） */
  readonly deltaChars?: number;
  readonly usage: { inputTokens: number; outputTokens: number };
  readonly error?: { code: string; message: string; details?: unknown };
}

export class Reviser {
  private readonly complete: RevisionCompleter;
  private readonly workspace: ChapterWorkspace;
  private readonly logger: Logger;
  private readonly maxIssuesPerPass: number;

  constructor(opts: RevisionOptions) {
    this.complete = opts.complete;
    this.workspace = opts.workspace;
    this.logger = opts.logger;
    this.maxIssuesPerPass = opts.maxIssuesPerPass ?? 6;
  }

  /**
   * 按审稿问题定向改稿。
   *
   * @param draftText  原稿（来自 draft.md）
   * @param issues     审稿问题（只处理 BLOCKING / MAJOR —— MINOR/NOTE 不值得改稿风险）
   */
  async revise(input: {
    readonly chapterNumber: number;
    readonly draftText: string;
    readonly issues: readonly ReviewIssue[];
  }): Promise<RevisionResult> {
    // ⚠ 只改 BLOCKING / MAJOR。
    //   MINOR / NOTE 大多是风格偏好，为它们动整章不划算 ——
    //   改稿的风险（引入新矛盾）往往大于收益。
    const targets = input.issues
      .filter((i) => i.severity === 'BLOCKING' || i.severity === 'MAJOR')
      .slice(0, this.maxIssuesPerPass);

    if (targets.length === 0) {
      this.logger.info('无需要改稿的问题（无 BLOCKING/MAJOR）', {
        chapterNumber: input.chapterNumber,
        totalIssues: input.issues.length,
      });
      // 无需改稿时也写一份 revision.md（与原稿一致），
      // 让后续流程有统一入口（不必再判断"有没有 revision"）
      const p = this.workspace.writeText('revision', input.draftText);
      return {
        ok: true,
        text: input.draftText,
        revisionPath: p,
        outcomes: [],
        totalChars: input.draftText.length,
        deltaChars: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    this.logger.info('开始改稿', {
      chapterNumber: input.chapterNumber,
      targets: targets.length,
      blocking: targets.filter((i) => i.severity === 'BLOCKING').length,
    });

    const outcomes: IssueOutcome[] = [];
    let current = input.draftText;
    let inputTokens = 0;
    let outputTokens = 0;

    // 逐 issue 定向修改，每次都在上一次的产物上继续 ——
    // 这样每个问题的修改可归因，出问题也能定位是哪一步引入的
    for (const issue of targets) {
      const res = await this.applyOne(current, issue, input.chapterNumber);
      if (!res.ok) {
        // ⚠ 单个 issue 失败不中断整轮：已改的部分仍有价值。
        //   但要记录失败原因，不能静默跳过。
        outcomes.push({
          issueId: issue.id,
          severity: issue.severity,
          category: issue.category,
          revised: false,
          note: '',
          skippedReason: `改稿调用失败：${res.error?.message ?? '未知错误'}`,
        });
        continue;
      }

      inputTokens += res.usage?.inputTokens ?? 0;
      outputTokens += res.usage?.outputTokens ?? 0;

      if (res.text !== null && res.text !== undefined && res.text.trim().length > 0) {
        current = res.text.trim();
        outcomes.push({
          issueId: issue.id,
          severity: issue.severity,
          category: issue.category,
          revised: true,
          note: res.note ?? '',
        });
      } else {
        outcomes.push({
          issueId: issue.id,
          severity: issue.severity,
          category: issue.category,
          revised: false,
          note: '',
          skippedReason: res.note ?? '模型未返回修改后的正文',
        });
      }
    }

    const revisionPath = this.workspace.writeText('revision', current);

    // 落盘改稿记录，便于人工复核"改了什么"
    this.workspace.writeJson('review', {
      kind: 'revision-log',
      chapterNumber: input.chapterNumber,
      outcomes,
      originalChars: input.draftText.length,
      revisedChars: current.length,
    });

    const revisedCount = outcomes.filter((o) => o.revised).length;
    this.logger.info('改稿完成', {
      chapterNumber: input.chapterNumber,
      revised: revisedCount,
      total: targets.length,
      deltaChars: current.length - input.draftText.length,
    });

    return {
      ok: true,
      text: current,
      revisionPath,
      outcomes,
      totalChars: current.length,
      deltaChars: current.length - input.draftText.length,
      usage: { inputTokens, outputTokens },
    };
  }

  /** 针对单个问题做一次定向修改 */
  private async applyOne(
    text: string,
    issue: ReviewIssue,
    chapterNumber: number,
  ): Promise<
    | { ok: true; text: string; note?: string; usage?: { inputTokens: number; outputTokens: number } }
    | { ok: false; error: { code: string; message: string } }
  > {
    try {
      const res = await this.complete({
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildIssueTask(text, issue, chapterNumber) },
        ],
        // 输出长度按输入估算（改稿通常比原文略长一点）
        maxTokens: Math.ceil(text.length * 2.2) + 512,
        temperature: 0.3, // 改稿要保守，不要发挥
      });

      // 模型若明确表示"无需修改"，尊重它并记录理由
      const skipMatch = res.text.match(/^\s*(无需修改|不需要修改|NO_CHANGE)\s*[：:]\s*(.+)$/m);
      if (skipMatch) {
        return { ok: true, text: '', note: skipMatch[2]!.trim(), usage: res.usage };
      }

      return { ok: true, text: res.text, usage: res.usage };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return {
        ok: false,
        error: {
          code: err.code ?? ErrorCode.MODEL_TIMEOUT,
          message: err.message ?? '改稿调用失败',
        },
      };
    }
  }
}

// ── Prompt（§31：模块化） ───────────────────────────────────

/**
 * 改稿系统提示。
 *
 * ⚠ 这里的每一条禁令都对应一类"改稿毁稿"：
 *   自由重写 → 顺手改掉不该改的人名与细节，且审稿发现不了
 *   加新情节 → 引入计划外的设定，污染后续章节
 *   改文风   → 与已提交章节的语感脱节
 */
function buildSystemPrompt(): string {
  return [
    '你是小说改稿者。你只做**定向修正**，不重写、不润色、不发挥。',
    '',
    '硬性要求：',
    '- 只修改被指出的问题所涉及的部分。其余文字**逐字保留**。',
    '- 不得改动人物姓名、地名、物品名、已确立的时间与事实。',
    '- 不得添加原文没有的新情节、新人物、新设定。',
    '- 不得改变叙事视角与人称。',
    '- 不要调整文风，保持与原文一致。',
    '',
    '输出要求：',
    '- 直接输出**修改后的完整正文**（不是片段、不是 diff、不是说明）。',
    '- 不要加任何解释、批注、markdown 围栏。',
    '- 如果你判断该问题无需修改（例如属于审稿误报），',
    '  只输出一行：`无需修改：<你的理由>`。',
  ].join('\n');
}

function buildIssueTask(text: string, issue: ReviewIssue, chapterNumber: number): string {
  const parts = [
    `【第 ${chapterNumber} 章 待改正文】`,
    text,
    '',
    '【需要修正的问题】',
    `类别：${issue.category}｜严重度：${issue.severity}`,
    `问题：${issue.claim}`,
  ];

  if (issue.evidence.length > 0) {
    parts.push('依据：');
    for (const e of issue.evidence) parts.push(`  - ${e}`);
  }
  if (issue.location?.excerpt) {
    parts.push(`定位片段：${issue.location.excerpt}`);
  }
  if (issue.location?.paragraph !== undefined) {
    parts.push(`位置：第 ${issue.location.paragraph} 段`);
  }
  if (issue.suggestions.length > 0) {
    parts.push('建议方向：');
    for (const s of issue.suggestions) parts.push(`  - ${s}`);
  }

  parts.push('');
  parts.push('请只修正这个问题，输出修改后的完整正文。');

  return parts.join('\n');
}
