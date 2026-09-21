/**
 * Project / Chapter 相关工具（施工文档 §6.3 的 MVP 子集）
 *
 * 权限约定：
 *   *.get / *.list  → READ
 *   *.create/update → WRITE
 *   chapter.plan    → PROPOSE_WRITE（产出计划但不落正式正文）
 */
import { z } from 'zod';
import { AppError, ErrorCode, chapterId, projectId } from '@nwa/core';
import { createPlanTools } from './plan-tools.js';
import {
  ChapterSchema,
  CreateChapterInputSchema,
  CreateProjectInputSchema,
  ProjectSchema,
  UpdateProjectInputSchema,
  type AnyToolDefinition,
  type ToolDefinition,
} from '@nwa/shared';
import type { Repositories } from '@nwa/storage';

/** 把 DB 行转成领域对象（snake_case → camelCase） */
function toProject(row: {
  id: string; name: string; genre: string | null; premise: string | null;
  status: string; created_at: string; updated_at: string;
}) {
  return {
    id: row.id, name: row.name, genre: row.genre, premise: row.premise,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function toChapter(row: {
  id: string; book_id: string; chapter_number: number; title: string | null;
  status: string; body_path: string | null; summary: string | null;
  created_at: string; updated_at: string;
}) {
  return {
    id: row.id, bookId: row.book_id, chapterNumber: row.chapter_number,
    title: row.title, status: row.status, plan: null,
    bodyPath: row.body_path, summary: row.summary,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function createProjectTools(repos: Repositories): AnyToolDefinition[] {
  const projectGet: ToolDefinition<{ id: string }, z.infer<typeof ProjectSchema>> = {
    name: 'project.get',
    description: '按 ID 获取项目详情',
    inputSchema: z.object({ id: z.string().min(1) }),
    outputSchema: ProjectSchema,
    permission: 'READ',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
    execute: ({ id }) => {
      const row = repos.projects.find(id);
      if (!row) {
        throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, `项目不存在：${id}`);
      }
      return toProject(row);
    },
  };

  const projectList: ToolDefinition<Record<string, never>, { projects: unknown[] }> = {
    name: 'project.list',
    description: '列出全部项目',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ projects: z.array(ProjectSchema) }),
    permission: 'READ',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
    execute: () => ({ projects: repos.projects.list().map(toProject) }),
  };

  const projectCreate: ToolDefinition<
    z.infer<typeof CreateProjectInputSchema>,
    z.infer<typeof ProjectSchema>
  > = {
    name: 'project.create',
    description: '创建新项目',
    inputSchema: CreateProjectInputSchema,
    outputSchema: ProjectSchema,
    permission: 'WRITE',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED, ErrorCode.TOOL_VALIDATION_ERROR],
    execute: (input) => {
      const row = repos.projects.create({
        id: projectId(),
        name: input.name,
        genre: input.genre ?? null,
        premise: input.premise ?? null,
      });
      return toProject(row);
    },
  };

  const projectUpdate: ToolDefinition<
    { id: string } & z.infer<typeof UpdateProjectInputSchema>,
    z.infer<typeof ProjectSchema>
  > = {
    name: 'project.update',
    description: '更新项目元数据',
    inputSchema: z.object({ id: z.string().min(1) }).and(UpdateProjectInputSchema),
    outputSchema: ProjectSchema,
    permission: 'WRITE',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
    execute: ({ id, ...patch }) => toProject(repos.projects.update(id, patch)),
  };

  return [projectGet, projectList, projectCreate, projectUpdate];
}

export function createChapterTools(repos: Repositories): AnyToolDefinition[] {
  const chapterList: ToolDefinition<{ bookId: string }, { chapters: unknown[] }> = {
    name: 'chapter.list',
    description: '列出某本书的全部章节（按章节号升序）',
    inputSchema: z.object({ bookId: z.string().min(1) }),
    outputSchema: z.object({ chapters: z.array(ChapterSchema) }),
    permission: 'READ',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
    execute: ({ bookId }) => ({
      chapters: repos.chapters.listByBook(bookId).map(toChapter),
    }),
  };

  const chapterGet: ToolDefinition<
    { bookId: string; chapterNumber: number },
    z.infer<typeof ChapterSchema>
  > = {
    name: 'chapter.get',
    description: '按书与章节号获取章节',
    inputSchema: z.object({
      bookId: z.string().min(1),
      chapterNumber: z.number().int().positive(),
    }),
    outputSchema: ChapterSchema,
    permission: 'READ',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
    execute: ({ bookId, chapterNumber }) => {
      const row = repos.chapters.getByNumber(bookId, chapterNumber);
      if (!row) {
        throw new AppError(
          ErrorCode.STORAGE_QUERY_FAILED,
          `章节不存在：${bookId} 第 ${chapterNumber} 章`,
        );
      }
      return toChapter(row);
    },
  };

  const chapterCreate: ToolDefinition<
    { bookId: string; chapterNumber: number; title?: string | null },
    z.infer<typeof ChapterSchema>
  > = {
    name: 'chapter.create',
    description: '创建章节（状态为 DRAFT，无正文）',
    inputSchema: z
      .object({ bookId: z.string().min(1) })
      .and(CreateChapterInputSchema),
    outputSchema: ChapterSchema,
    permission: 'WRITE',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED, ErrorCode.TOOL_VALIDATION_ERROR],
    execute: ({ bookId, chapterNumber, title }) => {
      const existing = repos.chapters.getByNumber(bookId, chapterNumber);
      if (existing) {
        // 幂等：已存在则直接返回，而不是报唯一约束错误
        return toChapter(existing);
      }
      const book = repos.books.get(bookId);
      const row = repos.chapters.create({
        id: chapterId(bookId, chapterNumber),
        bookId,
        chapterNumber,
        title: title ?? null,
      });
      // 推进 book 的进度指针（单调递增，由仓储保证）
      repos.books.advanceTo(book.id, chapterNumber);
      return toChapter(row);
    },
  };

  const chapterCountCommitted: ToolDefinition<{ bookId: string }, { count: number }> = {
    name: 'chapter.countCommitted',
    description: '统计已提交章节数（进度只信物理产物，不读 run 状态）',
    inputSchema: z.object({ bookId: z.string().min(1) }),
    outputSchema: z.object({ count: z.number().int().min(0) }),
    permission: 'READ',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
    execute: ({ bookId }) => ({ count: repos.chapters.countCommitted(bookId) }),
  };

  return [chapterList, chapterGet, chapterCreate, chapterCountCommitted];
}

export function createAllTools(repos: Repositories): AnyToolDefinition[] {
  return [
    ...createProjectTools(repos),
    ...createChapterTools(repos),
    // STEP 6：计划相关工具（chapter.plan / chapter.getPlan）
    ...createPlanTools(repos),
  ];
}
