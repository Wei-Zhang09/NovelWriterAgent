/**
 * Context Engine 测试（STEP 5 验收核心）
 *
 * 三条约束必须被证明「真的拦得住」：
 *   1. Protected 超预算 → 报错，绝不静默裁剪（研究报告 R3）
 *   2. 无 sourceRef 的条目 → 拒绝进入上下文（§11）
 *   3. 装配报告可断言（研究报告 §2.2 差异 5）
 *
 * 同时验证「相反方向」：可裁剪槽位确实会被裁，且如实上报裁了什么。
 */
import { describe, it, expect } from 'vitest';
import { ContextEngine, defaultTokenCounter } from '@nwa/harness';
import type { ContextEntry, TokenCounter } from '@nwa/harness';
import { AppError, ErrorCode } from '@nwa/core';

/** 用 1 字符 = 1 token 的计数替身，让预算断言可精确计算 */
const oneCharOneToken: TokenCounter = { estimate: (t) => t.length };

function engine(counter: TokenCounter = oneCharOneToken) {
  return new ContextEngine({ counter });
}

function entry(over: Partial<ContextEntry> = {}): ContextEntry {
  return {
    id: 'e1',
    sourceType: 'FACT',
    sourceRef: 'fact_001',
    content: '张三已死亡',
    priority: 1,
    ...over,
  };
}

const budget = (over: Partial<import('@nwa/core').ContextBudget> = {}) => ({
  inputTokens: 1000,
  outputReserveTokens: 100,
  protectedMaxTokens: 600,
  ...over,
});

describe('⚠ 保护式预算：Protected 装不下就报错（研究报告 R3）', () => {
  it('Protected 槽位超预算时抛 CONTEXT_BUDGET_EXCEEDED', () => {
    const e = engine();
    expect(() =>
      e.assemble({
        budget: budget(),
        slots: {
          // protectedCanon 默认预算 16000，但这里塞 20000 字符
          protectedCanon: [entry({ id: 'big', content: '字'.repeat(20_000) })],
        },
      }),
    ).toThrow(/超出其预算/);
  });

  it('报错时给出「是哪几条撑爆的」，便于定位', () => {
    const e = engine();
    let err: unknown;
    try {
      e.assemble({
        budget: budget(),
        slots: {
          protectedCanon: [
            entry({ id: 'small', content: '短', priority: 1 }),
            entry({ id: 'huge', content: '字'.repeat(20_000), priority: 9 }),
          ],
        },
      });
    } catch (x) {
      err = x;
    }
    expect(AppError.isAppError(err)).toBe(true);
    if (!AppError.isAppError(err)) return;
    expect(err.code).toBe(ErrorCode.CONTEXT_BUDGET_EXCEEDED);
    const d = err.details as {
      slot: string;
      needed: number;
      budget: number;
      largestEntries: { id: string; tokens: number }[];
    };
    expect(d.slot).toBe('protectedCanon');
    expect(d.largestEntries[0]!.id).toBe('huge');
    expect(d.largestEntries[0]!.tokens).toBe(20_000);
  });

  it('⚠ Protected 内容一条不丢：超预算时不会"丢掉一部分再成功"', () => {
    const e = engine();
    // 只要超预算就必须抛错 —— 绝不返回一个"内容变少了"的成功结果
    expect(() =>
      e.assemble({
        budget: budget(),
        slots: {
          protectedCanon: Array.from({ length: 5 }, (_, i) =>
            entry({ id: `p${i}`, content: '字'.repeat(4_000), priority: i }),
          ),
        },
      }),
    ).toThrow();
  });

  it('Protected 总量超过 inputTokens - outputReserve 时报错', () => {
    const e = engine();
    expect(() =>
      e.assemble({
        budget: budget({ inputTokens: 300, outputReserveTokens: 200, protectedMaxTokens: 300 }),
        slots: {
          // 6 个 protected 槽位各塞一点，加起来超过 100 的可用输入
          system: [entry({ content: '字'.repeat(50) })],
          projectProfile: [entry({ content: '字'.repeat(50) })],
          chapterPlan: [entry({ content: '字'.repeat(50) })],
        },
      }),
    ).toThrow(/可用输入预算|protectedMaxTokens/);
  });

  it('Protected 总量超过 protectedMaxTokens 时报错', () => {
    const e = engine();
    expect(() =>
      e.assemble({
        budget: budget({ inputTokens: 100_000, outputReserveTokens: 100, protectedMaxTokens: 120 }),
        slots: {
          system: [entry({ content: '字'.repeat(100) })],
          projectProfile: [entry({ content: '字'.repeat(100) })],
        },
      }),
    ).toThrow(/protectedMaxTokens 配置上限/);
  });

  it('刚好等于预算时通过（边界不报错）', () => {
    const e = engine();
    const assembled = e.assemble({
      budget: budget({ inputTokens: 100_000, outputReserveTokens: 100, protectedMaxTokens: 10_000 }),
      slots: { system: [entry({ content: '字'.repeat(2_000) })] },
    });
    expect(assembled.report.slots.find((s) => s.slot === 'system')!.usedTokens).toBe(2_000);
  });

  it('预算配置自相矛盾时也报错（protectedMaxTokens > inputTokens）', () => {
    const e = engine();
    expect(() =>
      e.assemble({ budget: budget({ inputTokens: 100, protectedMaxTokens: 200 }), slots: {} }),
    ).toThrow(/不得大于 inputTokens/);
  });

  it('输出预留吃光所有输入空间时报错', () => {
    const e = engine();
    expect(() =>
      e.assemble({ budget: budget({ inputTokens: 100, outputReserveTokens: 100, protectedMaxTokens: 50 }), slots: {} }),
    ).toThrow(/没有任何可用输入空间/);
  });
});

