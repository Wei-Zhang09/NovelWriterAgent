/**
 * 摘要人工确认关口测试（补缺口：ADR-0006 约束 C）
 *
 * ## 要证明的核心命题
 *
 *   **未确认的摘要不得进入检索索引。**
 *
 * 这条如果不成立，ADR-0006 引用的教训就会重演：
 *   "摘要是长程记忆的源头，错一条污染后面几百章"
 *
 * 因此测试的重点不是"确认后能索引"，而是**"未确认绝对索引不进去"**，
 * 以及撤回确认后能清理掉已索引的内容。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SummaryIndexer, MemoryGatherer } from '@nwa/harness';
import { FtsIndex } from '@nwa/storage';
import { bigramTokenizer, Retriever, buildMatchExpression } from '@nwa/retrieval';
import { Logger } from '@nwa/core';
import { createTestProject, makeChapter, type TestProject } from './helpers.js';

const logger = new Logger('test:summary-gate', { level: 'error' });

let t: TestProject | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

/**
 * 在**记忆索引**里检索摘要。
 *
 * ⚠ 摘要进的是 memory_fts，而 Retriever.retrieve() 走的是 runner.search()
 *   → chapter_fts（章节正文）。两者的用途不同：
 *     章节索引 = "找出相关段落"
 *     记忆索引 = "找出相关设定"
 *   早期测试误用 Retriever 查摘要，导致"确认了也查不到"的假失败。
 */
function searchSummary(fts: FtsIndex, query: string) {
  const expr = buildMatchExpression(bigramTokenizer.query(query));
  return fts.searchMemory({ matchExpression: expr, limit: 10 });
}

function setup() {
  const proj = createTestProject();
  t = proj;
  const fts = new FtsIndex({ db: proj.db, tokenizer: bigramTokenizer, logger });
  const indexer = new SummaryIndexer({ repos: proj.repos, fts, logger });
  return { proj, fts, indexer };
}

/**
 * 造一个已提交且带摘要的章节。
 *
 * ⚠ 必须先建为 COMMITTING 再 setCommittedBody —— 该仓储方法会校验状态
 *   （§9.1「正文未验证不得覆盖正式章节」的代码层强制点），
 *   DRAFT 状态下调用会被正确拒绝（实测踩到）。
 */
function committedWithSummary(proj: TestProject, n: number, summary: string) {
  const c = makeChapter(proj, n, 'COMMITTING');
  proj.repos.chapters.setCommittedBody(c.id, `chapters/${String(n).padStart(3, '0')}.md`, summary);
  return proj.repos.chapters.get(c.id);
}

describe('⚠ 未确认的摘要不得进入索引（ADR-0006 约束 C）', () => {
  it('已提交但未确认 → indexBook 不索引它', () => {
    const { proj, fts, indexer } = setup();
    committedWithSummary(proj, 1, '张三离开故乡，踏上旅途。');

    const r = indexer.indexBook(proj.bookId);

    expect(r.indexed).toBe(0);
    expect(r.excludedUnapproved).toBe(1);
    expect(fts.stats().memoryRows).toBe(0);
  });

  it('⚠ 未确认的摘要内容检索不到（污染被物理阻断）', () => {
    const { proj, fts, indexer } = setup();
    committedWithSummary(proj, 1, '张三离开故乡。');
    indexer.indexBook(proj.bookId);

    expect(searchSummary(fts, '张三故乡')).toEqual([]);
  });

  it('确认后才索引，且能检索到', () => {
    const { proj, fts, indexer } = setup();
    const c = committedWithSummary(proj, 1, '张三离开故乡。');
    proj.repos.chapters.approveSummary(c.id);

    const r = indexer.indexBook(proj.bookId);
    expect(r.indexed).toBe(1);
    expect(r.excludedUnapproved).toBe(0);

    // ⚠ 摘要进的是 memory_fts（记忆索引），不是 chapter_fts（章节正文索引）。
    //   两者的用途不同：前者找"相关设定"，后者找"相关段落"。
    const retriever = new Retriever({ runner: fts, tokenizer: bigramTokenizer });
    expect(searchSummary(fts, '张三故乡').length).toBeGreaterThan(0);
    void retriever;
  });

  it('indexBook 报告被排除的数量（记忆缺失必须可见）', () => {
    const { proj, indexer } = setup();
    committedWithSummary(proj, 1, '第一章摘要。');
    committedWithSummary(proj, 2, '第二章摘要。');
    const c3 = committedWithSummary(proj, 3, '第三章摘要。');
    proj.repos.chapters.approveSummary(c3.id);

    const r = indexer.indexBook(proj.bookId);
    expect(r.indexed).toBe(1);
    expect(r.excludedUnapproved).toBe(2);
  });

  it('⚠ indexChapter 对未确认摘要返回 false 且不写入', () => {
    const { proj, fts, indexer } = setup();
    const c = committedWithSummary(proj, 1, '张三离开故乡。');

    const r = indexer.indexChapter(c.id);
    expect(r.indexed).toBe(false);
    expect(r.reason).toContain('未确认');
    expect(fts.stats().memoryRows).toBe(0);
  });

  it('作者修改摘要内容后索引的是修改后的版本', () => {
    const { proj, fts, indexer } = setup();
    const c = committedWithSummary(proj, 1, '机器生成的原始摘要。');
    proj.repos.chapters.approveSummary(c.id, '作者改写过的摘要：张三离乡。');
    indexer.indexBook(proj.bookId);

    expect(searchSummary(fts, '张三离乡')).toHaveLength(1);
    // 被改掉的旧内容不应命中
    expect(searchSummary(fts, '机器生成')).toEqual([]);
  });
});

