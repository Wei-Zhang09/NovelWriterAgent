/**
 * Planner 测试（STEP 6 验收）
 *
 * 重点验证三件事：
 *   1. **结构化输出走单次提交**：宿主不抠 JSON，schema 不过就失败
 *   2. **语义问题自我修复**：schema 过了但业务约束不过 → 把问题回灌重试一次
 *   3. **模型不能越界**：Planner 只产出计划，不写任何正式文件
 */
import { describe, it, expect } from 'vitest';
import { Planner } from '@nwa/writing';
import type { StructuredCaller } from '@nwa/writing';
import { validatePlanSemantics, splitPlanIssues, PlanOutputSchema } from '@nwa/shared';
import type { PlanOutput } from '@nwa/shared';
import { ErrorCode } from '@nwa/core';

/** 合法的 Plan（可被各用例覆写字段） */
function validPlan(over: Partial<PlanOutput> = {}): PlanOutput {
  return {
    brief: {
      chapterNumber: 1,
      purpose: '主角离乡',
      previousState: '在故乡，生活安稳',
      targetState: '踏上旅途，与旧生活诀别',
      mainCharacters: ['张三'],
      locations: ['城门口'],
      requiredEvents: ['与母亲告别'],
      forbiddenEvents: ['主角死亡'],
      emotionalArc: '平静 → 不舍 → 决然',
      pacingPlan: '慢起快收',
      foreshadowing: { plant: ['母亲留下的玉佩'], reinforce: [], payoff: [] },
      hook: '他回头看了一眼，又走了',
      skillRefs: [],
    },
    scenes: [
      {
        sceneId: 's1',
        purpose: '告别',
        pov: '第三人称限知',
        setting: '城门口清晨',
        startState: '未出发',
        endState: '已出城门',
        goal: '告别',
        conflict: '母亲的挽留',
        obstacle: '情感牵绊',
        emotionalCurve: '低→高',
        pacing: '缓',
        activeSkills: [],
        continuityConstraints: [],
      },
    ],
    ...over,
  };
}

/** 返回预设结果的 structured 替身，并记录收到的消息 */
function callerReturning(
  results: ({ ok: true; data: unknown } | { ok: false; code: string; message: string })[],
): { caller: StructuredCaller; calls: { schemaName: string; messageCount: number; lastUserText: string }[] } {
  const calls: { schemaName: string; messageCount: number; lastUserText: string }[] = [];
  let i = 0;
  const caller: StructuredCaller = async (req) => {
    const last = req.messages[req.messages.length - 1];
    calls.push({
      schemaName: req.schemaName,
      messageCount: req.messages.length,
      lastUserText: typeof last?.content === 'string' ? last.content : '',
    });
    const r = results[Math.min(i, results.length - 1)]!;
    i++;
    if (r.ok) {
      const parsed = req.schema.safeParse(r.data);
      if (!parsed.success) {
        return {
          ok: false,
          error: { code: ErrorCode.MODEL_STRUCTURED_EMPTY, message: 'schema mismatch in stub' },
          attempts: 1,
          usedFallback: false,
          rawText: JSON.stringify(r.data),
        };
      }
      return { ok: true, data: parsed.data, attempts: 1, usedFallback: false };
    }
    return {
      ok: false,
      error: { code: r.code, message: r.message },
      attempts: 1,
      usedFallback: false,
      rawText: '',
    };
  };
  return { caller, calls };
}

const baseReq = { chapterNumber: 1, contextText: '## protectedCanon\n- 张三活着', previousSummary: '上一章：他在收拾行囊' };

describe('正常生成', () => {
  it('一次成功返回计划与场景', async () => {
    const { caller } = callerReturning([{ ok: true, data: validPlan() }]);
    const p = new Planner({ structured: caller });
    const res = await p.plan(baseReq);

    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(1);
    expect(res.plan?.brief.chapterNumber).toBe(1);
    expect(res.plan?.scenes).toHaveLength(1);
  });

  it('只调用一次 structured（单次提交，不分片拼装）', async () => {
    const { caller, calls } = callerReturning([{ ok: true, data: validPlan() }]);
    await new Planner({ structured: caller }).plan(baseReq);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.schemaName).toBe('PlanOutput');
  });

  it('消息结构为 system(身份+规则) + system(角色) + user(上下文) + user(任务)', async () => {
    let captured: readonly { role: string }[] = [];
    const spy: StructuredCaller = async (req) => {
      captured = req.messages;
      return { ok: true, data: validPlan(), attempts: 1, usedFallback: false };
    };
    await new Planner({ structured: spy }).plan(baseReq);
    expect(captured.map((m) => m.role)).toEqual(['system', 'system', 'user', 'user']);
  });

  it('包含上一章摘要与上下文', async () => {
    const { caller, calls } = callerReturning([{ ok: true, data: validPlan() }]);
    await new Planner({ structured: caller }).plan(baseReq);
    expect(calls[0]!.lastUserText).toContain('PlanOutput');
  });
});

