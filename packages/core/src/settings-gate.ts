/**
 * 设定确认门禁（P2-3）
 *
 * ## 问题
 *
 * 前置设定（世界观 / 角色）如果只是"写在那里"，Agent 无法区分
 * 「作者已定稿的设定」与「作者随手记的草稿」。混在一起有两个后果：
 *
 *   1. 草稿被当成权威设定写进正文，作者得回头改稿；
 *   2. 作者改了设定但没告诉 Agent，正文与设定悄悄分叉 ——
 *      这是连续性检查最难发现的一类（没有矛盾，只是"不是那个设定"）。
 *
 * 用户决策：「**作者先写设定 → Agent 按设定写**」（传统流程，可控但前期投入大）。
 * 本模块就是那个"先"的判定点。
 *
 * ## 关键设计：确认记录的是**内容指纹**，不是布尔量
 *
 * 只存 `confirmed = true` 的话，"确认后又改了设定"这个状态无法表达 ——
 * 除非在每个写设定的入口都记得把标记清掉。那是"靠流程纪律维持的一致性"，
 * 一旦新增一个入口就漏。
 *
 * 存指纹则是**读时判定**：任何入口改了设定，指纹自然对不上，
 * 不需要任何入口配合。同 `chapters.approveSummary()` 的预算 guard，
 * 这类"不依赖调用方守规矩"的设计在本项目里是硬要求。
 *
 * ## 判定与执行的分离
 *
 * `evaluateSettingsGate()` 是**纯函数**，只回答"该不该拦"，
 * 不读库、不抛错。调用方（IPC / workflow stage）自己决定怎么拦。
 * 这样门禁的语义能被单测穷举，而不是散落在各调用点里。
 */
import { createHash } from 'node:crypto';

/** 世界实体的状态：草稿 / 作者已定稿 */
export const WORLD_STATUSES = ['DRAFT', 'CONFIRMED'] as const;
export type WorldStatus = (typeof WORLD_STATUSES)[number];

/**
 * 参与指纹计算的设定快照。
 *
 * ⚠ 只放**内容**，不放 id / 时间戳 —— 否则"改了一个错别字又改回来"
 *   会因为 updated_at 变化而被判成"改过"，作者会失去对门禁的信任。
 */
export interface SettingsSnapshotEntry {
  /** 实体种类（如 WORLD_RULE / LOCATION / FACTION） */
  readonly type: string;
  readonly name: string;
  readonly description: string;
  /** 状态：DRAFT 也参与指纹（草稿改动了同样应影响判定） */
  readonly status: WorldStatus;
}

/**
 * 计算设定内容指纹。
 *
 * ⚠ 排序后再哈希：作者的编辑顺序不该影响指纹（改名排序、导入顺序不同
 *   都算"同一套设定"）。按 (type, name, description) 字典序排序。
 */
