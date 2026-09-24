/**
 * 时间线契约（P0-5）。
 *
 * ## 为什么表里有两套顺序
 *
 * `timeline_events` 同时有：
 * - `story_time_value` / `story_time_unit` —— **故事时间**（故事世界里何时发生）
 * - `narrative_chapter` / `narrative_offset` —— **叙述顺序**（读者在第几章第几段看到）
 *
 * 两者不等价，而且**不等价是常态**：倒叙、插叙、预告都会让故事时间与叙述
 * 顺序相反。这正是时间线不能简化成一个排序字段的原因。
 *
 * ⚠ 因此「故事时间随叙述顺序倒退」**不能**直接判为错误 ——
 *   那会把每一个闪回都报成缺陷。必须结合**叙述模式**判断：
 *   模型显式标注（`narrativeMode`）或正文里的闪回信号。
 *
 * ## 单位换算的口径
 *
 * 比较只用 `story_time_value`，但它必须换算到同一基准才可比。
 * `month` / `year` 取 30 天 / 365 天（约定近似），**只用于排序比较**，
 * 不用于任何展示给读者的绝对日期 —— 那需要 `story_time_display`。
 * 单位不认识就返回 null，如实报「不可比较」，不猜。
 */
import type { TimelineEventRow } from '@nwa/storage';
import type { IssueSeverity } from '../continuity/checker.js';

/** 叙事模式 */
export const NARRATIVE_MODES = ['FOREGROUND', 'FLASHBACK', 'ANTICIPATION'] as const;
export type NarrativeMode = (typeof NARRATIVE_MODES)[number];

/**
 * 时间单位 → 小时。
 *
 * ⚠ month / year 是约定近似（30 / 365 天）。做顺序比较够用，
 *   但**不能**当成真实历法 —— 需要精确日期时用 `storyTimeDisplay`。
 */
const UNIT_TO_HOURS: Readonly<Record<string, number>> = {
  minute: 1 / 60,
  hour: 1,
  day: 24,
  week: 168,
  month: 720,
  year: 8760,
};

export const TIME_UNITS = Object.keys(UNIT_TO_HOURS);

/**
 * 换算到小时。
 *
 * 返回 null 表示**不可比较**（单位不认识 / 值缺失）。
 * 调用方必须把 null 当作「无法判断」而不是「相等」。
 */
export function toHours(value: number | null, unit: string | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (unit === null) return null;
  const k = UNIT_TO_HOURS[unit.trim().toLowerCase()];
  if (k === undefined) return null;
  return value * k;
}

/**
 * 闪回信号词表（**有界**）。
 *
 * ⚠ 落在词表外的闪回检测不到 —— 刻意取舍：宁可漏判（多报一次 WARNING）
 *   也不误判。词表只收**强信号**：出现它们时读者基本能确定在回忆里。
 *   弱词（「当时」「那时」）不收 —— 它们在正常叙述里也常见，
 *   收了会让"闪回豁免"形同虚设。
 */
const FLASHBACK_MARKERS = [
  '回忆',
  '闪回',
  '回想',
  '倒叙',
  '追溯',
  '从前',
  '当年',
  '多年前',
  '数年前',
  '记忆中',
  '他记得',
  '她记得',
  '记得那',
] as const;

/** 「N 分钟/小时/天/月/年前」这种显式回溯短语 */
const BACKTRACK_PATTERN =
  /(若干|几|数|[一二三四五六七八九十百千万]+)(分钟|小时|时辰|天|日|周|个月|月|年)前/;

/**
 * 判断一段文字是否带闪回信号。
 *
 * 只看**事件自己的文字**（标题 + 描述 + 引文）—— 不去读全章正文。
 * 读全章会把"章内别处提到回忆"算到每个事件头上，让豁免变成普遍通过。
 */
export function hasFlashbackSignal(...texts: readonly (string | null | undefined)[]): boolean {
  const s = texts.filter((t): t is string => typeof t === 'string' && t.length > 0).join('\n');
  if (s.length === 0) return false;
  if (BACKTRACK_PATTERN.test(s)) return true;
  return FLASHBACK_MARKERS.some((m) => s.includes(m));
}

/** 死亡信号词表（**有界**，同上有意取舍） */
const DEATH_MARKERS = ['身亡', '死了', '死去', '殒命', '阵亡', '去世', '咽气', '断气', '丧命'] as const;

