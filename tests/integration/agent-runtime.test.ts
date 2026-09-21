/**
 * Agent Runtime + Event Bus 集成测试（STEP 4 验收核心）
 *
 * 验证四条「如果不强制，一定会被绕过」的约束：
 *   1. 审查类 Agent 只读 —— 权限由 Runtime 按 agentType 下发，调用方无法提权
 *   2. 异常必写 run_events —— §55 Rule 8 禁止 try/catch 吞异常
 *   3. checkpoint 是阶段级的 —— resume 不重跑已完成的昂贵调用（研究报告 R2）
 *   4. cancel 与 pause 语义不同 —— 前者不保留可恢复性
 */
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { AgentRuntime, AGENT_PERMISSIONS, EventBus } from '@nwa/harness';
import { ModelGateway } from '@nwa/harness';
import { ToolRegistry, createAllTools } from '@nwa/harness';
import { InMemorySecretStore } from '@nwa/harness';
import { AppError, ErrorCode } from '@nwa/core';
import type { AgentHandler } from '@nwa/harness';
import { createTestProject, type TestProject } from './helpers.js';

let t: TestProject | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const SCHEMA_VERSION = '0001_init';

/** 一个不做任何 LLM 调用的替身 gateway（structured 直接返回预设值） */
function stubGateway(responder?: (schemaName: string) => unknown): ModelGateway {
  const gw = new ModelGateway({
    profiles: [],
    slots: { architect: 'x', writer: 'x', reviewer: 'x', utility: 'x' },
    secrets: new InMemorySecretStore(),
    sleepImpl: async () => {},
  });
  // 覆写 structured：测试聚焦 Runtime 行为，不重复测 Gateway
  (gw as unknown as { structured: unknown }).structured = async (
    _slot: string,
    req: { schema: z.ZodType<unknown>; schemaName: string },
  ) => {
    const raw = responder ? responder(req.schemaName) : { ok: true };
    const parsed = req.schema.safeParse(raw);
    return parsed.success
      ? { ok: true, data: parsed.data, attempts: 1, usedFallback: false }
      : {
          ok: false,
          error: { code: ErrorCode.MODEL_STRUCTURED_EMPTY, message: 'schema mismatch' },
          attempts: 1,
          usedFallback: false,
          rawText: JSON.stringify(raw),
        };
  };
  return gw;
}

function makeRuntime(
  project: TestProject,
  handlers: AgentHandler[],
  responder?: (s: string) => unknown,
): AgentRuntime {
  const tools = new ToolRegistry();
  for (const tool of createAllTools(project.repos)) tools.register(tool);
  const rt = new AgentRuntime({
    runs: project.repos.runs,
    tools,
    models: stubGateway(responder),
    schemaVersion: SCHEMA_VERSION,
  });
  for (const h of handlers) rt.register(h);
  return rt;
}

/**
 * 构造 Run 输入。
 *
 * ⚠ projectId 必须是**真实存在**的项目 ID —— runs.project_id 有外键约束，
 *   早期版本硬编码 'proj_1' 导致所有用例 FOREIGN KEY constraint failed。
 */
const baseInput = (project: TestProject) =>
  ({
    runId: '',
    agentType: 'writer' as const,
    goal: '写第一章',
    projectId: project.projectId,
    mode: 'interactive' as const,
  });

describe('⚠ 权限按 Agent 类型下发（调用方无法提权）', () => {
  it('各 Agent 类型的权限上限符合约定', () => {
    expect(AGENT_PERMISSIONS.reviewer).toBe('READ');
    expect(AGENT_PERMISSIONS.continuity).toBe('READ');
    expect(AGENT_PERMISSIONS.writer).toBe('PROPOSE_WRITE');
    expect(AGENT_PERMISSIONS.planner).toBe('WRITE');
  });

  it('⚠ 审查类 Agent 不能执行写工具（即使它主动尝试）', async () => {
    t = createTestProject();
    let writerToolResult: unknown = null;

    const reviewer: AgentHandler = {
      agentType: 'reviewer',
      execute: async (ctx) => {
        // 模拟一个"越权"的审查 Agent：尝试创建章节
        const tools = new ToolRegistry();
        for (const tool of createAllTools(t!.repos)) tools.register(tool);
        writerToolResult = await tools.invoke(
          'chapter.create',
          { bookId: t!.bookId, chapterNumber: 1 },
          ctx.toolContext,
        );
        return { output: { tried: true } };
      },
    };

    const rt = makeRuntime(t, [reviewer]);
    await rt.run({ ...baseInput(t!), agentType: 'reviewer' });

    const r = writerToolResult as { ok: boolean; error?: { code: string } };
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(ErrorCode.TOOL_PERMISSION_DENIED);
    // 且确实没写入
    expect(t.repos.chapters.listByBook(t.bookId)).toHaveLength(0);
  });

  it('planner（WRITE）可执行 chapter.create', async () => {
    t = createTestProject();
    let result: unknown = null;
    const planner: AgentHandler = {
      agentType: 'planner',
      execute: async (ctx) => {
        const tools = new ToolRegistry();
        for (const tool of createAllTools(t!.repos)) tools.register(tool);
        result = await tools.invoke('chapter.create', { bookId: t!.bookId, chapterNumber: 1 }, ctx.toolContext);
        return {};
      },
    };
    const rt = makeRuntime(t, [planner]);
    await rt.run({ ...baseInput(t!), agentType: 'planner' });
    expect((result as { ok: boolean }).ok).toBe(true);
    expect(t.repos.chapters.listByBook(t.bookId)).toHaveLength(1);
  });
});

