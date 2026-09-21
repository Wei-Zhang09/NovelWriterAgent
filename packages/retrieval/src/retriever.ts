/**
 * 检索与来源追踪（施工文档 §11）
 *
 * §11 原文要求：
 *   检索结果必须携带 { id, score, sourceType, sourceRef, snippet, whyMatched }
 *   **禁止返回没有来源的「无根记忆」**。
 *
 * 这里是该约束的落地：RetrievalHit 的 sourceRef 必填，
 * 且在构造时校验 —— 而不是在 Prompt 里提醒模型"请注明来源"。
 *
 * ⚠ 归属说明：本模块属于 **retrieval** 包而不是 harness。
 *   两者是平级包（互不依赖），而"怎么检索、召回为什么命中"本质是检索职责。
 *   早期曾误放在 harness/context 下，已纠正。
 */
import { AppError, ErrorCode } from '@nwa/core';
import { buildMatchExpression, type Tokenizer } from './tokenizer.js';

export type SourceType =
  | 'CANON'
  | 'FACT'
  | 'EVIDENCE'
  | 'SUMMARY'
  | 'PLAN'
  | 'SKILL'
  | 'MEMORY'
  | 'PROFILE';

export interface RetrievalHit {
  readonly id: string;
  readonly score: number;
  readonly sourceType: SourceType;
  /** ⚠ 必填（§11） */
  readonly sourceRef: string;
  readonly snippet: string;
  /** 为何命中：让检索可解释，而不是一个黑箱分数 */
  readonly whyMatched: string;
}

export interface RetrievalTrace {
  readonly query: string;
  readonly hits: readonly RetrievalHit[];
  /** 命中的词元（便于确认分词是否生效） */
  readonly matchedTokens: readonly string[];
  readonly totalMatched: number;
  readonly returned: number;
  /** 检索引擎标识（ADR-0004 要求锁死引擎声明） */
  readonly engine: 'sqlite-fts5-bm25';
  readonly tookMs: number;
}

/** FTS 查询接口：由 storage 层实现，这里只依赖抽象，便于测试替身 */
export interface FtsQueryRunner {
  search(params: {
    matchExpression: string;
    limit: number;
    filter?: { bookId?: string; sourceTypes?: readonly string[] };
  }): {
    id: string;
    sourceType: string;
    sourceRef: string;
    snippet: string;
    score: number;
  }[];
}

export interface RetrieveParams {
  readonly query: string;
  readonly limit?: number;
  readonly filter?: { bookId?: string; sourceTypes?: readonly string[] };
}

export class Retriever {
  private readonly runner: FtsQueryRunner;
  private readonly tokenizer: Tokenizer;

  constructor(opts: { runner: FtsQueryRunner; tokenizer: Tokenizer }) {
    this.runner = opts.runner;
    this.tokenizer = opts.tokenizer;
  }

  /**
   * 执行检索并返回带来源追踪的结果。
   *
   * 空查询返回空结果而**不报错** —— 调用方可能在没有检索需求时也调一次，
   * 报错会迫使调用方到处加判断。
   */
  retrieve(params: RetrieveParams): RetrievalTrace {
    const started = Date.now();
    const query = params.query.trim();
    const limit = params.limit ?? 20;

    const empty: RetrievalTrace = {
      query,
      hits: [],
      matchedTokens: [],
      totalMatched: 0,
      returned: 0,
      engine: 'sqlite-fts5-bm25',
      tookMs: 0,
    };

    if (query.length === 0) return { ...empty, tookMs: Date.now() - started };

    const tokens = this.tokenizer.query(query).filter((t) => t.trim().length > 0);
    if (tokens.length === 0) return { ...empty, tookMs: Date.now() - started };

    // ⚠ 多词元必须用 AND 连接，不能空格拼接（空格会被当短语，要求相邻）
    const matchExpression = buildMatchExpression(tokens);
    const raw = this.runner.search({
      matchExpression,
      limit,
      ...(params.filter ? { filter: params.filter } : {}),
    });

    const hits = raw.map((r) => this.toHit(r, tokens));

    return {
      query,
      hits,
      matchedTokens: tokens,
      totalMatched: raw.length,
      returned: hits.length,
      engine: 'sqlite-fts5-bm25',
      tookMs: Date.now() - started,
    };
  }

  /**
   * 把原始行转成 RetrievalHit，并在此处强制 sourceRef。
   *
   * 这是「禁止无根记忆」的最后一道闸门：即便上层数据有问题，
   * 无来源的条目也进不了检索结果。
   */
  private toHit(
    raw: { id: string; sourceType: string; sourceRef: string; snippet: string; score: number },
    tokens: readonly string[],
  ): RetrievalHit {
    if (!raw.sourceRef || raw.sourceRef.trim().length === 0) {
      throw new AppError(
        ErrorCode.STORAGE_QUERY_FAILED,
        `检索结果 ${raw.id} 缺少 sourceRef —— 禁止返回无根记忆（§11）`,
        { details: { id: raw.id, sourceType: raw.sourceType } },
      );
    }
    return {
      id: raw.id,
      score: raw.score,
      sourceType: raw.sourceType as SourceType,
      sourceRef: raw.sourceRef,
      snippet: raw.snippet,
      // 把命中词元写进 whyMatched，让「为什么召回这条」可查
      whyMatched: `命中词元：${tokens.join(' + ')}`,
    };
  }
}
