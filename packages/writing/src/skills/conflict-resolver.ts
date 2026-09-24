/**
 * Skill 冲突解决（Scope Precedence）—— v1.0 正式决策。
 *
 * ## 定位
 *
 * ```
 * Skill Compiler
 *       ↓
 * ┌───────────────┐
 * │ UNIVERSAL     │   三个 Scope 独立存在
 * │ GENRE         │   独立编译 / 独立召回 / 独立评分
 * │ STYLE         │   可同时进入 Writer Context
 * └───────────────┘
 *       ↓
 * Skill Retrieval → 独立评分 → Context Assembly
 *       ↓
 * Conflict Resolution          ← 本文件
 *       ↓
 * Writer
 * ```
 *
 * ## ⚠ Scope Precedence 不是 Scope 升级机制
 *
 * `STYLE > GENRE > UNIVERSAL` 是**运行时的冲突解决优先级**，
 * 意思是"当两条规则真正互相矛盾时，更具体的证据范围更可信"。
 *
 * 它**不是**让 Skill 变成更高 Scope 的手段。因此本文件：
 * - 不改任何 Skill 的 `scope` 字段（三个 Skill 仍是三个 Skill）
 * - 不做 `STYLE + GENRE → GENRE` 这类融合
 * - 不重新引入"取最宽"
 *
 * ## ⚠ 无冲突时三者全部保留
 *
 * 这是本设计最重要的一条：优先级只在**冲突时**才起作用。
 * UNIVERSAL 给基础写法、GENRE 给类型专项、STYLE 给本作品偏好 ——
 * 三者互补是常态，只有真正矛盾才需要取舍。
 *
 * 实测（`resolveSkillConflicts` 的判据）：
 * ```
 * 避免直接解释人物情绪      (UNIVERSAL)
 * 悬疑高潮可以短暂直接揭示情绪 (GENRE)      → 冲突（同一话题「情绪」+ 极性相反）
 * 本作品在高潮段落允许直接使用一句情绪表达 (STYLE) → 与上两者同极性，不冲突
 * ```
 * 于是 UNIVERSAL 落败、GENRE 与 STYLE 并存 —— 符合"更具体者优先"，
 * 也符合"不冲突的规则不该被牵连删除"。
 *
 * ## v1.0 范围
 *
 * 只做三件事：保留无冲突技能 / 检测明确冲突 / 冲突时按 Scope 取舍并记录原因。
 *
 * **不做**（留给后续版本）：复杂规则推理、Skill inheritance、
 * Skill override tree、多层嵌套继承、动态 Skill mutation、复杂 priority graph。
 */

import type { Skill } from '@nwa/shared';

/** Scope 优先级（数值越大越具体） */
export const SCOPE_RANK: Readonly<Record<string, number>> = {
  STYLE: 3,
  GENRE: 2,
  UNIVERSAL: 1,
};

/** 取 scope 的优先级；未知 scope 按 UNIVERSAL 处理（最宽 = 最不优先） */
function rankOf(scope: string | null | undefined): number {
  return SCOPE_RANK[(scope ?? '').toUpperCase()] ?? 1;
}

// ── 冲突判据 ──────────────────────────────────────────────

/**
 * 否定极性词 —— 出现即表示"不要这么做"。
 *
 * ⚠ 与肯定词**同时出现**时极性归零（见 `polarityOf`）：
 * 中文写作规则常写"不要直接解释情绪，而要用行为暗示"，
 * 句里同时有"不要"和"要"，此时按极性相反去配对会把
 * **同一技能内部的两条互补规则**误判成冲突。
 */
const NEGATIVE = [
  '不要', '避免', '禁止', '不得', '严禁', '不应', '不能', '不必',
  '无需', '少用', '减少', '克制', '不要用',
];

/** 肯定极性词 —— 出现即表示"可以/应该这么做" */
const POSITIVE = [
  '可以', '允许', '应当', '应该', '必须', '需要', '多用', '增加',
  '适度', '短暂', '保持', '要',
];

