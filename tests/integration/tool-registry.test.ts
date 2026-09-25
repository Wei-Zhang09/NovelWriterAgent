/**
 * Tool Registry 集成测试（STEP 2 验收核心）
 *
 * 重点验证 Registry 的四道关卡，以及 InkOS 因缺这些能力而审计困难的问题
 * （研究报告 §1.3 差异 1）。工具数随 STEP 递增：STEP 2 为 8 个，STEP 6 起为 10 个。
 * 关卡：
 *   1. 存在性   —— 未注册工具被拒
 *   2. 权限     —— 显式分级，单点判定（不靠"工具在不在数组里"）
 *   3. 输入校验 —— schema 不通过即拒绝，不进入 execute
 *   4. 输出校验 —— 不信任工具自己返回的结构
 */
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, createAllTools } from '@nwa/harness';
import { AppError, ErrorCode } from '@nwa/core';
import type { ToolContext, ToolDefinition } from '@nwa/shared';
import { createTestProject, type TestProject } from './helpers.js';

let t: TestProject | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    runId: 'run_test',
    projectId: 'proj_test',
    callerPermission: 'ADMIN',
    emit: () => {},
    ...overrides,
  };
}

function makeRegistry(repos: NonNullable<TestProject['repos']>): ToolRegistry {
  const reg = new ToolRegistry();
  for (const tool of createAllTools(repos)) reg.register(tool);
  return reg;
}

describe('注册', () => {
  it('注册全部工具（按前缀分组断言，抓漏注册）', () => {
    t = createTestProject();
    const reg = makeRegistry(t.repos);
    const names = reg.list().map((x) => x.name);

    // 按前缀分组 —— 比"总数等于 N"更能定位"哪个工具没注册上"
    const byPrefix = (p: string) => names.filter((n) => n.startsWith(p)).sort();
    expect(byPrefix('project.')).toEqual([
      'project.create', 'project.get', 'project.list', 'project.update',
    ]);
    expect(byPrefix('chapter.')).toEqual([
      'chapter.countCommitted', 'chapter.create', 'chapter.get',
      'chapter.getPlan', 'chapter.list', 'chapter.plan',
    ]);
    expect(byPrefix('continuity.')).toEqual(['continuity.check', 'continuity.dimensions']);
    expect(byPrefix('review.')).toEqual(['review.categories', 'review.get', 'review.run']);
    expect(byPrefix('fact.')).toEqual(['fact.add', 'fact.get', 'fact.promote', 'fact.search']);
    expect(byPrefix('evidence.')).toEqual(['evidence.add', 'evidence.get']);
    // STEP 20 补的前缀：book / character（§52 Test A 要求 add character，
    // 而工具层此前完全没有 character.* 与 book.*）
    expect(byPrefix('book.')).toEqual(['book.create', 'book.list']);
    expect(byPrefix('character.')).toEqual([
      'character.create', 'character.list', 'character.remove', 'character.update',
    ]);
    // P0-5 补的前缀：timeline（timeline_events 表早已存在，
    // 但此前全仓无代码使用、也没有任何工具暴露 —— 与 character.* 同类缺陷）
    expect(byPrefix('timeline.')).toEqual(['timeline.addEvent', 'timeline.check']);
    // P2-3 补的前缀：world（world_entities 表在 0001_init.sql:214 就建好了，
    // 但全仓零引用 —— 与 timeline.* / character.* 同类缺陷）
    expect(byPrefix('world.')).toEqual([
      'world.create', 'world.list', 'world.remove', 'world.update',
    ]);
    expect(names).toHaveLength(33);
  });

  it('拒绝重复注册（静默覆盖会让"注册了哪个版本"不可知）', () => {
    t = createTestProject();
    const reg = makeRegistry(t.repos);
    const dup: ToolDefinition<{ id: string }, unknown> = {
      name: 'project.get',
      description: 'dup', inputSchema: z.object({ id: z.string() }),
      outputSchema: z.unknown(), permission: 'READ', errorCodes: ['X'],
      execute: () => ({}),
    };
    expect(() => reg.register(dup)).toThrow(/工具名重复注册/);
  });

  it('拒绝不合规的工具名', () => {
    t = createTestProject();
    const reg = new ToolRegistry();
    const bad: ToolDefinition<Record<string, never>, unknown> = {
      name: 'BadName', description: 'x', inputSchema: z.object({}),
      outputSchema: z.unknown(), permission: 'READ', errorCodes: ['X'], execute: () => ({}),
    };
    expect(() => reg.register(bad)).toThrow(/namespace\.action/);
  });

  it('⚠ 拒绝未声明错误码的工具（§55 Rule 4）', () => {
    t = createTestProject();
    const reg = new ToolRegistry();
    const noCodes: ToolDefinition<Record<string, never>, unknown> = {
      name: 'a.b', description: 'x', inputSchema: z.object({}),
      outputSchema: z.unknown(), permission: 'READ', errorCodes: [], execute: () => ({}),
    };
    expect(() => reg.register(noCodes)).toThrow(/必须声明可能的错误码/);
  });

  it('权限报告按级别归类（InkOS 缺此能力导致审计困难）', () => {
    t = createTestProject();
    const report = makeRegistry(t.repos).permissionReport();
    expect(report.READ).toEqual([
      'book.list', 'chapter.countCommitted', 'chapter.get', 'chapter.getPlan',
      'chapter.list', 'character.list', 'continuity.check', 'continuity.dimensions',
      'evidence.get', 'fact.get', 'fact.search', 'project.get', 'project.list',
      'review.categories', 'review.get',
      // P0-5：检查时间线是只读的（"只想看看有没有问题"不该需要写权限）
      'timeline.check',
      // P2-3：看设定是只读的（作者翻看设定不该需要写权限）
      'world.list',
    ]);
    // STEP 20：book.create / character.create / character.update 都是写入
    // P0-5：登记时间线事件是写入
    // P2-3：设定增删改都是写入（⚠ world.remove 也是 —— 删除设定会改变
    //       门禁指纹，等于改变了 Agent 的写作依据，不是无害操作）
    expect(report.WRITE).toEqual([
      'book.create', 'chapter.create', 'character.create', 'character.remove',
      'character.update',
      'project.create', 'project.update', 'timeline.addEvent',
      'world.create', 'world.remove', 'world.update',
    ]);
    // 计划与审阅都是"提议"，不是"提交"，故归 PROPOSE_WRITE
    expect(report.PROPOSE_WRITE).toEqual(['chapter.plan', 'evidence.add', 'fact.add', 'review.run']);
    // Canon 提升是不可逆的权威操作，权限门槛提到 COMMIT
    expect(report.COMMIT).toEqual(['fact.promote']);
  });
});

