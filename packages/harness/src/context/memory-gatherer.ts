/**
 * 上下文素材收集器（补缺口：把 FTS 检索接进 Context Engine）
 *
 * ## 为什么需要它
 *
 * Context Engine（STEP 5）负责**装配**：给什么槽位、怎么裁剪、超预算怎么办。
 * 但它不知道素材从哪来 —— 之前由 app 层手工拼（见 core-process 里的
 * `planner.planChapter`），只能靠结构化查询（Canon 列表 + 章摘要），
 * **没有长程检索**。
 *
 * 本模块补上这一段：用 Retriever（FTS + bm25）从已提交章节里
 * 找出与当前任务相关的段落，作为 `topMemory` 槽位的内容。
 *
 * ## 两条 §11 的硬约束
 *
 * 1. **每条都必须带 sourceRef** —— 无来源的内容不许进上下文。
 *    检索结果的 sourceRef 来自索引（chapters/NNN.md），可回溯到原文。
 * 2. **检索失败不静默降级为"没有记忆"** —— 那会让模型以为
 *    "史上没发生过相关的事"，从而自行编造。失败时记录 warning 并
 *    在装配报告里体现（返回 retrieval 状态）。
 */
import { Logger } from '@nwa/core';
import type { ContextEntry } from './types.js';

/**
 * 检索器接口（结构化类型，不 import @nwa/retrieval）。
 *
 * ⚠ 依赖方向：@nwa/retrieval → @nwa/harness（Retriever 依赖 harness 的
 *   ContextEntry 语境），反向 import 会成环。这里声明结构等价的最小接口 ——
 *   TypeScript 的结构化类型让 retrieval 的 Retriever 可直接传入。
 *   与 storage 的 FtsIndex、retrieval 的 FtsQueryRunner 同一手法。
 */
export interface RetrievalHitLike {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceRef: string;
  readonly snippet: string;
  readonly score: number;
}

export interface RetrievalTraceLike {
  readonly query: string;
  readonly hits: readonly RetrievalHitLike[];
  readonly matchedTokens: readonly string[];
  readonly totalMatched: number;
  readonly returned: number;
  readonly engine: string;
  readonly tookMs: number;
}

export interface RetrieverLike {
  retrieve(params: {
    readonly query: string;
    readonly limit?: number;
    readonly filter?: { bookId?: string };
  }): RetrievalTraceLike;
}

/**
 * 记忆索引查询接口（结构化类型）。
 *
 * ⚠ 为什么需要**两个**索引：
 *   chapter_fts —— 章节正文，回答"哪一段落相关"
 *   memory_fts  —— 摘要/事实，回答"哪条设定相关"
 *   两者的粒度与用途都不同。只查其一都会漏：
 *   只查章节会漏掉被压缩成摘要的长程信息（正是长程记忆的载体）。
 *
 * 传入的 tokenizer 由调用方提供，保证索引侧与查询侧同一实现。
 */
export interface MemoryIndexLike {
  searchMemory(params: {
    readonly matchExpression: string;
    readonly limit: number;
    readonly bookId?: string;
    readonly itemTypes?: readonly string[];
  }): {
    readonly id: string;
    readonly itemType: string;
    readonly sourceRef: string;
    readonly score: number;
  }[];
}

/** 构造 MATCH 表达式（由检索层提供，保证与索引侧同一分词口径） */
export type MatchExpressionBuilder = (query: string) => string;

/** 一条检索命中的加工结果 */
export interface MemoryCandidate extends ContextEntry {
  readonly score: number;
}

export interface GatherMemoryOptions {
  /** 是否同时检索记忆索引（默认 true） */
  readonly includeMemoryIndex?: boolean;
  /** 检索到的命中数上限（默认 8） */
  readonly limit?: number;
  /** 每条片段的最大字符数（默认 400） */
  readonly snippetChars?: number;
  /** 只在这些章节中检索（通常是已提交的、早于当前章的） */
  readonly bookId?: string;
}

export interface GatherMemoryResult {
  readonly entries: readonly MemoryCandidate[];
  /** 检索是否成功执行（false 表示检索层不可用，不是"没有相关记忆"） */
  readonly retrieved: boolean;
  readonly trace?: RetrievalTraceLike;
  /** 失败原因（retrieved=false 时有值） */
  readonly error?: string;
}

/**
 * 从已索引的章节正文中检索相关段落，组装成 `topMemory` 槽位条目。
 *
 * ⚠ 只读：不改索引、不写库。
 */
