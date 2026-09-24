/**
 * 世界观设定 → 上下文文本（P2-3）
 *
 * ## 为什么需要这个模块
 *
 * P2-3 的门禁与存储做完之后，设定**仍然没有进 prompt** ——
 * 那意味着"确认"这个动作只是让 Agent 不拦你，而不是让它按设定写。
 * 用户选的流程是「**作者先写设定 → Agent 按设定写**」，
 * 少了这一段，那条流程只完成了一半。
 *
 * 与 `character-block.ts` 是同一类接线（P2-2 补的角色注入）：
 * 底层能力齐备，但模型看不到。
 *
 * ## 关键判断：只注入 CONFIRMED，不注入 DRAFT
 *
 * 作者的标记本身就是语义：
 *   - `CONFIRMED` = 「这是我定稿的规矩，按它写」
 *   - `DRAFT`     = 「我还在改，先别当准」
 *
 * 把草稿当权威设定注入，会让模型按作者尚未想清楚的内容写正文 ——
 * 而作者改设定后还得回头改稿。这正是"确认"这一步要防的事。
 *
 * ⚠ 但**不能静默忽略**：调用方要能拿到"有多少条草稿没被采用"，
 *   在界面上如实告诉作者。否则作者会以为设定生效了（"我明明写了"），
 *   而实际没有 —— 沉默的不一致比报错更难查。
 *
 * ## 为什么不按章节筛选
 *
 * 角色是"谁出场"（按章不同），世界观是"世界怎么运转"（整本书不变量）。
 * 灵力不可再生这条规则在第 3 章和第 30 章同样成立，按章筛选没有意义。
 * 所以设定**整章全量注入**，只受预算上限约束。
 */
import type { WorldEntityRow } from '@nwa/storage';

export interface WorldBrief {
  readonly type: string;
  readonly name: string;
  readonly description: string;
  readonly status: 'DRAFT' | 'CONFIRMED';
}

/** 种类的可读名（渲染给模型看时用中文，比 WORLD_RULE 更省解释成本） */
const TYPE_LABELS: Record<string, string> = {
  WORLD_RULE: '世界规则',
  LOCATION: '地理',
  FACTION: '势力',
  ITEM: '器物',
  CONCEPT: '概念',
  CUSTOM: '其他',
};

export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

/**
 * 渲染世界观设定块。
 *
 * ⚠ 只渲染传入的条目；筛选（CONFIRMED）由 `selectWorldSettings` 负责，
 *   本函数保持"给什么渲染什么"的简单语义，便于单测穷举。
 */
export function renderWorldBlock(entries: readonly WorldBrief[]): string {
  if (entries.length === 0) return '';

  const lines: string[] = ['## 世界观设定（作者已确认，必须遵守）'];
  for (const e of entries) {
    const label = typeLabel(e.type);
    const desc = e.description.trim();
    lines.push(desc.length > 0 ? `- [${label}] ${e.name}：${desc}` : `- [${label}] ${e.name}`);
  }

  // ⚠ 边界声明：设定是"世界的规矩"，不是"本章已发生的事"。
  //   不加这句，模型容易把设定里的背景写成刚刚发生的剧情。
  lines.push('');
  lines.push(
    '（以上是设定，不是本章已发生的情节；' +
      '正文不得违反这些规则，也不得编造设定里没有的设定。）',
  );
  return lines.join('\n');
}

export interface WorldSelection {
  /** 要注入的设定块（无内容时为空串） */
  readonly block: string;
  /** 被采用（已确认）的条数 */
  readonly usedCount: number;
  /**
   * 被跳过的草稿条数。
   *
   * ⚠ 调用方**必须**把它呈现给作者（界面提示或日志）：
   *   作者写了设定却看到它没生效，必须能知道原因，
   *   而不是猜"是不是没保存成功"。
   */
  readonly skippedDrafts: number;
}

/**
 * 挑出可注入的世界观设定：只取 CONFIRMED。
 *
 * @param cap 最多注入几条（防上下文预算被大量设定挤爆）
 */
export function selectWorldSettings(
  all: readonly WorldBrief[],
  cap = 60,
): WorldSelection {
  const confirmed = all.filter((e) => e.status === 'CONFIRMED');
  const used = confirmed.slice(0, cap);
  return {
    block: renderWorldBlock(used),
    usedCount: used.length,
    skippedDrafts: all.length - confirmed.length,
  };
}

/**
 * 从数据库行构造 brief。
 *
 * ⚠ 状态归一：数据库里任何非 'CONFIRMED' 的值都按 DRAFT 处理。
 *   宁可少注入，也不要把一个状态不明的条目当权威设定喂给模型。
 */
export function toWorldBrief(row: WorldEntityRow): WorldBrief {
  return {
    type: row.type,
    name: row.name,
    description: row.description ?? '',
    status: row.status === 'CONFIRMED' ? 'CONFIRMED' : 'DRAFT',
  };
}