describe('⚠ 禁止无根记忆（§11）', () => {
  it('缺 sourceRef 的条目被拒绝', () => {
    const e = engine();
    let err: unknown;
    try {
      e.assemble({
        budget: budget(),
        slots: { topMemory: [entry({ id: 'm1', sourceRef: '' })] },
      });
    } catch (x) {
      err = x;
    }
    expect(AppError.isAppError(err)).toBe(true);
    if (AppError.isAppError(err)) {
      expect(err.code).toBe(ErrorCode.CONTEXT_BUILD_FAILED);
      expect(err.message).toMatch(/缺少 sourceRef/);
      expect(err.message).toMatch(/禁止无根记忆/);
    }
  });

  it('只有空白的 sourceRef 同样被拒绝', () => {
    const e = engine();
    expect(() =>
      e.assemble({ budget: budget(), slots: { topMemory: [entry({ sourceRef: '   ' })] } }),
    ).toThrow(/缺少 sourceRef/);
  });

  it('缺 id 的条目被拒绝', () => {
    const e = engine();
    expect(() => e.assemble({ budget: budget(), slots: { topMemory: [entry({ id: '' })] } })).toThrow(
      /缺少 id/,
    );
  });

  it('Protected 槽位同样受此约束（不能因为是 Canon 就免检）', () => {
    const e = engine();
    expect(() =>
      e.assemble({ budget: budget(), slots: { protectedCanon: [entry({ sourceRef: '' })] } }),
    ).toThrow(/缺少 sourceRef/);
  });

  it('渲染出的文本里每条都带来源标注', () => {
    const e = engine();
    const out = e.assemble({
      budget: budget(),
      slots: { topMemory: [entry({ id: 'm1', sourceType: 'SUMMARY', sourceRef: 'summaries/001.md', content: '主角离开故乡' })] },
    });
    expect(out.text).toContain('[SUMMARY:summaries/001.md]');
    expect(out.text).toContain('主角离开故乡');
  });
});

