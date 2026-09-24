/**
 * 时间线一致性检查（P0-5）。
 *
 * ## 它要回答的问题
 *
 * 验收用例（提示词原文）：
 *
 * > ch12 21:30 离开医院、ch13 21:20 还在医院 → Commit 前必须能发现
 *
 * ## ⚠ 核心设计取舍：不能把「故事时间倒退」一律当错误
 *
 * 倒叙、插叙、预告都会让故事时间与叙述顺序相反 —— 这是正常写法。
 * 直接判错会把**每一个闪回都报成缺陷**，那样的检查器会被关掉。
 *
 * 所以判据是三者结合：
 *   1. 故事时间确实相对叙述顺序倒退
 *   2. **没有闪回信号**（模型标注的 `narrativeMode` 或正文/事件文字里的强信号词）
 *   3. 倒退幅度**超过容差**（同一场景内的时间跳跃常是叙述技巧，不是错）
 *
 * ## 容差的方向性（重要）
 *
 * 容差内的倒退**只报 INFO**，不报 BLOCKING。理由：把正常写法报成
 * BLOCKING 会挡住提交，而"挡住提交"的成本远高于"漏报一次"。
 * 只有**明确不可能**的情形（角色在两地同时出现、死后仍有行动）
 * 才是 BLOCKING —— 那些不依赖容差，任何解释都说不通。
 */
import { Logger } from '@nwa/core';
import type { TimelineRepository } from '@nwa/storage';
import type { IssueSeverity } from '../continuity/checker.js';
import {
  compareNarrative,
  hasDeathSignal,
  resolveEvent,
  type ResolvedTimelineEvent,
  type TimelineEventRecord,
  type TimelineIssue,
  type TimelineReport,
} from './timeline-types.js';

/**
 * 倒退容差（小时）。
 *
 * ⚠ 这个值是**取舍**，不是测量值：同一场景里"21:30 离开"与"21:20 还在"
 *   若分处不同章、且作者没写闪回，读者会感到错乱 —— 但要判错需要证据。
 *   取 0 会把"同一天内的轻微重述"也报出来；取太大则验收用例会漏。
 *   1 小时既能抓住验收用例（10 分钟差…见下），又不会因几秒的叙述重叠误报。
 *
 * ⚠ 实测口径：验收用例的差值只有 **10 分钟（0.167 小时）**，
 *   所以"超过 1 小时才报"会**漏掉它**。因此策略是：
 *   - 差值 > 1 小时 → WARNING（明显倒退，大概率是错的）
 *   - 差值 ≤ 1 小时 → INFO（轻微倒退，可能是叙述重叠；**不挡提交**）
 *   两者都报出来，只是严重度不同 —— 验收用例要的是"能发现"，不是"必须挡住"。
 */
const LARGE_INVERSION_HOURS = 1;

/**
 * ⚠ 只知道钟点（dayUnknown）的事件，最多与相隔几章的事件比较顺序。
 *
 * 取 2 = 同章或相邻章。理由：相邻章通常仍在同一天内连续叙述，
 * 比较钟点是有意义的（这正是验收用例 ch12 → ch13 的形态）；
 * 相隔更远则日期未知，比较会造出假冲突。
 */
const CLOCK_ONLY_MAX_CHAPTER_GAP = 2;

export interface TimelineCheckerOptions {
  readonly repo: TimelineRepository;
  readonly logger: Logger;
  readonly bookId: string;
}

export class TimelineChecker {
  private readonly repo: TimelineRepository;
  private readonly logger: Logger;
  private readonly bookId: string;

  constructor(opts: TimelineCheckerOptions) {
    this.repo = opts.repo;
    this.logger = opts.logger;
    this.bookId = opts.bookId;
  }

