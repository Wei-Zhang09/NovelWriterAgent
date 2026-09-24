/**
 * P0-6：Scope 由证据计算（不是模型自报）。
 *
 * ## 需求原话（总提示词 §八）
 *
 * > 但是 Universal 不能仅依据「跨多本作品」。
 * > 例如：都市小说 A / 都市小说 B / 都市小说 C —— 不代表 Universal。
 * > 建议：1 本作品 → STYLE；2+ 同类型作品 → GENRE；2+ 不同类型作品 → 才可能 UNIVERSAL。
 * > 最终 scope 必须尽可能由代码计算，而不是仅相信 LLM 输出。
 * > 至少记录：support / coverage / cross_work_coverage / cross_genre_coverage /
 * >           counter_evidence / stability / held_out_validation
 *
 * ## ⚠ 这里最要紧的一条
 *
 * 「三部同类型作品」必须**判不出 UNIVERSAL** —— 这是用户点名的情形，
 * 也是旧实现的真实缺陷（旧 `resolveScope` 只数作品数，
 * 3 部都市作品就原样放行模型自报的 UNIVERSAL）。
 */
import { describe, it, expect } from 'vitest';
import { computeScope, narrowerScope, detectRuleConflict } from '@nwa/core';
import { resolveScope } from '@nwa/distillation';

describe('§八 核心规则：作品数 × 类型数 → scope', () => {
  it('⚠⚠ 1 部作品 → STYLE', () => {
    const d = computeScope({ sourceGenres: ['都市'], modelScope: 'UNIVERSAL' });
    expect(d.scope).toBe('STYLE');
    expect(d.evidence.support).toBe(1);
  });

  it('⚠⚠ 3 部**同类型**作品 → GENRE（不是 UNIVERSAL）—— 用户点名的情形', () => {
    // 都市小说 A / B / C：跨作品，但不跨类型
    const d = computeScope({
      sourceGenres: ['都市', '都市', '都市'],
      modelScope: 'UNIVERSAL',
    });
    expect(d.scope).toBe('GENRE');
    expect(d.evidence.crossWorkCoverage).toBe(3);
    expect(d.evidence.crossGenreCoverage).toBe(0);
    expect(d.reason).toContain('同属');
  });

  it('⚠⚠ 2 部不同类型作品 → 才可能 UNIVERSAL', () => {
    const d = computeScope({
      sourceGenres: ['都市', '仙侠'],
      modelScope: 'UNIVERSAL',
    });
    expect(d.scope).toBe('UNIVERSAL');
    expect(d.evidence.crossGenreCoverage).toBe(2);
  });

  it('2 部不同类型但模型自报 GENRE → 保持 GENRE（只降不升）', () => {
    const d = computeScope({ sourceGenres: ['都市', '仙侠'], modelScope: 'GENRE' });
    expect(d.scope).toBe('GENRE');
  });

  it('2 部同类型作品 → GENRE', () => {
    const d = computeScope({ sourceGenres: ['都市', '都市'], modelScope: 'UNIVERSAL' });
    expect(d.scope).toBe('GENRE');
  });

  it('类型未知不能用来升档（保守取舍）', () => {
    // 作品数是 2，但类型都未知 → 不能声称"跨类型"
    const d = computeScope({ sourceGenres: [null, null], modelScope: 'UNIVERSAL' });
    expect(d.scope).toBe('GENRE');
    expect(d.evidence.unknownGenreCount).toBe(2);
    expect(d.reason).toContain('类型');
  });

  it('类型未知与已知混合：只有 1 个已知类型 → 仍不能升档', () => {
    const d = computeScope({ sourceGenres: ['都市', null], modelScope: 'UNIVERSAL' });
    expect(d.scope).toBe('GENRE');
    expect(d.evidence.crossGenreCoverage).toBe(0);
    expect(d.evidence.unknownGenreCount).toBe(1);
  });
});

