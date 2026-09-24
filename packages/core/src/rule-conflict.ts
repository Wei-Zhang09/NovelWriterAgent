/**
 * 规则冲突判据（P0-6 从 `writing/skills/conflict-resolver.ts` 上提到 core）。
 *
 * ## ⚠ 为什么必须上提，而不是在 distillation 里再写一份
 *
 * P0-6 要求模式记录 `counter_evidence`（反证：有没有别的作品用的是
 * 相反写法）。判断"相反写法"用的正是这套判据。
 *
 * 但依赖方向不允许：`distillation` 不能依赖 `writing`
 * （`scripts/check-boundaries.mjs` 的 R4/R5），而 `writing` 已经在用这套判据。
 * 若在 distillation 里复制一份，两处阈值会各自漂移 ——
 * 编译期认为 A、B 两条模式冲突并记了反证，运行时却认为它们不冲突、
 * 两条都注入给 Writer。**同一判据出现两份，就是等着其中一份被调参。**
 *
 * 因此按"共享判据放一处、放在双方都够得到的最低层"的原则，
 * 上提到零依赖的 `core`。`writing` 与 `distillation` 都从这里 import。
 *
 * ## 判据本身（实测校准，勿凭直觉改）
 *
 * **有界话题词表 + 极性配对 + 互斥属性对**，实测 9/9 判对（含 4 个易误判负例）。
 *
 * ⚠ **不能用文本相似度**：实测真冲突的一对相似度 0.077，
 *   而互补的一对是 0.071 —— 区分不开。相似度只能证明"措辞像"，
 *   而冲突需要的是"谈的是同一件事，却给出相反指示"。
 *
 * 局限如实说明：话题词表是**有界的**，话题落在词表外的冲突检测不到。
 * 这是刻意取舍 —— 宁可漏判（两边都保留，使用者看到矛盾仍可自行取舍），
 * 也不误判（把互补规则删掉，永久丢失一个手法）。
 */

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

/** 话题词表 —— **必须是有界的**（理由见文件头注释） */
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

/**
 * 两条规则文本是否构成**明确冲突**；返回冲突说明，不冲突返回 null。
 *
 * ⚠ 返回的是**说明**而不是布尔值：调用方要把这个说明写进
 *   `counter_evidence` 与冲突解决记录里，回答"为什么这两条算冲突"。
 */
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
