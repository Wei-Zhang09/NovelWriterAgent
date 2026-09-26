/**
 * 去AI味检测器 —— **advisory 密度型**移植自 oh-story-claudecode（ADR-0009）。
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
 * ## 与 `ported-detectors.ts` 的分工
 *
 * `ported-detectors.ts` 收的是上游的 **7 类 blocking**（逐处、可精确定位）。
 * 本文件收的是上游的 **14 类 advisory**。两者是**两套不同的检测形状**，
 * 拆开是因为它们的失败模式不同：
 *
 *   - blocking 是**逐处**的：一处命中就是一个问题，误报代价是
 *     "让作者改写本来没问题的句子" → 必须靠大量豁免把误报压到 ≈0。
 *   - advisory 大多是**分布级**的：它问的是"这一章的**整体分布**
 *     是否像机器写的"（比喻密度、功能词密度、短段占比…），
 *     单个比喻、单个"了"都不是问题。所以它**全文只报一条**，
 *     报的是分布指纹，不是逐处问题。
 *
 * ⚠ 把 advisory 当 blocking 用（逐处让作者改）会毁掉正文 ——
 *   上游对每条都写了"修法是通读后补断裂处，不是为凑阈值全局加的/了/就"。
 *   这里的 `detail` 逐条保留了该修法说明。
 *
 * ## ⚠ 阈值一个字都没改
 *
 * 上游每条阈值都是在**真人语料**上校准的（注释里写着校准样本与误报率，
 * 如 stock-reaction 从 1.0 调到 1.5 把短篇误报从 5.57% 降到 1.46%）。
 * 这些校准结论**比我的直觉可靠**，照搬。
 *
 * 本项目的语料可能与之不同 —— 那是**校准**问题，不是**移植**问题。
 * 若实测误报率不可接受，正确做法是**记录偏离并说明**（ADR-0009 要求），
 * 而不是悄悄改数字让测试变绿。
 *
 * ## ⚠ 密度分母是"引号外叙述字数"，不是全文
 *
 * 上游每条密度型都用 `stripQuoted` 剥掉引号内台词再统计。理由是
 * 台词/弹幕/系统播报**天然短促、天然重复**（角色就那个说话方式），
 * 混入统计会把**体裁特征**误当**机器指纹**。这个豁免必须一并移植。
 */

/** 句末停顿字符：命中片段到此为止 */
const STOP_CHARS = new Set(['。', '！', '？', '!', '?', '\n']);

// ── 阈值（逐条照搬上游，勿"优化"）──────────────────────────────

const LONG_PARAGRAPH_CHARS = 200;

const MICRO_TIC_PATTERN = /了(?:[一两三几半])?[下阵圈道声眼口气会]/g;
const MICRO_TIC_MIN_HITS = 5;
const MICRO_TIC_PER_KILO = 6;

const STOCK_REACTION_PATTERNS = [
  /(?:指尖|手指|指节|手背|掌心|拳头|袖口|衣角|裙角|下唇|嘴唇|唇角|嘴角|眉头|眼底|眸光|目光|视线|肩膀|呼吸)[^。！？!?\n]{0,16}(?:轻轻|微微|缓缓|悄然|不自觉|无意识|下意识|攥紧|握紧|收紧|绞紧|泛白|发白|叩|敲|摩挲|抿紧|抿成|移开|垂下|躲开|一颤|颤了?一下|停了?一下|顿了?一下)/g,
  /(?:语气|声音)[^。！？!?\n]{0,12}(?:平静|冷静|平淡|冷淡|淡漠|平直)[^。！？!?\n]{0,12}(?:像|仿佛|如同|好像)[^。！？!?\n]{0,16}(?:念|读|报|说|陈述|宣判|背诵)/g,
  /(?:胸口|心口)[^。！？!?\n]{0,16}(?:像|仿佛|如同|好像)[^。！？!?\n]{0,16}(?:撞|锤|压|攥|堵)[^。！？!?\n]{0,8}(?:一下|一记|一拳)?/g,
  /(?:声音|嗓音|语气)[^。！？!?\n]{0,12}(?:放轻|压低|发紧|发颤|很轻|轻了些)/g,
  /(?:喉结|喉头|喉咙)[^。！？!?\n]{0,10}(?:滚|动|紧|堵|发涩|发干)/g,
  /(?:眼眶|眼圈|鼻子)[^。！？!?\n]{0,8}(?:发红|红了|发热|发酸|一酸)/g,
  /(?:抿了?下唇|抿了?抿唇|抿了?下嘴|抿着笑)/g,
];
const STOCK_REACTION_MIN_HITS = 4;
/**
 * ⚠ 上游校准记录（照搬，别按直觉改）：
 * 长篇 per-kilo 1.0→1.5 误报 0.43%→0.39%，几乎不动；短篇整篇
 * MIN_HITS 形同虚设、只剩密度门，1.0 时误报 5.57%，1.5 降到 1.46%。
 * 故取 1.5，把长篇/短篇两个总体拉到同一量级。
 */
const STOCK_REACTION_PER_KILO = 1.5;