describe('权限门禁（单点判定）', () => {
  it('READ 调用方不能执行 WRITE 工具', async () => {
    t = createTestProject();
    const reg = makeRegistry(t.repos);
    const r = await reg.invoke('project.create', { name: 'x' }, ctx({ callerPermission: 'READ' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(ErrorCode.TOOL_PERMISSION_DENIED);
      expect(r.error.message).toMatch(/需要 WRITE，调用方为 READ/);
    }
  });

  it('PROPOSE_WRITE 不能执行 WRITE（级别不可跳级）', async () => {
    t = createTestProject();
    const reg = makeRegistry(t.repos);
    const r = await reg.invoke('project.create', { name: 'x' }, ctx({ callerPermission: 'PROPOSE_WRITE' }));
    expect(r.ok).toBe(false);
  });

  it('WRITE 可以执行 READ 工具（高权限兼容低要求）', async () => {
    t = createTestProject();
    const reg = makeRegistry(t.repos);
    const r = await reg.invoke('project.list', {}, ctx({ callerPermission: 'WRITE' }));
    expect(r.ok).toBe(true);
  });

  it('权限被拒时不产生副作用', async () => {
    t = createTestProject();
    const reg = makeRegistry(t.repos);
    await reg.invoke('project.create', { name: '不该被创建' }, ctx({ callerPermission: 'READ' }));
    expect(t.repos.projects.list()).toHaveLength(1); // 只有 helpers 建的那一个
  });
});

describe('输入 / 输出校验', () => {
  it('未注册工具返回结构化错误，不抛异常', async () => {
    t = createTestProject();
    const reg = makeRegistry(t.repos);
    const r = await reg.invoke('nope.nope', {}, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/未注册的工具/);
  });

  it('输入 schema 不通过时拒绝，且不进入 execute', async () => {
    t = createTestProject();
    const reg = makeRegistry(t.repos);
    const r = await reg.invoke('project.create', { name: '' }, ctx()); // 空名
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(ErrorCode.TOOL_VALIDATION_ERROR);
      expect(r.error.message).toMatch(/输入校验失败/);
    }
    // 未被创建
    expect(t.repos.projects.list()).toHaveLength(1);
  });

  it('多余字段被 strict 拒绝（inputSchema 契约）', async () => {
    t = createTestProject();
    const reg = makeRegistry(t.repos);
    const r = await reg.invoke('project.list', { unexpected: 1 }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/输入校验失败/);
  });

  it('⚠ 输出不合契约时也被拒绝（不信任工具返回值）', async () => {
    t = createTestProject();
    const reg = new ToolRegistry();
    const lying: ToolDefinition<Record<string, never>, unknown> = {
      name: 'test.liar',
      description: '返回不符合 outputSchema 的数据',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ value: z.number() }),
      permission: 'READ',
      errorCodes: [ErrorCode.TOOL_VALIDATION_ERROR],
      execute: () => ({ value: '不是数字' }), // 故意违约
    };
    reg.register(lying);
    const r = await reg.invoke('test.liar', {}, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/输出校验失败/);
  });

  it('工具抛出的异常被转成结构化错误，不穿透', async () => {
    t = createTestProject();
    const reg = new ToolRegistry();
    const boom: ToolDefinition<Record<string, never>, unknown> = {
      name: 'test.boom', description: 'x',
      inputSchema: z.object({}).strict(), outputSchema: z.unknown(),
      permission: 'READ', errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
      execute: () => {
        throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, '底层炸了', { details: { table: 't' } });
      },
    };
    reg.register(boom);
    const r = await reg.invoke('test.boom', {}, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(ErrorCode.STORAGE_QUERY_FAILED);
      expect(r.error.message).toBe('底层炸了');
    }
  });

  it('非 AppError 的异常也被收敛（§55 Rule 8 不许吞）', async () => {
    t = createTestProject();
    const reg = new ToolRegistry();
    const boom: ToolDefinition<Record<string, never>, unknown> = {
      name: 'test.raw', description: 'x',
      inputSchema: z.object({}).strict(), outputSchema: z.unknown(),
      permission: 'READ', errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
      execute: () => { throw new TypeError('原生类型错误'); },
    };
    reg.register(boom);
    const r = await reg.invoke('test.raw', {}, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe('原生类型错误');
  });
});

