/**
 * 时间线服务（P0-5）—— 对外唯一入口。
 *
 * 把仓储（读写）与检查器（只读判断）合成一个门面，让调用方
 * （workflow-services / IPC / 验证脚本）不需要知道有几个类。
 *
 * ## 分工
 *
 * ```
 * TimelineRepository  建/查事件
 * TimelineChecker     判断顺序冲突、不可能事件（只读）
 * TimelineService     门面 + 从状态提议建事件
 * ```
 *
 * ⚠ 本文件**不重复实现检查逻辑** —— 只转发。两处实现必然漂移。
 */
import { Logger } from '@nwa/core';
import type { ProposedTimelineEvent } from '@nwa/shared';
import type { CreateTimelineEventInput, TimelineRepository } from '@nwa/storage';
import { TimelineChecker } from './timeline-checker.js';
import {
  resolveEvent,
  type ResolvedTimelineEvent,
  type TimelineEventRecord,
  type TimelineReport,
} from './timeline-types.js';

export interface TimelineServiceOptions {
  readonly repo: TimelineRepository;
  readonly logger: Logger;
  readonly bookId: string;
}

/** 从一条状态提议里的时间线事件建记录 */
export interface BuildFromProposalInput {
  readonly proposalId: string;
  readonly chapterNumber: number;
  readonly draftText: string;
  readonly events: readonly ProposedTimelineEvent[];
  /** 代码解析出的引文位置（模型给的字偏移不可靠 —— P0-4 实测结论） */
  readonly spans: readonly ({ readonly start: number; readonly end: number } | undefined)[];
  /** 每条事件的证据 id（P0-4 写入 evidence 表后回填） */
  readonly evidenceIds?: readonly (string | undefined)[];
  /** 每条事件涉及的角色名（由提取阶段解析） */
  readonly characters?: readonly (readonly string[] | undefined)[];
  readonly locations?: readonly (string | undefined)[];
}

export class TimelineService {
  readonly repo: TimelineRepository;
  private readonly checker: TimelineChecker;
  private readonly logger: Logger;
  private readonly bookId: string;

  constructor(opts: TimelineServiceOptions) {
    this.repo = opts.repo;
    this.logger = opts.logger;
    this.bookId = opts.bookId;
    this.checker = new TimelineChecker({
      repo: opts.repo,
      logger: opts.logger.child('checker'),
      bookId: opts.bookId,
    });
  }

  // ── 建事件 ──

  create(input: Omit<CreateTimelineEventInput, 'bookId'>): TimelineEventRecord {
    return this.repo.create({ ...input, bookId: this.bookId });
  }

  /**
   * 从状态提议批量建事件。
   *
   * ⚠ 只接受**已验证通过**的条目 —— 调用方（StateSettlement.apply）
   *   已经按 verdict 过滤过，这里不再重复判断，但会校验引文位置存在：
   *   没有位置的事件无法回溯，写进去就是"来历不明的时间线"。
   */
  buildFromProposal(input: BuildFromProposalInput): { written: number; skipped: string[] } {
    const skipped: string[] = [];
    let written = 0;

    input.events.forEach((ev, i) => {
      const span = input.spans[i];
      if (!span) {
        skipped.push(`时间线事件「${ev.title}」缺少引文位置，未写入（无法回溯）`);
        return;
      }
      const id = `te_${input.proposalId}_${i}`;
      if (this.repo.find(id)) {
        skipped.push(`时间线事件「${ev.title}」已存在（${id}），跳过重复写入`);
        return;
      }
      try {
        this.repo.create({
          id,
          bookId: this.bookId,
          title: ev.title,
          description: ev.description,
          storyTimeValue: ev.storyTimeValue ?? null,
          storyTimeUnit: ev.storyTimeUnit ?? null,
          storyTimeDisplay: ev.storyTimeDisplay ?? null,
          narrativeChapter: input.chapterNumber,
          narrativeOffset: span.start,
          importance: ev.importance ?? 1,
          data: {
            quote: ev.quote,
            quoteStart: span.start,
            quoteEnd: span.end,
            ...(input.evidenceIds?.[i] ? { evidenceId: input.evidenceIds[i] } : {}),
            ...(input.characters?.[i] ? { characters: input.characters[i] } : {}),
            ...(input.locations?.[i] ? { location: input.locations[i] } : {}),
          },
        });
        written += 1;
      } catch (e) {
        // ⚠ 带上是哪一条 —— 裸的错误信息会让人去查错地方（P0-4 的教训）
        skipped.push(
          `时间线事件「${ev.title}」写入失败：` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
    });

    return { written, skipped };
  }

  // ── 查询 ──

  listByBook(): ResolvedTimelineEvent[] {
    return this.repo.listByBook(this.bookId).map(resolveEvent);
  }

  listByChapter(chapter: number): ResolvedTimelineEvent[] {
    return this.repo.listByChapter(this.bookId, chapter).map(resolveEvent);
  }

  listByCharacter(character: string): ResolvedTimelineEvent[] {
    return this.repo.listByCharacter(this.bookId, character).map(resolveEvent);
  }

  listByLocation(location: string): ResolvedTimelineEvent[] {
    return this.repo.listByLocation(this.bookId, location).map(resolveEvent);
  }

  listByStoryRange(fromHours: number, toHours: number): ResolvedTimelineEvent[] {
    return this.repo.listByStoryRange(this.bookId, fromHours, toHours).map(resolveEvent);
  }

  count(): number {
    return this.repo.count(this.bookId);
  }

  // ── 检查 ──

  check(): TimelineReport {
    return this.checker.check();
  }

  /** 只报 BLOCKING（供 Commit 门禁） */
  checkBlocking(): readonly { code: string; message: string }[] {
    return TimelineChecker.blockingOf(this.check()).map((i) => ({
      code: i.code,
      message: i.message,
    }));
  }
}
