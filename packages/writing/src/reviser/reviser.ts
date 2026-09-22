/**
 * Revision（改稿）—— 施工文档 §7.4 / §33
 *
 * ## 为什么需要它
 *
 * 真实运行中 Reviewer 准确报出问题（同一场景写了两遍、日期前后不一），
 * 门禁正确拦截，但**没有改稿环节** —— 稿子停在那里只能人工改。
 *
 * ## ⚠ 关键教训：让模型输出全文会毁稿（实测踩到）
 *
 * 第一版实现让模型"输出修改后的完整正文"，逐 issue 各改一遍。
 * 真实 2 章运行结果：
 *
 *   第 1 章：审稿 10 问题、**阻塞 0**（可提交）
 *          → 改稿（+875 字）
 *          → 复审 **阻塞 1**（不可提交）← 改稿引入了新问题
 *
 * 草稿 19912 字节 → 修订 22535 字节（+13%）。模型并没有"只改被指出的
 * 地方"，而是顺手扩写了别处，那些改动引入了新的时间线矛盾 ——
 * 而审稿只看新稿，**发现不了"这是改稿引入的"**。
 *
 * 根因是设计问题：只要让模型输出全文，就无法约束它只动指定处。
 * prompt 里写"只修改被指出的部分"是**没有机制保证**的。
 *
 * ## 因此改为「定向替换」模式
 *
 * 模型不再输出全文，而是输出**若干条替换指令**：
 *   { find: "<原文片段>", replace: "<改后片段>", reason: "..." }
 *
 * 由本模块**程序化应用**这些替换：
 *   - 只替换能精确匹配到的片段，其余文字**逐字节不变**
 *   - 匹配不到 → 该条拒绝并记录（模型记错了原文）
 *   - 单条替换超过全文 50% → 拒绝（那是重写，不是定向修改）
 *
 * 这样"改稿毁稿"在机制上不可能发生：模型无法触碰它没明确引用的文字。
 *
 * ## 另两条纪律
 *
 * - **写 revision.md，绝不覆盖 draft.md** —— 改坏要能退回去（§9 的布局）
 * - **改完不自动通过，必须重新审稿** —— 由门禁决定能否提交
 */
import { ErrorCode, Logger } from '@nwa/core';
import { z } from 'zod';
import type { ReviewIssue } from '@nwa/shared';
import type { ChapterWorkspace } from '@nwa/story';

/** 结构化调用（与 gateway 解耦） */
export type RevisionStructuredCaller = <T>(req: {
  readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  readonly schemaName: string;
  readonly messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}) => Promise<
  | { ok: true; data: T; attempts: number }
  | { ok: false; error: { code: string; message: string }; attempts: number; rawText?: string }
>;

/** 单条替换指令 */
export const RevisionEditSchema = z.object({
  /** 要替换的原文片段（必须与正文逐字一致，含标点） */
  find: z.string().min(2),
  /** 替换成什么（空字符串表示删除） */
  replace: z.string(),
  /** 为什么这样改（供人工复核） */
  reason: z.string().default(''),
});

export const RevisionOutputSchema = z.object({
  edits: z.array(RevisionEditSchema),
});

export type RevisionEdit = z.infer<typeof RevisionEditSchema>;

export interface RevisionOptions {
  readonly structured: RevisionStructuredCaller;
  readonly workspace: ChapterWorkspace;
  readonly logger: Logger;
  /** 一次最多处理多少个问题（默认 6）。过多会让模型失去焦点 */
  readonly maxIssuesPerPass?: number;
  /**
   * 单条替换允许的最大长度占比（默认 0.7）。
   *
   * ⚠ 防止模型用一条"替换"吞掉大半章 —— 那不是定向修改，是重写。
   *   但也不能太严：**删除重复段落**是改稿的典型场景，而重复内容
   *   本来就可能占很大比例（实测：一处重复占全文 60%）。
   *   0.7 允许"删掉一大段重复"，同时仍挡住"整章重写"。
   */
  readonly maxReplaceRatio?: number;
}

export interface EditOutcome {
  readonly issueId: string;
  readonly severity: string;
  readonly category: string;
  readonly applied: boolean;
  readonly reason: string;
  readonly skippedReason?: string;
}

