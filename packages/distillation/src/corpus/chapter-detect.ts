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

/**
 * 判断一组数字是否构成递增序列。
 *
 * ⚠ 用于佐证"纯数字行"是否真的是章节标题：单个孤立的数字信息量太低
 *   （实测源文本里一行噪声「5」就被当成了章节），
 *   必须能构成递增序列才认定。
 *
 * 允许相等（有些源文本会出现重复号），但必须整体向上。
 */
function isIncreasingSequence(nums: readonly number[]): boolean {
  if (nums.length < 2) return false;
  let rises = 0;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i]! < nums[i - 1]!) return false;
    if (nums[i]! > nums[i - 1]!) rises++;
  }
  // 至少要有一半是真正递增的，否则不是章节序列
  return rises >= Math.floor(nums.length / 2);
}

/** 章节标题模式（按优先级排列） */
const TITLE_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  // 第X章 / 第X回 / 第X节（中文数字或阿拉伯数字）
  //
  // ⚠ 单位字后**不能紧跟句读标点**。实测踩到：正文里的
  //   「在第一章，如果时间再快十天…」「第一千章，写书两年」这类
  //   **散文提及**被当成了章节标题（后面跟逗号），导致
  //   findExtrasStart 在 87% 处误切，删掉 74 万字正文。
  //
  // ⚠ 但也不能要求"单位字后必须是空白"：实测 142 个真标题
  //   后面**直接跟汉字**（如「第九十四章眼光挺差」），
  //   要求空白会丢掉这 142 章、让它们与前章合并。
  //
  // 因此判据是「**排除**句读标点」而不是「只允许空白」。
  {
    name: 'cn-numbered',
    re: /^[\s\u3000]*第\s*[0-9一二三四五六七八九十百千零〇两]+\s*(?:章(?![节程])|回(?!合)|节(?!奏|目|省|约)|卷(?!轴|起|入|土)|篇)/,
  },
  // 「第X章：标题」带全角/半角冒号（实测《凡人修仙传》番外篇用此格式）
  {
    name: 'cn-numbered-colon',
    re: /^[\s\u3000]*第\s*[0-9一二三四五六七八九十百千零〇两]+\s*[章回节篇]\s*[：:]/,
  },
  // Chapter N / CHAPTER N
  { name: 'en-numbered', re: /^[\s\u3000]*Chapter\s+[0-9IVXLC]+\b.*$/i },
  // 纯数字标题行：1 / 001 / 1.
  //
  // ⚠ 这条**风险最高**：实测源文本里的噪声行「5」被当成了章节标题，
  //   造出一个正文为空、章号倒退的假章节。
  //   因此单凭"一行只有数字"不足以判定 —— 见 isBareNumberSequence()：
  //   必须能构成**递增序列**（≥2 个）才认定。
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

/**
 * 章节号缺口。
 *
 * `kind` 区分"语料缺章"与"源文本编号混乱" —— 两者的处置完全不同：
 *   前者需要补全语料，后者说明源文本质量差（可能需要换版本）。
 */
export interface ChapterGap {
  readonly after: number;
  readonly before: number;
  /** missing = 真实缺章（1~10）；numbering = 编号混乱（跳变>10 或倒退） */
  readonly kind: 'missing' | 'numbering';
  /** 缺了多少章（kind=numbering 时为负或巨大值，不代表真实缺章数） */
  readonly missing: number;
}

export interface DetectResult {
  readonly chapters: readonly DetectedChapter[];
  readonly strategy: DetectStrategy;
  /** 命中的标题模式名（便于诊断） */
  readonly patternName: string | null;
  /**
   * 声明的章节号缺口。
   *
   * ⚠ 如实报出而不是静默：缺口意味着**语料不完整**，
   *   会影响模式挖掘的样本覆盖度判断。人工需要知道这件事。
   *
   * ⚠ 但必须区分两类（实测《斗破苍穹》45 处缺口里混着两种）：
   *   - **真实缺口**：缺 1~10 章 → 语料不完整（35 处，共缺 110 章）
   *   - **编号混乱**：跳变 >10 章或倒退 → **源文本编号本身有问题**
   *     （10 处，如 `1 → 1424`、`440 → 1431`）
   *   混在一起会把"缺 7852 章"这种荒唐数字当成语料缺陷，
   *   掩盖真正的问题（源文本质量）。
   */
  readonly gaps: readonly ChapterGap[];
}

function isTitle(line: string): { hit: boolean; patternName: string | null } {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { hit: false, patternName: null };

  // ⚠ 过长的一行是"标题与正文合并"（实测 32 处，最长 76984 字）。
  //   早先直接**拒绝**这种行 —— 但那会丢掉整个章节标记，
  //   导致该章与前章合并（实测出现 35 万字的怪物章节）。
  //   现在改为**接受标记**，由 splitMergedTitle 把正文还回去。
  for (const p of TITLE_PATTERNS) {
    if (p.re.test(trimmed)) return { hit: true, patternName: p.name };
  }
  return { hit: false, patternName: null };
}

/**
 * 拆分"标题与正文合并"的行。
 *
 * 实测样例：`第五百六十一章血地八裂场中，白程那猛然间变得极其血红的脸庞…`
 * 真标题是「血地八裂」，后面紧跟的是正文。
 *
 * ⚠ 无法百分百还原标题边界（源文本本身没给分隔符），因此采取
 *   **保守切分**：在首个句读标点处切，且标题不超过 30 字。
 *   目标是"保住章节边界、不丢正文"，标题略有冗余是可接受的代价
 *   （标题对 NDE 的影响远小于章节边界错误）。
 */
