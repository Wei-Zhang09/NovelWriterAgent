/**
 * Retriever 测试（STEP 5 / §11）
 *
 * 重点：检索层的「禁止无根记忆」闸门 —— 即便上游数据没有来源，
 * 无来源的条目也进不了检索结果。
 */
import { describe, it, expect } from 'vitest';
import { Retriever, bigramTokenizer } from '@nwa/retrieval';
import type { FtsQueryRunner } from '@nwa/retrieval';
import { AppError } from '@nwa/core';

/** 记录收到的 MATCH 表达式，便于断言分词是否正确应用于查询侧 */
function makeRunner(
  rows: { id: string; sourceType: string; sourceRef: string; snippet: string; score: number }[] = [],
): { runner: FtsQueryRunner; calls: { matchExpression: string; limit: number; filter?: unknown }[] } {
  const calls: { matchExpression: string; limit: number; filter?: unknown }[] = [];
  const runner: FtsQueryRunner = {
    search(params) {
      calls.push({
        matchExpression: params.matchExpression,
        limit: params.limit,
        ...(params.filter ? { filter: params.filter } : {}),
      });
      return rows;
    },
  };
  return { runner, calls };
}

const hit = (over: Partial<{ id: string; sourceType: string; sourceRef: string; snippet: string; score: number }> = {}) => ({
  id: 'm1',
  sourceType: 'SUMMARY',
  sourceRef: 'summaries/012.md',
  snippet: '张三在城门口等李四',
  score: 1.5,
  ...over,
});

describe('检索与来源追踪', () => {
  it('返回结果带完整来源字段', () => {
    const { runner } = makeRunner([hit()]);
    const rt = new Retriever({ runner, tokenizer: bigramTokenizer });
    const trace = rt.retrieve({ query: '张三' });

    expect(trace.hits).toHaveLength(1);
    expect(trace.hits[0]!.sourceRef).toBe('summaries/012.md');
    expect(trace.hits[0]!.sourceType).toBe('SUMMARY');
    expect(trace.engine).toBe('sqlite-fts5-bm25');
  });

  it('whyMatched 记录命中词元（检索可解释）', () => {
    const { runner } = makeRunner([hit()]);
    const rt = new Retriever({ runner, tokenizer: bigramTokenizer });
    const trace = rt.retrieve({ query: '张三' });
    expect(trace.hits[0]!.whyMatched).toContain('张三');
    expect(trace.hits[0]!.whyMatched).toMatch(/命中词元/);
  });

  it('⚠ 多词元用 AND 连接（空格会被当短语，是常见错误）', () => {
    const { runner, calls } = makeRunner([hit()]);
    const rt = new Retriever({ runner, tokenizer: bigramTokenizer });
    rt.retrieve({ query: '张三' }); // bigram → 张, 三, 张三
    expect(calls[0]!.matchExpression).toContain(' AND ');
    expect(calls[0]!.matchExpression).not.toMatch(/"张"\s+"三"/);
  });

  it('matchedTokens 暴露分词结果（便于确认分词生效）', () => {
    const { runner } = makeRunner([]);
    const rt = new Retriever({ runner, tokenizer: bigramTokenizer });
    const trace = rt.retrieve({ query: '张三' });
    expect(trace.matchedTokens).toEqual(['张', '三', '张三']);
  });
});

describe('⚠ 禁止无根记忆（§11 的最终闸门）', () => {
  it('上游返回缺 sourceRef 的行 → 抛 EVIDENCE_ 类错误而不是静默放行', () => {
    const { runner } = makeRunner([hit({ sourceRef: '' })]);
    const rt = new Retriever({ runner, tokenizer: bigramTokenizer });
    let err: unknown;
    try {
      rt.retrieve({ query: '张三' });
    } catch (e) {
      err = e;
    }
    expect(AppError.isAppError(err)).toBe(true);
    if (AppError.isAppError(err)) {
      expect(err.message).toMatch(/缺少 sourceRef/);
      expect(err.message).toMatch(/禁止返回无根记忆/);
    }
  });

  it('只有空白的 sourceRef 同样被拦截', () => {
    const { runner } = makeRunner([hit({ sourceRef: '   ' })]);
    const rt = new Retriever({ runner, tokenizer: bigramTokenizer });
    expect(() => rt.retrieve({ query: '张三' })).toThrow(/缺少 sourceRef/);
  });

  it('合法来源正常通过（对照组）', () => {
    const { runner } = makeRunner([hit({ sourceRef: 'fact_123' })]);
    const rt = new Retriever({ runner, tokenizer: bigramTokenizer });
    expect(rt.retrieve({ query: '张三' }).hits).toHaveLength(1);
  });
});

describe('查询边界', () => {
  it('空查询返回空结果而不报错（调用方不必到处加判断）', () => {
    const { runner, calls } = makeRunner([hit()]);
    const rt = new Retriever({ runner, tokenizer: bigramTokenizer });
    const trace = rt.retrieve({ query: '   ' });
    expect(trace.hits).toEqual([]);
    expect(trace.totalMatched).toBe(0);
    expect(calls).toHaveLength(0); // 没有发起查询
  });

  it('查询只含非 CJK 字符时返回空（bigram 只索引 CJK）', () => {
    const { runner, calls } = makeRunner([hit()]);
    const rt = new Retriever({ runner, tokenizer: bigramTokenizer });
    const trace = rt.retrieve({ query: 'hello' });
    expect(trace.hits).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('limit 透传给底层查询', () => {
    const { runner, calls } = makeRunner([]);
    const rt = new Retriever({ runner, tokenizer: bigramTokenizer });
    rt.retrieve({ query: '张三', limit: 5 });
    expect(calls[0]!.limit).toBe(5);
  });

  it('filter 透传（支持按书与来源类型过滤）', () => {
    const { runner, calls } = makeRunner([]);
    const rt = new Retriever({ runner, tokenizer: bigramTokenizer });
    rt.retrieve({ query: '张三', filter: { bookId: 'book_1', sourceTypes: ['FACT'] } });
    expect(calls[0]!.filter).toEqual({ bookId: 'book_1', sourceTypes: ['FACT'] });
  });

  it('记录耗时（Run 可观测性）', () => {
    const { runner } = makeRunner([hit()]);
    const rt = new Retriever({ runner, tokenizer: bigramTokenizer });
    const trace = rt.retrieve({ query: '张三' });
    expect(trace.tookMs).toBeGreaterThanOrEqual(0);
    expect(trace.returned).toBe(1);
  });
});