export interface RevisionResult {
  readonly ok: boolean;
  /** 修订后的全文（已写入 revision.md） */
  readonly text?: string;
  readonly revisionPath?: string;
  readonly outcomes: readonly EditOutcome[];
  readonly totalChars?: number;
  /** 相对原稿的变化量（字符数差） */
  readonly deltaChars?: number;
  /** 实际应用的替换条数 */
  readonly appliedEdits: number;
  /** 被拒绝的替换数（模型记错原文、或想重写） */
  readonly rejectedEdits: number;
  readonly error?: { code: string; message: string; details?: unknown };
}

export class Reviser {
  private readonly structured: RevisionStructuredCaller;
  private readonly workspace: ChapterWorkspace;
  private readonly logger: Logger;
  private readonly maxIssuesPerPass: number;
  private readonly maxReplaceRatio: number;

  constructor(opts: RevisionOptions) {
    this.structured = opts.structured;
    this.workspace = opts.workspace;
    this.logger = opts.logger;
    this.maxIssuesPerPass = opts.maxIssuesPerPass ?? 6;
    this.maxReplaceRatio = opts.maxReplaceRatio ?? 0.7;
  }

  /**
   * 按审稿问题定向改稿（替换式）。
   *
   * ⚠ 只处理 BLOCKING / MAJOR；只应用能精确匹配的替换。
   */
  async revise(input: {
    readonly chapterNumber: number;
    readonly draftText: string;
    readonly issues: readonly ReviewIssue[];
  }): Promise<RevisionResult> {
    // ⚠ 只改 BLOCKING / MAJOR。
    //   MINOR / NOTE 大多是风格偏好，为它们动稿子不划算 ——
    //   改稿的风险（引入新矛盾）往往大于收益。
    const targets = input.issues
      .filter((i) => i.severity === 'BLOCKING' || i.severity === 'MAJOR')
      .slice(0, this.maxIssuesPerPass);

    // 无需要改的问题：仍写一份 revision.md（= 原稿），保持流程统一
    if (targets.length === 0) {
      const p = this.workspace.writeText('revision', input.draftText);
      this.logger.info('无需要改稿的问题（无 BLOCKING/MAJOR）', {
        chapterNumber: input.chapterNumber,
        totalIssues: input.issues.length,
      });
      return {
        ok: true,
        text: input.draftText,
        revisionPath: p,
        outcomes: [],
        totalChars: input.draftText.length,
        deltaChars: 0,
        appliedEdits: 0,
        rejectedEdits: 0,
      };
    }

    this.logger.info('开始改稿（替换式）', {
      chapterNumber: input.chapterNumber,
      targets: targets.length,
      blocking: targets.filter((i) => i.severity === 'BLOCKING').length,
    });

    const res = await this.structured<{ edits: RevisionEdit[] }>({
      schema: RevisionOutputSchema,
      schemaName: 'RevisionOutput',
      messages: buildMessages(input.chapterNumber, input.draftText, targets),
      maxTokens: 4096,
      temperature: 0.2, // 改稿要保守
    });

    if (!res.ok) {
      this.logger.warn('改稿结构化输出失败', {
        chapterNumber: input.chapterNumber,
        error: res.error.message,
      });
      // 失败时写原稿，保证流程有统一入口（后续步骤不必判断"有没有 revision"）
      const p = this.workspace.writeText('revision', input.draftText);
      return {
        ok: false,
        text: input.draftText,
        revisionPath: p,
        outcomes: [],
        appliedEdits: 0,
        rejectedEdits: 0,
        error: {
          code: res.error.code,
          message: res.error.message,
          details: { rawTextHead: (res.rawText ?? '').slice(0, 500) },
        },
      };
    }

    // ── 程序化应用替换（这是"不毁稿"的机制保证）──────────
    let current = input.draftText;
    let appliedEdits = 0;
    const rejected: { find: string; reason: string }[] = [];

    for (const edit of res.data.edits) {
      const ratio = edit.find.length / Math.max(1, current.length);
      if (ratio > this.maxReplaceRatio) {
        // 一条替换想吞掉大半章 → 那是重写，不是定向修改
        rejected.push({
          find: edit.find.slice(0, 60),
          reason: `替换片段占全文 ${(ratio * 100).toFixed(0)}%，超过上限 ${(this.maxReplaceRatio * 100).toFixed(0)}%`,
        });
        continue;
      }

      const idx = current.indexOf(edit.find);
      if (idx < 0) {
        // 模型记错了原文 —— 拒绝而不是模糊匹配（模糊匹配会改错地方）
        rejected.push({ find: edit.find.slice(0, 60), reason: '原文片段在正文中找不到' });
        continue;
      }

      // 只替换第一处：多处相同内容时保守处理，避免误改
      current = current.slice(0, idx) + edit.replace + current.slice(idx + edit.find.length);
      appliedEdits++;
    }

    if (rejected.length > 0) {
      this.logger.warn('部分替换被拒绝', {
        chapterNumber: input.chapterNumber,
        rejected: rejected.length,
        reasons: rejected.slice(0, 3).map((r) => r.reason),
      });
    }

    const revisionPath = this.workspace.writeText('revision', current);

    // 记录改稿日志（含被拒绝的替换 —— 人工复核时需要看到"模型想改但没改成"）
    this.workspace.writeJson('review', {
      kind: 'revision-log',
      chapterNumber: input.chapterNumber,
      mode: 'targeted-replace',
      appliedEdits,
      rejected,
      originalChars: input.draftText.length,
      revisedChars: current.length,
      deltaChars: current.length - input.draftText.length,
    });

    this.logger.info('改稿完成', {
      chapterNumber: input.chapterNumber,
      appliedEdits,
      rejected: rejected.length,
      deltaChars: current.length - input.draftText.length,
    });

    // 结果按 issue 标注：有替换被应用即认为该轮改稿生效
    const outcomes: EditOutcome[] = targets.map((t) => ({
      issueId: t.id,
      severity: t.severity,
      category: t.category,
      applied: appliedEdits > 0,
      reason: '',
      ...(appliedEdits === 0 ? { skippedReason: '没有可应用的替换（模型未产出有效指令）' } : {}),
    }));

    return {
      ok: true,
      text: current,
      revisionPath,
      outcomes,
      totalChars: current.length,
      deltaChars: current.length - input.draftText.length,
      appliedEdits,
      rejectedEdits: rejected.length,
    };
  }
}

