/**
 * 开书向导门禁（前置设定流程）
 *
 * ## 用户诉求（2026-09-25 原话）
 *
 * > 「应该配置 ai 生成大纲角色等等相关功能，再由用户进行选择、修改，
 * >    最后确认一切前置信息后，再开始写作呀」
 *
 * 三段式：**AI 生成草案 → 用户挑选/编辑 → 确认** → 才开写。
 * 本模块判定第三步（确认）与第四步（能不能开写）。
 *
 * ## 与 settings-gate 的关系（不是替代，是分层）
 *
 * `settings-gate.ts` 判定的是**设定**这一件事（world_entities 的确认状态）。
 * 本模块判定的是**整个前置流程**（选题 / 设定 / 卷纲 / 细纲 四步）。
 *
 * 两者是**合取**关系，不是二选一：
 *   - settings-gate 保证「写了设定就得确认，别让草稿混进正文」
 *   - blueprint-gate 保证「确认过的那套前置信息没被改过」
 * 一个成立不能顶替另一个 —— 所以开写前的检查要**两个都过**。
 *
 * ## 用户决策：**不强制**
 *
 * > 「允许跳过：不想用 AI 就直接手写或直接开写，向导只是个可选的快捷方式」
 *
 * 所以本门禁**只在"用了向导却没确认完"时拦**，不在"没用向导"时拦。
 * 这与 settings-gate 的 `NO_SETTINGS → 放行` 是同一条原则：
 * 门禁约束的是**不一致**（生成了却不确认），不是"必须走这个流程"。
 *
 * ⚠ 这条必须靠**状态**判定，不能靠"有没有数据"判定：
 *   四步全 `NOT_STARTED` = 没打算用向导 → 放行；
 *   有任一步 `GENERATED`/`EDITED` 却未统一确认 → 拦（AI 草案可能混进正文）；
 *   统一确认过但内容又被改 → 拦（正文与前置可能已分叉）。
 *
 * ## 为什么是纯函数
 *
 * 同 settings-gate：只回答"该不该拦"，不读库、不抛错。
 * 调用方（IPC / workflow stage）自己决定怎么拦。
 * 这样语义能被单测穷举，而不是散落在各调用点里。
 */
import { createHash } from 'node:crypto';

/** 开书向导的四步（顺序即用户操作顺序） */
export const BLUEPRINT_STEPS = ['CONCEPT', 'SETTINGS', 'OUTLINE', 'DETAIL'] as const;
export type BlueprintStep = (typeof BLUEPRINT_STEPS)[number];

/** 每一步的状态 */
export const BLUEPRINT_STATUSES = ['NOT_STARTED', 'GENERATED', 'EDITED', 'CONFIRMED'] as const;
export type BlueprintStatus = (typeof BLUEPRINT_STATUSES)[number];

/** 给作者看的步骤名 */
export const BLUEPRINT_STEP_LABELS: Readonly<Record<BlueprintStep, string>> = {
  CONCEPT: '选题方向',
  SETTINGS: '核心设定与角色',
  OUTLINE: '卷级大纲',
  DETAIL: '逐章细纲',
};

/**
 * 参与指纹计算的单步快照。
 *
 * ⚠ 与 settings-gate 同一条理由：**只放内容，不放 id / 时间戳**。
 *   否则"改了一个错别字又改回来"会因为 updated_at 变化被判成"改过"，
 *   作者会失去对门禁的信任。
 *
 * ⚠ `content` 是**有效内容**（edited ?? draft），不是 draft。
 *   门禁要保证的是"用户确认的那份内容没变"——
 *   用户编辑正是他要确认的对象。
 */
export interface BlueprintStepSnapshot {
  readonly step: BlueprintStep;
  readonly status: BlueprintStatus;
  /** 有效内容的规范化文本（无内容时为 ''） */
  readonly content: string;
}

/**
 * 计算前置内容指纹。
 *
 * ⚠ 排序后哈希：步骤的存储顺序不该影响指纹。
 *   按 step 名排序（而非按内容），保证同一个步骤集合的顺序稳定。
 */