export class MemoryGatherer {
  private readonly retriever: RetrieverLike;
  private readonly logger: Logger;
  /** 按 sourceRef 取原文（用于生成片段）；不注入时片段留空 */
  private readonly readChapterText?: (sourceRef: string) => string | null;
  /** 记忆索引（可选）：摘要/事实的检索来源 */
  private readonly memoryIndex?: MemoryIndexLike;
  /** MATCH 表达式构造器（与索引侧同一分词口径） */
  private readonly buildMatch?: MatchExpressionBuilder;

  constructor(opts: {
    readonly retriever: RetrieverLike;
    readonly logger: Logger;
    readonly readChapterText?: (sourceRef: string) => string | null;
    readonly memoryIndex?: MemoryIndexLike;
    readonly buildMatch?: MatchExpressionBuilder;
  }) {
    this.retriever = opts.retriever;
    this.logger = opts.logger;
    if (opts.readChapterText) this.readChapterText = opts.readChapterText;
    if (opts.memoryIndex) this.memoryIndex = opts.memoryIndex;
    if (opts.buildMatch) this.buildMatch = opts.buildMatch;
  }

  /**
   * 按查询串收集相关记忆。
   *
   * @param query 检索意图（通常是本章目的 + 主要角色 + 地点）
   */
  gather(query: string, opts?: GatherMemoryOptions): GatherMemoryResult {
    const limit = opts?.limit ?? 8;
    const snippetChars = opts?.snippetChars ?? 400;

    if (query.trim().length === 0) {
      return { entries: [], retrieved: true };
    }

    let trace: RetrievalTraceLike;
    try {
      trace = this.retriever.retrieve({
        query,
        limit,
        ...(opts?.bookId ? { filter: { bookId: opts.bookId } } : {}),
      });
    } catch (e) {
      // ⚠ 不返回空数组假装"没有相关记忆" —— 那会让模型自行编造。
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn('记忆检索失败（上下文将缺少长程记忆）', { query, error: msg });
      return { entries: [], retrieved: false, error: msg };
    }

    const entries: MemoryCandidate[] = trace.hits.map((h) => {
      // ⚠ 来源必须可回溯：优先带上章节路径
      const sourceRef = h.sourceRef;
      const text = this.readChapterText ? (this.readChapterText(sourceRef) ?? '') : '';
      return {
        id: `mem_${h.id}`,
        sourceType: 'SUMMARY',
        sourceRef,
        content: text.length > 0 ? clip(text, snippetChars) : `（见 ${sourceRef}）`,
        // 检索命中的记忆按相关度给优先级，供 Context Engine 排序
        priority: Math.max(1, Math.round(h.score * 100)),
        score: h.score,
      };
    });

    // ── 记忆索引（摘要/事实）─────────────────────────────
    //
    // ⚠ 必须单独查：摘要进的是 memory_fts，章节正文进的是 chapter_fts。
    //   只查章节会漏掉被压缩成长程记忆的信息 —— 而那正是长篇最需要的。
    if (opts?.includeMemoryIndex !== false && this.memoryIndex && this.buildMatch) {
      try {
        const rows = this.memoryIndex.searchMemory({
          matchExpression: this.buildMatch(query),
          limit,
          ...(opts?.bookId ? { bookId: opts.bookId } : {}),
        });
        for (const row of rows) {
          entries.push({
            id: `memitem_${row.id}`,
            sourceType: row.itemType === 'FACT' ? 'FACT' : 'SUMMARY',
            sourceRef: row.sourceRef,
            content: row.sourceRef === 'revoked' ? '' : `（${row.itemType}）见 ${row.sourceRef}`,
            priority: Math.max(1, Math.round(row.score * 100)),
            score: row.score,
          });
        }
      } catch (e) {
        // 记忆索引查询失败不影响章节检索结果，但必须留痕
        this.logger.warn('记忆索引查询失败', {
          query,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    this.logger.debug('记忆检索完成', {
      query,
      hits: entries.length,
      tokens: trace.matchedTokens.length,
      took: trace.tookMs,
    });

    return { entries, retrieved: true, trace };
  }
}

/**
 * 截取片段。
 *
 * ⚠ 保留**开头**而不是取摘要：正文开头的场景设定信息密度最高，
 *   且截断位置明确（带省略号），不会让模型以为这是完整章节。
 */
function clip(text: string, n: number): string {
  const t = text.trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n)}……`;
}