// ── Prompt（§31：模块化） ───────────────────────────────────

/**
 * 改稿系统提示（替换式）。
 *
 * ⚠ 关键：不再要求输出全文。要求输出替换指令后，
 *   "改稿毁稿"在机制上不可能发生 —— 模型只能触碰它明确引用的片段。
 */
function buildSystemPrompt(): string {
  return [
    '你是小说改稿者。你的任务是给出**最小必要的替换指令**，而不是重写。',
    '',
    '输出格式：一个 JSON 对象，包含 edits 数组。每条 edit 为：',
    '  { "find": "要被替换的原文片段", "replace": "替换成什么", "reason": "为什么" }',
    '',
    '硬性要求：',
    '- `find` 必须与正文**逐字一致**（含标点、空格、换行）。系统做精确匹配，',
    '  匹配不到则该条被丢弃。所以宁可短一点、准一点，不要凭记忆写。',
    '- `replace` 为空字符串表示删除该片段。',
    '- 只针对被指出的问题做最小修改。不要顺手润色其他地方。',
    '- 不要改动人物姓名、地名、物品名、已确立的时间与事实。',
    '- 不要添加新情节、新人物、新设定。',
    '- 若判断某个问题无需修改（审稿误报），就不为它产出 edit。',
    '',
    '不要输出整章正文，只输出 edits 数组。',
  ].join('\n');
}

function buildMessages(
  chapterNumber: number,
  text: string,
  issues: readonly ReviewIssue[],
): { role: 'system' | 'user'; content: string }[] {
  const parts = [`【第 ${chapterNumber} 章 待改正文】`, text, '', '【需要修正的问题】'];

  for (const [i, issue] of issues.entries()) {
    parts.push(`--- 问题 ${i + 1} ---`);
    parts.push(`类别：${issue.category}｜严重度：${issue.severity}`);
    parts.push(`问题：${issue.claim}`);
    if (issue.evidence.length > 0) {
      parts.push('依据：');
      for (const e of issue.evidence) parts.push(`  - ${e}`);
    }
    if (issue.suggestions.length > 0) {
      parts.push('建议方向：');
      for (const s of issue.suggestions) parts.push(`  - ${s}`);
    }
  }

  parts.push('');
  parts.push('请为这些问题给出最小必要的替换指令（edits 数组）。');
  parts.push('注意：find 必须与上面的正文逐字一致。');

  return [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: parts.join('\n') },
  ];
}

export { ErrorCode };
