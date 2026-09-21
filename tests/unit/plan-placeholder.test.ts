/**
 * 计划占位符检测测试（实测 bug）
 *
 * ## 触发这组测试的真实输出
 *
 * 模型在上下文不足（80 tokens）时产出了这样一份计划：
 *
 *   钩子：待确认：章末钩子，例如主角发现了一个改变现状的关键物品或信息
 *   角色：待确认：主角姓名
 *   状态：待确认：主角的初始处境与状态。 → 待确认：…
 *
 * 结构完备、schema 通过、语义校验（旧版）也通过 —— 但**没有任何创作决定**。
 * 这种计划传给 Writer 等于没给方向，写出来的东西必然空转。
 *
 * 所以要在语义层拦下（而不是只靠 prompt 劝阻：prompt 会失效，校验不会）。
 */
import { describe, it, expect } from 'vitest';
import { PlanOutputSchema, validatePlanSemantics, splitPlanIssues, findPlaceholders } from '@nwa/shared';

const basePlan = () => ({
  brief: {
    chapterNumber: 1,
    purpose: '确立故事基调，引入主角',
    previousState: '主角的日常',
    targetState: '主角进入核心事件',
    mainCharacters: ['张三'],
    hook: '他在账本里认出了父亲的字迹',
  },
  scenes: [
    { sceneId: 's1', purpose: '引入日常', startState: '平静', endState: '被打断' },
  ],
});

describe('⚠ 占位符必须被检出（实测：模型原样返回「待确认」）', () => {
  it('hook 里的「待确认」被检出', () => {
    const p = PlanOutputSchema.parse({
      ...basePlan(),
      brief: {
        ...basePlan().brief,
        hook: '待确认：章末钩子，例如主角发现了一个改变现状的关键物品或信息',
      },
    });
    const hits = findPlaceholders(p);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.field.includes('hook'))).toBe(true);
  });

  it('mainCharacters 里的「待确认：主角姓名」被检出', () => {
    const p = PlanOutputSchema.parse({
      ...basePlan(),
      brief: { ...basePlan().brief, mainCharacters: ['待确认：主角姓名'] },
    });
    expect(findPlaceholders(p).some((h) => h.field.includes('mainCharacters'))).toBe(true);
  });

  it('previousState / targetState 里的占位符被检出', () => {
    const p = PlanOutputSchema.parse({
      ...basePlan(),
      brief: {
        ...basePlan().brief,
        previousState: '待确认：主角的初始处境与状态。',
        targetState: '待确认：主角经历初始事件后的新处境与状态。',
      },
    });
    const fields = findPlaceholders(p).map((h) => h.field);
    expect(fields.some((f) => f.includes('previousState'))).toBe(true);
    expect(fields.some((f) => f.includes('targetState'))).toBe(true);
  });

  it('scene 里的占位符也被检出（不只查 brief）', () => {
    const p = PlanOutputSchema.parse({
      ...basePlan(),
      scenes: [{ sceneId: 's1', purpose: '待确认：本场景目的', endState: '已推进' }],
    });
    expect(findPlaceholders(p).some((h) => h.field.startsWith('scenes'))).toBe(true);
  });

  it('⚠ 占位符进入语义问题（进而触发自我修复）', () => {
    const p = PlanOutputSchema.parse({
      ...basePlan(),
      brief: { ...basePlan().brief, hook: '待确认：章末钩子' },
    });
    const issues = validatePlanSemantics(p);
    expect(issues.some((i) => i.includes('占位符'))).toBe(true);
  });

  it('⚠ 占位符是**阻塞**项而非提示（否则不会重试）', () => {
    const p = PlanOutputSchema.parse({
      ...basePlan(),
      brief: { ...basePlan().brief, hook: '待确认：章末钩子' },
    });
    const { blocking } = splitPlanIssues(validatePlanSemantics(p));
    expect(blocking.some((i) => i.includes('占位符'))).toBe(true);
  });
});

describe('各类占位符写法', () => {
  const withHook = (hook: string) =>
    PlanOutputSchema.parse({ ...basePlan(), brief: { ...basePlan().brief, hook } });

  it.each([
    ['待确认：xxx'],
    ['待定'],
    ['TODO: 稍后补充'],
    ['TBD'],
    ['待填写'],
    ['此处填写钩子'],
    ['（空）'],
    ['占位文本'],
    ['${hook}'],
  ])('检出 %s', (hook) => {
    expect(findPlaceholders(withHook(hook)).length).toBeGreaterThan(0);
  });

  it.each([
    ['他在账本里认出了父亲的字迹'],
    ['门外传来三下敲门声'],
    ['她终于说出了那个名字'],
    ['主角发现自己能听见亡者的低语'],
  ])('不误报具体的创作决定：%s', (hook) => {
    expect(findPlaceholders(withHook(hook))).toHaveLength(0);
  });

  it('⚠ 不误报含「确认」的正常用词（避免把「他确认了门锁」当占位符）', () => {
    // 只匹配「待确认」，不匹配「确认」
    expect(findPlaceholders(withHook('他确认了门已经锁好，才转身离开'))).toHaveLength(0);
    expect(findPlaceholders(withHook('经过确认，这是父亲的笔迹'))).toHaveLength(0);
  });

  it('不误报正常的「例如」以外的句子', () => {
    expect(findPlaceholders(withHook('他想起母亲常说的那句话，例如「别走夜路」'))).toHaveLength(0);
  });

  it('一个字段只报一次（避免同一字段刷屏）', () => {
    const p = PlanOutputSchema.parse({
      ...basePlan(),
      brief: { ...basePlan().brief, hook: '待确认：待定，TODO' },
    });
    const hookHits = findPlaceholders(p).filter((h) => h.field.includes('hook'));
    expect(hookHits).toHaveLength(1);
  });
});

describe('合法计划不受影响（不引入误报）', () => {
  it('正常计划无占位符、无语义问题', () => {
    const p = PlanOutputSchema.parse(basePlan());
    expect(findPlaceholders(p)).toHaveLength(0);
    expect(validatePlanSemantics(p)).toHaveLength(0);
  });

  it('既有语义规则仍然生效（占位符检测没有掩盖它们）', () => {
    const p = PlanOutputSchema.parse({
      ...basePlan(),
      scenes: [{ sceneId: 's1', purpose: 'p', startState: '同', endState: '同' }],
    });
    const issues = validatePlanSemantics(p);
    expect(issues.some((i) => i.includes('没有推进'))).toBe(true);
  });
});
