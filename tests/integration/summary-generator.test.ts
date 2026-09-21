/**
 * 摘要生成与长程记忆链路测试（补缺口）
 *
 * ## 触发这组测试的真实故障
 *
 * 实测跨章验证发现：第 1 章主角「林渊」，第 2 章变成「林秋」，
 * 妹妹的名字与设定全丢 —— **长程记忆整条断裂**。
 *
 * 根因不是模型发挥，而是链路缺一环：
 *   全代码库没有"生成章节摘要"的逻辑
 *   → `chapters.summary` 恒为 NULL
 *   → Commit 静默 fallback 成 `第 N 章`
 *   → 后续章节检索到的"前情"只有三个字
 *   → 模型无材料可用，只能另起炉灶
 *
 * 这组测试锁死三点：
 *   1. 摘要能从正文生成，且**只抽取不创作**
 *   2. 生成的摘要**未经确认不进检索**（ADR-0006 约束 C）
 *   3. **摘要缺失时拒绝提交**（不再静默降级成标题）
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SummaryGenerator, SummaryIndexer, validateSummary } from '@nwa/harness';
import type { SummaryStructuredCaller, ChapterSummary } from '@nwa/harness';
import { FtsIndex } from '@nwa/storage';
import { bigramTokenizer, buildMatchExpression } from '@nwa/retrieval';
import { Logger } from '@nwa/core';
import { createTestProject, makeChapter, type TestProject } from './helpers.js';

const logger = new Logger('test:summary-gen', { level: 'error' });

let t: TestProject | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

/** 返回预设摘要的 caller（走真实 schema 校验） */
function callerReturning(raw: unknown): SummaryStructuredCaller {
  return async (req) => {
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: 'MODEL_STRUCTURED_EMPTY', message: 'schema 失败' },
        attempts: 1,
        rawText: JSON.stringify(raw),
      };
    }
    return { ok: true, data: parsed.data, attempts: 1 };
  };
}

const DRAFT = [
  '雨水顺着旧货市场的屋檐滴落。林渊坐在工作台前，镊子夹着一枚黄铜齿轮。',
  '林溪失踪已经整整四天。治安官的敷衍像一张网勒在他脖子上。',
  '老乔掀起门帘走进来，左手背上有一道旧疤。',
].join('\n');

const goodSummary = (over: Partial<ChapterSummary> = {}): ChapterSummary => ({
  summary: '林渊在旧货市场修表，妹妹林溪已失踪四天。老乔冒雨来访。',
  keyFacts: ['林渊的妹妹林溪已失踪四天', '老乔左手背有旧疤'],
  endState: '林渊仍在旧货市场，老乔刚刚到访',
  ...over,
});

function genWith(raw: unknown) {
  return new SummaryGenerator({ structured: callerReturning(raw), logger });
}

describe('摘要生成（长程记忆的唯一入口）', () => {
  it('正常生成摘要', async () => {
    const g = genWith(goodSummary());
    const r = await g.generate({ chapterNumber: 1, draftText: DRAFT });

    expect(r.ok).toBe(true);
    expect(r.summary!.summary).toContain('林渊');
    expect(r.summary!.keyFacts.length).toBeGreaterThan(0);
  });

  it('⚠ 摘要必须保留可延续的具体信息（人名/地名/物品）', async () => {
    const g = genWith(goodSummary());
    const r = await g.generate({ chapterNumber: 1, draftText: DRAFT });
    // 人名与"失踪四天"这类可延续事实必须在摘要里
    expect(r.summary!.summary).toContain('林溪');
    expect(r.summary!.summary).toMatch(/失踪|四天/);
  });

  it('前情摘要会传给模型（保持连贯但不重复叙述）', async () => {
    let captured = '';
    const caller: SummaryStructuredCaller = async (req) => {
      captured = req.messages.map((m) => m.content).join('\n');
      return { ok: true, data: goodSummary(), attempts: 1 };
    };
    await new SummaryGenerator({ structured: caller, logger }).generate({
      chapterNumber: 2,
      draftText: DRAFT,
      previousSummaries: ['第 1 章：主角离乡'],
    });
    expect(captured).toContain('主角离乡');
    expect(captured).toContain('不要重复叙述');
  });

  it('温度固定低温（摘要要忠实，不要创造性）', async () => {
    let temp: number | undefined;
    const caller: SummaryStructuredCaller = async (req) => {
      temp = req.temperature;
      return { ok: true, data: goodSummary(), attempts: 1 };
    };
    await new SummaryGenerator({ structured: caller, logger }).generate({
      chapterNumber: 1,
      draftText: DRAFT,
    });
    expect(temp).toBe(0.1);
  });
});

