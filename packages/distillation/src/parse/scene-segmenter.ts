/**
 * 场景切分（施工文档 §18）
 *
 * ## 场景边界依据（§18 列出六项）
 *
 *   时间变化 / 地点变化 / POV 变化 / 主要人物群变化 / 事件变化 / 冲突变化
 *
 * ## ⚠ 为什么第一版只做规则、不做 LLM
 *
 * 实测《百岁之好》第 20 章 85 段，全章就是一个连续场景。
 * 若用 LLM 逐段判断边界，代价是"每章一次模型调用 × 5000 章"，
 * 而收益不确定 —— 规则能识别的显式标记（"第二天""教室里"）
 * 已经覆盖了绝大多数真实切换。
 *
 * 因此分层：
 *   1. **规则层**（本模块）：显式标记 + 段落统计。确定性、免费、可复现
 *   2. **LLM 层**（可选）：只在规则**不确定**时介入（见 `uncertain` 标记）
 *
 * 这与 ADR-0007 的 Naturalness 双层设计同一思路：
 * 能机械判定的不交给模型。
 *
 * ## 为什么"不猜"很重要
 *
 * 切分错误是**静默的**：后续标注与模式挖掘都基于错误边界工作，
 * 每个环节单独看都正常。因此宁可少切（合并场景）也不要错切 ——
 * 少切只是粒度粗，错切会造出**不存在的场景转移**，
 * 让模式挖掘学出"这种转折很常见"的伪规律。
 */
import type { BoundaryReason } from '@nwa/shared';

/** 段落 */
export interface Paragraph {
  readonly index: number;
  readonly text: string;
  /** 是否对话段（以引号开头或整段是引号内容） */
  readonly isDialogue: boolean;
}

/** 切分出的场景 */
export interface SegmentedScene {
  readonly index: number;
  readonly paragraphs: readonly Paragraph[];
  /** 起始段落在章内的序号 */
  readonly startParagraph: number;
  /** 结束段落在章内的序号（不含） */
  readonly endParagraph: number;
  /** 切分依据 */
  readonly reason: BoundaryReason;
  /** 触发切分的证据文本（便于人工核对） */
  readonly evidence: string;
  /**
   * 规则对该边界是否**不确定**。
   *
   * ⚠ 这是 LLM 层介入的入口：只有 uncertain 的边界才值得花模型调用。
   *   全章都不确定时（如通篇无显式标记），LLM 层可做整体切分。
   */
  readonly uncertain: boolean;
}

// ── 时间标记（§18「时间变化」） ──
//
// ⚠ 只列**明确的时段推进词**。实测数据里
//   "此时"（38 次）多是同场景内的叙述延续，不是切换，
//   因此不列入。
const TIME_MARKERS: readonly RegExp[] = [
  /^(第[二三四五六七八九十]+天|翌日|次日|隔天|隔日)/,
  /^(第二天|转天)/,
  /^(当晚|那天晚上|夜里|深夜|凌晨|天亮|清晨|早上|早晨)/,
  /^(中午|正午|下午|傍晚|黄昏|晚上)/,
  /^(次日一早|第二天一早|第二天早上)/,
  /^(片刻后|一会儿后|不久后|半小时后|一小时后)/,
  // ⚠ 实测补入（前 40 章各 12 处）：这些是**真正的场景过渡**，
  //   如「没过多久，客厅传来压抑的争吵声。」—— 从"回家路上"切到"客厅争吵"。
  //
  //   ⚠ 但"转折词"（然而/于是/不过）**不列入** —— 实测 88 处，
  //     绝大多数是同场景内的叙述转折，列入会大量误切。
  /^(没过多久|不一会儿|不多时|过了一会儿|稍后|随即)/,
  /^(此时|这时|这时候|这个时候)(距离|临近|正是|已经)/,
  /^(过了[一二三四五六七八九十两]?[天年月日]|几天后|一周后|一个月后|两个月后|半年后|多年后|三年后)/,
  /^(与此同时|同一时间|另一边|另一头|另一处|而此刻|此时.*(在|于))/,
];

