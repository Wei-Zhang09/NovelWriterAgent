/**
 * 文本规范化（施工文档 §45）
 *
 * 导入语料的第一道处理：把各种来源的文本统一成可解析的形状。
 *
 * ⚠ 规范化的原则：**只做无损的形状调整，不改内容**。
 *   删字、改词、合并段落都会让"证据引用"指向与原文不符的位置，
 *   而 NDE 的全部结论都要能回溯到原文（§46）。因此这里只做：
 *     - 去掉 BOM
 *     - 统一换行符（\r\n / \r → \n）
 *     - 全角空格与制表符 → 普通空格（仅行首缩进场景）
 *     - 压缩 3 个以上连续空行为 2 个（段落分隔保持可见）
 *     - 去掉每行尾部空白
 */
import { createHash } from 'node:crypto';
import { AppError, ErrorCode } from '@nwa/core';
import { stripBoilerplate, type StripResult } from './boilerplate.js';

/**
 * 规范化文本（含样板剥离）。
 *
 * ⚠ 剥离样板是规范化的一部分，不是可选项 —— 真实数据验证发现
 *   未剥离时最后一章混入 25KB 英文许可文本，会污染整条 NDE 链路。
 *   剥离量记录在返回值的 `stripped` 里，不静默丢弃。
 */
export function normalizeWithStrip(raw: string): { text: string; stripped: StripResult } {
  const base = normalizeText(raw);
  const stripped = stripBoilerplate(base);
  return { text: stripped.text, stripped };
}

/** 规范化文本 */
export function normalizeText(raw: string): string {
  if (typeof raw !== 'string') {
    throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, 'normalizeText 需要字符串输入');
  }

  let t = raw;

  // 1) BOM
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);

  // 2) 换行统一
  t = t.replace(/\r\n?/g, '\n');

  // 3) 去掉行尾空白（不影响行内内容）
  t = t
    .split('\n')
    .map((line) => line.replace(/[ \t\u3000]+$/, ''))
    .join('\n');

  // 4) 行首的全角空格/制表符 → 普通空格（保留缩进语义，便于后续识别段落）
  t = t.replace(/^[\u3000\t]+/gm, '  ');

  // 5) 压缩过多空行：3+ → 2
  t = t.replace(/\n{3,}/g, '\n\n');

  // 6) 去掉首尾多余空行
  return t.replace(/^\n+/, '').replace(/\n+$/, '') + '\n';
}

/**
 * 计算内容哈希（用于 §45 去重）。
 *
 * ⚠ 哈希基于**规范化后的文本**，而不是原始字节 ——
 *   否则同一部作品换个换行符就会被当成新文档，去重形同虚设。
 */
export function contentHash(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** 文本统计（导入报告用） */
export interface TextStats {
  readonly chars: number;
  readonly lines: number;
  readonly paragraphs: number;
  readonly nonEmptyLines: number;
}

export function textStats(normalized: string): TextStats {
  const lines = normalized.split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  // 段落 = 被空行分隔的块
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .filter((p) => p.trim().length > 0).length;
  return {
    chars: normalized.length,
    lines: lines.length,
    paragraphs,
    nonEmptyLines: nonEmpty.length,
  };
}