describe('⚠ 撤回确认后必须清理已索引内容', () => {
  it('确认 → 索引 → 撤回 → 索引被移除', () => {
    const { proj, fts, indexer } = setup();
    const c = committedWithSummary(proj, 1, '张三离开故乡。');
    proj.repos.chapters.approveSummary(c.id);
    indexer.indexChapter(c.id);

    expect(searchSummary(fts, '张三故乡')).toHaveLength(1);

    // 作者发现摘要写错了 → 撤回确认
    proj.repos.chapters.revokeSummaryApproval(c.id);
    const r = indexer.indexChapter(c.id);

    expect(r.indexed).toBe(false);
    // ⚠ 关键：撤回后不能还检索得到
    expect(searchSummary(fts, '张三故乡')).toEqual([]);
  });

  it('indexBook 在撤回后同样排除该章', () => {
    const { proj, fts, indexer } = setup();
    const c = committedWithSummary(proj, 1, '张三离开故乡。');
    proj.repos.chapters.approveSummary(c.id);
    indexer.indexBook(proj.bookId);
    expect(fts.stats().memoryRows).toBe(1);

    proj.repos.chapters.revokeSummaryApproval(c.id);
    const r = indexer.indexBook(proj.bookId);

    expect(r.excludedUnapproved).toBe(1);
    // 注意：indexBook 只索引已确认的，不主动清理被撤回的旧行 ——
    // 因此这里断言的是"新索引不含它"，旧行由 indexChapter 负责清理。
    expect(r.indexed).toBe(0);
  });
});

describe('确认状态的数据操作', () => {
  it('approveSummary 记录确认时间', () => {
    const { proj } = setup();
    const c = committedWithSummary(proj, 1, '摘要');
    expect(c.summary_approved).toBe(0);

    const after = proj.repos.chapters.approveSummary(c.id);
    expect(after.summary_approved).toBe(1);
    expect(after.summary_approved_at).not.toBeNull();
  });

  it('无摘要的章节无法确认（明确报错）', () => {
    const { proj } = setup();
    const c = makeChapter(proj, 1);
    expect(() => proj.repos.chapters.approveSummary(c.id)).toThrow(/还没有摘要/);
  });

  it('listPendingSummaries 只列未确认的', () => {
    const { proj } = setup();
    committedWithSummary(proj, 1, 'A');
    const c2 = committedWithSummary(proj, 2, 'B');
    proj.repos.chapters.approveSummary(c2.id);

    const pending = proj.repos.chapters.listPendingSummaries(proj.bookId);
    expect(pending.map((c) => c.chapter_number)).toEqual([1]);

    const approved = proj.repos.chapters.listApprovedSummaries(proj.bookId);
    expect(approved.map((c) => c.chapter_number)).toEqual([2]);
  });

  it('未提交的章节不进入任何摘要清单', () => {
    const { proj } = setup();
    const c = makeChapter(proj, 1); // DRAFT 状态
    proj.repos.chapters.saveReview(c.id, { overallStatus: 'PASSED', issues: [] }, 'PASSED');

    expect(proj.repos.chapters.listPendingSummaries(proj.bookId)).toEqual([]);
    expect(proj.repos.chapters.listApprovedSummaries(proj.bookId)).toEqual([]);
  });
});