/** 判断一段文字是否描述死亡 */
export function hasDeathSignal(...texts: readonly (string | null | undefined)[]): boolean {
  const s = texts.filter((t): t is string => typeof t === 'string' && t.length > 0).join('\n');
  if (s.length === 0) return false;
  return DEATH_MARKERS.some((m) => s.includes(m));
}

/** 时间线问题代码 */
export const TIMELINE_ISSUE_CODES = [
  /** 故事时间相对叙述顺序倒退，且没有闪回信号 */
  'TIME_INVERSION',
  /** 同一角色在同一故事时刻出现在两个不同地点 */
  'CHARACTER_DOUBLE_BOOKED',
  /** 角色在死亡之后仍有行动 */
  'ACT_AFTER_DEATH',
  /** 时间不可比较（单位不认识 / 缺值）—— INFO，不是缺陷 */
  'TIME_UNCOMPARABLE',
] as const;
export type TimelineIssueCode = (typeof TIMELINE_ISSUE_CODES)[number];

export interface TimelineIssue {
  readonly id: string;
  readonly code: TimelineIssueCode;
  readonly severity: IssueSeverity;
  /** 可读说明（回答「为什么这是问题」） */
  readonly message: string;
  /** 涉及的事件 id（顺序有意义：前者在叙述上先出现） */
  readonly eventIds: readonly string[];
  /** 涉及的章节号 */
  readonly chapters: readonly number[];
  /** 相关实体（角色名 / 地点），便于定位 */
  readonly entityRefs?: readonly string[];
}

/**
 * `timeline_events` 行。
 *
 * ⚠ 直接复用 `@nwa/storage` 的定义，**不在这里重复声明** ——
 *   两份结构体迟早漂移，而漂移的表现是"某一列读出来是 undefined"，
 *   查起来很远。
 */
export type TimelineEventRecord = TimelineEventRow;

/** `data_json` 里我们写入的附加信息 */
export interface TimelineEventData {
  readonly quote?: string;
  readonly quoteStart?: number;
  readonly quoteEnd?: number;
  readonly evidenceId?: string;
  /** 涉及角色名 */
  readonly characters?: readonly string[];
  /** 地点 */
  readonly location?: string;
  /** 叙事模式（模型标注；缺省视为 FOREGROUND） */
  readonly narrativeMode?: NarrativeMode;
  /** 故事时间的来源：模型给的 / 代码从展示文本解析的 / 没有 */
  readonly timeSource?: 'model' | 'parsed-display' | 'none';
  /** ⚠ true = 只知道钟点不知道哪天（从 "21:30" 这种文本解析而来） */
  readonly timeDayUnknown?: boolean;
}

/** 解析后的事件（供 builder / checker 使用，避免各自解析 JSON） */
export interface ResolvedTimelineEvent {
  readonly id: string;
  readonly chapter: number | null;
  readonly offset: number | null;
  readonly title: string;
  readonly description: string;
  readonly importance: number;
  /** 换算到小时的绝对故事时间；null = 不可比较 */
  readonly storyHours: number | null;
  readonly storyDisplay: string | null;
  readonly storyUnit: string | null;
  readonly characters: readonly string[];
  readonly location: string | null;
  readonly narrativeMode: NarrativeMode;
  /** 文字里是否带闪回信号 */
  readonly flashbackSignal: boolean;
  /**
   * ⚠ true = 故事时间只知道"一天内的几点"，不知道是哪天。
   *
   * 含义：这个时间**只能与章号相近的事件比较**。
   * 拿 ch12 的 "21:30" 与 ch40 的 "21:20" 比，会得出"倒退 10 分钟"的
   * 假冲突 —— 实际它们可能相隔一个月。检查器必须限制比较范围。
   */
  readonly dayUnknown: boolean;
  readonly data: TimelineEventData;
}

/** 中文数字（只到几十，够表达钟点与"第N天"） */
const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 解析一个短数字（阿拉伯或中文，支持"十""二十""二十三"） */
export function parseSmallNumber(s: string): number | null {
  const t = s.trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (t.length === 0) return null;

  // 十 / 十三 / 二十 / 二十三
  if (t.includes('十')) {
    const [a, b] = t.split('十');
    const tens = a === '' ? 1 : (CN_DIGITS[a!] ?? null);
    if (tens === null) return null;
    const ones = b === '' || b === undefined ? 0 : (CN_DIGITS[b] ?? null);
    if (ones === null) return null;
    return tens * 10 + ones;
  }
  if (t.length === 1) return CN_DIGITS[t] ?? null;
  // 多字中文数字（一二三 → 逐位）只处理个位组合，超出范围返回 null
  return null;
}