const ACTION_LIST_VERB_PATTERN =
  /伸手|抬手|探手|拿起|拿过|取出|取过|掏出|摸出|抓起|攥住|握住|捏住|按住|推开|拉开|打开|关上|放下|递给|挑开|掀开|扯开|拧开|倒出|端起|转身|回头|抬头|低头|弯腰|俯身|走到|走向|坐下|站起|看向|看着|盯着|扫过/g;
const ACTION_LIST_MIN_HITS = 5;
const ACTION_LIST_MIN_SEPARATORS = 4;

const ABSTRACT_SUMMARY_PATTERNS = [
  /这一刻[，,]?[^\n。！？!?]{0,24}(?:终于|才)(?:明白|意识到)/g,
  /从这一刻开始/g,
  /(?:命运|宿命)[^\n。！？!?]{0,28}(?:齿轮|棋局|獠牙|改写|推向|安排)/g,
  /早已[^\n。！？!?]{0,8}(?:布好|安排好)[^\n。！？!?]{0,8}(?:棋局|局)/g,
  /前所未有的(?:决意|清醒|勇气|力量|恐惧|平静|信念)/g,
  /(?:反击|复仇|战争|较量|故事|命运)[^\n。！？!?]{0,12}才刚刚开始/g,
  /(?:新的开始|全新的开始)/g,
];
const ABSTRACT_SUMMARY_MIN_HITS = 3;
const ABSTRACT_SUMMARY_PER_KILO = 4;

const CLICHE_PATTERNS = [
  /仿佛|犹如|宛若|如同/g,
  /一丝|一抹|些许|几分|隐约/g,
  /深吸一口气|缓缓|微微|轻轻|淡淡/g,
  /眼中闪过|嘴角勾起|眸光微微一闪|指节泛白|目光锐利|眼神锐利/g,
  /心中涌起一股|心头一震|心中一动|心下了然|心中暗道|心中一凛/g,
  /不容置疑|不容置喙|不易察觉|显而易见|毫无疑问|不可否认/g,
  /声音不大[，,]?却带着|语气平静无波|平静无波|声音平直|听不出情绪/g,
  /不知何时|唾手可得|无声翻涌|沉默(?:在[^。！？!?\n]{0,16})?蔓延|难以言说/g,
  /散发着一股|冰冷的光|格外刺眼|深邃而冰冷/g,
];
const CLICHE_DENSITY_MIN_HITS = 8;
const CLICHE_DENSITY_PER_KILO = 12;

const METAPHOR_MARKER_PATTERN = /好像|像是|仿佛|宛如|如同|犹如|(?<![不头图画影录摄肖])像(?![头像素])/g;
const METAPHOR_LIKE_PHRASE_PATTERN = /(?:死|水|冰|火|潮水|石头|木头|机器|纸|铁|鬼|死人|刀|针|网|墙)一样/g;
const METAPHOR_DENSITY_MIN_HITS = 7;
const METAPHOR_DENSITY_PER_KILO = 3;

const REASONING_CHAIN_PATTERNS = [
  { key: 'mental', core: true, pattern: /(?<![不没未无])(?:他|她|我)?(?:知道|明白|意识到|清楚|判断|确认|分析)/g },
  {
    key: 'connector',
    core: true,
    pattern: /这意味着|也就是说|换句话说|真正的问题(?:在于)?|问题在于|关键在于|在这种情况下|按照这个逻辑|只有这样|想到这里/g,
  },
  {
    key: 'modal',
    core: true,
    pattern: /(?:(?<!不)(?:必须|需要|应该|只要|就会|可能|可以|能够|无法)|不能)[^。！？!?\n]{0,16}(?:判断|确认|承担|维持|稳住|控制|扩大|失控|带来|造成|理解|默认|回家|进门|核对|筛选|减少|建立|风险|结果|秩序|责任)/g,
  },
  { key: 'abstract', core: false, pattern: /(?:任务|条件|风险|来源|逻辑|局面|结果|责任|秩序|规则|信息不足|决策能力)/g },
];
const REASONING_CHAIN_MIN_HITS = 8;
const REASONING_CHAIN_CORE_MIN_HITS = 4;
const REASONING_CHAIN_MIN_BUCKETS = 2;
const REASONING_CHAIN_PER_KILO = 18;

const NOTICE_FORMAL_PATTERNS = [
  /不得|必须|不可|禁止|严禁|应当|须|需|务必/g,
  /当前|本公告|本规则|本系统|提示|任务失败|临时权限|权限|状态|等级/g,
  /维持|公共区域|秩序|优先|惩罚|处罚|违规|指令|执行/g,
  /被视为|同样计入|计入|承担|责任|单位|撤回|转发|截图/g,
];
const NOTICE_FORMAL_CORE_PATTERN = /不得|必须|不可|禁止|严禁|应当|须|需|务必|被视为|同样计入|计入/g;
const NOTICE_FORMAL_MIN_LINES = 4;
const NOTICE_FORMAL_MIN_HITS = 12;
const NOTICE_FORMAL_CORE_MIN_HITS = 5;
const NOTICE_FORMAL_PER_KILO = 60;