describe('与 Context（MemoryGatherer）的联动', () => {
  it('⚠ 未确认摘要不会出现在上下文的 topMemory 里', () => {
    const { proj, fts, indexer } = setup();
    committedWithSummary(proj, 1, '张三在城中遇到阿明。');
    indexer.indexBook(proj.bookId);

    const gatherer = new MemoryGatherer({
      retriever: new Retriever({ runner: fts, tokenizer: bigramTokenizer }),
      memoryIndex: fts,
      buildMatch: (q) => buildMatchExpression(bigramTokenizer.query(q)),
      logger,
    });
    const r = gatherer.gather('张三阿明');

    expect(r.retrieved).toBe(true);
    expect(r.entries).toEqual([]);
  });

  it('确认后摘要出现在 topMemory，且带可回溯 sourceRef', () => {
    const { proj, fts, indexer } = setup();
    const c = committedWithSummary(proj, 1, '张三在城中遇到阿明。');
    proj.repos.chapters.approveSummary(c.id);
    indexer.indexBook(proj.bookId);

    const gatherer = new MemoryGatherer({
      retriever: new Retriever({ runner: fts, tokenizer: bigramTokenizer }),
      memoryIndex: fts,
      buildMatch: (q) => buildMatchExpression(bigramTokenizer.query(q)),
      logger,
    });
    const r = gatherer.gather('张三阿明');

    expect(r.entries.length).toBeGreaterThan(0);
    // ⚠ §11：每条记忆必须带来源
    expect(r.entries[0]!.sourceRef).toBeTruthy();
    expect(r.entries[0]!.sourceRef).toContain('chapters/001.md');
  });

  it('检索层失败时 retrieved=false（不假装"没有相关记忆"）', () => {
    const broken = {
      retrieve() {
        throw new Error('索引不可用');
      },
    };
    const gatherer = new MemoryGatherer({ retriever: broken as never, logger });
    const r = gatherer.gather('张三');

    // ⚠ 关键：不能返回 { entries: [], retrieved: true } ——
    //   那会让调用方以为"史上没发生过相关的事"，从而让模型自行编造。
    expect(r.retrieved).toBe(false);
    expect(r.error).toContain('索引不可用');
  });

  it('空查询返回空且标记检索成功', () => {
    const { proj, fts } = setup();
    const gatherer = new MemoryGatherer({
      retriever: new Retriever({ runner: fts, tokenizer: bigramTokenizer }),
      logger,
    });
    const r = gatherer.gather('   ');
    expect(r.entries).toEqual([]);
    expect(r.retrieved).toBe(true);
    void proj;
  });
});

describe('索引与确认的组合场景', () => {
  it('批量场景：部分确认部分未确认', () => {
    const { proj, fts, indexer } = setup();
    committedWithSummary(proj, 1, '第一章：出发。');
    committedWithSummary(proj, 2, '第二章：遇阻。');
    const c3 = committedWithSummary(proj, 3, '第三章：转折。');
    committedWithSummary(proj, 4, '第四章：重逢。');
    proj.repos.chapters.approveSummary(c3.id);

    const r = indexer.indexBook(proj.bookId);
    expect(r.indexed).toBe(1);
    expect(r.excludedUnapproved).toBe(3);
    expect(fts.stats().memoryRows).toBe(1);
  });

  it('确认全部后索引数等于章节数', () => {
    const { proj, fts, indexer } = setup();
    for (let n = 1; n <= 3; n++) {
      const c = committedWithSummary(proj, n, `第 ${n} 章摘要内容。`);
      proj.repos.chapters.approveSummary(c.id);
    }
    const r = indexer.indexBook(proj.bookId);
    expect(r.indexed).toBe(3);
    expect(fts.stats().memoryRows).toBe(3);
  });

  it('重复 indexBook 不产生重复行（幂等）', () => {
    const { proj, fts, indexer } = setup();
    const c = committedWithSummary(proj, 1, '张三离开故乡。');
    proj.repos.chapters.approveSummary(c.id);

    indexer.indexBook(proj.bookId);
    indexer.indexBook(proj.bookId);
    indexer.indexBook(proj.bookId);

    expect(fts.stats().memoryRows).toBe(1);
  });
});
