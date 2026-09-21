/**
 * Token 估算（施工文档 §12.3 的预算计算基础）
 *
 * 为什么需要估算而不是真 tokenizer：
 *   1. v1.0 要支持任意 OpenAI-compatible 端点，各家 tokenizer 不同
 *   2. 预算决策需要**零成本、零依赖**（每次装配都调 tokenizer 不现实）
 *
 * 估算策略：CJK 字符约 1 token/字，ASCII 约 4 字符/token。
 * 这是保守偏高的估算 —— 宁可提前触发预算告警，也不要超限被截断。
 */
import type { TokenCounter } from './types.js';

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/;

export const defaultTokenCounter: TokenCounter = {
  estimate(text: string): number {
    if (!text) return 0;
    let cjk = 0;
    let ascii = 0;
    for (const ch of text) {
      if (CJK.test(ch)) cjk++;
      else ascii++;
    }
    // CJK 约 1 token/字；其余按 4 字符 1 token
    return cjk + Math.ceil(ascii / 4);
  },
};

/**
 * 保守估算：偏大 15%。
 *
 * 用途：预算检查。真实 token 数通常小于估算值，
 * 因此用保守估算可以避免"算出还有余量、实际却超限"。
 */
export const conservativeTokenCounter: TokenCounter = {
  estimate(text: string): number {
    return Math.ceil(defaultTokenCounter.estimate(text) * 1.15);
  },
};
