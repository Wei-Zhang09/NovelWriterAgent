/**
 * Writer 的 POV / Emotion 结构拆分（P1）
 *
 * ## 这组测试防的是什么
 *
 * P1 第一项修的是一类**静默失效**：接口上写着支持某些维度，
 * 实际上那些维度从未生效过，而且没有任何地方会报错。
 *
 * 具体三处（都已修，这里逐条钉住）：
 *
 * 1. ⚠⚠ **把「出场角色」当成「视角」**
 *    旧 prompt：`人称与视角：${mainCharacters.join('、')} 视角，不要跳视角。`
 *    "本章有林晚、陈默、老板" → "林晚、陈默、老板视角"，
 *    与同一句的"不要跳视角"直接矛盾。模型会任选一边，
 *    于是跳视角变成**时有时无**的现象 —— 最难查的那种。
 *
 * 2. ⚠ **`emotionIntensity` 写死 null**
 *    §25 的 Emotion 维度**从未生效过**：所有声明了
 *    `minEmotionIntensity` 的技能永远拿不到那 0.3 分。
 *
 * 3. ⚠ **`SceneContext.pov` 声明了但从未被读取**
 *    接口看起来支持视角检索，实际没有任何技能会因为视角而被
 *    选中或排除 —— "只保留字段却全传 null"的典型。
 *
 * 测试策略：**测行为，不测实现**。不 grep prompt 文本，
 * 而是断言"喂进去不同输入，输出必须不同"——这类断言才能
 * 在实现重写后继续有效，也才能抓住"字段接了但没接进逻辑"。
 */
import { describe, it, expect } from 'vitest';
import {
  BAND_TO_INTENSITY,
  ChapterBriefSchema,
  NarrativeDistanceSchema,
  NarrativePositionSchema,
  NarrativePovSchema,
  PlanOutputSchema,
  ScenePlanSchema,
  resolveIntensity,
  validatePlanSemantics,
} from '@nwa/shared';
import { SkillEngine } from '@nwa/writing';
import type { SkillRow } from '@nwa/storage';

function mkRow(over: Partial<SkillRow> & { id: string; name: string }): SkillRow {
  return {
    category: 'conflict',
    summary: `说明 ${over.name}`,
    trigger_json: JSON.stringify({ sceneTypes: ['CONFLICT'], genres: ['都市'] }),
    rules_json: JSON.stringify([{ rule: `规则 ${over.name}：把冲突安排在公共空间` }]),
    anti_patterns_json: JSON.stringify([`反模式 ${over.name}：私密对峙时不要硬塞围观群体`]),
    examples_json: '[]',
    evidence_refs_json: JSON.stringify(['sc1']),
    confidence: 0.7,
    version: 1,
    status: 'CANDIDATE',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    genre: '都市',
    scope: 'GENRE',
    source_document_ids_json: JSON.stringify(['doc_a']),
    ...over,
  } as SkillRow;
}

// ── 1. 档位 → 数值（模型给判断，代码算数值）────────────────

