/**
 * 模式挖掘（施工文档 §20 / §21）
 *
 * ## 与"让模型评论这段写得好在哪"的本质区别
 *
 * §20 的要求很明确：**不能只问"这段为什么写得好"**，必须强制模型
 * 填满七个槽位：
 *
 * ```
 * Trigger    什么时候触发（可复用的条件，不是剧情复述）
 * Context    触发时的情境约束（信息差/情绪张力/节奏位置）
 * Decision   具体手法（可执行的动作，不是"写得好"这种形容词）
 * Mechanism  为什么有效（读者心理机制）
 * Effect     产生的效果（张力上升/好奇上升/…）
 * Boundary   什么时候**不该**用（防止滥用）
 * Evidence   证据（必须指向真实场景）
 * ```
 *
 * 七槽强制填的价值：**"写得好"无法复用，"Decision + Mechanism" 才能**。
 * 而且 `Boundary` 强制模型说出失效条件 —— 只说"该用"不说"不该用"的
 * 知识会诱导 Writer 到处套用同一招。
 *
 * ## ⚠ Evidence 必须可回溯（§46）
 *
 * 模式里的每条证据都要指向**真实存在的 sceneId**。模型很容易
 * 编造"某部小说的某章" —— 因此：
 *   1. 给模型的场景带显式编号（`[S1]`、`[S2]`…），要求证据只引用编号
 *   2. 回来校验编号存在，**不存在的编号整条丢弃**（不是改成第一个）
 *   3. 落库时把编号映射回真实 sceneId
 *
 * 丢弃而非修补的理由：编造的证据说明这条模式可能是**幻觉的产物**，
 * 修补成"看起来有依据"比丢弃更危险。
 *
 * ## ⚠ 类型隔离（用户明确要求）
 *
 * "在写对应类型小说时，才使用对应的内容" —— 因此挖掘按类型分组，
 * 模式带 `genre` 与 `scope`（UNIVERSAL / GENRE / STYLE）。
 * 跨类型通用的模式标 UNIVERSAL，仅同类型有效的标 GENRE。
 */
import { z } from 'zod';
import { Logger } from '@nwa/core';
import type { CorpusSceneRow } from '@nwa/storage';
import { normalizeGenre, type SkillScope } from '@nwa/storage';
import type { AnnotationStructuredCaller } from '../parse/annotator.js';

// ── 模型输出契约 ──

/**
 * ⚠ 七个槽位全部必填。
 *
 * 可选槽位会让模型走捷径（跳过 Mechanism 与 Boundary），
 * 而这两个恰恰是最难编、最有价值的部分。
 */
export const MinedPatternSchema = z.object({
  /** 可复用的触发条件（如 "character_discovers_betrayal"） */
  trigger: z.string().min(2),
  /** 触发时的情境约束 */
  context: z.array(z.string().min(2)).min(1),
  /** 具体手法（可执行动作） */
  decision: z.array(z.string().min(2)).min(1),
  /** 为什么有效（读者心理机制） */
  mechanism: z.string().min(2),
  /** 产生的效果 */
  effect: z.array(z.string().min(2)).min(1),
  /** ⚠ 什么时候**不该**用 —— 防滥用 */
  boundary: z.array(z.string().min(2)).min(1),
  /** ⚠ 证据编号（`S1`/`S2`…），必须指向真实给出的场景 */
  evidence: z.array(z.string().min(1)).min(1),
  /** 置信度 0~1 */
  confidence: z.number().min(0).max(1),
  /**
   * ⚠ 作用域：这条模式能跨类型用吗？
   *
   * - `UNIVERSAL`：跨类型通用的叙事原理（如"用行为暗示情绪"）
   * - `GENRE`：**仅同类型**有效（都市文的"同桌递纸条"在仙侠不成立）
   * - `STYLE`：特定作者风格（需显式开启才用）
   */
  scope: z.enum(['UNIVERSAL', 'GENRE', 'STYLE']),
});

export type MinedPattern = z.infer<typeof MinedPatternSchema>;

const MineOutputSchema = z.object({
  patterns: z.array(MinedPatternSchema),
});