export function hashSettings(entries: readonly SettingsSnapshotEntry[]): string {
  const canonical = entries
    .map((e) => [e.type, e.name, e.description, e.status].join('\u0001'))
    .sort()
    .join('\u0002');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

/**
 * 计算"确认之后"应有的指纹。
 *
 * ⚠ 必须有这个函数，否则门禁自相矛盾：
 *   确认这个动作本身会把 status 从 DRAFT 改成 CONFIRMED，
 *   而 status 参与指纹计算 —— 于是"刚确认完指纹就对不上"，
 *   门禁永远拦着自己。
 *
 *   所以确认时存的是**确认后状态**的指纹。之后校验时用当前状态算指纹，
 *   两者相等 ⟺ 全部已确认 且 内容没被改过。
 */
export function hashAfterConfirm(entries: readonly SettingsSnapshotEntry[]): string {
  return hashSettings(entries.map((e) => ({ ...e, status: 'CONFIRMED' as const })));
}

export interface SettingsGateInput {
  /** 门禁是否启用（可按书关闭） */
  readonly gateEnabled: boolean;
  /** 确认时记录的指纹（NULL = 从未确认） */
  readonly confirmedHash: string | null;
  /** 当前设定的指纹 */
  readonly currentHash: string;
  /** 设定条目数（0 = 作者还没写设定） */
  readonly entryCount: number;
}

export type SettingsGateReason =
  /** 门禁已关闭 → 放行 */
  | 'GATE_DISABLED'
  /** 没有设定，也从未确认 → 放行（不能强迫作者先写设定才准写字） */
  | 'NO_SETTINGS'
  /** 有设定且指纹一致 → 放行 */
  | 'CONFIRMED'
  /** 有设定但从未确认 → 拦 */
  | 'NEVER_CONFIRMED'
  /** 确认过，但设定已被改动 → 拦 */
  | 'CHANGED_SINCE_CONFIRM';

export interface SettingsGateResult {
  /** true = 允许开写 */
  readonly allowed: boolean;
  readonly reason: SettingsGateReason;
  /** 给作者看的一句话（allowed 时也应可读） */
  readonly message: string;
}

/**
 * 判定设定门禁。
 *
 * 语义（用户决策：**硬门禁**，未确认设定 → 拒绝规划/写作）：
 *
 * | 情形 | 结果 |
 * |---|---|
 * | 门禁关闭 | 放行 |
 * | 没有设定 | 放行 |
 * | 有设定 + 已确认 + 指纹一致 | 放行 |
 * | 有设定 + 从未确认 | **拦** |
 * | 有设定 + 确认过但改动过 | **拦** |
 *
 * ⚠ 「没有设定 → 放行」是刻意的，不是遗漏：
 *   本项目允许"直接生成后由用户修改确认"的流程（用户 2026-09-25 提问
 *   里明确提到这条路径）。若无条件要求先写设定，那条路径就被堵死了。
 *   门禁约束的是「**写了**设定却不确认就开写」这种不一致，
 *   而不是"必须写设定"。
 */
export function evaluateSettingsGate(input: SettingsGateInput): SettingsGateResult {
  if (!input.gateEnabled) {
    return {
      allowed: true,
      reason: 'GATE_DISABLED',
      message: '设定门禁已关闭，未检查设定确认状态',
    };
  }
  if (input.entryCount === 0) {
    return {
      allowed: true,
      reason: 'NO_SETTINGS',
      message: '尚未登记任何设定，直接开写（可在设定面板登记后启用门禁）',
    };
  }
  if (input.confirmedHash === null) {
    return {
      allowed: false,
      reason: 'NEVER_CONFIRMED',
      message:
        `已登记 ${input.entryCount} 条设定但尚未确认。` +
        // ⚠ 必须指向**导航里真的能找到**的位置。
        //   原文案只说「世界观设定面板」，而那个面板**不是左栏导航项** ——
        //   它只在「开始/项目主页」的中心视图里渲染。作者照做时找不到它，
        //   只能卡死（2026-09-26 实测事故）。
        //   现在优先指向开书向导（那里有统一确认按钮，且会一并确认设定）。
        '请在「开书向导」页点「确认全部前置信息」，' +
        '或在「开始」页的「世界观设定」卡片里确认 —— 确认后 Agent 才会按设定写作。',
    };
  }
  if (input.confirmedHash !== input.currentHash) {
    return {
      allowed: false,
      reason: 'CHANGED_SINCE_CONFIRM',
      message:
        '设定在确认之后又被修改过，当前正文与设定可能已经分叉。' +
        // 同 NEVER_CONFIRMED：指向导航里真的能找到的位置
        '请到「开书向导」页重新点「确认全部前置信息」（或「开始」页的设定卡片）。',
    };
  }
  return {
    allowed: true,
    reason: 'CONFIRMED',
    message: `设定已确认（${input.entryCount} 条），Agent 将按设定写作`,
  };
}

/**
 * 判断某个世界实体是否算"已定稿"。
 *
 * ⚠ 门禁要求**全部**实体都已确认，不是"至少一条"。
 *   "部分确认"会让判定变成一个模糊地带：哪些算数？
 *   作者也无法预期。全确认是唯一能被作者正确预期的语义。
 */
export function allConfirmed(entries: readonly { status: WorldStatus }[]): boolean {
  return entries.length > 0 && entries.every((e) => e.status === 'CONFIRMED');
}