/**
 * 话题词表 —— **必须是有界的**。
 *
 * ⚠ 为什么不用 bigram 重叠当"共同话题"：实测同一组规则里，
 *   互补的两条（"用行为暗示情绪" / "避免直接说明情绪"）bigram
 *   相似度 0.071，而**真正冲突**的一对（用户给的例子）也只有 0.077
 *   —— 两者区分不开。bigram 只能证明"措辞像"，
 *   而冲突需要的是"谈的是同一件事，却给出相反指示"。
 *   所以用有界话题词表 + 极性配对，实测 9/9 判对（含 4 个易误判的负例）。
 *
 * 局限如实说明：词表是**有界的**，话题落在词表之外的冲突检测不到。
 * 这是刻意的取舍 —— 宁可漏判（三条规则都保留，Writer 看到矛盾时
 * 仍可自行取舍），也不误判（把互补规则删掉，永久丢失一个手法）。
 */
const TOPIC_WORDS = [
  '情绪', '情感', '对话', '节奏', '冲突', '张力', '描写', '环境',
  '伏笔', '视角', '信息', '场景', '心理', '动作', '悬念', '氛围',
  '语气', '留白', '细节', '解释', '说明', '揭示', '铺垫', '抒情',
];

/**
 * 互斥属性对 —— 同一属性维度上的相反取值。
 *
 * 这类冲突的极性词可能完全相同（"对话保持简短" vs "对话可以适当拉长"
 * 都含肯定词），所以极性判据抓不到，需要靠属性对。
 */
const OPPOSED_ATTRS: readonly (readonly [string, string])[] = [
  ['简短', '拉长'],
  ['精简', '铺陈'],
  ['含蓄', '直白'],
  ['直接', '间接'],
  ['快', '慢'],
  ['克制', '渲染'],
  ['留白', '铺陈'],
  ['略写', '详写'],
  ['冷', '热'],
];

function polarityOf(text: string): -1 | 0 | 1 {
  const neg = NEGATIVE.some((w) => text.includes(w));
  const pos = POSITIVE.some((w) => text.includes(w));
  if (neg && !pos) return -1;
  if (pos && !neg) return 1;
  return 0;
}

function topicsOf(text: string): string[] {
  return TOPIC_WORDS.filter((w) => text.includes(w));
}

/** 两条规则文本是否构成**明确冲突**；返回冲突说明，不冲突返回 null */
export function detectRuleConflict(a: string, b: string): string | null {
  const shared = topicsOf(a).filter((t) => topicsOf(b).includes(t));
  if (shared.length === 0) return null;

  const pa = polarityOf(a);
  const pb = polarityOf(b);
  if (pa !== 0 && pb !== 0 && pa !== pb) {
    return `同一话题「${shared.join('、')}」上极性相反（${pa < 0 ? '否定' : '肯定'} vs ${pb < 0 ? '否定' : '肯定'}）`;
  }

  for (const [x, y] of OPPOSED_ATTRS) {
    if ((a.includes(x) && b.includes(y)) || (a.includes(y) && b.includes(x))) {
      return `同一话题「${shared.join('、')}」上属性互斥（${x} / ${y}）`;
    }
  }
  return null;
}

// ── 接口 ──────────────────────────────────────────────────

/** 输入：一条被选中的技能（与 `SelectedSkill` 结构兼容） */
export interface ResolvableSkill {
  readonly skill: Skill;
}

/** 一条冲突解决记录（可读，用于日志/诊断/回答"为什么这个技能没进去"） */
export interface ConflictResolution {
  /** 胜出技能 id */
  readonly winner: string;
  /** 落败技能 id */
  readonly loser: string;
  readonly winnerScope: string;
  readonly loserScope: string;
  /** 人类可读的解决原因 */
  readonly reason: string;
  /** 触发冲突的胜方规则原文 */
  readonly winnerRule: string;
  /** 触发冲突的败方规则原文 */
  readonly loserRule: string;
}

/** 同 Scope 冲突 —— **不由 Scope 解决**，交由既有评分机制处理 */
export interface SameScopeConflict {
  readonly a: string;
  readonly b: string;
  readonly scope: string;
  readonly reason: string;
}

export interface ResolvedSkillSet<T extends ResolvableSkill = ResolvableSkill> {
  /** 存活技能（保持输入顺序） */
  readonly kept: readonly T[];
  /** 被冲突解决淘汰的技能及原因（**不静默丢弃**） */
  readonly dropped: readonly { readonly item: T; readonly reason: string }[];
  /** 冲突解决记录 */
  readonly resolutions: readonly ConflictResolution[];
  /**
   * 同 Scope 冲突记录。
   *
   * ⚠ 这些**没有被删除** —— 同 Scope 之间 Scope 本身不提供判据，
   *   只能靠已有的 confidence / support / specificity / relevance 评分
   *   决定谁排前面（Top-N 会自然淘汰靠后的）。
   *   这里记录是为了让"两条同类技能给出相反指示"可被观测。
   */
  readonly sameScopeConflicts: readonly SameScopeConflict[];
}