const OVERCOMPRESSED_PROSE_PARTICLE_PATTERN = /[的了就着过呢吧啊呀嘛]/g;
const OVERCOMPRESSED_PROSE_MIN_CHARS = 1200;
const OVERCOMPRESSED_PROSE_MIN_PARAS = 45;
const OVERCOMPRESSED_PROSE_SHORT_MAX_CHARS = 15;
const OVERCOMPRESSED_PROSE_SHORT_RATIO = 0.58;
const OVERCOMPRESSED_PROSE_PARTICLE_PER_KILO = 85;

const LOW_CONNECTIVE_FUNCTION_TERMS = [
  '的', '了', '就', '在', '是', '也', '都', '还', '又', '把', '被', '给',
  '这个', '那个', '里面', '以后', '时候', '现在', '因为', '所以', '但是',
  '不过', '然后', '已经', '还是', '起来', '出来', '下去',
];
const LOW_CONNECTIVE_PLAIN_TERMS = [
  '的', '了', '就', '也', '还', '又', '这个', '那个', '东西', '事情',
  '时候', '里面', '以后', '一下', '一点', '有点', '还是',
];
const LOW_CONNECTIVE_MIN_CHARS = 800;
const LOW_CONNECTIVE_FUNCTION_PER_KILO = 100;
const LOW_CONNECTIVE_PLAIN_PER_KILO = 65;
const LOW_CONNECTIVE_LONG_SENTENCE_CHARS = 30;
const LOW_CONNECTIVE_LONG_SENTENCE_RATIO = 0.08;

const STUTTER_MIN_RUN = 6;
const STUTTER_MAX_SENTENCE = 5;

const DECISION_FRAME_PATTERN = /至于([\u3400-\u9fff]{1,3})不\1[，,]\s*怎么\1/g;
const REPEATED_NEGATIVE_VERB_PATTERN = /不([\u3400-\u9fff]{1,2})([\u3400-\u9fff]{2,8})[，,]\s*不\1([\u3400-\u9fff]{2,8})/g;

const CROSS_NEGATION_START = /^不是[^。！？!?\n]{1,24}[。！？!?]?$/;
const CROSS_NEGATION_MIDDLE = /^(?:也|还)不是[^。！？!?\n]{1,24}[。！？!?]?$/;
const CROSS_NEGATION_END = /^只是[^。！？!?\n]{1,32}[。！？!?]?$/;

const QUOTE_EMPHASIS_MIN_HITS = 3;
const QUOTE_EMPHASIS_MAX_VISIBLE = 4;
const QUOTE_EMPHASIS_SPEECH_VERB_PATTERN = /[说道问喊答念叫回吼骂写读唱嘀咕]/;

// ── 引号基建（与 ported-detectors.ts 同源；上游也是两处共用同一套）──────

const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['「', '」'], ['『', '』'], ['【', '】'], ['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeRegExpCharClass(s: string): string {
  return s.replace(/[\\\]^-]/g, '\\$&');
}

const QUOTE_SOURCES = QUOTE_PAIRS.map(
  ([open, close]) => `${escapeRegExp(open)}[^${escapeRegExpCharClass(close)}\\n]*${escapeRegExp(close)}`,
);

/** 去掉成对引号内片段（台词/系统播报），只留引号外叙述 */
function stripQuoted(text: string): string {
  let out = text;
  for (const src of QUOTE_SOURCES) out = out.replace(new RegExp(src, 'g'), '');
  return out;
}

