/**
 * 去AI味检测器 —— 移植自 oh-story-claudecode（ADR-0009）。
 *
 * ## 出处（⚠ 随代码进仓库，便于溯源与对照上游修 bug）
 *
 *   来源项目：oh-story-claudecode
 *   源文件：  skills/story-deslop/scripts/check-ai-patterns.js
 *   LICENSE： MIT
 *   Copyright (c) 2025-2026 oh-story-claudecode
 *
 * 完整许可文本见仓库根目录 `THIRD-PARTY-NOTICES.md`。
 * ⚠ 上游是本文件的**权威**：上游改了正则/阈值，这里要同步，
 *   而不是"我们觉得应该这样"。
 *
 * ## ⚠ 移植的是**检测**，不是**改写**
 *
 * 参考项目大量篇幅是"如何改写正文"的提示词（三遍法、范例库）。
 * 本项目已由 Writer / Reviewer / Revision 流程承担改写 ——
 * 本模块只做**可量化、可证伪**的检测（ADR-0009「不采纳其改写执行部分」）。
 *
 * ## ⚠ 不采纳其标点默认值（与作者偏好直接冲突）
 *
 * 上游 `normalize-punctuation.js` 默认**清除 `……` 与 `——`**。
 * 但本项目作者明确要求「正文少用破折号，转折/停顿尽量用省略号……或改写句式」。
 * 照搬会**把作者偏好的省略号删掉**，方向完全相反。
 *
 * 所以：**只移植检测**，标点归一不在此模块（另行实现）。
 * 注意 `em-dash` 检测器本身与作者偏好**一致**（都是"少用破折号"），
 * 所以它照常移植为 blocking —— 冲突的是"自动清除省略号"，不是这个检测器。
 *
 * ## ⚠ 豁免规则必须一并移植（否则误报率会爆）
 *
 * 上游对每条规则都做了大量**假阳性豁免**（引号内台词、系统播报、
 * "是不是"问句、合成词里的"是"…）。这些豁免是**规则的一部分**，
 * 不是可选的优化 —— 丢掉它们会让误报率远超 ADR 设定的 30% 阈值。
 * 每条豁免的原文理由都保留在下面的注释里。
 */

/** 句末停顿字符：命中片段到此为止 */
const STOP_CHARS = new Set(['。', '！', '？', '!', '?', '\n']);
/** 软分隔：逗号顿号分号冒号 */
const SOFT_SEPARATORS = new Set(['，', ',', '、', '；', ';', '：', ':']);
/** 硬分隔：句号感叹问号 */
const HARD_SEPARATORS = new Set(['。', '.', '！', '!', '？', '?']);
const MAX_NEGATIVE_SPAN = 80;
const MAX_POSITIVE_SPAN = 80;

/** 疑问语气词（"是吗/吧/嘛"不是肯定项） */
const TAG_PARTICLES = new Set(['吗', '吧', '嘛']);
/** 确认语尾（"是的，…"里的"是"是承接，不是对比） */
const AFFIRMATION_TAG_PARTICLES = new Set(['的', '啊', '呀', '呢']);
const AFFIRMATION_TAG_BOUNDARY = new Set([
  '',
  '，',
  ',',
  '。',
  '.',
  '！',
  '!',
  '？',
  '?',
  '、',
  '；',
  ';',
  '：',
  ':',
  '\n',
  '\r',
  '\t',
  ' ',
]);

/** 引号对（覆盖中文书名/引号与直角引号） */
const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['「', '」'],
  ['『', '』'],
  ['【', '】'],
  ['“', '”'],
  ['‘', '’'],
  ['"', '"'],
  ["'", "'"],
];

/**
 * 取第 i 个字符，越界返回空串。
 *
 * ⚠ 必须包一层：strict 下 `text[i]` 的类型是 `string | undefined`，
 *   直接传给参数为 `string` 的函数会报 TS2345。
 *   用 `?? ''` 而不是 `!` —— 越界确实是可能的（正则在末尾匹配），
 *   而空串的语义（"没有这个字符"）正是上游代码里 `text[index] || ''` 的意思。
 */