describe('⚠ 摘要只抽取不创作（ADR-0006："错一条污染几百章"）', () => {
  it('拒绝未来时（摘要应记录已发生的事，不是预告）', async () => {
    const g = genWith(goodSummary({ summary: '林渊将要去寻找妹妹，接下来会遇到老乔。' }));
    const r = await g.generate({ chapterNumber: 1, draftText: DRAFT });

    expect(r.ok).toBe(false);
    expect(r.error!.message).toContain('未来时');
  });

  it('拒绝含占位符的摘要', async () => {
    const g = genWith(goodSummary({ summary: '待确认：本章主角的行动与结局。' }));
    const r = await g.generate({ chapterNumber: 1, draftText: DRAFT });
    expect(r.ok).toBe(false);
  });

  it('⚠ 拒绝只回标题的空摘要（这正是原先 fallback 的样子）', async () => {
    const g = genWith(goodSummary({ summary: '第 1 章' }));
    const r = await g.generate({ chapterNumber: 1, draftText: DRAFT });
    expect(r.ok).toBe(false);
    expect(r.error!.message).toContain('实质内容');
  });

  it('拒绝超长摘要（会挤占后续章节的上下文预算）', async () => {
    const g = genWith(goodSummary({ summary: '林'.repeat(400) + '渊的故事' }));
    const r = await g.generate({ chapterNumber: 1, draftText: DRAFT });
    expect(r.ok).toBe(false);
    expect(r.error!.message).toContain('超出上限');
  });

  it('endState 也拒绝未来时', async () => {
    const v = validateSummary(goodSummary({ endState: '接下来会遇到老乔' }), DRAFT, 300);
    expect(v.some((x) => x.includes('未来时'))).toBe(true);
  });

  it('合法摘要无违规', () => {
    expect(validateSummary(goodSummary(), DRAFT, 300)).toEqual([]);
  });
});

describe('⚠ 生成的摘要未经确认不得进检索（ADR-0006 约束 C）', () => {
  function setup() {
    const proj = createTestProject();
    t = proj;
    const fts = new FtsIndex({ db: proj.db, tokenizer: bigramTokenizer, logger });
    return { proj, fts, indexer: new SummaryIndexer({ repos: proj.repos, fts, logger }) };
  }

  it('setSummaryCandidate 写入后仍为未确认状态', () => {
    const { proj } = setup();
    const c = makeChapter(proj, 1, 'COMMITTING');
    proj.repos.chapters.setCommittedBody(c.id, 'chapters/001.md', '第 1 章');

    proj.repos.chapters.setSummaryCandidate(c.id, '林渊在旧货市场修表，妹妹失踪四天。');

    const after = proj.repos.chapters.get(c.id);
    expect(after.summary).toContain('林渊');
    // ⚠ 关键：生成 ≠ 确认
    expect(after.summary_approved).toBe(0);
  });

  it('⚠ 生成后未确认 → 检索不到（记忆源头不被污染）', () => {
    const { proj, fts, indexer } = setup();
    const c = makeChapter(proj, 1, 'COMMITTING');
    proj.repos.chapters.setCommittedBody(c.id, 'chapters/001.md', '第 1 章');
    proj.repos.chapters.setSummaryCandidate(c.id, '林渊在旧货市场修表，妹妹林溪失踪四天。');
    indexer.indexBook(proj.bookId);

    const expr = buildMatchExpression(bigramTokenizer.query('林渊林溪'));
    expect(fts.searchMemory({ matchExpression: expr, limit: 5 })).toEqual([]);
  });

  it('确认后才进检索，且能召回', () => {
    const { proj, fts, indexer } = setup();
    const c = makeChapter(proj, 1, 'COMMITTING');
    proj.repos.chapters.setCommittedBody(c.id, 'chapters/001.md', '第 1 章');
    proj.repos.chapters.setSummaryCandidate(c.id, '林渊在旧货市场修表，妹妹林溪失踪四天。');
    proj.repos.chapters.approveSummary(c.id);
    indexer.indexBook(proj.bookId);

    const expr = buildMatchExpression(bigramTokenizer.query('林渊'));
    expect(fts.searchMemory({ matchExpression: expr, limit: 5 }).length).toBeGreaterThan(0);
  });

  it('⚠ setSummaryCandidate 会清掉旧的确认状态（改过的摘要需重新确认）', () => {
    const { proj } = setup();
    const c = makeChapter(proj, 1, 'COMMITTING');
    proj.repos.chapters.setCommittedBody(c.id, 'chapters/001.md', '第 1 章');
    proj.repos.chapters.setSummaryCandidate(c.id, '初版摘要');
    proj.repos.chapters.approveSummary(c.id);
    expect(proj.repos.chapters.get(c.id).summary_approved).toBe(1);

    // 重新生成 → 必须回到未确认
    proj.repos.chapters.setSummaryCandidate(c.id, '重新生成的摘要');
    expect(proj.repos.chapters.get(c.id).summary_approved).toBe(0);
  });
});

