/**
 * 核心设定物化（开书向导 Phase 2 的落库）
 *
 * ## 用户决策：冲突逐条让作者选
 *
 * > 选定：「**先弹窗逐条让我选**（保留旧的 / 用新的 / 两个都留）」
 *
 * 本模块执行作者的**决定**，不做决定。
 *
 * ## ⚠⚠ 为什么必须在这里**重新**检出冲突
 *
 * `detectSettingsConflicts()` 在生成时算过一次，界面据此弹窗。
 * 但作者可能在弹窗上停留几分钟 —— 期间他若在别处手改了角色表，
 * 生成时那份冲突列表就已经过期。按过期列表物化会：
 *   - 「保留旧的」→ 用新内容覆盖作者刚写的东西（丢数据）
 *   - 「用新的」→ 覆盖掉的其实是作者刚改的版本（丢数据）
 *
 * 所以物化前**必须重读正式表并重新比对**，且：
 *   - 作者的决定里点名的条目，若现在已不存在 → **不创建**，如实报"已消失"
 *     （说明作者自己删了，再创建等于把他的删除撤销掉）
 *   - 出现**新的**冲突（作者在停留期间新建了同名角色）→ **不静默处理**，
 *     报为 `newConflict`，由界面再次询问
 *
 * ## 为什么不走 Agent 工具
 *
 * `character.create` / `world.create` 是给 Agent 用的（带权限与审计）。
 * 这里是**作者确认后**的系统行为，直接走仓储更直白，
 * 且避免"工具层权限检查把作者自己的操作挡住"这种荒谬情形。
 * 但两者写的是**同一张表**，所以注入 prompt 的路径天然一致。
 */
import { AppError, ErrorCode, characterId, worldEntityId } from '@nwa/core';
import type { SettingsOutput, CharacterProposal, WorldProposal } from '@nwa/shared';
import type { Repositories } from '@nwa/storage';

/** 作者对单条冲突的决定 */
export type ConflictDecision =
  /** 保留作者已写的，丢弃 AI 提议 */
  | 'keep_existing'
  /** 用 AI 的覆盖已有的 */
  | 'use_new'
  /** 两个都留 —— AI 的会改名（加后缀）后新建 */
  | 'keep_both';

export interface MaterializeInput {
  readonly bookId: string;
  /** AI 的完整产出 */
  readonly output: SettingsOutput;
  /**
   * 作者逐条的决定。键 = 归一化后的名字。
   *
   * ⚠ 缺项按 `keep_existing` 处理（**保守方向**）：
   *   缺项意味着界面没问过这一条。此时覆盖作者的内容是不可逆的损失，
   *   而跳过只是少写一条 —— 后者的代价小得多，且作者能看出来并补上。
   */
  readonly decisions?: Readonly<Record<string, ConflictDecision>>;
  /**
   * ⚠ **生成时**检出过冲突的名字。
   *
   * 有这个入参才能区分两种"现在冲突但决定里没提"的情况：
   *   - 在 knownConflicts 里 → 界面**问过了**但决定缺失（异常，保守跳过）
   *   - 不在 → 作者在停留期间**新建**的同名项（新冲突，必须报回界面）
   * 缺了这个入参，两者会被混为一谈，新冲突被静默跳过 ——
   * 而作者以为自己刚建的角色会被 AI 参考。
   */
  readonly knownConflicts?: readonly string[];
}

export interface MaterializeResult {
  /** 实际写入的角色 */
  readonly charactersCreated: readonly string[];
  /** 实际写入的世界观设定 */
  readonly worldCreated: readonly string[];
  /** 因决定而跳过的（保留旧的） */
  readonly skipped: readonly string[];
  /** 因改名而都保留的 */
  readonly renamed: readonly { readonly from: string; readonly to: string }[];
  /**
   * ⚠ 作者决定里点名、但正式表里已不存在（作者自己删了）的条目。
   * 不创建 —— 那等于撤销作者的删除。
   */
  readonly vanished: readonly string[];
  /**
   * ⚠ 物化前新出现的冲突（作者停留期间新建了同名项）。
   * 不静默处理，交回界面再问一次。
   */
  readonly newConflicts: readonly string[];
}

/** 名字归一化：与 detectSettingsConflicts 同一口径 */
function norm(s: string): string {
  return s.replace(/\s+/g, '').trim();
}

/**
 * 把 AI 提议物化进 characters / world_entities。
 *
 * 一切写入都发生在**同一本书**内（bookId 显式传入），
 * 不做任何"当前书"的隐式推断 —— 那是 P0-4 记录过的缺陷类。
 */
