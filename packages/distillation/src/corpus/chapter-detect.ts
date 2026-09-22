/**
 * 章节识别（施工文档 §18 / §45）
 *
 * 把规范化后的整篇文本切成章节。
 *
 * ## 三级策略（按可靠性降序）
 *
 * 1. **显式标题**：`第一章 ...` / `第 1 章 ...` / `Chapter 1 ...`
 *    —— 最可靠，中文小说绝大多数用这种
 * 2. **分隔符**：单独成行的 `***` / `---` / `===`
 *    —— 用于没有章标题的作品
 * 3. **整篇一章**：都没有时把整篇当一章
 *    —— ⚠ 不猜。猜错的分章会让场景标注与模式挖掘建立在错误的边界上
 *
 * ## 为什么"不猜"很重要
 *
 * 分章错误是**静默的**：后续所有环节（场景切分、标注、模式挖掘）
 * 都会基于错误的边界工作，但每一环节单独看都正常。
 * 宁可按整篇一章处理并如实标注，也不要产出看似合理却错误的章节划分。
 */

/**
 * 中文数字 → 阿拉伯数字。
 *
 * ⚠ 需要它是因为真实语料里的回目写法很杂：`九十九`、`一百`、`一一九`。
 *   实测《三国演义》Gutenberg 版从 `九十九` 直接跳到 `一一一`
 *   （源文本缺 100–110 回）—— 只有解析出真实回目号才能发现这种缺口。
 */
const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
};

export function parseChineseNumber(input: string): number | null {
  const t = input.trim();
  if (t.length === 0) return null;
  // 纯阿拉伯数字
  if (/^[0-9]+$/.test(t)) return Number(t);

  // 「一一九」这类逐位写法（无十/百/千）：每个字都是数字位
  if (!/[十百千]/.test(t)) {
    let n = 0;
    for (const ch of t) {
      const d = CN_DIGITS[ch];
      if (d === undefined) return null;
      n = n * 10 + d;
    }
    return n;
  }

  // 「九十九」「一百二十」这类带单位的写法
  const UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of t) {
    const d = CN_DIGITS[ch];
    if (d !== undefined) {
      digit = d;
      continue;
    }
    const u = UNITS[ch];
    if (u === undefined) return null;
    // 「十五」= 15：十前面没有数字时按 1 算
    section += (digit === 0 ? 1 : digit) * u;
    digit = 0;
  }
  total += section + digit;
  return total > 0 ? total : null;
}

/** 从标题里提取声明的章节号（第X回 / 第X章 / Chapter N） */
export function declaredNumberOf(title: string | null): number | null {
  if (!title) return null;
  const cn = /第\s*([0-9一二三四五六七八九十百千零〇两]+)\s*[章回节卷篇]/.exec(title);
  if (cn?.[1]) return parseChineseNumber(cn[1]);
  const en = /Chapter\s+([0-9]+)/i.exec(title);
  if (en?.[1]) return Number(en[1]);
  const bare = /^\s*([0-9]{1,4})[.、]?\s*$/.exec(title);
  if (bare?.[1]) return Number(bare[1]);
  return null;
}

/** 章节标题模式（按优先级排列） */
const TITLE_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  // 第X章 / 第X回 / 第X节（中文数字或阿拉伯数字）
  { name: 'cn-numbered', re: /^[\s\u3000]*第\s*[0-9一二三四五六七八九十百千零〇两]+\s*[章回节卷篇].*$/ },
  // Chapter N / CHAPTER N
  { name: 'en-numbered', re: /^[\s\u3000]*Chapter\s+[0-9IVXLC]+\b.*$/i },
  // 纯数字标题行：1 / 001 / 1.
  { name: 'bare-number', re: /^[\s\u3000]*[0-9]{1,4}[.、]?\s*$/ },
];

/** 分隔符模式（无标题时用） */
const SEPARATOR_RE = /^[\s\u3000]*([-*=_]{3,})[\s\u3000]*$/;

export interface DetectedChapter {
  /** 序号（从 1 开始，按出现顺序）—— 用于文件命名与排序 */
  readonly number: number;
  /**
   * 标题里声明的章节号（如「第一百二十回」→ 120）。
   *
   * ⚠ 与 `number` 不同：真实语料可能有缺口（实测《三国演义》缺 100–110 回），
   *   此时 `number` 是连续的，而 `declaredNumber` 会跳。
   *   证据引用（§46）应当用这个，才能对上原文的回目。
   */
  readonly declaredNumber: number | null;
  /** 标题原文（无标题时为 null） */
  readonly title: string | null;
  /** 章节正文（不含标题行本身） */
  readonly body: string;
  /** 该章在原文中的起始行号（1-based，便于回溯证据） */
  readonly startLine: number;
}

