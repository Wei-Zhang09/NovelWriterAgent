/**
 * Scope Precedence 冲突解决回归测试（v1.0 正式决策）。
 *
 * ## 用户点名的用例
 * - 无冲突：UNIVERSAL + GENRE + STYLE → 三者都保留
 * - GENRE 与 UNIVERSAL 冲突 → GENRE > UNIVERSAL
 * - STYLE 与 GENRE 冲突 → STYLE > GENRE
 * - STYLE 与 UNIVERSAL 冲突 → STYLE > UNIVERSAL
 * - 同 Scope 冲突 → 不由 Scope 自动解决（交既有评分机制）
 *
 * ## 另有两条本设计的关键性质
 * - 冲突解决**不修改** Skill 的 `scope` 字段（三个 Skill 仍是三个 Skill）
 * - 不做 `STYLE + GENRE → GENRE` 这类融合，也不重新引入"取最宽"
 */

import { describe, expect, it } from 'vitest';
import type { Skill } from '@nwa/shared';
import {
  resolveSkillConflicts,
  detectRuleConflict,
  SCOPE_RANK,
} from '../../packages/writing/src/skills/conflict-resolver.js';

// ── 造技能 ────────────────────────────────────────────────

let seq = 0;
function mkSkill(
  scope: 'UNIVERSAL' | 'GENRE' | 'STYLE',
  rules: string[],
  over: Partial<Skill> = {},
): Skill {
  seq += 1;
  return {
    id: `${scope.toLowerCase()}-skill-${seq}`,
    name: `${scope} 技能 ${seq}`,
    category: 'conflict',
    summary: '测试技能',
    trigger: { sceneTypes: ['CONFLICT'], genres: ['都市'] },
    rules: rules.map((r) => ({ rule: r })),
    antiPatterns: ['不要在无关场景套用'],
    examples: [],
    evidenceRefs: ['sc1'],
    confidence: 0.7,
    version: 1,
    status: 'CANDIDATE',
    genre: '都市',
    scope,
    ...over,
  } as Skill;
}

/**
 * 包成 `SelectedSkill` 形状 —— `resolveSkillConflicts` 的入参就是它。
 * 评分字段用固定值：冲突解决**不看分数**，只看规则文本与 Scope。
 */
function sel(skill: Skill) {
  return { skill, score: 0.7, reasons: [] as string[], rendered: '', truncated: false };
}

// 用户给的例子（同一话题「情绪」，极性相反）
const UNIV_RULE = '避免直接解释人物情绪';
const GENRE_RULE = '悬疑高潮可以短暂直接揭示情绪';
const STYLE_RULE = '本作品在高潮段落允许直接使用一句情绪表达';

describe('detectRuleConflict — 冲突判据', () => {
  it('同一话题 + 极性相反 → 冲突', () => {
    const why = detectRuleConflict(UNIV_RULE, GENRE_RULE);
    expect(why).not.toBeNull();
    expect(why).toContain('情绪');
  });

  it('同一话题 + 同极性 → 不冲突（互补而非矛盾）', () => {
    expect(detectRuleConflict(GENRE_RULE, STYLE_RULE)).toBeNull();
  });

  it('话题不同 → 不冲突', () => {
    expect(detectRuleConflict('用短句加速节奏', '用环境细节承载情绪')).toBeNull();
  });

  it('互斥属性对 → 冲突（极性词相同也抓得到）', () => {
    const why = detectRuleConflict('对话保持简短有力', '对话可以适当拉长以营造氛围');
    expect(why).not.toBeNull();
    expect(why).toContain('互斥');
  });

  it('一条规则内同时含肯定与否定词 → 极性归零，不与自身矛盾', () => {
    // "不要直接解释情绪，而要用行为暗示" 同时含「不要」与「要」
    expect(detectRuleConflict('不要直接解释情绪，而要用行为暗示', '避免直接说明情绪')).toBeNull();
  });
});

describe('⚠ 无冲突：UNIVERSAL + GENRE + STYLE 三者都保留', () => {
  it('互补的三条规则全部存活，无任何 conflict resolution', () => {
    const a = mkSkill('UNIVERSAL', ['用短句加速节奏']);
    const b = mkSkill('GENRE', ['悬疑高潮放慢节奏以累积压力']);
    const c = mkSkill('STYLE', ['本作品在对话里留白']);

    const r = resolveSkillConflicts([sel(a), sel(b), sel(c)]);

    expect(r.kept.map((k) => k.skill.id)).toEqual([c.id, b.id, a.id]);
    expect(r.dropped).toHaveLength(0);
    expect(r.resolutions).toHaveLength(0);
    expect(r.sameScopeConflicts).toHaveLength(0);
  });

  it('三条同话题但同极性 → 仍全部保留（不是一谈同一话题就删）', () => {
    const a = mkSkill('UNIVERSAL', ['对话要简短']);
    const b = mkSkill('GENRE', ['悬疑对话应当简短']);
    const c = mkSkill('STYLE', ['本作品对话必须简短']);

    const r = resolveSkillConflicts([sel(a), sel(b), sel(c)]);

    expect(r.kept).toHaveLength(3);
    expect(r.resolutions).toHaveLength(0);
  });
});

