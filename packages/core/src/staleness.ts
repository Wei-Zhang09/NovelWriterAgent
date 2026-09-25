/**
 * Stale 判定（第二阶段施工单 §19–§22）【单一实现】
 *
 * ## 这个模块要解决的问题
 *
 * 施工单要求：Review / Continuity / State 三个产物各自记住"我是对哪一版正文
 * 得出的结论"。正文一旦被改动，这三份结论就**不能再用来提交**：
 *
 *     Manuscript ── hash A ──┬── Review(hash A)
 *                            ├── Continuity(hash A)
 *                            └── State(hash A)
 *
 *     用户编辑 → Manuscript ── hash B
 *
 *     Review(hash A)      → STALE
 *     Continuity(hash A)  → STALE
 *     State(hash A)       → STALE
 *
 * 不判 stale 的后果很具体：作者改了 3 段，然后点提交 —— 系统拿**改动前**
 * 的审阅结论放行，于是"审阅通过"这句话描述的是另一份稿子。
 * 这比没有审阅更危险，因为它给了虚假的保证。
 *
 * ## ⚠ 为什么必须是纯函数（而不是直接读库/读文件）
 *
 * 判定表可以穷举。放在 core 层、不读库不读文件，就能把四种情形
 * （FRESH / STALE / MISSING / NO_ANCHOR）各写一条单测钉死，
 * 而不是靠"跑一遍真实流程看看对不对"。
 *
 * ## ⚠ 与 `workflow_artifacts.content_hash` 的关系（一处必须澄清的误解）
 *
 * 施工计划与 ADR-0008 §3 曾写"复用 `workflow_artifacts.content_hash`
 * 作为 stale 锚点"。**核对代码后确认这条不成立**：
 *
 *     workflow-engine.ts:223
 *       const actualHash = hashOfFile(a.path) ?? a.contentHash;
 *
 * 它算的是**报告文件自身**的哈希（review.json 的内容哈希），
 * 不是被检查正文（manuscript.md / draft.md）的哈希。用报告哈希去和
 * 正文哈希比对，**两者永远不相等 → 永远 STALE**。
 *
 * 所以锚点是**新加的字段**，语义明确：`sourceHash` = 这份结论所依据的
 * 正文内容的 sha256。`workflow_artifacts.content_hash` 保持原义不动。
 *
 * ## ⚠ NO_ANCHOR 为什么不与 STALE 合并
 *
 * 引入锚点之前落下的 `review.json` / `continuity.json` 没有 hash 字段。
 * 升级后这些老数据若一律判 STALE，用户会看到"历史章节全部不能提交"；
 * 若一律判 FRESH，那是**没检查却说通过**。两者都是错的。
 *
 * 所以分开：`NO_ANCHOR` 表示"无法确认是否对应当前版本"。
 * 提交判定（`assertFresh`）对它按**宁严不宽**处理 —— 拒绝，但错误消息
 * 与 STALE 不同：STALE 说"正文改了，请重跑"，NO_ANCHOR 说
 * "这份结果没有版本锚点，无法确认对应哪一版，请重跑一次"。
 */
import { createHash } from 'node:crypto';
import { AppError, ErrorCode } from './errors.js';

/**
 * 参与 stale 追踪的产物种类。
 *
 * ⚠ 用下划线的 `proposed_state`，与 `workflow_artifacts.artifact_type`
 *   以及工作区文件名 `proposed_state.json` 一致 —— 不引入第二种拼法。
 */
export const STALE_TRACKED_ARTIFACTS = ['review', 'continuity', 'proposed_state'] as const;

export type StaleTrackedArtifact = (typeof STALE_TRACKED_ARTIFACTS)[number];

/** 产物的人话名称（错误消息与 UI 都用它，避免各处各写一份中文） */
export const ARTIFACT_LABELS: Readonly<Record<StaleTrackedArtifact, string>> = {
  review: '审阅结果',
  continuity: '连续性检查',
  proposed_state: '状态提议',
};

/**
 * 判定结果。
 *
 * FRESH     —— 锚点与当前正文一致，结论可用于提交
 * STALE     —— 有锚点但对不上：正文在结论之后被改过
 * MISSING   —— 当前正文不存在（连正文都没有，谈不上结论新旧）
 * NO_ANCHOR —— 结论存在但没记锚点（引入本机制之前的老数据）
 */
export const STALENESS_STATUSES = ['FRESH', 'STALE', 'MISSING', 'NO_ANCHOR'] as const;

export type StalenessStatus = (typeof STALENESS_STATUSES)[number];