export function hashBlueprint(steps: readonly BlueprintStepSnapshot[]): string {
  const canonical = [...steps]
    .map((s) => [s.step, s.content].join('\u0001'))
    .sort()
    .join('\u0002');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

/**
 * 计算"统一确认之后"应有的指纹。
 *
 * ⚠ 与 settings-gate 的 `hashAfterConfirm` 同一个坑：
 *   确认这个动作本身会把 status 从 GENERATED/EDITED 改成 CONFIRMED。
 *   若 status 参与指纹，确认完就对不上，门禁永远拦自己。
 *
 *   本函数的做法更彻底：**指纹只由内容决定，不含 status** ——
 *   这样"状态变了但内容没变"永远不触发拦截，
 *   而"内容变了"永远触发。语义比"确认后状态"更直接。
 */
export function hashAfterBlueprintConfirm(steps: readonly BlueprintStepSnapshot[]): string {
  return hashBlueprint(steps);
}

export interface BlueprintGateInput {
  /** 门禁是否启用（可按书关闭，同 settings-gate） */
  readonly gateEnabled: boolean;
  /** 统一确认时记录的指纹（NULL = 从未统一确认） */
  readonly confirmedHash: string | null;
  /** 当前四步的指纹 */
  readonly currentHash: string;
  /** 各步状态 */
  readonly steps: readonly BlueprintStepSnapshot[];
}

export type BlueprintGateReason =
  /** 门禁已关闭 → 放行 */
  | 'GATE_DISABLED'
  /** 四步全部未开始 → 放行（用户决策：向导可选，不强制） */
  | 'NOT_USED'
  /** 统一确认过且内容未变 → 放行 */
  | 'CONFIRMED'
  /** 有步骤已生成/已编辑，但从未统一确认 → 拦 */
  | 'NEVER_CONFIRMED'
  /** 统一确认过，但前置内容又被改过 → 拦 */
  | 'CHANGED_SINCE_CONFIRM';

export interface BlueprintGateResult {
  /** true = 允许开写 */
  readonly allowed: boolean;
  readonly reason: BlueprintGateReason;
  /** 给作者看的一句话（allowed 时也应可读） */
  readonly message: string;
  /** 尚未完成的步骤（供界面显示"还差哪几步"） */
  readonly unfinished: readonly BlueprintStep[];
}

/**
 * 判定开书向导门禁。
 *
 * | 情形 | 结果 |
 * |---|---|
 * | 门禁关闭 | 放行 |
 * | 四步全部未开始（没用向导） | 放行 |
 * | 有步骤已生成/已编辑 + 已统一确认 + 指纹一致 | 放行 |
 * | 有步骤已生成/已编辑 + 从未统一确认 | **拦** |
 * | 统一确认过但内容改过 | **拦** |
 *
 * ⚠ 「四步全未开始 → 放行」是用户决策的直接落地（向导可选）。
 *   注意判据是**状态**而非"有没有数据"：若某步生成了又清空，
 *   状态仍是 GENERATED（内容为空），仍应拦 —— 因为作者表达过
 *   "我要用向导"，只是还没确认完。
 */
export function evaluateBlueprintGate(input: BlueprintGateInput): BlueprintGateResult {
  const unfinished = input.steps
    .filter((s) => s.status !== 'CONFIRMED')
    .map((s) => s.step);

  if (!input.gateEnabled) {
    return {
      allowed: true,
      reason: 'GATE_DISABLED',
      message: '开书向导门禁已关闭，未检查前置确认状态',
      unfinished,
    };
  }

  // 用户决策：向导只是可选快捷方式 —— 完全没用过就不该拦。
  const used = input.steps.some((s) => s.status !== 'NOT_STARTED');
  if (!used) {
    return {
      allowed: true,
      reason: 'NOT_USED',
      message: '未使用开书向导，直接开写（可在向导中生成前置内容后启用门禁）',
      unfinished,
    };
  }

  if (input.confirmedHash === null) {
    const names = unfinished.map((s) => BLUEPRINT_STEP_LABELS[s]).join('、');
    return {
      allowed: false,
      reason: 'NEVER_CONFIRMED',
      message:
        `开书向导已有生成内容但尚未统一确认（未完成：${names}）。` +
        '请先在向导中确认全部前置信息，Agent 才会按前置内容写作。',
      unfinished,
    };
  }

  if (input.confirmedHash !== input.currentHash) {
    return {
      allowed: false,
      reason: 'CHANGED_SINCE_CONFIRM',
      message:
        '前置内容在统一确认之后又被修改过，当前正文与前置可能已经分叉。' +
        '请重新确认前置信息后再继续。',
      unfinished,
    };
  }

  return {
    allowed: true,
    reason: 'CONFIRMED',
    message: '前置信息已统一确认，Agent 将按前置内容写作',
    unfinished,
  };
}