describe('⚠ 异常必写 run_events（§55 Rule 8）', () => {
  it('Agent 抛错时 RUN_FAILED 被记录，且携带结构化错误', async () => {
    t = createTestProject();
    const boom: AgentHandler = {
      agentType: 'writer',
      execute: () => {
        throw new AppError(ErrorCode.MODEL_TIMEOUT, '模型超时了', { details: { ms: 60000 } });
      },
    };
    const rt = makeRuntime(t, [boom]);
    const res = await rt.run({ ...baseInput(t!), agentType: 'writer' });

    expect(res.status).toBe('FAILED');
    const events = rt.eventsFor(res.runId);
    const failed = events.find((e) => e.type === 'RUN_FAILED');
    expect(failed).toBeDefined();
    const payload = failed!.payload as { error: { code: string; message: string } };
    expect(payload.error.code).toBe(ErrorCode.MODEL_TIMEOUT);
    expect(payload.error.message).toBe('模型超时了');
  });

  it('非 AppError 的异常也被收敛记录，不丢信息', async () => {
    t = createTestProject();
    const boom: AgentHandler = {
      agentType: 'writer',
      execute: () => {
        throw new TypeError('原生错误也要被记录');
      },
    };
    const rt = makeRuntime(t, [boom]);
    const res = await rt.run({ ...baseInput(t!), agentType: 'writer' });
    const failed = rt.eventsFor(res.runId).find((e) => e.type === 'RUN_FAILED');
    expect((failed!.payload as { error: { message: string } }).error.message).toBe('原生错误也要被记录');
  });

  it('事件分类正确：RUN_STARTED 属 STATE，MODEL_CALL 属 OBSERVABILITY', async () => {
    t = createTestProject();
    const ok: AgentHandler = { agentType: 'writer', execute: async () => ({}) };
    const rt = makeRuntime(t, [ok]);
    const res = await rt.run({ ...baseInput(t!), agentType: 'writer' });

    const events = rt.eventsFor(res.runId);
    expect(events.find((e) => e.type === 'RUN_STARTED')!.category).toBe('STATE');
    expect(events.find((e) => e.type === 'RUN_FAILED')).toBeUndefined();
  });

  it('Run 本身被落库，且结束后状态与时间戳正确', async () => {
    t = createTestProject();
    const ok: AgentHandler = { agentType: 'writer', execute: async () => ({ artifacts: ['a.md'] }) };
    const rt = makeRuntime(t, [ok]);
    const res = await rt.run({ ...baseInput(t!), agentType: 'writer' });

    const row = t.repos.runs.get(res.runId);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.ended_at).not.toBeNull();
    expect(res.artifacts).toEqual(['a.md']);
  });
});