const at = (text: string, i: number): string => text[i] ?? '';

const isInlineSpace = (c: string): boolean => c === ' ' || c === '\t';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeRegExpCharClass(s: string): string {
  return s.replace(/[\]\\^-]/g, '\\$&');
}

/** 引号内的整段（用于判定某位置是否在引号内） */
const QUOTE_SOURCES = QUOTE_PAIRS.map(
  ([open, close]) =>
    `${escapeRegExp(open)}[^${escapeRegExpCharClass(close)}\\n]*${escapeRegExp(close)}`,
);

function quotedRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const src of QUOTE_SOURCES) {
    const re = new RegExp(src, 'g');
    let match;
    while ((match = re.exec(text)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges;
}

function insideRanges(pos: number, ranges: readonly { start: number; end: number }[]): boolean {
  return ranges.some((r) => pos >= r.start && pos < r.end);
}

/**
 * 把引号内容替换成等长占位符。
 *
 * ⚠ 用等长替换而不是删除：删掉会让后续 match.index 与原文错位，
 *   而 index 正是"命中位置"要报告给作者的东西。
 */
function maskQuoted(text: string): string {
  let out = text;
  for (const src of QUOTE_SOURCES) {
    out = out.replace(new RegExp(src, 'g'), (m) => '？'.repeat(m.length));
  }
  return out;
}

function compact(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function stripQuoted(text: string): string {
  let out = text;
  for (const src of QUOTE_SOURCES) out = out.replace(new RegExp(src, 'g'), '');
  return out;
}

/** 可见字数（中日韩统一表意文字 + 全角 + 拉丁字母数字） */
function visibleLength(sentence: string): number {
  const matched = sentence.match(/[\u4e00-\u9fff\uff21-\uff5aA-Za-z0-9]/g);
  return matched ? matched.length : 0;
}

function startsWithAt(text: string, index: number, needle: string): boolean {
  return text.slice(index, index + needle.length) === needle;
}

function skipGap(text: string, index: number): number {
  while (index < text.length && (isInlineSpace(at(text, index)) || at(text, index) === '\n')) index += 1;
  return index;
}

function trimTrailingNoise(text: string): string {
  return text.replace(/[\s|）)】\]]+$/u, '');
}

function isAffirmationTagAt(text: string, index: number): boolean {
  if (text[index] !== '是') return false;
  const particle = at(text, index + 1);
  if (!AFFIRMATION_TAG_PARTICLES.has(particle)) return false;
  const boundary = at(text, index + 2);
  return AFFIRMATION_TAG_BOUNDARY.has(boundary);
}

function isDivider(trimmed: string): boolean {
  return /^-{3,}$/.test(trimmed) || /^[*_]{3,}$/.test(trimmed);
}

function isStructural(trimmed: string): boolean {
  return (
    /^(#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|\|)/.test(trimmed) ||
    /^第[零一二三四五六七八九十百千万\d]+章(?:\s|_|$)/.test(trimmed)
  );
}

// ══════════════════════════════════════════════════════════════
// 规则常量（逐字对照上游，勿"顺手优化"）
// ══════════════════════════════════════════════════════════════

const COMPACT_EITHER_OR_PREV = new Set(['不', '就', '也']);

/** 音量反差腔：「声音不大…却/但…」 */
const VOICE_CONTRAST_PATTERN = /声音(?:并)?不[大高响亮][^。！？!?\n]{0,16}[却但偏]/g;

/** 否定排比：「没有X，没有Y…」/「没X，没有Y，只是Z」 */
const NEGATION_PARADE_PATTERNS = [
  /(?:没有[^。！？!?\n，,]{1,12}[，,]){2}/g,
  /(?<![沉淹埋出隐湮吞覆漫泯])没(?!有?过?多久)(?:有)?[^。！？!?\n，,]{1,12}[，,]\s*没(?!有?过?多久)(?:有)?[^。！？!?\n，,]{1,16}[，,。.][^。！？!?\n，,]{0,6}只(?:是|会|有)/g,
];

/** 反序对比腔：「是A，不是B」 */
const REVERSE_NOT_IS_PATTERN = /是([^。！？!?\n，,]{1,12})[，,]\s*(?:而)?不是([^。！？!?\n]{1,20})/g;

/**
 * ⚠ 「就是/也是/还是/只是/可是…」里的「是」是**合成词的一部分**，
 *   不是肯定项系动词。上游列了这一串前缀作为排除集 ——
 *   不排除的话「他就是这样的人」会被判成反序对比。
 */
const REVERSE_NOT_IS_PREV_EXCLUDE = new Set([
  ...COMPACT_EITHER_OR_PREV,
  '还', '只', '可', '但', '于', '倒', '像', '若', '要', '正', '便', '总', '老',
  '更', '最', '算', '怕', '凡', '或', '即', '自', '竟', '原', '本', '仍', '许',
  '净', '光', '单', '尽',
]);

/** 章末预告体 */
const TRAILER_ENDING_PATTERN =
  /没人知道|谁也不知道|谁也没想到|殊不知|(?:这)?才刚刚开(?:始|头)|正(?:朝着|向着)[^。！？!?\n]{0,24}(?:压|涌|袭|逼)(?:了?过去|了?过来|来)|(?<!正式)拉开(?:序幕|帷幕)|即将(?:开始|来临|降临)/g;

/** 章末总结体 */
const TRAILER_SUMMARY_PATTERN =
  /这一(?:夜|天|刻|战|年|局|役)[，,]?[^。！？!?，,\n]{0,6}(?<!命中)(?<!是)注定[^。！？!?\n]{0,8}[。！]|就这样[，,][^。！？!?，,\n]{0,8}(?:一切|全部)[^。！？!?，,\n]{0,4}(?:结束了|落幕|收场)[。！]|这一切[，,]?[^。！？!?，,\n]{0,6}(?:都)?(?:说明|意味着|结束了)(?!的)(?:(?!什么)[^。！？!?\n]){0,6}[。！]|(?:新的篇章|新的旅程|崭新的篇章|新的人生)[^。！？!?\n]{0,6}(?:开始|拉开|展开)|命运[^。！？!?\n]{0,6}齿轮/g;

/** 章末检测的回看窗口（字符）—— 只在结尾这一段里找，不看全文 */
const TRAILER_ENDING_WINDOW_CHARS = 600;

// ══════════════════════════════════════════════════════════════
// 检测实现
// ══════════════════════════════════════════════════════════════

/**
 * 找「不是A，而是B」的肯定项结束位置。
 *
 * ⚠ 这段逻辑是上游最容易误报的地方，注释里的每条排除都有真实案例：
 *   - 「是不是」问句
 *   - 分隔符之后的「是」若前面是 只是/可是/但是/还是/于是/倒是/总是…
 *     那是合成词，不是系动词（上游 issue #166 的假阳性类别）
 *   - 「，他是」「，那是」这类**有意不抓** —— 没有词表无法与合成词区分，
 *     而"强行让作者改写本来没问题的句子"比"漏掉这种较罕见的形式"代价更大
 */
function findPositiveFlipEnd(candidate: string): number {
  let index = 2; // after "不是"
  let scanned = 0;
  let crossedSeparator = false;

  while (index < candidate.length && scanned <= MAX_NEGATIVE_SPAN) {
    const char = at(candidate, index);

    if (startsWithAt(candidate, index, '而是')) return index + 2;

    if (SOFT_SEPARATORS.has(char)) {
      const next = skipGap(candidate, index + 1);
      if (startsWithAt(candidate, next, '而是')) return next + 2;
      if (
        at(candidate, next) === '是' &&
        !TAG_PARTICLES.has(at(candidate, next + 1)) &&
        !isAffirmationTagAt(candidate, next)
      ) {
        return next + 1;
      }
      crossedSeparator = true;
    }

    if (HARD_SEPARATORS.has(char)) {
      const next = skipGap(candidate, index + 1);
      if (
        at(candidate, next) === '是' &&
        !TAG_PARTICLES.has(at(candidate, next + 1)) &&
        !isAffirmationTagAt(candidate, next)
      ) {
        return next + 1;
      }
      if (char !== '.') break;
      crossedSeparator = true;
    }

    if (STOP_CHARS.has(char)) break;

    // 紧凑形式「不是A是B」—— 但只在**第一个分句内**（未跨分隔符）。
    // ⚠ 跨了分隔符还抓的话，「不是A，也不是B」里的第二个「不是」会被当成肯定项。
    if (char === '是' && !COMPACT_EITHER_OR_PREV.has(at(candidate, index - 1)) && !crossedSeparator) {
      return index + 1;
    }

    index += 1;
    scanned += 1;
  }

  return -1;
}

function extractFinding(candidate: string, markerEnd: number): string {
  let end = markerEnd;
  const limit = Math.min(candidate.length, markerEnd + MAX_POSITIVE_SPAN);
  while (end < limit) {
    if (STOP_CHARS.has(at(candidate, end))) break;
    end += 1;
  }
  return candidate.slice(0, end);
}

/** 命中形状：段内偏移 + 片段 */
export interface PortedHit {
  readonly start: number;
  readonly excerpt: string;
}

/** 「不是A，而是B」 */
export function findNotIsComparisons(text: string): PortedHit[] {
  const out: PortedHit[] = [];
  const quoted = quotedRanges(text);
  let offset = 0;

  while (offset < text.length) {
    const start = text.indexOf('不是', offset);
    if (start === -1) break;

    // ⚠ 引号内是台词/系统播报：口语里「不是A，是B」是自然辩解/反问，
    //   不算叙述层的 AI 对比句式（与碎句号一致豁免引号内容）
    if (insideRanges(start, quoted)) {
      offset = start + 2;
      continue;
    }

    // 「是不是」问句
    if (start > 0 && at(text, start - 1) === '是') {
      offset = start + 2;
      continue;
    }

    const candidate = text.slice(start);
    const markerEnd = findPositiveFlipEnd(candidate);

    if (markerEnd === -1) {
      offset = start + 2;
      continue;
    }

    const raw = trimTrailingNoise(extractFinding(candidate, markerEnd));
    if (raw.length >= 4) {
      out.push({ start, excerpt: compact(raw) });
    }

    offset = start + Math.max(raw.length, 2);
  }

  return out;
}

/** 反序对比腔「是A，不是B」 */
export function findReverseNotIs(text: string): PortedHit[] {
  const out: PortedHit[] = [];
  const masked = maskQuoted(text);
  REVERSE_NOT_IS_PATTERN.lastIndex = 0;
  let match;
  while ((match = REVERSE_NOT_IS_PATTERN.exec(masked)) !== null) {
    const start = match.index;
    // 合成词的一部分
    if (REVERSE_NOT_IS_PREV_EXCLUDE.has(at(masked, start - 1))) continue;
    // 「是不是…」问句起头
    if (at(masked, start + 1) === '不') continue;
    // 「是的，…不是…」承接确认语
    if (isAffirmationTagAt(masked, start)) continue;
    // 「…，不是吗/不是么/不是吧」反问尾巴
    if (/^[吗么吧]/.test(match[2] ?? '')) continue;
    out.push({ start, excerpt: compact(text.slice(start, start + match[0].length)) });
  }
  return out;
}

/** 音量反差腔 */
export function findVoiceContrast(text: string): PortedHit[] {
  const out: PortedHit[] = [];
  const masked = maskQuoted(text);
  VOICE_CONTRAST_PATTERN.lastIndex = 0;
  let match;
  while ((match = VOICE_CONTRAST_PATTERN.exec(masked)) !== null) {
    out.push({ start: match.index, excerpt: compact(text.slice(match.index, match.index + match[0].length)) });
  }
  return out;
}

/** 否定排比 */
export function findNegationParade(text: string): PortedHit[] {
  const out: PortedHit[] = [];
  const masked = maskQuoted(text);

  // ⚠ 用对象数组而不是 `[number, number][]`：strict + noUncheckedIndexedAccess
  //   下解构元组会得到 `number | undefined`，到处要断言。
  const spans: { start: number; end: number }[] = [];
  for (const pattern of NEGATION_PARADE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(masked)) !== null) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  spans.sort((a, b) => a.start - b.start);

  // ⚠ 去重叠：两条正则可能命中同一段，重复报告会让作者看到两条一样的提示
  let lastEnd = -1;
  for (const sp of spans) {
    if (sp.start < lastEnd) {
      lastEnd = Math.max(lastEnd, sp.end);
      continue;
    }
    lastEnd = sp.end;
    out.push({ start: sp.start, excerpt: compact(text.slice(sp.start, sp.end)) });
  }
  return out;
}

/** 章末预告体 / 总结体（只在结尾窗口内找） */
export function findTrailerEndings(paragraphs: readonly string[]): { endings: { paragraph: number; excerpt: string }[]; summaries: { paragraph: number; excerpt: string }[] } {
  const endings: { paragraph: number; excerpt: string }[] = [];
  const summaries: { paragraph: number; excerpt: string }[] = [];

  // 从后往前累积到窗口字符数
  const windowParas: { text: string; paragraph: number }[] = [];
  let accumulated = 0;
  for (let i = paragraphs.length - 1; i >= 0 && accumulated < TRAILER_ENDING_WINDOW_CHARS; i -= 1) {
    const text = String(paragraphs[i] ?? '');
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    windowParas.unshift({ text, paragraph: i + 1 });
    accumulated += visibleLength(stripQuoted(trimmed));
  }

  for (const { text, paragraph } of windowParas) {
    const masked = maskQuoted(text);
    TRAILER_ENDING_PATTERN.lastIndex = 0;
    let m;
    while ((m = TRAILER_ENDING_PATTERN.exec(masked)) !== null) {
      endings.push({ paragraph, excerpt: compact(text.slice(m.index, m.index + m[0].length)) });
    }
    TRAILER_SUMMARY_PATTERN.lastIndex = 0;
    while ((m = TRAILER_SUMMARY_PATTERN.exec(masked)) !== null) {
      summaries.push({ paragraph, excerpt: compact(text.slice(m.index, m.index + m[0].length)) });
    }
  }

  return { endings, summaries };
}

/** 破折号（作者偏好一致：少用破折号） */
export function findEmDashes(text: string): PortedHit[] {
  const out = [];
  const dashPattern = /——|—|--+/g;
  let m;
  while ((m = dashPattern.exec(text)) !== null) {
    out.push({
      start: m.index,
      excerpt: compact(text.slice(Math.max(0, m.index - 8), m.index + m[0].length + 8)),
    });
  }
  return out;
}

/** 供测试与文档使用的规则元数据 */
export const PORTED_RULES = [
  { code: 'not_is_comparison', severity: 'blocking', source: 'not-is-comparison' },
  { code: 'reverse_not_is', severity: 'blocking', source: 'reverse-not-is' },
  { code: 'voice_contrast', severity: 'blocking', source: 'voice-contrast' },
  { code: 'negation_parade', severity: 'blocking', source: 'negation-parade' },
  { code: 'trailer_ending', severity: 'blocking', source: 'trailer-ending' },
  { code: 'trailer_summary', severity: 'blocking', source: 'trailer-summary' },
  { code: 'em_dash', severity: 'blocking', source: 'em-dash' },
];
