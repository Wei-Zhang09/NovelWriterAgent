/**
 * 模式落库与跨作品对比（施工文档 §21）
 *
 * ## §21 的分层要求
 *
 * 同一叙事任务下，跨作品提取：
 * ```
 * Common Pattern     多部作品共有
 * Variant Pattern    同任务的不同做法
 * Genre-specific     仅某类型成立
 * Author-specific    特定作者风格
 * Weak / noisy       证据不足
 * ```
 * 最终分档：`Universal-ish` / `Genre-specific` /
 * `Subgenre-specific` / `Style-specific`。
 *
 * Writer 默认优先使用 **Genre-specific + 高置信通用策略**，
 * 而不是直接使用作者特有策略（§21 明文）。
 *
 * ## ⚠ 跨作品 vs 单作品：置信度不能同等对待
 *
 * **只有一部作品支持的模式，无法区分"叙事规律"与"这个作者的癖好"**。
 * 这是跨作品分析存在的全部理由。
 *
 * 因此落库时按来源作品数分档：
 *   1 部 → 证据不足，标 `scope=STYLE`（作者风格，需显式开启）
 *   2 部 → 可用，但置信度打折
 *   ≥3 部 → 才够格称"类型规律"
 *
 * 这个分档**不交给模型判断** —— 模型看不到全局的作品分布，
 * 它只能看到我们喂的那几个片段。作品数是代码算得出来的事实。
 */
import {
  Logger,
  computeScope,
  type ScopeDecision,
  type ScopeEvidence,
  type ScopeEvidenceInput,
} from '@nwa/core';
import type { CorpusRepository, CorpusSceneRow, SkillScope } from '@nwa/storage';
import { normalizeGenre } from '@nwa/storage';
import { PatternMiner, toPatternRow, type MinedPatternRecord, type MineResult } from './pattern-miner.js';

export interface PatternStoreOptions {
  readonly logger: Logger;
  readonly repo: CorpusRepository;
}

export interface CrossWorkAnalysis {
  /** 按 sceneFunction 分组，每组跨了几部作品 */
  readonly coverage: readonly {
    readonly sceneFunction: string;
    readonly documents: number;
    readonly scenes: number;
    /** ⚠ 只有 1 部作品时无法区分"规律"与"作者癖好" */
    readonly crossWork: boolean;
  }[];
  /** 可做跨作品对比的组数（≥2 部作品） */
  readonly comparableGroups: number;
  /** 只有单作品支持的组数（证据不足，只能算作者风格） */
  readonly singleWorkGroups: number;
}

/**
 * 跨作品覆盖分析。
 *
 * ⚠ 先做这一步再挖掘：**单作品组挖出来的模式必然带作者风格**，
 *   落库时该降档为 STYLE，不该冒充类型规律。
 */
export function analyzeCrossWork(scenes: readonly CorpusSceneRow[]): CrossWorkAnalysis {
  const byFn = new Map<string, { docs: Set<string>; n: number }>();
  for (const s of scenes) {
    const fn = s.scene_function;
    if (!fn) continue;
    if (!byFn.has(fn)) byFn.set(fn, { docs: new Set(), n: 0 });
    const g = byFn.get(fn)!;
    g.docs.add(s.document_id);
    g.n++;
  }

  const coverage = [...byFn.entries()]
    .map(([sceneFunction, g]) => ({
      sceneFunction,
      documents: g.docs.size,
      scenes: g.n,
      crossWork: g.docs.size >= 2,
    }))
    .sort((a, b) => b.documents - a.documents || b.scenes - a.scenes);

  return {
    coverage,
    comparableGroups: coverage.filter((c) => c.crossWork).length,
    singleWorkGroups: coverage.filter((c) => !c.crossWork).length,
  };
}

