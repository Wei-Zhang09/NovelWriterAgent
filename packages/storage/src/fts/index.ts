/**
 * FTS5 检索执行器（ADR-0004，施工文档 §11）
 *
 * 实现 @nwa/retrieval 的 FtsQueryRunner 接口，负责真正对 SQLite 发起查询。
 *
 * ## 为什么索引与查询必须共用同一个 Tokenizer 实例
 *
 * 索引侧把正文变成 `"张 三 张三 三走 走了 ..."`（空格分隔）；
 * 查询侧必须用**同一实现**把 "张三" 变成 `["张","三","张三"]`，
 * 再用 AND 连接成 MATCH 表达式。
 * 两侧分词不一致 → 查不到（这正是 ADR-0004 要解决的问题）。
 *
 * ## 为什么内容列用外部内容表（content=''）
 *
 * 避免原文被存两份。tokens 列只存词元，原文仍在 chapters/ 与 facts 表里。
 * 代价是 rebuild 时需要外部回填 —— 见 `rebuildChapterIndex`。
 */
import { Logger } from '@nwa/core';
import type { Database } from '../database.js';

/**
 * 分词器接口（结构化类型，不 import @nwa/retrieval）。
 *
 * ⚠ 依赖方向：@nwa/retrieval → @nwa/storage，反向 import 会成环。
 *   这里声明一个**结构等价**的最小接口 —— TypeScript 的结构化类型
 *   让 retrieval 的 Tokenizer 可以直接传进来，无需任何转换或适配。
 *   这与 Retriever 反向声明 FtsQueryRunner 是同一手法（接口倒置）。
 */
export interface Tokenizer {
  readonly kind: 'jieba' | 'bigram';
  /** 把原文转成空格分隔的索引文本 */
  index(text: string): string;
  /** 把查询串转成词元数组 */
  query(text: string): string[];
}

/** 索引一条章节正文 */
export interface IndexChapterInput {
  readonly chapterId: string;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly sourceRef: string;
  readonly text: string;
}

/** 索引一条记忆项（摘要/事实/伏笔） */
export interface IndexMemoryInput {
  readonly itemId: string;
  readonly bookId: string;
  readonly itemType: string;
  readonly sourceRef: string;
  readonly text: string;
}

/**
 * 把 FTS5 的 MATCH 语法特殊字符处理掉。
 *
 * ⚠ 词元里若含 `"` `*` `(` `)` 等会破坏表达式或被当操作符。
 *   buildMatchExpression 已用双引号包裹并把内部 `"` 转义为 `""`，
 *   这里再挡一层：过滤掉纯符号词元（它们既无检索价值又会引入语法风险）。
 */
function sanitizeToken(t: string): string | null {
  const s = t.trim();
  if (s.length === 0) return null;
  // 只保留含字母/数字/汉字的词元
  if (!/[\p{L}\p{N}]/u.test(s)) return null;
  return s;
}

export class FtsIndex {
  private readonly db: Database;
  private readonly tokenizer: Tokenizer;
  private readonly logger: Logger;

  constructor(opts: { readonly db: Database; readonly tokenizer: Tokenizer; readonly logger: Logger }) {
    this.db = opts.db;
    this.tokenizer = opts.tokenizer;
    this.logger = opts.logger;
  }

  /**
   * 检索章节正文。
   *
   * 实现 FtsQueryRunner.search —— 返回的不是最终 RetrievalHit，
   * 而是带 score 的原始行（由 Retriever 负责组装与来源校验）。
   */
  search(params: {
    readonly matchExpression: string;
    readonly limit: number;
    readonly filter?: { bookId?: string; sourceTypes?: readonly string[] };
  }): {
    id: string;
    sourceType: string;
    sourceRef: string;
    snippet: string;
    score: number;
  }[] {
    const rows = this.db.all<{
      chapter_id: string;
      book_id: string;
      source_ref: string;
      score: number;
    }>(
      // bm25() 返回**越小越相关**的负值，取负转成"越大越相关"，便于调用方排序
      `SELECT chapter_id, book_id, source_ref, -bm25(chapter_fts) AS score
         FROM chapter_fts
        WHERE chapter_fts MATCH ?
          AND (? IS NULL OR book_id = ?)
        ORDER BY score DESC
        LIMIT ?`,
      params.matchExpression,
      params.filter?.bookId ?? null,
      params.filter?.bookId ?? null,
      Math.max(1, Math.min(params.limit, 200)),
    );

    return rows.map((r) => ({
      id: r.chapter_id,
      sourceType: 'CHAPTER',
      sourceRef: r.source_ref,
      // 外部内容表模式下 FTS5 无法生成 snippet（无原文），
      // 需要片段时由调用方按 body_path 读原文再截取。
      snippet: '',
      score: r.score,
    }));
  }