describe('resolveIntensity：模型给档位，代码算数值', () => {
  it('三档映射到固定数值（可复现）', () => {
    expect(resolveIntensity('LOW').value).toBe(BAND_TO_INTENSITY.LOW);
    expect(resolveIntensity('MEDIUM').value).toBe(BAND_TO_INTENSITY.MEDIUM);
    expect(resolveIntensity('HIGH').value).toBe(BAND_TO_INTENSITY.HIGH);
  });

  it('⚠ 档位缺失时返回 null 而不是默认值', () => {
    // 这是**核心纪律**：填一个 0.5 会让"模型没说"伪装成"模型说中等"，
    // 于是阈值比较照常运行，而它比较的是一个编造的数。
    const r = resolveIntensity(undefined);
    expect(r.value).toBeNull();
    expect(r.source).toBe('UNKNOWN');
    expect(resolveIntensity(null).value).toBeNull();
  });

  it('⚠ 数值单调递增（否则档位排序会反过来）', () => {
    expect(BAND_TO_INTENSITY.LOW).toBeLessThan(BAND_TO_INTENSITY.MEDIUM);
    expect(BAND_TO_INTENSITY.MEDIUM).toBeLessThan(BAND_TO_INTENSITY.HIGH);
  });

  it('⚠ 不用端点值 0 / 1', () => {
    // 端点会让"模型说极低"与"模型没说"在比较时表现相同
    for (const v of Object.values(BAND_TO_INTENSITY)) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// ── 2. 出场角色 ≠ 视角 ──────────────────────────────────

describe('出场角色与视角是两件事', () => {
  const base = {
    chapterNumber: 1,
    purpose: '推进主线',
    previousState: 'A',
    targetState: 'B',
    mainCharacters: ['林晚', '陈默', '老板'],
    requiredEvents: ['林晚拿到账本'],
    endState: '林晚离开',
    purpose: '林晚与陈默在办公室对峙',
  };

  it('⚠ 一章多个人出场 + 单一视角是合法的', () => {
    const brief = ChapterBriefSchema.parse({
      chapterNumber: 1, purpose: 'p', previousState: 'a', targetState: 'b',
      mainCharacters: ['林晚', '陈默', '老板'],
      narrativePov: 'THIRD_LIMITED',
    });
    expect(brief.mainCharacters).toHaveLength(3);
    expect(brief.narrativePov).toBe('THIRD_LIMITED');
  });

  it('⚠ 视角人物不在出场角色里 → 校验报错', () => {
    const plan = PlanOutputSchema.parse({
      brief: {
        chapterNumber: 1, purpose: 'p', previousState: 'a', targetState: 'b',
        mainCharacters: ['林晚', '陈默'],
        narrativePov: 'THIRD_LIMITED',
      },
      scenes: [{ sceneId: 's1', ...base, pov: '张三' }],
    });
    const issues = validatePlanSemantics(plan);
    expect(issues.some((i) => i.includes('张三') && i.includes('不在本章出场角色'))).toBe(true);
  });

  it('视角人物在场 → 通过', () => {
    const plan = PlanOutputSchema.parse({
      brief: {
        chapterNumber: 1, purpose: 'p', previousState: 'a', targetState: 'b',
        mainCharacters: ['林晚', '陈默'],
        narrativePov: 'THIRD_LIMITED',
      },
      scenes: [{ sceneId: 's1', ...base, pov: '林晚' }],
    });
    expect(validatePlanSemantics(plan).filter((i) => i.includes('视角人物'))).toHaveLength(0);
  });

  it('⚠ 容错匹配：模型写「林晚（视角）」不应误报', () => {
    // 误报的代价是 Planner 反复自我修复甚至失败 —— 比漏检更糟。
    const plan = PlanOutputSchema.parse({
      brief: {
        chapterNumber: 1, purpose: 'p', previousState: 'a', targetState: 'b',
        mainCharacters: ['林晚', '陈默'],
        narrativePov: 'THIRD_LIMITED',
      },
      scenes: [{ sceneId: 's1', ...base, pov: '林晚（视角）' }],
    });
    expect(validatePlanSemantics(plan).filter((i) => i.includes('视角人物'))).toHaveLength(0);
  });

  it('⚠ 全知视角 + 声明了视角人物 → 自相矛盾，报错', () => {
    const plan = PlanOutputSchema.parse({
      brief: {
        chapterNumber: 1, purpose: 'p', previousState: 'a', targetState: 'b',
        mainCharacters: ['林晚'],
        narrativePov: 'THIRD_OMNISCIENT',
      },
      scenes: [{ sceneId: 's1', ...base, pov: '林晚' }],
    });
    const issues = validatePlanSemantics(plan);
    expect(issues.some((i) => i.includes('THIRD_OMNISCIENT') && i.includes('全知'))).toBe(true);
  });

  it('全知视角不填视角人物 → 合法', () => {
    const plan = PlanOutputSchema.parse({
      brief: {
        chapterNumber: 1, purpose: 'p', previousState: 'a', targetState: 'b',
        mainCharacters: ['林晚'],
        narrativePov: 'THIRD_OMNISCIENT',
      },
      scenes: [{ sceneId: 's1', ...base, pov: '' }],
    });
    expect(validatePlanSemantics(plan).filter((i) => i.includes('全知'))).toHaveLength(0);
  });

  it('⚠⚠ 模型把视角类型写进 pov 字段 → 容忍（否则每章都卡修复重试）', () => {
    // 实测：既有 planner 夹具写的就是 `pov: '第三人称限知'`。
    // 模型会把 §30 的自由文本 pov 当成"视角"填 —— 这是可理解的行为。
    // 判错会让 Planner 反复修复重试直到整章失败，比漏检更糟。
    for (const v of ['第三人称限知', '第一人称', '第三人称全知视角', 'third-person limited']) {
      const plan = PlanOutputSchema.parse({
        brief: {
          chapterNumber: 1, purpose: 'p', previousState: 'a', targetState: 'b',
          mainCharacters: ['林晚'],
        },
        scenes: [{ sceneId: 's1', ...base, pov: v }],
      });
      const issues = validatePlanSemantics(plan).filter((i) => i.includes('视角人物'));
      expect(issues, `「${v}」不应被判为不在场的人名`).toHaveLength(0);
    }
  });

  it('⚠ 真的人名不在场仍然报错（容忍不等于放弃检查）', () => {
    const plan = PlanOutputSchema.parse({
      brief: {
        chapterNumber: 1, purpose: 'p', previousState: 'a', targetState: 'b',
        mainCharacters: ['林晚'],
      },
      scenes: [{ sceneId: 's1', ...base, pov: '张三' }],
    });
    expect(validatePlanSemantics(plan).some((i) => i.includes('张三'))).toBe(true);
  });
});

// ── 3. 枚举是权威闭集 ──────────────────────────────────

describe('叙事维度枚举', () => {
  it('视角三值', () => {
    expect(NarrativePovSchema.options).toEqual([
      'FIRST_PERSON', 'THIRD_LIMITED', 'THIRD_OMNISCIENT',
    ]);
  });

  it('距离三档', () => {
    expect(NarrativeDistanceSchema.options).toEqual(['CLOSE', 'MEDIUM', 'FAR']);
  });

  it('位置六值', () => {
    expect(NarrativePositionSchema.options).toEqual([
      'OPENING', 'RISING', 'MIDPOINT', 'CLIMAX', 'FALLING', 'RESOLUTION',
    ]);
  });

  it('⚠ 非法值被拒（自由文本会让检索静默失效）', () => {
    expect(NarrativePovSchema.safeParse('第一人称').success).toBe(false);
    expect(NarrativePovSchema.safeParse('FIRST_PERSON').success).toBe(true);
  });
});

// ── 4. 检索真的消费了这些维度（行为断言）────────────────

describe('Skill Engine 消费 POV / 张力维度', () => {
  /** 造一条**限定视角**的技能 */
  const povSkill = (povs: string[]) =>
    mkRow({
      id: 'pov_skill', name: 'pov_skill',
      trigger_json: JSON.stringify({ sceneTypes: ['CONFLICT'], genres: ['都市'], povs }),
    });

  it('⚠ 视角匹配 → 加分（此前该字段完全不被读取）', () => {
    const engine = new SkillEngine({ maxSkills: 5 });
    const rows = [povSkill(['FIRST_PERSON'])];
    const hit = engine.retrieve(rows, {
      sceneFunction: 'CONFLICT', genre: '都市', pov: 'FIRST_PERSON',
    });
    const miss = engine.retrieve(rows, {
      sceneFunction: 'CONFLICT', genre: '都市', pov: 'THIRD_LIMITED',
    });
    const hitScore = hit.selected[0]?.score ?? 0;
    const missScore = miss.selected[0]?.score ?? 0;
    // 关键：两种输入必须产出**不同**的分数 —— 相同就说明维度没接进逻辑
    expect(hitScore).toBeGreaterThan(missScore);
  });

  it('⚠ 视角不符是降权不是排除（一票否决会让小样本库检索不到东西）', () => {
    const engine = new SkillEngine({ maxSkills: 5 });
    const rows = [povSkill(['FIRST_PERSON'])];
    const sel = engine.retrieve(rows, {
      sceneFunction: 'CONFLICT', genre: '都市', pov: 'THIRD_LIMITED',
    });
    // 仍在候选里（可能因分数低落到后面，但不该被静默删除）
    expect(sel.considered).toBe(1);
    const all = [...sel.selected.map((s) => s.skill.id), ...sel.rejected.map((r) => r.id)];
    expect(all).toContain('pov_skill');
  });

  it('⚠ 视角未声明时该维度不参与（不猜）', () => {
    const engine = new SkillEngine({ maxSkills: 5 });
    const rows = [povSkill(['FIRST_PERSON'])];
    const noCtx = engine.retrieve(rows, { sceneFunction: 'CONFLICT', genre: '都市' });
    const withCtx = engine.retrieve(rows, {
      sceneFunction: 'CONFLICT', genre: '都市', pov: 'FIRST_PERSON',
    });
    const a = noCtx.selected[0]?.score ?? 0;
    const b = withCtx.selected[0]?.score ?? 0;
    expect(b).toBeGreaterThan(a);
  });

  it('⚠ 张力与情绪强度是独立维度（冷静的危机必须能被检索到）', () => {
    const engine = new SkillEngine({ maxSkills: 5 });
    const rows = [mkRow({
      id: 'tense_skill', name: 'tense_skill',
      trigger_json: JSON.stringify({
        sceneTypes: ['CONFLICT'], genres: ['都市'], minTension: 0.8,
      }),
    })];
    // 低情绪 + 高张力：追车戏。若两个维度被合并，这里会拿不到分。
    const calmTense = engine.retrieve(rows, {
      sceneFunction: 'CONFLICT', genre: '都市',
      emotionIntensity: BAND_TO_INTENSITY.LOW,
      tension: BAND_TO_INTENSITY.HIGH,
    });
    const calmFlat = engine.retrieve(rows, {
      sceneFunction: 'CONFLICT', genre: '都市',
      emotionIntensity: BAND_TO_INTENSITY.LOW,
      tension: BAND_TO_INTENSITY.LOW,
    });
    const a = calmTense.selected[0]?.score ?? 0;
    const b = calmFlat.selected[0]?.score ?? 0;
    expect(a).toBeGreaterThan(b);
  });

  it('⚠ 情感强度维度真的生效了（此前写死 null，从未生效）', () => {
    const engine = new SkillEngine({ maxSkills: 5 });
    const rows = [mkRow({
      id: 'emo_skill', name: 'emo_skill',
      trigger_json: JSON.stringify({
        sceneTypes: ['CONFLICT'], genres: ['都市'], minEmotionIntensity: 0.8,
      }),
    })];
    const high = engine.retrieve(rows, {
      sceneFunction: 'CONFLICT', genre: '都市',
      emotionIntensity: BAND_TO_INTENSITY.HIGH,
    });
    const low = engine.retrieve(rows, {
      sceneFunction: 'CONFLICT', genre: '都市',
      emotionIntensity: BAND_TO_INTENSITY.LOW,
    });
    expect(high.selected[0]?.score ?? 0).toBeGreaterThan(low.selected[0]?.score ?? 0);
  });

  it('⚠ 叙事位置与场景功能正交，可独立加分', () => {
    const engine = new SkillEngine({ maxSkills: 5 });
    const rows = [mkRow({
      id: 'climax_skill', name: 'climax_skill',
      trigger_json: JSON.stringify({
        sceneTypes: ['CONFLICT'], genres: ['都市'], narrativePositions: ['CLIMAX'],
      }),
    })];
    const atClimax = engine.retrieve(rows, {
      sceneFunction: 'CONFLICT', genre: '都市', narrativePosition: 'CLIMAX',
    });
    const atOpening = engine.retrieve(rows, {
      sceneFunction: 'CONFLICT', genre: '都市', narrativePosition: 'OPENING',
    });
    expect(atClimax.selected[0]?.score ?? 0).toBeGreaterThan(atOpening.selected[0]?.score ?? 0);
  });

  it('⚠ 未声明这些维度的技能不受影响（向后兼容既有 29 条技能）', () => {
    // 实测：库里 29 条自动编译的技能，trigger 只有 sceneTypes + genres。
    // 新维度必须**完全不影响**它们 —— 否则修一个空转会弄坏整个检索。
    const engine = new SkillEngine({ maxSkills: 5 });
    const plain = mkRow({
      id: 'plain_skill', name: 'plain_skill',
      trigger_json: JSON.stringify({ sceneTypes: ['CONFLICT'], genres: ['都市'] }),
    });
    const withAll = engine.retrieve([plain], {
      sceneFunction: 'CONFLICT', genre: '都市',
      pov: 'FIRST_PERSON', tension: 0.9, emotionIntensity: 0.9,
      narrativePosition: 'CLIMAX',
    });
    const bare = engine.retrieve([plain], { sceneFunction: 'CONFLICT', genre: '都市' });
    // 未声明 → 所有新维度都不参与打分，两种情况得分必须相同
    expect(withAll.selected[0]?.score).toBe(bare.selected[0]?.score);
  });

  it('⚠ 空数组/undefined 表示"不限定"，不是"不匹配"', () => {
    const engine = new SkillEngine({ maxSkills: 5 });
    // povs: [] 是默认值 —— 不能因为场景声明了视角就降权
    const empty = mkRow({
      id: 'empty_povs', name: 'empty_povs',
      trigger_json: JSON.stringify({
        sceneTypes: ['CONFLICT'], genres: ['都市'], povs: [],
      }),
    });
    const a = engine.retrieve([empty], {
      sceneFunction: 'CONFLICT', genre: '都市', pov: 'FIRST_PERSON',
    });
    const b = engine.retrieve([empty], { sceneFunction: 'CONFLICT', genre: '都市' });
    expect(a.selected[0]?.score).toBe(b.selected[0]?.score);
  });
});

// ── 5. ScenePlan 承载新字段 ─────────────────────────────

describe('ScenePlan 承载 P1 字段', () => {
  it('档位 / 位置 / 视角可选，缺省不报错（兼容既有计划）', () => {
    const s = ScenePlanSchema.parse({
      sceneId: 's1', purpose: 'p', endState: 'e',
    });
    expect(s.emotionIntensityBand).toBeUndefined();
    expect(s.tensionBand).toBeUndefined();
    expect(s.narrativePosition).toBeUndefined();
    expect(s.narrativePov).toBeUndefined();
  });

  it('⚠ 给了小数强度会被拒（模型必须给档位）', () => {
    const r = ScenePlanSchema.safeParse({
      sceneId: 's1', purpose: 'p', endState: 'e', emotionIntensityBand: 0.72,
    });
    expect(r.success).toBe(false);
  });

  it('档位/位置/视角声明后能往返', () => {
    const s = ScenePlanSchema.parse({
      sceneId: 's1', purpose: 'p', endState: 'e',
      emotionIntensityBand: 'HIGH', tensionBand: 'LOW',
      narrativePosition: 'CLIMAX', narrativePov: 'FIRST_PERSON',
      narrativeDistance: 'CLOSE',
    });
    expect(s.emotionIntensityBand).toBe('HIGH');
    expect(s.tensionBand).toBe('LOW');
    expect(s.narrativePosition).toBe('CLIMAX');
    expect(s.narrativePov).toBe('FIRST_PERSON');
    expect(s.narrativeDistance).toBe('CLOSE');
  });
});
