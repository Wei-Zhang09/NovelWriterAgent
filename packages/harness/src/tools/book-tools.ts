/**
 * 书目工具（施工文档 §52 Test A 的前置）
 *
 * ## ⚠ 为什么必须补这个
 *
 * 实测发现：**工具层没有 book.create**（只有 IPC `book.create`）。
 * 而章节必须挂在书上（`chapters.book_id` NOT NULL）——
 * 所以"新建项目 → 建书 → 建章 → 写正文"这条工具驱动的链路
 * **在建书这一步就断了**。
 *
 * 这解释了为什么 §52 Test A 一直无法执行：它要求
 * `create project → add character → ...`，但项目建好后
 * 没有任何工具能创建书，后续步骤全部无从落地。
 *
 * 与 `character.create`（存储层完整、工具缺失）、
 * `detectProseIssues`（写了没接线）是同一类缺陷 —— 底层齐备，
 * 使用者够不到，而代码审查看不出来。
 *
 * ## 多书隔离
 *
 * 建书时必须显式给 `projectId`，不猜测"当前项目"。
 * `resolveBookId` 那套"缺省回退"只用于**读取**（且已有源码级防回退测试），
 * 写入路径一律要求显式指定，避免写错书。
 */
import { z } from 'zod';
import { ErrorCode, bookId } from '@nwa/core';
import type { Repositories } from '@nwa/storage';
import type { AnyToolDefinition } from '@nwa/shared';

export function createBookTools(repos: Repositories): AnyToolDefinition[] {
  const create: AnyToolDefinition = {
    name: 'book.create',
    description:
      '在项目下创建一本书（§52 Test A 的前置）。' +
      '⚠ 必须显式给 projectId —— 不猜测"当前项目"，避免把书写到别处。',
    inputSchema: z.object({
      projectId: z.string().min(1, '必须显式指定 projectId'),
      title: z.string().min(1, '书名不得为空'),
    }),
    outputSchema: z.object({
      id: z.string(),
      projectId: z.string(),
      title: z.string(),
      currentChapter: z.number().int(),
    }),
    permission: 'WRITE',
    errorCodes: [ErrorCode.TOOL_VALIDATION_ERROR, ErrorCode.STORAGE_QUERY_FAILED],
    execute: (input: { projectId: string; title: string }) => {
      // ⚠ 校验项目存在：不存在的 projectId 直接报错，
      //   不静默回退到"第一个项目" —— 静默回退会把书写到别处，
      //   而用户看不出来（这正是多书隔离事故的成因，见 HANDOVER 第十九轮）。
      const proj = repos.projects.list().find((p) => p.id === input.projectId);
      if (!proj) {
        throw new Error(`项目不存在：${input.projectId}`);
      }
      const row = repos.books.create({
        id: bookId(),
        projectId: input.projectId,
        title: input.title.trim(),
      });
      return {
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        currentChapter: row.current_chapter,
      };
    },
  };

  const list: AnyToolDefinition = {
    name: 'book.list',
    description: '列出项目下的全部书目（多书隔离下用于确认"在写哪一本"）。',
    inputSchema: z.object({ projectId: z.string().min(1) }),
    outputSchema: z.object({
      books: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          currentChapter: z.number().int(),
        }),
      ),
    }),
    permission: 'READ',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
    execute: ({ projectId }: { projectId: string }) => ({
      books: repos.books.listByProject(projectId).map((b) => ({
        id: b.id,
        title: b.title,
        currentChapter: b.current_chapter,
      })),
    }),
  };

  return [create, list];
}
