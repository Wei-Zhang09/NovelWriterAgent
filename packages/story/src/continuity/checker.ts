/**
 * Continuity Checker（施工文档 §7.6 / §13）
 *
 * 职责：把草稿与 Canon 对账，找出**矛盾**。十个维度（§7.6）：
 *   人物 / 地点 / 时间 / 战力 / 物品 / 关系 / 世界规则 / 事件先后 /
 *   死亡状态 / 伏笔状态
 *
 * ## 设计核心：只报"有出处"的问题
 *
 * 每条 issue 必须带 `sourceRef` —— 指向它依据的 Canon 事实或状态记录。
 * 没有出处的"感觉不对"不进结果（§11 的"无来源条目拒绝进入上下文"同理）。
 * 这条约束的效果是：报告里每条都能被人独立复核，而不是一堆模糊印象。
 *
 * ## 为什么必须按「章号」取状态，而不是取最新状态
 *
 * `character_states` 是**时间点**记录（appendState 带 chapterNumber）。
 * 若用 latestState 检查第 10 章的草稿，会把"第 20 章才瞎"的角色
 * 在第 10 章就判成"不该能看见" —— 制造出假矛盾。
 * 因此一律用 `stateAt(characterId, chapterNumber)`。
 *
 * ## 分工边界（沿 STEP 7 的划分）
 *
 * - Writer：写出文字，不管对错
 * - **Continuity Checker：判断对错，不改文字**
 * - Repair（后续步骤）：按 issue 改文字
 *
 * 本类不持有任何写工具，只读。
 */
import { Logger, type Nullable } from '@nwa/core';
import type { PlanOutput } from '@nwa/shared';
import type { Repositories } from '@nwa/storage';

/** 检查维度（§7.6 十项） */
export const CONTINUITY_DIMENSIONS = [
  'character',
  'location',
  'time',
  'power',
  'item',
  'relationship',
  'worldRule',
  'eventOrder',
  'deathStatus',
  'foreshadowing',
] as const;
export type ContinuityDimension = (typeof CONTINUITY_DIMENSIONS)[number];

/** 问题严重度 */
export type IssueSeverity = 'BLOCKING' | 'WARNING' | 'INFO';

export interface ContinuityIssue {
  readonly id: string;
  readonly dimension: ContinuityDimension;
  readonly severity: IssueSeverity;
  /** 稳定机器码，供测试与门禁断言 */
  readonly code: string;
  readonly message: string;
  /** ⚠ 必填：这条判断依据的 Canon 出处。无出处的判断不进结果 */
  readonly sourceRef: string;
  /** 草稿中涉及的位置（原文片段或场景 id），供人工定位 */
  readonly draftRef?: string;
  /** 相关实体的 id（角色/事实/伏笔），便于后续 Repair 精确定位 */
  readonly entityRefs?: readonly string[];
}

export interface ContinuityReport {
  readonly ok: boolean;
  readonly chapterNumber: number;
  readonly issues: readonly ContinuityIssue[];
  readonly blockingCount: number;
  readonly warningCount: number;
  /** 本次检查实际对账了多少条 Canon 记录（可断言，防"空跑也算通过"） */
  readonly checked: {
    readonly canonFacts: number;
    readonly characters: number;
    readonly scenes: number;
  };
}

export interface ContinuityCheckerOptions {
  readonly repos: Repositories;
  readonly logger: Logger;
  readonly bookId: string;
}

export class ContinuityChecker {
  private readonly repos: Repositories;
  private readonly logger: Logger;
  private readonly bookId: string;

  constructor(opts: ContinuityCheckerOptions) {
    this.repos = opts.repos;
    this.logger = opts.logger;
    this.bookId = opts.bookId;
  }

  /**
   * 对一章草稿做一致性检查。
   *
   * ⚠ 纯只读：不写库、不改稿。测试断言调用后章节状态与正文路径均未变。
   */
  check(input: {
    readonly chapterNumber: number;
    readonly draftText: string;
    readonly plan?: PlanOutput;
  }): ContinuityReport {
    const { chapterNumber, draftText, plan } = input;
    const issues: ContinuityIssue[] = [];

    const canonFacts = this.repos.facts.listByStatus(this.bookId, 'CANON');
    const characters = this.repos.characters.listByBook(this.bookId);

    issues.push(...this.checkDeathStatus(chapterNumber, draftText, characters));
    issues.push(...this.checkCharacterIdentity(chapterNumber, draftText, characters));
    issues.push(...this.checkCanonFacts(chapterNumber, draftText, canonFacts));
    issues.push(...this.checkScenePlanning(plan));
    issues.push(...this.checkForeshadowing(chapterNumber, draftText, plan));

    this.logger.info('一致性检查完成', {
      chapterNumber,
      issues: issues.length,
      blocking: issues.filter((i) => i.severity === 'BLOCKING').length,
    });

    return {
      ok: issues.every((i) => i.severity !== 'BLOCKING'),
      chapterNumber,
      issues,
      blockingCount: issues.filter((i) => i.severity === 'BLOCKING').length,
      warningCount: issues.filter((i) => i.severity === 'WARNING').length,
      checked: {
        canonFacts: canonFacts.length,
        characters: characters.length,
        scenes: plan?.scenes.length ?? 0,
      },
    };
  }