  /**
   * 检查整本书的时间线。
   *
   * ⚠ 检查是**只读**的：不改任何事件、不写库。
   */
  check(rows?: readonly TimelineEventRecord[]): TimelineReport {
    const raw = rows ?? this.repo.listByBook(this.bookId);
    const events = raw.map(resolveEvent);
    const issues: TimelineIssue[] = [];
    const limitations: string[] = [];

    // ── 1. 故事时间相对叙述顺序倒退 ──
    const ordered = [...events].sort(compareNarrative);
    let last: ResolvedTimelineEvent | null = null;
    let skippedForSignal = 0;
    let skippedUncomparable = 0;
    let skippedClockOnly = 0;

    for (const ev of ordered) {
      if (ev.storyHours === null) {
        // ⚠⚠ **不要**把 last 换成这个事件。
        //
        // 实测踩到的 bug：一旦有事件没有可比时间，它就成了新的 last，
        // 而 last.storyHours === null 会让**下一个**事件整段跳过比较 ——
        // 链条从第一个不可比事件处断掉，后面所有可比事件之间都不再互相比。
        // 表现为：库里明明有 ch12 21:30 与 ch13 21:20，却报不出倒退。
        // （验收用例本身因此失效，直到真实数据里混进不可比事件才暴露。）
        //
        // 正确语义：不可比的事件只是"这一条不参与"，不应影响其余事件的比较。
        skippedUncomparable += 1;
        continue;
      }

      // ⚠ dayUnknown 的事件只知道"几点"，不知道哪天。
      //   若与上一个事件相隔太远，直接比钟点会造出假冲突
      //   （ch12 的 21:30 vs ch40 的 21:20 可能隔了一个月）。
      //   所以只在**章号相近**时才用它做顺序判断，否则如实记为不可比较。
      const comparableWithLast =
        last !== null &&
        last.storyHours !== null &&
        !(
          (ev.dayUnknown || last.dayUnknown) &&
          Math.abs((ev.chapter ?? 0) - (last.chapter ?? 0)) > CLOCK_ONLY_MAX_CHAPTER_GAP
        );

      if (last && last.storyHours !== null && !comparableWithLast) {
        skippedClockOnly += 1;
        last = ev;
        continue;
      }

      if (last && last.storyHours !== null) {
        const delta = ev.storyHours - last.storyHours;
        if (delta < 0) {
          if (ev.flashbackSignal || last.flashbackSignal) {
            // ⚠ 有闪回信号 → 故事时间倒退是**正常写法**，不报
            skippedForSignal += 1;
          } else {
            const backHours = Math.abs(delta);
            const large = backHours > LARGE_INVERSION_HOURS;
            issues.push({
              id: `tl_inv_${last.id}__${ev.id}`,
              code: 'TIME_INVERSION',
              severity: large ? 'WARNING' : 'INFO',
              message:
                `第 ${ev.chapter ?? '?'} 章的「${ev.title}」故事时间是 ` +
                `${ev.storyDisplay ?? `${ev.storyHours} 小时`}，` +
                `早于第 ${last.chapter ?? '?'} 章的「${last.title}」` +
                `（${last.storyDisplay ?? `${last.storyHours} 小时`}），` +
                `倒退约 ${formatHours(backHours)}` +
                (large ? '' : '（幅度很小，可能是同场景叙述重叠）'),
              eventIds: [last.id, ev.id],
              chapters: [last.chapter, ev.chapter].filter((c): c is number => c !== null),
              entityRefs: [...new Set([...last.characters, ...ev.characters])],
            });
          }
        }
      }
      last = ev;
    }

    if (skippedUncomparable > 0) {
      limitations.push(
        `${skippedUncomparable} 个事件的时间不可比较（缺 story_time_value/unit，或单位不认识）` +
          `—— 它们不参与顺序检查`,
      );
    }
    if (skippedClockOnly > 0) {
      limitations.push(
        `${skippedClockOnly} 处因只知道钟点（无日期）且章号相隔较远而未做顺序判断` +
          ` —— 直接比钟点会造出假冲突`,
      );
    }
    if (skippedForSignal > 0) {
      limitations.push(
        `${skippedForSignal} 处故事时间倒退带闪回信号（回忆/倒叙等），按正常写法豁免`,
      );
    }
    limitations.push(
      '闪回信号来自有界词表 + 模型标注的 narrativeMode；词表外的闪回会被误报为 WARNING',
    );

    // ── 2. 同一角色在同一故事时刻出现在两个地点 ──
    issues.push(...this.checkDoubleBooking(events));

    // ── 3. 角色在死亡之后仍有行动 ──
    issues.push(...this.checkActAfterDeath(events));

    const blockingCount = issues.filter((i) => i.severity === 'BLOCKING').length;
    const warningCount = issues.filter((i) => i.severity === 'WARNING').length;

    this.logger.info('时间线检查完成', {
      bookId: this.bookId,
      events: events.length,
      blocking: blockingCount,
      warning: warningCount,
    });

    return {
      ok: blockingCount === 0,
      bookId: this.bookId,
      eventCount: events.length,
      comparableCount: events.filter((e) => e.storyHours !== null).length,
      issues,
      blockingCount,
      warningCount,
      limitations,
    };
  }