/** 返回引号内片段（含引号本身）的 [start, end) 区间 */
function quotedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const src of QUOTE_SOURCES) {
    const re = new RegExp(src, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function compact(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function isDivider(trimmed: string): boolean {
  return /^-{3,}$/.test(trimmed) || /^[*_]{3,}$/.test(trimmed);
}

/**
 * markdown 结构行（标题/列表/引用/表格）不是叙述正文，
 * 长段落/碎句号/破折号检测都跳过。
 */
function isStructural(trimmed: string): boolean {
  return (
    /^(#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|\|)/.test(trimmed) ||
    /^第[零一二三四五六七八九十百千万\d]+章(?:\s|_|$)/.test(trimmed)
  );
}

/** 系统公告载体行（【…】）—— 公文腔检测只认这种行 */
function isNoticeLine(trimmed: string): boolean {
  return /^【[^】]+】$/.test(trimmed);
}

function splitSentences(trimmed: string): string[] {
  return trimmed
    .split(/[。！？!?]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function sentenceAround(text: string, index: number): string {
  let start = index;
  while (start > 0 && !STOP_CHARS.has(text[start - 1]!)) start -= 1;
  let end = index;
  while (end < text.length && !STOP_CHARS.has(text[end]!)) end += 1;
  return compact(text.slice(start, end).trim());
}

/** 可见字数：只数汉字/全角字母/ASCII 字母数字，忽略标点空白 */
function visibleLength(sentence: string): number {
  const matched = sentence.match(/[一-鿿Ａ-ｚA-Za-z0-9]/g);
  return matched ? matched.length : 0;
}

function countTerms(text: string, terms: readonly string[]): number {
  let count = 0;
  for (const term of terms) {
    let index = text.indexOf(term);
    while (index !== -1) {
      count += 1;
      index = text.indexOf(term, index + term.length);
    }
  }
  return count;
}

/** 命中形状：段落序号（1-based）+ 片段 + 计数 */
export interface AdvisoryHit {
  /** 段落序号（1-based）—— 分布级检测报**首次命中**所在段 */
  readonly paragraph: number;
  readonly excerpt: string;
  /** 该规则的原始计数（密度型用它说明"多少处/千字"） */
  readonly count: number;
}

/**
 * 逐行文本（跳过空行/分隔线/结构行）—— 与上游 `proseLines` 的过滤一致。
 *
 * ## ⚠⚠ 为什么必须**按行**拆，而不是把每个段落块当一个单位
 *
 * 本项目的 `splitParagraphs()`（@nwa/core）按**空行**切段 ——
 * 一个"段落"是空行分隔的**块**，块内可以有多行。
 * 而上游 `scanDocument` 是**按行**建 `proseLines` 的，它的检测单位是**行**。
 *
 * 第一版我把上游的行循环直接照搬，却把**段落块**喂了进去 ——
 * 于是「90 行、每行 22 字」的正文被当成**一个 2000 字的段落**，
 * 触发了 long_paragraph，而上游按行看根本不报。
 * 实测就是靠交叉验证抓出来的（`low_connective` fixture 上
 * 本项目独有 `long_paragraph`）。
 *
 * 所以：**检测单位 = 行**（与上游一致），
 *      **上报段号 = 该行所属的段落块序号**（供 M8 定位，定位按块）。
 * 两者分开，既保真又能定位。
 */
interface ProseLine {
  readonly text: string;
  /** 所属段落块序号（1-based）—— 上报给 UI 定位用 */
  readonly paragraph: number;
  /** 全局行序（1-based）—— 上游按行号做的"是否连续"判断用它 */
  readonly lineOrdinal: number;
}

function proseLines(paragraphs: readonly string[]): ProseLine[] {
  const out: ProseLine[] = [];
  let ordinal = 0;
  paragraphs.forEach((block, idx) => {
    for (const raw of block.split(/\r?\n/)) {
      ordinal += 1;
      const trimmed = raw.trim();
      if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
      out.push({ text: raw, paragraph: idx + 1, lineOrdinal: ordinal });
    }
  });
  return out;
}

/** 只保留引号外叙述非空的行（密度型检测的输入） */
function narrativeLines(paragraphs: readonly string[]): ProseLine[] {
  return proseLines(paragraphs).filter((l) => visibleLength(stripQuoted(l.text.trim())) > 0);
}

// ────────────────────────────────────────────────────────────────
// 逐段型（4 类）
// ────────────────────────────────────────────────────────────────

/**
 * 长段落（advisory）。
 *
 * 判据：段内可见字数 > 200。
 * 修法：按镜头/新动作/新线索/视线切换断段，别一段到底。
 *
 * ⚠ 用 `trimmed.length`（含标点的**原始长度**）与上游一致，
 *   不是 visibleLength —— 上游这里数的是字符串长度。
 */
export function findLongParagraphs(paragraphs: readonly string[]): AdvisoryHit[] {
  const out: AdvisoryHit[] = [];
  for (const line of proseLines(paragraphs)) {
    const trimmed = line.text.trim();
    if (trimmed.length > LONG_PARAGRAPH_CHARS) {
      out.push({ paragraph: line.paragraph, excerpt: compact(trimmed.slice(0, 40)), count: trimmed.length });
    }
  }
  return out;
}

/**
 * 工整排比框架（advisory）。
 *
 * 两类常见但**不能直接判错**的工整框架 —— 与 blocking 规则不同，
 * 这里**故意扫描台词**：自然点单「不放辣，不放葱」靠对象最短长度排除；
 * 更长的同动词清单交语义审查判断功能。
 */
export function findFormulaicParallelism(paragraphs: readonly string[]): AdvisoryHit[] {
  const out: AdvisoryHit[] = [];

  // ① 逐段：同段内的「至于X不X，怎么X」「不V A，不V B」
  for (const line of proseLines(paragraphs)) {
    for (const pattern of [DECISION_FRAME_PATTERN, REPEATED_NEGATIVE_VERB_PATTERN]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line.text)) !== null) {
        out.push({ paragraph: line.paragraph, excerpt: compact(match[0]), count: 1 });
      }
    }
  }

  // ② 跨段：「不是A / 也不是B / 只是C」三连。
  //
  // ⚠ 上游注释：既可能是细纲复述，也可能是正常的辩解、悬念排除或情绪递进。
  //   纯句法无法稳定区分，因此**只给 advisory**，交给语义复核。
  //
  // ⚠ "连续"按**行号**判断（上游 `lineNo - window.last.lineNo > 2`）——
  //   不是段号。用段号会让跨行段落的窗口行为与上游不同。
  const window: { text: string; original: string; paragraph: number; lineOrdinal: number }[] = [];
  for (const line of proseLines(paragraphs)) {
    const trimmed = line.text.trim();
    if (!trimmed) continue;
    if (isDivider(trimmed) || isStructural(trimmed)) {
      window.length = 0;
      continue;
    }
    if (window.length && line.lineOrdinal - window[window.length - 1]!.lineOrdinal > 2) window.length = 0;
    window.push({ text: stripQuoted(trimmed), original: trimmed, paragraph: line.paragraph, lineOrdinal: line.lineOrdinal });
    if (window.length > 3) window.shift();
    if (window.length !== 3) continue;
    if (
      !CROSS_NEGATION_START.test(window[0]!.text) ||
      !CROSS_NEGATION_MIDDLE.test(window[1]!.text) ||
      !CROSS_NEGATION_END.test(window[2]!.text)
    ) {
      continue;
    }
    out.push({
      paragraph: window[0]!.paragraph,
      excerpt: compact(window.map((e) => e.original).join(' / ')),
      count: 1,
    });
  }

  return out;
}

/**
 * 监控摄像头式动作清单（advisory）。
 *
 * 判据：同段连续动作动词 ≥5 个**且**分隔符 ≥4 个。
 * 只做 advisory —— 打斗/追逐等功能性动作编排可保留或人工复核。
 */
export function findActionListTic(paragraphs: readonly string[]): AdvisoryHit[] {
  const out: AdvisoryHit[] = [];
  for (const line of proseLines(paragraphs)) {
    const narrative = stripQuoted(line.text.trim()).trim();
    if (!narrative) continue;

    ACTION_LIST_VERB_PATTERN.lastIndex = 0;
    const verbs: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = ACTION_LIST_VERB_PATTERN.exec(narrative)) !== null) verbs.push(match[0]);

    if (verbs.length < ACTION_LIST_MIN_HITS) continue;
    const separators = (narrative.match(/[，、；;]/g) || []).length;
    if (separators < ACTION_LIST_MIN_SEPARATORS) continue;

    out.push({ paragraph: line.paragraph, excerpt: compact(verbs.slice(0, 8).join(' ')), count: verbs.length });
  }
  return out;
}

/**
 * 碎句号：连续 ≥6 个短句（≤5 字）无呼吸（advisory）。
 *
 * ⚠ 上游对"空行 / 纯对话行 / 分隔线"都**重置**计数：
 *   一句一段的排版与台词成片短句都是正常形态，不是碎句号。
 */
export function findPeriodStutter(paragraphs: readonly string[]): AdvisoryHit[] {
  const out: AdvisoryHit[] = [];
  let runLen = 0;
  let runStart: number | null = null;
  let runSample: string[] = [];

  const flush = (): void => {
    if (runLen >= STUTTER_MIN_RUN && runStart !== null) {
      out.push({ paragraph: runStart, excerpt: compact(runSample.join(' ')), count: runLen });
    }
    runLen = 0;
    runStart = null;
    runSample = [];
  };

  for (const line of proseLines(paragraphs)) {
    const trimmed = line.text.trim();
    if (isDivider(trimmed) || isStructural(trimmed)) {
      flush();
      continue;
    }
    const narrative = stripQuoted(trimmed);
    if (visibleLength(narrative) === 0) {
      // 纯对话/弹幕/系统播报：成片短句是正常形态，重置
      flush();
      continue;
    }
    for (const sentence of splitSentences(narrative)) {
      if (visibleLength(sentence) <= STUTTER_MAX_SENTENCE) {
        if (runLen === 0) runStart = line.paragraph;
        runLen += 1;
        if (runSample.length < 6) runSample.push(sentence);
      } else {
        flush();
      }
    }
  }
  flush();
  return out;
}

// ────────────────────────────────────────────────────────────────
// 分布型（10 类）—— 全文只报一条
// ────────────────────────────────────────────────────────────────

/** 微动作复读：「了X量词」轻量补语密度 */
export function findMicroActionTic(paragraphs: readonly string[]): AdvisoryHit[] {
  let hits = 0;
  let narrativeChars = 0;
  let first: number | null = null;
  const samples: string[] = [];

  for (const line of narrativeLines(paragraphs)) {
    const narrative = stripQuoted(line.text.trim());
    narrativeChars += visibleLength(narrative);
    MICRO_TIC_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MICRO_TIC_PATTERN.exec(narrative)) !== null) {
      hits += 1;
      if (first === null) first = line.paragraph;
      if (samples.length < 6 && !samples.includes(match[0])) samples.push(match[0]);
    }
  }

  if (narrativeChars === 0 || hits < MICRO_TIC_MIN_HITS) return [];
  if ((hits / narrativeChars) * 1000 < MICRO_TIC_PER_KILO) return [];
  return [{ paragraph: first ?? 1, excerpt: compact(samples.join(' ')), count: hits }];
}

