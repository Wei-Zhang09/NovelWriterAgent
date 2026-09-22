/**
 * Revision（改稿）—— 施工文档 §7.4 / §33
 *
 * ## 为什么需要它
 *
 * 真实运行中 Reviewer 准确报出问题（同一场景写了两遍、日期前后不一），
 * 门禁正确拦截，但**没有改稿环节** —— 稿子停在那里只能人工改。
 *
 * ## ⚠ 教训一：让模型输出全文会毁稿（实测踩到）
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
 *   - 单条替换超过全文 70% → 拒绝（那是重写，不是定向修改）
 *
 * 这样"改稿毁稿"在机制上不可能发生：模型无法触碰它没明确引用的文字。
 *
 * ## ⚠ 教训二：逐条独立替换修不了"前后矛盾"（实测踩到）
 *
 * 改稿后第 2 章仍有 3 个阻塞问题，都是**同一事物在多处描述不一致**：
 *   - 木匣藏匿位置：前文"候船棚长凳横档空心处"，后文"棚角松动的船板下方"
 *   - 铜扣纹样：一章内出现**三种**互不兼容的描述（锤打痕迹／波浪纹／歪斜的锚）
 *   - 潮汐倒计时："两天半涨潮"与"一天半退潮"不能同时成立
 *
 * 这类问题**不能靠逐条独立替换修**：修"三种纹样"必须**选定一种**，
 * 再把另外两处改成它。每条替换单独看都对，合起来却可能互相打架 ——
 * 模型自己也说不清"最终统一成了什么"。
 *
 * ## 因此引入「关联替换」（本模块的核心机制）
 *
 * 每条 edit 可挂 `issueId` 归属到某个问题；对于**矛盾类**问题，
 * 模型还必须声明 `canonical`（"这一处以哪个说法为准"）。
 *
 * 然后本模块做**机制校验**（不是 prompt 承诺）：
 *   1. `canonical` 必须能在该问题的某条 `find` 原文中找到
 *      —— 保证模型是"从原文里选"，不是凭空发明第三种说法
 *   2. 该问题**所有** edit 的 `replace` 文本里，若提到同一概念，
 *      必须与 `canonical` 一致 —— 防止"改了三处、三种新说法"
 *   3. 同一 issue 的多条替换**同时应用**：任一条匹配失败 →
 *      整组回退，避免"改了一处、漏了另一处"留下新的不一致
 *
 * 第 3 条是关键：**要么全改，要么不改**。半途而废的修改
 * 比不修改更糟 —— 它会留下更隐蔽的矛盾。
 *
 * ## 未解决问题会做第二轮（定向重试）
 *
 * 第一轮后仍未解决的阻塞问题，会带着**更窄的上下文**（该问题 + 相关段落）
 * 再试一轮。第二轮仍失败则如实报告，由门禁决定 —— 不假装成功。
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

/**
 * 单条替换指令。
 *
 * `issueId` / `canonical` 是"关联替换"的载体：
 *   - `issueId` 把替换归属到具体问题，便于"要么全改要么不改"的整组回退
 *   - `canonical` 声明"以哪种说法为准"，用于矛盾类问题的机制校验
 */
export const RevisionEditSchema = z.object({
  /** 要替换的原文片段（必须与正文逐字一致，含标点） */
  find: z.string().min(2),
  /** 替换成什么（空字符串表示删除） */
  replace: z.string(),
  /** 为什么这样改（供人工复核） */
  reason: z.string().default(''),
  /**
   * 归属的问题 id（对应输入 issues 的 id）。
   *
   * ⚠ 用于"同一问题的多条替换必须全部成功"的整组回退。
   *   缺省视为独立替换（不参与整组校验）。
   */
  issueId: z.string().default(''),
  /**
   * 统一后的说法（仅矛盾类问题需要）。
   *
   * ⚠ 必须是**从原文里选定**的一个说法，不能是凭空发明的第三种。
   *   本模块会校验它确实出现在该问题的某条 find 中。
   */
  canonical: z.string().default(''),
});