export interface PatternMinerOptions {
  readonly logger: Logger;
  /** 语义调用器（走 utility 槽位）；不传则无法挖掘 */
  readonly structured: AnnotationStructuredCaller;
  /** 每组送几个场景（越多越贵，太少挖不出共性） */
  readonly scenesPerGroup?: number;
  /** 每个场景送入模型的最大字符数 */
  readonly maxSceneChars?: number;
}

export interface MinedPatternRecord extends MinedPattern {
  /** 真实 sceneId（由编号映射而来，非模型给出） */
  readonly evidenceSceneIds: readonly string[];
  /** 来源文档 */
  readonly sourceDocumentIds: readonly string[];
  /** 场景功能（分组的依据） */
  readonly sceneFunction: string;
  /** 归一化类型 */
  readonly genre: string | null;
  /** 本组参与挖掘的场景数（置信度的分母依据） */
  readonly sampleCount: number;
  /** 证据编号里**不存在**的那些（如实记录，不静默丢弃） */
  readonly droppedEvidence: readonly string[];
}

export interface MineResult {
  readonly patterns: readonly MinedPatternRecord[];
  /** 尝试的组数（按 sceneFunction 分组） */
  readonly groups: number;
  /** 模型调用失败或输出不合契约的组数 */
  readonly failedGroups: number;
  /** 失败原因（如实报告，不吞） */
  readonly failures: readonly { readonly sceneFunction: string; readonly error: string }[];
}

/** 场景功能 → 中文任务描述（让模型知道自己在挖什么） */
const FUNCTION_HINT: Record<string, string> = {
  SETUP: '开场铺垫（介绍人物处境、建立期待）',
  CHARACTER_DEVELOPMENT: '人物塑造（揭示性格、动机、变化）',
  RELATIONSHIP_CHANGE: '关系变化（两人之间的距离拉近或推远）',
  CONFLICT: '冲突对抗（正面摩擦、目标受阻）',
  ESCALATION: '冲突升级（矛盾加剧、代价提高）',
  REVELATION: '揭示信息（秘密曝光、真相浮现）',
  REVERSAL: '反转（预期被推翻）',
  EMOTIONAL_PAYOFF: '情绪兑现（前面积累的情绪在此释放）',
  COOLDOWN: '缓冲回落（紧张后的松弛）',
  COMEDY_RELIEF: '喜剧调剂',
  TRANSITION: '场景过渡',
  CLIMAX: '高潮',
  RESOLUTION: '收束',
  FORESHADOW: '伏笔埋设',
  PAYOFF: '伏笔回收',
};

/**
 * 挖掘模式。
 *
 * ⚠ 按 `sceneFunction` 分组 —— 同一叙事任务的场景才有可比性。
 *   把"冲突"与"缓冲"混在一起挖，得到的是**平均后的废话**。
 */
export class PatternMiner {
  private readonly logger: Logger;
  private readonly structured: AnnotationStructuredCaller;
  private readonly scenesPerGroup: number;
  private readonly maxSceneChars: number;

  constructor(opts: PatternMinerOptions) {
    this.logger = opts.logger;
    this.structured = opts.structured;
    this.scenesPerGroup = opts.scenesPerGroup ?? 8;
    this.maxSceneChars = opts.maxSceneChars ?? 2000;
  }

