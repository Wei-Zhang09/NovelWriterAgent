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
  /**
   * 一次最多处理多少个问题（默认 3）。
   *
   * ⚠ 从 6 降到 3：实测 6 个问题时模型输出（每个问题都要逐字引用原文）
   *   会超出 maxTokens 被截断 —— 第 2 章改稿就是这样整轮失败的。
   *   宁可多跑一轮，也不要截断。未解决的阻塞问题会有第二轮定向重试。
   */
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
  /**
   * 单条**删除**允许的最大占比（默认 0.30）。
   *
   * ⚠ 比 maxReplaceRatio 严：删除是不可逆的信息损失
   *   （实测一次删除 59% 正文把稿子毁掉）。
   *   但过严会拒绝正常改法（模型常用"删掉矛盾段落"）。
   */
  readonly maxDeleteRatio?: number;
  /** 全章删除**累计**上限（默认 0.35）—— 防多条小删除拼起来掏空整章 */
  readonly maxTotalDeleteRatio?: number;
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
  /**
   * ⚠ 需要**重新生成正文**（改稿修不了）。
   *
   * 触发条件：仍有阻塞问题未解决，且失败原因是"要删掉的比例超过安全上限"。
   *
   * 实测场景：第 2 章整章把同一段情节（上车/交残片/问来历）**近乎逐字演了两遍**，
   * 修它必须删掉约 50% 正文 —— 而删除上限正是为防"一次删掉半章"设的。
   *
   * 这不是改稿能修的问题：**删掉半章不是修订，是草稿本身坏了**。
   * 正确处置是重新生成该章正文，因此如实报出来，
   * 而不是静默卡在门禁前让人不知道该怎么办。
   */
  readonly needsRegeneration?: boolean;
  /** 需要重新生成的原因（人类可读） */
  readonly regenerationReason?: string;
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
  private readonly maxDeleteRatio: number;
  private readonly maxTotalDeleteRatio: number;

  constructor(opts: RevisionOptions) {
    this.structured = opts.structured;
    this.workspace = opts.workspace;
    this.logger = opts.logger;
    this.maxIssuesPerPass = opts.maxIssuesPerPass ?? 3;
    this.maxReplaceRatio = opts.maxReplaceRatio ?? 0.7;
    this.retryUnresolved = opts.retryUnresolved ?? true;
    this.maxShrinkRatio = opts.maxShrinkRatio ?? 0.2;
    this.maxDeleteRatio = opts.maxDeleteRatio ?? MAX_DELETE_RATIO;
    this.maxTotalDeleteRatio = opts.maxTotalDeleteRatio ?? MAX_TOTAL_DELETE_RATIO;
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

    // ⚠ 判断"改稿修不了、需重新生成正文"。
    //
    // 依据：仍有阻塞问题未解决，且失败原因是**要删掉的比例超过安全上限**。
    // 实测第 2 章：整章把同一段情节近乎逐字演了两遍，修它要删掉约 50% ——
    // 那已不是"修订"，而是草稿本身结构坏了。
    // 如实报出来，让人知道该重新生成该章，而不是对着"提交被拦"发愁。
    const blockedByDeleteCap =
      rolledBackGroups.some((g) => g.reason.includes('删除')) ||
      allRejected.some((r) => r.reason.includes('删除'));
    const stillUnresolved = targets.some((t) => !resolvedCounts.has(t.id));
    const needsRegeneration = stillUnresolved && blockedByDeleteCap && totalApplied === 0;

    const regenerationReason = needsRegeneration
      ? '本章草稿存在大段重复/结构性矛盾，修它需要删掉过大的篇幅 —— ' +
        '那已不是"改稿"而是"重写"。建议**重新生成本章正文**（重新写作比逐处修补更可靠）。'
      : undefined;

    if (needsRegeneration) {
      this.logger.warn('改稿无法解决（需重新生成正文）', {
        chapterNumber: input.chapterNumber,
        reason: regenerationReason,
      });
    }

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
      needsRegeneration: needsRegeneration || undefined,
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
      ...(needsRegeneration ? { needsRegeneration: true, regenerationReason } : {}),
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
    let deletedChars = 0;

    for (const edit of standalone) {
      const outcome = applyEdit(
        current,
        edit,
        this.maxReplaceRatio,
        this.maxDeleteRatio,
        deletedChars,
        this.maxTotalDeleteRatio,
        ctx.text.length,
      );
      if (outcome.ok) {
        current = outcome.text;
        deletedChars += outcome.deletedChars;
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

      let groupDeleted = 0;
      for (const edit of edits) {
        const outcome = applyEdit(
          trial,
          edit,
          this.maxReplaceRatio,
          this.maxDeleteRatio,
          deletedChars + groupDeleted,
          this.maxTotalDeleteRatio,
          ctx.text.length,
        );
        if (!outcome.ok) {
          failed = { reason: outcome.reason, find: edit.find.slice(0, 60) };
          break;
        }
        trial = outcome.text;
        groupDeleted += outcome.deletedChars;
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
      deletedChars += groupDeleted;
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
 * 判断文字是否以句末标点收尾（即"是一个完整的句子/段落"）。
 */
function endsAtSentenceBoundary(s: string): boolean {
  const t = s.trimEnd();
  if (t.length === 0) return true; // 空 = 删除，合法
  return /[。！？…”』」\.\"!?]$/.test(t);
}

/** 大跨度替换的下限：低于此长度才值得怀疑（小改动不设限，避免误杀） */
const META_CHECK_MIN_FIND = 25;

/** 截断检测的长度下限（短片段不判，避免误杀中文短句缩写） */
const TRUNCATION_CHECK_MIN_FIND = 60;

/**
 * 检测"描述性替换"：整段被替换成一小段**不像正文**的文字。
 *
 * ⚠ 触发这个检查的真实故障：模型把**修改意图**当成替换文本写进了正文。
 *   实测：用 4 个字的「彻底消失」替换了 557 字的段落，
 *   于是手稿里凭空出现一句「彻底消失」—— 而所有机械检查都放行了
 *   （557/5366 = 10%，远低于 70% 上限）。
 *
 * ⚠ 必须**比较两端的收尾方式**，不能只看 replace 是否以标点结尾。
 *   替换常常是"片段级"的：find 停在句子中间，replace 也可以停在句子中间
 *   （后面接的是未改动的原文）。只看 replace 会把这些合法替换误杀
 *   —— 实测踩到：'船到了中流。……林砚在船篷下坐下来' 被判为描述性文字。
 *
 * 判据：**find 在句末收尾、replace 却在句中收尾、且短得多** → 可疑。
 *   那意味着"一整段被换成半句话"，更像是在描述"这段该没了"。
 */
function looksLikeMetaText(find: string, replace: string): boolean {
  if (replace.length === 0) return false; // 删除，合法
  if (find.length < META_CHECK_MIN_FIND) return false; // 小改动不设限
  // find 本身没在句末收尾 → 是片段级替换，replace 停在句中也正常
  if (!endsAtSentenceBoundary(find)) return false;
  // find 在句末收尾，replace 也在句末收尾 → 是完整的改写
  if (endsAtSentenceBoundary(replace)) return false;
  // find 整段收尾、replace 半句收尾，且明显更短 → 疑似描述性文字
  return replace.length < find.length * 0.5;
}

/**
 * 在正文中定位 `needle` 对应的**唯一**片段。
 *
 * ⚠ 为什么要容错匹配（实测数据驱动）：
 *
 * 模型无法逐字复现较长的中文段落。实测同一问题产出 3~5 条替换时，
 * **往往只有 1 条能精确匹配**，其余全部"找不到"—— 于是整组被放弃，
 * 该问题一处都没改成，章节永远提交不了：
 *
 *   第1章 issue-2：3 条中仅 1 条能应用 → 整组放弃
 *   第2章 I1：    5 条中仅 1 条能应用 → 整组放弃
 *
 * 但失败原因是**引文不精确**，不是"位置不存在"。因此做两级匹配：
 *   1. 精确匹配（快路径）
 *   2. 忽略空白后的匹配 —— 把模型引文与正文都去掉空白再比对，
 *      命中后回填**正文中的真实区间**（用模型给的 replace 覆盖它）
 *
 * 安全性不打折：仍然只替换正文里**真实存在**的片段，且要求**唯一**；
 * 多处命中一律拒绝（无法确定改哪一处）。
 */
function findUniqueSpan(text: string, needle: string): { start: number; end: number } | null {
  // ── 1) 精确匹配 ──
  const exact = text.indexOf(needle);
  if (exact >= 0) {
    if (text.indexOf(needle, exact + 1) >= 0) return null; // 多处 → 不明确，拒绝
    return { start: exact, end: exact + needle.length };
  }

  // ── 2) 忽略空白后匹配 ──
  const stripped = needle.replace(/\s+/g, '');
  if (stripped.length === 0) return null;

  // 建立"去空白文本 → 原文下标"的映射
  const map: number[] = [];
  let norm = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) continue;
    norm += ch;
    map.push(i);
  }

  const idx = norm.indexOf(stripped);
  if (idx < 0) return null;
  if (norm.indexOf(stripped, idx + 1) >= 0) return null; // 多处 → 拒绝

  const start = map[idx]!;
  const end = map[idx + stripped.length - 1]! + 1;
  return { start, end };
}

/**
 * 单条**删除**允许的最大占比（默认 0.30）。
 *
 * ⚠ 为什么删除要单独限额（实测踩到严重事故）：
 *
 * 第 1 章一次改稿删掉了 3226/5458 = **59%** 的正文，稿子直接毁掉
 * （5458 → 2210 字），而当时的上限是 70%，所以被放行了。
 *
 * 关键在于：**删除是不可逆的信息损失，替换不是**。
 * 替换（哪怕改动很大）至少保留了"改写后的内容"，
 * 而删除一旦删错，那些情节、对话、细节就永久没了 —— 复审只能看到
 * "少了一大段"，无法判断原本写了什么，人工也难恢复。
 *
 * ⚠ 但也不能设得过严：实测 15% 会把模型的**正常**改法全部拒绝。
 *   模型处理"这段描述与后文矛盾"时，常用手段就是**删掉整段**
 *   （实测 3 次/5 章因此被拒：删除占比 15%、16%、18%、29%）。
 *   因此改为**双限额**：
 *     - 单条 ≤ 30%：挡住"一条指令删掉大半章"
 *     - 全章累计 ≤ 35%：挡住"很多条小删除拼起来掏空整章"
 *   真正的事故形态（单条 59%）被单条限额挡住；
 *   正常改法（单条 15~29%）被放行。
 */
const MAX_DELETE_RATIO = 0.3;

/** 全章删除累计上限（默认 0.35）—— 防止多条小删除拼起来掏空整章 */
const MAX_TOTAL_DELETE_RATIO = 0.35;

/**
 * 判断 `find` 是否是"把重复内容合成一份"的形态（去重）。
 *
 * ⚠ 必须放行这种情况：find = X + X，replace = X。
 *   它天然表现为"replace 是 find 的前缀"，若一律当作截断残迹拒绝，
 *   删重复段落这个正当用途就废了（实测误杀）。
 */
function isDedupPattern(find: string, replace: string): boolean {
  if (replace.length === 0) return false;
  const body = replace.replace(/\s+$/, '');
  // X + 空白 + X（两到三份）
  const two = new RegExp(`^${escapeRe(body)}\\s*${escapeRe(body)}$`);
  if (two.test(find.replace(/\s+$/, ''))) return true;
  const three = new RegExp(`^${escapeRe(body)}\\s*${escapeRe(body)}\\s*${escapeRe(body)}$`);
  return three.test(find.replace(/\s+$/, ''));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 判断 `needle` 的内容在 `text` 中是否**重复出现**（即属于冗余内容）。
 *
 * ⚠ 用于给"大范围删除"放行：只有可机械验证为冗余的删除才允许，
 *   否则一次误判就会永久删掉独有情节。
 */
function isRedundant(text: string, needle: string): boolean {
  const stripped = needle.replace(/\s+/g, '');
  if (stripped.length < 10) return false;

  let norm = '';
  for (const ch of text) {
    if (!/\s/.test(ch)) norm += ch;
  }
  const first = norm.indexOf(stripped);
  if (first < 0) return false;
  // 去掉这一处后，别处还有同样的内容 → 冗余
  const rest = norm.slice(0, first) + norm.slice(first + stripped.length);
  return rest.includes(stripped);
}

function applyEdit(
  text: string,
  edit: RevisionEdit,
  maxRatio: number,
  maxDeleteRatio: number,
  /** 本次改稿中已累计删除的字符数（用于全章累计限额） */
  deletedSoFar: number,
  totalDeleteRatio: number,
  originalLength: number,
): { ok: true; text: string; deletedChars: number } | { ok: false; reason: string } {
  const ratio = edit.find.length / Math.max(1, text.length);

  // ⚠ 删除用更严的上限（不可逆的信息损失）
  if (edit.replace.length === 0) {
    // 全章累计限额：防止多条小删除拼起来掏空整章
    const afterDelete = deletedSoFar + edit.find.length;
    if (originalLength > 0 && afterDelete / originalLength > totalDeleteRatio) {
      return {
        ok: false,
        reason:
          `累计删除将达到 ${((afterDelete / originalLength) * 100).toFixed(0)}%，` +
          `超过全章累计上限 ${(totalDeleteRatio * 100).toFixed(0)}% —— ` +
          '逐条删除虽小，合起来会掏空整章',
      };
    }
    if (ratio > maxDeleteRatio) {
      // 大范围删除只在**内容确实在别处重复**时才放行 ——
      // 这是可机械验证的判据，不是凭模型的说明。
      // 删重复段落是合理需求；删掉独有内容则可能是误判，
      // 一旦删错那些情节就永久没了（复审只能看到"少了一段"）。
      if (!isRedundant(text, edit.find)) {
        return {
          ok: false,
          reason:
            `单条删除占全文 ${(ratio * 100).toFixed(0)}%，超过删除上限 ${(maxDeleteRatio * 100).toFixed(0)}%，` +
            '且被删内容在正文中**没有重复**（不是冗余内容）—— 删除不可逆，需人工确认',
        };
      }
    }
    const span = findUniqueSpan(text, edit.find);
    if (span !== null) {
      return {
        ok: true,
        text: text.slice(0, span.start) + text.slice(span.end),
        deletedChars: span.end - span.start,
      };
    }

    // ⚠ 命中多处时删除**仍然安全**，前提是内容在别处重复 ——
    //   此时删掉哪一份，结果都一样（内容仍在正文里）。
    //   这正是"删除重复段落"的典型场景：find 天然会出现多次，
    //   若一律拒绝，这个正当用途就废了（实测误杀）。
    if (isRedundant(text, edit.find)) {
      const idx = text.indexOf(edit.find);
      if (idx >= 0) {
        return {
          ok: true,
          text: text.slice(0, idx) + text.slice(idx + edit.find.length),
          deletedChars: edit.find.length,
        };
      }
    }

    return { ok: false, reason: '原文片段在正文中找不到或有多处（无法确定改哪一处）' };
  }

  if (ratio > maxRatio) {
    return {
      ok: false,
      reason: `替换片段占全文 ${(ratio * 100).toFixed(0)}%，超过上限 ${(maxRatio * 100).toFixed(0)}%`,
    };
  }

  // ⚠ 挡住"replace 是 find 的前缀"这类**截断残迹**（实测踩到）。
  //
  // 模型输出被 maxTokens 截断时，replace 会变成 find 的开头一段，
  // 应用后等于**静默删掉 find 的后半部分** —— 那是数据损失，
  // 而日志里看起来只是一次普通的"缩短"。
  //
  // 实测：find 443 字 → replace 231 字，replace 正是 find 的前缀。
  // ⚠ 只在**长片段**上判：截断只发生在长输出上，
  //   而中文里短句缩写（「门开了又合。」→「门开了」）很常见，会误杀。
  if (
    edit.find.length >= TRUNCATION_CHECK_MIN_FIND &&
    edit.replace.length > 0 &&
    edit.find.startsWith(edit.replace) &&
    edit.replace.length < edit.find.length * 0.8 &&
    !isDedupPattern(edit.find, edit.replace)
  ) {
    return {
      ok: false,
      reason:
        `替换文本是原文片段的**前缀**（${edit.replace.length}/${edit.find.length} 字）—— ` +
        '疑似输出被截断，应用后会静默删掉后半段。已拒绝',
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

  const span = findUniqueSpan(text, edit.find);
  if (span === null) {
    // 找不到，或有多处（无法确定改哪一处）—— 拒绝而不是猜
    return { ok: false, reason: '原文片段在正文中找不到或有多处（无法确定改哪一处）' };
  }

  return { ok: true, text: text.slice(0, span.start) + edit.replace + text.slice(span.end), deletedChars: 0 };
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
    '  ⚠ 但**不要用一条指令删掉大段正文**（单条删除不得超过全文 15%，会被拒绝）。',
    '    要删就拆成若干条小范围删除；删情节请先确认它确实是重复或多余的。',
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
    '⚠⚠ `find` 要尽可能**短**，只覆盖需要改动的字句，不要整段整段地替换。',
    '  系统限制单条替换不得超过全文 70%，整段替换会被直接拒绝。',
    '',
    '矛盾类问题的正确改法（示例）：',
    '  原文：「他取出铜扣，扣面是锻打的痕迹。」…「铜扣上压着波浪纹。」…「歪斜的锚形纹样朝上。」',
    '  ✅ 正确：只替换"有分歧的那几个字"，共 2 条 edit',
    '     { find: "扣面是锻打的痕迹，一锤一锤敲出来的", replace: "扣面压着波浪纹", issueId: "I-001", canonical: "波浪纹" }',
    '     { find: "歪斜的锚形纹样朝上", replace: "波浪纹朝上", issueId: "I-001", canonical: "波浪纹" }',
    '  ❌ 错误：把包含这三句的**整段**作为 find 去替换 —— 会被拒绝，且改完你也不确定统一成了什么。',
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
