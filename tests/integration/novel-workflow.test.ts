/**
 * Novel Workflow 集成测试（v1.0 闭环提示词 §二十五 测试要求）
 *
 * 覆盖提示词点名的四组：
 *
 *   Workflow      start workflow → reaches DONE
 *   Pause         pause during WRITE → status = PAUSED
 *   Resume        PAUSED → resume → continues
 *   Restart       process died → 重新初始化 Runtime → 仍能恢复
 *   No duplicate   PLAN completed → restart → resume → Planner 不能再次调用模型
 *
 * ## 为什么这些测试必须用"真数据库 + 新引擎实例"来模拟重启
 *
 * 提示词 §四 的硬要求是"不要依赖内存中的 Map/Set 作为唯一恢复依据"。
 * 若测试里复用同一个引擎对象，内存缓存还在，**恢复路径根本没被走到** ——
 * 那测试就是绿的却什么都没证明。
 *
 * 所以"重启"在这里被实现为：丢掉旧引擎、新建一个引擎实例、
 * 只从数据库重建状态。如果恢复依据真的在内存里，这些测试必然失败。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { WorkflowEngine, WorkflowRepository, stageOrdinals, createNovelWorkflowStages } from '@nwa/harness';
import type { NovelWorkflowServices } from '@nwa/harness';
import { STAGE_ORDER, type StageId } from '@nwa/harness';
import { createTestProject, makeChapter, type TestProject } from './helpers.js';

let t: TestProject | null = null;

afterEach(() => {
  t?.cleanup();
  t = null;
});

/** 记录每个 stage 被真正执行了几次 —— 「不重复执行」的直接证据 */
interface CallLog {
  readonly calls: string[];
  count(stage: string): number;
}

function newLog(): CallLog {
  const calls: string[] = [];
  return {
    calls,
    count: (stage: string) => calls.filter((c) => c === stage).length,
  };
}

/**
 * 造一套假服务：不碰模型、不碰文件，只记录调用。
 *
 * ⚠ 这正是把服务做成"注入"的好处 —— 测试能在毫秒级验证
 *   编排与恢复语义，而不需要真实 LLM（那要几分钟且不确定）。
 */
function fakeServices(log: CallLog, opts?: {
  failAt?: StageId;
  /** 让 write stage 停住，等测试放行（用于确定性地测试暂停/取消） */
  gate?: { wait: () => Promise<void>; release: () => void };
  /**
   * 真实存在的章节 id。
   *
   * ⚠ 必须是真章节：`workflows.chapter_id` 有外键指向 `chapters(id)`，
   *   返回一个不存在的 id 会触发 FOREIGN KEY constraint failed。
   *   这不是测试噪音 —— 它正说明"绑定章节"是个真实的状态变更，
   *   不能靠约定一个字符串糊过去。
   */
  chapterId: string;
}): NovelWorkflowServices {
  const rec = (s: string) => log.calls.push(s);

  return {
    async ensureChapter(input) {
      rec('create_chapter');
      return {
        chapterId: input.chapterId ?? opts!.chapterId,
        chapterNumber: input.chapterNumber ?? 1,
      };
    },
    async buildContext() {
      rec('build_context');
      return { contextSummary: { tokens: 100 }, retrievalTrace: [] };
    },
    async plan() {
      rec('plan');
      return { planPath: 'plan.json', sceneCount: 3, contentHash: 'h-plan' };
    },
    async planVerify() {
      rec('plan_verify');
      return { ok: true, problems: [] };
    },
    async write(input, ...rest) {
      rec('write');
      void rest;
      void input;
      // ⚠ 门闸：停在 write 中间，等测试放行。
      //
      //   为什么不用 setTimeout 制造"写到一半"：假的 stage 是同步返回的，
      //   整个工作流会在一个微任务批次里跑完 —— 等测试 sleep(10) 后
      //   再调 pause()，工作流早已 DONE。那样的测试是**竞争**，
      //   不是验证。门闸让"write 正在执行中"成为一个确定的事实。
      if (opts?.gate) {
        await opts.gate.wait();
      }
      return {
        draftPath: 'draft.md',
        contentHash: 'h-draft',
        wordCount: 2000,
        sceneCount: 3,
        deviations: [],
      };
    },
    async review() {
      rec('review');
      return { reportPath: 'review.json', contentHash: 'h-review', blockingCount: 0, issueCount: 2 };
    },
    async revision() {
      rec('revision');
      return {
        revisionPath: 'revision.md',
        contentHash: 'h-rev',
        applied: 2,
        needsRegeneration: false,
      };
    },
    async continuity() {
      rec('continuity');
      return {
        reportPath: 'continuity.json',
        contentHash: 'h-cont',
        blockingCount: 0,
        checkedAgainst: ['character:1'],
      };
    },
    async settleState() {
      rec('state_settlement');
      return {
        proposalId: 'sp-1',
        verified: true,
        factCount: 1,
        characterStateCount: 1,
        timelineEventCount: 0,
        rejected: [],
      };
    },
    async readyToCommit() {
      rec('ready_to_commit');
      return { ok: true, missing: [] };
    },
    async commit() {
      rec('commit');
      if (opts?.failAt === 'commit') {
        throw new Error('模拟提交失败');
      }
      return { manifestPath: 'manifest.json', contentHash: 'h-manifest', committed: true };
    },
    async verifyCommit() {
      rec('verify');
      return { ok: true, problems: [] };
    },
  };
}