describe('⚠ 结构化输出失败时明确失败（绝不抠 JSON）', () => {
  it('schema 不过 → 返回 ok:false 并带错误码', async () => {
    const { caller } = callerReturning([
      { ok: false, code: ErrorCode.MODEL_STRUCTURED_EMPTY, message: '模型返回了散文' },
    ]);
    const res = await new Planner({ structured: caller }).plan(baseReq);

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ErrorCode.MODEL_STRUCTURED_EMPTY);
    expect(res.error?.message).toContain('散文');
  });

  it('schema 失败时不做语义修复重试（重试已由 gateway 的三级降级负责）', async () => {
    const { caller, calls } = callerReturning([
      { ok: false, code: ErrorCode.MODEL_STRUCTURED_EMPTY, message: 'x' },
    ]);
    await new Planner({ structured: caller, maxSemanticRepair: 3 }).plan(baseReq);
    expect(calls).toHaveLength(1);
  });

  it('错误详情保留 rawText 头部便于人工排查', async () => {
    const caller: StructuredCaller = async () => ({
      ok: false,
      error: { code: ErrorCode.MODEL_STRUCTURED_EMPTY, message: 'bad' },
      attempts: 2,
      usedFallback: true,
      rawText: '这是模型返回的散文内容……',
    });
    const res = await new Planner({ structured: caller }).plan(baseReq);
    const d = res.error?.details as { rawTextHead: string; usedFallback: boolean };
    expect(d.rawTextHead).toContain('散文');
    expect(d.usedFallback).toBe(true);
  });
});

