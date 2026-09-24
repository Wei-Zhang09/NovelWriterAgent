/**
 * 时间线集成测试（P0-5）。
 *
 * ## 验收用例（提示词原文）
 *
 * > ch12 21:30 离开医院、ch13 21:20 还在医院 → Commit 前必须能发现
 *
 * ## ⚠ 这里最要紧的一组测试是「不该报的不报」
 *
 * 时间线检查器的最大风险不是漏报，而是**把正常写法报成缺陷**：
 * 倒叙、插叙、预告都会让故事时间与叙述顺序相反，那是文学手法。
 * 一个把闪回全报成错误的检查器会被关掉，之后什么也检查不到。
 * 所以下面的「闪回豁免」「容差」「钟点不跨远章比较」三组
 * 和验收用例同等重要。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  TimelineService,
  TimelineChecker,
  buildTimelineEvent,
  parseDisplayTime,
  parseSmallNumber,
  toHours,
  resolveEvent,
  hasFlashbackSignal,
  hasDeathSignal,
} from '@nwa/story';
import { Logger } from '@nwa/core';
import { createTestProject, makeChapter, type TestProject } from './helpers.js';

let t: TestProject | null = null;

afterEach(() => {
  t?.cleanup();
  t = null;
});

const logger = new Logger('test:timeline', { level: 'error' });

function svcOf(p: TestProject): TimelineService {
  return new TimelineService({
    repo: p.repos.timeline,
    logger,
    bookId: p.bookId,
  });
}

/** 建一条事件（默认顺叙、故事时间可比较） */
function mkEvent(
  p: TestProject,
  id: string,
  opts: {
    chapter: number;
    title: string;
    description?: string;
    storyValue?: number | null;
    storyUnit?: string | null;
    storyDisplay?: string | null;
    characters?: readonly string[];
    location?: string | null;
    narrativeMode?: string;
    offset?: number;
  },
): void {
  p.repos.timeline.create({
    id,
    bookId: p.bookId,
    title: opts.title,
    description: opts.description ?? opts.title,
    storyTimeValue: opts.storyValue ?? null,
    storyTimeUnit: opts.storyUnit ?? null,
    storyTimeDisplay: opts.storyDisplay ?? null,
    narrativeChapter: opts.chapter,
    narrativeOffset: opts.offset ?? 0,
    data: {
      ...(opts.characters ? { characters: opts.characters } : {}),
      ...(opts.location ? { location: opts.location } : {}),
      ...(opts.narrativeMode ? { narrativeMode: opts.narrativeMode } : {}),
    },
  });
}