export type DetectStrategy = 'explicit-title' | 'separator' | 'whole-document';

export interface DetectResult {
  readonly chapters: readonly DetectedChapter[];
  readonly strategy: DetectStrategy;
  /** 命中的标题模式名（便于诊断） */
  readonly patternName: string | null;
  /**
   * 声明的章节号缺口（如源文本缺 100–110 回）。
   *
   * ⚠ 如实报出而不是静默：缺口意味着**语料不完整**，
   *   会影响模式挖掘的样本覆盖度判断。人工需要知道这件事。
   */
  readonly gaps: readonly { readonly after: number; readonly before: number }[];
}

function isTitle(line: string): { hit: boolean; patternName: string | null } {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { hit: false, patternName: null };
  // 标题行通常较短；过长的一行即使以"第X章"开头也更可能是正文
  if (trimmed.length > 60) return { hit: false, patternName: null };

  for (const p of TITLE_PATTERNS) {
    if (p.re.test(trimmed)) return { hit: true, patternName: p.name };
  }
  return { hit: false, patternName: null };
}

/**
 * 识别章节。
 *
 * ⚠ 只做"能明确识别"的切分，识别不出就整篇一章 —— 见文件头说明。
 */
export function detectChapters(normalized: string): DetectResult {
  const lines = normalized.split('\n');

  // ── 策略 1：显式标题 ──
  const titleHits: { index: number; title: string; patternName: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const r = isTitle(lines[i]!);
    if (r.hit) titleHits.push({ index: i, title: lines[i]!.trim(), patternName: r.patternName! });
  }

  // 至少 2 个标题才算"有章节结构"；只有 1 个可能是正文里的偶然匹配
  if (titleHits.length >= 2) {
    const chapters: DetectedChapter[] = [];
    for (let k = 0; k < titleHits.length; k++) {
      const cur = titleHits[k]!;
      const next = titleHits[k + 1];
      const bodyStart = cur.index + 1;
      const bodyEnd = next ? next.index : lines.length;
      const body = lines.slice(bodyStart, bodyEnd).join('\n').trim();
      chapters.push({
        number: k + 1,
        declaredNumber: declaredNumberOf(cur.title),
        title: cur.title,
        body,
        startLine: cur.index + 1,
      });
    }
    // ⚠ 标题前的引子（序/前言）不丢弃：并入第一章，避免内容丢失
    const lead = lines.slice(0, titleHits[0]!.index).join('\n').trim();
    if (lead.length > 0) {
      const first = chapters[0]!;
      chapters[0] = { ...first, body: `${lead}\n\n${first.body}`.trim() };
    }
    return {
      chapters,
      strategy: 'explicit-title',
      patternName: titleHits[0]!.patternName,
      gaps: findGaps(chapters),
    };
  }

  // ── 策略 2：分隔符 ──
  const sepHits = lines
    .map((l, i) => ({ i, hit: SEPARATOR_RE.test(l) }))
    .filter((x) => x.hit)
    .map((x) => x.i);

  if (sepHits.length >= 2) {
    const chapters: DetectedChapter[] = [];
    const bounds = [...sepHits, lines.length];
    let n = 0;
    let prev = 0;
    for (const b of bounds) {
      const body = lines.slice(prev, b).join('\n').trim();
      if (body.length > 0) {
        n++;
        chapters.push({ number: n, declaredNumber: null, title: null, body, startLine: prev + 1 });
      }
      prev = b + 1;
    }
    if (chapters.length >= 2) {
      return { chapters, strategy: 'separator', patternName: 'separator', gaps: [] };
    }
  }

  // ── 策略 3：整篇一章（不猜） ──
  return {
    chapters: [
      { number: 1, declaredNumber: null, title: null, body: normalized.trim(), startLine: 1 },
    ],
    strategy: 'whole-document',
    patternName: null,
    gaps: [],
  };
}

/**
 * 找出声明的章节号缺口。
 *
 * ⚠ 只有"声明号与序号不一致"时才可能检出缺口 —— 无标题的章节
 *   没有声明号，无法判断，此时返回空（不猜）。
 */
function findGaps(chapters: readonly DetectedChapter[]): { after: number; before: number }[] {
  const declared = chapters
    .map((c) => c.declaredNumber)
    .filter((n): n is number => n !== null);
  if (declared.length < 2) return [];

  const gaps: { after: number; before: number }[] = [];
  for (let i = 1; i < declared.length; i++) {
    const prev = declared[i - 1]!;
    const cur = declared[i]!;
    if (cur - prev > 1) gaps.push({ after: prev, before: cur });
  }
  return gaps;
}
