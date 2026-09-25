/**
 * 用户项目目录契约（施工计划 §6.1）
 *
 * ⚠ 这是**兼容性契约**：一旦有用户数据落盘，路径结构不得破坏性变更。
 *   变更需要迁移脚本 + ADR。
 *
 * ⚠⚠ 按书隔离（审查报告 P0-1，2026-09-25 修订）
 *
 * 原先 chapters/ summaries/ workspace/ 三个目录在**项目根**下，路径只由
 * 章号拼成。而 DB 是 `UNIQUE(book_id, chapter_number)` —— 允许两本书各有
 * 第 1 章。于是两书同章号映射到同一个文件，提交 B 书会**覆盖** A 书正文，
 * 而 A 书的行仍是 COMMITTED、body_path 仍指向该文件（系统认为它还在）。
 *
 * 现在按书分目录：
 *
 *     books/<bookId>/chapters/001.md
 *     books/<bookId>/summaries/001.md
 *     books/<bookId>/workspace/chapter-001/
 *
 * 相对路径的唯一定义在 `@nwa/core` 的 `paths.ts`；本模块负责拼成绝对路径。
 *
 * 真源划分（§59）：
 *   真源      = books/<id>/chapters/*.md, books/<id>/summaries/*.md, project.db
 *   派生      = FTS 索引（可 rebuild）、artifacts/index.json（导航，进事务）
 *   中间产物  = books/<id>/workspace/chapter-NNN/*（未验证，不属于真源）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AppError,
  ErrorCode,
  assertSafeBookId,
  bookChaptersDirRel,
  bookRootRel,
  bookSummariesDirRel,
  bookWorkspaceDirRel,
  chapterRel,
  summaryRel,
  workspaceFileRel,
  workspaceRel,
} from '@nwa/core';

/** 项目目录下的固定子目录 */
export const PROJECT_DIRS = {
  canon: 'canon',
  canonCharacters: 'canon/characters',
  canonWorld: 'canon/world',
  canonTimeline: 'canon/timeline',
  canonFacts: 'canon/facts',
  /**
   * 按书隔离的根目录：`books/<bookId>/…`。
   *
   * ⚠ 这三个名字（chapters / summaries / workspace）**同时是旧布局的目录名**
   *   （项目根下的 chapters/ 等）。它们仍保留在此，只用于**迁移时读取老项目**，
   *   新写入一律走 `projectPaths(rootDir, bookId)`。
   */
  books: 'books',
  chapters: 'chapters',
  summaries: 'summaries',
  workspace: 'workspace',
  corpus: 'corpus',
  skills: 'skills',
  exports: 'exports',
  backups: 'backups',
} as const;

/** 旧布局（项目根下、不分书）的三个目录 —— 仅迁移用 */
export const LEGACY_BOOK_DIRS = ['chapters', 'summaries', 'workspace'] as const;

export const PROJECT_DB_FILE = 'project.db';
export const PROJECT_META_FILE = 'project.json';

/** project.json 的形状（DB 的可读副本，只读用途；真源仍是 DB） */
export interface ProjectMeta {
  readonly id: string;
  readonly name: string;
  readonly bookId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly schemaVersion: string;
}

/**
 * 创建一个新项目的目录结构。
 *
 * 幂等：已存在的目录不报错（用户可能重复打开）。
 * 已存在 project.json 时**不覆盖** —— 那会丢掉原始创建时间。
 */
export function scaffoldProjectDir(rootDir: string, meta: ProjectMeta): string {
  const root = resolve(rootDir);
  if (existsSync(join(root, PROJECT_META_FILE)) === false) {
    mkdirSync(root, { recursive: true });
  } else {
    // 已有项目：只补齐缺失的子目录，不改动元数据
    for (const d of Object.values(PROJECT_DIRS)) {
      mkdirSync(join(root, d), { recursive: true });
    }
    ensureBookDirs(root, meta.bookId);
    return root;
  }

  for (const d of Object.values(PROJECT_DIRS)) {
    mkdirSync(join(root, d), { recursive: true });
  }
  ensureBookDirs(root, meta.bookId);
  writeFileSync(
    join(root, PROJECT_META_FILE),
    JSON.stringify(meta, null, 2) + '\n',
    'utf8',
  );
  return root;
}

/**
 * 建一本书的三个目录（幂等）。
 *
 * ⚠ 新项目**只建 meta.bookId 那一本**，不是"给每本书都建" ——
 *   多书是后续 `book.create` 时按需创建的（`ensureChapterWorkspace`
 *   等写路径也会顺带补建）。这里建的是"项目自带的初始书"，
 *   否则新项目一打开，连第一章的工作区父目录都不存在。
 */