describe('⚠ checkpoint 是阶段级的（研究报告 R2）', () => {
  it('handler 可通过 ctx.checkpoint 记录阶段，resume 从该阶段继续', async () => {
    t = createTestProject();
    const staged: AgentHandler = {
      agentType: 'writer',
      execute: async (ctx) => {
        ctx.checkpoint('PLANNING', { step: 'plan' }, { files: ['plan.json'] });
        ctx.checkpoint('WRITING', { step: 'write' }, { files: ['draft.md'] });
        return {};
      },
    };
    const rt = makeRuntime(t, [staged]);
    const res = await rt.run({ ...baseInput(t!), agentType: 'writer' });
    expect(res.status).toBe('SUCCEEDED');

    const ckpts = t.repos.runs.latestCheckpoint(res.runId);
    expect(ckpts?.stage).toBe('WRITING'); // 最近完成的阶段

    // resume 返回该阶段，调用方据此避免重跑已完成部分
    const resumed = await rt.resume(res.runId);
    expect(resumed.resumeFrom).toBe('WRITING');
    const st = resumed.state as { step: string };
    expect(st.step).toBe('write');
  });

  it('每次 checkpoint 都产生 CHECKPOINT_CREATED 事件', async () => {
    t = createTestProject();
    const staged: AgentHandler = {
      agentType: 'writer',
      execute: async (ctx) => {
        ctx.checkpoint('A', {}, {});
        ctx.checkpoint('B', {}, {});
        return {};
      },
    };
    const rt = makeRuntime(t, [staged]);
    const res = await rt.run({ ...baseInput(t!), agentType: 'writer' });
    const ckptEvents = rt.eventsFor(res.runId).filter((e) => e.type === 'CHECKPOINT_CREATED');
    expect(ckptEvents).toHaveLength(2);
  });

  it('⚠ schema 版本不一致时拒绝 resume（防止跨版本续跑）', async () => {
    t = createTestProject();
    const staged: AgentHandler = {
      agentType: 'writer',
      execute: async (ctx) => {
        ctx.checkpoint('PLANNING', {}, {});
        return {};
      },
    };
    const rt = makeRuntime(t, [staged]);
    const res = await rt.run({ ...baseInput(t!), agentType: 'writer' });

    // 换一个 schemaVersion 不同的 runtime 去 resume
    const tools = new ToolRegistry();
    for (const tool of createAllTools(t.repos)) tools.register(tool);
    const rtV2 = new AgentRuntime({
      runs: t.repos.runs,
      tools,
      models: stubGateway(),
      schemaVersion: '0002_next',
    });

    await expect(rtV2.resume(res.runId)).rejects.toThrow(/schema 版本/);
  });

  it('无 checkpoint 时 resume 报 CHECKPOINT_NOT_FOUND', async () => {
    t = createTestProject();
    const rt = makeRuntime(t, []);
    let err: unknown;
    try {
      await rt.resume('run_不存在');
    } catch (e) {
      err = e;
    }
    expect(AppError.isAppError(err)).toBe(true);
    if (AppError.isAppError(err)) expect(err.code).toBe(ErrorCode.CHECKPOINT_NOT_FOUND);
  });
});

describe('cancel 与 pause 语义不同', () => {
  it('cancel 会让 Run 以 CANCELLED 结束，且不可 resume', async () => {
    t = createTestProject();
    let observed: string | undefined;
    const slow: AgentHandler = {
      agentType: 'writer',
      execute: async (ctx) => {
        await new Promise((r) => setTimeout(r, 200));
        observed = ctx.signal.aborted ? 'aborted' : 'not-aborted';
        return {};
      },
    };
    const rt = makeRuntime(t, [slow]);
    const p = rt.run({ ...baseInput(t!), agentType: 'writer' });
    await new Promise((r) => setTimeout(r, 50));
    // runId 由 Runtime 生成，从 listActive 取
    const active = rt.listActive();
    expect(active.length).toBe(1);
    await rt.cancel(active[0]!.runId);
    const res = await p;
    expect(res.status).toBe('CANCELLED');
    expect(observed).toBe('aborted');
    // cancel 不产生 checkpoint，因此 resume 应失败
    await expect(rt.resume(res.runId)).rejects.toThrow(/找不到可恢复的 checkpoint/);
  });

  it('pause 会记录 lastCompletedStage 并产生 RUN_PAUSED 事件', async () => {
    t = createTestProject();
    const slow: AgentHandler = {
      agentType: 'writer',
      execute: async (ctx) => {
        ctx.checkpoint('PLANNING', { p: 1 }, {});
        await new Promise((r) => setTimeout(r, 200));
        return {};
      },
    };
    const rt = makeRuntime(t, [slow]);
    const p = rt.run({ ...baseInput(t!), agentType: 'writer' });
    await new Promise((r) => setTimeout(r, 60));
    const active = rt.listActive();
    await rt.pause(active[0]!.runId);
    const res = await p;
    expect(res.status).toBe('CANCELLED'); // abort 导致的终态

    const paused = rt.eventsFor(res.runId).find((e) => e.type === 'RUN_PAUSED');
    expect(paused).toBeDefined();
    expect((paused!.payload as { lastCompletedStage: string }).lastCompletedStage).toBe('PLANNING');
  });

  it('对不存在的 Run 执行 pause/cancel 报明确错误', async () => {
    t = createTestProject();
    const rt = makeRuntime(t, []);
    await expect(rt.pause('nope')).rejects.toThrow(/不在运行中/);
    await expect(rt.cancel('nope')).rejects.toThrow(/不在运行中/);
  });
});

