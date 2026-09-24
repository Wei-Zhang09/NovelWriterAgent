/**
 * Scope 证据计算（P0-6）。
 *
 * ## 需求原话（总提示词 §八）
 *
 * > 但是 Universal 不能仅依据「跨多本作品」。
 * > 例如：都市小说 A / 都市小说 B / 都市小说 C —— 不代表 Universal。
 * > 建议：1 本作品 → STYLE；2+ 同类型作品 → GENRE；2+ 不同类型作品 → 才可能 UNIVERSAL。
 * > 最终 scope 必须尽可能由代码计算，而不是仅相信 LLM 输出。
 *
 * ## 修的是什么（真实缺陷）
 *
 * 此前 `resolveScope(modelScope, sourceDocumentCount)` **只数作品数**，
 * 完全没有类型维度。于是三部**同类型**（都市校园 / 都市言情 / 都市）
 * 作品就能让一条模式保持 UNIVERSAL —— 正是用户点名的那种情形。
 *
 * 更糟的是：模型的判断是**通过条件**。作品数够（≥3）时
 * `resolveScope` 直接 `return { scope: modelScope }`，即"作品数与模型判断一致"。
 * 也就是说模型说 UNIVERSAL 就真是 UNIVERSAL —— 而模型看不到全局作品分布，
 * 它只能看到我们喂进去的那几个片段，它说 UNIVERSAL 时其实无从判断。
 *
 * 现在的规则：**scope 由证据计算，模型的判断只作为"上限"参与**。
 *
 * ## ⚠ 只降不升
 *
 * 计算结果与模型自报取**更保守的那个**（STYLE 最窄、UNIVERSAL 最宽）。
 * 理由：
 *   - 模型说 STYLE 而证据支持 UNIVERSAL → 保留 STYLE。
 *     它可能识别出了我们统计不到的、只有某位作者才有的习惯；
 *     升级会让一条作者癖好冒充通用规律（§21 明确要防的）。
 *   - 模型说 UNIVERSAL 而证据只支持 GENRE → 取 GENRE（本 P0 要修的正是这条）。
 * 代价是可能**漏掉**真正通用的模式。这个方向的错误是可接受的：
 * 少用一条通用手法的代价，小于把作者癖好当规律到处套用。
 *
 * ## 证据字段（§八 要求至少记录）
 *
 * `support` / `coverage` / `cross_work_coverage` / `cross_genre_coverage` /
 * `counter_evidence` / `stability` / `held_out_validation`
 *
 * 其中三项刻意**不编造**（见各字段注释）：
 *   - `stability` —— 同一批语料重复挖掘会得到不同模式集，
 *     没做重复实验就不该声称"稳定"。
 *   - `held_out_validation` —— 需要留出作品做验证，当前流程没有，
 *     如实标 `NOT_RUN` 而不是假装通过。
 *   - `counter_evidence` —— 只能检查"同一批模式里有没有相反写法"。
 *     跨类型语料尚不存在（库里只有都市类已标注），
 *     所以"别的类型是否用相反写法"这一维度**查不了**，如实记在 limitations。
 */

import { detectRuleConflict } from './rule-conflict.js';

/** 作用域（与 storage 的 SkillScope 取值一致；core 不依赖 storage，故本地声明） */
export const SCOPE_LEVELS = ['UNIVERSAL', 'GENRE', 'STYLE'] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

/** 越具体越窄；用于"取更保守的那个" */
const SCOPE_RANK: Readonly<Record<ScopeLevel, number>> = {
  UNIVERSAL: 1,
  GENRE: 2,
  STYLE: 3,
};

/** 取两个 scope 中**更保守**（更窄）的那个 */
export function narrowerScope(a: ScopeLevel, b: ScopeLevel): ScopeLevel {
  return SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b;
}

/** 参与计算的证据（一条模式的实际来源，按**证据口径**而非样本口径） */
export interface ScopeEvidenceInput {
  /**
   * 该模式**证据实际覆盖**的作品 → 该作品的归一化类型。
   *
   * ⚠ 必须是"证据覆盖的"而不是"样本里有哪些"：
   *   实测样本含 2 部作品时，模型给出的证据常常只引用同一部作品的场景
   *   （64 条 GENRE 里 44 条如此）。用样本口径会放过它们。
   *
   * 类型为 `null` 表示该作品的类型未知 —— 按"不能算作不同类型"处理，
   * 即未知类型不能用来把模式推上 UNIVERSAL。这是刻意的保守取舍：
   * 类型元数据缺失时，宁可不升档。
   */
  readonly sourceGenres: readonly (string | null)[];
  /** 模型自报的 scope（只作为上限参与，不直接采信） */
  readonly modelScope: ScopeLevel;
  /** 同批其它模式的可读文本（用于反证检测）；不传则反证维度标"未检查" */
  readonly siblingPatterns?: readonly { readonly id: string; readonly text: string }[];
  /** 本模式的文本（用于与同批其它模式做冲突比较） */
  readonly selfText?: string;
}

/** 反证：有没有另一条模式用相反写法 */
export interface CounterEvidence {
  /**
   * 检测状态。
   *   `NONE`     查过了，没有发现相反写法
   *   `FOUND`    发现相反写法（见 conflicts）
   *   `NOT_CHECKED` 没有提供同批模式文本，**没查**（不等于"没有"）
   */
  readonly status: 'NONE' | 'FOUND' | 'NOT_CHECKED';
  readonly conflicts: readonly {
    readonly otherId: string;
    readonly reason: string;
  }[];
}

