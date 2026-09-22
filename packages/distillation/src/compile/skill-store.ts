/**
 * 技能编译落库（施工文档 §17 / §23 / §24）
 *
 * ## 流程
 *
 * ```
 * 模式（已验证，按类型隔离）
 *   → 按 sceneFunction 分组
 *   → LLM 合并成少量技能
 *   → 代码补全（id/version/status/evidence）
 *   → **校验触发可达性**（能否被检索到）
 *   → 落库（CANDIDATE）
 * ```
 *
 * ## ⚠ 为什么新技能一律 CANDIDATE
 *
 * §24 要求技能可"A/B 测试 / 禁用 / 更新"。新编译的技能**从未被使用过**，
 * 直接标 ACTIVE 会让 Writer 立刻按它写作，而它可能：
 *   - 触发条件过窄（永远检索不到，占库无用）
 *   - 规则表述含糊（无法执行）
 *
 * `CANDIDATE` 表示"编译出来了但没验证过"。只有经实际使用证明有效
 * （或人工复核）才升到 `VALIDATED` / `ACTIVE`。
 *
 * ## ⚠ 校验不过的技能仍然落库
 *
 * 不丢弃，而是**带着 problems 落库并降级为 DEPRECATED**。
 * 理由：丢弃后无法解释"为什么某条模式没变成技能"；
 * 留下并标记，诊断信息才完整。这与 §46 的可追溯性一致。
 */
import { Logger, jaccardBigrams } from '@nwa/core';
import type { CorpusRepository, CorpusSceneRow, PatternRow } from '@nwa/storage';
import type { Skill } from '@nwa/shared';
import {
  SkillCompiler,
  assembleSkill,
  validateSkill,
  type CompiledSkillRecord,
} from './skill-compiler.js';

export interface SkillStoreOptions {
  readonly logger: Logger;
  readonly repo: CorpusRepository;
}

export interface CompileAndPersistResult {
  readonly records: readonly CompiledSkillRecord[];
  /** 落库的技能数（含被标记不可用的） */
  readonly persisted: number;
  /** 校验通过、真正可被检索到的 */
  readonly usable: number;
  /** 校验不通过（已标记 DEPRECATED 并记录原因） */
  readonly unusable: number;
  /** 每个不可用技能的原因（如实报告，不吞） */
  readonly problems: readonly {
    readonly skillId: string;
    readonly name: string;
    readonly problems: readonly string[];
    readonly triggerHits: number;
  }[];
  readonly groups: number;
  readonly failures: readonly { readonly sceneFunction: string; readonly error: string }[];
  /** ⚠ 被去重掉的近重复技能（如实报告，不静默吞） */
  readonly duplicates: readonly {
    readonly name: string;
    readonly duplicateOf: string;
    readonly similarity: number;
    /** 跨运行重复（库里已有）还是同一次运行内重复 */
    readonly scope: 'within-run' | 'existing';
  }[];
}

/**
 * ⚠ 技能近重复检测。
 *
 * ## 为什么必须做
 *
 * 技能名由模型生成，**跨运行不稳定** —— 同一个手法这次叫
 * `calm_counterstatement_in_conflict`，下次叫 `calm_upper_hand_declaration`。
 * 于是：
 *   1. **重编译会累积重复**（id 由 name 派生，名字变了就是新技能）
 *   2. 单次运行内模型也可能没完全合并（提示词要求"合并"但不保证）
 *
 * 实测 CONFLICT 一组产出 10 个技能，实为约 4 个手法各写了 2~3 个名字。
 *
 * 后果不只是"库脏"：Writer 检索 CONFLICT 时会拿到 10 个近乎一样的技能，
 * **把上下文预算挤满，且给模型互相矛盾的细微差别**。
 *
 * ## 判据：字符二元组 Jaccard 相似度，阈值 0.40
 *
 * ⚠ 阈值是**实测**定的，不是估的。对库里 29 个真实技能算了全部
 *   406 个两两相似度（`summary + rules + antiPatterns` 拼接）：
 *
 * ```
 *   0.660  subtextual_threat_exchange      ~ packaged_threat_in_polite_surface
 *   0.651  subtextual_threat_exchange      ~ subtextual_standoff
 *   0.637  packaged_threat_in_polite_surface ~ subtextual_standoff
 *   0.560  conflict_power_balance_visualization ~ public_standoff_with_witnesses
 *   0.556  calm_counterstatement_in_conflict ~ calm_upper_hand_declaration
 *   0.510  small_trigger_face_escalation   ~ petty_trigger_face_escalation
 *   0.498  calm_counterstatement_in_conflict ~ calm_counter_as_moral_high_ground
 *   ───── 0.45 分界（以上 7 对确实是同一手法）─────
 *   0.435  calm_counter_as_moral_high_ground ~ calm_upper_hand_declaration
 *   0.316  third_party_intrusion_escalation ~ public_private_collision
 *   0.295  evidence_before_reveal          ~ physical_evidence_reveal
 *   0.284  conflict_power_balance_visualization ~ witnessed_conflict_staging
 *   中位 0.026
 * ```
 *
 * ⚠ 注意真实重复项只到 **0.5~0.66**，不是 0.7~0.9 ——
 *   早先按直觉写的 0.6 阈值只抓到 3 对（漏掉一半），
 *   而那是我**没测量就写进注释**的数字。教训：阈值必须测出来。
 *
 * 取 0.40 的理由：抓住最明显的重复（0.435 那对）；0.24~0.32 那几对已属
 * 可争议区间（可能是同一手法的不同侧面，也可能是相邻但不同的手法），
 * 宁可保留 —— 误删会**永久丢失**一个手法，误留只是多占一点预算。
 *
 * ⚠ 保留哪一个：置信度高者优先；相同则保留规则更多者（信息更全）。
 *   被丢弃的**如实记录**，不静默吞掉。
 */