export function ensureBookDirs(rootDir: string, bookId: string): void {
  const root = resolve(rootDir);
  assertSafeBookId(bookId);
  mkdirSync(join(root, bookChaptersDirRel(bookId)), { recursive: true });
  mkdirSync(join(root, bookSummariesDirRel(bookId)), { recursive: true });
  mkdirSync(join(root, bookWorkspaceDirRel(bookId)), { recursive: true });
}

export function readProjectMeta(rootDir: string): ProjectMeta {
  const p = join(resolve(rootDir), PROJECT_META_FILE);
  if (!existsSync(p)) {
    throw new AppError(ErrorCode.WORKSPACE_CORRUPTED, `不是有效的项目目录（缺少 ${PROJECT_META_FILE}）：${rootDir}`);
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ProjectMeta;
  } catch (cause) {
    throw new AppError(ErrorCode.WORKSPACE_CORRUPTED, `${PROJECT_META_FILE} 不是合法 JSON`, {
      cause,
      details: { path: p },
    });
  }
}

/**
 * 项目内的路径辅助（集中定义，避免各处拼字符串）。
 *
 * ⚠ `bookId` **必填**：章节/摘要/工作区都是按书的，缺了它就会退回
 *   不分书的旧布局 —— 那正是 P0-1 的成因（两书同章号互相覆盖）。
 *   设为必填而不是可选，是为了让"忘记传书"在**编译期**就暴露，
 *   而不是运行期静默写错文件。
 */
export function projectPaths(rootDir: string, bookId: string) {
  const root = resolve(rootDir);
  assertSafeBookId(bookId);
  return {
    root,
    bookId,
    db: join(root, PROJECT_DB_FILE),
    meta: join(root, PROJECT_META_FILE),
    /** 本书在项目内的根目录：<root>/books/<bookId> */
    bookRoot: join(root, bookRootRel(bookId)),
    chaptersDir: join(root, bookChaptersDirRel(bookId)),
    summariesDir: join(root, bookSummariesDirRel(bookId)),
    workspaceDir: join(root, bookWorkspaceDirRel(bookId)),
    chapter: (n: number) => join(root, chapterRel(bookId, n)),
    summary: (n: number) => join(root, summaryRel(bookId, n)),
    workspace: (n: number) => join(root, workspaceRel(bookId, n)),
    /** 工作区内的中间产物（施工文档 §9 的 10 个文件） */
    workspaceFile: (n: number, file: WorkspaceFile) =>
      join(root, workspaceFileRel(bookId, n, file)),
    canonCharacters: join(root, PROJECT_DIRS.canonCharacters),
    canonWorld: join(root, PROJECT_DIRS.canonWorld),
    canonTimeline: join(root, PROJECT_DIRS.canonTimeline),
    canonFacts: join(root, PROJECT_DIRS.canonFacts),
    exports: join(root, PROJECT_DIRS.exports),
    backups: join(root, PROJECT_DIRS.backups),
  };
}

/**
 * 不分书的项目级路径（DB / 元信息 / 导出 / 备份 / 技能 / 语料）。
 *
 * ⚠ 与 `projectPaths` 分开是为了**明确意图**：调用方要么明确知道
 *   自己在处理某本书，要么明确在处理项目级的东西。混用一个函数会让
 *   "这本书的章节在哪"与"项目数据库在哪"看起来一样。
 */
export function projectLevelPaths(rootDir: string) {
  const root = resolve(rootDir);
  return {
    root,
    db: join(root, PROJECT_DB_FILE),
    meta: join(root, PROJECT_META_FILE),
    books: join(root, PROJECT_DIRS.books),
    corpus: join(root, PROJECT_DIRS.corpus),
    skills: join(root, PROJECT_DIRS.skills),
    exports: join(root, PROJECT_DIRS.exports),
    backups: join(root, PROJECT_DIRS.backups),
  };
}

/** 工作区中间产物的文件名（施工文档 §9 的固定契约） */
export const WORKSPACE_FILES = [
  'plan.json',
  'context.json',
  'scene-plan.json',
  'draft.md',
  'review.json',
  'revision.md',
  'continuity.json',
  'proposed_facts.json',
  'proposed_state.json',
  'run.json',
] as const;

export type WorkspaceFile = (typeof WORKSPACE_FILES)[number];

/** 创建一个章节的工作区目录（按书隔离） */
export function ensureChapterWorkspace(
  rootDir: string,
  bookId: string,
  chapterNumber: number,
): string {
  const dir = projectPaths(rootDir, bookId).workspace(chapterNumber);
  mkdirSync(dir, { recursive: true });
  return dir;
}