export function splitMergedTitle(line: string): { title: string; rest: string } {
  const trimmed = line.trim();
  if (trimmed.length <= 60) return { title: trimmed, rest: '' };

  // 定位章节标记之后的位置
  const m = /^第\s*[0-9一二三四五六七八九十百千零〇两]+\s*[章回节卷篇]/.exec(trimmed);
  const start = m ? m[0].length : 0;
  const after = trimmed.slice(start);

  // 在标记后 30 字内找首个句读标点
  const window = after.slice(0, 30);
  const punct = /[，。、；：！？…]/.exec(window);
  const cut = punct ? start + punct.index + 1 : Math.min(start + 30, trimmed.length);

  return {
    title: trimmed.slice(0, cut).trim(),
    rest: trimmed.slice(cut).trim(),
  };
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

  // ⚠ 「卷」行在同时存在「章」行时不是章节，而是**卷标**。
  //
  //   实测《凡人修仙传》：清洗阶段把「第九卷灵界百族第一千六百五十三章尸体与真血」
  //   拆成两行后，卷标行「第九卷灵界百族」被当成章节（声明号 = 9），
  //   造成 410 处章号"倒退"（如 1652 → 9）—— 全是假象。
  //
  //   判据：若全书以「章/回」为主（≥2 个），则「第X卷」单独成行的行只是卷标。
  const chapterUnitHits = titleHits.filter((t) => /[章回节篇]/.test(t.title)).length;
  if (chapterUnitHits >= 2) {
    for (let i = titleHits.length - 1; i >= 0; i--) {
      const t = titleHits[i]!;
      // 只含「卷」不含「章/回」→ 卷标，剔除
      if (/第[0-9一二三四五六七八九十百千零〇两]+\s*卷/.test(t.title) && !/[章回节篇]/.test(t.title)) {
        titleHits.splice(i, 1);
      }
    }
  }

  // ⚠ 纯数字标题必须构成**递增序列**才认定。
  //   实测踩到：源文本里一行孤立的「5」被当成章节标题，
  //   造出一个正文为空、章号倒退的假章节。
  //   单看"一行只有数字"信息量太低，必须靠序列性佐证。
  const numberHits = titleHits.filter((t) => t.patternName === 'bare-number');
  if (numberHits.length < 2 || !isIncreasingSequence(numberHits.map((t) => Number(t.title.trim().replace(/[.、]$/, ''))))) {
    const dropIdx = new Set(numberHits.map((t) => t.index));
    for (let i = titleHits.length - 1; i >= 0; i--) {
      if (dropIdx.has(titleHits[i]!.index)) titleHits.splice(i, 1);
    }
  }

  // 至少 2 个标题才算"有章节结构"；只有 1 个可能是正文里的偶然匹配
  if (titleHits.length >= 2) {
    const chapters: DetectedChapter[] = [];
    for (let k = 0; k < titleHits.length; k++) {
      const cur = titleHits[k]!;
      const next = titleHits[k + 1];
      const bodyStart = cur.index + 1;
      const bodyEnd = next ? next.index : lines.length;
      // ⚠ 标题行可能含正文（"标题+正文合并"，实测 32 处）——
      //   拆分后把正文还给本章，避免丢内容。
      const split = splitMergedTitle(cur.title);
      const restOfTitleLine = split.rest;
      const rawBody = lines.slice(bodyStart, bodyEnd).join('\n').trim();
      const body = restOfTitleLine.length > 0
        ? `${restOfTitleLine}\n\n${rawBody}`.trim()
        : rawBody;

      chapters.push({
        number: k + 1,
        declaredNumber: declaredNumberOf(split.title),
        title: split.title,
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
function findGaps(chapters: readonly DetectedChapter[]): ChapterGap[] {
  const declared = chapters
    .map((c) => c.declaredNumber)
    .filter((n): n is number => n !== null);
  if (declared.length < 2) return [];

  const gaps: ChapterGap[] = [];
  for (let i = 1; i < declared.length; i++) {
    const prev = declared[i - 1]!;
    const cur = declared[i]!;
    const missing = cur - prev - 1;
    // ⚠ 阈值 3：实测源文本的小幅乱序是 1~3 章
    //   （如 599 → 560 是倒退 39，属乱序；457 → 456 是倒退 1）。
    //   跳变 1~3 视为真实缺章；>3 或倒退视为源文本编号混乱。
    if (missing >= 1 && missing <= 3) {
      gaps.push({ after: prev, before: cur, kind: 'missing', missing });
    } else if (missing > 3 || cur <= prev) {
      gaps.push({ after: prev, before: cur, kind: 'numbering', missing });
    }
  }
  return gaps;
}

/** 汇总缺口：区分真实缺章与编号混乱 */
export function summarizeGaps(gaps: readonly ChapterGap[]): {
  readonly missingCount: number;
  readonly missingChapters: number;
  readonly numberingCount: number;
} {
  const m = gaps.filter((g) => g.kind === 'missing');
  return {
    missingCount: m.length,
    missingChapters: m.reduce((s, g) => s + g.missing, 0),
    numberingCount: gaps.filter((g) => g.kind === 'numbering').length,
  };
}