  /**
   * §7.6「死亡状态」—— 施工文档给出的经典案例：
   *   模型声称"张三又出现在第 31 章"，但 Canon 里 张三状态 == DEAD，
   *   且无复活事件 → BLOCKING_CONTINUITY_ERROR。
   */
  private checkDeathStatus(
    chapterNumber: number,
    draftText: string,
    characters: readonly { id: string; name: string }[],
  ): ContinuityIssue[] {
    const out: ContinuityIssue[] = [];

    for (const c of characters) {
      // ⚠ 取"该章时点"的状态，不是最新状态。
      //   若用 latestState 检查第 10 章草稿，会把"第 20 章才死"的角色
      //   在第 10 章就判成"已死却出场" —— 制造假矛盾。
      const status = this.statusAt(c.id, chapterNumber);
      if (status === null) continue;
      if (!isDeadStatus(status)) continue;
      // 名字在草稿中出现即视为出场
      if (!draftText.includes(c.name)) continue;

      out.push({
        id: `ci_dead_${c.id}_${chapterNumber}`,
        dimension: 'deathStatus',
        severity: 'BLOCKING',
        code: 'BLOCKING_CONTINUITY_ERROR',
        message:
          `角色「${c.name}」在第 ${chapterNumber} 章时点的状态为「${status}」，` +
          `却出现在正文中（若为复活剧情，需先写入复活事件再引用）`,
        sourceRef: `character_states:${c.id}@ch${chapterNumber}`,
        entityRefs: [c.id],
      });
    }
    return out;
  }

  /**
   * 读取某章时点的角色状态字符串。
   *
   * 状态存放在 `character_states.state_json`（不是一个 status 列），
   * 形状由写入方决定 —— 这里兼容几种常见键名（status / state / lifeState）。
   */
  private statusAt(characterId: string, chapterNumber: number): Nullable<string> {
    const row = this.repos.characters.stateAt(characterId, chapterNumber);
    if (!row) return null;
    try {
      const parsed = this.repos.characters.readState<Record<string, unknown>>(row);
      for (const key of ['status', 'state', 'lifeState', 'life_state']) {
        const v = parsed[key];
        if (typeof v === 'string' && v.length > 0) return v;
      }
      return null;
    } catch {
      // 状态损坏不应让整个检查崩掉 —— 跳过该角色
      this.logger.warn('角色状态 JSON 损坏，跳过', { characterId, chapterNumber });
      return null;
    }
  }

  /**
   * 人物身份／称谓一致性。
   *
   * 只做**确定性**检查：Canon 里登记的角色名若在草稿中被写成
   * 另一个已知角色名，或出现明显错字（同音不同字），才报问题。
   * 不做"语感判断" —— 那会产出大量无法复核的噪声。
   */
  private checkCharacterIdentity(
    chapterNumber: number,
    draftText: string,
    characters: readonly { id: string; name: string; aliases?: unknown }[],
  ): ContinuityIssue[] {
    const out: ContinuityIssue[] = [];
    for (const c of characters) {
      const aliases = Array.isArray(c.aliases) ? (c.aliases as string[]) : [];
      // 角色的所有合法称谓（正名 + 别名）都不出现 → 说明本章没写到它，跳过
      const allNames = [c.name, ...aliases];
      if (!allNames.some((n) => draftText.includes(n))) continue;

      // 正名与别名同时出现且正名被拆开使用，通常是称谓混乱（WARNING 级）
      if (aliases.length > 0 && draftText.includes(c.name)) {
        const foreign = characters.filter(
          (o) => o.id !== c.id && o.name.length === c.name.length && isNearMiss(o.name, c.name),
        );
        for (const f of foreign) {
          if (!draftText.includes(f.name)) continue;
          out.push({
            id: `ci_name_${c.id}_${f.id}_${chapterNumber}`,
            dimension: 'character',
            severity: 'WARNING',
            code: 'CHARACTER_NAME_SIMILARITY',
            message: `正文中「${c.name}」与「${f.name}」同时出现且字形相近，可能是称谓混用或错字`,
            sourceRef: `characters:${c.id}`,
            entityRefs: [c.id, f.id],
          });
        }
      }
    }
    return out;
  }

