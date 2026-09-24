/**
 * Skill Engine（施工文档 §25 Skill Runtime）
 *
 * ## 职责：为**一个场景**选出 Top-N 技能
 *
 * §25 的原文要求很明确：
 * ```
 * Scene Type: CLIMAX     ┐
 * Emotion: HIGH          │  Skill Engine 检索
 * Goal: win_confrontation│  → climax_pacing / high_tension_emotion /
 * POV: third_person_limited    dialogue_confrontation / reversal /
 * Genre: urban_fantasy   ┘  chapter_hook
 * 然后只注入 Top-N。默认 2~5 个 Skills。
 * 不要把整个 Skill Library 全塞进 Prompt。
 * ```
 *
 * ## ⚠ 为什么"只注入 Top-N"是硬要求而不是优化
 *
 * 技能库会随语料增长（实测两部都市作品已产出 24 个技能）。
 * 全量注入的后果不是"稍微慢一点"，而是：
 *   1. **预算被挤占** —— §28 的上下文预算是硬约束，技能挤掉的
 *      是正文计划、前情摘要、Canon 的位置
 *   2. **信号被淹没** —— 24 条建议里真正相关的 3 条不再突出，
 *      模型倾向于抓最显眼的（往往是无关的）那几条
 *   3. **互相矛盾** —— 不同场景功能的技能会给出相反建议
 *      （"拉长情绪"vs"加快节奏"），同时注入让模型无所适从
 *
 * ## ⚠ 分层：本模块不依赖 distillation
 *
 * 技能的**生产**（挖掘 + 编译）在 `distillation`；
 * 技能的**使用**只需要读 `storage`。这个分层很重要：
 * 运行时的 Writer 不该拖进整条离线蒸馏链路。
 *
 * ## ⚠ 排序不能只看 confidence
 *
 * confidence 是"这条技能描述得有多准"，**不是"它有多适合当前场景"**。
 * 只按 confidence 排序会让高分技能在每个场景都被注入 ——
 * 哪怕它与当前场景无关。因此排序的主信号是**匹配度**，
 * confidence 只作为同匹配度时的次级依据。
 */
import { dedupeBySimilarity } from '@nwa/core';
import type { SkillRow } from '@nwa/storage';
import { filterSkillsByGenre, normalizeGenre, sameGenre } from '@nwa/storage';
import type { Skill, SkillTrigger } from '@nwa/shared';
import { SkillSchema } from '@nwa/shared';
import {
  resolveSkillConflicts,
  type ConflictResolution,
  type SameScopeConflict,
} from './conflict-resolver.js';

/** 检索场景的上下文（§25 的检索输入） */
export interface SceneContext {
  /** 场景功能（§19.1 枚举；Planner 声明） */
  readonly sceneFunction?: string | null;
  /** 目标类型（写什么类型的小说） */
  readonly genre?: string | null;
  /** 情感强度 0~1（可选） */
  readonly emotionIntensity?: number | null;
  /** 视角（可选，用于未来扩展） */
  readonly pov?: string | null;
  /**
   * 用户指定要模仿的来源作品（语料 documentId）。
   *
   * ⚠ 这是 STYLE 技能的**可见性开关**（§九 第三条方案）：
   *   用户说"照这部作品写"时，来自该作品的 STYLE 技能可见。
   *   没有它就只能靠全局 allowStyle 或编译期升档 —— 前者会连带引入
   *   无关作品的风格，后者伪造证据范围。
   */
  readonly styleSources?: readonly string[];
  /** 当前作品的风格类型（未指定具体作品时的退路） */
  readonly styleGenre?: string | null;
}

