/**
 * 迁移门禁测试（STEP 8，施工文档 §8.2 / §33）
 *
 * STEP 8 的验收要求：
 *   "构造一个必含 BLOCKING 的 draft（例：写已死亡角色正常活动），断言被拦"
 *
 * 这里用「已死亡角色正常活动」作为固定 fixture（§13 的张三示例），
 * 走完整链路：Continuity 检出 → Review 落库 → 门禁拦截。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { TransitionGate } from '@nwa/harness';
import type { GateResult } from '@nwa/harness';
import { ContinuityChecker } from '@nwa/story';
import { Reviewer } from '@nwa/writing';
import { canTransition, assertTransition } from '@nwa/harness';
import { ReviewOutputSchema, deriveStatus } from '@nwa/shared';
import type { ReviewIssue } from '@nwa/shared';
import { Logger } from '@nwa/core';
import { createTestProject, makeChapter, type TestProject } from './helpers.js';

let t: TestProject | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const logger = new Logger('test:gate', { level: 'error' });

function gateOf(proj: TestProject, hasDraft: (id: string) => boolean): TransitionGate {
  return new TransitionGate({ repos: proj.repos, logger, hasDraft });
}

const issue = (over: Partial<ReviewIssue> = {}): ReviewIssue => ({
  id: 'ri_1',
  severity: 'MINOR',
  category: 'PACING',
  claim: 'c',
  evidence: [],
  suggestions: [],
  ...over,
});

describe('⚠ 核心门禁：BLOCKING = 0 才能离开 REVIEW_READY（§33）', () => {
  it('有 BLOCKING 时拒绝进入 CONTINUITY_CHECKING', () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    t.repos.chapters.saveReview(
      c.id,
      { overallStatus: 'BLOCKED', issues: [issue({ severity: 'BLOCKING', category: 'CONTINUITY', evidence: ['f1'] })] },
      'BLOCKED',
    );

    const r = gateOf(t, () => true).check({
      chapterId: c.id,
      from: 'REVIEW_READY',
      to: 'CONTINUITY_CHECKING',
    });

    expect(r.met).toBe(false);
    expect(r.code).toBe('GATE_BLOCKING_REVIEW');
    expect(r.missing.join()).toContain('BLOCKING = 0');
  });

  it('无 BLOCKING 时放行', () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    t.repos.chapters.saveReview(
      c.id,
      { overallStatus: 'NEEDS_REVISION', issues: [issue({ severity: 'MAJOR' })] },
      'NEEDS_REVISION',
    );

    const r = gateOf(t, () => true).check({
      chapterId: c.id,
      from: 'REVIEW_READY',
      to: 'CONTINUITY_CHECKING',
    });
    expect(r.met).toBe(true);
  });

  it('报告阻塞问题数量（可操作信息）', () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    t.repos.chapters.saveReview(
      c.id,
      {
        overallStatus: 'BLOCKED',
        issues: [
          issue({ id: 'a', severity: 'BLOCKING', category: 'CONTINUITY', evidence: ['f'] }),
          issue({ id: 'b', severity: 'BLOCKING', category: 'TIMELINE', evidence: ['f'] }),
          issue({ id: 'c', severity: 'MINOR' }),
        ],
      },
      'BLOCKED',
    );

    const r = gateOf(t, () => true).check({
      chapterId: c.id,
      from: 'REVIEW_READY',
      to: 'CONTINUITY_CHECKING',
    });
    expect(r.missing.join()).toContain('2 个 BLOCKING');
  });

  it('未审阅时拒绝（不能跳过审阅直接提交）', () => {
    t = createTestProject();
    const c = makeChapter(t, 1);

    const r = gateOf(t, () => true).check({
      chapterId: c.id,
      from: 'REVIEW_READY',
      to: 'CONTINUITY_CHECKING',
    });

    expect(r.met).toBe(false);
    expect(r.missing.join()).toContain('尚未审阅');
  });
});

describe('⚠ 端到端：已死亡角色活动 → 审阅拦截（STEP 8 验收）', () => {
  it('Continuity 检出 → Review 落库 → 门禁拒绝提交', async () => {
    t = createTestProject();
    const bookId = t.repos.books.listByProject(t.repos.projects.list()[0]!.id)[0]!.id;
    const c = makeChapter(t, 11);

    // 固定 fixture：角色已死
    const zhang = t.repos.characters.create({ id: 'ch_zhang', bookId, name: '张三' });
    t.repos.characters.appendState({
      id: 'cs_10',
      characterId: zhang.id,
      chapterNumber: 10,
      state: { status: 'DEAD' },
    });

    // 1) 确定性检查发现矛盾
    const checker = new ContinuityChecker({ repos: t.repos, logger, bookId });
    const report = checker.check({ chapterNumber: 11, draftText: '张三推开门走了进来。' });
    expect(report.ok).toBe(false);
    expect(report.blockingCount).toBe(1);

    // 2) 合并进审阅结果并落库
    const deterministic: ReviewIssue[] = report.issues.map((i) => ({
      id: i.id,
      severity: i.severity === 'BLOCKING' ? 'BLOCKING' : 'MAJOR',
      category: 'CONTINUITY',
      claim: i.message,
      evidence: [i.sourceRef],
      suggestions: [],
    }));

    const reviewer = new Reviewer({
      structured: async () => ({
        ok: true,
        data: { overallStatus: 'PASSED', issues: [] },
        attempts: 1,
        usedFallback: false,
      }),
      logger,
    });
    const review = await reviewer.review({
      chapterNumber: 11,
      draftText: '张三推开门走了进来。',
      contextText: '',
      deterministicIssues: deterministic,
    });

    expect(review.canCommit).toBe(false);
    expect(review.status).toBe('BLOCKED');

    t.repos.chapters.saveReview(c.id, { overallStatus: review.status, issues: review.issues }, review.status);

    // 3) 门禁拒绝
    const gate = gateOf(t, () => true);
    const r1 = gate.check({ chapterId: c.id, from: 'REVIEW_READY', to: 'CONTINUITY_CHECKING' });
    expect(r1.met).toBe(false);
    expect(r1.code).toBe('GATE_BLOCKING_REVIEW');

    const r2 = gate.check({ chapterId: c.id, from: 'READY_TO_COMMIT', to: 'COMMITTING' });
    expect(r2.met).toBe(false);
  });

  it('修好之后（改为非死亡角色）可以通过门禁', async () => {
    t = createTestProject();
    const bookId = t.repos.books.listByProject(t.repos.projects.list()[0]!.id)[0]!.id;
    const c = makeChapter(t, 11);
    const zhang = t.repos.characters.create({ id: 'ch_zhang2', bookId, name: '张三' });
    t.repos.characters.appendState({
      id: 'cs_10b',
      characterId: zhang.id,
      chapterNumber: 10,
      state: { status: 'DEAD' },
    });

    const checker = new ContinuityChecker({ repos: t.repos, logger, bookId });
    // 改稿后张三不再出场
    const report = checker.check({ chapterNumber: 11, draftText: '李四推开门走了进来。' });
    expect(report.ok).toBe(true);

    t.repos.chapters.saveReview(c.id, { overallStatus: 'PASSED', issues: [] }, 'PASSED');

    const gate = gateOf(t, () => true);
    gate.setContinuityReport(c.id, { blockingCount: 0 });

    expect(gate.check({ chapterId: c.id, from: 'REVIEW_READY', to: 'CONTINUITY_CHECKING' }).met).toBe(true);
    expect(gate.check({ chapterId: c.id, from: 'CONTINUITY_CHECKING', to: 'READY_TO_COMMIT' }).met).toBe(true);
    expect(gate.check({ chapterId: c.id, from: 'READY_TO_COMMIT', to: 'COMMITTING' }).met).toBe(true);
  });
});

describe('草稿存在性门禁', () => {
  it('无草稿时拒绝进入 REVIEWING', () => {
    t = createTestProject();
    const c = makeChapter(t, 1);

    const r = gateOf(t, () => false).check({ chapterId: c.id, from: 'DRAFT_READY', to: 'REVIEWING' });
    expect(r.met).toBe(false);
    expect(r.code).toBe('GATE_NO_DRAFT');
  });

  it('有草稿时放行', () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    expect(gateOf(t, () => true).check({ chapterId: c.id, from: 'DRAFT_READY', to: 'REVIEWING' }).met).toBe(true);
  });

  it('无草稿时拒绝 COMMITTING（不得提交空章节）', () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    t.repos.chapters.saveReview(c.id, { overallStatus: 'PASSED', issues: [] }, 'PASSED');

    const r = gateOf(t, () => false).check({ chapterId: c.id, from: 'READY_TO_COMMIT', to: 'COMMITTING' });
    expect(r.met).toBe(false);
    expect(r.missing.join()).toContain('不存在草稿');
  });
});

describe('审阅产物门禁', () => {
  it('REVIEWING → REVIEW_READY 必须有 review 产物', () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    const gate = gateOf(t, () => true);

    expect(gate.check({ chapterId: c.id, from: 'REVIEWING', to: 'REVIEW_READY' }).met).toBe(false);
    expect(gate.check({ chapterId: c.id, from: 'REVIEWING', to: 'REVIEW_READY' }).code).toBe('GATE_NO_REVIEW');

    t.repos.chapters.saveReview(c.id, { overallStatus: 'PASSED', issues: [] }, 'PASSED');
    expect(gate.check({ chapterId: c.id, from: 'REVIEWING', to: 'REVIEW_READY' }).met).toBe(true);
  });

  it('修订后必须重新审阅（REVISION_READY → CONTINUITY_CHECKING）', () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    // 模拟"修订清掉了审阅结果"（改稿后旧结论失效）
    const gate = gateOf(t, () => true);
    expect(gate.check({ chapterId: c.id, from: 'REVISION_READY', to: 'CONTINUITY_CHECKING' }).met).toBe(false);
  });
});

describe('一致性门禁', () => {
  it('未做一致性检查时拒绝进入 READY_TO_COMMIT', () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    t.repos.chapters.saveReview(c.id, { overallStatus: 'PASSED', issues: [] }, 'PASSED');

    const r = gateOf(t, () => true).check({
      chapterId: c.id,
      from: 'CONTINUITY_CHECKING',
      to: 'READY_TO_COMMIT',
    });
    expect(r.met).toBe(false);
    expect(r.missing.join()).toContain('尚未做一致性检查');
  });

  it('一致性有阻塞时拒绝', () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    t.repos.chapters.saveReview(c.id, { overallStatus: 'PASSED', issues: [] }, 'PASSED');
    const gate = gateOf(t, () => true);
    gate.setContinuityReport(c.id, { blockingCount: 3 });

    const r = gate.check({ chapterId: c.id, from: 'CONTINUITY_CHECKING', to: 'READY_TO_COMMIT' });
    expect(r.met).toBe(false);
    expect(r.missing.join()).toContain('3 个阻塞问题');
  });

  it('一致性清零后放行', () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    t.repos.chapters.saveReview(c.id, { overallStatus: 'PASSED', issues: [] }, 'PASSED');
    const gate = gateOf(t, () => true);
    gate.setContinuityReport(c.id, { blockingCount: 0 });

    expect(gate.check({ chapterId: c.id, from: 'CONTINUITY_CHECKING', to: 'READY_TO_COMMIT' }).met).toBe(true);
  });
});

describe('门禁只加业务约束，不重复状态机职责', () => {
  it('表外的迁移一律放行（由状态机校验合法性）', () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    const gate = gateOf(t, () => false);

    // PLANNING → CONTEXT_READY 与业务门禁无关
    const r: GateResult = gate.check({ chapterId: c.id, from: 'PLANNING', to: 'CONTEXT_READY' });
    expect(r.met).toBe(true);
  });

  it('状态机与门禁配合：非法迁移先被状态机拦截', () => {
    expect(canTransition('DRAFT', 'COMMITTED').allowed).toBe(false);
    expect(() => assertTransition({ from: 'DRAFT', to: 'COMMITTED', reason: 'x' })).toThrow();
  });

  it('保存审阅时状态由 issues 推导，不采信传入的 overallStatus', () => {
    // 这才是落库的正确姿势：先 deriveStatus，再存
    const issues = [issue({ severity: 'BLOCKING', category: 'CONTINUITY', evidence: ['f'] })];
    const status = deriveStatus(issues);
    expect(status).toBe('BLOCKED');

    // 若模型声称 PASSED，落库的仍应是 BLOCKED
    const parsed = ReviewOutputSchema.parse({ overallStatus: 'PASSED', issues });
    expect(deriveStatus(parsed.issues)).toBe('BLOCKED');
  });
});