describe('可裁剪槽位：按预算装入并如实上报', () => {
  it('超预算时裁掉低优先级条目', () => {
    const e = engine();
    const out = e.assemble({
      budget: budget({ inputTokens: 100_000, outputReserveTokens: 100, protectedMaxTokens: 100 }),
      // topMemory 默认预算 6000；塞 10 条各 1000 字符
      slots: {
        topMemory: Array.from({ length: 10 }, (_, i) =>
          entry({ id: `m${i}`, sourceRef: `summary/${i}`, content: '字'.repeat(1_000), priority: i }),
        ),
      },
      overrides: { topMemory: { budgetTokens: 3_000 } },
    });
    const rep = out.report.slots.find((s) => s.slot === 'topMemory')!;
    expect(rep.includedCount).toBe(3);
    expect(rep.droppedCount).toBe(7);
    expect(rep.usedTokens).toBeLessThanOrEqual(3_000);
  });

  it('⚠ 优先级高的先装入', () => {
    const e = engine();
    const out = e.assemble({
      budget: budget({ inputTokens: 100_000, outputReserveTokens: 100, protectedMaxTokens: 100 }),
      slots: {
        topMemory: [
          entry({ id: 'low', sourceRef: 'a', content: '低'.repeat(1_000), priority: 1 }),
          entry({ id: 'high', sourceRef: 'b', content: '高'.repeat(1_000), priority: 99 }),
        ],
      },
      overrides: { topMemory: { budgetTokens: 1_500 } },
    });
    expect(out.entriesBySlot.topMemory?.map((x) => x.id)).toEqual(['high']);
  });

  it('⚠ 条目级 isProtected 高于优先级（可裁剪槽位里也能保护单条）', () => {
    const e = engine();
    const out = e.assemble({
      budget: budget({ inputTokens: 100_000, outputReserveTokens: 100, protectedMaxTokens: 100 }),
      slots: {
        activeForeshadowing: [
          entry({ id: 'normal', sourceRef: 'a', content: '普'.repeat(1_000), priority: 99 }),
          entry({ id: 'core', sourceRef: 'b', content: '核'.repeat(1_000), priority: 1, isProtected: true }),
        ],
      },
      overrides: { activeForeshadowing: { budgetTokens: 1_500 } },
    });
    expect(out.entriesBySlot.activeForeshadowing?.map((x) => x.id)).toEqual(['core']);
  });

  it('被裁掉的条目 id 全部记录在报告里（可审计丢了什么）', () => {
    const e = engine();
    const out = e.assemble({
      budget: budget({ inputTokens: 100_000, outputReserveTokens: 100, protectedMaxTokens: 100 }),
      slots: {
        topMemory: Array.from({ length: 5 }, (_, i) =>
          entry({ id: `m${i}`, sourceRef: `s${i}`, content: '字'.repeat(500), priority: i }),
        ),
      },
      overrides: { topMemory: { budgetTokens: 1_200 } },
    });
    const rep = out.report.slots.find((s) => s.slot === 'topMemory')!;
    expect(rep.droppedIds).toHaveLength(rep.droppedCount);
    expect(rep.droppedIds).not.toContain(out.entriesBySlot.topMemory![0]!.id);
  });

  it('排序稳定：同优先级时按 id 排序（结果可复现）', () => {
    const e = engine();
    const mk = () =>
      e.assemble({
        budget: budget({ inputTokens: 100_000, outputReserveTokens: 100, protectedMaxTokens: 100 }),
        slots: {
          topMemory: [
            entry({ id: 'z', sourceRef: 'sz', content: '字'.repeat(500), priority: 5 }),
            entry({ id: 'a', sourceRef: 'sa', content: '字'.repeat(500), priority: 5 }),
            entry({ id: 'm', sourceRef: 'sm', content: '字'.repeat(500), priority: 5 }),
          ],
        },
        overrides: { topMemory: { budgetTokens: 1_200 } },
      });
    expect(mk().entriesBySlot.topMemory?.map((x) => x.id)).toEqual(mk().entriesBySlot.topMemory?.map((x) => x.id));
  });

  it('预算为 0 时全不装入，且报告说明原因', () => {
    const e = engine();
    const out = e.assemble({
      budget: budget({ inputTokens: 100_000, outputReserveTokens: 100, protectedMaxTokens: 100 }),
      slots: { topMemory: [entry({ content: 'x'.repeat(100) })] },
      overrides: { topMemory: { budgetTokens: 0 } },
    });
    const rep = out.report.slots.find((s) => s.slot === 'topMemory')!;
    expect(rep.includedCount).toBe(0);
    expect(rep.note).toMatch(/预算为 0/);
  });

  it('截断时显式告知模型「上下文不完整」', () => {
    const e = engine();
    const out = e.assemble({
      budget: budget({ inputTokens: 100_000, outputReserveTokens: 100, protectedMaxTokens: 100 }),
      slots: {
        topMemory: [entry({ id: 'long', sourceRef: 's', content: Array.from({ length: 40 }, () => '字'.repeat(50)).join('\n') })],
      },
      overrides: { topMemory: { budgetTokens: 1_000, fillPolicy: 'truncate' } },
    });
    const rep = out.report.slots.find((s) => s.slot === 'topMemory')!;
    expect(rep.truncated).toBe(true);
    // 文本里必须出现"上下文说明"，避免模型把残缺上下文当完整
    expect(out.text).toContain('[上下文说明：');
    expect(out.text).toContain('已截断');
  });
});