export interface SkillEngineOptions {
  /**
   * 最多注入几个技能（§25 默认 2~5）。
   *
   * ⚠ 上限是硬约束：它保护的是**上下文预算**，不是"锦上添花"。
   */
  readonly maxSkills?: number;
  /** 每个技能的字符预算（超出则截断规则列表，并如实标记） */
  readonly maxCharsPerSkill?: number;
  /** 是否允许 STYLE 技能（§21：默认 false，Writer 不用作者特有策略） */
  readonly allowStyle?: boolean;
  /**
   * 用户指定要模仿的来源作品（默认空）。
   *
   * ⚠ 这是让 STYLE 技能**在有明确理由时可见**的正规途径 ——
   *   替代"编译期把 scope 升档"那种伪造证据的做法。
   */
  readonly styleSources?: readonly string[];
  /** 当前作品的风格类型 */
  readonly styleGenre?: string | null;
  /** 最低置信度（默认 0，不额外过滤） */
  readonly minConfidence?: number;
  /**
   * 近重复抑制阈值（默认 0.40，与编译期去重同值）。
   *
   * ⚠ 为什么运行时**还要**去重（编译期已经去过一次）：
   *   编译期去重是**跨技能**的全局判据，而运行时是**同一场景内**
   *   被同时选中的技能之间的判据 —— 两者判据相同但集合不同。
   *
   *   实测：`calm_counter_as_moral_high_ground` 与
   *   `calm_upper_hand_declaration` 相似度 **0.435** —— 同一个 CONFLICT
   *   场景把**两条都选中了**，模型收到两份近乎相同的指令。
   *
   *   ⚠ 阈值取 0.40 是**实测**结果，分布有明显间隔：
   * ```
   *   0.435  calm_counter_as_moral_high_ground ~ calm_upper_hand_declaration  ← 确为重复
   *   ───── 0.40 分界 ─────
   *   0.316  third_party_intrusion_escalation ~ public_private_collision
   *   0.302  evidence_before_reveal ~ physical_evidence_reveal
   *   0.284  conflict_power_balance_visualization ~ witnessed_conflict_staging
   *   0.244  body_signal_for_emotion ~ body_over_emotion_label
   * ```
   *   分界之后那几对**可能是不同手法**（只是措辞相近），
   *   合并它们会永久丢失一个手法 —— 所以宁可保留。
   *
   *   阈值与编译期保持一致，否则会出现"编译时判为重复、运行时又同时注入"
   *   的不一致。
   */
  readonly dedupeThreshold?: number;
}

/** 一条被选中的技能（含选中原因，便于诊断"为什么用了这个"） */
export interface SelectedSkill {
  readonly skill: Skill;
  readonly score: number;
  /** 选中的依据（可读，用于日志与调试） */
  readonly reasons: readonly string[];
  /** 截断后的渲染文本 */
  readonly rendered: string;
  /** 是否因字符预算被截断（如实标记） */
  readonly truncated: boolean;
}

export interface SkillSelection {
  readonly selected: readonly SelectedSkill[];
  /** ⚠ 落选的技能及原因（不静默丢弃 —— 便于回答"某技能为什么没被用到"） */
  readonly rejected: readonly { readonly id: string; readonly name: string; readonly reason: string }[];
  /** 渲染后的注入文本（空字符串表示无技能可用） */
  readonly block: string;
  /** 过滤后参与打分的候选数（不含已被类型/状态排除的） */
  readonly considered: number;
  /**
   * 冲突解决记录（Scope Precedence）。
   *
   * ⚠ 无冲突时为空数组 —— 三个 Scope 的技能全部保留。
   *   Scope 优先级**只在冲突时**起作用。
   */
  readonly resolutions: readonly ConflictResolution[];
  /**
   * 同 Scope 之间的冲突（**未被删除**）。
   *
   * 同 Scope 时 Scope 本身不提供判据，只能靠既有评分机制排序；
   * 这里如实记录，便于观测"两条同类技能给出相反指示"。
   */
  readonly sameScopeConflicts: readonly SameScopeConflict[];
}

/**
 * Skill Engine。
 *
 * ⚠ 无状态：技能每次由调用方传入（来自 `CorpusRepository.listSkills()`）。
 *   不在这里缓存 —— 技能是可被人工下架（DEPRECATED）的，
 *   缓存会让"刚下架的技能又被用上"。
 */
export class SkillEngine {
  private readonly maxSkills: number;
  private readonly maxCharsPerSkill: number;
  private readonly allowStyle: boolean;
  private readonly styleSources: readonly string[];
  private readonly styleGenre: string | null;
  private readonly minConfidence: number;
  private readonly dedupeThreshold: number;

  constructor(opts: SkillEngineOptions = {}) {
    this.maxSkills = clamp(opts.maxSkills ?? 4, 1, 8);
    this.maxCharsPerSkill = opts.maxCharsPerSkill ?? 700;
    this.allowStyle = opts.allowStyle === true;
    this.styleSources = opts.styleSources ?? [];
    this.styleGenre = opts.styleGenre ?? null;
    this.minConfidence = opts.minConfidence ?? 0;
    this.dedupeThreshold = opts.dedupeThreshold ?? 0.40;
  }

