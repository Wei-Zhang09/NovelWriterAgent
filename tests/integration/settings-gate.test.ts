/**
 * 设定确认门禁（P2-3）
 *
 * ## 这个缺陷长什么样
 *
 * `world_entities` 表在 `0001_init.sql:214` 就建好了，但**全仓零引用**
 * （P2-3 核查：0 次）—— 没有仓储、没有工具、没有界面。
 * ADR-0003 当时列为「Schema 预留，MVP 不写入」，到 Full 阶段就成了
 * "表在那里，没人用"。与 timeline（P0-5）、characters（P2-2）同一类。
 *
 * ## 门禁为什么需要"指纹"而不是布尔量
 *
 * 只存 `confirmed = true` 的话，"确认后又改了设定"这个状态无法表达 ——
 * 除非每个写设定的入口都记得把标记清掉。那是"靠流程纪律维持的一致性"，
 * 新增一个入口就漏。存指纹则是**读时判定**：任何入口改了设定，
 * 指纹自然对不上，不需要任何入口配合。
 *
 * ## 测试重点
 *
 * 1. 判定表穷举（5 种情形）
 * 2. ⚠ 「确认」这个动作本身不能把指纹弄失效（否则门禁永远拦自己）
 * 3. 排序无关：编辑顺序变化不该被判成"改过"
 * 4. 仓储层：确认 → 改设定 → 指纹对不上
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateSettingsGate,
  hashSettings,
  hashAfterConfirm,
  allConfirmed,
  type SettingsSnapshotEntry,
} from '@nwa/core';

function entry(over: Partial<SettingsSnapshotEntry> = {}): SettingsSnapshotEntry {
  return {
    type: 'WORLD_RULE',
    name: '灵力枯竭',
    description: '施法消耗寿命',
    status: 'DRAFT',
    ...over,
  };
}

describe('设定内容指纹', () => {
  it('相同内容 → 相同指纹', () => {
    expect(hashSettings([entry()])).toBe(hashSettings([entry()]));
  });

  it('内容不同 → 指纹不同', () => {
    expect(hashSettings([entry()])).not.toBe(
      hashSettings([entry({ description: '施法消耗寿命（改）' })]),
    );
  });

  it('改名 → 指纹不同', () => {
    expect(hashSettings([entry()])).not.toBe(hashSettings([entry({ name: '灵力稀缺' })]));
  });

  it('改类型 → 指纹不同', () => {
    expect(hashSettings([entry()])).not.toBe(
      hashSettings([entry({ type: 'LOCATION' })]),
    );
  });

  it('⚠ 编辑顺序无关（排序后再哈希）', () => {
    // 作者改名排序、或从别处导入顺序不同，都算"同一套设定" ——
    // 否则门禁会因为无关操作误判成"改过设定"，作者会失去对它的信任。
    const a = entry({ name: '甲' });
    const b = entry({ name: '乙' });
    const c = entry({ name: '丙' });
    expect(hashSettings([a, b, c])).toBe(hashSettings([c, a, b]));
  });

  it('增删条目 → 指纹不同', () => {
    expect(hashSettings([entry()])).not.toBe(hashSettings([entry(), entry({ name: '乙' })]));
  });

  it('空列表有稳定指纹（不抛错）', () => {
    expect(hashSettings([])).toBe(hashSettings([]));
  });

  it('status 参与指纹', () => {
    expect(hashSettings([entry({ status: 'DRAFT' })])).not.toBe(
      hashSettings([entry({ status: 'CONFIRMED' })]),
    );
  });
});

describe('⚠ hashAfterConfirm：确认动作本身不能让指纹失效', () => {
  it('确认后按 CONFIRMED 计算 → 与确认时存的一致', () => {
    // 若确认时存"确认前（DRAFT）"的指纹，那么确认完 status 变成 CONFIRMED，
    // 校验时算出来的指纹就对不上 → 门禁永远拦着自己，作者永远写不了。
    const entries = [entry({ status: 'DRAFT' })];
    const stored = hashAfterConfirm(entries);
    const afterConfirm = [{ ...entries[0]!, status: 'CONFIRMED' as const }];
    expect(hashSettings(afterConfirm)).toBe(stored);
  });

  it('多条目同样成立', () => {
    const entries = [entry({ name: '甲' }), entry({ name: '乙' })];
    const stored = hashAfterConfirm(entries);
    const after = entries.map((e) => ({ ...e, status: 'CONFIRMED' as const }));
    expect(hashSettings(after)).toBe(stored);
  });

  it('⚠ 确认后改了内容 → 指纹仍然对不上（门禁仍生效）', () => {
    // hashAfterConfirm 只统一 status，不能把内容变化也抹掉 ——
    // 否则"确认后偷偷改设定"就绕过了门禁。
    const stored = hashAfterConfirm([entry()]);
    const tampered = [{ ...entry(), description: '改了', status: 'CONFIRMED' as const }];
    expect(hashSettings(tampered)).not.toBe(stored);
  });
});

describe('门禁判定表', () => {
  const base = { gateEnabled: true, confirmedHash: 'abc', currentHash: 'abc', entryCount: 1 };

  it('门禁关闭 → 放行（不论设定状态）', () => {
    const r = evaluateSettingsGate({ ...base, gateEnabled: false, confirmedHash: null });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('GATE_DISABLED');
  });

  it('没有设定 → 放行', () => {
    // ⚠ 刻意的，不是遗漏：本项目允许"直接生成后由用户修改确认"的流程。
    //   无条件要求先写设定会把那条路径堵死。
    const r = evaluateSettingsGate({ ...base, entryCount: 0, confirmedHash: null });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('NO_SETTINGS');
  });

  it('有设定 + 从未确认 → 拦', () => {
    const r = evaluateSettingsGate({ ...base, confirmedHash: null });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('NEVER_CONFIRMED');
    expect(r.message).toContain('尚未确认');
  });

  it('有设定 + 确认过 + 指纹一致 → 放行', () => {
    const r = evaluateSettingsGate(base);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('CONFIRMED');
  });

  it('⚠ 有设定 + 确认过但改动过 → 拦', () => {
    const r = evaluateSettingsGate({ ...base, confirmedHash: 'old', currentHash: 'new' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('CHANGED_SINCE_CONFIRM');
    expect(r.message).toContain('修改');
  });

  it('门禁关闭时即使设定了也不拦', () => {
    const r = evaluateSettingsGate({ ...base, gateEnabled: false, confirmedHash: 'old', currentHash: 'new' });
    expect(r.allowed).toBe(true);
  });

  it('无设定时即使 confirmedHash 有值也放行（设定被删光的情形）', () => {
    const r = evaluateSettingsGate({ ...base, entryCount: 0 });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('NO_SETTINGS');
  });

  it('每种判定都给出可读的 message（不能是空串）', () => {
    for (const input of [
      { ...base, gateEnabled: false },
      { ...base, entryCount: 0 },
      { ...base, confirmedHash: null },
      base,
      { ...base, confirmedHash: 'old' },
    ]) {
      const r = evaluateSettingsGate(input);
      expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

describe('allConfirmed', () => {
  it('全 CONFIRMED → true', () => {
    expect(allConfirmed([{ status: 'CONFIRMED' }, { status: 'CONFIRMED' }])).toBe(true);
  });

  it('⚠ 部分确认 → false（不做"至少一条"的模糊判定）', () => {
    expect(allConfirmed([{ status: 'CONFIRMED' }, { status: 'DRAFT' }])).toBe(false);
  });

  it('空列表 → false（没有设定谈不上"全确认"）', () => {
    expect(allConfirmed([])).toBe(false);
  });
});