  /**
   * 挖掘一组场景里的共性模式。
   *
   * ⚠ 模型看到的是**带编号的场景**，要求证据只引用编号。
   *   回来校验编号 —— 不存在的编号导致整条模式被丢弃（见文件头说明）。
   */
  async mineGroup(req: {
    readonly scenes: readonly CorpusSceneRow[];
    readonly sceneFunction: string;
    readonly textOf: (scene: CorpusSceneRow) => string;
    readonly genre: string | null;
  }): Promise<{
    readonly patterns: readonly MinedPatternRecord[];
    readonly error?: string;
  }> {
    const { scenes, sceneFunction, textOf, genre } = req;
    if (scenes.length === 0) return { patterns: [] };

    // 编号 → 真实 sceneId 的映射（只在这里建立，模型不碰 sceneId）
    //
    // ⚠ 作品用**字母代号**（甲/乙/丙）而非 document_id —— 让模型能看出
    //   "哪些场景来自不同作品"，从而判断某手法是跨作品共性
    //   还是单部作品的习惯。给内部 id 会让它倾向于忽略这个区别。
    const indexToId = new Map<string, string>();
    const docLabel = new Map<string, string>();
    const docSeq = ['甲', '乙', '丙', '丁', '戊', '己'];
    for (const sc of scenes) {
      if (!docLabel.has(sc.document_id)) {
        docLabel.set(sc.document_id, docSeq[docLabel.size] ?? `作${docLabel.size + 1}`);
      }
    }
    const docCount = docLabel.size;

    const blocks: string[] = [];
    for (let i = 0; i < scenes.length; i++) {
      const key = `S${i + 1}`;
      indexToId.set(key, scenes[i]!.id);
      const text = textOf(scenes[i]!).slice(0, this.maxSceneChars);
      const label = docLabel.get(scenes[i]!.document_id)!;
      blocks.push(
        `【${key}】作品${label}｜第 ${scenes[i]!.chapter_number ?? '?'} 章\n${text}`,
      );
    }

    const hint = FUNCTION_HINT[sceneFunction] ?? sceneFunction;
    const genreLine = genre
      ? `这些场景来自「${genre}」类作品，共 ${docCount} 部不同的作品` +
        `（标注为作品${[...docLabel.values()].join('、')}）。`
      : `这些场景来自 ${docCount} 部不同的作品。`;

    const prompt = [
      `以下是一批**同一叙事任务**（${hint}）的场景片段，来自真实出版/发表的作品。`,
      genreLine,
      '',
      '你的任务：提炼它们**共有的可复用写法**（不是复述剧情）。',
      '',
      '⚠ 严格要求：',
      '1. `evidence` 只能填场景编号（如 "S1"、"S3"），**不得编造**。',
      '   填了不存在的编号会导致这条模式被整条丢弃。',
      '2. `decision` 必须是**可执行的动作**（如"把情绪拆到动作与旁白"），',
      '   不能是"写得很细腻"这类评价。',
      '3. `mechanism` 要说明**读者心理层面**为什么有效。',
      '4. `boundary` 必须写出**什么时候不该用** —— 这是防滥用的关键。',
      '5. `scope` 判断：跨类型都成立的叙事原理填 UNIVERSAL；',
      `   只在「${genre ?? '本类型'}」成立、换个类型就不合理的填 GENRE。`,
      docCount >= 2
        ? `   ⚠ 特别注意：这批场景来自 ${docCount} 部**不同**作品。` +
          '若某手法只出现在同一部作品的场景里（证据编号都属同一作品），' +
          '它更可能是该作者的个人习惯，请把它填 GENRE 或降低 confidence；' +
          '只有**跨作品都出现**的手法才配 UNIVERSAL。'
        : '',
      '6. 若这批场景里**没有**明显的共性手法，返回空数组 —— ',
      '   不要为了交差硬凑。空结果比编造的模式有价值。',
      '',
      '场景：',
      ...blocks,
    ]
      .filter((x) => x !== '')
      .join('\n');

    try {
      const res = await this.structured({
        schema: MineOutputSchema,
        schemaName: 'MinedPatterns',
        messages: [
          {
            role: 'system',
            content:
              '你是叙事技法分析专家。只依据给定文本，不引入外部知识。' +
              '证据必须指向给定编号。宁可返回空数组，也不要编造模式。',
          },
          { role: 'user', content: prompt },
        ],
        maxTokens: 3000,
        temperature: 0.2,
      });

      // ⚠ 调用失败要如实上报，不能当成"这组没模式"
      if (!res.ok) {
        this.logger.warn('模式挖掘调用失败（该组跳过）', {
          sceneFunction,
          error: res.error.message,
        });
        return { patterns: [], error: `${res.error.code}：${res.error.message}` };
      }
      const parsed = MineOutputSchema.parse(res.data);
      const records: MinedPatternRecord[] = [];
      const docIds = new Set(scenes.map((s) => s.document_id));

      for (const p of parsed.patterns) {
        // ⚠ 校验证据编号：不存在的编号 → **整条丢弃**（不修补）
        const valid: string[] = [];
        const dropped: string[] = [];
        for (const ev of p.evidence) {
          const key = ev.trim().toUpperCase().replace(/^\[|\]$/g, '');
          const id = indexToId.get(key);
          if (id) valid.push(id);
          else dropped.push(ev);
        }

        if (valid.length === 0) {
          // 没有任何有效证据 = 这条模式无据可依 → 丢弃
          this.logger.warn('丢弃无有效证据的模式', {
            sceneFunction,
            trigger: p.trigger,
            claimed: p.evidence,
          });
          continue;
        }

        records.push({
          ...p,
          evidenceSceneIds: valid,
          droppedEvidence: dropped,
          sourceDocumentIds: [...docIds],
          sceneFunction,
          genre: normalizeGenre(genre),
          sampleCount: scenes.length,
        });
      }

      if (droppedTotal(records) > 0) {
        this.logger.warn('部分证据编号不存在（已记录，未修补）', {
          sceneFunction,
          patterns: records.length,
        });
      }

      return { patterns: records };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn('模式挖掘失败（该组跳过）', { sceneFunction, error: msg });
      return { patterns: [], error: msg };
    }
  }