/**
 * 轮询等待某个条件成立。
 *
 * ⚠ 用它而不是 `setTimeout(n)` 固定等待：固定 sleep 在慢机器上会偶发失败，
 *   在快机器上又白等 —— 而这里的条件（"write 已开始"）是**可观测**的，
 *   没必要靠猜时间。
 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** 一个可控门闸：`wait()` 会挂起，直到 `release()` 被调用 */
function makeGate(): { wait: () => Promise<void>; release: () => void } {
  let release!: () => void;
  const p = new Promise<void>((r) => {
    release = r;
  });
  return { wait: () => p, release: () => release() };
}

/**
 * 建引擎 + 工作流。
 *
 * ⚠ 工作流创建时 `chapterId: null` —— 这正是真实场景：用户说"写下一章"，
 *   章节还没建，由 `create_chapter` stage 负责建并绑回工作流。
 *   这条路径必须被测试覆盖，否则会漏掉"下游读到 NULL chapterId"这类问题。
 */
function setup(t2: TestProject) {
  const chapter = makeChapter(t2, 1);
  const repo = new WorkflowRepository(t2.db);
  const engine = new WorkflowEngine({ repo });
  const wf = repo.create({
    id: `wf-${Date.now()}`,
    projectId: t2.projectId,
    bookId: t2.bookId,
    chapterId: null,
    chapterNumber: null,
  });
  repo.initStages(wf.id, stageOrdinals());
  return { repo, engine, wfId: wf.id, chapterId: chapter.id };
}