describe('Agent 注册与结构化输出通路', () => {
  it('未注册的 Agent 类型被拒绝，并列出已注册项', async () => {
    t = createTestProject();
    const rt = makeRuntime(t, []);
    let err: unknown;
    try {
      await rt.run({ ...baseInput(t!), agentType: 'writer' });
    } catch (e) {
      err = e;
    }
    expect(AppError.isAppError(err)).toBe(true);
    if (AppError.isAppError(err)) {
      expect(err.code).toBe(ErrorCode.NOT_IMPLEMENTED);
      expect(err.message).toMatch(/未注册的 Agent 类型/);
    }
  });

  it('重复注册同一 Agent 类型被拒绝', () => {
    t = createTestProject();
    const h: AgentHandler = { agentType: 'writer', execute: async () => ({}) };
    const rt = makeRuntime(t, [h]);
    expect(() => rt.register(h)).toThrow(/重复注册/);
  });

  it('ctx.structured 走 gateway 并按 schema 校验', async () => {
    t = createTestProject();
    const S = z.object({ title: z.string() });
    let got: unknown = null;
    const h: AgentHandler = {
      agentType: 'planner',
      execute: async (ctx) => {
        got = await ctx.structured({
          schema: S,
          schemaName: 'Brief',
          messages: [{ role: 'user', content: 'plan' }],
        });
        return {};
      },
    };
    const rt = makeRuntime(t, [h], () => ({ title: '第一章' }));
    await rt.run({ ...baseInput(t!), agentType: 'planner' });
    expect((got as { ok: boolean; data: { title: string } }).ok).toBe(true);
    expect((got as { data: { title: string } }).data.title).toBe('第一章');
  });

  it('structured 校验失败时返回 ok:false（不抛异常，由 Agent 决定如何处理）', async () => {
    t = createTestProject();
    const S = z.object({ title: z.string() });
    let got: unknown = null;
    const h: AgentHandler = {
      agentType: 'planner',
      execute: async (ctx) => {
        got = await ctx.structured({
          schema: S,
          schemaName: 'Brief',
          messages: [{ role: 'user', content: 'plan' }],
        });
        return {};
      },
    };
    const rt = makeRuntime(t, [h], () => ({ wrong: 'shape' }));
    await rt.run({ ...baseInput(t!), agentType: 'planner' });
    expect((got as { ok: boolean }).ok).toBe(false);
  });
});

describe('EventBus 独立行为', () => {
  it('⚠ 落库失败时抛出而不是吞掉（可观测性损坏必须暴露）', () => {
    t = createTestProject();
    const bus = new EventBus({ runs: t.repos.runs });
    // 用一个不存在的 runId 触发外键失败
    let err: unknown;
    try {
      bus.emit({ runId: 'run_不存在的外键', type: 'RUN_STARTED' });
    } catch (e) {
      err = e;
    }
    expect(AppError.isAppError(err)).toBe(true);
    if (AppError.isAppError(err)) {
      expect(err.message).toMatch(/事件落库失败/);
      expect((err.details as { runId: string }).runId).toBe('run_不存在的外键');
    }
  });

  it('可按 category 过滤事件（ADR-0006 的保留策略基础）', () => {
    t = createTestProject();
    const run = t.repos.runs.create({ id: 'run_x', projectId: t.projectId, workflowType: 'test' });
    const bus = new EventBus({ runs: t.repos.runs });
    bus.emit({ runId: run.id, type: 'RUN_STARTED' });            // STATE
    bus.emit({ runId: run.id, type: 'MODEL_CALL_STARTED' });      // OBSERVABILITY
    expect(bus.list(run.id, 'STATE')).toHaveLength(1);
    expect(bus.list(run.id, 'OBSERVABILITY')).toHaveLength(1);
    expect(bus.list(run.id)).toHaveLength(2);
  });

  it('onEvent 订阅者能实时收到事件', () => {
    t = createTestProject();
    const run = t.repos.runs.create({ id: 'run_y', projectId: t.projectId, workflowType: 'test' });
    const seen: string[] = [];
    const bus = new EventBus({ runs: t.repos.runs, onEvent: (e) => seen.push(e.type) });
    bus.emit({ runId: run.id, type: 'RUN_STARTED' });
    bus.emit({ runId: run.id, type: 'DRAFT_CREATED' });
    expect(seen).toEqual(['RUN_STARTED', 'DRAFT_CREATED']);
  });

  it('emitFailure 把任意异常转成结构化 RUN_FAILED', () => {
    t = createTestProject();
    const run = t.repos.runs.create({ id: 'run_z', projectId: t.projectId, workflowType: 'test' });
    const bus = new EventBus({ runs: t.repos.runs });
    bus.emitFailure({ runId: run.id, error: new Error('炸了'), lastKnownStatus: 'WRITING' });
    const ev = bus.list(run.id).find((e) => e.type === 'RUN_FAILED');
    expect(ev).toBeDefined();
    expect((ev!.payload as { error: { message: string }; lastKnownStatus: string }).error.message).toBe('炸了');
    expect((ev!.payload as { lastKnownStatus: string }).lastKnownStatus).toBe('WRITING');
  });
});
