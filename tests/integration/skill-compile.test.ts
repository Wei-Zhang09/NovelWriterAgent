/**
 * 技能编译测试（施工文档 §17 / §23 / §24）
 *
 * ## 这组测试的核心
 *
 * 1. ⚠ **触发可达性校验** —— 技能必须真的能被检索到。
 *    模型容易写出过窄的触发条件（只认 CLIMAX 而语料里只有 1 个），
 *    这种技能占着库、内容看着挺好，但永远不会被用到。
 * 2. ⚠ **近重复去重** —— 技能名由模型生成、跨运行不稳定，
 *    同一个手法会以多个名字出现（实测 CONFLICT 一组 10 个技能实为 4 个手法）。
 * 3. ⚠ **§24 八要素** —— 技能不是一大段 prompt。
 * 4. ⚠ **证据可回溯**（§46）。
 * 5. ⚠ **作用域取最强** —— 一条 STYLE 混进来不该把整个技能降档。
 */
import { describe, it, expect } from 'vitest';
import { dedupeSkills, jaccardBigrams, validateSkill, countTriggerHits, strongestScope } from '@nwa/distillation';
import { SkillSchema, CompiledSkillSchema, type Skill } from '@nwa/shared';
import type { CorpusSceneRow, PatternRow } from '@nwa/storage';

function mkSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: 's1_都市',
    name: 'test_skill',
    category: 'emotion',
    summary: '测试技能',
    trigger: { sceneTypes: ['CONFLICT'], genres: ['都市'] },
    rules: [{ rule: '把情绪拆到动作与旁白' }],
    antiPatterns: ['不要在情绪已明确时重复暗示'],
    examples: [],
    evidenceRefs: ['sc1'],
    confidence: 0.7,
    version: 1,
    status: 'CANDIDATE',
    scope: 'GENRE',
    genre: '都市',
    sourceDocumentIds: ['doc_a', 'doc_b'],
    ...over,
  };
}

function mkScene(over: Partial<CorpusSceneRow> & { id: string }): CorpusSceneRow {
  return {
    document_id: 'doc_a',
    chapter_number: 1,
    scene_index: 0,
    text_path: null,
    scene_type: 'CONFLICT',
    annotation_json: '{}',
    created_at: '2026-01-01T00:00:00Z',
    annotated: 1,
    scene_function: 'CONFLICT',
    genre: '都市',
    ...over,
  } as CorpusSceneRow;
}

describe('§24 技能是结构化八要素，不是 prompt', () => {
  it('八要素齐全时通过校验', () => {
    expect(SkillSchema.safeParse(mkSkill()).success).toBe(true);
  });

  it('⚠ antiPatterns 不能为空（说不出失效条件的技能不该启用）', () => {
    expect(SkillSchema.safeParse(mkSkill({ antiPatterns: [] })).success).toBe(false);
  });

  it('⚠ rules 不能为空', () => {
    expect(SkillSchema.safeParse(mkSkill({ rules: [] })).success).toBe(false);
  });

  it('技能名必须是 snake_case（作为稳定标识）', () => {
    expect(SkillSchema.safeParse(mkSkill({ name: 'BadName' })).success).toBe(false);
    expect(SkillSchema.safeParse(mkSkill({ name: 'good_name' })).success).toBe(true);
  });

  it('category 只能取闭集（避免同义类别让查询失效）', () => {
    expect(SkillSchema.safeParse(mkSkill({ category: 'emotion' })).success).toBe(true);
    expect(SkillSchema.safeParse(mkSkill({ category: '情绪' as never })).success).toBe(false);
  });

  it('⚠ 模型输出契约不含 id/version/status（这些由代码决定）', () => {
    const compiled = {
      name: 'x_y',
      category: 'emotion',
      summary: '这是一个技能的说明',
      trigger: { sceneTypes: ['CONFLICT'], genres: [] },
      rules: [{ rule: '做某事' }],
      antiPatterns: ['不要某事'],
    };
    expect(CompiledSkillSchema.safeParse(compiled).success).toBe(true);

    // 契约里确实没有这三个字段（模型填了也会被剥离）
    const parsed = CompiledSkillSchema.parse({
      ...compiled,
      id: 'model_made_this',
      version: 99,
      status: 'ACTIVE',
    } as never);
    expect(Object.keys(parsed)).not.toContain('id');
    expect(Object.keys(parsed)).not.toContain('version');
    expect(Object.keys(parsed)).not.toContain('status');
  });

  it('⚠ 模型输出 sceneTypes 用非法枚举值时被拒（实测 7 组作废）', () => {
    const bad = {
      name: 'x_y',
      category: 'emotion',
      summary: '这是一个技能的说明',
      // 模型自创的值（实测出现过 RELATIONSHIP / INTRODUCE / GROUP_SCENE）
      trigger: { sceneTypes: ['RELATIONSHIP'], genres: [] },
      rules: [{ rule: '做某事' }],
      antiPatterns: ['不要某事'],
    };
    expect(CompiledSkillSchema.safeParse(bad).success).toBe(false);
  });
});

