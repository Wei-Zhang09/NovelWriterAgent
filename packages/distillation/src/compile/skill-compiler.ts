/**
 * 技能编译（施工文档 §23 / §24）
 *
 * ## 编译器做两件事：**合并** 与 **校验**
 *
 * ### 1. 合并：模式 → 技能不是一对一
 *
 * 同一个场景功能下常有 5~7 条模式，它们往往是**同一手法的不同侧面**
 * （实测 CONFLICT 下 7 条模式里有 4 条都在讲"用旁观者放大压力"）。
 *
 * 若一条模式编译成一个技能，Writer 的上下文里会出现 7 个近乎重复的
 * CONFLICT 技能 —— 既浪费预算，又让模型收到互相矛盾的细微差别。
 *
 * 因此按 `sceneFunction` 分组送入，要求模型**合并成少量技能**。
 *
 * ### 2. 校验：技能的触发条件必须**真的能命中**
 *
 * 这是本模块最有价值的部分，也是纯代码可算的。
 *
 * 模型很容易写出过窄的触发条件（如 `sceneTypes: ['CLIMAX']` 而该类型
 * 只有 1 个场景）。这种技能**永远不会被检索到** —— 它占着库、看着正常，
 * 但对 Writer 毫无作用。人眼很难发现，因为技能内容本身写得很好。
 *
 * 因此校验会拿**语料里真实存在的场景**去匹配每个技能的触发条件，
 * 命中数为 0 的技能标为不可用并如实报告。
 *
 * 同理校验 `evidenceRefs` 指向的场景真实存在（§46）。
 */
import { Logger } from '@nwa/core';
import type { CorpusSceneRow, PatternRow } from '@nwa/storage';
import { normalizeGenre } from '@nwa/storage';
import {
  CompileOutputSchema,
  SCENE_FUNCTIONS,
  SKILL_CATEGORIES,
  type CompiledSkill,
  type Skill,
  type SkillStatus,
} from '@nwa/shared';
import type { AnnotationStructuredCaller } from '../parse/annotator.js';

export interface SkillCompilerOptions {
  readonly logger: Logger;
  readonly structured: AnnotationStructuredCaller;
  /** 每组最多产出几个技能（防止一个场景功能爆出十几个） */
  readonly maxSkillsPerGroup?: number;
}

/** 场景功能 → 中文任务描述（与 pattern-miner 一致，供模型理解语境） */
const FUNCTION_HINT: Record<string, string> = {
  SETUP: '开场铺垫',
  CHARACTER_DEVELOPMENT: '人物塑造',
  RELATIONSHIP_CHANGE: '关系变化',
  CONFLICT: '冲突对抗',
  ESCALATION: '冲突升级',
  REVELATION: '信息揭示',
  REVERSAL: '反转',
  EMOTIONAL_PAYOFF: '情绪兑现',
  COOLDOWN: '缓冲回落',
  COMEDY_RELIEF: '喜剧调剂',
  ACTION: '动作',
  WORLD_BUILDING: '世界观构建',
  CLIMAX: '高潮',
  HOOK: '钩子',
  CLIFFHANGER: '悬念收束',
};

/** 编译结果：技能 + 校验结论 */
export interface CompiledSkillRecord {
  readonly skill: Skill;
  /** 校验问题（空数组表示通过） */
  readonly problems: readonly string[];
  /** 触发条件在语料里的命中场景数 */
  readonly triggerHits: number;
}

export interface CompileResult {
  readonly records: readonly CompiledSkillRecord[];
  /** 可用的技能（校验通过） */
  readonly usable: number;
  /** 因校验不通过而不可用的 */
  readonly unusable: number;
  /** 按场景功能分组的编译尝试数 */
  readonly groups: number;
  readonly failures: readonly { readonly sceneFunction: string; readonly error: string }[];
}

/**
 * 技能编译器。
 *
 * ⚠ 输入是**模式**（§20 七槽）而非原始场景 —— 模式已经过跨作品验证
 *   与作用域判定，是可信的中间产物。直接从场景编译会绕过那些校验。
 */
export class SkillCompiler {
  private readonly logger: Logger;
  private readonly structured: AnnotationStructuredCaller;
  private readonly maxSkillsPerGroup: number;

  constructor(opts: SkillCompilerOptions) {
    this.logger = opts.logger;
    this.structured = opts.structured;
    this.maxSkillsPerGroup = opts.maxSkillsPerGroup ?? 3;
  }