  /**
   * 为一个场景检索技能。
   *
   * @param rows 库里的技能行（原样传入，本模块负责解析与过滤）
   */
  retrieve(rows: readonly SkillRow[], ctx: SceneContext): SkillSelection {
    // ── 1. 类型隔离（§21 的唯一入口）──
    //
    // ⚠ 走 filterSkillsByGenre 而不是自己写 where：
    //   过滤规则一旦分散，就会出现"某条路径忘了按类型过滤"的漏洞，
    //   而那种漏洞只在跨类型场景下暴露。
    // ⚠ SceneContext 里的 styleSources/styleGenre **优先**于引擎级默认值。
    //   这样同一个引擎实例可以逐场景决定"这一段是否要模仿指定作品"，
    //   而不必为每个场景重建引擎。
    const filtered = filterSkillsByGenre(rows, {
      genre: ctx.genre ?? null,
      allowStyle: this.allowStyle,
      styleSources: ctx.styleSources ?? this.styleSources,
      styleGenre: ctx.styleGenre ?? this.styleGenre,
    });

    const rejected: { id: string; name: string; reason: string }[] = filtered.excluded.map((e) => ({
      id: e.skill.id,
      name: e.skill.name,
      reason: e.reason,
    }));

    // ── 2. 解析 + 基础过滤 ──
    const candidates: { skill: Skill; row: SkillRow }[] = [];
    for (const row of filtered.kept) {
      // 状态：DEPRECATED 已被 filterSkillsByGenre 排除
      if (row.confidence < this.minConfidence) {
        rejected.push({
          id: row.id,
          name: row.name,
          reason: `confidence ${row.confidence} < ${this.minConfidence}`,
        });
        continue;
      }
      const skill = parseSkillRow(row);
      if (!skill) {
        // ⚠ 解析失败如实报告，不静默跳过 —— 否则"某技能从未被用到"
        //   会变成一个查不出原因的现象
        rejected.push({ id: row.id, name: row.name, reason: '技能行解析失败（schema 不符）' });
        continue;
      }
      candidates.push({ skill, row });
    }

    // ── 3. 打分 ──
    const scored = candidates.map((c) => this.score(c.skill, ctx));

    // 只保留**有场景功能匹配**的（若无 sceneFunction 信息则全部保留）
    const wantFn = (ctx.sceneFunction ?? '').trim();
    const withFn = wantFn
      ? scored.filter((s) => s.fnMatch)
      : scored;

    // ⚠ 场景功能匹配数为 0 时**不注入任何技能**，而不是退化成"注入高置信度的"。
    //
    //   理由：§25 的检索输入以 Scene Type 为主键。若当前场景是 COOLDOWN
    //   而库里只有 CONFLICT 技能，注入 CONFLICT 技能会**误导** ——
    //   模型会把"冲突要拉张力"用在缓冲场景上，正好写反。
    //   宁可不给建议，也不要给错建议。
    const pool = wantFn ? withFn : scored;

    for (const s of scored) {
      if (!pool.includes(s)) {
        rejected.push({
          id: s.skill.id,
          name: s.skill.name,
          reason: `场景功能不匹配（技能要求 ${JSON.stringify(s.skill.trigger.sceneTypes)}，当前 ${wantFn || '未声明'}）`,
        });
      }
    }

    // ── 4. 排序 + 取 Top-N ──
    const sorted = [...pool].sort(
      (a, b) =>
        b.score - a.score ||
        b.skill.confidence - a.skill.confidence ||
        a.skill.id.localeCompare(b.skill.id), // 稳定排序，保证可重复
    );

    // ── 5. 冲突解决（Scope Precedence）──
    //
    // ⚠⚠ 必须在近重复抑制**之前** —— 顺序不能反，这是实测出来的。
    //
    //   互相**矛盾**的两条规则，措辞必然高度相似（谈同一件事、用相近的词），
    //   所以它们在近重复判据下看起来就像"重复"。实测：
    // ```
    //   "避免直接解释人物情绪"(UNIVERSAL) ~ "悬疑高潮可以短暂直接揭示情绪"(GENRE)  → 0.43
    //   "避免直接解释人物情绪"(UNIVERSAL) ~ "本作品在冲突段落允许直接揭示情绪"(STYLE) → 0.40
    // ```
    //   两者都越过 0.40 阈值。若先去重：
    //   - 冲突解决拿不到这对规则 → `resolutions` 永远为空 → **功能形同虚设**
    //   - 谁被删由**分数**决定，而不是由 Scope 具体性决定
    //   - 实测 STYLE 曾被 UNIVERSAL 以"近重复"为由删掉 ——
    //     正好与 `STYLE > UNIVERSAL` **完全相反**
    //
    //   去重的语义是"这两条说的是同一件事"，冲突的语义是"这两条说的是相反的事"。
    //   措辞相似无法区分二者，所以**必须先做更高风险的判断（冲突）**，
    //   再去重只在存活者之间进行。
    const resolved = resolveSkillConflicts(sorted);
    for (const d of resolved.dropped) {
      rejected.push({ id: d.item.skill.id, name: d.item.skill.name, reason: d.reason });
    }

    // ⚠ 先做近重复抑制**再**取 Top-N —— 顺序不能反。
    //
    //   若先取 Top-N 再去重，会出现"4 个名额被 2 组近重复占掉、
    //   只剩 2 条有效建议"的情况。先去重能让名额给到真正不同的技能。
    const deduped = dedupeBySimilarity(
      resolved.kept,
      (x) => skillText(x.skill),
      this.dedupeThreshold,
    );
    for (const d of deduped.dropped) {
      rejected.push({
        id: d.item.skill.id,
        name: d.item.skill.name,
        reason: `与已选技能近重复（${d.similarTo.skill.name}，相似度 ${d.similarity}）`,
      });
    }

    const picked: SelectedSkill[] = [];
    for (const s of deduped.kept) {
      if (picked.length >= this.maxSkills) {
        rejected.push({
          id: s.skill.id,
          name: s.skill.name,
          reason: `超出 Top-${this.maxSkills} 上限（得分 ${s.score.toFixed(2)}）`,
        });
        continue;
      }
      picked.push({
        skill: s.skill,
        score: s.score,
        reasons: s.reasons,
        rendered: '',
        truncated: false,
      });
    }

    // 只为存活技能渲染（落败者已在冲突解决阶段出局，不必渲染）
    const selected: SelectedSkill[] = picked.map((k) => {
      const { rendered, truncated } = renderSkill(k.skill, this.maxCharsPerSkill);
      return { ...k, rendered, truncated };
    });

    const block = renderBlock(selected);

    return {
      selected,
      rejected,
      block,
      resolutions: resolved.resolutions,
      sameScopeConflicts: resolved.sameScopeConflicts,
      // ⚠ `considered` 是**过滤后参与打分的候选数**，不是库行总数。
      //   报库行总数会让人误以为"有 N 个技能参与了竞争"，
      //   而其中可能有已被下架（DEPRECATED）或类型不符的。
      considered: candidates.length,
    };
  }