describe('§八 七项证据必须如实记录', () => {
  it('support / coverage / cross_work_coverage / cross_genre_coverage 由证据算出', () => {
    const d = computeScope({
      sourceGenres: ['都市', '都市', '仙侠'],
      modelScope: 'UNIVERSAL',
    });
    expect(d.evidence.support).toBe(3);
    expect(d.evidence.coverage).toBe(3);
    expect(d.evidence.crossWorkCoverage).toBe(3);
    expect(d.evidence.crossGenreCoverage).toBe(2);
    expect([...d.evidence.genres].sort()).toEqual(['仙侠', '都市']);
  });

  it('⚠⚠ stability 与 held_out_validation 如实标 NOT_RUN —— 不伪造证据', () => {
    // 这两项需要重复实验 / 留出作品验证，当前流程没有做。
    // 填一个"看起来合理"的分数就是伪造证据 —— 必须如实标未运行。
    const d = computeScope({ sourceGenres: ['都市', '仙侠'], modelScope: 'UNIVERSAL' });
    expect(d.evidence.stability).toBe('NOT_RUN');
    expect(d.evidence.heldOutValidation).toBe('NOT_RUN');
  });

  it('counter_evidence：没给同批模式 → NOT_CHECKED（不等于"没有反证"）', () => {
    const d = computeScope({ sourceGenres: ['都市', '仙侠'], modelScope: 'UNIVERSAL' });
    expect(d.evidence.counterEvidence.status).toBe('NOT_CHECKED');
    expect(d.evidence.counterEvidence.conflicts).toHaveLength(0);
  });

  it('counter_evidence：给了同批模式且无相反写法 → NONE（查过了）', () => {
    const d = computeScope({
      sourceGenres: ['都市', '仙侠'],
      modelScope: 'UNIVERSAL',
      selfText: '用行为暗示情绪，避免直接说明',
      siblingPatterns: [{ id: 'other', text: '用环境细节承载氛围' }],
    });
    expect(d.evidence.counterEvidence.status).toBe('NONE');
  });

  it('counter_evidence：发现相反写法 → FOUND 并记录是哪一条、为什么', () => {
    const d = computeScope({
      sourceGenres: ['都市', '仙侠'],
      modelScope: 'UNIVERSAL',
      selfText: '避免直接解释情绪',
      siblingPatterns: [{ id: 'pat_x', text: '可以适度直接说明情绪' }],
    });
    expect(d.evidence.counterEvidence.status).toBe('FOUND');
    expect(d.evidence.counterEvidence.conflicts[0]!.otherId).toBe('pat_x');
    expect(d.evidence.counterEvidence.conflicts[0]!.reason).toContain('情绪');
  });
});

describe('⚠ 只降不升', () => {
  it('证据支持 UNIVERSAL 而模型说 STYLE → 保留 STYLE', () => {
    // 模型可能识别出我们统计不到的、只有某作者才有的习惯。
    // 升级会让作者癖好冒充通用规律（§21 明确要防的）。
    const d = computeScope({ sourceGenres: ['都市', '仙侠'], modelScope: 'STYLE' });
    expect(d.scope).toBe('STYLE');
  });

  it('narrowerScope：STYLE 比 GENRE 窄，GENRE 比 UNIVERSAL 窄', () => {
    expect(narrowerScope('UNIVERSAL', 'GENRE')).toBe('GENRE');
    expect(narrowerScope('GENRE', 'STYLE')).toBe('STYLE');
    expect(narrowerScope('UNIVERSAL', 'STYLE')).toBe('STYLE');
    expect(narrowerScope('GENRE', 'UNIVERSAL')).toBe('GENRE');
    // 同档返回自身
    expect(narrowerScope('GENRE', 'GENRE')).toBe('GENRE');
  });

  it('降档时 reason 必须说明"为什么"（可审计）', () => {
    const d = computeScope({ sourceGenres: ['都市', '都市', '都市'], modelScope: 'UNIVERSAL' });
    expect(d.scope).toBe('GENRE');
    expect(d.reason).toContain('过于宽泛');
    expect(d.reason).toContain('GENRE');
    // 保留模型原值，便于对比"模型想给什么"
    expect(d.modelScope).toBe('UNIVERSAL');
  });
});

describe('⚠ 共享判据只此一处（不得在 distillation 里复制一份）', () => {
  it('detectRuleConflict 由 core 提供，writing 与 distillation 用同一份', () => {
    // 判据本体在 @nwa/core/rule-conflict.ts。
    // 若两处各存一份，编译期认为两条模式冲突并记了反证、
    // 运行时却认为不冲突两条都注入 —— 同一判据出现两份就是等着其中一份被调参。
    expect(detectRuleConflict('避免直接解释情绪', '可以适度直接说明情绪')).toContain('情绪');
    expect(detectRuleConflict('用短句加速节奏', '用环境细节承载情绪')).toBeNull();
  });
});

describe('兼容：旧的 (scope, count) 签名仍可用', () => {
  it('⚠ 旧签名拿不到类型信息 → 按"类型未知"保守处理', () => {
    // 旧签名无法区分"三部都市"与"三部不同类型"，所以一律不升档。
    // 这是刻意的：宁可漏判通用模式，也不把类型规律冒充跨类型通用。
    expect(resolveScope('UNIVERSAL', 1).scope).toBe('STYLE');
    expect(resolveScope('UNIVERSAL', 3).scope).toBe('GENRE');
    expect(resolveScope('GENRE', 3).scope).toBe('GENRE');
  });

  it('旧签名 2 部作品 + UNIVERSAL → GENRE', () => {
    expect(resolveScope('UNIVERSAL', 2).scope).toBe('GENRE');
  });
});
