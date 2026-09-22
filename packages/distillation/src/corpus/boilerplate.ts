/**
 * 语料样板文本剥离（真实数据验证暴露的问题）
 *
 * ## 为什么需要它
 *
 * 用真实公版小说（《三国演义》Gutenberg 版）验证时发现：
 * 最后一章 30993 字，而其他章都在 5000~6000 字。
 *
 * 原因：Gutenberg 文件末尾附了约 25KB 的**英文许可样板文本**
 * （"*** END OF THE PROJECT GUTENBERG EBOOK ***" 之后的大段法律条文）。
 *
 * ## 为什么这是严重问题（而不是"多一点文本"）
 *
 * 污染是**静默的**，而且会顺着 NDE 全链路放大：
 *   1. 最后一章的正文混入英文法律条文
 *   2. 场景切分把许可文本切成"场景"
 *   3. 叙事标注给法律条文打上 sceneFunction
 *   4. 模式挖掘从法律条文里"挖出"所谓的叙事模式
 *   5. 编译成 Skill 注入 Writer —— **污染整条创作链**
 *
 * 每一环节单独看都正常，没有任何报错。这正是必须在导入层拦掉的原因。
 *
 * ## 策略
 *
 * 只剥离**有明确标记**的样板，不做启发式猜测（猜错会删掉正文）。
 * 剥离量会记录在导入报告里，不静默丢弃。
 */

/** 样板开始标记（之前的内容是正文） */
const START_MARKERS: readonly RegExp[] = [
  /^\*\*\*\s*START OF THE PROJECT GUTENBERG EBOOK.*\*\*\*\s*$/im,
  /^\*\*\*\s*START OF THIS PROJECT GUTENBERG EBOOK.*\*\*\*\s*$/im,
  /^This eBook is for the use of anyone anywhere.*$/im,
];

/** 样板结束标记（之后的内容是样板） */
const END_MARKERS: readonly RegExp[] = [
  /^\*\*\*\s*END OF THE PROJECT GUTENBERG EBOOK.*\*\*\*\s*$/im,
  /^\*\*\*\s*END OF THIS PROJECT GUTENBERG EBOOK.*\*\*\*\s*$/im,
  /^End of (the )?Project Gutenberg.*$/im,
  /^End of this Project Gutenberg.*$/im,
];

export interface StripResult {
  readonly text: string;
  /** 被剥离的字符数（0 表示没有样板） */
  readonly removedChars: number;
  /** 命中的标记（便于人工核对是否剥错） */
  readonly hitMarkers: readonly string[];
}

/**
 * 剥离 Gutenberg 类样板。
 *
 * ⚠ 保守原则：只有**同时找到开始与结束标记**时才剥离中间段。
 *   只找到其中一个时不做处理（可能标记本身在正文里被引用），
 *   宁可留着让人工发现，也不要猜错删掉正文。
 */
export function stripBoilerplate(normalized: string): StripResult {
  const hitMarkers: string[] = [];
  let text = normalized;
  let removed = 0;

  // ── 1) 头部样板：START 标记之前的内容 ──
  //
  // ⚠ 取**最靠后**的 START 匹配，而不是"第一个命中的模式"。
  //   多个标记可能同时出现（如 "This eBook is for..." 与
  //   "*** START OF THE PROJECT GUTENBERG EBOOK ***"），
  //   取最靠后才能把两段头部样板一起剥掉。
  let headCut = -1;
  let headMarker = '';
  for (const re of START_MARKERS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of text.matchAll(g)) {
      const lineEnd = text.indexOf('\n', m.index + m[0].length);
      if (lineEnd > 0 && lineEnd > headCut) {
        headCut = lineEnd + 1;
        headMarker = m[0].trim().slice(0, 60);
      }
    }
  }
  if (headCut > 0) {
    const head = text.slice(0, headCut);
    text = text.slice(headCut);
    removed += head.length;
    hitMarkers.push(`START: ${headMarker}`);
  }

  // ── 2) 尾部样板：END 标记之后的内容 ──
  //
  // ⚠ 取**最靠前**的 END 匹配。实测踩到：Gutenberg 文件里
  //   "End of Project Gutenberg's ..."（21328 行）出现在
  //   "*** END OF THE PROJECT GUTENBERG EBOOK ***"（21332 行）**之前**。
  //   若按"第一个命中的模式"截断，就会从 21332 行截起，
  //   把 21328 行那句英文留在正文里 —— 实测确实漏了这句。
  let tailCut = -1;
  let tailMarker = '';
  for (const re of END_MARKERS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of text.matchAll(g)) {
      const lineStart = text.lastIndexOf('\n', m.index);
      const cutAt = lineStart >= 0 ? lineStart : m.index;
      if (tailCut < 0 || cutAt < tailCut) {
        tailCut = cutAt;
        tailMarker = m[0].trim().slice(0, 60);
      }
    }
  }
  if (tailCut >= 0) {
    const tail = text.slice(tailCut);
    text = text.slice(0, tailCut);
    removed += tail.length;
    hitMarkers.push(`END: ${tailMarker}`);
  }

  return {
    text: text.replace(/\n+$/, '') + '\n',
    removedChars: removed,
    hitMarkers,
  };
}
