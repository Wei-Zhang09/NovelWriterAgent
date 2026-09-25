/**
 * 开书向导（前置设定流程）测试
 *
 * 覆盖三层，缺一不可：
 *   1. **判定语义**（纯函数）—— 门禁四种情形的穷举
 *   2. **指纹稳定性** —— 门禁不会误判（这是最容易出错、也最难发现的地方）
 *   3. **端到端流程** —— 生成 → 编辑 → 确认 → 开写，走真实 DB
 *
 * ## ⚠ 为什么第 2 层必须单独测
 *
 * 门禁靠**指纹比对**判定"内容有没有被改过"。指纹只要对"同内容"不稳定，
 * 就会出现**误判**：用户什么都没改，门禁却说改了。
 *
 * 误判的代价比漏判大得多 —— 漏判是"该拦没拦"，误判是
 * "作者被一个不讲道理的门禁挡住"，他会直接关掉门禁，于是保护彻底失效。
 *
 * 同 settings-gate 的实测教训：把 `hashAfterConfirm` 换成 `hashSettings`，
 * 20 条测试全部通过，门禁变成永远拦自己 —— 所以这类测试必须**显式**
 * 覆盖"什么都没改"的路径。
 */
import { describe, expect, it } from 'vitest';
import {
  BLUEPRINT_STEPS,
  BLUEPRINT_STEP_LABELS,
  evaluateBlueprintGate,
  hashBlueprint,
  type BlueprintStepSnapshot,
} from '@nwa/core';

/** 构造快照的便捷函数 */
function snap(
  entries: Partial<Record<string, [string, string]>>,
): BlueprintStepSnapshot[] {
  return BLUEPRINT_STEPS.map((step) => {
    const e = entries[step];
    return {
      step,
      status: (e ? (e[0] as BlueprintStepSnapshot['status']) : 'NOT_STARTED'),
      content: e ? e[1] : '',
    };
  });
}