  /**
   * Canon 事实对账。
   *
   * 当前实现覆盖**可确定性判定**的一类：Canon 中标记为
   * `subject=角色, predicate=状态/位置/能力` 的事实，若正文声称相反则报问题。
   *
   * ⚠ 刻意不做全量语义比对：那需要模型判断，会产生无法复核的结论。
   *   需要模型参与的语义检查走 `semanticHints()`，作为提示交给人工/模型复核。
   */
  private checkCanonFacts(
    chapterNumber: number,
    draftText: string,
    // 用 FactRow 的真实字段（数据库列名，snake_case）
    canonFacts: readonly {
      readonly id: string;
      readonly subject_type: string;
      readonly subject_id: string | null;
      readonly predicate: string;
      readonly object_value: string;
      readonly evidence_id: string | null;
    }[],
  ): ContinuityIssue[] {
    const out: ContinuityIssue[] = [];
    for (const f of canonFacts) {
      // 只检查"能力/感官缺失"这类定义性事实 —— 它们一旦确立就不可随意推翻
      if (!isIncapacitatingPredicate(f.predicate)) continue;

      const subject = this.resolveSubjectName(f.subject_id);
      if (subject === null || !draftText.includes(subject)) continue;

      // 该能力被正文描写为正常使用 → 矛盾
      const capability = capabilityOf(f.object_value);
      if (capability === null) continue;
      if (!draftText.includes(capability)) continue;

      out.push({
        id: `ci_fact_${f.id}_${chapterNumber}`,
        dimension: 'character',
        severity: 'BLOCKING',
        code: 'BLOCKING_CONTINUITY_ERROR',
        message: `Canon 记载「${subject}」处于「${f.object_value}」状态，但正文中其「${capability}」表现正常`,
        sourceRef: `facts:${f.id}`,
        entityRefs: f.subject_id ? [f.subject_id] : [],
      });
    }
    return out;
  }

  private resolveSubjectName(subjectId: string | null): string | null {
    if (subjectId === null) return null;
    const c = this.repos.characters.listByBook(this.bookId).find((x) => x.id === subjectId);
    return c?.name ?? null;
  }

  /**
   * 场景计划的内部自洽（不需要 Canon）。
   *
   * 与 STEP 6 的 validatePlanSemantics 不同：这里检查的是
   * **计划与正文的关系** —— 计划说要到达某个 endState，
   * 草稿却不含任何相关内容，属于计划未落实。
   */
  private checkScenePlanning(plan: PlanOutput | undefined): ContinuityIssue[] {
    if (!plan) return [];
    const out: ContinuityIssue[] = [];
    // requiredEvents 是否在正文中体现，由语义判断；这里只做结构性检查
    const dup = new Set<string>();
    for (const s of plan.scenes) {
      if (dup.has(s.sceneId)) {
        out.push({
          id: `ci_scene_dup_${s.sceneId}`,
          dimension: 'eventOrder',
          severity: 'WARNING',
          code: 'SCENE_ID_DUPLICATE',
          message: `场景 id「${s.sceneId}」重复，正文分段可能错位`,
          sourceRef: `plan:${plan.brief.chapterNumber}`,
          entityRefs: [s.sceneId],
        });
      }
      dup.add(s.sceneId);
    }
    return out;
  }