/**
 * 套式反应细节（advisory）。
 *
 * ⚠ 上游：这是**删除测试的候选集，不是身体描写黑名单**。
 *   保留有动作后果、伤势、人物习惯或情节功能的细节。
 */
export function findStockReactionTic(paragraphs: readonly string[]): AdvisoryHit[] {
  let hits = 0;
  let narrativeChars = 0;
  let first: number | null = null;
  const samples: string[] = [];

  for (const line of narrativeLines(paragraphs)) {
    const narrative = stripQuoted(line.text.trim());
    narrativeChars += visibleLength(narrative);

    for (const pattern of STOCK_REACTION_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(narrative)) !== null) {
        hits += 1;
        if (first === null) first = line.paragraph;
        const sample = sentenceAround(narrative, match.index);
        if (samples.length < 6 && sample && !samples.includes(sample)) samples.push(sample);
      }
    }
  }

  if (narrativeChars === 0 || hits < STOCK_REACTION_MIN_HITS) return [];
  if ((hits / narrativeChars) * 1000 < STOCK_REACTION_PER_KILO) return [];
  return [{ paragraph: first ?? 1, excerpt: compact(samples.join(' | ')), count: hits }];
}

/** 套词密度：高危 AI 套词聚集（不是逐词替换器） */
export function findClicheDensityTic(paragraphs: readonly string[]): AdvisoryHit[] {
  let hits = 0;
  let narrativeChars = 0;
  let first: number | null = null;
  const samples: string[] = [];

  for (const line of narrativeLines(paragraphs)) {
    const narrative = stripQuoted(line.text.trim());
    narrativeChars += visibleLength(narrative);

    for (const pattern of CLICHE_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(narrative)) !== null) {
        hits += 1;
        if (first === null) first = line.paragraph;
        if (samples.length < 8 && !samples.includes(match[0])) samples.push(match[0]);
      }
    }
  }

  if (narrativeChars === 0 || hits < CLICHE_DENSITY_MIN_HITS) return [];
  if ((hits / narrativeChars) * 1000 < CLICHE_DENSITY_PER_KILO) return [];
  return [{ paragraph: first ?? 1, excerpt: compact(samples.join(' ')), count: hits }];
}

