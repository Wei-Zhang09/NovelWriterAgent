/**
 * 「当前正文是哪一份」—— **唯一定义**（ADR-0008 决策 1 的读取侧补充）
 *
 * ## 为什么这个文件必须存在（缺陷 A 的根因）
 *
 * 施工文档与 ADR-0008 都写明：
 *
 *   > 预览、真实提交、审阅、连续性检查、状态结算**必须针对同一份文本**，
 *   > 否则「审阅通过」这句话描述的是另一份稿子。
 *
 * 但 M1 只把这套优先级链实现在**提交侧**（`@nwa/harness` 的
 * `pickCommitSource`），**读取侧从未跟进**：`manuscript.open` 硬读
 * `manuscript.md`。而工作流从不写 `manuscript.md`（它写 `draft.md` /
 * `revision.md`）——
 *
 *   于是 AI 写了 10KB 正文，作者打开编辑器看到的是**空白**；
 *   点保存又会用空正文覆盖掉那一份，
 *   而提交侧仍按优先级链取「当前正文」→ 正文静默丢失。
 *
 * 实测（整链联调）：`draft.md` = 7,986 字节，`manuscript.md` 不存在，
 * 提交后 `chapters/001.md` = 68 字节且状态为 COMMITTED。
 *
 * ## 本文件与 `pickCommitSource` 的关系
 *
 * 两者**必须**由同一个常量驱动，否则「作者看到的」与「提交的」会再次分叉 ——
 * 那正是本缺陷的形状。因此 `@nwa/harness` 的 `COMMIT_SOURCE_ORDER` /
 * `COMMIT_SOURCE_FILE` 现在**从这里 re-export**，不再各写一份。
 *
 * ## 语义边界（不可混用）
 *
 *   manuscript = 用户当前正文（**人的产出**）
 *   revision   = Agent 的修订建议（AI 修订）
 *   draft      = Writer 的原始产出（AI 初稿）
 *
 * ⚠ 优先级链是「当前正文」的**唯一权威定义**，但它**不代表三者同质**：
 *   `manuscript.md` 只允许由 `manuscript.save`（人的动作）写入。
 *   AI 的产出（draft / revision）**永不自动覆盖**它 —— 施工单 §15 /
 *   ADR-0008 §7。读取侧的改动**不得**削弱这一点（见
 *   `tests/integration/manuscript-read-chain.test.ts` 的证伪测试）。
 */

/** 当前正文的候选键，按优先级从高到低 */
export const MANUSCRIPT_SOURCE_ORDER = ['manuscript', 'revision', 'draft'] as const;

export type ManuscriptSourceKey = (typeof MANUSCRIPT_SOURCE_ORDER)[number];

/** 候选键 → 工作区文件名 */
export const MANUSCRIPT_SOURCE_FILE: Readonly<Record<ManuscriptSourceKey, string>> = {
  manuscript: 'manuscript.md',
  revision: 'revision.md',
  draft: 'draft.md',
};

/**
 * 该来源是否为**人的产出**。
 *
 * ⚠ 这个区分不是装饰：它决定 `getSaveStatus` 的 `dirty` 基线用哪份文本。
 *   作者看到的是 draft（AI 稿）时，编辑器内容与 draft 相同就该是「未改动」，
 *   而不是与一份**还不存在**的 `manuscript.md` 比较后恒为「有未保存改动」——
 *   后者会让作者一打开章节就被提示「未保存」，而他没有改任何东西。
 */
export const MANUSCRIPT_SOURCE_IS_HUMAN: Readonly<Record<ManuscriptSourceKey, boolean>> = {
  manuscript: true,
  revision: false,
  draft: false,
};

export interface ResolvedManuscriptText {
  /** 当前正文；三份都不存在时为 null */
  readonly text: string | null;
  /** 实际命中的来源键；`text === null` 时无意义（调用方必须忽略） */
  readonly source: ManuscriptSourceKey;
  /**
   * 是否已存在**人工正文**（`manuscript.md`）。
   *
   * ⚠ 与 `source` 不是同一件事：`source` 是"当前显示的是哪一份"，
   *   本字段是"作者有没有确认过正文"。UI 必须据此如实告知
   *   「当前显示的是 AI 稿」——否则又变成 §十一 禁止的
   *   「我以为打开的是定稿」。
   */
  readonly hasHumanManuscript: boolean;
}

/**
 * 按优先级链解析「当前正文」。
 *
 * ⚠ 抽成单一实现而不是各处各写一遍：提交侧与读取侧必须由**同一个函数**
 *   决定"当前正文是哪份"。分头实现是本缺陷的成因。
 *
 * @param readFile 读取工作区文件；不存在返回 null（不抛错）
 */
export function resolveManuscriptText(
  readFile: (key: ManuscriptSourceKey) => string | null,
): ResolvedManuscriptText {
  const hasHumanManuscript = readFile('manuscript') !== null;
  for (const key of MANUSCRIPT_SOURCE_ORDER) {
    const text = readFile(key);
    if (text !== null) {
      return { text, source: key, hasHumanManuscript };
    }
  }
  // 三份都不存在：text=null 由调用方决定怎么呈现（编辑器显示空 + 如实说明）。
  // source 回落到 draft 只是为了类型完整，此时它没有语义。
  return { text: null, source: 'draft', hasHumanManuscript };
}