  /**
   * 同一角色在同一故事时刻（容差内）出现在两个不同地点。
   *
   * ⚠ 只比较**地点不同**的配对 —— 同一地点重复出现不是冲突。
   *   且只在两个事件的故事时间**都可比**时判断；不可比就跳过（不猜）。
   */
  private checkDoubleBooking(events: readonly ResolvedTimelineEvent[]): TimelineIssue[] {
    const issues: TimelineIssue[] = [];
    const byChar = new Map<string, ResolvedTimelineEvent[]>();
    for (const ev of events) {
      if (ev.storyHours === null || ev.location === null) continue;
      for (const c of ev.characters) {
        const arr = byChar.get(c) ?? [];
        arr.push(ev);
        byChar.set(c, arr);
      }
    }

    for (const [char, list] of byChar) {
      const sorted = [...list].sort((a, b) => (a.storyHours ?? 0) - (b.storyHours ?? 0));
      for (let i = 1; i < sorted.length; i += 1) {
        const a = sorted[i - 1]!;
        const b = sorted[i]!;
        const aH = a.storyHours!;
        const bH = b.storyHours!;
        // 同一时刻（±0）且地点不同 → 物理上不可能
        if (aH === bH && a.location !== b.location) {
          // ⚠ dayUnknown 的时间不可跨远章比较（见 CLOCK_ONLY_MAX_CHAPTER_GAP）
          if (
            (a.dayUnknown || b.dayUnknown) &&
            Math.abs((a.chapter ?? 0) - (b.chapter ?? 0)) > CLOCK_ONLY_MAX_CHAPTER_GAP
          ) {
            continue;
          }
          // ⚠ 闪回不豁免这条：闪回里"当时在 A 地"和现在"在 B 地"不是同一时刻。
          //   所以只在**两个事件都不带闪回信号**时才判。
          if (a.flashbackSignal || b.flashbackSignal) continue;
          issues.push({
            id: `tl_dbl_${a.id}__${b.id}`,
            code: 'CHARACTER_DOUBLE_BOOKED',
            severity: 'BLOCKING',
            message:
              `「${char}」在同一故事时刻（${a.storyDisplay ?? `${aH} 小时`}）` +
              `同时出现在「${a.location}」（第 ${a.chapter ?? '?'} 章「${a.title}」）` +
              `和「${b.location}」（第 ${b.chapter ?? '?'} 章「${b.title}」）`,
            eventIds: [a.id, b.id],
            chapters: [a.chapter, b.chapter].filter((c): c is number => c !== null),
            entityRefs: [char, a.location ?? '', b.location ?? ''].filter((x) => x.length > 0),
          });
        }
      }
    }
    return issues;
  }

  /**
   * 角色在死亡之后仍有行动。
   *
   * ⚠ 死亡判定用**有界词表**（`hasDeathSignal`），只看事件自己的文字。
   *   词表外（"他闭上了眼睛再没睁开"）检测不到 —— 如实记在 limitations 里。
   *
   * ⚠ 只报**故事时间可比且严格晚于死亡事件**的后续行动。
   *   不可比就不判（不能拿叙述顺序当故事时间用）。
   */
  private checkActAfterDeath(events: readonly ResolvedTimelineEvent[]): TimelineIssue[] {
    const issues: TimelineIssue[] = [];

    for (const char of new Set(events.flatMap((e) => e.characters))) {
      const mine = events.filter((e) => e.characters.includes(char) && e.storyHours !== null);
      const deaths = mine.filter((e) => hasDeathSignal(e.title, e.description));

      for (const death of deaths) {
        const dH = death.storyHours!;
        for (const after of mine) {
          if (after.id === death.id) continue;
          const aH = after.storyHours!;
          if (aH <= dH) continue;
          // 闪回里叙述"死亡之前"的事不构成矛盾
          if (after.flashbackSignal) continue;
          issues.push({
            id: `tl_dead_${death.id}__${after.id}`,
            code: 'ACT_AFTER_DEATH',
            severity: 'BLOCKING',
            message:
              `「${char}」在第 ${death.chapter ?? '?'} 章「${death.title}」中死亡` +
              `（${death.storyDisplay ?? `${dH} 小时`}），` +
              `但第 ${after.chapter ?? '?'} 章「${after.title}」` +
              `（${after.storyDisplay ?? `${aH} 小时`}）中仍有行动`,
            eventIds: [death.id, after.id],
            chapters: [death.chapter, after.chapter].filter((c): c is number => c !== null),
            entityRefs: [char],
          });
        }
      }
    }
    return issues;
  }

  /** 按严重度汇总（供 Commit 门禁使用） */
  static blockingOf(report: TimelineReport): readonly TimelineIssue[] {
    return report.issues.filter((i) => i.severity === 'BLOCKING');
  }
}

/** 人类可读的时长 */
export function formatHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} 分钟`;
  if (h < 24) return `${h % 1 === 0 ? h : h.toFixed(1)} 小时`;
  const days = h / 24;
  return `${days % 1 === 0 ? days : days.toFixed(1)} 天`;
}

/** 严重度权重（供排序） */
export const SEVERITY_RANK: Readonly<Record<IssueSeverity, number>> = {
  BLOCKING: 0,
  WARNING: 1,
  INFO: 2,
};
