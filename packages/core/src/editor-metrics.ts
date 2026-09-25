/**
 * 编辑器文本度量（M4，第二阶段施工单 §二十八 / §二十九）
 *
 * ## 为什么必须是**单一实现**（而不是编辑器自己数）
 *
 * §28 要求编辑器显示"当前章节字数 / 选中文字数 / 段落数"。
 * 若编辑器自己写一套计数，就会出现：
 *
 *     编辑器显示   4,328 字
 *     章节目标判定  3,912 字
 *
 * 两个数字都"对"，但没人能解释差在哪 —— 这类争议无解，
 * 因为它不是算法错，是**两套口径并存**。
 *
 * 所以口径定在这里（`@nwa/core`），编辑器与 Writer 共用。
 * ADR-0008 §5 明确要求"复用既有唯一定义，不引入第二种"。
 *
 * ## 口径是什么（照搬既有实现，不是新发明）
 *
 * | 指标 | 口径 | 依据 |
 * |---|---|---|
 * | 字数 | `text.length`（UTF-16 码元数） | `writer.ts` 的 `totalChars: fullText.length` |
 * | 段落 | 按空行切分、trim、去空 | `detectors.ts` 的 `splitParagraphs()` |
 *
 * ⚠ **字数用 `.length` 而不是"去掉空白/标点后的字数"**：
 *   中文写作里"字数"就是字符数，作者按字数规划篇幅。
 *   若改成"有效字数"，作者看到的数字会与自己的直觉不符，
 *   而直觉不符的计数器等于没有 —— 作者不会用它做任何判断。
 *
 * ⚠ **不含标点剔除**：`……`、`——` 都算字。这与作者偏好一致
 *   （本项目允许并鼓励用省略号代替破折号）。
 */

/** 文本度量结果 */
export interface TextMetrics {
  /** 总字数（UTF-16 码元数，与 Writer 的 totalChars 同口径） */
  readonly chars: number;
  /** 段落数（按空行分段，trim 后非空的段才算） */
  readonly paragraphs: number;
  /**
   * 不含空白的字数。
   *
   * ⚠ 只作**参考**展示，不参与任何判定 —— 判定一律用 `chars`。
   *   存在的理由：作者偶尔想知道"实打实写了多少字"，
   *   但它不是项目的字数口径，不能被当成"更准确的数字"。
   */
  readonly charsWithoutSpaces: number;
}

/**
 * 统计文本度量。
 *
 * ⚠ 空串返回全 0（而不是 1 段）—— "空文本有 1 段"会让
 *   "还没有正文"与"有 1 个空段"无法区分。
 */
export function measureText(text: string): TextMetrics {
  const paragraphs = splitParagraphs(text);
  return {
    chars: text.length,
    paragraphs: paragraphs.length,
    charsWithoutSpaces: text.replace(/\s/g, '').length,
  };
}

/**
 * 按空行切分段落。
 *
 * ⚠ 与 `packages/writing/src/naturalness/detectors.ts` 的
 *   `splitParagraphs()` **必须逐字一致**：那边的段落号会被写进
 *   Review 的 `location.paragraph`，而编辑器用这里的段落号去定位。
 *   两处不一致的表现是"点问题跳到错误的段落"，且只在含多空行/
 *   行首空格的文件里出现 —— 极难复现。
 *
 * ⚠ 那个函数在 `@nwa/writing`，本模块在 `@nwa/core`（更底层），
 *   不能 import（会形成反向依赖）。一致性由
 *   `tests/integration/editor-metrics.test.ts` 的对照断言钉住。
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * 求一段文本在全文中的**段落序号**（从 1 起）。
 *
 * 编辑器用它做"点 Review 问题 → 跳到对应段"（M8）。
 * 找不到时返回 null —— 不返回 0 或 -1：调用方要能区分
 * "定位失败"与"定位到第 0 段"（后者不存在，但用 0 表示失败
 * 会让判断条件写成 `if (n)`，而那是隐式约定）。
 */
export function paragraphIndexOf(text: string, needle: string): number | null {
  if (needle.length === 0) return null;
  const paras = splitParagraphs(text);
  const i = paras.findIndex((p) => p.includes(needle));
  return i === -1 ? null : i + 1;
}

/**
 * 把段落序号换算成全文的字符偏移区间（M8 的定位用）。
 *
 * ⚠ 返回的区间是**段落在原文中的实际位置**，不是"重新拼接后的位置"：
 *   段落切分时 trim 过，重新拼接会丢掉段首缩进与空行，
 *   于是"跳转后光标位置"与"作者看到的段落开头"差几个字符。
 *
 * 找不到该段时返回 null。
 */
export function paragraphRange(
  text: string,
  paragraphNumber: number,
): { start: number; end: number } | null {
  if (!Number.isInteger(paragraphNumber) || paragraphNumber < 1) return null;

  // 用与 splitParagraphs 相同的切分规则，但保留偏移
  const re = /\n\s*\n/g;
  const blocks: { start: number; end: number }[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ start: cursor, end: m.index });
    cursor = m.index + m[0].length;
  }
  blocks.push({ start: cursor, end: text.length });

  const kept = blocks
    .map((b) => {
      const raw = text.slice(b.start, b.end);
      const lead = raw.length - raw.trimStart().length;
      const trail = raw.length - raw.trimEnd().length;
      return { start: b.start + lead, end: b.end - trail };
    })
    .filter((b) => b.end > b.start);

  const hit = kept[paragraphNumber - 1];
  return hit ?? null;
}