describe('⚠ 摘要缺失时拒绝提交（不再静默降级成标题）', () => {
  it('章节无摘要 → 提交被拒并说明缺哪一步', async () => {
    const { CommitEngine } = await import('@nwa/harness');
    const { createAllTools } = await import('@nwa/harness');
    const { ToolRegistry } = await import('@nwa/harness');
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const dir = mkdtempSync(join(tmpdir(), 'nwa-sum-'));
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);

    const fts = new FtsIndex({ db: proj.db, tokenizer: bigramTokenizer, logger });
    const reg = new ToolRegistry();
    for (const tool of createAllTools(proj.repos, {
      logger,
      commit: {
        db: proj.db,
        rootDir: dir,
        readWorkspaceText: () => '张三推开门走了进来。',
        indexer: {
          indexChapter: (i) => {
            fts.indexChapter({
              chapterId: i.chapterId,
              bookId: proj.bookId,
              chapterNumber: i.chapterNumber,
              sourceRef: i.sourceRef,
              text: i.body,
            });
          },
        },
      },
    })) {
      reg.register(tool);
    }

    // ⚠ 先满足审阅门禁 —— 否则会先被"审阅有 BLOCKING"拦下，
    //   测不到摘要门禁（实测踩到断言错位）。
    proj.repos.chapters.saveReview(
      chapter.id,
      { overallStatus: 'PASSED', issues: [] },
      'PASSED',
    );

    // 无摘要 → 提交应被拒
    const r = await reg.invoke(
      'workspace.commit',
      { chapterId: chapter.id },
      { runId: 'r1', projectId: proj.projectId, callerPermission: 'ADMIN', emit: () => {} },
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain('还没有摘要');
      expect(r.error.message).toContain('长程记忆');
    }
    void CommitEngine;
  });
});

describe('端到端：第1章摘要 → 第2章上下文能引用到', () => {
  it('⚠ 第2章的检索能召回第1章摘要（长程记忆接通）', () => {
    const proj = createTestProject();
    t = proj;
    const fts = new FtsIndex({ db: proj.db, tokenizer: bigramTokenizer, logger });
    const indexer = new SummaryIndexer({ repos: proj.repos, fts, logger });

    // 第 1 章：提交 + 生成摘要 + 确认
    const c1 = makeChapter(proj, 1, 'COMMITTING');
    proj.repos.chapters.setCommittedBody(c1.id, 'chapters/001.md', '第 1 章');
    proj.repos.chapters.setSummaryCandidate(
      c1.id,
      '林渊在旧货市场修表为生。妹妹林溪已失踪四天，治安官敷衍不理。老乔冒雨来访，手背有旧疤。',
    );
    proj.repos.chapters.approveSummary(c1.id);
    indexer.indexBook(proj.bookId);

    // 第 2 章规划时会以主角名检索前情
    const expr = buildMatchExpression(bigramTokenizer.query('林渊 林溪'));
    const hits = fts.searchMemory({ matchExpression: expr, limit: 5 });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.sourceRef).toContain('chapters/001.md');
  });

  it('⚠ 只有标题的摘要无法被检索到（复现原先的故障）', () => {
    const proj = createTestProject();
    t = proj;
    const fts = new FtsIndex({ db: proj.db, tokenizer: bigramTokenizer, logger });
    const indexer = new SummaryIndexer({ repos: proj.repos, fts, logger });

    const c1 = makeChapter(proj, 1, 'COMMITTING');
    // 模拟原先的 fallback 行为
    proj.repos.chapters.setCommittedBody(c1.id, 'chapters/001.md', '第 1 章');
    proj.repos.chapters.approveSummary(c1.id);
    indexer.indexBook(proj.bookId);

    // 用主角名检索 —— 只有"第 1 章"的摘要里没有它，召不回来
    const expr = buildMatchExpression(bigramTokenizer.query('林渊'));
    expect(fts.searchMemory({ matchExpression: expr, limit: 5 })).toEqual([]);
  });
});