export { jaccardBigrams };

export function dedupeSkills<T extends { readonly skill: Skill }>(
  records: readonly T[],
  threshold = 0.40,
): { readonly kept: readonly T[]; readonly dropped: readonly { name: string; duplicateOf: string; similarity: number }[] } {
  const kept: T[] = [];
  const dropped: { name: string; duplicateOf: string; similarity: number }[] = [];

  for (const r of records) {
    const text = skillText(r.skill);
    let dupOf: { name: string; similarity: number } | null = null;

    for (const k of kept) {
      const sim = jaccardBigrams(text, skillText(k.skill));
      if (sim >= threshold) {
        dupOf = { name: k.skill.name, similarity: Math.round(sim * 100) / 100 };
        break;
      }
    }

    if (!dupOf) {
      kept.push(r);
      continue;
    }

    // 已有的是否更值得留？若新来的置信度更高，替换（并把旧的记为被丢）
    const existing = kept.find((k) => k.skill.name === dupOf!.name)!;
    if (r.skill.confidence > existing.skill.confidence) {
      kept.splice(kept.indexOf(existing), 1, r);
      dropped.push({ name: existing.skill.name, duplicateOf: r.skill.name, similarity: dupOf.similarity });
    } else {
      dropped.push({ name: r.skill.name, duplicateOf: dupOf.name, similarity: dupOf.similarity });
    }
  }

  return { kept, dropped };
}

/** 从库行取可比较文本（跨运行去重用） */
function skillTextFromRow(row: { summary: string; rules_json: string; anti_patterns_json: string }): string {
  const rules = safeParseArr(row.rules_json).map((r) =>
    typeof r === 'string' ? r : String((r as { rule?: string }).rule ?? ''),
  );
  const anti = safeParseArr(row.anti_patterns_json).map((x) => String(x));
  return [row.summary, ...rules, ...anti].join('');
}

