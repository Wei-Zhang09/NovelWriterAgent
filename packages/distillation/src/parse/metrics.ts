/**
 * 机械指标计算（施工文档 §19 的 pacing / prose）
 *
 * ## ⚠ 为什么这些**必须**由代码算，不接受 LLM 输出
 *
 * §19 的 SceneAnnotation 里混了两类字段。`pacing` 与 `prose`
 * 有确定定义（段落密度、对话比、句长均值），是**可算的**。
 *
 * 让模型去"估"这些数字有两个后果：
 *   1. 引入不可复现的误差 —— 同一段文本两次调用得到不同数字
 *   2. 更糟的是**看起来合理但实际不符** —— 模型给出的
 *      "对话占比 0.4"可能与真实值差很远，而统计时无法察觉
 *
 * 因此这些字段一律代码计算，且 LLM 输出契约里刻意不含它们
 * （见 annotation.ts 的 SceneSemanticSchema）。
 *
 * ## 中文句子的切分
 *
 * 中文没有空格分词，句号/问号/感叹号/省略号才是句子边界。
 * ⚠ 省略号在中文里常表示"话没说完"，仍算句末（实测网文
 *   大量使用"……"作为停顿与句末）。
 */
import type { Paragraph } from './scene-segmenter.js';

/** 句末标点（中文 + 英文） */
const SENTENCE_END = /[。！？…；;.!?]+/;

/** 内部独白标记（心里想 —— 用引号或"心想/暗想/觉得"等引导） */
const INTERNAL_MARKERS = /(心想|暗想|心中|心里|脑海|思忖|琢磨|觉得|意识到|暗忖|思量)/;

/**
 * 切句（保留标点）。
 *
 * ⚠ 连续省略号（"……"）算一个句末，不拆成多个空句。
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  // ⚠ 必须记"上一个字符"，不能用 buf.endsWith 判断：
  //   第一个「…」已经触发切分并清空 buf，第二个「…」看不到前一个。
  //   实测该 bug 把「他犹豫了一下……然后点头。」拆成
  //   ['他犹豫了一下…', '…', '然后点头。'] —— 中间是空句，污染句长统计。
  let prev = '';
  for (const ch of text) {
    const isEllipsisContinuation = ch === '…' && prev === '…';
    buf += ch;
    if (SENTENCE_END.test(ch) && !isEllipsisContinuation) {
      const t = buf.trim();
      if (t.length > 0) out.push(t);
      buf = '';
    }
    prev = ch;
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

export interface ProseMetrics {
  readonly sentenceLengthMean: number;
  readonly dialogueRatio: number;
  readonly descriptionRatio: number;
  readonly internalMonologueRatio: number;
}

export interface PacingMetrics {
  readonly paragraphDensity: number;
  readonly dialogueRatio: number;
  readonly speed: number;
}

/** 段落总字符数 */
function totalChars(paras: readonly Paragraph[]): number {
  return paras.reduce((s, p) => s + p.text.length, 0);
}

/** 对话段字符数 */
function dialogueChars(paras: readonly Paragraph[]): number {
  return paras.filter((p) => p.isDialogue).reduce((s, p) => s + p.text.length, 0);
}

/**
 * 计算 prose 指标。
 *
 * ⚠ `descriptionRatio` 与 `internalMonologueRatio` 是**近似**：
 *   中文没有可靠的形态学标记来区分"叙述"与"描写"，
 *   因此用启发式（含感官/形容词密度、内心独白引导词）。
 *   返回的是**相对指标**，用于跨场景比较，不宜当作绝对真值。
 *   这一点必须在文档里说明，否则下游会把它当精确测量。
 */
export function computeProse(paras: readonly Paragraph[]): ProseMetrics {
  const total = totalChars(paras);
  if (total === 0) {
    return {
      sentenceLengthMean: 0,
      dialogueRatio: 0,
      descriptionRatio: 0,
      internalMonologueRatio: 0,
    };
  }

  const sentences = paras.flatMap((p) => splitSentences(p.text));
  const sentenceLengthMean =
    sentences.length > 0
      ? Number((sentences.reduce((s, x) => s + x.length, 0) / sentences.length).toFixed(2))
      : 0;

  const dChars = dialogueChars(paras);
  const dialogueRatio = Number((dChars / total).toFixed(4));

  // 内心独白：含引导词且非对话的段落
  const innerChars = paras
    .filter((p) => !p.isDialogue && INTERNAL_MARKERS.test(p.text))
    .reduce((s, p) => s + p.text.length, 0);
  const internalMonologueRatio = Number((innerChars / total).toFixed(4));

  // 描写：非对话、非内心独白的部分（近似）
  const descChars = total - dChars - innerChars;
  const descriptionRatio = Number((Math.max(0, descChars) / total).toFixed(4));

  return { sentenceLengthMean, dialogueRatio, descriptionRatio, internalMonologueRatio };
}

/**
 * 计算 pacing 指标。
 *
 * ⚠ `speed` 是一个**合成指标**（0~1），定义为：
 *   对话占比高 + 段落短 → 快。
 *   这是启发式，用于跨场景/跨作品比较，不是物理量。
 *   公式写在代码里便于复核：
 *     speed = 0.6 × dialogueRatio + 0.4 × (1 − 归一化段落长度)
 */
export function computePacing(paras: readonly Paragraph[]): PacingMetrics {
  const total = totalChars(paras);
  if (total === 0 || paras.length === 0) {
    return { paragraphDensity: 0, dialogueRatio: 0, speed: 0 };
  }

  const paragraphDensity = Number(((paras.length / total) * 1000).toFixed(2));
  const dialogueRatio = Number((dialogueChars(paras) / total).toFixed(4));

  // 归一化段落长度：以 100 字为"长段落"基准（中文网文常见上限）
  const meanParaLen = total / paras.length;
  const lenFactor = Math.min(1, meanParaLen / 100);
  const speed = Number((0.6 * dialogueRatio + 0.4 * (1 - lenFactor)).toFixed(4));

  return { paragraphDensity, dialogueRatio, speed };
}

/** 场景文本拼接（供 LLM 标注使用） */
export function paragraphsToText(paras: readonly Paragraph[]): string {
  return paras.map((p) => p.text).join('\n\n');
}