/**
 * ⚠ 容忍模型直接返回数组。
 *
 * 实测踩到：模型返回 `[{...}]` 而不是 `{ "edits": [...] }`，
 * 于是校验失败报 `(root): Required` —— 整轮改稿作废，稿子卡在门禁前。
 *
 * 小模型"少一层包装"是常见行为，而两种形状语义完全等价。
 * 与其让它白跑一轮，不如在前置处理里归一。
 */
export const RevisionOutputSchema = z.preprocess(
  (v) => (Array.isArray(v) ? { edits: v } : v),
  z.object({
    edits: z.array(RevisionEditSchema),
  }),
);

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
  /** 未解决问题是否做第二轮定向重试（默认 true） */
  readonly retryUnresolved?: boolean;
  /**
   * 允许的最大删减比例（默认 0.2）。
   *
   * ⚠ 定向改稿理应是小改动。删掉两成以上说明模型可能删错了地方
   *   （实测踩到 −23%，且复审问题数反而增加）。
   *   超限只**报警不阻止** —— 删除重复段落有时确实需要大幅删减，
   *   由重新审稿决定最终是否可提交。
   */
  readonly maxShrinkRatio?: number;
}

export interface EditOutcome {
  readonly issueId: string;
  readonly severity: string;
  readonly category: string;
  /** 该问题是否被实际改动 */
  readonly applied: boolean;
  /** 应用的替换条数（关联替换可能多条） */
  readonly editCount: number;
  /** 统一后的说法（矛盾类问题） */
  readonly canonical?: string;
  readonly skippedReason?: string;
}

/** 一轮改稿的统计 */
export interface PassStats {
  readonly pass: number;
  readonly appliedEdits: number;
  readonly rejectedEdits: number;
  /** 本轮尝试解决的问题数 */
  readonly attempted: number;
  /** 本轮真正改动了的问题数 */
  readonly resolved: number;
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
  /** 实际应用的替换条数（累计） */
  readonly appliedEdits: number;
  /** 被拒绝的替换数（累计） */
  readonly rejectedEdits: number;
  /** 各轮统计 */
  readonly passes: readonly PassStats[];
  /** 被整组回退的替换组（含原因，供人工复核） */
  readonly rolledBackGroups: readonly { issueId: string; reason: string }[];
  readonly error?: { code: string; message: string; details?: unknown };
}

interface RejectedEdit {
  readonly find: string;
  readonly reason: string;
  readonly issueId: string;
}

/**
 * 已应用替换的记录（诊断用）。
 *
 * ⚠ 只记被拒的替换是不够的：实测出现"模型把描述性文字写进正文"时，
 *   无法从日志复盘到底改了哪里 —— 只能靠 diff draft/revision 反推。
 */
interface AppliedEditLog {
  readonly pass: number;
  readonly issueId: string;
  readonly findHead: string;
  readonly replaceHead: string;
  readonly findLen: number;
  readonly replaceLen: number;
  readonly reason: string;
}

function logEdit(pass: number, e: RevisionEdit): AppliedEditLog {
  return {
    pass,
    issueId: e.issueId,
    findHead: e.find.slice(0, 120),
    replaceHead: e.replace.slice(0, 120),
    findLen: e.find.length,
    replaceLen: e.replace.length,
    reason: e.reason.slice(0, 200),
  };
}

export class Reviser {
  private readonly structured: RevisionStructuredCaller;
  private readonly workspace: ChapterWorkspace;
  private readonly logger: Logger;
  private readonly maxIssuesPerPass: number;
  private readonly maxReplaceRatio: number;
  private readonly retryUnresolved: boolean;
  private readonly maxShrinkRatio: number;

  constructor(opts: RevisionOptions) {
    this.structured = opts.structured;
    this.workspace = opts.workspace;
    this.logger = opts.logger;
    this.maxIssuesPerPass = opts.maxIssuesPerPass ?? 6;
    this.maxReplaceRatio = opts.maxReplaceRatio ?? 0.7;
    this.retryUnresolved = opts.retryUnresolved ?? true;
    this.maxShrinkRatio = opts.maxShrinkRatio ?? 0.2;
  }

