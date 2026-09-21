/**
 * 领域对象 Schema（施工文档 §55 Rule 3：所有跨包数据使用 Zod Schema）
 *
 * 约定：**DB 行（snake_case）与领域对象（camelCase）分离**。
 *   仓储返回原始行，边界层（此处）负责转换与校验。
 *   理由：让 DB 列名变更不直接冲击业务代码，也让非法数据在入口处暴露。
 */
import { z } from 'zod';

/** 时间戳：ISO 8601 UTC 字符串 */
const IsoTimestamp = z.string().datetime();

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1, '项目名不得为空'),
  genre: z.string().nullable(),
  premise: z.string().nullable(),
  status: z.string().min(1),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type Project = z.infer<typeof ProjectSchema>;

export const BookSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1, '书名不得为空'),
  currentChapter: z.number().int().min(0),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type Book = z.infer<typeof BookSchema>;

export const ChapterSchema = z.object({
  id: z.string().min(1),
  bookId: z.string().min(1),
  chapterNumber: z.number().int().positive('章节号从 1 开始'),
  title: z.string().nullable(),
  status: z.string().min(1),
  plan: z.unknown().nullable(),
  /** 只有 COMMITTED 的章节才有正式正文路径（§9.1） */
  bodyPath: z.string().nullable(),
  summary: z.string().nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type Chapter = z.infer<typeof ChapterSchema>;

/** 创建输入：只需要调用方必填的字段 */
export const CreateProjectInputSchema = z.object({
  name: z.string().min(1, '项目名不得为空').max(200),
  genre: z.string().max(100).nullable().optional(),
  premise: z.string().max(5000).nullable().optional(),
});
export type CreateProjectInputDto = z.infer<typeof CreateProjectInputSchema>;

export const CreateChapterInputSchema = z.object({
  chapterNumber: z.number().int().positive(),
  title: z.string().max(200).nullable().optional(),
});
export type CreateChapterInputDto = z.infer<typeof CreateChapterInputSchema>;

export const UpdateProjectInputSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  genre: z.string().max(100).nullable().optional(),
  premise: z.string().max(5000).nullable().optional(),
  status: z.string().max(50).optional(),
});
export type UpdateProjectInputDto = z.infer<typeof UpdateProjectInputSchema>;