  /**
   * 按 `sceneFunction` 分组，逐组挖掘。
   *
   * ⚠ 组内场景数超过 `scenesPerGroup` 时**均匀抽样**而非取前 N ——
   *   取前 N 会让模式只反映作品开头（写作手法在开篇与中后段常不同）。
   */
  async mine(req: {
    readonly scenes: readonly CorpusSceneRow[];
    readonly textOf: (scene: CorpusSceneRow) => string;
    readonly genre: string | null;
    /**
     * 最多挖几组（`undefined` 或 `<= 0` 表示全部）。
     *
     * ⚠ 之前这个参数在 IPC 层声明了却没实现 —— 调用方传 `--groups=3`
     *   以为只挖 3 组，实际全挖。**声明了却不生效的参数比没有更糟**：
     *   它让调用方对代价有错误预期（挖掘按组调用模型）。
     */
    readonly maxGroups?: number;
    readonly onProgress?: (done: number, total: number, fn: string) => void;
  }): Promise<MineResult> {
    // 按 sceneFunction 分组
    const groups = new Map<string, CorpusSceneRow[]>();
    for (const s of req.scenes) {
      const fn = s.scene_function;
      // ⚠ 无 sceneFunction 的场景无法分组 —— 跳过而非归入 "unknown"。
      //   归入 unknown 会挖出"杂项场景的共性"，那是统计噪声不是叙事规律。
      if (!fn) continue;
      if (!groups.has(fn)) groups.set(fn, []);
      groups.get(fn)!.push(s);
    }

    const patterns: MinedPatternRecord[] = [];
    const failures: { sceneFunction: string; error: string }[] = [];
    let done = 0;

    // ⚠ `<= 0` 视为"全部"（调用方传 0 表示不限制，而不是"一组都不挖"）
    const limit = req.maxGroups && req.maxGroups > 0 ? req.maxGroups : Number.POSITIVE_INFINITY;
    const entries = [...groups.entries()].slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit);

    for (const [fn, all] of entries) {
      // ⚠ 分层抽样：保证每部作品都有代表，否则跨作品证据会被抽样抹掉，
      //   导致模式被错误降档为 STYLE（虚假的"证据不足"）
      const sampled = sampleStratifiedByDocument(all, this.scenesPerGroup);
      const r = await this.mineGroup({
        scenes: sampled,
        sceneFunction: fn,
        textOf: req.textOf,
        genre: req.genre,
      });
      patterns.push(...r.patterns);
      if (r.error) failures.push({ sceneFunction: fn, error: r.error });
      done++;
      req.onProgress?.(done, entries.length, fn);
    }

    return {
      patterns,
      groups: entries.length,
      failedGroups: failures.length,
      failures,
    };
  }
}

function droppedTotal(records: readonly MinedPatternRecord[]): number {
  return records.reduce((s, r) => s + r.droppedEvidence.length, 0);
}

/**
 * 均匀抽样。
 *
 * ⚠ 不用"取前 N"：那会让模式只反映作品开头。
 *   写作手法在开篇与中后段常不同（开篇重铺垫、后段重冲突）。
 */
export function sampleEvenly<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const out: T[] = [];
  const step = items.length / n;
  for (let i = 0; i < n; i++) {
    out.push(items[Math.floor(i * step)]!);
  }
  return out;
}