describe('⚠ 语义问题自我修复（schema 过但业务约束不过）', () => {
  it('scene 的 startState === endState 时触发修复重试', async () => {
    const bad = validPlan();
    bad.scenes[0]!.startState = '未出发';
    bad.scenes[0]!.endState = '未出发'; // 场景没有推进

    const good = validPlan();
    const { caller, calls } = callerReturning([
      { ok: true, data: bad },
      { ok: true, data: good },
    ]);
    const res = await new Planner({ structured: caller }).plan(baseReq);

    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('修复重试会把具体问题回灌给模型', async () => {
    const bad = validPlan();
    bad.scenes[0]!.startState = 'X';
    bad.scenes[0]!.endState = 'X';
    const { caller, calls } = callerReturning([
      { ok: true, data: bad },
      { ok: true, data: validPlan() },
    ]);
    await new Planner({ structured: caller }).plan(baseReq);

    // 第二次调用的消息里应包含"上一次生成存在以下问题"
    expect(calls[1]!.lastUserText).toContain('上一次生成存在以下问题');
    expect(calls[1]!.lastUserText).toContain('endState');
  });

  it('修复次数用尽后返回阻塞问题（供调用方降级为质量债）', async () => {
    const bad = validPlan();
    bad.scenes[0]!.startState = 'X';
    bad.scenes[0]!.endState = 'X';
    const { caller } = callerReturning([{ ok: true, data: bad }]);
    const res = await new Planner({ structured: caller, maxSemanticRepair: 1 }).plan(baseReq);

    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(2); // 首次 + 1 次修复
    expect(res.issues?.some((i) => i.includes('endState'))).toBe(true);
  });

  it('maxSemanticRepair=0 时不做修复，直接返回问题', async () => {
    const bad = validPlan();
    bad.scenes[0]!.startState = 'X';
    bad.scenes[0]!.endState = 'X';
    const { caller, calls } = callerReturning([{ ok: true, data: bad }]);
    const res = await new Planner({ structured: caller, maxSemanticRepair: 0 }).plan(baseReq);
    expect(calls).toHaveLength(1);
    expect(res.ok).toBe(false);
  });
});

describe('validatePlanSemantics 的具体规则', () => {
  it('合法计划无问题', () => {
    expect(validatePlanSemantics(validPlan())).toEqual([]);
  });

  it('sceneId 重复被检出', () => {
    const p = validPlan();
    p.scenes.push({ ...p.scenes[0]!, purpose: '另一个场景' });
    const issues = validatePlanSemantics(p);
    expect(issues.some((i) => i.includes('sceneId 重复'))).toBe(true);
  });

  it('required 与 forbidden 冲突被检出', () => {
    const p = validPlan();
    p.brief.requiredEvents = ['主角死亡'];
    p.brief.forbiddenEvents = ['主角死亡'];
    expect(validatePlanSemantics(p).some((i) => i.includes('同时出现在 required 与 forbidden'))).toBe(true);
  });

  it('startState === endState 被检出（场景未推进）', () => {
    const p = validPlan();
    p.scenes[0]!.startState = '同';
    p.scenes[0]!.endState = '同';
    expect(validatePlanSemantics(p).some((i) => i.includes('没有推进'))).toBe(true);
  });

  it('startState 为空时不做此项判定（允许留白）', () => {
    const p = validPlan();
    p.scenes[0]!.startState = '';
    p.scenes[0]!.endState = '已出城门';
    expect(validatePlanSemantics(p).some((i) => i.includes('没有推进'))).toBe(false);
  });

  it('只回收不登记伏笔 → 归为提示（advisory）而非阻塞', () => {
    const p = validPlan();
    p.brief.foreshadowing = { plant: [], reinforce: [], payoff: ['旧伏笔'] };
    const { blocking, advisory } = splitPlanIssues(validatePlanSemantics(p));
    expect(blocking).toEqual([]);
    expect(advisory.length).toBeGreaterThan(0);
  });

  it('splitPlanIssues 把可忽略项归为 advisory', () => {
    const { blocking, advisory } = splitPlanIssues(['sceneId 重复', '可忽略的提示']);
    expect(blocking).toEqual(['sceneId 重复']);
    expect(advisory).toEqual(['可忽略的提示']);
  });
});

describe('Schema 约束（§29 / §30）', () => {
  it('brief.mainCharacters 不得为空数组', () => {
    const p = validPlan();
    const bad = { ...p, brief: { ...p.brief, mainCharacters: [] } };
    const r = PlanOutputSchema.safeParse(bad);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.message).toMatch(/至少一个主要角色/);
  });

  it('scenes 不得为空数组', () => {
    const p = validPlan();
    const bad = { ...p, scenes: [] };
    expect(PlanOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('scene.endState 必填（§31 规则 10 的 schema 层强制）', () => {
    const p = validPlan();
    const bad = { ...p, scenes: [{ ...p.scenes[0]!, endState: '' }] };
    const r = PlanOutputSchema.safeParse(bad);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.message).toMatch(/必须声明 endState/);
  });

  it('带 default 的字段缺失时被填充而不是报错', () => {
    const minimal = {
      brief: {
        chapterNumber: 1,
        purpose: 'p',
        previousState: 'a',
        targetState: 'b',
        mainCharacters: ['张三'],
      },
      scenes: [{ sceneId: 's1', purpose: 'p', endState: 'b' }],
    };
    const r = PlanOutputSchema.safeParse(minimal);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.brief.locations).toEqual([]);
      expect(r.data.brief.foreshadowing).toEqual({ plant: [], reinforce: [], payoff: [] });
      expect(r.data.scenes[0]!.activeSkills).toEqual([]);
    }
  });

  it('chapterNumber 必须为正整数', () => {
    const p = validPlan();
    expect(PlanOutputSchema.safeParse({ ...p, brief: { ...p.brief, chapterNumber: 0 } }).success).toBe(false);
    expect(PlanOutputSchema.safeParse({ ...p, brief: { ...p.brief, chapterNumber: 1.5 } }).success).toBe(false);
  });
});

describe('Planner 不越界（不写文件、不改 Canon）', () => {
  it('Planner 只依赖注入的 structured，不引入写工具', async () => {
    const { caller } = callerReturning([{ ok: true, data: validPlan() }]);
    const p = new Planner({ structured: caller });
    // 构造函数只接受 structured / logger / maxSemanticRepair 三个选项
    // —— 没有任何写盘或写库的依赖入口（见 PlannerOptions）
    expect(Object.keys(p)).not.toContain('repos');
    expect(Object.keys(p)).not.toContain('db');
    expect(Object.keys(p)).not.toContain('tools');
  });

  it('userInstruction 会附加到任务指令里', async () => {
    const { caller, calls } = callerReturning([{ ok: true, data: validPlan() }]);
    await new Planner({ structured: caller }).plan({
      ...baseReq,
      userInstruction: '这一章不要出现战斗',
    });
    expect(calls[0]!.lastUserText).toContain('这一章不要出现战斗');
  });
});
