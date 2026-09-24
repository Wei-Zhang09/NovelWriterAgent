/**
 * 时间线构建器（P0-5）。
 *
 * ## 为什么需要「解析展示时间」这一层
 *
 * 提示词给的验收用例是：
 *
 * > ch12 21:30 离开医院、ch13 21:20 还在医院 → Commit 前必须能发现
 *
 * 要发现它，两个事件的故事时间必须**可比较**。而模型填 `storyTimeValue`
 * 的可靠性很差 —— 这与 P0-4 实测的「模型给不出可靠的字偏移」是同一类问题：
 * 模型擅长**引用**（这里是"21:30"这样的展示文本），不擅长**计算**（把它变成 21.5）。
 *
 * 所以分工与 P0-4 一致：
 * - 模型提供 `storyTimeValue` + `storyTimeUnit`（能填就填，优先采用）
 * - 填不出来时，**代码**从 `storyTimeDisplay` 里解析出可比较的小时数
 *
 * ⚠ 解析是**有界**的：只认几种明确格式，认不出就如实标"不可比较"，
 *   绝不猜一个值 —— 猜出来的时间线会让检查器报出假冲突。
 *
 * ## ⚠ 「几点几分」没有日期，这件事必须说清
 *
 * "21:30" 本身不含日期。ch12 与 ch13 若是同一夜的连续场景，
 * 直接比 21.5 与 21.33 正是验收用例想要的；但若 ch12 与 ch40 各是不同日子，
 * 直接比就会**误报**。
 *
 * 处理方式：解析出的小时数带 `dayUnknown` 标记，检查器只对
 * **章号相近（同章或相邻章）** 的事件使用这种时间做顺序判断，
 * 其余情况如实计入"不可比较"。这个取舍写在 checker 里，见其注释。
 */
import type { ProposedTimelineEvent } from '@nwa/shared';
import { parseDisplayTime } from './timeline-types.js';
import type { CreateTimelineEventInput } from '@nwa/storage';

export interface BuildEventInput {
  readonly proposalId: string;
  readonly chapterNumber: number;
  readonly event: ProposedTimelineEvent;
  readonly index: number;
  /** 代码解析出的引文位置（P0-4 结论：模型给的字偏移不可靠） */
  readonly span?: { readonly start: number; readonly end: number };
  readonly evidenceId?: string;
  readonly characters?: readonly string[];
  readonly location?: string;
  readonly narrativeMode?: string;
}

/**
 * 把一条提议事件转成可写入的记录。
 *
 * ⚠ 故事时间的取值顺序：
 *   1. 模型给了 `storyTimeValue` + `storyTimeUnit` → 直接用（最可信）
 *   2. 否则从 `storyTimeDisplay` 解析
 *   3. 都没有 → `storyTimeValue: null`（如实标"不可比较"，不填默认值）
 *
 * 返回 null 表示缺引文位置（不可回溯），调用方应跳过并报告。
 */
export function buildTimelineEvent(
  input: BuildEventInput,
): Omit<CreateTimelineEventInput, 'bookId'> | null {
  if (!input.span) return null;
  const ev = input.event;

  let value: number | null = ev.storyTimeValue ?? null;
  let unit: string | null = ev.storyTimeUnit ?? null;
  let timeSource: 'model' | 'parsed-display' | 'none' =
    value !== null && unit !== null ? 'model' : 'none';

  if (timeSource === 'none') {
    const parsed = parseDisplayTime(ev.storyTimeDisplay);
    if (parsed) {
      // ⚠ 有日期信息 → 用"第N天+钟点"的总小时数（绝对可比）
      //   没有日期 → 用一天内小时数，并标 dayUnknown 供检查器限制比较范围
      value = parsed.absoluteHours ?? parsed.hoursInDay;
      unit = 'hour';
      timeSource = 'parsed-display';
    }
  }

  return {
    id: `te_${input.proposalId}_${input.index}`,
    title: ev.title,
    description: ev.description,
    storyTimeValue: value,
    storyTimeUnit: unit,
    storyTimeDisplay: ev.storyTimeDisplay ?? null,
    narrativeChapter: input.chapterNumber,
    narrativeOffset: input.span.start,
    importance: ev.importance ?? 1,
    data: {
      quote: ev.quote,
      quoteStart: input.span.start,
      quoteEnd: input.span.end,
      ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
      ...(input.characters && input.characters.length > 0
        ? { characters: input.characters }
        : {}),
      ...(input.location ? { location: input.location } : {}),
      ...(input.narrativeMode ? { narrativeMode: input.narrativeMode } : {}),
      // ⚠ 时间来源必须记下来：「模型给的」和「代码从文本解析的」可信度不同，
      //   出问题时第一个要问的就是这个。
      timeSource,
      ...(timeSource === 'parsed-display'
        ? { timeDayUnknown: parseDisplayTime(ev.storyTimeDisplay)?.dayUnknown ?? false }
        : {}),
    },
  };
}
