/**
 * 中文分词与 FTS 预处理测试（ADR-0004）
 *
 * 这些断言的依据是 STEP 0 的实测数据：
 *   默认 tokenizer 查全率 1/13 → bigram/jieba 8/8 且零误召回。
 */
import { describe, it, expect } from 'vitest';
import { bigramTokens, bigramTokenizer, buildMatchExpression } from '@nwa/retrieval';

describe('bigram 索引文本', () => {
  it('对连续 CJK 生成 1-gram + 2-gram（1-gram 保证单字可召回）', () => {
    expect(bigramTokens('张三')).toEqual(['张', '三', '张三']);
  });

  it('丢弃标点与空白，避免污染词元表', () => {
    // 实现按「连续 CJK 段」逐个处理：每段先出自己的 1-gram，再出自己的 2-gram
    expect(bigramTokens('张三，李四。')).toEqual(['张', '三', '张三', '李', '四', '李四']);
  });

  it('非 CJK 内容不进入索引', () => {
    expect(bigramTokens('hello 世界')).toEqual(['世', '界', '世界']);
  });

  it('index() 输出空格分隔文本', () => {
    expect(bigramTokenizer.index('张三')).toBe('张 三 张三');
  });
});

describe('MATCH 表达式构造', () => {
  it('词元用双引号包裹并以 AND 连接', () => {
    expect(buildMatchExpression(['张', '三'])).toBe('"张" AND "三"');
  });

  it('⚠ 词组必须用 AND 而非空格（空格会被当作短语，要求相邻）', () => {
    const expr = buildMatchExpression(['张三', '走了']);
    expect(expr).toContain(' AND ');
    expect(expr).not.toBe('"张三" "走了"');
  });

  it('转义双引号防注入', () => {
    expect(buildMatchExpression(['a"b'])).toBe('"a""b"');
  });

  it('限制词元数量上限（64）', () => {
    const many = Array.from({ length: 100 }, (_, i) => `w${i}`);
    expect(buildMatchExpression(many).split(' AND ')).toHaveLength(64);
  });

  it('空词元拒绝构造（避免全表返回）', () => {
    expect(() => buildMatchExpression([])).toThrow();
    expect(() => buildMatchExpression(['  '])).toThrow();
  });
});
