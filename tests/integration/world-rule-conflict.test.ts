/**
 * 世界规则 vs 正文的冲突判据（P2-4）
 *
 * ## 要解决的问题
 *
 * P2-3 之后作者能写并确认世界规则，规则也进了 prompt，但**连续性检查
 * 仍然只看 Canon facts**（从正文推断的），作者手写的规则不在检查范围内：
 *
 *   设定说「施法会消耗寿命，不可逆」
 *   正文写「他恢复了被抽走的寿命」
 *   → 检查器一声不响。
 *
 * ## 测试重点
 *
 * 判据是启发式的，**最容易出错的不是漏判而是误判** ——
 * 作者被指出一个并不存在的问题，会开始不信任检查报告。
 * 所以这组测试里"不该报"的用例比"该报"的更多。
 */
import { describe, expect, it } from 'vitest';
import {
  checkWorldRules,
  extractKeywords,
  findRuleViolation,
  parseWorldRule,
  renderWorldRulesForReview,
  type WorldRuleForCheck,
} from '@nwa/core';

function rule(over: Partial<WorldRuleForCheck> = {}): WorldRuleForCheck {
  return {
    id: 'w1',
    name: '灵力枯竭',
    description: '施法会消耗寿命，不可逆',
    ...over,
  };
}

describe('解析规则', () => {
  it('含"不可逆" → INVARIANT', () => {
    const p = parseWorldRule(rule());
    expect(p?.kind).toBe('INVARIANT');
    expect(p?.id).toBe('w1');
  });

  it('含"无法恢复" → INVARIANT', () => {
    expect(parseWorldRule(rule({ description: '寿命无法恢复' }))?.kind).toBe('INVARIANT');
  });

  it('含"禁止" → PROHIBITION', () => {
    const p = parseWorldRule(rule({ name: '禁术', description: '禁止复活死者' }));
    expect(p?.kind).toBe('PROHIBITION');
  });

  it('⚠ 不变量优先于禁令（"不可逆"里的"不"不该被当成禁令）', () => {
    // 「施法会消耗寿命，不可逆」同时含禁令词与不变量词。
    // 按不变量判更准 —— 它约束的是"结果能否被扭转"。
    expect(parseWorldRule(rule())?.kind).toBe('INVARIANT');
  });

  it('⚠ 纯描述性规则 → null（判不了就别判）', () => {
    expect(parseWorldRule(rule({ name: '雾隐城', description: '终年大雾'}))).toBeNull();
  });

  it('空规则 → null', () => {
    expect(parseWorldRule(rule({ name: '', description: '' }))).toBeNull();
  });

  it('关键词非空（判定的前提）', () => {
    expect(parseWorldRule(rule())!.keywords.length).toBeGreaterThan(0);
  });
});

describe('关键词抽取', () => {
  it('⚠ 关键词必须细到能在正文里命中（多粒度）', () => {
    // 第一版只按标点切分，抽出的是整句「施法会消耗寿命」——
    // 正文写「被抽走的寿命」永远匹配不上，判据静默失效。
    const k = extractKeywords('灵力枯竭', '施法会消耗寿命，不可逆');
    expect(k).toContain('灵力枯竭');
    expect(k).toContain('消耗寿命');
    // 2 字粒度也要有（召回靠它）
    expect(k).toContain('寿命');
  });

  it('⚠ 剔除停用词（避免正文里到处命中）', () => {
    const k = extractKeywords('规则', '使用任何法术都不能出现');
    expect(k).not.toContain('任何');
    expect(k).not.toContain('使用');
    expect(k).not.toContain('出现');
  });

  it('⚠ 长短两种粒度并存（短词召回、长词定位）', () => {
    const k = extractKeywords('消耗寿命', '消耗寿命');
    expect(k).toContain('消耗寿命');
    expect(k).toContain('寿命');
  });

  it('单字词不入选', () => {
    expect(extractKeywords('光', '看')).toEqual([]);
  });
});