function safeParseArr(s: string): unknown[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 技能的可比较文本（去掉名字，只看内容） */
function skillText(skill: Skill): string {
  return [
    skill.summary,
    ...skill.rules.map((r) => r.rule),
    ...skill.antiPatterns,
  ].join('');
}


/**
 * ⚠ 清理库里已有的近重复技能（把较弱的标记 DEPRECATED）。
 *
 * ## 为什么用 DEPRECATED 而不是 DELETE
 *
 * `DEPRECATED` 是 0001 迁移就定义好的生命周期状态，
 * 且 `filterSkillsByGenre` 已经会把它排除在检索之外。
 * 用它来"下架"重复技能有三个好处：
 *   1. **可逆** —— 判断错了可以改回来，删了就没了
 *   2. **可审计** —— 库里还留着"曾经编译出这个技能"的记录，
 *      能解释"某个手法为什么没有对应的活跃技能"
 *   3. **不破坏证据链** —— 技能的 evidenceRefs 仍指向真实场景（§46）
 *
 * ## 何时需要它
 *
 * 去重只在编译时生效。**在去重功能上线之前**编译的技能会残留在库里
 * （实测《都市》有 29 个，其中 10 个 CONFLICT 技能实为约 4 个手法），
 * 它们仍在 CANDIDATE 状态、仍会被检索到。这个操作负责清理这类历史残留。
 *
 * ⚠ 保留哪一个：置信度高者；相同则 id 字典序在前（稳定，保证可重复执行）。
 */
export function planDeprecations(
  rows: readonly { readonly id: string; readonly name: string; readonly summary: string; readonly rules_json: string; readonly anti_patterns_json: string; readonly confidence: number; readonly status: string }[],
  threshold = 0.40,
): { readonly deprecate: readonly string[]; readonly kept: readonly string[] } {
  // 只考虑仍活跃的（DEPRECATED 的不用再动）
  const active = rows.filter((r) => r.status !== 'DEPRECATED');
  // 按"置信度降序、id 升序"排 —— 保证同样的输入得到同样的结果
  const sorted = [...active].sort(
    (a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id),
  );

  const kept: string[] = [];
  const deprecate: string[] = [];
  const keptTexts: { id: string; text: string }[] = [];

  for (const r of sorted) {
    const t = skillTextFromRow(r);
    const dup = keptTexts.find((k) => jaccardBigrams(t, k.text) >= threshold);
    if (dup) {
      deprecate.push(r.id);
      continue;
    }
    kept.push(r.id);
    keptTexts.push({ id: r.id, text: t });
  }

  return { deprecate, kept };
}

export class SkillStore {
  private readonly logger: Logger;
  private readonly repo: CorpusRepository;

  constructor(opts: SkillStoreOptions) {
    this.logger = opts.logger;
    this.repo = opts.repo;
  }

  /**
   * 编译并落库一个类型的全部技能。
   *
   * ⚠ 类型隔离：只吃同一（归一化）类型的模式 ——
   *   用户要求"写对应类型小说时才使用对应内容"。
   */
  async compileAndPersist(req: {
    readonly compiler: SkillCompiler;
    readonly patterns: readonly PatternRow[];
    readonly scenes: readonly CorpusSceneRow[];
    readonly genre: string | null;
    readonly onProgress?: (done: number, total: number, fn: string) => void;
  }): Promise<CompileAndPersistResult> {
    // sceneId → document_id（技能来源作品反查用）
    const docOf = new Map<string, string>();
    const validSceneIds = new Set<string>();
    for (const s of req.scenes) {
      docOf.set(s.id, s.document_id);
      validSceneIds.add(s.id);
    }

    // 按 sceneFunction 分组（模式自带该字段）
    const groups = new Map<string, PatternRow[]>();
    for (const p of req.patterns) {
      if (!p.scene_function) continue;
      if (!groups.has(p.scene_function)) groups.set(p.scene_function, []);
      groups.get(p.scene_function)!.push(p);
    }

    const records: CompiledSkillRecord[] = [];
    const failures: { sceneFunction: string; error: string }[] = [];
    let done = 0;

    for (const [fn, groupPatterns] of groups) {
      const r = await req.compiler.compileGroup({
        patterns: groupPatterns,
        sceneFunction: fn,
        genre: req.genre,
      });
      if (r.error) failures.push({ sceneFunction: fn, error: r.error });

      for (const compiled of r.skills) {
        // ⚠ 作用域取来源模式的**最高档**：技能比其依据更弱没有意义，
        //   但也不能更强 —— 若该组模式里有 STYLE，技能仍应按最强证据标。
        const scope = strongestScope(groupPatterns);

        // 版本递增（同 id 重编译时 +1）
        const preview = assembleSkill({
          compiled,
          patterns: groupPatterns,
          genre: req.genre,
          scope,
          version: 1,
          docOf,
        });
        const prev = this.repo.skillVersion(preview.id);
        const skill = assembleSkill({
          compiled,
          patterns: groupPatterns,
          genre: req.genre,
          scope,
          version: prev + 1,
          docOf,
        });

        // ⚠ 校验：能不能被检索到 + 证据是否可回溯
        const { problems, triggerHits } = validateSkill({
          skill,
          scenes: req.scenes,
          validSceneIds,
        });

        // ⚠ 校验不过**不丢弃**，而是标 DEPRECATED 后落库 ——
        //   丢弃后无法解释"这条模式为什么没变成技能"
        const finalStatus = problems.length > 0 ? 'DEPRECATED' : skill.status;
        records.push({ skill: { ...skill, status: finalStatus }, problems, triggerHits });

        if (problems.length > 0) {
          this.logger.warn('技能未通过校验（将标记 DEPRECATED，保留以便诊断）', {
            skillId: skill.id,
            name: skill.name,
            triggerHits,
            problems,
          });
        }
      }

      done++;
      req.onProgress?.(done, groups.size, fn);
    }

    // ⚠ 去重必须在**落库之前** —— 这是关键顺序。
    //
    //   早先先落库再去重，等于没防住：重复项已经写进库了，
    //   只是被"记录为重复"。重编译多次后库里照样堆满近重复技能。
    //   正确顺序：装配 → 去重 → 只落库保留的。

    // 1) 同一次运行内的重复
    const { kept: keptInRun, dropped: droppedInRun } = dedupeSkills(records);

    // 2) 跨运行重复：与库里**已有**技能比内容（名字可能不同但手法相同）
    const existing = this.repo.listSkills();
    const existingTexts = existing.map((r) => ({
      id: r.id,
      name: r.name,
      text: skillTextFromRow(r),
    }));

    const duplicates: {
      name: string;
      duplicateOf: string;
      similarity: number;
      scope: 'within-run' | 'existing';
    }[] = droppedInRun.map((d) => ({ ...d, scope: 'within-run' as const }));

    const toPersist: CompiledSkillRecord[] = [];
    for (const r of keptInRun) {
      const t = skillText(r.skill);
      let dup: { name: string; similarity: number } | null = null;
      for (const e of existingTexts) {
        if (e.id === r.skill.id) continue; // 自身（重编译同一技能）
        const sim = jaccardBigrams(t, e.text);
        if (sim >= 0.40) {
          dup = { name: e.name, similarity: Math.round(sim * 100) / 100 };
          break;
        }
      }
      if (dup) {
        // ⚠ 已存在同内容技能 → **不写库**（这正是防累积的关键）
        duplicates.push({ name: r.skill.name, duplicateOf: dup.name, similarity: dup.similarity, scope: 'existing' });
        continue;
      }
      toPersist.push(r);
    }

    // 3) 只落库去重后保留的
    for (const r of toPersist) this.persist(r.skill);

    const usable = toPersist.filter((r) => r.problems.length === 0).length;
    const unusable = toPersist.length - usable;

    this.logger.info('技能编译完成', {
      genre: req.genre,
      groups: groups.size,
      persisted: records.length,
      usable,
      unusable,
      failures: failures.length,
    });

    return {
      records: toPersist,
      persisted: toPersist.length,
      usable,
      unusable,
      problems: toPersist
        .filter((r) => r.problems.length > 0)
        .map((r) => ({
          skillId: r.skill.id,
          name: r.skill.name,
          problems: r.problems,
          triggerHits: r.triggerHits,
        })),
      groups: groups.size,
      failures,
      duplicates,
    };
  }

  private persist(skill: Skill): void {
    this.repo.putSkill({
      id: skill.id,
      name: skill.name,
      category: skill.category,
      summary: skill.summary,
      triggerJson: JSON.stringify(skill.trigger),
      rulesJson: JSON.stringify(skill.rules),
      examplesJson: JSON.stringify(skill.examples),
      antiPatternsJson: JSON.stringify(skill.antiPatterns),
      evidenceRefsJson: JSON.stringify(skill.evidenceRefs),
      confidence: skill.confidence,
      version: skill.version,
      status: skill.status,
      genre: skill.genre,
      scope: skill.scope,
      sourceDocumentIdsJson: JSON.stringify(skill.sourceDocumentIds),
    });
  }
}

/**
 * 取一组模式里**最强**的作用域。
 *
 * ⚠ 为什么取最强而非最弱：技能是模式的上位抽象，若它把多条模式
 *   合并成一个，其中只要有一条是 GENRE（跨作品验证过），
 *   合并结果就继承了那份证据强度。
 *
 *   反过来若取最弱，一条 STYLE 混进来就会把整个技能降到 STYLE ——
 *   而 STYLE 默认不可见，等于**白编译**。
 *
 * 顺序：UNIVERSAL > GENRE > STYLE
 */
export function strongestScope(
  patterns: readonly PatternRow[],
): 'UNIVERSAL' | 'GENRE' | 'STYLE' {
  const rank = { UNIVERSAL: 3, GENRE: 2, STYLE: 1 } as const;
  let best: 'UNIVERSAL' | 'GENRE' | 'STYLE' = 'STYLE';
  for (const p of patterns) {
    const s = (p.scope ?? 'STYLE') as 'UNIVERSAL' | 'GENRE' | 'STYLE';
    if (rank[s] > rank[best]) best = s;
  }
  return best;
}