describe('⚠ 触发可达性校验（技能必须能被检索到）', () => {
  const scenes = [
    mkScene({ id: 'a', scene_function: 'CONFLICT' }),
    mkScene({ id: 'b', scene_function: 'CONFLICT' }),
    mkScene({ id: 'c', scene_function: 'COOLDOWN' }),
  ];

  it('触发条件能命中 → 无问题', () => {
    const r = validateSkill({
      skill: mkSkill(),
      scenes,
      validSceneIds: new Set(['sc1']),
    });
    expect(r.triggerHits).toBe(2);
    expect(r.problems).toEqual([]);
  });

  it('⚠ 触发条件命中 0 个场景 → 报问题（永远不会被用到）', () => {
    const r = validateSkill({
      skill: mkSkill({ trigger: { sceneTypes: ['CLIMAX'], genres: [] } }),
      scenes,
      validSceneIds: new Set(['sc1']),
    });
    expect(r.triggerHits).toBe(0);
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.problems[0]).toContain('命中 0 个场景');
  });

  it('⚠ 证据引用不存在的场景 → 报问题（§46）', () => {
    const r = validateSkill({
      skill: mkSkill({ evidenceRefs: ['nope'] }),
      scenes,
      validSceneIds: new Set(['sc1']),
    });
    expect(r.problems.some((p) => p.includes('不存在的场景'))).toBe(true);
  });

  it('类型不匹配时不计命中（类型隔离）', () => {
    const r = countTriggerHits(
      mkSkill({ trigger: { sceneTypes: ['CONFLICT'], genres: ['仙侠'] } }),
      scenes,
    );
    expect(r).toBe(0);
  });

  it('genres 为空数组表示不限类型', () => {
    const r = countTriggerHits(mkSkill({ trigger: { sceneTypes: ['CONFLICT'], genres: [] } }), scenes);
    expect(r).toBe(2);
  });

  it('sceneTypes 为空表示不限场景功能', () => {
    const r = countTriggerHits(mkSkill({ trigger: { sceneTypes: [], genres: [] } }), scenes);
    expect(r).toBe(3);
  });
});

