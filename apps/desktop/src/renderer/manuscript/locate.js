/**
 * M8 —— 把 Review Issue 的定位信息解析成正文里的字符区间。
 *
 * ## 为什么单独一个纯函数文件
 *
 * 「点 Issue 跳到正文并高亮」的**难点不是跳转，是定位算得对不对**：
 * 定位算错的后果是"高亮到别的句子"，而作者会据此改错地方 ——
 * 比不跳转更糟。所以定位逻辑必须能穷举测试（与 M7 的 `diff.js` 同源做法：
 * 算法与 DOM 渲染分离，算法用单测穷举，渲染才需要 GUI）。
 *
 * ## 三层回落（§18 / M1 契约）
 *
 * `offset` 精确，但**模型改写标点或多打一个空格就会漂**；
 * `excerpt` 稳定，但靠文本搜索定位、可能命中多处。
 * 所以顺序是：
 *
 *   ① `offset` —— 但**必须用 excerpt 校验**。不校验的话，
 *      漂了的 offset 会被当成精确位置用，高亮落在无关文字上。
 *   ② `excerpt` —— offset 校验不过（或没给）时搜索原文。
 *      命中多处时优先取**所在段**内的那一个。
 *   ③ `paragraph` —— 连 excerpt 都没有时，至少把作者带到那一段开头。
 *      ⚠ 这是"退而求其次"而不是"定位成功"：`via` 字段会如实标出来，
 *      UI 据此提示"只定位到段落，未精确到句子"。
 *
 * 任何一层都不成立时返回 `null`（**不返回 0** —— 0 是合法的正文开头，
 * 混用会让"定位失败"显示成"高亮第一句"）。
 */

/**
 * 段落的起止偏移。
 *
 * ⚠ 段落编号从 **1** 起（与 `ReviewLocationSchema.paragraph` 一致，
 *   也与作者看到的"第 N 段"一致）。用 0 起会让所有段号差一。
 *
 * @param {string} text
 * @returns {{start:number,end:number}[]} 下标 0 对应第 1 段
 */
export function paragraphRanges(text) {
  const out = [];
  if (typeof text !== 'string' || text.length === 0) return out;

  // ⚠ 按行扫描而不是写正则：正则版本会让 `^` 吞掉段前那个换行，
  //   导致段区间比真实段落长一个字符，offset 基准整体偏移。
  //   逐行聚合的实现可以直接手工验算，正则不行。
  const lines = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    lines.push({ start: pos, end: pos + line.length, text: line });
    pos += line.length + 1; // +1 = 被 split 掉的 '\n'
  }

  /** @type {{start:number,end:number}|null} */
  let cur = null;
  for (const ln of lines) {
    if (ln.text.trim().length === 0) {
      // 空行（含只有空白字符的行）= 段分隔
      if (cur) {
        out.push(cur);
        cur = null;
      }
      continue;
    }
    if (!cur) cur = { start: ln.start, end: ln.end };
    else cur.end = ln.end; // 段内续行：只延长终点
  }
  if (cur) out.push(cur);
  return out;
}

/** 第 n 段（1 起）的区间；不存在返回 null */
export function paragraphRange(text, n) {
  if (!Number.isInteger(n) || n < 1) return null;
  return paragraphRanges(text)[n - 1] ?? null;
}

/**
 * 解析定位。
 *
 * @param {string} text 当前正文
 * @param {{paragraph?:number, offset?:number, excerpt?:string}} loc
 * @returns {{start:number, end:number, via:'offset'|'excerpt'|'paragraph',
 *            paragraph:number|null, drift:boolean} | null}
 */
export function locateIssue(text, loc) {
  if (typeof text !== 'string' || text.length === 0) return null;
  if (!loc || typeof loc !== 'object') return null;

  const excerpt = typeof loc.excerpt === 'string' && loc.excerpt.length > 0 ? loc.excerpt : null;
  const hasOffset = Number.isInteger(loc.offset) && loc.offset >= 0;
  const paraRange = paragraphRange(text, loc.paragraph);

  // ── ① offset（需 excerpt 校验）──
  if (hasOffset && paraRange) {
    const start = paraRange.start + loc.offset;
    if (start >= paraRange.start && start <= paraRange.end) {
      if (excerpt === null) {
        // 没有 excerpt 可比对：只能信 offset，但如实标出"未经校验"
        return {
          start,
          end: Math.min(start + 1, paraRange.end),
          via: 'offset',
          paragraph: loc.paragraph ?? null,
          drift: false,
        };
      }
      if (text.startsWith(excerpt, start)) {
        return {
          start,
          end: start + excerpt.length,
          via: 'offset',
          paragraph: loc.paragraph ?? null,
          drift: false,
        };
      }
      // ⚠ offset 校验不过 = 漂移。**不返回这个位置** ——
      //   返回它就会高亮到无关文字上，作者照着改错地方。
      //   继续往下走 excerpt 搜索。
    }
  }

  // ── ② excerpt 搜索 ──
  if (excerpt !== null) {
    const hits = [];
    let from = 0;
    for (;;) {
      const i = text.indexOf(excerpt, from);
      if (i < 0) break;
      hits.push(i);
      from = i + 1;
    }
    if (hits.length > 0) {
      // ⚠ 多处命中时优先取**所在段**内的那一个 ——
      //   同一句话在一章里出现两次很常见（口头禅、复现的意象），
      //   取第一个会把作者带到前面那处，而 Issue 说的是后面那处。
      let chosen = hits[0];
      if (paraRange) {
        const inPara = hits.find((i) => i >= paraRange.start && i <= paraRange.end);
        if (inPara !== undefined) chosen = inPara;
      }
      return {
        start: chosen,
        end: chosen + excerpt.length,
        via: 'excerpt',
        paragraph: loc.paragraph ?? null,
        // 有 offset 但没用上，说明它漂了 —— 如实标出，
        // UI 可以提示"这份审阅的定位已漂移"
        drift: hasOffset,
      };
    }
  }

  // ── ③ 段落开头 ──
  if (paraRange) {
    return {
      start: paraRange.start,
      end: paraRange.end,
      via: 'paragraph',
      paragraph: loc.paragraph ?? null,
      drift: hasOffset,
    };
  }

  return null;
}
