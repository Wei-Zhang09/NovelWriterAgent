/**
 * 项目内路径的**唯一来源**（按书隔离，施工计划 §6.1 修订）
 *
 * ## ⚠ 为什么必须按书隔离
 *
 * 原先的布局是：
 *
 *     chapters/001.md
 *     summaries/001.md
 *     workspace/chapter-001/
 *
 * 这些路径**只由章号拼成，不含书**。而数据库层是
 * `UNIQUE(book_id, chapter_number)`（`0001_init.sql:43`）—— 明确允许
 * A 书第 1 章与 B 书第 1 章同时存在。于是磁盘层这两章映射到**同一个文件**：
 *
 *   - 提交 A 书第 1 章 → 写 chapters/001.md
 *   - 提交 B 书第 1 章 → **覆盖** chapters/001.md
 *
 * 后果是静默且不可逆的：A 的正文被覆盖，但 A 的 `chapters` 行
 * `status` 仍是 COMMITTED、`body_path` 仍指向那个文件 ——
 * 系统认为 A 的正文还在。同一形态还波及 `workspace/` 下的
 * draft / review / manuscript / plan，以及 `versions/vNNN.md`
 * （两书各自的 seq 都从 1 起，B 的 v001 覆盖 A 的 v001）。
 *
 * 实测复现（审查报告 P0-1）：
 *
 *     提交 A 书第 1 章 → chapters/001.md = 【A 书的第 1 章正文】
 *     提交 B 书第 1 章 → chapters/001.md = 【B 书的第 1 章正文】
 *     A 行 body_path == B 行 body_path == 'chapters/001.md'
 *
 * 所以路径必须带书维度：`books/<bookId>/chapters/001.md`。
 *
 * ## ⚠ 为什么放在 core 且是纯字符串
 *
 * 路径拼错的表现是「文件写到 A 处、读从 B 处」—— 不报错、只是数据对不上。
 * 因此**只能有一处**定义。放在 core 是因为 harness / storage / story
 * 都依赖它，且这里是纯字符串（不用 `node:path`），
 * 绝对路径由调用方 `join(rootDir, rel)` 得到。
 */
import { AppError, ErrorCode } from './errors.js';

/**
 * 校验 bookId 可安全用于路径。
 *
 * ⚠ 这是安全边界：bookId 参与路径拼接，若可逃逸，就能写到项目外
 *   （例如 `../../../.ssh`）。正常来源是 `book_<uuid>`，但**不能依赖
 *   调用方传对** —— 恢复备份、外部导入都可能带来非预期值。
 */
export function assertSafeBookId(bookId: string): void {
  if (typeof bookId !== 'string' || bookId.length === 0) {
    throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, 'bookId 不能为空（路径需要按书隔离）');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(bookId)) {
    throw new AppError(
      ErrorCode.TOOL_VALIDATION_ERROR,
      `bookId 含不允许的字符（只允许字母数字下划线连字符）：${bookId}`,
    );
  }
}

/** 工作区目录名（施工计划 §6.1 的固定契约） */
export const workspaceDirName = (chapterNumber: number): string =>
  `chapter-${String(chapterNumber).padStart(3, '0')}`;

/** 章节正文文件名（施工计划 §6.1 的固定契约） */
export const chapterFileName = (chapterNumber: number): string =>
  `${String(chapterNumber).padStart(3, '0')}.md`;

/** 一本书在项目内的根目录（相对路径） */
export const bookRootRel = (bookId: string): string => `books/${bookId}`;

/** 正式正文目录（相对路径） */
export const bookChaptersDirRel = (bookId: string): string => `books/${bookId}/chapters`;

/** 摘要目录（相对路径） */
export const bookSummariesDirRel = (bookId: string): string => `books/${bookId}/summaries`;

/** 中间产物根目录（相对路径） */
export const bookWorkspaceDirRel = (bookId: string): string => `books/${bookId}/workspace`;

/** 章节正文（相对路径）—— 这是写进 `chapters.body_path` 的值 */
export function chapterRel(bookId: string, chapterNumber: number): string {
  assertSafeBookId(bookId);
  return `${bookChaptersDirRel(bookId)}/${chapterFileName(chapterNumber)}`;
}

/** 章节摘要（相对路径） */
export function summaryRel(bookId: string, chapterNumber: number): string {
  assertSafeBookId(bookId);
  return `${bookSummariesDirRel(bookId)}/${chapterFileName(chapterNumber)}`;
}

/** 某一章的工作区目录（相对路径） */
export function workspaceRel(bookId: string, chapterNumber: number): string {
  assertSafeBookId(bookId);
  return `${bookWorkspaceDirRel(bookId)}/${workspaceDirName(chapterNumber)}`;
}

/** 工作区内某个产物文件（相对路径） */
export function workspaceFileRel(bookId: string, chapterNumber: number, file: string): string {
  return `${workspaceRel(bookId, chapterNumber)}/${file}`;
}
