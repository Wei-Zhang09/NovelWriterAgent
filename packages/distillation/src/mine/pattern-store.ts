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
import { Logger } from '@nwa/core';
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
 * ⚠ 按来源作品数决定作用域 —— **不采信模型自报的 scope**。
 *
 * 模型看不到全局作品分布，它只能看到我们喂的片段。
 * 它说 "UNIVERSAL" 时其实无从判断。
 * 作品数是代码算得出来的事实，用它覆盖模型的判断。
 *
 * 但也不完全丢弃模型的意见：
 *   - 模型说 GENRE 而作品数够 → 尊重（它可能识别出类型特异性）
 *   - 模型说 UNIVERSAL 但只有 1 部作品 → **降级为 STYLE**（证据不足）
 */
export function resolveScope(
  modelScope: SkillScope,
  sourceDocumentCount: number,
): { readonly scope: SkillScope; readonly reason: string } {
  if (sourceDocumentCount <= 1) {
    // 单作品：无法区分叙事规律与作者癖好
    return {
      scope: 'STYLE',
      reason: '仅 1 部作品支持，无法区分叙事规律与作者风格',
    };
  }
  if (sourceDocumentCount === 2 && modelScope === 'UNIVERSAL') {
    return {
      scope: 'GENRE',
      reason: '2 部作品支持，不足以称跨类型通用',
    };
  }
  return { scope: modelScope, reason: '作品数与模型判断一致' };
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
  } {
    let written = 0;
    let downgraded = 0;

    for (const p of patterns) {
      const { scope, reason } = resolveScope(p.scope, p.sourceDocumentIds.length);
      if (scope !== p.scope) {
        downgraded++;
        this.logger.info('模式作用域已按证据降档', {
          trigger: p.trigger,
          from: p.scope,
          to: scope,
          reason,
        });
      }

      const id = `${idPrefix}_${hashKey(`${p.sceneFunction}|${p.trigger}|${p.genre ?? ''}`)}`;
      const row = toPatternRow(p, id);
      this.repo.putPattern({
        ...row,
        scope,
        // 证据：真实 sceneId（已由编号映射校验过）
        evidenceRefsJson: JSON.stringify(p.evidenceSceneIds),
      });
      written++;
    }

    return { written, downgraded };
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
    readonly onProgress?: (done: number, total: number, fn: string) => void;
  }): Promise<{
    readonly mine: MineResult;
    readonly written: number;
    readonly downgraded: number;
    readonly analysis: CrossWorkAnalysis;
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
      onProgress: req.onProgress,
    });

    const { written, downgraded } = this.persist(mine.patterns);
    return { mine, written, downgraded, analysis };
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