describe('⚠ 不该报的（误判比漏判更糟）', () => {
  it('正文复述规则（否定语境）→ 不报', () => {
    // 这是最容易误报的一类：正文在**遵守**规则，却命中了规则关键词。
    const parsed = parseWorldRule(rule({ name: '禁术', description: '禁止复活死者' }))!;
    const draft = '长老警告他，禁止复活死者是铁律，他点了点头。';
    expect(findRuleViolation(parsed, draft)).toBeNull();
  });

  it('正文没提规则关键词 → 不报（与本章无关）', () => {
    const parsed = parseWorldRule(rule())!;
    expect(findRuleViolation(parsed, '他走进屋里，坐下来喝茶。')).toBeNull();
  });

  it('不变量：提了关键词但没有"扭转"写法 → 不报', () => {
    // 正常写"消耗寿命"不该被当成违反。
    const parsed = parseWorldRule(rule())!;
    const draft = '他施展法术，寿命被消耗了一些，不可逆。';
    expect(findRuleViolation(parsed, draft)).toBeNull();
  });

  it('描述性规则不参与判定（parse 返回 null）', () => {
    const r = checkWorldRules([rule({ name: '雾隐城', description: '终年大雾' })], '任意正文');
    expect(r.violations).toHaveLength(0);
    expect(r.parsedRules).toBe(0);
    expect(r.skippedRules).toBe(1);
  });
});

describe('⚠ 该报的', () => {
  it('不变量被推翻：声明不可逆，正文却"恢复"了', () => {
    const parsed = parseWorldRule(rule())!;
    const draft = '他运起秘法，被抽走的寿命竟缓缓恢复了过来。';
    const v = findRuleViolation(parsed, draft);
    expect(v).not.toBeNull();
    expect(v!.ruleId).toBe('w1');
    expect(v!.kind).toBe('INVARIANT');
    expect(v!.quote.length).toBeGreaterThan(0);
  });

  it('不变量被推翻：出现"死而复生"', () => {
    const parsed = parseWorldRule(
      rule({ name: '死亡不可逆', description: '死者无法恢复，不可逆' }),
    )!;
    expect(findRuleViolation(parsed, '众人惊愕地看着他死而复生。')).not.toBeNull();
  });

  it('禁令被违反：正文执行了被禁止的动作', () => {
    const parsed = parseWorldRule(rule({ name: '禁术', description: '禁止复活死者' }))!;
    const v = findRuleViolation(parsed, '他决定复活死者，哪怕代价是堕入魔道。');
    expect(v).not.toBeNull();
    expect(v!.kind).toBe('PROHIBITION');
  });

  it('quote 带上下文（供人工定位）', () => {
    const parsed = parseWorldRule(rule({ name: '禁术', description: '禁止复活死者' }))!;
    const v = findRuleViolation(parsed, '夜色沉沉，他决定复活死者，哪怕代价是堕入魔道。')!;
    expect(v.quote).toContain('复活死者');
  });
});

describe('批量检查与如实上报', () => {
  it('⚠ 解析不出的规则计入 skippedRules（不假装都查了）', () => {
    const r = checkWorldRules(
      [rule(), rule({ id: 'w2', name: '雾隐城', description: '终年大雾' })],
      '他运起秘法，寿命恢复了。',
    );
    expect(r.parsedRules).toBe(1);
    expect(r.skippedRules).toBe(1);
  });

  it('无规则 → 全 0（不抛错）', () => {
    const r = checkWorldRules([], '任意正文');
    expect(r.violations).toHaveLength(0);
    expect(r.parsedRules).toBe(0);
    expect(r.skippedRules).toBe(0);
  });

  it('一条规则只报一次（不重复）', () => {
    const r = checkWorldRules([rule()], '寿命恢复了。寿命又恢复了。');
    expect(r.violations).toHaveLength(1);
  });
});

describe('交给模型判定的规则清单', () => {
  it('含规则 id（模型才能引用它报问题）', () => {
    const t = renderWorldRulesForReview([rule()]);
    expect(t).toContain('w1');
    expect(t).toContain('灵力枯竭');
    expect(t).toContain('不可逆');
  });

  it('空规则 → 空串（不产生空标题块）', () => {
    expect(renderWorldRulesForReview([])).toBe('');
  });
});
