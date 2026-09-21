/**
 * FTS 检索测试（补缺口：ADR-0004 落地）
 *
 * ## 这组测试要回答的问题
 *
 * STEP 0 实测的原始问题：SQLite FTS5 内置 unicode61 把整段连续中文
 * 当**单一 token**，「张三」查不到「张三走了」—— 查全率 1/13。
 *
 * 因此这组测试的核心不是"FTS 能跑"，而是：
 *   **中文查询确实能召回到含该词的文档，且换一种说法也能召回。**
 *
 * 这条如果不过，FTS 就是"装上了但没用"，比没有更糟 ——
 * 因为会让 Context Engine 以为检索可用。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { FtsIndex } from '@nwa/storage';
import { bigramTokenizer } from '@nwa/retrieval';
import { Retriever } from '@nwa/retrieval';
import { Logger } from '@nwa/core';
import { createTestProject, type TestProject } from './helpers.js';

const logger = new Logger('test:fts', { level: 'error' });

let t: TestProject | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function ftsOf(proj: TestProject) {
  return new FtsIndex({ db: proj.db, tokenizer: bigramTokenizer, logger });
}

describe('⚠ 中文可检索性（ADR-0004 的核心目标）', () => {
  it('「张三」能召回含「张三走了」的章节', () => {
    t = createTestProject();
    const fts = ftsOf(t);
    fts.indexChapter({
      chapterId: 'ch1',
      bookId: t.bookId,
      chapterNumber: 1,
      sourceRef: 'chapters/001.md',
      text: '张三走了，李四来了。',
    });

    const hits = fts.search({ matchExpression: '"张" AND "三"', limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.sourceRef).toBe('chapters/001.md');
  });

  it('⚠ 换一种说法也能召回（这才是"检索"而非"精确匹配"）', () => {
    t = createTestProject();
    const fts = ftsOf(t);
    fts.indexChapter({
      chapterId: 'ch1',
      bookId: t.bookId,
      chapterNumber: 1,
      sourceRef: 'chapters/001.md',
      text: '他推开门，看见母亲坐在灯下缝补衣裳。',
    });

    // 查询"母亲缝衣"—— 字面上与原文并不连续
    const retriever = new Retriever({ runner: fts, tokenizer: bigramTokenizer });
    const r = retriever.retrieve({ query: '母亲缝衣' });

    expect(r.hits.length).toBeGreaterThan(0);
  });

  it('⚠ 对比：不做分词时（整句当一词）会查不到', () => {
    t = createTestProject();
    // 模拟"未分词直接索引"：把整句作为一个 token
    t.db.run(
      'INSERT INTO chapter_fts (tokens, chapter_id, book_id, chapter_number, source_ref) VALUES (?, ?, ?, ?, ?)',
      '张三走了李四来了', // 无空格 = 单一 token
      'ch_raw',
      t.bookId,
      1,
      'chapters/raw.md',
    );

    // 用分词后的查询词去查 —— 匹配不上，这正是 STEP 0 的 1/13 问题
    const fts = ftsOf(t);
    const hits = fts.search({ matchExpression: '"张" AND "三"', limit: 10 });
    expect(hits).toHaveLength(0);
  });

  it('多个词元以 AND 连接可精确定位（而非短语相邻要求）', () => {
    t = createTestProject();
    const fts = ftsOf(t);
    fts.indexChapter({
      chapterId: 'ch1',
      bookId: t.bookId,
      chapterNumber: 1,
      sourceRef: 'chapters/001.md',
      text: '张三去了城里。李四留在村中。',
    });
    fts.indexChapter({
      chapterId: 'ch2',
      bookId: t.bookId,
      chapterNumber: 2,
      sourceRef: 'chapters/002.md',
      text: '李四也去了城里。',
    });

    // 查"张三"应只命中 ch1
    const hits = fts.search({ matchExpression: '"张" AND "三"', limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('ch1');
  });

  it('中文单字查询也能召回（bigram 保留 1-gram 的原因）', () => {
    t = createTestProject();
    const fts = ftsOf(t);
    fts.indexChapter({
      chapterId: 'ch1',
      bookId: t.bookId,
      chapterNumber: 1,
      sourceRef: 'chapters/001.md',
      text: '刀光一闪。',
    });
    expect(fts.search({ matchExpression: '"刀"', limit: 10 })).toHaveLength(1);
  });
});

describe('索引写入的幂等性', () => {
  it('⚠ 同一章节重复索引不产生重复行', () => {
    t = createTestProject();
    const fts = ftsOf(t);
    const input = {
      chapterId: 'ch1',
      bookId: t.bookId,
      chapterNumber: 1,
      sourceRef: 'chapters/001.md',
      text: '张三走了。',
    };
    fts.indexChapter(input);
    fts.indexChapter(input);
    fts.indexChapter(input);

    // FTS5 虚拟表没有唯一约束 → 必须靠先删后插保证幂等
    const hits = fts.search({ matchExpression: '"张"', limit: 10 });
    expect(hits).toHaveLength(1);
    expect(fts.stats().chapterRows).toBe(1);
  });

  it('更新正文后索引反映新内容（旧内容不再命中）', () => {
    t = createTestProject();
    const fts = ftsOf(t);
    fts.indexChapter({
      chapterId: 'ch1',
      bookId: t.bookId,
      chapterNumber: 1,
      sourceRef: 'chapters/001.md',
      text: '张三走了。',
    });
    fts.indexChapter({
      chapterId: 'ch1',
      bookId: t.bookId,
      chapterNumber: 1,
      sourceRef: 'chapters/001.md',
      text: '王五来了。',
    });

    expect(fts.search({ matchExpression: '"张"', limit: 10 })).toHaveLength(0);
    expect(fts.search({ matchExpression: '"王"', limit: 10 })).toHaveLength(1);
  });

  it('空文本不会写入空 token 行', () => {
    t = createTestProject();
    const fts = ftsOf(t);
    expect(fts.indexChapter({
      chapterId: 'ch1',
      bookId: t.bookId,
      chapterNumber: 1,
      sourceRef: 'chapters/001.md',
      text: '   \n  ',
    })).toBe(0);
    expect(fts.stats().chapterRows).toBe(0);
  });

  it('标点符号不进入词元（避免污染词元表）', () => {
    t = createTestProject();
    const fts = ftsOf(t);
    fts.indexChapter({
      chapterId: 'ch1',
      bookId: t.bookId,
      chapterNumber: 1,
      sourceRef: 'chapters/001.md',
      text: '「张三！」……（笑）。',
    });
    // 标点被丢弃，但中文词元保留
    expect(fts.search({ matchExpression: '"张"', limit: 10 })).toHaveLength(1);
    // 不应因标点产生畸形词元
    expect(fts.stats().chapterRows).toBe(1);
  });
});

describe('bm25 排序（相关度）', () => {
  it('命中词更多的文档排序靠前', () => {
    t = createTestProject();
    const fts = ftsOf(t);
    fts.indexChapter({
      chapterId: 'few',
      bookId: t.bookId,
      chapterNumber: 1,
      sourceRef: 'chapters/001.md',
      text: '张三今天出门了，天气不错，路上遇到许多人与他打招呼。',
    });
    fts.indexChapter({
      chapterId: 'many',
      bookId: t.bookId,
      chapterNumber: 2,
      sourceRef: 'chapters/002.md',
      text: '张三看着张三留下的东西，想起张三说过的话。',
    });

    const hits = fts.search({ matchExpression: '"张" AND "三"', limit: 10 });
    expect(hits).toHaveLength(2);
    // score 已取负转正（越大越相关）
    expect(hits[0]!.score).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe('many');
  });
});

describe('bookId 过滤（多书隔离）', () => {
  it('只返回指定书的命中', () => {
    t = createTestProject();
    const fts = ftsOf(t);
    fts.indexChapter({
      chapterId: 'a1',
      bookId: 'book_a',
      chapterNumber: 1,
      sourceRef: 'a/001.md',
      text: '张三走了。',
    });
    fts.indexChapter({
      chapterId: 'b1',
      bookId: 'book_b',
      chapterNumber: 1,
      sourceRef: 'b/001.md',
      text: '张三也走了。',
    });

    const only = fts.search({ matchExpression: '"张"', limit: 10, filter: { bookId: 'book_a' } });
    expect(only).toHaveLength(1);
    expect(only[0]!.id).toBe('a1');

    expect(fts.search({ matchExpression: '"张"', limit: 10 })).toHaveLength(2);
  });
});

describe('记忆索引（摘要/事实）', () => {
  it('记忆项可检索且能按键类型过滤', () => {
    t = createTestProject();
    const fts = ftsOf(t);
    fts.indexMemory({
      itemId: 'mem1',
      bookId: t.bookId,
      itemType: 'SUMMARY',
      sourceRef: 'summaries/001.md',
      text: '张三在城中遇到了阿明。',
    });
    fts.indexMemory({
      itemId: 'mem2',
      bookId: t.bookId,
      itemType: 'FACT',
      sourceRef: 'facts/fact_1',
      text: '阿明双目失明。',
    });

    expect(fts.searchMemory({ matchExpression: '"张"', limit: 10 })).toHaveLength(1);
    expect(fts.searchMemory({ matchExpression: '"阿" AND "明"', limit: 10 })).toHaveLength(2);
    expect(
      fts.searchMemory({ matchExpression: '"阿"', limit: 10, itemTypes: ['FACT'] }),
    ).toHaveLength(1);
  });

  it('记忆索引同样幂等', () => {
    t = createTestProject();
    const fts = ftsOf(t);
    const m = {
      itemId: 'mem1',
      bookId: t.bookId,
      itemType: 'SUMMARY',
      sourceRef: 'summaries/001.md',
      text: '张三走了。',
    };
    fts.indexMemory(m);
    fts.indexMemory(m);
    expect(fts.searchMemory({ matchExpression: '"张"', limit: 10 })).toHaveLength(1);
  });
});

describe('rebuild（§59：FTS 是 Derived，必须可重建）', () => {
  it('⚠ 重建后索引内容与重建前一致', () => {
    t = createTestProject();
    const fts = ftsOf(t);
    const chapters = [
      { chapterId: 'c1', bookId: t.bookId, chapterNumber: 1, sourceRef: 'chapters/001.md', text: '张三走了。' },
      { chapterId: 'c2', bookId: t.bookId, chapterNumber: 2, sourceRef: 'chapters/002.md', text: '李四来了。' },
    ];
    fts.rebuild({ chapters, memories: [] });
    const before = fts.search({ matchExpression: '"张"', limit: 10 });

    fts.rebuild({ chapters, memories: [] });
    const after = fts.search({ matchExpression: '"张"', limit: 10 });

    expect(after.map((h) => h.id)).toEqual(before.map((h) => h.id));
  });

  it('rebuild 会清掉不再存在的条目的索引', () => {
    t = createTestProject();
    const fts = ftsOf(t);
    fts.indexChapter({
      chapterId: 'stale',
      bookId: t.bookId,
      chapterNumber: 99,
      sourceRef: 'chapters/099.md',
      text: '张三走了。',
    });
    expect(fts.stats().chapterRows).toBe(1);

    // 重建时只提供 1 条 → 旧的 stale 记录应消失
    fts.rebuild({
      chapters: [
        { chapterId: 'c1', bookId: t.bookId, chapterNumber: 1, sourceRef: 'chapters/001.md', text: '李四来了。' },
      ],
      memories: [],
    });
    expect(fts.stats().chapterRows).toBe(1);
    expect(fts.search({ matchExpression: '"张"', limit: 10 })).toHaveLength(0);
  });

  it('FTS5 原生 rebuild 命令可执行（外部内容表模式）', () => {
    t = createTestProject();
    // 不应抛错 —— 这是 §59「可 rebuild」的物理保证
    expect(() => t!.db.run("INSERT INTO chapter_fts(chapter_fts) VALUES('rebuild')")).not.toThrow();
  });
});

describe('与 Retriever 的端到端集成', () => {
  it('Retriever 能直接使用 FtsIndex 作为 runner', () => {
    t = createTestProject();
    const fts = ftsOf(t);
    fts.indexChapter({
      chapterId: 'ch1',
      bookId: t.bookId,
      chapterNumber: 1,
      sourceRef: 'chapters/001.md',
      text: '张三推开门，看见母亲在灯下缝补。',
    });

    const retriever = new Retriever({ runner: fts, tokenizer: bigramTokenizer });
    const r = retriever.retrieve({ query: '张三', limit: 5 });

    expect(r.hits).toHaveLength(1);
    expect(r.engine).toBe('sqlite-fts5-bm25');
    // 命中必须带 sourceRef —— 这是"无根记忆"的防线
    expect(r.hits[0]!.sourceRef).toBe('chapters/001.md');
    // 词元可解释（便于排查"为什么没查到"）
    expect(r.matchedTokens).toContain('张');
  });

  it('多词查询的 MATCH 表达式是 AND 而非短语', () => {
    t = createTestProject();
    const fts = ftsOf(t);
    // 两个词在文中不相邻
    fts.indexChapter({
      chapterId: 'ch1',
      bookId: t.bookId,
      chapterNumber: 1,
      sourceRef: 'chapters/001.md',
      text: '张三走了很远的路，后来才见到阿明。',
    });

    const retriever = new Retriever({ runner: fts, tokenizer: bigramTokenizer });
    // "张三阿明" 在原文中不相邻；若用短语匹配会失败
    const r = retriever.retrieve({ query: '张三阿明' });
    expect(r.hits).toHaveLength(1);
  });

  it('空查询返回空结果而不报错', () => {
    t = createTestProject();
    const retriever = new Retriever({ runner: ftsOf(t), tokenizer: bigramTokenizer });
    expect(retriever.retrieve({ query: '   ' }).hits).toEqual([]);
    expect(retriever.retrieve({ query: '!!!' }).hits).toEqual([]);
  });
});