/**
 * ⚠ 按来源作品**分层**抽样（跨作品分析的前提）。
 *
 * ## 为什么必须分层
 *
 * `sourceDocumentIds` 是从**送给模型的样本**里算出来的，它决定了
 * 这条模式算"类型规律"还是"作者风格"（见 resolveScope）。
 *
 * 若只用 `sampleEvenly`：某组有 2 部作品各 100 个场景，抽 8 个时
 * **可能 8 个全来自同一部**（尤其两部作品场景数悬殊时）。
 * 后果：这条模式明明有跨作品证据，却被降档为 STYLE ——
 * **虚假的"证据不足"**，让跨作品分析白做。
 *
 * 实测数据形态：`CHARACTER_DEVELOPMENT` 在《百岁之好》67 个场景，
 * 在《清纯校花》里更多 —— 两部作品场景数悬殊，均匀抽样很容易全落在一部。
 *
 * ## 做法
 *
 * 先按作品分组，每部作品内均匀抽 `n / 作品数` 个（至少 1 个），
 * 再按原始顺序合并 —— 保证**每部作品都有代表**。
 * 若某部作品场景太少，余额由场景多的作品补齐（不硬凑重复）。
 */
export function sampleStratifiedByDocument<T extends { readonly document_id: string }>(
  items: readonly T[],
  n: number,
): T[] {
  if (items.length <= n) return [...items];

  const byDoc = new Map<string, T[]>();
  for (const it of items) {
    if (!byDoc.has(it.document_id)) byDoc.set(it.document_id, []);
    byDoc.get(it.document_id)!.push(it);
  }

  // 单一作品：退化为均匀抽样
  if (byDoc.size === 1) return sampleEvenly(items, n);

  const perDoc = Math.max(1, Math.floor(n / byDoc.size));
  const picked: T[] = [];
  const leftovers: T[] = [];

  for (const group of byDoc.values()) {
    const take = sampleEvenly(group, Math.min(perDoc, group.length));
    picked.push(...take);
    const taken = new Set(take);
    leftovers.push(...group.filter((x) => !taken.has(x)));
  }

  // 余额（因某部作品不足而剩下的名额）从其余场景里均匀补
  const shortfall = n - picked.length;
  if (shortfall > 0 && leftovers.length > 0) {
    picked.push(...sampleEvenly(leftovers, shortfall));
  }

  // 按原始顺序返回，便于模型看到连贯的上下文
  const order = new Map(items.map((x, i) => [x, i]));
  return picked
    .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
    .slice(0, n);
}

/** 模式 → 落库行（供仓储写入） */
export function toPatternRow(p: MinedPatternRecord, id: string): {
  readonly id: string;
  readonly category: string;
  readonly triggerJson: string;
  readonly patternJson: string;
  readonly strategyJson: string;
  readonly evidenceRefsJson: string;
  readonly confidence: number;
  readonly sampleCount: number;
  readonly mechanism: string;
  readonly genre: string | null;
  readonly sceneFunction: string;
  readonly scope: SkillScope;
} {
  return {
    id,
    category: 'narrative_technique',
    triggerJson: JSON.stringify({
      trigger: p.trigger,
      context: p.context,
    }),
    patternJson: JSON.stringify({
      decision: p.decision,
      effect: p.effect,
      boundary: p.boundary,
    }),
    strategyJson: JSON.stringify({ mechanism: p.mechanism }),
    evidenceRefsJson: JSON.stringify(p.evidenceSceneIds),
    // ⚠ 置信度按样本量打折：3 个样本挖出的"共性"不该与 20 个样本同权
    confidence: discountBySample(p.confidence, p.sampleCount),
    sampleCount: p.sampleCount,
    mechanism: p.mechanism,
    genre: p.genre,
    sceneFunction: p.sceneFunction,
    scope: p.scope,
  };
}

/**
 * 按样本量折扣置信度。
 *
 * ⚠ 为什么必须折扣：模型给的 confidence 是"这条模式描述得有多确信"，
 *   不是"它在总体里有多普遍"。3 个样本里 3 个都有，模型会说 0.9，
 *   但这可能只是抽样偏差。
 *
 *   折扣曲线：n<5 折半，n=8 折 0.8，n>=15 不打折。
 *   宁可低估，也不要让 Writer 拿到虚高的置信度去到处套用。
 */
export function discountBySample(confidence: number, n: number): number {
  const factor = n >= 15 ? 1 : n >= 8 ? 0.8 : n >= 5 ? 0.65 : 0.5;
  return Math.round(confidence * factor * 100) / 100;
}
