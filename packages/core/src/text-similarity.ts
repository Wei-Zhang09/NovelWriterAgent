/**
 * 文本相似度工具（零依赖基础层）
 *
 * ## 为什么放在 core
 *
 * 两处需要它，且必须在**不同层**：
 *   - `distillation` 的技能编译：跨运行去重（落库前）
 *   - `writing` 的 Skill Engine：运行时去重（注入前）
 *
 * 若各自实现一份，两条去重路径的阈值与判据会漂移 ——
 * 而它们**本该一致**：编译时判为重复的两条，运行时也不该同时注入。
 *
 * `core` 是零依赖基础层，两处都能引。
 *
 * ## 判据：字符二元组 Jaccard
 *
 * 对中文无需分词，且对**改写**稳健 —— 这正是"同一手法的不同命名"
 * 的形态（模型会用不同措辞重述同一件事）。
 */

/**
 * 字符二元组 Jaccard 相似度。
 *
 * @returns 0~1；两侧任一为空时返回 0
 */
export function jaccardBigrams(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 提取字符二元组。
 *
 * ⚠ 先剔除标点与空白：它们不承载语义，却会稀释相似度 ——
 *   同一手法的两种表述，差别常常只在标点与断句上。
 */
function bigrams(s: string): Set<string> {
  const t = s.replace(/[\s，。；：、（）"'‘’“”《》【】…—\-]/g, '');
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * 从一组条目里剔除近重复项（保留先出现的）。
 *
 * ⚠ "先出现的"由调用方通过**排序**决定 —— 本函数不猜重要性。
 *   调用方应先按优先级排好序（如得分降序），再交给它去重。
 *
 * @param items 已按优先级排序的条目
 * @param textOf 取条目的可比较文本
 * @param threshold 相似度阈值（0~1）
 */
export function dedupeBySimilarity<T>(
  items: readonly T[],
  textOf: (item: T) => string,
  threshold: number,
): { readonly kept: readonly T[]; readonly dropped: readonly { readonly item: T; readonly similarTo: T; readonly similarity: number }[] } {
  const kept: T[] = [];
  const keptTexts: string[] = [];
  const dropped: { item: T; similarTo: T; similarity: number }[] = [];

  for (const item of items) {
    const t = textOf(item);
    let dup: { similarTo: T; similarity: number } | null = null;
    for (let i = 0; i < kept.length; i++) {
      const sim = jaccardBigrams(t, keptTexts[i]!);
      if (sim >= threshold) {
        dup = { similarTo: kept[i]!, similarity: Math.round(sim * 100) / 100 };
        break;
      }
    }
    if (dup) {
      dropped.push({ item, ...dup });
      continue;
    }
    kept.push(item);
    keptTexts.push(t);
  }

  return { kept, dropped };
}