describe('⚠ GENRE 与 UNIVERSAL 冲突 → GENRE > UNIVERSAL', () => {
  it('GENRE 胜，UNIVERSAL 落败，且记录 reason', () => {
    const u = mkSkill('UNIVERSAL', [UNIV_RULE]);
    const g = mkSkill('GENRE', [GENRE_RULE]);

    const r = resolveSkillConflicts([sel(u), sel(g)]);

    expect(r.kept.map((k) => k.skill.id)).toEqual([g.id]);
    expect(r.dropped.map((d) => d.item.skill.id)).toEqual([u.id]);
    expect(r.resolutions).toHaveLength(1);

    const res = r.resolutions[0]!;
    expect(res.winner).toBe(g.id);
    expect(res.loser).toBe(u.id);
    expect(res.winnerScope).toBe('GENRE');
    expect(res.loserScope).toBe('UNIVERSAL');
    expect(res.reason).toBe(
      'GENRE scope overrides UNIVERSAL under direct rule conflict（同一话题「情绪」上极性相反（否定 vs 肯定））',
    );
    expect(res.winnerRule).toBe(GENRE_RULE);
    expect(res.loserRule).toBe(UNIV_RULE);
  });

  it('落败原因可读，且说明淘汰依据是 Scope Precedence', () => {
    const u = mkSkill('UNIVERSAL', [UNIV_RULE]);
    const g = mkSkill('GENRE', [GENRE_RULE]);

    const r = resolveSkillConflicts([sel(u), sel(g)]);
    expect(r.dropped[0]!.reason).toContain('Scope Precedence');
    expect(r.dropped[0]!.reason).toContain('GENRE > UNIVERSAL');
  });
});

describe('⚠ STYLE 与 GENRE 冲突 → STYLE > GENRE', () => {
  it('STYLE 胜，GENRE 落败', () => {
    const g = mkSkill('GENRE', ['悬疑高潮必须直接揭示情绪']);
    const s = mkSkill('STYLE', ['本作品避免直接揭示情绪']);

    const r = resolveSkillConflicts([sel(g), sel(s)]);

    expect(r.kept.map((k) => k.skill.id)).toEqual([s.id]);
    expect(r.resolutions[0]!.winner).toBe(s.id);
    expect(r.resolutions[0]!.winnerScope).toBe('STYLE');
    expect(r.resolutions[0]!.loserScope).toBe('GENRE');
  });
});

describe('⚠ STYLE 与 UNIVERSAL 冲突 → STYLE > UNIVERSAL', () => {
  it('STYLE 胜，UNIVERSAL 落败（跨两级的传递性）', () => {
    const u = mkSkill('UNIVERSAL', [UNIV_RULE]);
    const s = mkSkill('STYLE', ['本作品在冲突段落允许直接揭示情绪']);

    const r = resolveSkillConflicts([sel(u), sel(s)]);

    expect(r.kept.map((k) => k.skill.id)).toEqual([s.id]);
    expect(r.resolutions[0]!.winnerScope).toBe('STYLE');
    expect(r.resolutions[0]!.loserScope).toBe('UNIVERSAL');
  });
});

describe('⚠ 用户给的完整例子：UNIVERSAL 落败，GENRE 与 STYLE 并存', () => {
  it('只淘汰真正矛盾的那条，不牵连同极性的具体规则', () => {
    const u = mkSkill('UNIVERSAL', [UNIV_RULE]);
    const g = mkSkill('GENRE', [GENRE_RULE]);
    const s = mkSkill('STYLE', [STYLE_RULE]);

    const r = resolveSkillConflicts([sel(u), sel(g), sel(s)]);

    // UNIVERSAL 与 GENRE/STYLE 极性相反 → 落败
    expect(r.kept.map((k) => k.skill.id).sort()).toEqual([g.id, s.id].sort());
    expect(r.dropped.map((d) => d.item.skill.id)).toEqual([u.id]);
    // GENRE 与 STYLE 同极性，不产生 resolution
    expect(r.resolutions).toHaveLength(1);
    expect(r.resolutions[0]!.loser).toBe(u.id);
  });
});