  /**
   * 按审稿问题定向改稿（替换式 + 关联替换 + 未解决重试）。
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
        passes: [],
        rolledBackGroups: [],
      };
    }

    this.logger.info('开始改稿', {
      chapterNumber: input.chapterNumber,
      targets: targets.length,
      blocking: targets.filter((i) => i.severity === 'BLOCKING').length,
    });

    let current = input.draftText;
    const allRejected: RejectedEdit[] = [];
    const rolledBackGroups: { issueId: string; reason: string }[] = [];
    const passes: PassStats[] = [];
    /** issueId → 实际应用的替换条数（如实统计，不用 0/1 糊弄） */
    const resolvedCounts = new Map<string, number>();
    let totalApplied = 0;
    const canonicals = new Map<string, string>();
    /** 已应用的替换明细（诊断用 —— 只记被拒的无法复盘改了什么） */
    const allApplied: AppliedEditLog[] = [];

    // ── 第一轮：全部目标问题 ─────────────────────────────
    const pass1 = await this.runPass({
      pass: 1,
      chapterNumber: input.chapterNumber,
      text: current,
      issues: targets,
      issuesById: new Map(targets.map((t) => [t.id, t])),
    });
    current = pass1.text;
    totalApplied += pass1.appliedEdits;
    allRejected.push(...pass1.rejected);
    rolledBackGroups.push(...pass1.rolledBack);
    for (const [id, n] of pass1.resolvedCounts) resolvedCounts.set(id, n);
    for (const [k, v] of pass1.canonicals) canonicals.set(k, v);
    allApplied.push(...pass1.applied);
    passes.push(pass1.stats);

    // 第一轮结构化调用失败：写原稿并返回错误
    if (pass1.fatal) {
      const p = this.workspace.writeText('revision', current);
      return {
        ok: false,
        text: current,
        revisionPath: p,
        outcomes: [],
        appliedEdits: totalApplied,
        rejectedEdits: allRejected.length,
        passes,
        rolledBackGroups,
        error: pass1.fatal,
      };
    }

    // ── 第二轮：只针对未解决的阻塞问题（定向重试）─────────
    // ⚠ 只重试 BLOCKING —— MAJOR 再试一轮的收益低于风险。
    const unresolved = targets.filter(
      (t) => t.severity === 'BLOCKING' && !resolvedCounts.has(t.id),
    );

    if (this.retryUnresolved && unresolved.length > 0) {
      this.logger.info('第二轮定向重试（未解决的阻塞问题）', {
        chapterNumber: input.chapterNumber,
        unresolved: unresolved.length,
      });

      const pass2 = await this.runPass({
        pass: 2,
        chapterNumber: input.chapterNumber,
        text: current,
        issues: unresolved,
        issuesById: new Map(unresolved.map((t) => [t.id, t])),
      });
      current = pass2.text;
      totalApplied += pass2.appliedEdits;
      allRejected.push(...pass2.rejected);
      rolledBackGroups.push(...pass2.rolledBack);
      for (const [id, n] of pass2.resolvedCounts) resolvedCounts.set(id, n);
      for (const [k, v] of pass2.canonicals) canonicals.set(k, v);
      allApplied.push(...pass2.applied);
      passes.push(pass2.stats);
    }

    const revisionPath = this.workspace.writeText('revision', current);

    // ── 结果按问题标注（如实：没改成的就标没改成）─────────
    const outcomes: EditOutcome[] = targets.map((t) => {
      const applied = resolvedCounts.has(t.id);
      const canon = canonicals.get(t.id);
      const rollback = rolledBackGroups.find((g) => g.issueId === t.id);
      return {
        issueId: t.id,
        severity: t.severity,
        category: t.category,
        applied,
        editCount: resolvedCounts.get(t.id) ?? 0,
        ...(canon ? { canonical: canon } : {}),
        ...(applied
          ? {}
          : {
              skippedReason: rollback
                ? `整组回退：${rollback.reason}`
                : '未产出可应用的替换（模型未给出有效指令或原文匹配失败）',
            }),
      };
    });