/** 时段前缀 → 小时偏移（12 小时制 → 24 小时制） */
/**
 * 时段词 → 当天代表性小时数。
 *
 * ⚠ 这些值是**代表值**，不是精确钟点 —— 用途只有一个：
 *   让"同一天内的不同时段"能分出先后。
 *   原先清晨/傍晚都映射到 0/12 这种粗值，导致"第三天清晨"与
 *   "第三天傍晚"被算成同一时刻，先后永远判不出来。
 *   宁可粗糙也要**区分**，否则时间线检查等于没做。
 */
const PERIOD_OFFSET: Readonly<Record<string, number>> = {
  凌晨: 3,
  清晨: 5, 拂晓: 5, 黎明: 5, 破晓: 5,
  早上: 8, 早晨: 8, 天亮: 8, 大亮: 8,
  上午: 9,
  中午: 12, 正午: 12, 晌午: 12,
  下午: 14, 午后: 14,
  傍晚: 18, 黄昏: 18, 入夜: 18, 天黑: 18,
  晚上: 20,
  夜里: 22, 夜晚: 22, 深夜: 23,
};

/**
 * 属于"午后/夜晚"的时段词 —— 这些词后跟 1–11 点的钟点时要按 12 小时制加 12。
 *
 * ⚠ 与 PERIOD_OFFSET 分开是必要的：加了"清晨=5"之后，
 *   原先 `offset === 12` 的判定就失效了（"傍晚三点"会被算成 3 点）。
 */
const PM_PERIODS: readonly string[] = [
  '中午', '正午', '下午', '傍晚', '黄昏', '晚上', '夜里', '夜晚', '深夜',
];

export interface ParsedDisplayTime {
  /** 一天内的小时数（0–24，含小数） */
  readonly hoursInDay: number;
  /** 故事第几天（解析到才有；无日期信息时为 null） */
  readonly day: number | null;
  /** ⚠ true = 只知道钟点，不知道哪天 —— 比较时必须受限 */
  readonly dayUnknown: boolean;
  /** 换算到"第 N 天 + 钟点"的总小时数；dayUnknown 时为 null */
  readonly absoluteHours: number | null;
}

/**
 * 从展示文本解析时间（**有界**）。
 *
 * 支持：
 *   "21:30" / "21：30" / "21点30分" / "晚上九点半" / "下午3点"
 *   "第3天 21:30" / "第三天晚上九点" / "三天后的傍晚"
 *
 * 认不出返回 null（调用方据此标"不可比较"，不猜）。
 */