/** 比喻密度：像/好像/仿佛/如同 等标记成片复现 */
export function findMetaphorDensityTic(paragraphs: readonly string[]): AdvisoryHit[] {
  let hits = 0;
  let narrativeChars = 0;
  let first: number | null = null;
  const samples: string[] = [];

  for (const line of narrativeLines(paragraphs)) {
    const narrative = stripQuoted(line.text.trim());
    narrativeChars += visibleLength(narrative);

    METAPHOR_MARKER_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = METAPHOR_MARKER_PATTERN.exec(narrative)) !== null) {
      hits += 1;
      if (first === null) first = line.paragraph;
      const sample = sentenceAround(narrative, match.index);
      if (samples.length < 6 && sample && !samples.includes(sample)) samples.push(sample);
    }

    // ⚠ 「X一样」要排除**前面已有比喻标记**的情形（「像潮水一样」的「潮水一样」
    //   不是第二个比喻）—— 上游用前 8 字回看。
    METAPHOR_LIKE_PHRASE_PATTERN.lastIndex = 0;
    while ((match = METAPHOR_LIKE_PHRASE_PATTERN.exec(narrative)) !== null) {
      const prefix = narrative.slice(Math.max(0, match.index - 8), match.index);
      if (/好像|像是|像|仿佛|宛如|如同|犹如/.test(prefix)) continue;
      hits += 1;
      if (first === null) first = line.paragraph;
      const sample = sentenceAround(narrative, match.index);
      if (samples.length < 6 && sample && !samples.includes(sample)) samples.push(sample);
    }
  }

  if (narrativeChars === 0 || hits < METAPHOR_DENSITY_MIN_HITS) return [];
  if ((hits / narrativeChars) * 1000 < METAPHOR_DENSITY_PER_KILO) return [];
  return [{ paragraph: first ?? 1, excerpt: compact(samples.join(' | ')), count: hits }];
}

/** 解释链密度：知道/明白/这意味着/必须需要 等判断链 */
export function findReasoningChainTic(paragraphs: readonly string[]): AdvisoryHit[] {
  let hits = 0;
  let coreHits = 0;
  let narrativeChars = 0;
  let first: number | null = null;
  const samples: string[] = [];
  const buckets = new Set<string>();

  for (const line of narrativeLines(paragraphs)) {
    const narrative = stripQuoted(line.text.trim());
    narrativeChars += visibleLength(narrative);

    for (const { pattern, key, core } of REASONING_CHAIN_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(narrative)) !== null) {
        hits += 1;
        if (core) coreHits += 1;
        buckets.add(key);
        if (first === null) first = line.paragraph;
        const sample = compact(match[0]);
        if (samples.length < 8 && !samples.includes(sample)) samples.push(sample);
      }
    }
  }

  if (narrativeChars === 0 || hits < REASONING_CHAIN_MIN_HITS) return [];
  if (coreHits < REASONING_CHAIN_CORE_MIN_HITS || buckets.size < REASONING_CHAIN_MIN_BUCKETS) return [];
  if ((hits / narrativeChars) * 1000 < REASONING_CHAIN_PER_KILO) return [];
  return [{ paragraph: first ?? 1, excerpt: compact(samples.join(' | ')), count: hits }];
}

/**
 * 系统公告公文腔（advisory）。
 *
 * ⚠ 只统计**方括号规则行**（【…】）里的硬规则词 —— 单条严肃规则、
 *   日常叙述或普通对话都不触发。
 */