describe('实际业务工具行为', () => {
  it('project.create 落库并可被 project.get 读回', async () => {
    t = createTestProject();
    const reg = makeRegistry(t.repos);
    const created = await reg.invoke<{ id: string; name: string }>(
      'project.create', { name: '新小说', genre: 'urban_fantasy' }, ctx(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const got = await reg.invoke<{ name: string; genre: string | null }>(
      'project.get', { id: created.data.id }, ctx(),
    );
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.data.name).toBe('新小说');
      expect(got.data.genre).toBe('urban_fantasy');
    }
  });

  it('chapter.create 幂等：同章节号重复创建返回同一条', async () => {
    t = createTestProject();
    const reg = makeRegistry(t.repos);
    const a = await reg.invoke<{ id: string }>(
      'chapter.create', { bookId: t.bookId, chapterNumber: 1 }, ctx(),
    );
    const b = await reg.invoke<{ id: string }>(
      'chapter.create', { bookId: t.bookId, chapterNumber: 1 }, ctx(),
    );
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.data.id).toBe(b.data.id);
    expect(t.repos.chapters.listByBook(t.bookId)).toHaveLength(1);
  });

  it('chapter.create 推进 book 进度指针', async () => {
    t = createTestProject();
    const reg = makeRegistry(t.repos);
    await reg.invoke('chapter.create', { bookId: t.bookId, chapterNumber: 7 }, ctx());
    expect(t.repos.books.get(t.bookId).current_chapter).toBe(7);
  });

  it('chapter.get 对不存在的章节返回结构化错误', async () => {
    t = createTestProject();
    const reg = makeRegistry(t.repos);
    const r = await reg.invoke('chapter.get', { bookId: t.bookId, chapterNumber: 99 }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/章节不存在/);
  });

  it('chapter.countCommitted 只数已提交（进度只信物理产物）', async () => {
    t = createTestProject();
    const reg = makeRegistry(t.repos);
    await reg.invoke('chapter.create', { bookId: t.bookId, chapterNumber: 1 }, ctx());
    await reg.invoke('chapter.create', { bookId: t.bookId, chapterNumber: 2 }, ctx());
    const r = await reg.invoke<{ count: number }>(
      'chapter.countCommitted', { bookId: t.bookId }, ctx(),
    );
    expect(r.ok && r.data.count).toBe(0); // 都是 DRAFT
  });

  it('新章节的 bodyPath 为 null（未验证正文不得有正式路径）', async () => {
    t = createTestProject();
    const reg = makeRegistry(t.repos);
    const r = await reg.invoke<{ bodyPath: string | null; status: string }>(
      'chapter.create', { bookId: t.bookId, chapterNumber: 1 }, ctx(),
    );
    expect(r.ok && r.data.bodyPath).toBeNull();
    expect(r.ok && r.data.status).toBe('DRAFT');
  });

  it('每次调用都报告耗时（用于 Run 可观测性）', async () => {
    t = createTestProject();
    const reg = makeRegistry(t.repos);
    const r = await reg.invoke('project.list', {}, ctx());
    expect(typeof r.durationMs).toBe('number');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});