export function parseDisplayTime(display: string | null | undefined): ParsedDisplayTime | null {
  if (typeof display !== 'string' || display.trim().length === 0) return null;
  const s = display.trim();

  // ── 第 N 天 ──
  let day: number | null = null;
  const dayM = /第\s*([0-9一二三四五六七八九十两]+)\s*[天日]/.exec(s);
  if (dayM) day = parseSmallNumber(dayM[1]!);
  if (day === null) {
    const afterM = /([0-9一二三四五六七八九十两]+)\s*[天日]后/.exec(s);
    if (afterM) {
      const n = parseSmallNumber(afterM[1]!);
      if (n !== null) day = n; // "三天后" ≈ 第 3 天（近似，只用于排序）
    }
  }

  // ── 时段前缀（记住命中的词，后面判定上/下午要用）──
  let offset: number | null = null;
  let periodKey: string | null = null;
  for (const k of Object.keys(PERIOD_OFFSET)) {
    if (s.includes(k)) {
      offset = PERIOD_OFFSET[k]!;
      periodKey = k;
      break;
    }
  }

  // ── 钟点：HH:MM / H点M分 ──
  let hour: number | null = null;
  let minute = 0;

  const colonM = /(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(s);
  if (colonM) {
    hour = Number(colonM[1]);
    minute = Number(colonM[2]);
  } else {
    const dianM = /([0-9一二三四五六七八九十两]{1,3})\s*[点時时]/.exec(s);
    if (dianM) {
      hour = parseSmallNumber(dianM[1]!);
      const halfM = /[点時时]\s*半/.exec(s);
      if (halfM) minute = 30;
      else {
        const fenM = /([0-9一二三四五六七八九十两]{1,3})\s*分/.exec(s);
        if (fenM) minute = parseSmallNumber(fenM[1]!) ?? 0;
      }
    }
  }

  if (hour === null || hour < 0 || hour > 24 || minute < 0 || minute > 59) {
    // 只有"第N天"没有钟点 → 用**时段词**定位到当天的大致时刻。
    //
    // ⚠ 实测踩到的 bug：原先这里直接 `hoursInDay: 0` 返回，
    //   把时段词整个丢掉 —— 于是"第三天清晨"与"第三天傍晚"变成
    //   同一个时刻（都是第 3 天 0 点）。两者的先后关系因此永远判不出来，
    //   而这恰恰是时间线检查最该抓住的那类矛盾。
    //   没有时段词时才退回当天 0 点（粗粒度，够排序用）。
    const periodHour = offset ?? 0;
    if (day !== null) {
      return {
        hoursInDay: periodHour,
        day,
        dayUnknown: false,
        absoluteHours: (day - 1) * 24 + periodHour,
      };
    }
    // ⚠ 只有时段词（"雾气弥漫的清晨"、"午后云堆上来时"）→ **要**返回。
    //
    // 这条是被真机数据推翻后改的：我原先认为"不知道哪天就不能比较"，
    // 于是返回 null。但实测模型产出的时间几乎全是这种写法
    // （10 条事件里 0 条可比），时间线检查因此在真实数据上完全空转 ——
    // 而单元测试全绿（测试用的是"21:30"这种规整写法）。
    //
    // 正确做法与"只有钟点"完全一致：给出一天内的位置 + 标 dayUnknown，
    // 由检查器限制比较范围（同章或相邻章）。"清晨 < 午后"这种判断
    // 在相邻章内是有意义的。
    if (offset !== null) {
      return { hoursInDay: offset, day: null, dayUnknown: true, absoluteHours: null };
    }
    return null;
  }

  // 12 小时制换算：有"下午/傍晚/晚上"等前缀且小时 < 12 → 加 12
  if (periodKey !== null && PM_PERIODS.includes(periodKey) && hour < 12) {
    hour += 12;
  } else if (periodKey !== null && !PM_PERIODS.includes(periodKey) && hour === 12) {
    // "凌晨十二点" = 0 点（不是中午 12 点）
    hour = 0;
  }

  const hoursInDay = hour + minute / 60;
  if (day !== null) {
    return {
      hoursInDay,
      day,
      dayUnknown: false,
      absoluteHours: (day - 1) * 24 + hoursInDay,
    };
  }
  // ⚠ 没有日期 → 只能给出"一天内的小时数"，且必须标记 dayUnknown
  return { hoursInDay, day: null, dayUnknown: true, absoluteHours: null };
}

/**
 * 展示文本是否"只有钟点、没有日期"。
 *
 * ⚠ 只认能解析出钟点、且解析不出日期的文本。
 *   解析失败（"很久以后"）不算 —— 那种情况时间本来就不可比较，
 *   由 `storyHours === null` 处理，不该在这里冒充"钟点"。
 */
export function isClockOnlyDisplay(display: string | null): boolean {
  if (typeof display !== 'string' || display.trim().length === 0) return false;
  const s = display.trim();
  // 有日期信息 → 不是"只有钟点"
  if (/第\s*[0-9一二三四五六七八九十两]+\s*[天日]/.test(s)) return false;
  if (/[0-9一二三四五六七八九十两]+\s*[天日]后/.test(s)) return false;
  // 有钟点 → 是
  return /(\d{1,2})\s*[:：]\s*(\d{1,2})/.test(s) || /[0-9一二三四五六七八九十两]{1,3}\s*[点時时]/.test(s);
}

/** 解析一行 DB 记录 */
export function resolveEvent(row: TimelineEventRecord): ResolvedTimelineEvent {
  let data: TimelineEventData = {};
  if (row.data_json) {
    try {
      const v = JSON.parse(row.data_json) as unknown;
      if (v && typeof v === 'object') data = v as TimelineEventData;
    } catch {
      // ⚠ JSON 坏了按"没有附加信息"处理，但下面会把不可比较如实报出来，
      //   不会静默变成"这个事件没问题"。
      data = {};
    }
  }

  const chars = Array.isArray(data.characters)
    ? data.characters.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];

  const mode: NarrativeMode =
    data.narrativeMode && (NARRATIVE_MODES as readonly string[]).includes(data.narrativeMode)
      ? data.narrativeMode
      : 'FOREGROUND';

  // ⚠⚠ 故事时间的取值顺序（**实测校准**）：
  //
  //   1. 数值列 `story_time_value` + `story_time_unit`（若填了，最可信）
  //   2. 从展示文本 `story_time_display` 解析
  //
  // 为什么必须要有第 2 条：实测模型**几乎不填** `storyTimeValue`
  // （它只愿意照抄正文里的"21:30"），于是 17 条事件里 0 条可比 ——
  // 时间线检查在真实数据上完全空转，而单元测试全绿
  // （测试是我自己填的 value，模型不给）。
  // 这与 P0-4「模型给不出可靠字偏移」是同一类问题：模型擅长引用、不擅长计算。
  // 所以分工一致 —— 模型给原文，代码算数值。
  const numericHours = toHours(row.story_time_value, row.story_time_unit);
  const parsed = numericHours === null ? parseDisplayTime(row.story_time_display) : null;
  const storyHours = numericHours !== null ? numericHours : (parsed?.absoluteHours ?? null);
  // 只有钟点（无日期）时 hoursInDay 才是"一天内的几点"，
  // 检查器对这类值必须限制比较范围（见 CLOCK_ONLY_MAX_CHAPTER_GAP）
  const parsedClockOnly = parsed !== null && parsed.dayUnknown ? parsed.hoursInDay : null;

  return {
    id: row.id,
    chapter: row.narrative_chapter,
    offset: row.narrative_offset,
    title: row.title,
    description: row.description,
    importance: row.importance ?? 1,
    storyHours: storyHours ?? parsedClockOnly,
    storyDisplay: row.story_time_display,
    storyUnit: row.story_time_unit,
    characters: chars,
    location: typeof data.location === 'string' && data.location.trim() ? data.location : null,
    narrativeMode: mode,
    // ⚠ dayUnknown 由**解析时判定**，不只依赖 builder 写入的标记。
    //   理由：标记只在 buildTimelineEvent 解析展示文本时才写；
    //   而事件可能由别的路径写入（手工建、导入、旧数据），
    //   那些行的 data_json 里没有标记 —— 若只认标记，
    //   "21:30" 这类只知道钟点的时间会被当成绝对时间，
    //   于是 ch12 的 21:30 与 ch40 的 21:20 被误判为"倒退 10 分钟"。
    //   解析判定更稳：只要展示文本是"只有钟点"，就一律按钟点对待。
    // ⚠ 不能写成"数值列有值就 dayUnknown=false"：模型给了 value=21.5 的同时
    //   展示文本仍是"21:30" —— 那依旧是**只有钟点没有日期**。
    //   若因此放行，ch12 的 21:30 与 ch40 的 21:20 会被判成"倒退 10 分钟"
    //   （实际可能隔了一个月），正是 dayUnknown 要防的假冲突。
    dayUnknown:
      data.timeDayUnknown === true ||
      (parsed !== null && parsed.dayUnknown) ||
      isClockOnlyDisplay(row.story_time_display),
    flashbackSignal:
      mode === 'FLASHBACK' || mode === 'ANTICIPATION'
        ? true
        : hasFlashbackSignal(row.title, row.description, data.quote),
    data,
  };
}

/** 叙述顺序比较（章号，再章内偏移） */
export function compareNarrative(a: ResolvedTimelineEvent, b: ResolvedTimelineEvent): number {
  const ac = a.chapter ?? Number.MAX_SAFE_INTEGER;
  const bc = b.chapter ?? Number.MAX_SAFE_INTEGER;
  if (ac !== bc) return ac - bc;
  const ao = a.offset ?? Number.MAX_SAFE_INTEGER;
  const bo = b.offset ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 检查报告 */
export interface TimelineReport {
  readonly ok: boolean;
  readonly bookId: string;
  readonly eventCount: number;
  /** 其中故事时间可比较的事件数 */
  readonly comparableCount: number;
  readonly issues: readonly TimelineIssue[];
  readonly blockingCount: number;
  readonly warningCount: number;
  /** 检测时如实说明的局限（有界词表 / 不可比较项等） */
  readonly limitations: readonly string[];
}