/**
 * 文本内容哈希。
 *
 * ⚠ 必须与 `@nwa/harness` 的 `sha256()` / `hashOfFile()` **同算法同编码**
 *   （sha256 / utf8 / hex）。两处算法不同会让"锚点与当前正文"的比较
 *   永远不相等 —— 那种 bug 的表现是"刚跑完检查就判 STALE"，
 *   看起来像时序问题，实际是算法不一致。
 *   跨包一致性由 `tests/integration/staleness.test.ts` 断言。
 */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface StalenessInput {
  readonly artifact: StaleTrackedArtifact;
  /** 结论记录的锚点（结论所依据的正文哈希）；老数据为 null */
  readonly anchoredHash: string | null;
  /** 当前正文的哈希；正文不存在为 null */
  readonly currentHash: string | null;
}

export interface StalenessVerdict {
  readonly artifact: StaleTrackedArtifact;
  readonly label: string;
  readonly status: StalenessStatus;
  readonly anchoredHash: string | null;
  readonly currentHash: string | null;
  /** 人话说明（UI 直接展示，不拼接） */
  readonly message: string;
  /** 唯一可用于提交的条件：FRESH */
  readonly usableForCommit: boolean;
}

/**
 * 判定单个产物是否 stale。
 *
 * ⚠ 判定顺序不可调换：
 *   1. 先看当前正文在不在（正文都没有 → MISSING，与"结论过期"是两回事）
 *   2. 再看锚点在不在（没有锚点 → NO_ANCHOR，不能谎报 FRESH）
 *   3. 最后比哈希
 *
 *   若把第 3 步提前，"锚点为空 vs 正文哈希非空"会被判成 STALE ——
 *   而 STALE 的消息是"正文改过了，请重跑"，与真实原因
 *   （"这份结论根本没记版本"）不符，排查会被引向错误方向。
 */
export function stalenessOf(input: StalenessInput): StalenessVerdict {
  const label = ARTIFACT_LABELS[input.artifact];
  const base = {
    artifact: input.artifact,
    label,
    anchoredHash: input.anchoredHash,
    currentHash: input.currentHash,
  };

  if (input.currentHash === null) {
    return {
      ...base,
      status: 'MISSING',
      message: `正文还不存在，无法判断${label}对应哪一版`,
      usableForCommit: false,
    };
  }

  if (input.anchoredHash === null) {
    return {
      ...base,
      status: 'NO_ANCHOR',
      message: `${label}没有记录版本锚点，无法确认它对应的是哪一版正文（请重跑一次）`,
      usableForCommit: false,
    };
  }

  if (input.anchoredHash !== input.currentHash) {
    return {
      ...base,
      status: 'STALE',
      message: `${label}已过期：正文在它之后被改动过（请重跑）`,
      usableForCommit: false,
    };
  }

  return {
    ...base,
    status: 'FRESH',
    message: `${label}对应当前正文`,
    usableForCommit: true,
  };
}

/**
 * 断言产物可用于提交；否则抛 `ARTIFACT_STALE`。
 *
 * ⚠ 这是**唯一**的 stale 门禁入口。三处产物各写一遍比对逻辑必然漂移，
 *   而漂移了很难发现（三处里改对两处，看起来功能正常）。
 *
 * ⚠ NO_ANCHOR 与 MISSING 也拒绝提交（宁严不宽），但错误消息如实区分 ——
 *   §20 的原话是"不能拿旧结果继续 Commit"，而"没有锚点的旧结果"
 *   同样属于"旧结果"。
 */
export function assertFresh(input: StalenessInput): StalenessVerdict {
  const verdict = stalenessOf(input);
  if (!verdict.usableForCommit) {
    throw new AppError(ErrorCode.ARTIFACT_STALE, verdict.message, {
      details: {
        artifact: verdict.artifact,
        status: verdict.status,
        anchoredHash: verdict.anchoredHash,
        currentHash: verdict.currentHash,
      },
    });
  }
  return verdict;
}

export interface StalenessReport {
  readonly all: readonly StalenessVerdict[];
  /** 不可用于提交的项（UI 的"重新检查"清单直接用它） */
  readonly notFresh: readonly StalenessVerdict[];
  /** 全部 FRESH 才为 true */
  readonly ok: boolean;
}

/**
 * 汇总一批产物的 stale 状态（§31 提交前检查面板的数据源）。
 *
 * ⚠ 返回**全部**判定而不是只返回失败项：§31 要求逐条显示
 *   "✓ Review 对应当前版本"，成功项也要在界面上。
 *   只返回失败项的话，UI 得自己再算一遍成功项 —— 又是第二处实现。
 */
export function stalenessReport(
  inputs: readonly StalenessInput[],
): StalenessReport {
  const all = inputs.map(stalenessOf);
  const notFresh = all.filter((v) => !v.usableForCommit);
  return { all, notFresh, ok: notFresh.length === 0 };
}