  /**
   * 检索记忆项（摘要/事实/伏笔）。
   *
   * 与章节检索分开是因为两者的用途不同：
   * 章节检索用于"找出相关段落"，记忆检索用于"找出相关设定"，
   * 且记忆项的字数小、命中更精准。
   */
  searchMemory(params: {
    readonly matchExpression: string;
    readonly limit: number;
    readonly bookId?: string;
    readonly itemTypes?: readonly string[];
  }): {
    id: string;
    itemType: string;
    sourceRef: string;
    score: number;
  }[] {
    const rows = this.db.all<{
      item_id: string;
      item_type: string;
      source_ref: string;
      score: number;
    }>(
      `SELECT item_id, item_type, source_ref, -bm25(memory_fts) AS score
         FROM memory_fts
        WHERE memory_fts MATCH ?
          AND (? IS NULL OR book_id = ?)
        ORDER BY score DESC
        LIMIT ?`,
      params.matchExpression,
      params.bookId ?? null,
      params.bookId ?? null,
      Math.max(1, Math.min(params.limit, 200)),
    );
    return rows
      .filter((r) => !params.itemTypes || params.itemTypes.includes(r.item_type))
      .map((r) => ({
        id: r.item_id,
        itemType: r.item_type,
        sourceRef: r.source_ref,
        score: r.score,
      }));
  }

  // ── 索引写入 ──────────────────────────────────────────────

  /**
   * 索引一条章节正文（幂等：同 chapter_id 先删后插）。
   *
   * ⚠ 先删后插而不是 INSERT OR REPLACE：FTS5 的虚拟表没有唯一约束，
   *   直接追加会产生重复行，导致同一章节在检索结果里出现多次。
   */
  indexChapter(input: IndexChapterInput): number {
    const tokens = this.tokenize(input.text);
    this.db.run('DELETE FROM chapter_fts WHERE chapter_id = ?', input.chapterId);
    if (tokens.length === 0) return 0;
    this.db.run(
      'INSERT INTO chapter_fts (tokens, chapter_id, book_id, chapter_number, source_ref) VALUES (?, ?, ?, ?, ?)',
      tokens.join(' '),
      input.chapterId,
      input.bookId,
      input.chapterNumber,
      input.sourceRef,
    );
    return tokens.length;
  }

  /** 索引一条记忆项（幂等） */
  indexMemory(input: IndexMemoryInput): number {
    const tokens = this.tokenize(input.text);
    this.db.run('DELETE FROM memory_fts WHERE item_id = ?', input.itemId);
    if (tokens.length === 0) return 0;
    this.db.run(
      'INSERT INTO memory_fts (tokens, item_id, book_id, item_type, source_ref) VALUES (?, ?, ?, ?, ?)',
      tokens.join(' '),
      input.itemId,
      input.bookId,
      input.itemType,
      input.sourceRef,
    );
    return tokens.length;
  }

  /**
   * 清空并重建全部索引。
   *
   * ⚠ 由调用方提供数据源 —— 索引层不读业务表，避免依赖倒挂。
   */
  rebuild(input: {
    readonly chapters: readonly IndexChapterInput[];
    readonly memories: readonly IndexMemoryInput[];
  }): { readonly chaptersIndexed: number; readonly memoriesIndexed: number } {
    this.db.run('DELETE FROM chapter_fts');
    this.db.run('DELETE FROM memory_fts');
    for (const c of input.chapters) this.indexChapter(c);
    for (const m of input.memories) this.indexMemory(m);
    this.logger.info('FTS 索引已重建', {
      chapters: input.chapters.length,
      memories: input.memories.length,
    });
    return { chaptersIndexed: input.chapters.length, memoriesIndexed: input.memories.length };
  }

  /** 索引概览（UI 与验收断言） */
  stats(): { readonly chapterRows: number; readonly memoryRows: number } {
    const c = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chapter_fts');
    const m = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_fts');
    return { chapterRows: c?.n ?? 0, memoryRows: m?.n ?? 0 };
  }

  private tokenize(text: string): string[] {
    return this.tokenizer
      .index(text)
      .split(/\s+/)
      .map(sanitizeToken)
      .filter((t): t is string => t !== null);
  }
}