  /**
   * 伏笔状态（§14）。
   *
   * 检查：计划声明"本章需要回收"的伏笔，在数据库里的状态
   * 若已经是 PAID_OFF，说明重复回收；若是 ABANDONED，说明回收了废弃伏笔。
   */
  private checkForeshadowing(
    chapterNumber: number,
    draftText: string,
    plan: PlanOutput | undefined,
  ): ContinuityIssue[] {
    if (!plan) return [];
    const out: ContinuityIssue[] = [];
    const rows = this.repos.foreshadowing.listByBook(this.bookId);

    for (const name of plan.brief.foreshadowing.payoff) {
      const row = rows.find((r) => r.name === name);
      if (!row) {
        out.push({
          id: `ci_fs_missing_${name}_${chapterNumber}`,
          dimension: 'foreshadowing',
          severity: 'WARNING',
          code: 'FORESHADOW_UNREGISTERED',
          message: `计划要回收伏笔「${name}」，但它未登记在伏笔表中 —— 无法追溯埋设点`,
          sourceRef: `plan:${chapterNumber}`,
          entityRefs: [],
        });
        continue;
      }
      if (row.status === 'PAID_OFF') {
        out.push({
          id: `ci_fs_paid_${row.id}`,
          dimension: 'foreshadowing',
          severity: 'WARNING',
          code: 'FORESHADOW_ALREADY_PAID',
          message: `伏笔「${name}」已在此前回收（第 ${row.payoff_chapter ?? '?'} 章），本章计划再次回收`,
          sourceRef: `foreshadowing:${row.id}`,
          entityRefs: [row.id],
        });
      }
      if (row.status === 'ABANDONED') {
        out.push({
          id: `ci_fs_abandoned_${row.id}`,
          dimension: 'foreshadowing',
          severity: 'BLOCKING',
          code: 'BLOCKING_CONTINUITY_ERROR',
          message: `伏笔「${name}」已被标记为 ABANDONED，却在本章计划中回收`,
          sourceRef: `foreshadowing:${row.id}`,
          entityRefs: [row.id],
        });
      }
      // 伏笔内容未在正文中出现 → 说明"说要回收但没写"
      if (draftText.length > 0 && !draftText.includes(name)) {
        out.push({
          id: `ci_fs_notwritten_${row.id}`,
          dimension: 'foreshadowing',
          severity: 'WARNING',
          code: 'FORESHADOW_NOT_IN_DRAFT',
          message: `计划要回收伏笔「${name}」，但正文中未出现该名称（可能换了说法，也可能漏写）`,
          sourceRef: `foreshadowing:${row.id}`,
          draftRef: `ch${chapterNumber}`,
          entityRefs: [row.id],
        });
      }
    }
    return out;
  }

  /**
   * 输出给"需要模型判断"的语义检查提示。
   *
   * 这些不做成自动判定 —— 语义矛盾（时间线、动机、物理可能）
   * 需要模型参与，结论必须由人复核。这里只负责**把材料准备好**，
   * 交给后续步骤（或人工）使用。
   */
  semanticHints(chapterNumber: number, draftText: string): readonly {
    readonly dimension: ContinuityDimension;
    readonly question: string;
    readonly material: string;
  }[] {
    const canon = this.repos.facts
      .listByStatus(this.bookId, 'CANON')
      .map((f) => `- [${f.id}] ${f.predicate} = ${f.object_value}`)
      .join('\n');
    return [
      {
        dimension: 'time',
        question: '正文中的时间推进是否与 Canon 中的事件先后一致？',
        material: `Canon 事实：\n${canon}`,
      },
      {
        dimension: 'eventOrder',
        question: `正文描写的事件顺序是否与第 ${chapterNumber} 章计划的 requiredEvents 一致？`,
        material: draftText.slice(0, 2000),
      },
      {
        dimension: 'worldRule',
        question: '正文是否违反已确立的世界规则？',
        material: `Canon 事实：\n${canon}`,
      },
    ];
  }
}

// ── 辅助判定 ────────────────────────────────────────────────

/**
 * 判定"能力/感官缺失"类谓词。
 *
 * 只覆盖能确定性判断的：这类事实一旦确立，
 * 正文中对应的能力描写就是可机械检测的矛盾。
 */
function isIncapacitatingPredicate(predicate: string): boolean {
  return /(失明|失聪|失语|瘫痪|残疾|断臂|断腿|修为尽失|失去.*能力)/.test(predicate);
}

/** 谓词涉及的能力 → 对应的正文描写关键词 */
function capabilityOf(objectValue: string): string | null {
  const map: readonly [RegExp, string][] = [
    [/失明|看不见|盲/, '看'],
    [/失聪|听不见|聋/, '听'],
    [/失语|说不出/, '说'],
    [/瘫痪|无法行动/, '走'],
  ];
  for (const [re, kw] of map) {
    if (re.test(objectValue) || re.test(kw)) return kw;
  }
  // objectValue 本身可能就是"失明"
  if (/失明/.test(objectValue)) return '看';
  if (/失聪/.test(objectValue)) return '听';
  return null;
}

/**
 * 判定"已死亡"状态。
 *
 * 兼容中英文与常见写法 —— 状态由写入方决定，
 * 不能假设只有 'DEAD' 一种字面量。
 */
function isDeadStatus(status: string): boolean {
  return /^(DEAD|dead|已死|死亡|已死亡|身亡|殒命)$/i.test(status.trim());
}

/** 同长度且仅一字之差（可能是错字/混用） */
function isNearMiss(a: string, b: string): boolean {
  if (a === b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return diff === 1;
}