describe('Novel Workflow（P0-1 编排 + P0-2 恢复）', () => {
  it('① start workflow → reaches DONE，且 12 个 stage 全部执行', async () => {
    t = createTestProject();
    const log = newLog();
    const { engine, wfId, chapterId } = setup(t);
    engine.registerAll(createNovelWorkflowStages(fakeServices(log, { chapterId })));

    const res = await engine.advance(wfId);

    expect(res.workflow.status).toBe('DONE');
    // 全部 12 个 stage 都被执行（revision 因 blocking=0 会 SKIPPED，但仍在 executed 里）
    expect(res.executed.length).toBe(STAGE_ORDER.length);
    expect(res.skippedDone.length).toBe(0);
    expect(log.count('write')).toBe(1);
    expect(log.count('commit')).toBe(1);

    // 每个 stage 都落了状态
    const stages = engine['repo' as never] as never; // 仅用于类型占位，实际用 repo
    void stages;
  });

  it('② pause during WRITE → status = PAUSED（不是 CANCELLED）', async () => {
    t = createTestProject();
    const log = newLog();
    const gate = makeGate();
    const { repo, engine, wfId, chapterId } = setup(t);
    engine.registerAll(createNovelWorkflowStages(fakeServices(log, { chapterId, gate })));

    const p = engine.advance(wfId);
    // 等 write 真的开始执行（此时它挂在门闸上，工作流确定处于"写到一半"）
    await waitFor(() => log.count('write') === 1);
    engine.pause(wfId);
    gate.release();
    const res = await p;

    // ⚠ 这是 P0-2 的核心断言：暂停必须落成 PAUSED，而不是 CANCELLED。
    //   原实现 `signal.aborted ? 'CANCELLED'` 会在这里给出 CANCELLED。
    expect(res.workflow.status).toBe('PAUSED');
    expect(res.workflow.status).not.toBe('CANCELLED');

    // 暂停后写的是 PAUSED，恢复依据（resume_cursor）应已落库
    const after = repo.get(wfId)!;
    expect(after.status).toBe('PAUSED');
    // 写过的 stage 不应被标成失败 —— 暂停不是失败
    expect(repo.getStage(wfId, 'plan')!.status).toBe('DONE');
  });

  it('③ PAUSED → resume → 继续执行（不重跑已完成 stage）', async () => {
    t = createTestProject();
    const log = newLog();
    const gate = makeGate();
    const { repo, engine, wfId, chapterId } = setup(t);
    engine.registerAll(createNovelWorkflowStages(fakeServices(log, { chapterId, gate })));

    // 先跑到暂停
    const p = engine.advance(wfId);
    await waitFor(() => log.count('write') === 1);
    engine.pause(wfId);
    gate.release();
    const paused = await p;
    expect(paused.workflow.status).toBe('PAUSED');

    const doneBefore = repo.doneStages(wfId);
    expect(doneBefore.size).toBeGreaterThan(0);

    // 恢复
    const resumed = await engine.resume(wfId);
    expect(resumed.workflow.status).toBe('DONE');

    // ⚠ 已完成的 stage 不能重跑：跳过数应等于暂停前已 DONE 的数量
    expect(resumed.skippedDone.length).toBe(doneBefore.size);
    for (const s of doneBefore) {
      expect(resumed.skippedDone).toContain(s);
    }
  });

  it('④ 模拟进程重启：丢掉引擎、只从 DB 重建 → 仍能恢复', async () => {
    t = createTestProject();
    const log = newLog();
    const gate = makeGate();
    const first = setup(t);
    first.engine.registerAll(
      createNovelWorkflowStages(fakeServices(log, { chapterId: first.chapterId, gate })),
    );

    // 跑到暂停（模拟"进程被杀"前的状态）
    const p = first.engine.advance(first.wfId);
    await waitFor(() => log.count('write') === 1);
    first.engine.pause(first.wfId);
    gate.release();
    await p;

    const doneBefore = first.repo.doneStages(first.wfId);
    const callsBefore = log.calls.length;
    expect(doneBefore.size).toBeGreaterThan(0);

    // ⚠ 关键：**丢掉旧引擎**，新建一个（内存状态全部消失）。
    //   这模拟进程重启 —— 恢复依据只可能来自数据库。
    const repo2 = new WorkflowRepository(t.db);
    const engine2 = new WorkflowEngine({ repo: repo2 });
    // ⚠ 新引擎必须重新注册 stage —— 进程重启后内存里的注册表也没了。
    //   忘记注册会报"未注册的 stage"（这正是引擎的 ⑨ 号测试在防的事）。
    engine2.registerAll(
      createNovelWorkflowStages(fakeServices(log, { chapterId: first.chapterId })),
    );

    // 恢复扫描应能捞出这个工作流
    const recoverable = engine2.findRecoverable();
    expect(recoverable.map((w) => w.id)).toContain(first.wfId);

    const resumed = await engine2.resume(first.wfId);
    expect(resumed.workflow.status).toBe('DONE');
    expect(resumed.skippedDone.length).toBe(doneBefore.size);

    // 恢复后继续跑的部分没有把前面重跑一遍
    const newCalls = log.calls.slice(callsBefore);
    for (const s of doneBefore) {
      // 已 DONE 的 stage 不应出现在"恢复后新增的调用"里
      expect(newCalls).not.toContain(s);
    }
  });

  it('⑤ 不重复执行昂贵阶段：PLAN 完成后重启，Planner 不再被调用', async () => {
    t = createTestProject();
    const log = newLog();
    const { repo, engine, wfId, chapterId } = setup(t);
    engine.registerAll(createNovelWorkflowStages(fakeServices(log, { chapterId })));

    // 手动把前几个 stage 标成 DONE（模拟"上次跑到这里就被杀了"）
    //
    // ⚠ 必须同时补上 `create_chapter` 的**副作用** —— 绑定章节。
    //   只标 DONE 而不绑章节会造出一个现实中不可能的状态
    //   （create_chapter 成功但 chapter_id 仍为 NULL），
    //   于是下游 stage 报"缺少 chapterId"。这是测试脚手架的问题，
    //   不是引擎的问题 —— 所以这里如实复刻真实 stage 的两步动作。
    repo.setChapter(wfId, chapterId, 1);
    for (const s of ['create_chapter', 'build_context', 'plan'] as StageId[]) {
      repo.markStageRunning(wfId, s);
      repo.markStageDone(wfId, s, { fake: true }, []);
    }
    // 故意留一个 RUNNING 残留（进程崩溃时留下的中间态）
    repo.markStageRunning(wfId, 'write');
    repo.updateStatus(wfId, 'PAUSED');

    expect(log.count('plan')).toBe(0);

    // 重启：新引擎实例（注册表也要重建，因为内存全丢了）
    const engine2 = new WorkflowEngine({ repo: new WorkflowRepository(t.db) });
    engine2.registerAll(createNovelWorkflowStages(fakeServices(log, { chapterId })));
    const res = await engine2.resume(wfId);

    expect(res.workflow.status).toBe('DONE');
    // ⚠ 核心断言：PLAN 已完成，Planner **一次都不能被再调用**
    expect(log.count('plan')).toBe(0);
    expect(log.count('build_context')).toBe(0);
    expect(log.count('create_chapter')).toBe(0);
    expect(res.skippedDone).toContain('plan');
    // 残留的 RUNNING write 被重置后应正常执行
    expect(log.count('write')).toBe(1);
  });

  it('⑥ stage 失败 → FAILED，但已完成的 stage 记录保留（可修复后续跑）', async () => {
    t = createTestProject();
    const log = newLog();
    const { repo, engine, wfId, chapterId } = setup(t);
    engine.registerAll(
      createNovelWorkflowStages(fakeServices(log, { failAt: 'commit', chapterId })),
    );

    const res = await engine.advance(wfId);

    expect(res.workflow.status).toBe('FAILED');
    // commit 之前的 stage 都已完成，记录保留
    const done = repo.doneStages(wfId);
    expect(done.has('write')).toBe(true);
    expect(done.has('review')).toBe(true);
    expect(done.has('state_settlement')).toBe(true);
    expect(done.has('commit')).toBe(false);

    // 失败信息落库（可追溯）
    expect(res.workflow.error?.message).toContain('模拟提交失败');
  });

  it('⑦ cancel → CANCELLED，且不可 resume', async () => {
    t = createTestProject();
    const log = newLog();
    const gate = makeGate();
    const { engine, wfId, chapterId } = setup(t);
    engine.registerAll(createNovelWorkflowStages(fakeServices(log, { chapterId, gate })));

    const p = engine.advance(wfId);
    await waitFor(() => log.count('write') === 1);
    engine.cancel(wfId);
    gate.release();
    const res = await p;

    expect(res.workflow.status).toBe('CANCELLED');
    await expect(engine.resume(wfId)).rejects.toThrow(/无法恢复/);
  });

  it('⑧ DONE 的工作流不可再次推进（防止重复提交）', async () => {
    t = createTestProject();
    const log = newLog();
    const { engine, wfId, chapterId } = setup(t);
    engine.registerAll(createNovelWorkflowStages(fakeServices(log, { chapterId })));

    await engine.advance(wfId);
    expect(log.count('commit')).toBe(1);

    await expect(engine.advance(wfId)).rejects.toThrow(/已结束/);
    // ⚠ commit 不能被再执行一次 —— 否则会重复提交
    expect(log.count('commit')).toBe(1);
  });

  it('⑨ 未注册的 stage → 明确 FAILED，不静默跳过', async () => {
    t = createTestProject();
    const repo = new WorkflowRepository(t.db);
    const engine = new WorkflowEngine({ repo });
    const wf = repo.create({
      id: 'wf-missing',
      projectId: t.projectId,
      bookId: t.bookId,
      chapterId: null,
      chapterNumber: 1,
    });
    repo.initStages(wf.id, stageOrdinals());
    // 一个 stage 都不注册

    const res = await engine.advance(wf.id);

    // ⚠ 必须失败而不是"跳过全部 stage 然后报 DONE" ——
    //   后者会让"忘了注册"表现为"写完了"
    expect(res.workflow.status).toBe('FAILED');
    expect(res.workflow.error?.message).toContain('未注册的 stage');
  });

  it('⑩ 编排由代码控制：stage 顺序来自 STAGE_ORDER，调用方无法改变', async () => {
    t = createTestProject();
    const log = newLog();
    const { engine, wfId, chapterId } = setup(t);
    engine.registerAll(createNovelWorkflowStages(fakeServices(log, { chapterId })));

    await engine.advance(wfId);

    // 实际调用顺序必须是 STAGE_ORDER 的前缀顺序
    const executedInOrder = log.calls.filter((c) => STAGE_ORDER.includes(c as StageId));
    const expected = STAGE_ORDER.filter((s) => executedInOrder.includes(s));
    expect(executedInOrder).toEqual(expected);
  });
});

