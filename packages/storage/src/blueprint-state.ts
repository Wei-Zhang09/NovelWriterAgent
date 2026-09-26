/**
 * 开书向导门禁的状态装配（W6）
 *
 * ## 为什么单独一个文件
 *
 * 门禁判定需要三样东西：开关、确认指纹、当前指纹。
 * 其中**当前指纹**的算法必须与**确认时**的算法**完全一致** ——
 * 否则门禁自相矛盾（刚确认完就报"内容被改过"）。
 *
 * 本项目已经在这个坑上翻过一次车：`confirmBookSettings` 的注释记着
 * 「把 `hashAfterConfirm` 换成 `hashSettings`，20 条测试全部通过，
 *   门禁变成永远拦自己」。
 *
 * 所以这里把"装配"抽成**唯一实现**：门禁检查与统一确认**都**走
 * `blueprintStateOf()`，两者不可能分叉。
 *
 * ## ⚠ SETTINGS 步的内容必须来自正式表
 *
 * 角色与世界设定的权威副本是 `characters` / `world_entities` ——
 * 那才是 prompt 真正读到的东西（`renderCharacterBlock` / `renderWorldBlock`）。
 *
 * 若指纹用 `blueprint_steps.draft_json` 里的副本算，就会出现
 * **门禁说"已确认"，prompt 读到的却是别的内容** ——
 * 哈希的对象不是被消费的对象（W1 记录过的教训）。
 *
 * 所以这里现取正式表内容，按**与 prompt 相同的顺序**序列化。
 */
import type { Repositories } from './index.js';
import {
  hashBlueprint,
  evaluateBlueprintGate,
  type BlueprintGateResult,
  type BlueprintStepSnapshot,
} from '@nwa/core';

/**
 * 构造 SETTINGS 步的指纹内容 —— **从正式表现取**。
 *
 * ⚠ 顺序必须稳定（按 name 排序），否则同一份设定在不同查询顺序下
 *   算出不同指纹，门禁误判成"被改过"。
 *
 * ⚠ 只取**参与 prompt 的字段**：`characters` 取 name/role/profile，
 *   世界设定取 type/name/description/status。
 *   把 `created_at` 之类也塞进去会让"重新保存一次"变成"内容变了"。
 */
function settingsFingerprintContent(repos: Repositories, bookId: string): string {
  const characters = repos.characters
    .listByBook(bookId)
    .map((c) => ({
      name: c.name,
      role: c.role ?? '',
      aliases: c.aliases_json ?? '',
      profile: c.profile_json ?? '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const world = repos.world
    .listByBook(bookId)
    .map((w) => ({
      type: w.type,
      name: w.name,
      description: w.description ?? '',
      status: w.status,
    }))
    .sort((a, b) => (a.name + a.type).localeCompare(b.name + b.type));

  return JSON.stringify({ characters, world });
}

/**
 * 装配门禁输入并判定。
 *
 * ⚠ **统一确认与门禁检查必须都调这个函数**（或都用
 *   `snapshotWithSettings`），否则两者可能用不同的内容算法。
 */
export function blueprintStateOf(
  repos: Repositories,
  bookId: string,
): {
  readonly gateEnabled: boolean;
  readonly confirmedHash: string | null;
  readonly currentHash: string;
  readonly steps: readonly BlueprintStepSnapshot[];
} {
  const book = repos.books.get(bookId);
  const extraContent = { SETTINGS: settingsFingerprintContent(repos, bookId) };
  const steps = repos.blueprint.snapshot(bookId, extraContent);
  return {
    gateEnabled: book.blueprint_gate_enabled === 1,
    confirmedHash: repos.blueprint.confirmedHash(bookId),
    // ⚠ 当前指纹必须用 `hashBlueprint`（不含 status）——
    //   与 `confirmAll` 内部用的 `hashAfterBlueprintConfirm` 是同一个函数
    //   （后者就是前者的别名，见 blueprint-gate.ts 注释）。
    currentHash: hashBlueprint(steps),
    steps,
  };
}

/** 判定开书向导门禁（门禁检查的唯一入口） */
export function evaluateBookBlueprintGate(
  repos: Repositories,
  bookId: string,
): BlueprintGateResult {
  return evaluateBlueprintGate(blueprintStateOf(repos, bookId));
}

/**
 * 统一确认（用户说的「最后确认一切前置信息」）—— **唯一实现**。
 *
 * ⚠ 与 `confirmBookSettings` 同一个理由：这个序列此前若内联在 IPC 里，
 *   测试只能自己重写一遍，而那意味着"IPC 里写错了"测试照样绿。
 *   抽成唯一实现后，IPC 与测试走同一条路径。
 *
 * ⚠ 指纹必须**通过 `blueprintStateOf` 现算**，而不是复用某个缓存值 ——
 *   确认的那一刻就是"当前内容"该被固化的时刻。
 */
export function confirmBookBlueprint(
  repos: Repositories,
  bookId: string,
): { hash: string; steps: number } {
  const extraContent = { SETTINGS: settingsFingerprintContent(repos, bookId) };
  return repos.blueprint.confirmAll(bookId, extraContent);
}