export function findNoticeFormalityTic(paragraphs: readonly string[]): AdvisoryHit[] {
  let hits = 0;
  let noticeChars = 0;
  let noticeLines = 0;
  let coreHits = 0;
  let first: number | null = null;
  const samples: string[] = [];

  for (const line of proseLines(paragraphs)) {
    const trimmed = line.text.trim();
    if (!isNoticeLine(trimmed)) continue;
    noticeLines += 1;
    noticeChars += visibleLength(trimmed);

    NOTICE_FORMAL_CORE_PATTERN.lastIndex = 0;
    while (NOTICE_FORMAL_CORE_PATTERN.exec(trimmed) !== null) coreHits += 1;

    for (const pattern of NOTICE_FORMAL_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(trimmed)) !== null) {
        hits += 1;
        if (first === null) first = line.paragraph;
        const sample = compact(match[0]);
        if (samples.length < 8 && !samples.includes(sample)) samples.push(sample);
      }
    }
  }

  if (
    noticeLines < NOTICE_FORMAL_MIN_LINES ||
    noticeChars === 0 ||
    hits < NOTICE_FORMAL_MIN_HITS ||
    coreHits < NOTICE_FORMAL_CORE_MIN_HITS
  ) {
    return [];
  }
  if ((hits / noticeChars) * 1000 < NOTICE_FORMAL_PER_KILO) return [];
  return [{ paragraph: first ?? 1, excerpt: compact(samples.join(' | ')), count: hits }];
}

/**
 * 过度精炼短段（advisory）。
 *
 * 判据（**全部**满足）：叙述字数 ≥1200 且叙述段 ≥45 且 ≤15 字的短段占比 ≥58%
 * 且自然连接词（的/了/就/着/过…）< 85/千字。
 *
 * ⚠ 上游修法：**通读后补断裂处，不是为凑阈值全局加的/了/就**。
 */
export function findOvercompressedProseTic(paragraphs: readonly string[]): AdvisoryHit[] {
  let narrativeChars = 0;
  let narrativeParas = 0;
  let shortParas = 0;
  let particles = 0;
  let first: number | null = null;
  const samples: string[] = [];

  for (const line of proseLines(paragraphs)) {
    const trimmed = line.text.trim();
    if (isNoticeLine(trimmed)) continue;
    const narrative = stripQuoted(trimmed).trim();
    const len = visibleLength(narrative);
    if (len === 0) continue;

    if (first === null) first = line.paragraph;
    narrativeParas += 1;
    narrativeChars += len;
    if (len <= OVERCOMPRESSED_PROSE_SHORT_MAX_CHARS) {
      shortParas += 1;
      if (samples.length < 6) samples.push(narrative);
    }

    OVERCOMPRESSED_PROSE_PARTICLE_PATTERN.lastIndex = 0;
    while (OVERCOMPRESSED_PROSE_PARTICLE_PATTERN.exec(narrative) !== null) particles += 1;
  }

  if (narrativeChars < OVERCOMPRESSED_PROSE_MIN_CHARS || narrativeParas < OVERCOMPRESSED_PROSE_MIN_PARAS) return [];
  if (shortParas / narrativeParas < OVERCOMPRESSED_PROSE_SHORT_RATIO) return [];
  if ((particles / narrativeChars) * 1000 >= OVERCOMPRESSED_PROSE_PARTICLE_PER_KILO) return [];
  return [{ paragraph: first ?? 1, excerpt: compact(samples.join(' | ')), count: narrativeParas }];
}

/**
 * 低连接密度（advisory）—— overcompressed 的**短窗口补充**。
 *
 * 判据（全部满足）：叙述字数 ≥800 且功能词 <100/千字 且白话连接 <65/千字
 * 且 ≥30 字的中长句占比 <8%。
 *
 * ⚠ 上游注释：单纯低功能词会**误抓有大量中长句的文本**，
 *   所以必须叠加"中长句不足"这一条。只看引号外叙述。
 */
export function findLowConnectiveDensityTic(paragraphs: readonly string[]): AdvisoryHit[] {
  let bodyChars = 0;
  let functionHits = 0;
  let plainHits = 0;
  let first: number | null = null;
  const sentences: number[] = [];
  const samples: string[] = [];

  for (const line of proseLines(paragraphs)) {
    const trimmed = line.text.trim();
    const narrative = stripQuoted(trimmed).trim();
    const narrativeLen = visibleLength(narrative);
    if (narrativeLen === 0) continue;

    if (first === null) first = line.paragraph;
    bodyChars += narrativeLen;
    functionHits += countTerms(narrative, LOW_CONNECTIVE_FUNCTION_TERMS);
    plainHits += countTerms(narrative, LOW_CONNECTIVE_PLAIN_TERMS);

    for (const sentence of splitSentences(narrative)) {
      const len = visibleLength(sentence);
      if (len === 0) continue;
      sentences.push(len);
      if (len <= 12 && samples.length < 6) samples.push(sentence);
    }
  }

  if (bodyChars < LOW_CONNECTIVE_MIN_CHARS || sentences.length === 0) return [];
  if ((functionHits / bodyChars) * 1000 >= LOW_CONNECTIVE_FUNCTION_PER_KILO) return [];
  if ((plainHits / bodyChars) * 1000 >= LOW_CONNECTIVE_PLAIN_PER_KILO) return [];
  const longRatio = sentences.filter((len) => len >= LOW_CONNECTIVE_LONG_SENTENCE_CHARS).length / sentences.length;
  if (longRatio >= LOW_CONNECTIVE_LONG_SENTENCE_RATIO) return [];
  return [{ paragraph: first ?? 1, excerpt: compact(samples.join(' | ')), count: sentences.length }];
}

