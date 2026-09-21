/**
 * 中文分词与 FTS 预处理（ADR-0004）
 *
 * 背景（STEP 0 实测）：SQLite FTS5 内置 unicode61 把**整段连续中文当一个 token**，
 * 导致「张三」查不到「张三走了」——8 查询词 / 13 文档-词对实测查全率仅 1/13。
 *
 * 因此：写入 FTS 前必须分词（空格连接），查询侧必须用同一分词器并以 AND 连接词元。
 */
import { AppError, ErrorCode } from '@nwa/core';

export type TokenizerKind = 'jieba' | 'bigram';

const CJK_RUN = /[\u4e00-\u9fff\u3400-\u4dbf]+/g;

/**
 * bigram 索引文本：对连续 CJK 段生成 1-gram + 2-gram，非 CJK 全部丢弃。
 *
 * 保留 1-gram 是为了让单字查询可召回；丢弃标点是为了避免污染词元表。
 * 实测召回 8/8、零误召回，索引膨胀约 3.94x（ADR-0004）。
 */
export function bigramTokens(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(CJK_RUN) ?? []) {
    for (let i = 0; i < run.length; i++) out.push(run[i]!);
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

/** 分词器接口：索引侧与查询侧必须使用同一实例的同一实现 */
export interface Tokenizer {
  readonly kind: TokenizerKind;
  /** 把原文转成空格分隔的索引文本 */
  index(text: string): string;
  /** 把查询串转成词元数组 */
  query(text: string): string[];
}

/** bigram 分词器（零依赖，ADR-0004 的兜底方案） */
export const bigramTokenizer: Tokenizer = {
  kind: 'bigram',
  index: (text) => bigramTokens(text).join(' '),
  query: (text) => bigramTokens(text),
};

/** jieba 分词器（ADR-0004 主方案，依赖 @node-rs/jieba 注入） */
export function createJiebaTokenizer(cut: (text: string) => string[]): Tokenizer {
  const tokens = (text: string): string[] => cut(text).filter((t) => t.trim().length > 0);
  return {
    kind: 'jieba',
    index: (text) => tokens(text).join(' '),
    query: (text) => tokens(text),
  };
}

/**
 * 构造 FTS5 MATCH 表达式。
 *
 * 每个词元用双引号包裹（防止 FTS5 保留字注入），以 AND 连接
 * —— 多词元用空格连接会被解析为"短语"，要求相邻，是常见错误。
 */
export function buildMatchExpression(tokens: readonly string[]): string {
  const safe = tokens
    .map((t) => t.replace(/"/g, '""').trim())
    .filter((t) => t.length > 0)
    .slice(0, 64); // 研究报告 §1.2 决策 7：限制 64 个词元
  if (safe.length === 0) {
    throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, '查询词元为空，拒绝构造 MATCH 表达式');
  }
  return safe.map((t) => `"${t}"`).join(' AND ');
}