// ── 地点标记（§18「地点变化」） ──
//
// ⚠ 用具体地点词而非泛化的"在…"，否则误判率过高。
const PLACE_MARKERS: readonly RegExp[] = [
  // ⚠ 地点词后必须紧跟"到达/进入/回到"类动词，或直接是"在某地"的定位句。
  //
  //   实测踩到：「路上有流浪汉看着她，流里流气地笑了。」
  //   只是句首含"路上"，被误判为场景切换 —— 而它其实是同场景内的
  //   叙述延续（前一场景就在这条路上）。
  //
  //   判据收紧为两种形态：
  //     1) 地点 + 移动动词：「教室里响起…」「回到宿舍…」
  //     2) 地点 + 存在/状态句：「客厅里只有…」「操场上满是…」
  /^(教室|宿舍|食堂|图书馆|操场|校门口|办公室|会议室|走廊|楼梯|天台|阳台|客厅|卧室|厨房|书房|餐厅|院子|商场|超市|咖啡厅|酒吧|医院|公司|学校|老城区|火车站|机场|车站|码头|公园|广场)(里|内|中|上|外|前|后)?[^，。]{0,6}(响起|只有|满是|空无|坐了|站了|挤满|传来|飘|摆|放|灯火)/,
  /^(他|她|两人|众人)?(回到|走进|走进|来到|抵达|赶往|跑到|冲向|踏入|推开|离开|走出|出了)[^，。]{0,10}(教室|宿舍|食堂|图书馆|操场|家|房间|办公室|医院|公司|学校|车站|门口)/,
  /^(第[二三四五六七八九十]+天|翌日|次日)[^，。]{0,12}(在|到|去|来)[^，。]{0,10}(学校|教室|宿舍|公司|医院|家)/,
];

// ── POV / 视角切换标记（§18「POV 变化」） ──
const POV_MARKERS: readonly RegExp[] = [
  /^(而(此时|此刻)?[^，。]{0,8}(则|却|也))/,
  /^(另一边|另一头)[^，。]{0,10}(则|正|在)/,
];

// ── 场景分隔符（源文本显式标记） ──
const SEPARATORS: readonly RegExp[] = [
  /^[※＊*]{3,}$/,
  /^[—\-=]{4,}$/,
  /^[（(]?[上下]?[一二三四五六七八九十\d]+[）)]?$/,
];

