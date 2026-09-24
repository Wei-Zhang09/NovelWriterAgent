/**
 * 角色卡 → 上下文文本（P2-2）
 *
 * ## 为什么需要这个模块
 *
 * 角色表与 `character.create/list/update` 三个工具**早就存在**，
 * 但全代码库没有任何地方把角色信息喂给模型：
 *   - Planner 的 `contextText` 被传了空串（`workflow-services.ts` 的 plan stage）
 *   - Writer 只吃 `plan.brief` + 结构化约束 + 技能块
 *   - Context Engine 的 `characterState` 槽位定义了，但**永远为空**
 *
 * 结果是：作者在设定里写了「沈砚是个修表匠，左手有旧伤」，
 * 模型完全不知道 —— 它只能靠"检索旧章节"间接猜到，猜不到就自己编。
 *
 * ## 为什么单独成模块
 *
 * 这段拼装必须**可测**。此前 `characterState` 槽之所以一直空着而没人发现，
 * 正是因为"填槽"这件事散在 IPC 层、没有单元测试覆盖。
 *
 * ⚠ 输出的**来源可追溯**：每条都带角色名，便于作者核对"模型看到的设定
 *   是不是我写的"。角色卡是作者手写的权威设定，不是模型推断出来的。
 */
import type { CharacterRow } from '@nwa/storage';

export interface CharacterBrief {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly role: string | null;
  readonly currentStatus: string | null;
  /** 自由档案（外貌/性格/背景），可能是任意 JSON */
  readonly profile: unknown;
}

/**
 * 把角色行转成可读的设定块。
 *
 * ⚠ 刻意**不注入全部角色**：一本长篇可能有上百个角色，全塞进去会
 *   挤爆上下文预算（正是 Context Engine 存在的理由）。
 *   这里只注入与本章相关的（由调用方筛选后传入）。
 */
export function renderCharacterBlock(chars: readonly CharacterBrief[]): string {
  if (chars.length === 0) return '';

  const lines: string[] = ['## 角色设定（作者手写的权威设定，必须遵守）'];
  for (const c of chars) {
    const bits: string[] = [c.name];
    if (c.aliases.length > 0) bits.push(`（又称 ${c.aliases.join('、')}）`);
    if (c.role) bits.push(`— ${c.role}`);
    let line = `- ${bits.join(' ')}`;

    const details: string[] = [];
    if (c.currentStatus) details.push(`现状：${c.currentStatus}`);
    const profileText = renderProfile(c.profile);
    if (profileText) details.push(profileText);
    if (details.length > 0) line += `。${details.join('；')}`;

    lines.push(line);
  }

  // ⚠ 明确边界：角色卡是设定，不是已经发生的情节。
  //   不加这句模型会把"设定里的背景"当成"本章已发生的事"写进正文。
  lines.push('');
  lines.push('（以上是设定，不是本章已发生的情节；不得编造设定里没有的人物属性。）');
  return lines.join('\n');
}

/** 把自由档案渲染成一行文本；无法理解的结构退回 JSON 摘要 */
function renderProfile(profile: unknown): string {
  if (profile === null || profile === undefined) return '';
  if (typeof profile === 'string') return profile.trim();
  if (typeof profile === 'number' || typeof profile === 'boolean') {
    return String(profile);
  }
  if (Array.isArray(profile)) {
    const items = profile.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
    return items.join('、');
  }
  if (typeof profile === 'object') {
    const entries = Object.entries(profile as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}：${typeof v === 'string' ? v : JSON.stringify(v)}`);
    return entries.join('；');
  }
  return '';
}

/**
 * 从角色行构造 brief（解析 JSON 列）。
 *
 * ⚠ JSON 列解析失败**不能中断写作** —— 那是一个角色的档案坏了，
 *   不该让整章写不出来。坏掉的字段按空处理，其余照常注入。
 */
export function toCharacterBrief(row: CharacterRow): CharacterBrief {
  return {
    name: row.name,
    aliases: safeArray(row.aliases_json),
    role: row.role,
    currentStatus: row.current_status,
    profile: safeJson(row.profile_json),
  };
}

function safeArray(json: string | null): string[] {
  if (!json) return [];
  const v = safeJson(json);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function safeJson(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * 挑出与本章相关的角色。
 *
 * 规则（按优先级）：
 *   1. 名字/别名出现在**提示文本**里（用户指令 / 上一章摘要）→ 相关
 *   2. **没有任何提示**（典型：第 1 章）→ 注入全部（受 cap 限制）
 *
 * ⚠ 规则 2 是必需的，不是偷懒：第 1 章没有上一章摘要，若"无提示就不注入"，
 *   那么作者刚写好的设定**恰恰在最需要它的那一章**被丢掉 ——
 *   而"作者先写设定 → Agent 按设定写"正是本项目的既定流程。
 *
 * ⚠ 刻意不做"按重要度排序取前 N"：那会注入作者没打算写进这一章的人，
 *   模型看到就会想办法让他们出场（"角色出现即要交代"）。
 *   这里的 cap 只是**上下文预算保护**，不是重要度排序。
 *
 * @param cap 最多注入几个角色（防上下文预算被上百个角色挤爆）
 */
export function selectRelevantCharacters(
  all: readonly CharacterBrief[],
  hints: readonly string[],
  cap = 20,
): CharacterBrief[] {
  if (all.length === 0) return [];
  const needles = hints
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  // 无提示（如第 1 章）：全部注入，仅受预算上限约束
  if (needles.length === 0) return all.slice(0, cap);

  return all
    .filter((c) =>
      needles.some((n) => {
        if (c.name.includes(n) || n.includes(c.name)) return true;
        return c.aliases.some((a) => a.includes(n) || n.includes(a));
      }),
    )
    .slice(0, cap);
}