  /**
   * 给单个技能打分。
   *
   * ⚠ 打分维度必须与 §25 的检索输入对应（sceneType / genre / emotion），
   *   否则"检索"名不副实 —— 那只是按置信度取前几个。
   */
  private score(
    skill: Skill,
    ctx: SceneContext,
  ): { skill: Skill; score: number; fnMatch: boolean; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;

    // ── 场景功能匹配（主信号）──
    const wantFn = (ctx.sceneFunction ?? '').trim();
    const types = skill.trigger.sceneTypes;
    const fnMatch = wantFn === '' || types.length === 0 || types.includes(wantFn as never);
    if (wantFn && types.includes(wantFn as never)) {
      score += 1.0;
      reasons.push(`场景功能匹配（${wantFn}）`);
    } else if (types.length === 0) {
      // 技能不限定场景功能 → 通用，给较小权重
      score += 0.3;
      reasons.push('技能不限定场景功能');
    }

    // ── 类型匹配（GENRE 技能命中同类型）──
    if (skill.scope === 'GENRE' && sameGenre(skill.genre, ctx.genre ?? null)) {
      score += 0.4;
      reasons.push(`类型匹配（${normalizeGenre(skill.genre)}）`);
    } else if (skill.scope === 'UNIVERSAL') {
      score += 0.2;
      reasons.push('跨类型通用');
    } else if (skill.scope === 'STYLE') {
      // STYLE 已通过可见性过滤（有明确使用理由），这里给较小权重：
      // 它是"某部作品的偏好"，说服力弱于跨作品验证过的 GENRE。
      score += 0.1;
      reasons.push('作者风格（已指定来源/风格类型）');
    }

    // ── 情感强度（§25 的 Emotion 维度）──
    const minEmo = skill.trigger.minEmotionIntensity;
    // ⚠ 同时排除 null 与 undefined（两者都表示"没有该维度信息"）
    if (minEmo !== undefined && ctx.emotionIntensity !== null && ctx.emotionIntensity !== undefined) {
      if (ctx.emotionIntensity >= minEmo) {
        score += 0.3;
        reasons.push(`情感强度满足（${ctx.emotionIntensity} ≥ ${minEmo}）`);
      } else {
        // ⚠ 不满足情感强度要求 → 扣分而非直接排除。
        //   情感强度是估算值（来自 Plan 的自由文本），不该一票否决。
        score -= 0.5;
        reasons.push(`情感强度不足（${ctx.emotionIntensity} < ${minEmo}）`);
      }
    }

    // ── 置信度作为**次级**信号（权重刻意小）──
    score += skill.confidence * 0.3;

    return { skill, score, fnMatch, reasons };
  }
}