/**
 * ⚠ 按**证据**决定作用域 —— 不采信模型自报的 scope。
 *
 * ## 修的是什么（P0-6）
 *
 * 旧实现只数作品数，**完全没有类型维度**：
 *
 * ```
 * if (sourceDocumentCount === 2 && modelScope === 'UNIVERSAL') → GENRE
 * return { scope: modelScope, reason: '作品数与模型判断一致' }   // ← 缺陷在这里
 * ```
 *
 * 三部**同类型**作品（都市 A/B/C）就能走到最后一行，
 * 于是"作品数够"直接放行了模型自报的 UNIVERSAL ——
 * 正是总提示词 §八 点名的情形：都市小说 A/B/C 不代表 Universal。
 *
 * 而且模型的判断是**通过条件**而非输入：作品数够时它的自报原样生效。
 * 模型看不到全局作品分布（它只看到我们喂的片段），
 * 说 UNIVERSAL 时其实无从判断。
 *
 * ## 现在的规则（§八）
 *
 *   1 部作品              → STYLE
 *   ≥2 部、全部同类型      → GENRE
 *   ≥2 部、≥2 个不同类型   → 才可能 UNIVERSAL
 *
 * 且与模型自报取**更保守**者（只降不升），理由见 `computeScope` 的注释。
 *
 * ## 兼容签名
 *
 * 旧的 `(modelScope, count)` 调用仍然可用（第二参数为数字时走简化路径），
 * 但**不推荐** —— 它拿不到类型信息，无法区分"三部都市"与"三部不同类型"。
 * 新代码请传完整的 `ScopeEvidenceInput`。
 */
export function resolveScope(
  modelScope: SkillScope,
  sourceDocumentCount: number,
): { readonly scope: SkillScope; readonly reason: string };
export function resolveScope(input: ScopeEvidenceInput): ScopeDecision;
export function resolveScope(
  arg1: SkillScope | ScopeEvidenceInput,
  arg2?: number,
): { readonly scope: SkillScope; readonly reason: string } {
  if (typeof arg1 === 'string') {
    // 简化路径：没有类型信息 → 按"类型未知"处理（不能据此升档）
    const n = arg2 ?? 0;
    const d = computeScope({
      sourceGenres: Array.from({ length: n }, () => null),
      modelScope: arg1,
    });
    return { scope: d.scope, reason: d.reason };
  }
  const d = computeScope(arg1);
  return { scope: d.scope, reason: d.reason, evidence: d.evidence } as ScopeDecision;
}

/** 模式落库 */
export class PatternStore {
  private readonly logger: Logger;
  private readonly repo: CorpusRepository;

  constructor(opts: PatternStoreOptions) {
    this.logger = opts.logger;
    this.repo = opts.repo;
  }