export function materializeSettings(
  repos: Repositories,
  input: MaterializeInput,
): MaterializeResult {
  const { bookId, output } = input;
  const decisions = input.decisions ?? {};
  const known = new Set((input.knownConflicts ?? []).map(norm));

  // ── 重读正式表（不信生成时算出的冲突列表）──
  const existingChars = new Map(
    repos.characters.listByBook(bookId).map((c) => [norm(c.name), c]),
  );
  const existingWorld = new Map(
    repos.world.listByBook(bookId).map((w) => [norm(w.name), w]),
  );

  const charactersCreated: string[] = [];
  const worldCreated: string[] = [];
  const skipped: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  const vanished: string[] = [];
  const newConflicts: string[] = [];

  for (const p of output.characters) {
    const key = norm(p.name);
    const hit = existingChars.get(key);
    const d = decisions[key];

    if (known.has(key)) {
      // 生成时就是冲突 —— 界面问过，作者做过决定
      if (d === undefined) {
        // 界面漏问（异常）。保守跳过：覆盖作者内容是不可逆损失。
        skipped.push(p.name);
        continue;
      }
      if (!hit) {
        // ⚠ 作者把旧的删了。**不创建** —— 那等于撤销他的删除。
        vanished.push(p.name);
        continue;
      }
      if (d === 'keep_existing') {
        skipped.push(p.name);
      } else if (d === 'use_new') {
        repos.characters.update(hit.id, {
          aliases: p.aliases.length > 0 ? p.aliases : undefined,
          role: p.role ?? undefined,
          profile: p.profile,
        });
        charactersCreated.push(p.name);
      } else {
        const to = uniqueName(p.name, existingChars);
        createCharacter(repos, bookId, p, to);
        charactersCreated.push(to);
        renamed.push({ from: p.name, to });
      }
      continue;
    }

    // 生成时不是冲突
    if (!hit) {
      createCharacter(repos, bookId, p, p.name);
      charactersCreated.push(p.name);
      continue;
    }
    // ⚠ 现在冲突了 = 作者在停留期间新建了同名项。报回界面再问一次，
    //   不静默跳过（否则作者以为自己新建的角色被参考了）。
    newConflicts.push(p.name);
    skipped.push(p.name);
  }

  for (const w of output.worldEntities) {
    const key = norm(w.name);
    const hit = existingWorld.get(key);
    const d = decisions[key];

    if (known.has(key)) {
      if (d === undefined) {
        skipped.push(w.name);
        continue;
      }
      if (!hit) {
        vanished.push(w.name);
        continue;
      }
      if (d === 'keep_existing') {
        skipped.push(w.name);
      } else if (d === 'use_new') {
        repos.world.update(hit.id, { type: w.type, description: w.description });
        worldCreated.push(w.name);
      } else {
        const to = uniqueName(w.name, existingWorld);
        createWorld(repos, bookId, w, to);
        worldCreated.push(to);
        renamed.push({ from: w.name, to });
      }
      continue;
    }

    if (!hit) {
      createWorld(repos, bookId, w, w.name);
      worldCreated.push(w.name);
      continue;
    }
    newConflicts.push(w.name);
    skipped.push(w.name);
  }

  return {
    charactersCreated,
    worldCreated,
    skipped,
    renamed,
    vanished,
    newConflicts,
  };
}

function createCharacter(
  repos: Repositories,
  bookId: string,
  p: CharacterProposal,
  name: string,
): void {
  // ⚠ id 是随机 UUID（`characterId()` 无参数）。
  //
  //   "重复物化产生两个沈砚"这件事**不靠 id 防**，靠冲突检出防：
  //   第二次物化时沈砚已存在 → 被 `detectSettingsConflicts` 检出 →
  //   进 knownConflicts → 必须由作者决定，不会走这条新建路径。
  //
  //   ⚠ 但 characters 表**没有 UNIQUE(book_id, name) 约束** ——
  //   所以这条防线只在"必须调用 materializeSettings"这一层成立。
  //   若将来有人绕过本函数直接调仓储，重复仍会发生。
  repos.characters.create({
    id: characterId(),
    bookId,
    name,
    aliases: p.aliases.length > 0 ? p.aliases : undefined,
    role: p.role ?? undefined,
    profile: p.profile,
  });
}

function createWorld(
  repos: Repositories,
  bookId: string,
  w: WorldProposal,
  name: string,
): void {
  repos.world.create({
    id: worldEntityId(),
    bookId,
    type: w.type,
    name,
    description: w.description,
  });
}

/**
 * 为 `keep_both` 生成一个不冲突的名字。
 *
 * ⚠ 不用时间戳/随机数：那会让"沈砚（AI）"每次物化都不同，
 *   作者第二次走流程时会得到"沈砚（AI）"和"沈砚（AI）2"两个。
 *   顺序后缀（2、3…）是幂等的。
 */
function uniqueName(base: string, existing: ReadonlyMap<string, unknown>): string {
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}（AI${i}）`;
    if (!existing.has(norm(candidate))) return candidate;
  }
  throw new AppError(
    ErrorCode.TOOL_VALIDATION_ERROR,
    `无法为「${base}」生成不冲突的名字（已有过多同名变体）`,
  );
}