/**
 * 把库行解析成完整 Skill。
 *
 * ⚠ 解析失败返回 null（由调用方如实记录），不抛异常 ——
 *   一条坏行不该让整个场景的检索失败。
 */
export function parseSkillRow(row: SkillRow): Skill | null {
  const parsed = SkillSchema.safeParse({
    id: row.id,
    name: row.name,
    category: row.category,
    summary: row.summary,
    trigger: safeParse(row.trigger_json) ?? {},
    rules: safeParse(row.rules_json) ?? [],
    antiPatterns: safeParse(row.anti_patterns_json) ?? [],
    examples: safeParse(row.examples_json) ?? [],
    evidenceRefs: safeParse(row.evidence_refs_json) ?? [],
    confidence: row.confidence,
    version: row.version,
    status: row.status,
    scope: row.scope,
    genre: row.genre,
    sourceDocumentIds: safeParse(row.source_document_ids_json) ?? [],
  });
  return parsed.success ? parsed.data : null;
}

/** 技能的可比较文本（近重复抑制用，与编译期同判据） */
function skillText(skill: Skill): string {
  return [skill.summary, ...skill.rules.map((r) => r.rule), ...skill.antiPatterns].join('');
}

/** 渲染单个技能为注入文本 */
export function renderSkill(skill: Skill, maxChars: number): { rendered: string; truncated: boolean } {
  const lines: string[] = [`【${skill.name}】${skill.summary}`];

  // 规则：优先给全；超预算时保留前面的（规则列表已按重要性排序）
  const ruleLines: string[] = [];
  for (const r of skill.rules) {
    const why = r.rationale ? `（因为：${r.rationale}）` : '';
    ruleLines.push(`- ${r.rule}${why}`);
  }
  lines.push('做法：', ...ruleLines);

  // ⚠ 反模式**必须完整保留**，不参与截断。
  //   它是防滥用的部分（§24）—— 截掉反模式等于只给"该怎么做"
  //   而不给"什么时候不该用"，那正是最容易写出问题的用法。
  lines.push('⚠ 不适用的情况：', ...skill.antiPatterns.map((a) => `- ${a}`));

  const antiChars = lines.slice(-(skill.antiPatterns.length + 1)).join('\n').length;
  let out = lines.join('\n');
  let truncated = false;

  if (out.length > maxChars) {
    // 截断规则部分（保留反模式）
    const budget = Math.max(120, maxChars - antiChars - 40);
    const head = lines.slice(0, lines.length - skill.antiPatterns.length - 1);
    let acc = '';
    for (const l of head) {
      if (acc.length + l.length + 1 > budget) break;
      acc += (acc ? '\n' : '') + l;
    }
    out = [
      acc,
      `（规则较多，此处只列前若干条 —— 完整版共 ${skill.rules.length} 条）`,
      '⚠ 不适用的情况：',
      ...skill.antiPatterns.map((a) => `- ${a}`),
    ].join('\n');
    truncated = true;
  }

  return { rendered: out, truncated };
}

/** 渲染整个注入块 */
function renderBlock(selected: readonly SelectedSkill[]): string {
  if (selected.length === 0) return '';
  return [
    '【本章可用的写作技能（策略建议，不是必须逐条执行）】',
    '下面每一条都来自对真实作品的跨作品分析。**只在它适用时使用**，',
    '尤其注意每条末尾的「不适用的情况」—— 用错场合比不用更糟。',
    '',
    ...selected.map((s) => s.rendered),
  ].join('\n');
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function safeParse(s: string | null | undefined): unknown {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

void (null as unknown as SkillTrigger);