// ─────────────────────────────────────────────────────────
describe('P0-5 · 验收用例：ch12 21:30 离开医院、ch13 21:20 还在医院', () => {
  it('⚠⚠ 必须能发现（这是提示词点名的用例）', () => {
    const p = (t = createTestProject());
    makeChapter(p, 12);
    makeChapter(p, 13);

    mkEvent(p, 'te_12', {
      chapter: 12,
      title: '林砚离开医院',
      storyValue: 21.5,
      storyUnit: 'hour',
      storyDisplay: '21:30',
      characters: ['林砚'],
      location: '医院',
    });
    mkEvent(p, 'te_13', {
      chapter: 13,
      title: '林砚仍在医院',
      storyValue: 21 + 20 / 60,
      storyUnit: 'hour',
      storyDisplay: '21:20',
      characters: ['林砚'],
      location: '医院',
    });

    const report = svcOf(p).check();

    expect(report.eventCount).toBe(2);
    expect(report.comparableCount).toBe(2);

    const inv = report.issues.filter((i) => i.code === 'TIME_INVERSION');
    expect(inv.length).toBe(1);
    expect(inv[0]!.message).toContain('离开医院');
    expect(inv[0]!.message).toContain('仍在医院');
    expect(inv[0]!.message).toContain('倒退');
    // 两个事件都被指出来（否则无法定位）
    expect(inv[0]!.eventIds).toEqual(['te_12', 'te_13']);
    expect(inv[0]!.chapters).toEqual([12, 13]);
  });

  it('⚠ 10 分钟的倒退幅度很小 → INFO 而非 BLOCKING（不挡提交）', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'a', { chapter: 12, title: '离开医院', storyValue: 21.5, storyUnit: 'hour' });
    mkEvent(p, 'b', {
      chapter: 13,
      title: '仍在医院',
      storyValue: 21 + 20 / 60,
      storyUnit: 'hour',
    });

    const report = svcOf(p).check();
    const inv = report.issues.find((i) => i.code === 'TIME_INVERSION')!;
    // 差值 0.167 小时 < 1 小时容差 → INFO
    expect(inv.severity).toBe('INFO');
    expect(report.blockingCount).toBe(0);
    // ⚠ 但"能发现"是硬要求：INFO 也是发现了
    expect(report.issues.length).toBeGreaterThan(0);
  });

  it('⚠ 大幅倒退（>1 小时）→ WARNING', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'a', { chapter: 12, title: '离开', storyValue: 21.5, storyUnit: 'hour' });
    mkEvent(p, 'b', { chapter: 13, title: '回来', storyValue: 9, storyUnit: 'hour' });

    const report = svcOf(p).check();
    const inv = report.issues.find((i) => i.code === 'TIME_INVERSION')!;
    expect(inv.severity).toBe('WARNING');
  });

  it('⚠ 顺序正常时不报（基线：检查器不能总是报）', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'a', { chapter: 12, title: '离开医院', storyValue: 21.5, storyUnit: 'hour' });
    mkEvent(p, 'b', { chapter: 13, title: '到家', storyValue: 22.5, storyUnit: 'hour' });

    const report = svcOf(p).check();
    expect(report.issues.filter((i) => i.code === 'TIME_INVERSION')).toHaveLength(0);
    expect(report.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
describe('P0-5 · 闪回不能报成缺陷（否则检查器会被关掉）', () => {
  it('⚠⚠ 带闪回信号的故事时间倒退 → 豁免，不报', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'now', {
      chapter: 20,
      title: '现在的对峙',
      storyValue: 100,
      storyUnit: 'hour',
    });
    mkEvent(p, 'mem', {
      chapter: 21,
      title: '回忆：三年前的那个雨夜',
      description: '他回忆起三年前离开家时的情形。',
      storyValue: 10,
      storyUnit: 'hour',
    });

    const report = svcOf(p).check();
    expect(report.issues.filter((i) => i.code === 'TIME_INVERSION')).toHaveLength(0);
    // ⚠ 豁免必须被记录 —— 否则"没报"和"没检查"分不出来
    expect(report.limitations.join(' ')).toContain('闪回');
  });

  it('⚠ 模型显式标注 FLASHBACK → 豁免（不依赖词表）', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'now', { chapter: 20, title: '对峙', storyValue: 100, storyUnit: 'hour' });
    mkEvent(p, 'fb', {
      chapter: 21,
      title: '往事',
      storyValue: 10,
      storyUnit: 'hour',
      narrativeMode: 'FLASHBACK',
    });

    const report = svcOf(p).check();
    expect(report.issues.filter((i) => i.code === 'TIME_INVERSION')).toHaveLength(0);
  });

  it('⚠ ANTICIPATION（预告）同样豁免', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'now', { chapter: 20, title: '对峙', storyValue: 100, storyUnit: 'hour' });
    mkEvent(p, 'ant', {
      chapter: 21,
      title: '预言',
      storyValue: 500,
      storyUnit: 'hour',
      narrativeMode: 'ANTICIPATION',
    });
    const report = svcOf(p).check();
    expect(report.issues.filter((i) => i.code === 'TIME_INVERSION')).toHaveLength(0);
  });

  it('⚠ hasFlashbackSignal 只认强信号（弱词不收，否则豁免形同虚设）', () => {
    expect(hasFlashbackSignal('他回忆起从前')).toBe(true);
    expect(hasFlashbackSignal('三年前的雨夜')).toBe(true);
    expect(hasFlashbackSignal('此刻他站在门口')).toBe(false);
    // ⚠ "当时"/"那时"是弱词，故意不收
    expect(hasFlashbackSignal('当时他站在门口')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
describe('P0-5 · 钟点不可跨远章比较（防假冲突）', () => {
  it('⚠⚠ ch12 的 21:30 与 ch40 的 21:20 不能判为倒退（可能隔了一个月）', () => {
    const p = (t = createTestProject());
    // dayUnknown：只知道钟点，不知道哪天（由 "21:30" 这种文本解析而来）
    mkEvent(p, 'a', {
      chapter: 12,
      title: '离开医院',
      storyValue: 21.5,
      storyUnit: 'hour',
      storyDisplay: '21:30',
    });
    mkEvent(p, 'b', {
      chapter: 40,
      title: '又一次离开',
      storyValue: 21 + 20 / 60,
      storyUnit: 'hour',
      storyDisplay: '21:20',
    });

    const report = svcOf(p).check();
    expect(report.issues.filter((i) => i.code === 'TIME_INVERSION')).toHaveLength(0);
    expect(report.limitations.join(' ')).toContain('钟点');
  });

  it('⚠ 相邻章（ch12 → ch13）的钟点可以比较（验收用例的形态）', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'a', { chapter: 12, title: '离开', storyValue: 21.5, storyUnit: 'hour' });
    mkEvent(p, 'b', { chapter: 13, title: '还在', storyValue: 21.3, storyUnit: 'hour' });
    const report = svcOf(p).check();
    expect(report.issues.filter((i) => i.code === 'TIME_INVERSION')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────
describe('P0-5 · 不可能事件：同一角色两地同时出现', () => {
  it('⚠⚠ 同一时刻出现在两个地点 → BLOCKING', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'h', {
      chapter: 5,
      title: '在医院',
      storyValue: 100,
      storyUnit: 'hour',
      characters: ['林砚'],
      location: '医院',
    });
    mkEvent(p, 's', {
      chapter: 5,
      title: '在学堂',
      storyValue: 100,
      storyUnit: 'hour',
      characters: ['林砚'],
      location: '学堂',
    });

    const report = svcOf(p).check();
    const dbl = report.issues.filter((i) => i.code === 'CHARACTER_DOUBLE_BOOKED');
    expect(dbl).toHaveLength(1);
    expect(dbl[0]!.severity).toBe('BLOCKING');
    expect(report.ok).toBe(false);
    expect(dbl[0]!.message).toContain('医院');
    expect(dbl[0]!.message).toContain('学堂');
    expect(dbl[0]!.entityRefs).toContain('林砚');
  });

  it('⚠ 同一时刻**同一地点**不算冲突', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'a', {
      chapter: 5, title: '进医院', storyValue: 100, storyUnit: 'hour',
      characters: ['林砚'], location: '医院',
    });
    mkEvent(p, 'b', {
      chapter: 5, title: '还在医院', storyValue: 100, storyUnit: 'hour',
      characters: ['林砚'], location: '医院',
    });
    const report = svcOf(p).check();
    expect(report.issues.filter((i) => i.code === 'CHARACTER_DOUBLE_BOOKED')).toHaveLength(0);
  });

  it('⚠ 不同角色同时在不同地点是正常的', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'a', {
      chapter: 5, title: '甲在医院', storyValue: 100, storyUnit: 'hour',
      characters: ['甲'], location: '医院',
    });
    mkEvent(p, 'b', {
      chapter: 5, title: '乙在学堂', storyValue: 100, storyUnit: 'hour',
      characters: ['乙'], location: '学堂',
    });
    const report = svcOf(p).check();
    expect(report.issues.filter((i) => i.code === 'CHARACTER_DOUBLE_BOOKED')).toHaveLength(0);
  });

  it('⚠ 缺少地点信息时不判（不猜）', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'a', { chapter: 5, title: '甲', storyValue: 100, storyUnit: 'hour', characters: ['甲'] });
    mkEvent(p, 'b', { chapter: 5, title: '乙', storyValue: 100, storyUnit: 'hour', characters: ['甲'] });
    const report = svcOf(p).check();
    expect(report.issues.filter((i) => i.code === 'CHARACTER_DOUBLE_BOOKED')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────
describe('P0-5 · 不可能事件：死后仍有行动', () => {
  it('⚠⚠ 死亡之后的事件 → BLOCKING', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'die', {
      chapter: 30,
      title: '陆明远阵亡',
      description: '他在城头阵亡。',
      storyValue: 500,
      storyUnit: 'hour',
      characters: ['陆明远'],
    });
    mkEvent(p, 'after', {
      chapter: 31,
      title: '陆明远回到家中',
      description: '陆明远推门进来。',
      storyValue: 600,
      storyUnit: 'hour',
      characters: ['陆明远'],
    });

    const report = svcOf(p).check();
    const dead = report.issues.filter((i) => i.code === 'ACT_AFTER_DEATH');
    expect(dead).toHaveLength(1);
    expect(dead[0]!.severity).toBe('BLOCKING');
    expect(dead[0]!.message).toContain('阵亡');
    expect(dead[0]!.entityRefs).toContain('陆明远');
  });

  it('⚠ 死亡**之前**的事件不报（闪回里的往事是正常的）', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'before', {
      chapter: 28,
      title: '陆明远出征',
      storyValue: 400,
      storyUnit: 'hour',
      characters: ['陆明远'],
    });
    mkEvent(p, 'die', {
      chapter: 30,
      title: '陆明远阵亡',
      storyValue: 500,
      storyUnit: 'hour',
      characters: ['陆明远'],
    });
    const report = svcOf(p).check();
    expect(report.issues.filter((i) => i.code === 'ACT_AFTER_DEATH')).toHaveLength(0);
  });

  it('⚠ 死后事件带闪回信号 → 豁免（叙述的是死亡之前的事）', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'die', {
      chapter: 30, title: '陆明远阵亡', storyValue: 500, storyUnit: 'hour',
      characters: ['陆明远'],
    });
    mkEvent(p, 'fb', {
      chapter: 31, title: '回忆：陆明远年少时',
      description: '回忆起陆明远年少时的事。',
      storyValue: 600, storyUnit: 'hour',
      characters: ['陆明远'],
    });
    const report = svcOf(p).check();
    expect(report.issues.filter((i) => i.code === 'ACT_AFTER_DEATH')).toHaveLength(0);
  });

  it('⚠ hasDeathSignal 用有界词表', () => {
    expect(hasDeathSignal('他阵亡了')).toBe(true);
    expect(hasDeathSignal('他去世了')).toBe(true);
    expect(hasDeathSignal('他离开了')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
describe('P0-5 · 展示时间解析（有界，认不出不猜）', () => {
  it('⚠ 解析 HH:MM', () => {
    const r = parseDisplayTime('21:30');
    expect(r?.hoursInDay).toBeCloseTo(21.5, 5);
    expect(r?.dayUnknown).toBe(true);
  });

  it('⚠ 解析「21点30分」与「晚上九点半」', () => {
    expect(parseDisplayTime('21点30分')?.hoursInDay).toBeCloseTo(21.5, 5);
    expect(parseDisplayTime('晚上九点半')?.hoursInDay).toBeCloseTo(21.5, 5);
  });

  it('⚠ 12 小时制换算（下午三点 → 15 点）', () => {
    expect(parseDisplayTime('下午三点')?.hoursInDay).toBeCloseTo(15, 5);
    expect(parseDisplayTime('晚上九点')?.hoursInDay).toBeCloseTo(21, 5);
    // 中午十二点 = 12
    expect(parseDisplayTime('中午十二点')?.hoursInDay).toBeCloseTo(12, 5);
  });

  it('⚠ 解析「第N天」得到绝对小时数（dayUnknown = false）', () => {
    const r = parseDisplayTime('第3天 21:30');
    expect(r?.day).toBe(3);
    expect(r?.dayUnknown).toBe(false);
    expect(r?.absoluteHours).toBeCloseTo(2 * 24 + 21.5, 5);
  });

  it('⚠⚠ 认不出就返回 null —— 不猜（猜出来的时间线会造出假冲突）', () => {
    expect(parseDisplayTime('很久以后')).toBeNull();
    expect(parseDisplayTime('')).toBeNull();
    expect(parseDisplayTime(null)).toBeNull();
    // ⚠ 非法钟点也不猜
    expect(parseDisplayTime('99:99')).toBeNull();
  });

  it('⚠ 只有时段词也要解析出来（真机数据全是这种写法）', () => {
    // ⚠ 这条断言的方向被**真机数据推翻过**，值得记下来。
    //
    // 原先是 `expect(parseDisplayTime('那天傍晚')).toBeNull()`，
    // 理由是"不知道哪天就不该比较"。但真机跑出来：模型产出的时间
    // 几乎全是"雾气弥漫的清晨""天已经大亮""午后云堆上来时"这类写法 ——
    // 10 条事件里 0 条可比，时间线检查在真实数据上完全空转。
    //
    // 正确做法与"只有钟点"一致：给出一天内的位置 + 标 dayUnknown，
    // 由检查器限制比较范围（同章或相邻章）。"清晨 < 午后"在相邻章内
    // 是有意义的判断。
    const dusk = parseDisplayTime('那天傍晚');
    expect(dusk).not.toBeNull();
    expect(dusk!.dayUnknown).toBe(true);
    expect(dusk!.hoursInDay).toBe(18);

    // 模型实际写出来的那些说法
    // ⚠ "天已经大亮"是**上午**（8 点），不是下午 —— 我第一版测试把它
    //   写成下午，被测试自己抓出来了。
    for (const [text, expectMorning] of [
      ['雾气弥漫的清晨', true],
      ['天已经大亮', true],
      ['午后云堆上来时', false],
    ] as const) {
      const r = parseDisplayTime(text);
      expect(r, text).not.toBeNull();
      expect(r!.dayUnknown, text).toBe(true);
      if (expectMorning) expect(r!.hoursInDay, text).toBeLessThan(12);
      else expect(r!.hoursInDay, text).toBeGreaterThan(11);
    }
    // 清晨 早于 午后（同一天内可比先后）
    expect(parseDisplayTime('雾气弥漫的清晨')!.hoursInDay).toBeLessThan(
      parseDisplayTime('午后云堆上来时')!.hoursInDay,
    );
  });

  it('⚠ parseSmallNumber 支持中文数字', () => {
    expect(parseSmallNumber('3')).toBe(3);
    expect(parseSmallNumber('三')).toBe(3);
    expect(parseSmallNumber('十')).toBe(10);
    expect(parseSmallNumber('十三')).toBe(13);
    expect(parseSmallNumber('二十三')).toBe(23);
    expect(parseSmallNumber('三十')).toBe(30);
    expect(parseSmallNumber('很久')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
describe('P0-5 · 单位换算（比较口径必须一致）', () => {
  it('⚠ toHours 换算正确', () => {
    expect(toHours(1, 'hour')).toBe(1);
    expect(toHours(1, 'day')).toBe(24);
    expect(toHours(1, 'week')).toBe(168);
    expect(toHours(1, 'month')).toBe(720);
    expect(toHours(1, 'year')).toBe(8760);
    expect(toHours(30, 'minute')).toBeCloseTo(0.5, 5);
  });

  it('⚠⚠ 单位不认识 / 缺值 → null（"不可比较"，不是"相等"）', () => {
    expect(toHours(1, 'fortnight')).toBeNull();
    expect(toHours(null, 'hour')).toBeNull();
    expect(toHours(1, null)).toBeNull();
  });

  it('⚠ 不可比较的事件被如实计入 limitations（不静默当"没问题"）', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'a', { chapter: 1, title: '无时间事件 A' }); // 无 storyValue
    mkEvent(p, 'b', { chapter: 2, title: '无时间事件 B' });
    const report = svcOf(p).check();
    expect(report.eventCount).toBe(2);
    expect(report.comparableCount).toBe(0);
    expect(report.limitations.join(' ')).toContain('不可比较');
  });
});

// ─────────────────────────────────────────────────────────
describe('P0-5 · buildTimelineEvent：模型不填时间时由代码解析', () => {
  it('⚠⚠ 模型没给 storyTimeValue → 从 storyTimeDisplay 解析（验收用例的前提）', () => {
    const built = buildTimelineEvent({
      proposalId: 'sp_1',
      chapterNumber: 12,
      index: 0,
      span: { start: 10, end: 40 },
      event: {
        quote: '他走出医院大门，看了一眼表。',
        title: '离开医院',
        description: '他离开医院。',
        storyTimeDisplay: '21:30',
      },
    });
    expect(built).not.toBeNull();
    expect(built!.storyTimeValue).toBeCloseTo(21.5, 5);
    expect(built!.storyTimeUnit).toBe('hour');
    expect((built!.data as { timeSource?: string }).timeSource).toBe('parsed-display');
  });

  it('⚠ 模型给了 storyTimeValue → 优先采用（最可信）', () => {
    const built = buildTimelineEvent({
      proposalId: 'sp_1',
      chapterNumber: 12,
      index: 0,
      span: { start: 0, end: 10 },
      event: {
        quote: 'x',
        title: 't',
        description: 'd',
        storyTimeValue: 5,
        storyTimeUnit: 'day',
        storyTimeDisplay: '21:30',
      },
    });
    expect(built!.storyTimeValue).toBe(5);
    expect(built!.storyTimeUnit).toBe('day');
    expect((built!.data as { timeSource?: string }).timeSource).toBe('model');
  });

  it('⚠ 都没有 → storyTimeValue 为 null（如实标不可比较，不填默认值）', () => {
    const built = buildTimelineEvent({
      proposalId: 'sp_1',
      chapterNumber: 12,
      index: 0,
      span: { start: 0, end: 10 },
      event: { quote: 'x', title: 't', description: 'd' },
    });
    expect(built!.storyTimeValue).toBeNull();
    expect(built!.storyTimeUnit).toBeNull();
  });

  it('⚠⚠ 缺引文位置 → 返回 null（不可回溯的事件不写）', () => {
    const built = buildTimelineEvent({
      proposalId: 'sp_1',
      chapterNumber: 12,
      index: 0,
      event: { quote: 'x', title: 't', description: 'd' },
    });
    expect(built).toBeNull();
  });

  it('⚠ 时间来源被记录（"模型给的"与"代码解析的"可信度不同）', () => {
    const built = buildTimelineEvent({
      proposalId: 'sp_1',
      chapterNumber: 12,
      index: 0,
      span: { start: 0, end: 10 },
      event: { quote: 'x', title: 't', description: 'd', storyTimeDisplay: '第2天 08:00' },
    });
    const d = built!.data as { timeSource?: string; timeDayUnknown?: boolean };
    expect(d.timeSource).toBe('parsed-display');
    // 有日期 → dayUnknown 为 false
    expect(d.timeDayUnknown).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
describe('P0-5 · 查询能力', () => {
  it('⚠ 按角色 / 地点 / 章节 / 时间区间查询', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'e1', {
      chapter: 1, title: '医院的事', storyValue: 10, storyUnit: 'hour',
      characters: ['林砚'], location: '医院',
    });
    mkEvent(p, 'e2', {
      chapter: 2, title: '学堂的事', storyValue: 100, storyUnit: 'hour',
      characters: ['沈氏'], location: '学堂',
    });
    mkEvent(p, 'e3', {
      chapter: 2, title: '两人相遇', storyValue: 200, storyUnit: 'hour',
      characters: ['林砚', '沈氏'], location: '街上',
    });
    const svc = svcOf(p);

    expect(svc.listByCharacter('林砚').map((e) => e.id).sort()).toEqual(['e1', 'e3']);
    expect(svc.listByLocation('学堂').map((e) => e.id)).toEqual(['e2']);
    expect(svc.listByChapter(2).map((e) => e.id).sort()).toEqual(['e2', 'e3']);
    expect(svc.listByStoryRange(50, 150).map((e) => e.id)).toEqual(['e2']);
    expect(svc.count()).toBe(3);
  });

  it('⚠ 按故事时间排序与按叙述顺序排序是两件事', () => {
    const p = (t = createTestProject());
    // 第 1 章叙述的是"第 3 天"，第 2 章叙述的是"第 1 天"（倒叙）
    mkEvent(p, 'later', { chapter: 1, title: '现在', storyValue: 3, storyUnit: 'day' });
    mkEvent(p, 'earlier', { chapter: 2, title: '回忆', storyValue: 1, storyUnit: 'day' });

    const svc = svcOf(p);
    const narrative = svc.listByBook().map((e) => e.id);
    expect(narrative).toEqual(['later', 'earlier']); // 叙述顺序
  });

  it('⚠ 多书隔离：另一本书的时间线互不可见', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'mine', { chapter: 1, title: '我的事件', storyValue: 1, storyUnit: 'hour' });
    const other = p.repos.books.create({
      id: 'book_other',
      projectId: p.projectId,
      title: '另一本书',
    });
    p.repos.timeline.create({
      id: 'theirs',
      bookId: other.id,
      title: '别人的事件',
      description: 'd',
      narrativeChapter: 1,
    });

    expect(svcOf(p).listByBook().map((e) => e.id)).toEqual(['mine']);
    expect(p.repos.timeline.count(other.id)).toBe(1);
  });

  it('⚠ 空书不报错（检查器不能因为没数据就炸）', () => {
    const p = (t = createTestProject());
    const report = svcOf(p).check();
    expect(report.eventCount).toBe(0);
    expect(report.issues).toHaveLength(0);
    expect(report.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
describe('P0-5 · resolveEvent 解析（JSON 坏了也不静默变"没问题"）', () => {
  it('⚠ data_json 损坏 → 解析为空，但仍如实标不可比较', () => {
    const p = (t = createTestProject());
    p.db.run(
      `INSERT INTO timeline_events
         (id, book_id, story_time_value, story_time_unit, story_time_display,
          narrative_chapter, narrative_offset, title, description, importance, data_json, created_at)
       VALUES ('bad','${p.bookId}',NULL,NULL,NULL,1,0,'坏事件','d',1,'not json','2026-01-01T00:00:00Z')`,
    );
    const row = p.repos.timeline.get('bad');
    const ev = resolveEvent(row);
    expect(ev.data).toEqual({});
    expect(ev.storyHours).toBeNull();
    expect(ev.characters).toEqual([]);
    expect(ev.narrativeMode).toBe('FOREGROUND');

    const report = svcOf(p).check();
    expect(report.comparableCount).toBe(0);
    expect(report.limitations.join(' ')).toContain('不可比较');
  });

  it('⚠ TimelineChecker.blockingOf 只挑 BLOCKING', () => {
    const p = (t = createTestProject());
    mkEvent(p, 'a', {
      chapter: 1, title: '甲在医院', storyValue: 1, storyUnit: 'hour',
      characters: ['甲'], location: '医院',
    });
    mkEvent(p, 'b', {
      chapter: 1, title: '甲在学堂', storyValue: 1, storyUnit: 'hour',
      characters: ['甲'], location: '学堂',
    });
    const report = svcOf(p).check();
    expect(TimelineChecker.blockingOf(report).length).toBe(1);
    expect(report.warningCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 回归：两个**实测踩出来的** bug
//
// 这一组测试的来历很重要 —— 两个 bug 都不是靠读代码想出来的，
// 而是在 `pnpm verify:timeline` 里让真模型写两章之后暴露的：
//
//   ① 库里明明有 ch12 21:30 与 ch13 21:20，却报不出倒退。
//      根因：`check()` 的循环里，遇到"没有可比时间"的事件会把 `last`
//      换成它，于是**下一个**事件整段跳过比较 —— 比较链条从第一个
//      不可比事件处断掉。此前测试全绿，是因为构造的数据里所有事件
//      都可比，链条从不断裂。
//
//   ② "第三天清晨"与"第三天傍晚"被解析成同一时刻。
//      根因：`parseDisplayTime` 在"只有第N天、没有钟点"时直接返回
//      `hoursInDay: 0`，把时段词（清晨/傍晚/深夜）整个丢掉。
//      后果：同一天内的时段先后永远判不出来 —— 而那正是时间线
//      检查最该抓住的一类矛盾。
//
// 两个 bug 的共同教训：**只有真实数据才会走到那些分支**。
// 单靠单元测试构造的"干净"输入，恰好绕开了它们。
// ═══════════════════════════════════════════════════════════════

describe('回归：不可比事件不得打断比较链条', () => {
  it('中间夹着无时间事件时，仍能报出跨章倒退', () => {
    const t = createTestProject();
    const repo = t.repos.timeline;
    const bookId = t.bookId;
    // 故意把"无时间"的事件排在中间 —— 这正是真实数据的样子
    // （模型只给部分事件填了时间）
    repo.create({
      id: 'te_a', bookId, title: '陆明远离开医院', description: 'd',
      storyTimeValue: null, storyTimeUnit: null, storyTimeDisplay: '21:30',
      narrativeChapter: 12, narrativeOffset: 0, importance: 1, data: {},
    });
    repo.create({
      id: 'te_mid', bookId, title: '无关事件', description: 'd',
      storyTimeValue: null, storyTimeUnit: null, storyTimeDisplay: null,
      narrativeChapter: 12, narrativeOffset: 1, importance: 1, data: {},
    });
    repo.create({
      id: 'te_b', bookId, title: '陆明远仍在医院', description: 'd',
      storyTimeValue: null, storyTimeUnit: null, storyTimeDisplay: '21:20',
      narrativeChapter: 13, narrativeOffset: 0, importance: 1, data: {},
    });

    const checker = new TimelineChecker({ repo, logger: new Logger('t'), bookId });
    const report = checker.check();

    // ⚠ 关键断言：夹了不可比事件之后，倒退**仍要**被报出来
    const inv = report.issues.filter((i) => i.code === 'TIME_INVERSION');
    expect(inv.length).toBeGreaterThan(0);
    expect(inv[0]!.message).toContain('21:20');
    expect(inv[0]!.message).toContain('21:30');
    // 不可比的那条要如实记进局限，不能假装它参与过
    expect(report.limitations.join('|')).toContain('不可比较');
    t.cleanup();
  });
});

describe('回归：同一天内的时段必须能分先后', () => {
  it('"第三天清晨" 与 "第三天傍晚" 解析成不同时刻', () => {
    const morning = parseDisplayTime('第三天清晨');
    const evening = parseDisplayTime('第三天傍晚');
    expect(morning).not.toBeNull();
    expect(evening).not.toBeNull();
    // ⚠ 关键断言：两者不能相等 —— 相等就说明时段词被丢掉了
    expect(evening!.absoluteHours).toBeGreaterThan(morning!.absoluteHours!);
  });

  it('同一天的清晨→傍晚不构成倒退', () => {
    const t = createTestProject();
    const repo = t.repos.timeline;
    const bookId = t.bookId;
    repo.create({
      id: 'te_m', bookId, title: '清晨出发', description: 'd',
      storyTimeValue: null, storyTimeUnit: null, storyTimeDisplay: '第三天清晨',
      narrativeChapter: 5, narrativeOffset: 0, importance: 1, data: {},
    });
    repo.create({
      id: 'te_e', bookId, title: '傍晚抵达', description: 'd',
      storyTimeValue: null, storyTimeUnit: null, storyTimeDisplay: '第三天傍晚',
      narrativeChapter: 5, narrativeOffset: 1, importance: 1, data: {},
    });
    const report = new TimelineChecker({ repo, logger: new Logger('t'), bookId }).check();
    // 清晨在前、傍晚在后 = 正常顺序，不该报倒退
    expect(report.issues.filter((i) => i.code === 'TIME_INVERSION')).toHaveLength(0);
    expect(report.comparableCount).toBe(2);
    t.cleanup();
  });
});

describe('回归：resolveEvent 必须能从展示文本取时间', () => {
  it('数值列为空但展示文本是"21:30" → 仍可比（且仍标 dayUnknown）', () => {
    // ⚠ 这条来自实测：真模型写出的 17 条事件里 0 条可比，
    //   因为它**只填 storyTimeDisplay、不填 storyTimeValue**。
    //   若 resolveEvent 只读数值列，时间线检查在真实数据上完全空转 ——
    //   而单元测试全绿（测试自己填了 value，模型不给）。
    const row = {
      id: 'te_x',
      book_id: 'b',
      title: '陆明远离开医院',
      description: 'd',
      story_time_value: null,
      story_time_unit: null,
      story_time_display: '21:30',
      narrative_chapter: 12,
      narrative_offset: 0,
      importance: 1,
      data_json: null,
      created_at: '2026-01-01T00:00:00.000Z',
    } as never;
    const ev = resolveEvent(row);
    expect(ev.storyHours).not.toBeNull();
    expect(ev.storyHours).toBeCloseTo(21.5, 5);
    // 只有钟点 → 必须仍受限（不能与远章直接比较）
    expect(ev.dayUnknown).toBe(true);
  });

  it('模型给了数值 21.5、展示文本仍是"21:30" → 仍标 dayUnknown', () => {
    // ⚠ 数值来源（模型给的 vs 代码解析的）不改变"没有日期"这个事实。
    //   若因"数值列有值"就放行，ch12 的 21:30 与 ch40 的 21:20
    //   会被判成"倒退 10 分钟"，而实际可能隔了一个月。
    const row = {
      id: 'te_y',
      book_id: 'b',
      title: 't',
      description: 'd',
      story_time_value: 21.5,
      story_time_unit: 'hour',
      story_time_display: '21:30',
      narrative_chapter: 12,
      narrative_offset: 0,
      importance: 1,
      data_json: null,
      created_at: '2026-01-01T00:00:00.000Z',
    } as never;
    const ev = resolveEvent(row);
    expect(ev.storyHours).toBeCloseTo(21.5, 5);
    expect(ev.dayUnknown).toBe(true);
  });
});