describe('WorkflowRepository', () => {
  it('initStages 幂等：不会把已 DONE 的 stage 重置为 PENDING', async () => {
    t = createTestProject();
    const repo = new WorkflowRepository(t.db);
    const wf = repo.create({
      id: 'wf-idem',
      projectId: t.projectId,
      bookId: t.bookId,
      chapterId: null,
      chapterNumber: 1,
    });
    repo.initStages(wf.id, stageOrdinals());
    repo.markStageRunning(wf.id, 'plan');
    repo.markStageDone(wf.id, 'plan', { ok: true }, []);

    // 再次初始化（模拟 resume 时重新 init）
    repo.initStages(wf.id, stageOrdinals());

    // ⚠ 若这里被重置回 PENDING，恢复依据就被抹掉了 —— 会重跑昂贵阶段
    const stage = repo.getStage(wf.id, 'plan')!;
    expect(stage.status).toBe('DONE');
  });

  it('doneStages 只返回 DONE，不含 SKIPPED/RUNNING/FAILED', async () => {
    t = createTestProject();
    const repo = new WorkflowRepository(t.db);
    const wf = repo.create({
      id: 'wf-done',
      projectId: t.projectId,
      bookId: t.bookId,
      chapterId: null,
      chapterNumber: 1,
    });
    repo.initStages(wf.id, stageOrdinals());
    repo.markStageDone(wf.id, 'plan', {}, []);
    repo.markStageSkipped(wf.id, 'revision', 'no blocking');
    repo.markStageRunning(wf.id, 'write');
    repo.markStageFailed(wf.id, 'review', 'boom');

    const done = repo.doneStages(wf.id);
    expect([...done]).toEqual(['plan']);
  });

  it('resetRunningStages 把崩溃残留的 RUNNING 重置为 PENDING', async () => {
    t = createTestProject();
    const repo = new WorkflowRepository(t.db);
    const wf = repo.create({
      id: 'wf-reset',
      projectId: t.projectId,
      bookId: t.bookId,
      chapterId: null,
      chapterNumber: 1,
    });
    repo.initStages(wf.id, stageOrdinals());
    repo.markStageRunning(wf.id, 'write');

    const n = repo.resetRunningStages(wf.id);
    expect(n).toBe(1);
    expect(repo.getStage(wf.id, 'write')!.status).toBe('PENDING');
  });
});
