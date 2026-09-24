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
// ⚠ 判据本体在 core（见下方"冲突判据"段注释）；此处 import 而非本地定义
import { detectRuleConflict } from '@nwa/core';

// 转发导出：既有调用方（tests / writing 包内）继续从本模块取用
export { detectRuleConflict };

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
//
// ⚠ 判据本体（有界话题词表 + 极性配对 + 互斥属性对）已上提到 `@nwa/core`
//   的 `rule-conflict.ts`。原因：P0-6 的 `counter_evidence`（反证检测）
//   要用**同一套**判据，而 `distillation` 不能依赖 `writing`。
//   若在此处保留副本，两处阈值会各自漂移 —— 编译期认为两条模式冲突并记了反证，
//   运行时却认为不冲突、两条都注入给 Writer。**同一判据出现两份，
//   就是等着其中一份被调参。** 所以只保留 re-export，不再本地定义。

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
