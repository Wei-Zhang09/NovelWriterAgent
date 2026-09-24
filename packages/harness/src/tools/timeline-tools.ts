/**
 * 时间线工具（P0-5）。
 *
 * ## ⚠ 为什么必须补这些工具
 *
 * `timeline_events` 表在 `0001_init.sql:227` 就建好了，仓储层（P0-5）也补齐了，
 * 但**没有任何工具暴露它** —— 这与 `character.create`（仓储完整、工具缺失）
 * 是同一类缺陷：底层能力齐备，使用者够不到。
 *
 * 验收用例「ch12 21:30 离开医院、ch13 21:20 还在医院」需要**能构造出这个场景**
 * 才能验证检查器真的会发现它。没有写入工具，验证脚本只能去直接改数据库 ——
 * 那测的就不是产品能力了。
 *
 * ## 只读检查工具与写入工具分开
 *
 * `timeline.check` 是只读的（权限 READ），可以在任何阶段调用；
 * `timeline.addEvent` 是写入（权限 WRITE）。
 * 混在一起会让"只想看看时间线有没有问题"也需要写权限。
 */
import { z } from 'zod';
import { ErrorCode, timelineEventId } from '@nwa/core';
import type { Repositories } from '@nwa/storage';
import type { AnyToolDefinition } from '@nwa/shared';
import { TimelineChecker } from '@nwa/story';
import { Logger } from '@nwa/core';

export interface TimelineToolOptions {
  readonly resolveBookId: (explicit?: string | null) => string;
  readonly logger: Logger;
}

export function createTimelineTools(
  repos: Repositories,
  opts: TimelineToolOptions,
): AnyToolDefinition[] {
  const addEvent: AnyToolDefinition = {
    name: 'timeline.addEvent',
    description:
      '登记一条时间线事件（故事世界里发生了什么、什么时候、涉及谁、在哪）。' +
      '⚠ 时间线是"不可能事件"检查的依据：同一角色同一时刻出现在两地、' +
      '角色死后仍有行动，都会在 Commit 前被拦下。',
    inputSchema: z.object({
      bookId: z.string().optional(),
      title: z.string().min(1, '事件标题不得为空'),
      description: z.string().min(1, '事件描述不得为空'),
      /** 叙述章号（读者在第几章看到） */
      chapter: z.number().int().min(1),
      /** 章内偏移（可选） */
      offset: z.number().int().min(0).optional(),
      /** 故事时间（可计算，配合 unit）—— 与 storyTimeDisplay 二选一即可 */
      storyTimeValue: z.number().nullable().optional(),
      storyTimeUnit: z.enum(['minute', 'hour', 'day', 'week', 'month', 'year']).nullable().optional(),
      /** 时间原文（"21:30"、"第三天傍晚"）—— 没有 value 时由代码解析 */
      storyTimeDisplay: z.string().nullable().optional(),
      characters: z.array(z.string()).optional(),
      location: z.string().nullable().optional(),
      narrativeMode: z.enum(['FOREGROUND', 'FLASHBACK', 'ANTICIPATION']).optional(),
      importance: z.number().int().min(1).max(5).optional(),
    }),
    outputSchema: z.object({
      id: z.string(),
      /** 写入后可比较的故事时间（null = 不可比较，如实返回） */
      storyTimeValue: z.number().nullable(),
      storyTimeUnit: z.string().nullable(),
    }),
    permission: 'WRITE',
    errorCodes: [ErrorCode.TOOL_VALIDATION_ERROR, ErrorCode.STORAGE_QUERY_FAILED],
    execute: (input: {
      bookId?: string;
      title: string;
      description: string;
      chapter: number;
      offset?: number;
      storyTimeValue?: number | null;
      storyTimeUnit?: string | null;
      storyTimeDisplay?: string | null;
      characters?: string[];
      location?: string | null;
      narrativeMode?: 'FOREGROUND' | 'FLASHBACK' | 'ANTICIPATION';
      importance?: number;
    }) => {
      const bookId = opts.resolveBookId(input.bookId);
      const id = timelineEventId({
        bookId,
        chapter: input.chapter,
        offset: input.offset ?? 0,
        title: input.title,
      });
      const row = repos.timeline.create({
        id,
        bookId,
        title: input.title,
        description: input.description,
        storyTimeValue: input.storyTimeValue ?? null,
        storyTimeUnit: input.storyTimeUnit ?? null,
        storyTimeDisplay: input.storyTimeDisplay ?? null,
        narrativeChapter: input.chapter,
        narrativeOffset: input.offset ?? 0,
        importance: input.importance ?? 1,
        data: {
          ...(input.characters && input.characters.length > 0
            ? { characters: input.characters }
            : {}),
          ...(input.location ? { location: input.location } : {}),
          ...(input.narrativeMode ? { narrativeMode: input.narrativeMode } : {}),
        },
      });
      return {
        id: row.id,
        storyTimeValue: row.story_time_value,
        storyTimeUnit: row.story_time_unit,
      };
    },
  };

  const check: AnyToolDefinition = {
    name: 'timeline.check',
    description:
      '检查时间线一致性（只读）。报出故事时间倒退、同一角色两地同时出现、' +
      '角色死后仍有行动。⚠ BLOCKING 会在 Commit 前拦下提交。',
    inputSchema: z.object({ bookId: z.string().optional() }),
    outputSchema: z.object({
      eventCount: z.number(),
      /** ⚠ 可比较数必须单独返回：全是"不可比较"时事件再多也检查不了 */
      comparableCount: z.number(),
      blockingCount: z.number(),
      warningCount: z.number(),
      issues: z.array(
        z.object({
          code: z.string(),
          severity: z.string(),
          message: z.string(),
          chapters: z.array(z.number()),
        }),
      ),
      limitations: z.array(z.string()),
    }),
    permission: 'READ',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
    execute: (input: { bookId?: string }) => {
      const bookId = opts.resolveBookId(input.bookId);
      const checker = new TimelineChecker({
        repo: repos.timeline,
        logger: opts.logger.child('timeline'),
        bookId,
      });
      const report = checker.check();
      return {
        eventCount: report.eventCount,
        comparableCount: report.comparableCount,
        blockingCount: report.blockingCount,
        warningCount: report.warningCount,
        issues: report.issues.map((i) => ({
          code: i.code,
          severity: i.severity,
          message: i.message,
          chapters: [...i.chapters],
        })),
        limitations: [...report.limitations],
      };
    },
  };

  return [addEvent, check];
}