  /**
   * 把一个场景功能下的多条模式编译成少量技能。
   */
  async compileGroup(req: {
    readonly patterns: readonly PatternRow[];
    readonly sceneFunction: string;
    readonly genre: string | null;
    /**
     * 本组模式的证据范围（调用方已按 scope 分好组，组内一致）。
     *
     * ⚠ 传给模型是为了让它知道**这批写法凭什么成立**：
     *   STYLE = 只在某一部作品里成立，GENRE = 同类型多部作品验证过。
     *   这直接影响 rules 该怎么写（STYLE 的写法要标"这是某作者的偏好"，
     *   GENRE 的可以写成类型通用规则）。
     */
    readonly scope?: 'UNIVERSAL' | 'GENRE' | 'STYLE';
  }): Promise<{ readonly skills: readonly CompiledSkill[]; readonly error?: string }> {
    const { patterns, sceneFunction, genre } = req;
    if (patterns.length === 0) return { skills: [] };

    const hint = FUNCTION_HINT[sceneFunction] ?? sceneFunction;

    // 把模式整理成模型可读的文本（含七槽）
    const blocks = patterns.map((p, i) => {
      const trigger = safeParse(p.trigger_json) as { trigger?: string; context?: string[] };
      const pat = safeParse(p.pattern_json) as {
        decision?: string[];
        effect?: string[];
        boundary?: string[];
      };
      return [
        `【模式 ${i + 1}】作用域 ${p.scope}｜置信度 ${p.confidence}｜样本 ${p.sample_count}`,
        `  触发场景: ${trigger?.trigger ?? '(未记录)'}`,
        `  情境约束: ${(trigger?.context ?? []).join('；')}`,
        `  手法: ${(pat?.decision ?? []).join('；')}`,
        `  机制: ${p.mechanism}`,
        `  效果: ${(pat?.effect ?? []).join('；')}`,
        `  失效条件: ${(pat?.boundary ?? []).join('；')}`,
      ].join('\n');
    });

    const genreLine = genre ? `目标类型：${genre}。` : '目标类型：不限（跨类型通用）。';

    // ⚠ 明确告诉模型这批模式的证据范围。
    //   不同 scope 已经被调用方分成不同的组，这里不会混。
    const scope = req.scope ?? 'STYLE';
    const scopeLine =
      scope === 'UNIVERSAL'
        ? '证据范围：**UNIVERSAL** —— 这些写法在**跨类型**的多部作品里都成立，可以写成类型无关的通用规则。'
        : scope === 'GENRE'
          ? `证据范围：**GENRE** —— 这些写法在**同类型（${genre ?? '本类型'}）多部作品**里验证过，` +
            '可以写成该类型的通用规则；不要声称为跨类型通用。'
          : '证据范围：**STYLE** —— 这些写法目前只在**一部作品**里观察到。' +
            '规则要写成"这部作品的做法"，并明确这是个别偏好而非类型规律。';

    const prompt = [
      `以下是一批关于「${hint}」场景的**已验证写法**（来自真实作品，已通过跨作品校验）。`,
      genreLine,
      '',
      scopeLine,
      '',
      '你的任务：把它们**合并**成少量可直接执行的写作技能。',
      '',
      `⚠ 严格要求：`,
      `1. 最多产出 ${this.maxSkillsPerGroup} 个技能。若多条模式其实是同一手法的不同侧面，`,
      '   **必须合并**成一个技能，不要一个模式产出一个技能。',
      '2. `name` 用 snake_case 英文（如 high_tension_emotion），是这个技能的稳定标识。',
      '3. `rules` 每条必须是**可执行的动作**（"把情绪拆到动作与旁白"），',
      '   不能是评价（"写得更细腻"无法执行）。`rationale` 说明为什么有效。',
      '4. `antiPatterns` 至少一条，写**什么时候这个技能会毁稿**。',
      '   直接来自上面各模式的"失效条件"，不要自己发明。',
      '5. `trigger.sceneTypes` 只能从下面这**闭集**里选（写别的值会导致整组作废）：',
      `   ${SCENE_FUNCTIONS.join(' | ')}`,
      `   \`trigger.genres\` 填 ${genre ? `["${genre}"]` : '[]'}（空数组表示不限类型）。`,
      '   ⚠ 触发条件不要过窄：若某个场景功能在语料里很少，填它会检索不到。',
      // ⚠⚠ 这里**故意不**要求模型填 trigger.povs / minEmotionIntensity /
      //   minTension / narrativePositions。
      //
      //   原因：模式挖掘的产出（pattern_json）只有
      //   trigger / context / decision / effect / boundary ——
      //   **没有视角、没有强度、没有结构位置**这些信息。
      //   要求模型基于这些材料声明"本技能适用于第一人称、张力≥0.8"
      //   就是让它凭空编造证据范围，与 §九「Scope 是证据适用范围、
      //   不得为方便而扩大」的纪律直接冲突。
      //
      //   引擎侧已支持这些维度（skills/engine.ts 会消费它们），
      //   等挖掘端能产出对应证据后再在这里要求。
      //   在那之前，这些字段留空 —— 空数组/undefined 表示"不限定"，
      //   检索行为与现在一致（不参与该维度打分）。
      `6. \`category\` 只能从闭集里选：${SKILL_CATEGORIES.join(' | ')}`, 
      '7. 若这批模式**不足以**支撑一个清晰技能，返回空数组 —— 不要硬凑。',
      '8. ⚠ 这批模式的证据范围是**一致的**（同一 scope）。不要把它写成' +
        '更强的适用范围 —— 例如只有一部作品支撑时，不要写成"所有小说都适用"。' +
        '适用范围由系统按证据判定，你只需把手法本身写清楚。',
      '',
      '模式：',
      ...blocks,
    ].join('\n');

    try {
      const res = await this.structured({
        schema: CompileOutputSchema,
        schemaName: 'CompiledSkills',
        messages: [
          {
            role: 'system',
            content:
              '你是写作技能编译器。把已验证的写法合并成可执行、可检索、可禁用的技能。' +
              '技能不是提示词模板 —— 规则要具体可执行，反模式要写明失效条件。' +
              '宁可返回空数组，也不要产出含糊或重复的技能。',
          },
          { role: 'user', content: prompt },
        ],
        maxTokens: 3000,
        temperature: 0.2,
      });

      if (!res.ok) {
        this.logger.warn('技能编译调用失败（该组跳过）', {
          sceneFunction,
          error: res.error.message,
        });
        return { skills: [], error: `${res.error.code}：${res.error.message}` };
      }

      const parsed = CompileOutputSchema.parse(res.data);
      return { skills: parsed.skills.slice(0, this.maxSkillsPerGroup) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn('技能编译失败（该组跳过）', { sceneFunction, error: msg });
      return { skills: [], error: msg };
    }
  }
}

/**
 * ⚠ 校验技能是否**真的可用**（§17 的"校验"）。
 *
 * 这是纯代码校验，不看技能写得好不好，只看它**能不能被触发**。
 *
 * ## 为什么要校验触发可达性
 *
 * 模型会写出过窄的触发条件。实测：`sceneTypes: ['CLIMAX']` 而语料里
 * 该类型只有 1 个场景 —— 这种技能**永远不会被检索到**，
 * 但它占着库、内容看着挺好，人眼很难发现。
 *
 * ## 判据
 * - 触发条件在语料里有命中（`triggerHits > 0`）
 * - 证据引用真实存在（§46）
 * - `rules` / `antiPatterns` 非空（schema 已保证，这里再确认落库值）
 */
export function validateSkill(req: {
  readonly skill: Skill;
  /** 该类型下已标注的全部场景（用于匹配触发条件） */
  readonly scenes: readonly CorpusSceneRow[];
  /** 库中真实存在的 sceneId 集合 */
  readonly validSceneIds: ReadonlySet<string>;
}): { readonly problems: readonly string[]; readonly triggerHits: number } {
  const { skill, scenes, validSceneIds } = req;
  const problems: string[] = [];

  // ── 1. 触发可达性 ──
  const hits = countTriggerHits(skill, scenes);
  if (hits === 0) {
    problems.push(
      `触发条件命中 0 个场景（sceneTypes=${JSON.stringify(skill.trigger.sceneTypes)}` +
        `${skill.trigger.genres.length ? `, genres=${JSON.stringify(skill.trigger.genres)}` : ''}）` +
        `—— 该技能永远不会被检索到，不可用`,
    );
  }

  // ── 2. 证据可回溯（§46）──
  const badEvidence = skill.evidenceRefs.filter((id) => !validSceneIds.has(id));
  if (badEvidence.length > 0) {
    problems.push(`证据引用了不存在的场景：${badEvidence.slice(0, 3).join(', ')}`);
  }

  // ── 3. 规则与反模式（schema 已保证，这里确认落库值不被清空）──
  if (skill.rules.length === 0) problems.push('没有可执行规则');
  if (skill.antiPatterns.length === 0) {
    problems.push('没有反模式 —— 说不出"什么时候不该用"的技能不该启用');
  }

  return { problems, triggerHits: hits };
}

/** 统计触发条件在语料里的命中场景数 */
export function countTriggerHits(skill: Skill, scenes: readonly CorpusSceneRow[]): number {
  const types = new Set(skill.trigger.sceneTypes);
  const genres = new Set(skill.trigger.genres.map((g) => normalizeGenre(g)));

  let n = 0;
  for (const s of scenes) {
    // 场景功能：触发条件未指定则不限制
    if (types.size > 0 && !types.has(s.scene_function as never)) continue;
    // 类型：触发条件未指定则不限制；否则要求同类型
    if (genres.size > 0) {
      const g = normalizeGenre(s.genre);
      if (g === null || !genres.has(g)) continue;
    }
    n++;
  }
  return n;
}

/**
 * 落库前的技能装配：把模型产出（CompiledSkill）补全为完整 Skill。
 *
 * ⚠ `id` / `version` / `status` / `evidenceRefs` 由**代码**决定，不让模型填：
 *   - id 由 name + 类型派生（稳定，便于版本管理）
 *   - version 由仓储递增（模型不知道已有版本）
 *   - status 一律 CANDIDATE（新编译的未经验证，不该直接 ACTIVE）
 *   - evidenceRefs 取该组模式的证据并集（模型没看过完整证据列表）
 */
export function assembleSkill(req: {
  readonly compiled: CompiledSkill;
  readonly patterns: readonly PatternRow[];
  readonly genre: string | null;
  readonly scope: 'UNIVERSAL' | 'GENRE' | 'STYLE';
  readonly version: number;
  /**
   * sceneId → document_id 映射。
   *
   * ⚠ 必需：`distillation_patterns` 表**没有** source_document_ids 列，
   *   来源作品只能从证据场景反查。少了这个映射，
   *   `sourceDocumentIds` 会静默为空 —— 而它正是技能降档的依据。
   */
  readonly docOf: ReadonlyMap<string, string>;
  readonly status?: SkillStatus;
}): Skill {
  const { compiled, patterns, genre, scope, version } = req;

  // 证据并集（去重）—— 来自模式，不来自模型
  const evidence = new Set<string>();
  for (const p of patterns) {
    const ids = safeParse(p.evidence_refs_json) as string[] | null;
    for (const id of ids ?? []) evidence.add(id);
  }

  // ⚠ 来源作品从**证据场景**反查（与模式挖掘同口径）
  const docs = new Set<string>();
  for (const id of evidence) {
    const d = req.docOf.get(id);
    if (d) docs.add(d);
  }

  // 置信度：取来源模式的平均（技能的把握不该高于它依据的模式）
  const conf =
    patterns.length > 0
      ? patterns.reduce((s, p) => s + p.confidence, 0) / patterns.length
      : 0.5;

  return {
    // ⚠ id 必须含 scope。
    //
    //   按 sceneFunction × scope 分组后，同一场景功能下会**同时**存在
    //   STYLE / GENRE / UNIVERSAL 三个技能（正是第三条方案要的结果）。
    //   若 id 只由 name + genre 组成，三个技能会撞成同一个 id ——
    //   后写的把先写的顶掉（version +1），最终只剩一个。
    //   那就等于"独立编译"白做了。
    id: `${slug(compiled.name)}_${normalizeGenre(genre) ?? 'universal'}_${scope.toLowerCase()}`,
    name: compiled.name,
    category: compiled.category,
    summary: compiled.summary,
    trigger: compiled.trigger,
    rules: compiled.rules,
    antiPatterns: compiled.antiPatterns,
    examples: [],
    evidenceRefs: [...evidence],
    confidence: Math.round(conf * 100) / 100,
    version,
    status: req.status ?? 'CANDIDATE',
    scope,
    genre: normalizeGenre(genre),
    sourceDocumentIds: [...docs],
  };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);
}

function safeParse(s: string | null | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