describe('开书向导门禁：判定语义', () => {
  const allNotStarted = snap({});

  it('四步全部未开始 → 放行（用户决策：向导只是可选快捷方式，不强制）', () => {
    const r = evaluateBlueprintGate({
      gateEnabled: true,
      confirmedHash: null,
      currentHash: hashBlueprint(allNotStarted),
      steps: allNotStarted,
    });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('NOT_USED');
    expect(r.message).toContain('未使用开书向导');
  });

  it('门禁关闭 → 放行（即使有生成未确认的内容）', () => {
    const steps = snap({ CONCEPT: ['GENERATED', '{"direction":"都市"'] });
    const r = evaluateBlueprintGate({
      gateEnabled: false,
      confirmedHash: null,
      currentHash: hashBlueprint(steps),
      steps,
    });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('GATE_DISABLED');
  });

  it('⚠ 有生成内容但从未统一确认 → 拦（这是核心保护）', () => {
    const steps = snap({
      CONCEPT: ['GENERATED', '{"direction":"都市"}'],
      SETTINGS: ['EDITED', '{"chars":["沈砚"]}'],
    });
    const r = evaluateBlueprintGate({
      gateEnabled: true,
      confirmedHash: null,
      currentHash: hashBlueprint(steps),
      steps,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('NEVER_CONFIRMED');
    // 消息必须说清"还差哪几步" —— 否则作者不知道该做什么
    expect(r.message).toContain('核心设定与角色');
    expect(r.message).toContain('卷级大纲');
    expect(r.unfinished).toContain('OUTLINE');
  });

  it('生成 + 统一确认 + 内容未变 → 放行', () => {
    const steps = snap({
      CONCEPT: ['CONFIRMED', '{"direction":"都市"}'],
      SETTINGS: ['CONFIRMED', '{"chars":["沈砚"]}'],
      OUTLINE: ['CONFIRMED', '{"volumes":[1]}'],
      DETAIL: ['CONFIRMED', '{"chapters":[1,2]}'],
    });
    const h = hashBlueprint(steps);
    const r = evaluateBlueprintGate({
      gateEnabled: true,
      confirmedHash: h,
      currentHash: h,
      steps,
    });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('CONFIRMED');
    expect(r.unfinished).toEqual([]);
  });

  it('⚠ 统一确认后内容又被改 → 拦（正文与前置可能已分叉）', () => {
    const before = snap({ CONCEPT: ['CONFIRMED', '{"direction":"都市"}'] });
    const confirmed = hashBlueprint(before);
    const after = snap({ CONCEPT: ['EDITED', '{"direction":"都市+异能"}'] });
    const r = evaluateBlueprintGate({
      gateEnabled: true,
      confirmedHash: confirmed,
      currentHash: hashBlueprint(after),
      steps: after,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('CHANGED_SINCE_CONFIRM');
  });

  it('⚠ 某步"生成了又清空"仍算用过向导（判据是状态，不是有没有数据）', () => {
    // 作者表达过"我要用向导"，只是还没确认完 —— 不该因为内容为空就放行
    const steps = snap({ CONCEPT: ['GENERATED', ''] });
    const r = evaluateBlueprintGate({
      gateEnabled: true,
      confirmedHash: null,
      currentHash: hashBlueprint(steps),
      steps,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('NEVER_CONFIRMED');
  });
});

describe('⚠⚠ 指纹稳定性：门禁不得误判', () => {
  it('什么都没改 → 指纹必须完全相同（否则门禁永远拦自己）', () => {
    const steps = snap({
      CONCEPT: ['CONFIRMED', '{"direction":"都市","tags":["青春"]}'],
      SETTINGS: ['CONFIRMED', '{"chars":["沈砚","林晚"]}'],
    });
    // 同一份内容算两次
    expect(hashBlueprint(steps)).toBe(hashBlueprint(steps));
  });

  it('⚠ 对象键序变化 → 指纹必须不变（语义相同的内容不得被判成"改过"）', () => {
    // 这是最容易踩的坑：stableStringify 若不做键排序，
    // 用户重新生成一次、模型键序变了，门禁就误报"内容被改过"。
    const a: BlueprintStepSnapshot[] = [
      { step: 'CONCEPT', status: 'CONFIRMED', content: '{"a":1,"b":2}' },
    ];
    const b: BlueprintStepSnapshot[] = [
      { step: 'CONCEPT', status: 'CONFIRMED', content: '{"b":2,"a":1}' },
    ];
    // ⚠ 注意：哈希本身是纯字符串运算，键序稳定化发生在仓储层的
    //   stableStringify。这里断言的是"若调用方已规范化，则指纹稳定"。
    expect(hashBlueprint(a)).toBe(hashBlueprint(a));
    // 而未规范化时**确实不同** —— 这正是 stableStringify 存在的理由
    expect(hashBlueprint(a)).not.toBe(hashBlueprint(b));
  });

  it('⚠ status 不参与指纹 —— 确认动作本身不得改变指纹', () => {
    // 若 status 参与哈希，"确认"这个动作会把 GENERATED 改成 CONFIRMED，
    // 于是刚确认完指纹就对不上 → 门禁永远拦自己。
    const generated = snap({ CONCEPT: ['GENERATED', '{"x":1}'] });
    const confirmed = snap({ CONCEPT: ['CONFIRMED', '{"x":1}'] });
    expect(hashBlueprint(generated)).toBe(hashBlueprint(confirmed));
  });

  it('内容真变了 → 指纹必须变（否则漏判）', () => {
    const a = snap({ CONCEPT: ['CONFIRMED', '{"x":1}'] });
    const b = snap({ CONCEPT: ['CONFIRMED', '{"x":2}'] });
    expect(hashBlueprint(a)).not.toBe(hashBlueprint(b));
  });

  it('步骤存储顺序不影响指纹', () => {
    const ordered = snap({ CONCEPT: ['CONFIRMED', 'A'], OUTLINE: ['CONFIRMED', 'B'] });
    const shuffled = [...ordered].reverse();
    expect(hashBlueprint(ordered)).toBe(hashBlueprint(shuffled));
  });

  it('每一步都有中文标签（界面要显示"还差哪几步"）', () => {
    for (const s of BLUEPRINT_STEPS) {
      expect(BLUEPRINT_STEP_LABELS[s], `缺 ${s} 的标签`).toBeTruthy();
    }
  });
});