  /**
   * 落库挖掘结果。
   *
   * ⚠ 用 `resolveScope` 覆盖模型自报的 scope，并记录原因 ——
   *   否则"单作品挖出的模式"会冒充类型规律进入 Writer 的上下文。
   */
  persist(patterns: readonly MinedPatternRecord[], idPrefix = 'pat'): {
    readonly written: number;
    readonly downgraded: number;
    /** 每条模式的证据记录（供调用方汇报，回答"为什么是这一档"） */
    readonly evidence: readonly { readonly trigger: string; readonly scope: SkillScope; readonly evidence: ScopeEvidence }[];
  } {
    let written = 0;
    let downgraded = 0;
    const evidenceOut: { trigger: string; scope: SkillScope; evidence: ScopeEvidence }[] = [];

    // 同批其它模式的可读文本 —— 用于反证检测（counter_evidence）。
    // ⚠ 传进去的是"同批所有模式"，包括自己；detectCounterEvidence 里
    //   自己与自己比较必然不冲突（同一段文本极性一致），无需特意排除。
    const siblings = patterns.map((x) => ({
      id: hashKey(`${x.sceneFunction}|${x.trigger}|${x.genre ?? ''}`),
      text: [x.trigger, x.decision.join('；'), x.boundary.join('；')].join('｜'),
    }));

    for (const p of patterns) {
      const selfId = hashKey(`${p.sceneFunction}|${p.trigger}|${p.genre ?? ''}`);
      const selfText = [p.trigger, p.decision.join('；'), p.boundary.join('；')].join('｜');

      // ⚠ scope 由**证据**算，不采信模型自报（P0-6）。
      //   证据口径 = 该模式实际引用的场景所覆盖的作品及其类型。
      const decision = computeScope({
        sourceGenres: p.sourceGenres,
        modelScope: p.scope,
        selfText,
        siblingPatterns: siblings.filter((x) => x.id !== selfId),
      });
      const scope = decision.scope;
      if (scope !== p.scope) {
        downgraded++;
        this.logger.info('模式作用域已按证据降档', {
          trigger: p.trigger,
          from: p.scope,
          to: scope,
          reason: decision.reason,
          evidence: decision.evidence,
        });
      }
      evidenceOut.push({ trigger: p.trigger, scope, evidence: decision.evidence });

      const id = `${idPrefix}_${selfId}`;
      const row = toPatternRow(p, id);
      this.repo.putPattern({
        ...row,
        scope,
        // 证据：真实 sceneId（已由编号映射校验过）
        evidenceRefsJson: JSON.stringify(p.evidenceSceneIds),
        // P0-6：scope 判定依据随行落库，可审计
        scopeEvidenceJson: JSON.stringify(decision.evidence),
      });
      written++;
    }

    return { written, downgraded, evidence: evidenceOut };
  }

  /**
   * 挖掘 + 落库（一个类型的全部已标注场景）。
   *
   * ⚠ 类型隔离：只喂同一（归一化）类型的场景 ——
   *   用户明确要求"写对应类型小说时才使用对应内容"。
   */
  async mineAndPersist(req: {
    readonly miner: PatternMiner;
    readonly textOf: (scene: CorpusSceneRow) => string;
    readonly genre: string | null;
    readonly scenes: readonly CorpusSceneRow[];
    /** 最多挖几组（<=0 表示全部） */
    readonly maxGroups?: number;
    readonly onProgress?: (done: number, total: number, fn: string) => void;
  }): Promise<{
    readonly mine: MineResult;
    readonly written: number;
    readonly downgraded: number;
    readonly analysis: CrossWorkAnalysis;
    /** P0-6：逐条 scope 判定依据（供调用方汇报/审计） */
    readonly scopeEvidence: readonly {
      readonly trigger: string;
      readonly scope: SkillScope;
      readonly evidence: ScopeEvidence;
    }[];
  }> {
    const analysis = analyzeCrossWork(req.scenes);
    this.logger.info('跨作品覆盖分析', {
      genre: req.genre,
      groups: analysis.coverage.length,
      comparable: analysis.comparableGroups,
      singleWork: analysis.singleWorkGroups,
    });

    const mine = await req.miner.mine({
      scenes: req.scenes,
      textOf: req.textOf,
      genre: req.genre,
      maxGroups: req.maxGroups,
      onProgress: req.onProgress,
    });

    const { written, downgraded, evidence } = this.persist(mine.patterns);
    return { mine, written, downgraded, analysis, scopeEvidence: evidence };
  }
}

/** 稳定短哈希（同模式重复挖掘时覆盖而非重复） */
function hashKey(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * ⚠ 按类型过滤场景（类型隔离的唯一入口）。
 *
 * 用户要求"写对应类型小说时才使用对应内容"。归一化后比较 ——
 * 库里的 "修仙"/"修真" 与查询的 "仙侠" 是同一类型，
 * 等值比较会漏掉。
 */
export function filterByGenre(
  scenes: readonly CorpusSceneRow[],
  genre: string | null,
): CorpusSceneRow[] {
  const target = normalizeGenre(genre);
  if (target === null) return [...scenes];
  return scenes.filter((s) => normalizeGenre(s.genre) === target);
}