describe('装配报告（研究报告 §2.2 差异 5）', () => {
  it('报告包含全部 12 个槽位（未提供数据的槽位也记录为 0）', () => {
    const e = engine();
    const out = e.assemble({ budget: budget(), slots: {} });
    expect(out.report.slots.length).toBeGreaterThanOrEqual(12);
  });

  it('allProtectedSatisfied 在成功装配时为 true', () => {
    const e = engine();
    const out = e.assemble({ budget: budget(), slots: { system: [entry({ content: 'x' })] } });
    expect(out.report.allProtectedSatisfied).toBe(true);
  });

  it('Protected 与可裁剪槽位分别统计 token', () => {
    const e = engine();
    const out = e.assemble({
      budget: budget({ inputTokens: 100_000, outputReserveTokens: 100, protectedMaxTokens: 50_000 }),
      slots: {
        system: [entry({ content: '字'.repeat(100) })],
        topMemory: [entry({ content: '字'.repeat(200) })],
      },
    });
    expect(out.report.protectedTokens).toBe(100);
    const memRep = out.report.slots.find((s) => s.slot === 'topMemory')!;
    expect(memRep.usedTokens).toBe(200);
    expect(memRep.isProtected).toBe(false);
  });

  it('槽位顺序固定为 §28 的装配顺序（可断言）', () => {
    const e = engine();
    const out = e.assemble({
      budget: budget(),
      slots: {
        topMemory: [entry({ id: 'm', sourceRef: 's' })],
        system: [entry({ id: 's', sourceRef: 's2' })],
      },
    });
    const order = out.report.slots.map((s) => s.slot);
    expect(order.indexOf('system')).toBeLessThan(order.indexOf('topMemory'));
  });

  it('渲染文本按固定顺序分段', () => {
    const e = engine();
    const out = e.assemble({
      budget: budget(),
      slots: {
        topMemory: [entry({ id: 'm', sourceRef: 's', content: '记忆内容' })],
        system: [entry({ id: 's', sourceRef: 's2', content: '系统内容' })],
      },
    });
    expect(out.text.indexOf('## system')).toBeLessThan(out.text.indexOf('## topMemory'));
  });

  it('空槽位不出现在渲染文本里（不产生噪音）', () => {
    const e = engine();
    const out = e.assemble({ budget: budget(), slots: { system: [entry({ content: 'x' })] } });
    expect(out.text).not.toContain('## topMemory');
    expect(out.text).toContain('## system');
  });
});

describe('可注入的 token 计数与默认实现', () => {
  it('默认计数对中文按 1 字 1 token 估算', () => {
    expect(defaultTokenCounter.estimate('中文内容')).toBe(4);
  });

  it('默认计数对 ASCII 按 4 字符 1 token 估算', () => {
    expect(defaultTokenCounter.estimate('abcdefgh')).toBe(2);
  });

  it('空文本为 0', () => {
    expect(defaultTokenCounter.estimate('')).toBe(0);
  });

  it('可注入自定义计数（测试用精确计数）', () => {
    const e = engine();
    const out = e.assemble({
      budget: budget({ inputTokens: 100_000, outputReserveTokens: 100, protectedMaxTokens: 50_000 }),
      slots: { system: [entry({ content: '12345' })] },
    });
    expect(out.report.protectedTokens).toBe(5);
  });
});