    const deltaChars = current.length - input.draftText.length;
    const shrinkRatio = input.draftText.length > 0 ? -deltaChars / input.draftText.length : 0;

    // ⚠ 大幅删减要报警：定向改稿理应是小改动，删掉两成以上说明
    //   模型可能把"删除"用在了不该删的地方（实测踩到 −23%）
    if (shrinkRatio > this.maxShrinkRatio) {
      this.logger.warn('改稿删减比例偏大，请人工复核', {
        chapterNumber: input.chapterNumber,
        shrinkPercent: (shrinkRatio * 100).toFixed(0),
        originalChars: input.draftText.length,
        revisedChars: current.length,
      });
    }

    // 记录改稿日志（含被拒绝/被回退/已应用的替换 —— 人工复核要能完整复盘）
    this.workspace.writeJson('review', {
      kind: 'revision-log',
      chapterNumber: input.chapterNumber,
      mode: 'targeted-replace',
      appliedEdits: totalApplied,
      applied: allApplied,
      shrinkRatio: Number(shrinkRatio.toFixed(3)),
      rejected: allRejected,
      rolledBackGroups,
      passes,
      resolved: [...resolvedCounts.keys()],
      unresolved: targets.filter((t) => !resolvedCounts.has(t.id)).map((t) => t.id),
      originalChars: input.draftText.length,
      revisedChars: current.length,
      deltaChars,
    });

    this.logger.info('改稿完成', {
      chapterNumber: input.chapterNumber,
      appliedEdits: totalApplied,
      rejected: allRejected.length,
      rolledBack: rolledBackGroups.length,
      resolved: resolvedCounts.size,
      targets: targets.length,
      deltaChars: current.length - input.draftText.length,
    });