describe('⚠ 同 Scope 冲突：不由 Scope 自动解决', () => {
  it('同 Scope 两条都不删，只如实记录冲突', () => {
    const a = mkSkill('GENRE', ['冲突场景必须拉高张力']);
    const b = mkSkill('GENRE', ['避免在冲突场景制造张力']);

    const r = resolveSkillConflicts([sel(a), sel(b)]);

    // ⚠ 都保留 —— 交既有 confidence / support / specificity / relevance
    expect(r.kept).toHaveLength(2);
    expect(r.dropped).toHaveLength(0);
    expect(r.resolutions).toHaveLength(0);
    expect(r.sameScopeConflicts).toHaveLength(1);
    expect(r.sameScopeConflicts[0]!.scope).toBe('GENRE');
    expect(r.sameScopeConflicts[0]!.reason).toContain('Scope 不解决冲突');
  });

  it('同 Scope UNIVERSAL 冲突同样不删', () => {
    const a = mkSkill('UNIVERSAL', ['对话保持简短']);
    const b = mkSkill('UNIVERSAL', ['对话可以适当拉长']);

    const r = resolveSkillConflicts([sel(a), sel(b)]);
    expect(r.kept).toHaveLength(2);
    expect(r.sameScopeConflicts).toHaveLength(1);
  });
});

describe('⚠ 冲突解决不修改 Skill 的真实证据 Scope', () => {
  it('三个技能解决后仍是三个各自 scope 的技能（不融合、不升级）', () => {
    const u = mkSkill('UNIVERSAL', [UNIV_RULE]);
    const g = mkSkill('GENRE', [GENRE_RULE]);
    const s = mkSkill('STYLE', [STYLE_RULE]);

    const r = resolveSkillConflicts([sel(u), sel(g), sel(s)]);

    for (const k of r.kept) {
      const original = [u, g, s].find((x) => x.id === k.skill.id)!;
      expect(k.skill.scope).toBe(original.scope);
    }
    // 存活的 GENRE 技能没有被升级成 UNIVERSAL，STYLE 也没有被降级
    expect(r.kept.find((k) => k.skill.id === g.id)!.skill.scope).toBe('GENRE');
    expect(r.kept.find((k) => k.skill.id === s.id)!.skill.scope).toBe('STYLE');
    // 落败的 UNIVERSAL 也没有被改写成更高 scope 来"救活"
    expect(r.dropped[0]!.item.skill.scope).toBe('UNIVERSAL');
  });

  it('SCOPE_RANK 只表达运行时优先级，不是 Skill 的 scope 取值域', () => {
    expect(SCOPE_RANK).toEqual({ STYLE: 3, GENRE: 2, UNIVERSAL: 1 });
  });
});

describe('⚠ antiPatterns 也参与冲突判定', () => {
  it('UNIVERSAL 的 antiPattern 与 GENRE 的 rule 冲突 → 同样按 Scope 取舍', () => {
    const u = mkSkill('UNIVERSAL', ['保持叙述克制'], {
      antiPatterns: ['避免直接揭示情绪'],
    });
    const g = mkSkill('GENRE', ['悬疑高潮可以短暂直接揭示情绪']);

    const r = resolveSkillConflicts([sel(u), sel(g)]);
    expect(r.resolutions).toHaveLength(1);
    expect(r.resolutions[0]!.loser).toBe(u.id);
    expect(r.resolutions[0]!.loserRule).toBe('避免直接揭示情绪');
  });
});

describe('⚠ 传递性：只与"存活的更具体者"比较', () => {
  it('STYLE 淘汰 GENRE 后，UNIVERSAL 若只与 GENRE 冲突而未被 STYLE 牵连则存活', () => {
    // STYLE 与 GENRE 冲突；UNIVERSAL 与 STYLE 不冲突
    const s = mkSkill('STYLE', ['本作品对话必须简短']);
    const g = mkSkill('GENRE', ['悬疑对话可以适当拉长']);
    const u = mkSkill('UNIVERSAL', ['用环境细节承载情绪']);

    const r = resolveSkillConflicts([sel(u), sel(g), sel(s)]);

    // STYLE 与 UNIVERSAL 话题不同 → UNIVERSAL 不与任何**存活**者冲突 → 存活
    expect(r.kept.map((k) => k.skill.id).sort()).toEqual([s.id, u.id].sort());
    expect(r.dropped.map((d) => d.item.skill.id)).toEqual([g.id]);
  });
});

describe('边界', () => {
  it('空输入', () => {
    const r = resolveSkillConflicts([]);
    expect(r.kept).toHaveLength(0);
    expect(r.resolutions).toHaveLength(0);
  });

  it('单条输入原样返回', () => {
    const a = mkSkill('STYLE', ['本作品在对话里留白']);
    const r = resolveSkillConflicts([sel(a)]);
    expect(r.kept.map((k) => k.skill.id)).toEqual([a.id]);
  });

  it('未知 scope 按 UNIVERSAL 处理（最不优先，不冒充具体证据）', () => {
    const a = mkSkill('UNIVERSAL', [UNIV_RULE]);
    const weird = mkSkill('GENRE', [GENRE_RULE], { scope: 'SOMETHING_NEW' as never });

    const r = resolveSkillConflicts([sel(a), sel(weird)]);
    // weird 按 UNIVERSAL 处理 → 同 rank → 不由 Scope 解决
    expect(r.kept).toHaveLength(2);
    expect(r.sameScopeConflicts).toHaveLength(1);
  });
});