/** 判断段落是否为对话 */
export function isDialogueParagraph(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // 以引号开头，或整段被引号包裹
  return /^[“"「『]/.test(t);
}

/** 把正文切成段落 */
export function toParagraphs(text: string): Paragraph[] {
  const raw = text.split(/\n\s*\n/);
  const out: Paragraph[] = [];
  let idx = 0;
  for (const r of raw) {
    const t = r.trim();
    if (t.length === 0) continue;
    out.push({ index: idx++, text: t, isDialogue: isDialogueParagraph(t) });
  }
  return out;
}

interface MarkerHit {
  readonly reason: BoundaryReason;
  readonly evidence: string;
}

/** 检测段落开头的切换标记 */
function detectMarker(text: string): MarkerHit | null {
  const t = text.trim();

  for (const re of SEPARATORS) {
    if (re.test(t)) return { reason: 'SEPARATOR', evidence: t.slice(0, 20) };
  }
  for (const re of TIME_MARKERS) {
    if (re.test(t)) return { reason: 'TIME_SHIFT', evidence: t.slice(0, 20) };
  }
  for (const re of PLACE_MARKERS) {
    if (re.test(t)) return { reason: 'PLACE_SHIFT', evidence: t.slice(0, 20) };
  }
  for (const re of POV_MARKERS) {
    if (re.test(t)) return { reason: 'POV_SHIFT', evidence: t.slice(0, 20) };
  }
  return null;
}

export interface SegmentOptions {
  /**
   * 合并过短的场景（段数下限，默认 3）。
   *
   * ⚠ 为什么需要：实测网文里"第二天，他去了学校。"这类
   *   单段过渡句会被误判为独立场景。合并后场景才有
   *   足够的文本支撑语义标注。
   */
  readonly minParagraphs?: number;
  /** 最大场景段数（默认 40）—— 超过则强制再切，避免一个场景吃掉整章 */
  readonly maxParagraphs?: number;
}

/**
 * 把一个章节切成场景。
 *
 * ⚠ 规则层只做"有明确标记"的切分；无标记时不切（整章一个场景）。
 *   这是"宁少切不错切"的落地 —— 见文件头说明。
 */
export function segmentScenes(
  chapterText: string,
  opts: SegmentOptions = {},
): SegmentedScene[] {
  const minParas = opts.minParagraphs ?? 3;
  const maxParas = opts.maxParagraphs ?? 40;
  const paras = toParagraphs(chapterText);

  if (paras.length === 0) return [];

  // ── 1) 找候选边界 ──
  interface Cut {
    readonly at: number;
    readonly reason: BoundaryReason;
    readonly evidence: string;
    readonly uncertain: boolean;
  }
  const cuts: Cut[] = [];
  for (let i = 1; i < paras.length; i++) {
    const hit = detectMarker(paras[i]!.text);
    if (hit) {
      cuts.push({
        at: i,
        reason: hit.reason,
        evidence: hit.evidence,
        // 时间/地点标记较可靠；POV 与事件类较模糊
        uncertain: hit.reason === 'POV_SHIFT',
      });
    }
  }

  // ── 2) 按 minParas 合并过短段 ──
  //
  // ⚠ 只合并"边界后段数不足"的情况，不移动边界位置 ——
  //   移动会改变切分语义（切在别处意味着另一套场景划分）。
  const kept: Cut[] = [];
  let lastCut = 0;
  for (const c of cuts) {
    if (c.at - lastCut < minParas) continue; // 该段太短，不切
    kept.push(c);
    lastCut = c.at;
  }

  // ── 3) 按 maxParas 强制再切（避免一个场景吃掉整章）──
  //
  // ⚠ 实测踩到两个问题：
  //   a) 早先无条件 `start += maxParas` 会切在任意位置 → 造出 12 字碎片场景
  //   b) 若全章**无任何标记**（kept 为空），循环根本不执行 → 整章一个场景，
  //      maxParas 形同虚设（实测 60 段连续叙述完全不切）
  //
  //   现在：先按标记切，再对每个区间检查长度，
  //   超长则在区间内找**最近的标记**作切点；找不到才等距切。
  const cutsForBound: Cut[] = [...kept];
  // 逐个区间（含末区间）检查长度
  const segments: { start: number; end: number }[] = [];
  let segStart = 0;
  for (const c of cutsForBound) {
    segments.push({ start: segStart, end: c.at });
    segStart = c.at;
  }
  segments.push({ start: segStart, end: paras.length });

  const forced: Cut[] = [];
  for (const seg of segments) {
    let start = seg.start;
    while (seg.end - start > maxParas) {
      const target = start + maxParas;
      // 在 (start, seg.end) 内找距 target 最近的标记段
      let found = -1;
      let bestDist = Number.MAX_SAFE_INTEGER;
      for (let j = start + minParas; j < seg.end; j++) {
        if (detectMarker(paras[j]!.text)) {
          const d = Math.abs(j - target);
          if (d < bestDist) {
            bestDist = d;
            found = j;
          }
        }
      }
      const at = found >= 0 ? found : target;
      if (at - start < minParas) break; // 防碎片
      forced.push({
        at,
        reason: 'EVENT_SHIFT',
        evidence:
          found >= 0
            ? `（就近标记：${paras[at]!.text.slice(0, 16)}）`
            : `（等距切分，超 ${maxParas} 段）`,
        uncertain: true,
      });
      start = at;
    }
  }

  const bounded: Cut[] = [...cutsForBound, ...forced].sort((a, b) => a.at - b.at);

  // ── 4) 组装场景 ──
  const scenes: SegmentedScene[] = [];
  let start = 0;
  const bounds = [...bounded.map((b) => b), { at: paras.length, reason: 'CHAPTER_START' as BoundaryReason, evidence: '', uncertain: false }];

  for (let k = 0; k < bounds.length; k++) {
    const b = bounds[k]!;
    if (b.at <= start && k < bounds.length - 1) continue;
    const slice = paras.slice(start, b.at);
    if (slice.length === 0) continue;
    scenes.push({
      index: scenes.length,
      paragraphs: slice,
      startParagraph: start,
      endParagraph: b.at,
      reason: k === 0 ? 'CHAPTER_START' : bounds[k - 1]!.reason,
      evidence: k === 0 ? '（章首）' : bounds[k - 1]!.evidence,
      uncertain: k === 0 ? false : bounds[k - 1]!.uncertain,
    });
    start = b.at;
  }

  return scenes;
}