    return {
      ok: true,
      text: current,
      revisionPath,
      outcomes,
      totalChars: current.length,
      deltaChars: current.length - input.draftText.length,
      appliedEdits: totalApplied,
      rejectedEdits: allRejected.length,
      passes,
      rolledBackGroups,
    };
  }

  /**
   * 执行一轮改稿。
   *
   * 关键机制：**同一 issue 的多条替换要么全成功、要么全回退** ——
   * 半途而废的修改比不修改更糟（留下更隐蔽的矛盾）。
   */
  private async runPass(ctx: {
    pass: number;
    chapterNumber: number;
    text: string;
    issues: readonly ReviewIssue[];
    issuesById: Map<string, ReviewIssue>;
  }): Promise<{
    text: string;
    appliedEdits: number;
    rejected: RejectedEdit[];
    rolledBack: { issueId: string; reason: string }[];
    resolvedCounts: Map<string, number>;
    canonicals: Map<string, string>;
    applied: AppliedEditLog[];
    stats: PassStats;
    fatal?: { code: string; message: string; details?: unknown };
  }> {
    const res = await this.structured<{ edits: RevisionEdit[] }>({
      schema: RevisionOutputSchema,
      schemaName: 'RevisionOutput',
      messages: buildMessages(ctx.chapterNumber, ctx.text, ctx.issues, ctx.pass),
      maxTokens: 4096,
      temperature: 0.2, // 改稿要保守
    });

    const empty = {
      text: ctx.text,
      appliedEdits: 0,
      rejected: [] as RejectedEdit[],
      rolledBack: [] as { issueId: string; reason: string }[],
      resolvedCounts: new Map<string, number>(),
      canonicals: new Map<string, string>(),
      applied: [] as AppliedEditLog[],
      stats: { pass: ctx.pass, appliedEdits: 0, rejectedEdits: 0, attempted: ctx.issues.length, resolved: 0 },
    };

    if (!res.ok) {
      this.logger.warn('改稿结构化输出失败', {
        chapterNumber: ctx.chapterNumber,
        pass: ctx.pass,
        error: res.error.message,
      });
      // ⚠ 把模型原始输出落盘：否则只看到 "(root): Required" 无从诊断
      this.workspace.writeJson('review', {
        kind: 'revision-error',
        chapterNumber: ctx.chapterNumber,
        pass: ctx.pass,
        code: res.error.code,
        message: res.error.message,
        rawTextHead: (res.rawText ?? '').slice(0, 2000),
      });
      return {
        ...empty,
        fatal: {
          code: res.error.code,
          message: res.error.message,
          details: { pass: ctx.pass, rawTextHead: (res.rawText ?? '').slice(0, 800) },
        },
      };
    }

    // ── 1) 按 issueId 分组 ────────────────────────────────
    const groups = new Map<string, RevisionEdit[]>();
    const standalone: RevisionEdit[] = [];
    for (const edit of res.data.edits) {
      const key = edit.issueId || '';
      // 归属到不存在的问题 → 视为独立替换（不静默丢弃）
      if (key && ctx.issuesById.has(key)) {
        const arr = groups.get(key) ?? [];
        arr.push(edit);
        groups.set(key, arr);
      } else {
        standalone.push(edit);
      }
    }

    // ── 2) 机制校验：canonical 必须来自原文 ────────────────
    const rejected: RejectedEdit[] = [];
    const validGroups = new Map<string, RevisionEdit[]>();
    const canonicals = new Map<string, string>();

    for (const [issueId, edits] of groups) {
      const declared = edits.map((e) => e.canonical).find((c) => c.length > 0) ?? '';

      // ⚠ canonical 只在"同一问题有多处要改"时才有意义 ——
      //   它的作用是声明"以哪种说法为准"来消除分歧。
      //   单条替换没有分歧要消除，模型却仍会习惯性填 canonical，
      //   填的往往是**修改意图**（如"把设定信息拆散到动作与旁白"）而非事实。
      //   若对单条也做校验，合法替换会被全部误杀（实测：6 条被拒）。
      if (declared && edits.length > 1) {
        // canonical 必须是"从原文里选定"的说法，不能凭空发明第三种。
        //
        // 注意对照的是**本轮正文**，不是各条 find：
        // canonical 通常是"本来就写对的那一处"，模型不会为它产出 edit，
        // 因此它根本不会出现在任何 find 里。若拿 find 去校验，
        // 合法情形会被全部误杀（实测踩到）。
        if (!ctx.text.includes(declared)) {
          rejected.push({
            find: declared.slice(0, 60),
            reason: `canonical「${declared.slice(0, 30)}」在正文中不存在（不能凭空发明新的说法）`,
            issueId,
          });
          continue;
        }
        canonicals.set(issueId, declared);
      }

      validGroups.set(issueId, edits);
    }

    // ── 3) 独立替换：逐条应用（与整组无关）─────────────────
    let current = ctx.text;
    let appliedEdits = 0;
    const resolvedCounts = new Map<string, number>();
    const applied: AppliedEditLog[] = [];

    for (const edit of standalone) {
      const outcome = applyEdit(current, edit, this.maxReplaceRatio);
      if (outcome.ok) {
        current = outcome.text;
        appliedEdits++;
        applied.push(logEdit(ctx.pass, edit));
      } else {
        rejected.push({ find: edit.find.slice(0, 60), reason: outcome.reason, issueId: edit.issueId });
      }
    }

    // ── 4) 关联替换：要么全改、要么不改 ────────────────────
    const rolledBack: { issueId: string; reason: string }[] = [];

    for (const [issueId, edits] of validGroups) {
      // 先全部在**同一份快照**上试算，任一失败则整组放弃
      let trial = current;
      let failed: { reason: string; find: string } | null = null;
      let groupApplied = 0;

      for (const edit of edits) {
        const outcome = applyEdit(trial, edit, this.maxReplaceRatio);
        if (!outcome.ok) {
          failed = { reason: outcome.reason, find: edit.find.slice(0, 60) };
          break;
        }
        trial = outcome.text;
        groupApplied++;
      }

      if (failed || groupApplied === 0) {
        const reason = failed
          ? `${edits.length} 条中仅 ${groupApplied} 条能应用（第 ${groupApplied + 1} 条：${failed.reason}）—— 整组放弃以免只改一半`
          : '该问题没有产出替换指令';
        rolledBack.push({ issueId, reason });
        if (failed) {
          rejected.push({ find: failed.find, reason: `整组回退：${failed.reason}`, issueId });
        }
        continue;
      }

      // ⚠ 整组通过才落盘 —— 半途而废的修改会留下更隐蔽的矛盾
      current = trial;
      appliedEdits += groupApplied;
      resolvedCounts.set(issueId, groupApplied);
      for (const e of edits) applied.push(logEdit(ctx.pass, e));
    }

    // 独立替换若命中某个问题（模型给了 issueId 但该问题没进 groups 的情况已排除），
    // 这里额外把"独立替换里带有效 issueId"的也算作已解决
    for (const edit of standalone) {
      if (edit.issueId && ctx.issuesById.has(edit.issueId) && !resolvedCounts.has(edit.issueId)) {
        // 只有确实应用成功才算（rejected 里没有它）
        const wasRejected = rejected.some((r) => r.find === edit.find.slice(0, 60));
        if (!wasRejected) resolvedCounts.set(edit.issueId, 1);
      }
    }

    return {
      text: current,
      appliedEdits,
      rejected,
      rolledBack,
      resolvedCounts,
      canonicals,
      applied,
      stats: {
        pass: ctx.pass,
        appliedEdits,
        rejectedEdits: rejected.length,
        attempted: ctx.issues.length,
        resolved: resolvedCounts.size,
      },
    };
  }
}