describe('⚠ 近重复去重（技能名跨运行不稳定）', () => {
  // ⚠ 用**真实形态**的重复对：实测同手法重复项的内容相似度 0.5~0.66，
  //   即 summary/rules/antiPatterns 都有相当重叠（不只是换个说法）。
  //   只共享 summary 的虚构用例相似度仅 0.35，不构成重复 —— 那种不算。
  const RULES = [
    { rule: '让主角在对方发难后给出一句简短、冷静、逻辑清晰的陈述' },
    { rule: '陈述后不追加情绪化补充，用沉默或转身留给对方和读者消化' },
    { rule: '让对方的反应暴露其理亏或失态，而不是由旁白判定谁对谁错' },
  ];
  const ANTI = ['主角本身理亏却使用冷静陈述，会被读者识破为强词夺理', '连续使用同一种冷静反击会让主角显得像辩论机器'];

  const base = mkSkill({
    name: 'calm_counterstatement_in_conflict',
    summary: '在冲突中让主角用简短冷静的陈述占据道德高地，并以沉默和对方的失态收束',
    rules: RULES,
    antiPatterns: ANTI,
    confidence: 0.65,
  });
  const dup = mkSkill({
    name: 'calm_upper_hand_declaration',
    summary: '在情绪化对抗中用简短、冷静、逻辑闭环的陈述抢占道德或规则高地',
    rules: [
      { rule: '让主角在对方发难后只给出一句简短、冷静、逻辑完整的陈述' },
      { rule: '陈述后不追加情绪化补充，用沉默、转身或一个物理动作留给对方和读者消化' },
      { rule: '让对方的反应（结巴、失态、找补、动手）暴露其理亏，不由叙述者点评' },
    ],
    antiPatterns: ANTI,
    confidence: 0.65,
  });

  it('⚠ 同一手法的不同命名被识别为重复', () => {
    const { kept, dropped } = dedupeSkills([
      { skill: base },
      { skill: dup },
    ]);
    expect(kept.length).toBe(1);
    expect(dropped.length).toBe(1);
    expect(dropped[0]!.similarity).toBeGreaterThanOrEqual(0.4);
  });

  it('⚠ 被丢弃的如实记录（不静默吞）', () => {
    const { dropped } = dedupeSkills([{ skill: base }, { skill: dup }]);
    expect(dropped[0]!.duplicateOf).toBeTruthy();
    expect(dropped[0]!.name).toBeTruthy();
  });

  it('不同手法不被误判为重复', () => {
    const other = mkSkill({
      name: 'c_skill',
      summary: '用倒叙揭示人物动机',
      rules: [{ rule: '先给结果再回溯原因，让读者带着疑问读' }],
      antiPatterns: ['悬念本身不成立时不要倒叙'],
    });
    const { kept } = dedupeSkills([{ skill: base }, { skill: other }]);
    expect(kept.length).toBe(2);
  });

  it('保留置信度更高的那个', () => {
    const low = mkSkill({ name: 'low_skill', summary: '用旁观者反应放大冲突压力', confidence: 0.4 });
    const high = mkSkill({ name: 'high_skill', summary: '用旁观者的反应来放大冲突带来的压力', confidence: 0.9 });
    const { kept } = dedupeSkills([{ skill: low }, { skill: high }]);
    expect(kept.length).toBe(1);
    expect(kept[0]!.skill.name).toBe('high_skill');
  });

  it('置信度更高时替换已保留的（并记录被替换的）', () => {
    const low = mkSkill({ name: 'low_skill', summary: '用旁观者反应放大冲突压力', confidence: 0.4 });
    const high = mkSkill({ name: 'high_skill', summary: '用旁观者的反应来放大冲突带来的压力', confidence: 0.9 });
    const { kept, dropped } = dedupeSkills([{ skill: low }, { skill: high }]);
    expect(kept[0]!.skill.name).toBe('high_skill');
    expect(dropped[0]!.name).toBe('low_skill');
  });

  it('jaccardBigrams：相同文本为 1，无关文本接近 0', () => {
    expect(jaccardBigrams('用旁观者反应放大冲突', '用旁观者反应放大冲突')).toBe(1);
    expect(jaccardBigrams('用旁观者反应放大冲突', '倒叙揭示人物动机')).toBeLessThan(0.2);
  });

  it('空文本不崩（返回 0）', () => {
    expect(jaccardBigrams('', 'abc')).toBe(0);
  });
});

describe('⚠ 作用域取最强（一条 STYLE 不该拖垮整个技能）', () => {
  function mkPattern(scope: string): PatternRow {
    return {
      id: 'p1',
      category: 'narrative_technique',
      trigger_json: '{}',
      pattern_json: '{}',
      strategy_json: '{}',
      evidence_refs_json: '[]',
      confidence: 0.6,
      sample_count: 8,
      mechanism: 'm',
      genre: '都市',
      scene_function: 'CONFLICT',
      created_at: '2026-01-01T00:00:00Z',
      scope,
    };
  }

  it('GENRE + STYLE 混合 → 取 GENRE', () => {
    expect(strongestScope([mkPattern('GENRE'), mkPattern('STYLE')])).toBe('GENRE');
  });

  it('UNIVERSAL 优先于 GENRE', () => {
    expect(strongestScope([mkPattern('GENRE'), mkPattern('UNIVERSAL')])).toBe('UNIVERSAL');
  });

  it('全 STYLE → STYLE', () => {
    expect(strongestScope([mkPattern('STYLE')])).toBe('STYLE');
  });

  it('空数组 → STYLE（最保守）', () => {
    expect(strongestScope([])).toBe('STYLE');
  });
});