/** 抽象总结复读：命运/棋局/这一刻终于明白/才刚刚开始 等作者总结 */
export function findAbstractSummaryTic(paragraphs: readonly string[]): AdvisoryHit[] {
  let hits = 0;
  let narrativeChars = 0;
  let first: number | null = null;
  const samples: string[] = [];

  for (const line of narrativeLines(paragraphs)) {
    const narrative = stripQuoted(line.text.trim());
    narrativeChars += visibleLength(narrative);

    for (const pattern of ABSTRACT_SUMMARY_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(narrative)) !== null) {
        hits += 1;
        if (first === null) first = line.paragraph;
        const sample = compact(match[0]);
        if (samples.length < 6 && !samples.includes(sample)) samples.push(sample);
      }
    }
  }

  if (narrativeChars === 0 || hits < ABSTRACT_SUMMARY_MIN_HITS) return [];
  if ((hits / narrativeChars) * 1000 < ABSTRACT_SUMMARY_PER_KILO) return [];
  return [{ paragraph: first ?? 1, excerpt: compact(samples.join(' | ')), count: hits }];
}

/**
 * 引号强调滥用（advisory）。
 *
 * 判据：叙述层 1-4 字成对引号片段 ≥3 处。
 *
 * ⚠ 排除项（照搬，缺一条误报就上来）：
 *   - 【】系统面板载体
 *   - 引语动词（说/道/问/喊…）前 6 字 / 后 3 字邻接的极短台词
 *   - 引号内含句读的（那是台词/播报，不是强调）
 *   - 引号外无叙述的行（独立台词/弹幕流/拟声词连发）
 *   - 引号套引号（台词内强调属于角色语言）
 */
export function findQuoteEmphasisTic(paragraphs: readonly string[]): AdvisoryHit[] {
  let hits = 0;
  let first: number | null = null;
  const samples: string[] = [];

  for (const line of proseLines(paragraphs)) {
    const trimmed = line.text.trim();
    if (visibleLength(stripQuoted(trimmed)) === 0) continue;
    const ranges = quotedRanges(line.text);

    for (const [start, end] of ranges) {
      if (line.text[start] === '【') continue;
      if (ranges.some(([s2, e2]) => s2 <= start && end <= e2 && (s2 !== start || e2 !== end))) continue;
      const inner = line.text.slice(start + 1, end - 1);
      const visible = visibleLength(inner);
      if (visible < 1 || visible > QUOTE_EMPHASIS_MAX_VISIBLE) continue;
      if (/[。！？!?…，,；;：:]/.test(inner)) continue;
      const before = line.text.slice(Math.max(0, start - 6), start);
      const after = line.text.slice(end, end + 3);
      if (QUOTE_EMPHASIS_SPEECH_VERB_PATTERN.test(before) || QUOTE_EMPHASIS_SPEECH_VERB_PATTERN.test(after)) continue;
      hits += 1;
      if (first === null) first = line.paragraph;
      if (samples.length < 6 && !samples.includes(inner)) samples.push(inner);
    }
  }

  if (hits < QUOTE_EMPHASIS_MIN_HITS) return [];
  return [{ paragraph: first ?? 1, excerpt: compact(samples.join(' ')), count: hits }];
}

/** 供测试与文档使用的规则元数据（14 类 advisory） */
export const ADVISORY_RULES = [
  { code: 'long_paragraph', source: 'long-paragraph', scope: 'paragraph' },
  { code: 'formulaic_parallelism', source: 'formulaic-parallelism', scope: 'paragraph' },
  { code: 'action_list_tic', source: 'action-list-tic', scope: 'paragraph' },
  { code: 'period_stutter', source: 'period-stutter', scope: 'paragraph' },
  { code: 'micro_action_tic', source: 'micro-action-tic', scope: 'document' },
  { code: 'stock_reaction_tic', source: 'stock-reaction-tic', scope: 'document' },
  { code: 'cliche_density_tic', source: 'cliche-density-tic', scope: 'document' },
  { code: 'metaphor_density_tic', source: 'metaphor-density-tic', scope: 'document' },
  { code: 'reasoning_chain_tic', source: 'reasoning-chain-tic', scope: 'document' },
  { code: 'system_notice_formality_tic', source: 'system-notice-formality-tic', scope: 'document' },
  { code: 'overcompressed_prose_tic', source: 'overcompressed-prose-tic', scope: 'document' },
  { code: 'low_connective_density_tic', source: 'low-connective-density-tic', scope: 'document' },
  { code: 'abstract_summary_tic', source: 'abstract-summary-tic', scope: 'document' },
  { code: 'quote_emphasis_tic', source: 'quote-emphasis-tic', scope: 'document' },
] as const;

export type AdvisoryRuleCode = (typeof ADVISORY_RULES)[number]['code'];