// ── 单条替换的应用（纯函数，便于测试）──────────────────────

/**
 * 判断一段文字是否"读起来像正文"。
 *
 * ⚠ 触发这个检查的真实故障：模型把**修改意图**当成替换文本写进了正文。
 *   实测：用 4 个字的「彻底消失」替换了 557 字的段落，
 *   于是手稿里凭空出现一句「彻底消失」—— 而所有机械检查都放行了
 *   （557/5366 = 10%，远低于 70% 上限）。
 *
 * 判据：成段正文必然以句末标点收尾。空字符串是合法的"删除"。
 */
function endsLikeProse(s: string): boolean {
  const t = s.trimEnd();
  if (t.length === 0) return true; // 空 = 删除，合法
  return /[。！？…”』」\.\"!?]$/.test(t);
}

/** 大跨度替换的下限：低于此长度才值得怀疑（小改动不设限，避免误杀） */
const META_CHECK_MIN_FIND = 25;

/**
 * 检测"描述性替换"：长片段被替换成一小段**不像正文**的文字。
 *
 * 典型表现：`find` 是一整段，`replace` 是「彻底消失」「才就」「他等周管事」
 * 这类短语 —— 模型在描述"应该怎么改"，而不是给出改后的文字。
 */
function looksLikeMetaText(find: string, replace: string): boolean {
  if (replace.length === 0) return false; // 删除，合法
  if (find.length < META_CHECK_MIN_FIND) return false; // 小改动不设限
  if (endsLikeProse(replace)) return false; // 像正文
  // 大跨度替换却给出一小段非正文文字 → 判定为描述性文字
  return replace.length < find.length * 0.5;
}

function applyEdit(
  text: string,
  edit: RevisionEdit,
  maxRatio: number,
): { ok: true; text: string } | { ok: false; reason: string } {
  const ratio = edit.find.length / Math.max(1, text.length);
  if (ratio > maxRatio) {
    return {
      ok: false,
      reason: `替换片段占全文 ${(ratio * 100).toFixed(0)}%，超过上限 ${(maxRatio * 100).toFixed(0)}%`,
    };
  }

  // ⚠ 挡住"描述性文字被写进正文"（实测：557 字段落被换成「彻底消失」）
  if (looksLikeMetaText(edit.find, edit.replace)) {
    return {
      ok: false,
      reason:
        `替换文本「${edit.replace.slice(0, 30)}」不像正文（大跨度替换却无句末标点）—— ` +
        '疑似描述性文字。若要删除该片段，请把 replace 设为空字符串',
    };
  }

  const idx = text.indexOf(edit.find);
  if (idx < 0) {
    // 模型记错了原文 —— 拒绝而不是模糊匹配（模糊匹配会改错地方）
    return { ok: false, reason: '原文片段在正文中找不到' };
  }

  // 只替换第一处：多处相同内容时保守处理，避免误改
  return { ok: true, text: text.slice(0, idx) + edit.replace + text.slice(idx + edit.find.length) };
}

// ── Prompt（§31：模块化） ───────────────────────────────────

/**
 * 改稿系统提示（替换式 + 关联替换）。
 *
 * ⚠ 关键：不要求输出全文。"改稿毁稿"在机制上不可能发生 ——
 *   模型只能触碰它明确引用的片段。
 */
function buildSystemPrompt(): string {
  return [
    '你是小说改稿者。你的任务是给出**最小必要的替换指令**，而不是重写。',
    '',
    '输出格式：一个 JSON 对象，包含 edits 数组。每条 edit 为：',
    '  { "find": "要被替换的原文片段", "replace": "替换成什么",',
    '    "reason": "为什么", "issueId": "问题编号", "canonical": "统一后的说法" }',
    '',
    '硬性要求：',
    '- `find` 必须与正文**逐字一致**（含标点、空格、换行）。系统做精确匹配，',
    '  匹配不到则该条被丢弃。所以宁可短一点、准一点，不要凭记忆写。',
    '- `replace` 为空字符串表示删除该片段。',
    '- `issueId` 填该替换针对的问题编号（用问题前面的 id，如 ri_3）。',
    '- 只针对被指出的问题做最小修改。不要顺手润色其他地方。',
    '- 不要改动人物姓名、地名、物品名、已确立的时间与事实。',
    '- 不要添加新情节、新人物、新设定。',
    '- 若判断某个问题无需修改（审稿误报），就不为它产出 edit。',
    '',
    '【同一事物多处描述不一致时（矛盾类问题）】',
    '- 必须为**每一处**不一致的描述各产出一条 edit（同一 issueId），',
    '  把其他说法改成选定的那一种。只改一处会留下新的不一致。',
    '- 必须用 `canonical` 声明"以哪种说法为准"。',
    '- ⚠ `canonical` 必须是**原文里已经出现的**某个说法，不能自己发明第三种。',
    '  系统会校验：若 canonical 不在原文中，整组替换作废。',
    '- 只有"同一问题需要改多处"时才填 `canonical`；只改一处时留空即可。',
    '',
    '不要输出整章正文，只输出 edits 数组。',
  ].join('\n');
}

function buildMessages(
  chapterNumber: number,
  text: string,
  issues: readonly ReviewIssue[],
  pass: number,
): { role: 'system' | 'user'; content: string }[] {
  const parts = [`【第 ${chapterNumber} 章 待改正文】`, text, '', '【需要修正的问题】'];

  for (const issue of issues) {
    parts.push(`--- 问题 id=${issue.id} ---`);
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
  if (pass > 1) {
    parts.push('⚠ 这是第二轮：上一轮没能解决这些问题。请重新仔细核对原文，');
    parts.push('给出能精确匹配的替换指令。同一事物多处不一致时，记得为每一处都给出 edit。');
  } else {
    parts.push('请为这些问题给出最小必要的替换指令（edits 数组）。');
    parts.push('注意：find 必须与上面的正文逐字一致，issueId 要填对应的问题 id。');
  }

  return [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: parts.join('\n') },
  ];
}

export { ErrorCode };
