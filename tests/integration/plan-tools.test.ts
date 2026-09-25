/**
 * chapter.plan / chapter.getPlan 工具测试（STEP 6）
 *
 * 重点：计划工具**不能**越界碰正文或已提交章节。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ToolRegistry, createAllTools } from '@nwa/harness';
import { ErrorCode } from '@nwa/core';
import type { ToolContext } from '@nwa/shared';
import { createTestProject, makeChapter, type TestProject } from './helpers.js';

let t: TestProject | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function ctx(permission: ToolContext['callerPermission'] = 'ADMIN'): ToolContext {
  return { runId: 'run_t', projectId: 'p', callerPermission: permission, emit: () => {} };
}

function registry(project: TestProject): ToolRegistry {
  const r = new ToolRegistry();
  for (const tool of createAllTools(project.repos)) r.register(tool);
  return r;
}

const validPlan = (n: number) => ({
  brief: {
    chapterNumber: n,
    purpose: '引入冲突',
    previousState: '平静',
    targetState: '冲突爆发',
    mainCharacters: ['张三'],
    hook: '门外传来脚步声',
  },
  scenes: [
    { sceneId: 's1', purpose: '开场', startState: '平静', endState: '警觉' },
  ],
});

describe('chapter.plan', () => {
  it('工具已注册且权限为 PROPOSE_WRITE', () => {
    t = createTestProject();
    const reg = registry(t);
    const tool = reg.list().find((x) => x.name === 'chapter.plan');
    expect(tool).toBeDefined();
    expect(tool!.permission).toBe('PROPOSE_WRITE');
  });

  it('保存合法计划', async () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    const r = await registry(t).invoke(
      'chapter.plan',
      { chapterId: c.id, plan: validPlan(1) },
      ctx(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.data as { sceneCount: number; saved: boolean };
      expect(d.sceneCount).toBe(1);
      expect(d.saved).toBe(true);
    }
  });

  it('计划确实落库并可读回', async () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    const reg = registry(t);
    await reg.invoke('chapter.plan', { chapterId: c.id, plan: validPlan(1) }, ctx());

    const r = await reg.invoke('chapter.getPlan', { chapterId: c.id }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.data as { plan: { brief: { purpose: string } } };
      expect(d.plan.brief.purpose).toBe('引入冲突');
    }
  });

  it('⚠ 拒绝不含 scene 的计划（schema 层）', async () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    const bad = { ...validPlan(1), scenes: [] };
    const r = await registry(t).invoke('chapter.plan', { chapterId: c.id, plan: bad }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/不符合 PlanOutput 契约/);
  });

  it('⚠ 拒绝章号不一致的计划', async () => {
    t = createTestProject();
    const c = makeChapter(t, 3);
    const r = await registry(t).invoke(
      'chapter.plan',
      { chapterId: c.id, plan: validPlan(7) }, // 声明第 7 章，但目标是第 3 章
      ctx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/与目标章节（3）不一致/);
  });

  it('expectedChapterNumber 不匹配时拒绝', async () => {
    t = createTestProject();
    const c = makeChapter(t, 2);
    const r = await registry(t).invoke(
      'chapter.plan',
      { chapterId: c.id, plan: validPlan(2), expectedChapterNumber: 5 },
      ctx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/与期望（5）不一致/);
  });

  it('缺少 plan 参数时报明确错误', async () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    const r = await registry(t).invoke('chapter.plan', { chapterId: c.id }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/缺少 plan 参数/);
  });

  it('⚠ 拒绝为已提交章节覆盖计划', async () => {
    t = createTestProject();
    const c = makeChapter(t, 1, 'COMMITTING');
    t.repos.chapters.setCommittedBody(c.id, 'chapters/001.md', '摘要');

    const r = await registry(t).invoke(
      'chapter.plan',
      { chapterId: c.id, plan: validPlan(1) },
      ctx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(ErrorCode.COMMIT_FAILED);
      expect(r.error.message).toMatch(/拒绝为已提交\/提交中的章节覆盖计划/);
    }
  });

  it('⚠ 计划工具不写正文路径（权限边界）', async () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    await registry(t).invoke('chapter.plan', { chapterId: c.id, plan: validPlan(1) }, ctx());

    const after = t.repos.chapters.get(c.id);
    expect(after.body_path).toBeNull(); // 正文路径仍为空
    expect(after.status).toBe('DRAFT'); // 状态未变
    expect(after.plan_json).not.toBeNull(); // 只有计划被写入
  });

  it('PROPOSE_WRITE 权限可调用（planner 的权限上限）', async () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    const r = await registry(t).invoke(
      'chapter.plan',
      { chapterId: c.id, plan: validPlan(1) },
      ctx('PROPOSE_WRITE'),
    );
    expect(r.ok).toBe(true);
  });

  it('READ 权限被拒绝', async () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    const r = await registry(t).invoke(
      'chapter.plan',
      { chapterId: c.id, plan: validPlan(1) },
      ctx('READ'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ErrorCode.TOOL_PERMISSION_DENIED);
  });
});

describe('chapter.getPlan', () => {
  it('无计划时返回 null（而不是报错）', async () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    const r = await registry(t).invoke('chapter.getPlan', { chapterId: c.id }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { plan: unknown }).plan).toBeNull();
  });

  it('READ 权限即可读取', async () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    const reg = registry(t);
    await reg.invoke('chapter.plan', { chapterId: c.id, plan: validPlan(1) }, ctx());
    const r = await reg.invoke('chapter.getPlan', { chapterId: c.id }, ctx('READ'));
    expect(r.ok).toBe(true);
  });

  it('章节不存在时报错', async () => {
    t = createTestProject();
    const r = await registry(t).invoke('chapter.getPlan', { chapterId: 'nope' }, ctx());
    expect(r.ok).toBe(false);
  });
});

describe('工具总数（STEP 20 后）', () => {
  it('工具总数随 STEP 递增（当前 33）', () => {
    t = createTestProject();
    const names = registry(t).list().map((x) => x.name);
    // STEP 20 新增 book.{create,list} 与 character.{create,list,update}
    // P2-4c 新增 character.remove（角色此前只能加不能改不能删）
    // P0-5 新增 timeline.{addEvent,check}
    // P2-3 新增 world.{create,list,update,remove}
    expect(names).toHaveLength(33);
    expect(names).toContain('chapter.plan');
    expect(names).toContain('chapter.getPlan');
    expect(names).toContain('timeline.addEvent');
    expect(names).toContain('timeline.check');
    expect(names).toContain('world.create');
    expect(names).toContain('world.list');
  });

  it('权限报告：PROPOSE_WRITE 类含 plan 工具', () => {
    t = createTestProject();
    const report = registry(t).permissionReport();
    expect(report.PROPOSE_WRITE).toContain('chapter.plan');
    expect(report.WRITE).toContain('chapter.create');
  });
});