/** 完整证据记录（§八 要求至少记录这七项） */
export interface ScopeEvidence {
  /** 支持的作品数（= 证据覆盖的作品数） */
  readonly support: number;
  /** 证据覆盖的作品数（与 support 同源，分开命名是为了与 §八 字段对齐） */
  readonly coverage: number;
  /** 跨作品覆盖：≥2 部作品 */
  readonly crossWorkCoverage: number;
  /** 跨类型覆盖：≥2 个**不同**归一化类型 */
  readonly crossGenreCoverage: number;
  /** 反证 */
  readonly counterEvidence: CounterEvidence;
  /**
   * 稳定性。
   *
   * ⚠ 恒为 `NOT_RUN`：同一批语料重复挖掘会得到不同的模式集
   *   （抽样 + 模型采样都有方差）。没做重复实验就不该声称"稳定" ——
   *   填一个看起来合理的分数是**伪造证据**。
   */
  readonly stability: 'NOT_RUN';
  /** 留出验证（held-out） */
  readonly heldOutValidation: 'NOT_RUN';
  /** 归一化后的类型分布（如实记录，便于人工核对） */
  readonly genres: readonly string[];
  /** 未能判定类型的作品数（类型元数据缺失） */
  readonly unknownGenreCount: number;
}

export interface ScopeDecision {
  readonly scope: ScopeLevel;
  /** 人类可读的判定依据（写进日志，回答"为什么是这一档"） */
  readonly reason: string;
  readonly evidence: ScopeEvidence;
  /** 模型自报的 scope（保留原值，便于对比"模型想给什么"） */
  readonly modelScope: ScopeLevel;
}

/**
 * 由证据计算 scope。
 *
 * 规则（§八）：
 *   1 部作品            → STYLE
 *   ≥2 部，全部同类型    → GENRE
 *   ≥2 部，且 ≥2 个不同类型 → 才可能 UNIVERSAL
 *
 * ⚠ "才可能" —— 跨类型证据只让它**有资格**是 UNIVERSAL，
 *   最终还要看模型是否也认为是（取更保守者）。见文件头"只降不升"。
 */
export function computeScope(input: ScopeEvidenceInput): ScopeDecision {
  // 归一化 + 去重（同一类型多部作品只算一个类型）
  const genres = [...new Set(input.sourceGenres.filter((g): g is string => typeof g === 'string' && g.length > 0))];
  const unknownGenreCount = input.sourceGenres.filter((g) => g === null || g === undefined).length;
  const support = input.sourceGenres.length;
  const crossWorkCoverage = support >= 2 ? support : 0;
  const crossGenreCoverage = genres.length >= 2 ? genres.length : 0;

  const counterEvidence = detectCounterEvidence(input.selfText, input.siblingPatterns);

  const evidence: ScopeEvidence = {
    support,
    coverage: support,
    crossWorkCoverage,
    crossGenreCoverage,
    counterEvidence,
    stability: 'NOT_RUN',
    heldOutValidation: 'NOT_RUN',
    genres,
    unknownGenreCount,
  };

  // ── 由证据决定"最高可达"档位 ──
  let byEvidence: ScopeLevel;
  let evidenceReason: string;
  if (support <= 1) {
    byEvidence = 'STYLE';
    evidenceReason = `证据仅覆盖 ${support} 部作品，无法区分叙事规律与作者风格`;
  } else if (crossGenreCoverage === 0) {
    byEvidence = 'GENRE';
    const detail =
      genres.length === 1
        ? `全部 ${support} 部作品同属「${genres[0]}」类`
        : `证据覆盖 ${support} 部作品但类型全部未知（不能据此升档）`;
    evidenceReason = `${detail}，只够类型规律（GENRE）`;
  } else {
    byEvidence = 'UNIVERSAL';
    evidenceReason = `证据覆盖 ${support} 部作品、跨 ${crossGenreCoverage} 个类型（${genres.join('、')}）`;
  }

  // ── 与模型自报取更保守者（只降不升）──
  const scope = narrowerScope(byEvidence, input.modelScope);
  const downgraded = scope !== input.modelScope;
  const reason = downgraded
    ? `证据只支持 ${byEvidence}（${evidenceReason}），模型自报 ${input.modelScope} 过于宽泛，按证据降为 ${scope}`
    : `${evidenceReason}，与模型自报 ${input.modelScope} 一致`;

  return { scope, reason, evidence, modelScope: input.modelScope };
}

/**
 * 反证检测：同批模式里有没有"谈同一件事却给出相反指示"的另一条。
 *
 * ⚠ 这里只检查**同一批**模式。跨类型反证（"玄幻作品是否用相反写法"）
 *   当前查不了 —— 库里只有都市类语料做过标注。如实标 `NOT_CHECKED`
 *   的语义边界：提供了同批文本就是 `NONE`（查过没有），
 *   没提供就是 `NOT_CHECKED`（没查）。**两者不能混为一谈**。
 */
function detectCounterEvidence(
  selfText: string | undefined,
  siblings: readonly { readonly id: string; readonly text: string }[] | undefined,
): CounterEvidence {
  if (!selfText || !siblings || siblings.length === 0) {
    return { status: 'NOT_CHECKED', conflicts: [] };
  }
  const conflicts: { otherId: string; reason: string }[] = [];
  for (const s of siblings) {
    const why = detectRuleConflict(selfText, s.text);
    if (why) conflicts.push({ otherId: s.id, reason: why });
  }
  return conflicts.length > 0
    ? { status: 'FOUND', conflicts }
    : { status: 'NONE', conflicts: [] };
}