// ── 实现 ──────────────────────────────────────────────────

/** 一条技能参与冲突比较的全部规则文本（rules + antiPatterns） */
function ruleTextsOf(skill: Skill): string[] {
  const out: string[] = [];
  for (const r of skill.rules ?? []) out.push(r.rule);
  for (const a of skill.antiPatterns ?? []) out.push(a);
  return out;
}

/**
 * 解决技能之间的规则冲突。
 *
 * 算法：按 Scope 优先级**从具体到宽泛**依次考察，某条技能若与
 * **已存活的、更具体**的技能存在明确冲突，则被淘汰。
 *
 * ⚠ 只比较"已存活且更具体"的技能，不比较"已被淘汰的技能"。
 *   因此 `STYLE 与 GENRE 冲突` + `GENRE 与 UNIVERSAL 冲突` 而
 *   `STYLE 与 UNIVERSAL 不冲突` 时，结果是 STYLE + UNIVERSAL 存活 ——
 *   UNIVERSAL 并没有和任何**存活**的更具体规则矛盾，
 *   牵连删除它会丢失一条本可用的基础写法。
 *
 * 该算法天然传递（STYLE > GENRE > UNIVERSAL），无需 priority graph。
 */
export function resolveSkillConflicts<T extends ResolvableSkill>(
  selected: readonly T[],
): ResolvedSkillSet<T> {
  // 稳定排序：优先级降序，同优先级保持原顺序（原顺序已是评分降序）
  const ordered = [...selected].sort(
    (a, b) => rankOf(b.skill.scope) - rankOf(a.skill.scope),
  );

  const kept: T[] = [];
  const dropped: { item: T; reason: string }[] = [];
  const resolutions: ConflictResolution[] = [];
  const sameScopeConflicts: SameScopeConflict[] = [];

  for (const item of ordered) {
    const myRank = rankOf(item.skill.scope);
    const myScope = (item.skill.scope ?? 'UNIVERSAL').toUpperCase();
    let lost = false;

    for (const other of kept) {
      const otherRank = rankOf(other.skill.scope);
      const otherScope = (other.skill.scope ?? 'UNIVERSAL').toUpperCase();

      // 找出第一条互相冲突的规则对
      let hit: { mine: string; theirs: string; why: string } | null = null;
      for (const mine of ruleTextsOf(item.skill)) {
        for (const theirs of ruleTextsOf(other.skill)) {
          const why = detectRuleConflict(mine, theirs);
          if (why) {
            hit = { mine, theirs, why };
            break;
          }
        }
        if (hit) break;
      }
      if (!hit) continue;

      if (myRank < otherRank) {
        // 更宽泛 → 落败
        lost = true;
        dropped.push({
          item,
          reason:
            `与更具体的 ${otherScope} 技能「${other.skill.name}」规则冲突（${hit.why}）` +
            `，按 Scope Precedence ${otherScope} > ${myScope} 淘汰`,
        });
        resolutions.push({
          winner: other.skill.id,
          loser: item.skill.id,
          winnerScope: otherScope,
          loserScope: myScope,
          reason: `${otherScope} scope overrides ${myScope} under direct rule conflict（${hit.why}）`,
          winnerRule: hit.theirs,
          loserRule: hit.mine,
        });
        break;
      }

      if (myRank === otherRank) {
        // ⚠ 同 Scope：Scope 本身不提供判据，交由既有评分机制
        sameScopeConflicts.push({
          a: other.skill.id,
          b: item.skill.id,
          scope: myScope,
          reason:
            `同为 ${myScope}，Scope 不解决冲突（${hit.why}）—— ` +
            `交由 confidence / support / specificity / relevance 评分决定排序`,
        });
      }
      // myRank > otherRank：更具体者胜。但 other 已在 kept 中，
      // 说明它先被放行 —— 不可能发生（ordered 已按 rank 降序）。
    }

    if (!lost) kept.push(item);
  }

  return { kept, dropped, resolutions, sameScopeConflicts };
}
