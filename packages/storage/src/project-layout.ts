/**
 * 用户项目目录契约（施工计划 §6.1）
 *
 * ⚠ 这是**兼容性契约**：一旦有用户数据落盘，路径结构不得破坏性变更。
 *   变更需要迁移脚本 + ADR。
 *
 * 真源划分（§59）：
 *   真源      = chapters/*.md, summaries/*.md, project.db（结构化记录）
 *   派生      = FTS 索引（可 rebuild）、artifacts/index.json（导航，进事务）
 *   中间产物  = workspace/chapter-NNN/*（未验证，不属于真源）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppError, ErrorCode, chapterFileName, workspaceDirName } from '@nwa/core';

/** 项目目录下的固定子目录 */
export const PROJECT_DIRS = {
  canon: 'canon',
  canonCharacters: 'canon/characters',
  canonWorld: 'canon/world',
  canonTimeline: 'canon/timeline',
  canonFacts: 'canon/facts',
  chapters: 'chapters',
  summaries: 'summaries',
  workspace: 'workspace',
  corpus: 'corpus',
  skills: 'skills',
  exports: 'exports',
  backups: 'backups',
} as const;

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
    return root;
  }

  for (const d of Object.values(PROJECT_DIRS)) {
    mkdirSync(join(root, d), { recursive: true });
  }
  writeFileSync(
    join(root, PROJECT_META_FILE),
    JSON.stringify(meta, null, 2) + '\n',
    'utf8',
  );
  return root;
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

/** 项目内的路径辅助（集中定义，避免各处拼字符串） */
export function projectPaths(rootDir: string) {
  const root = resolve(rootDir);
  return {
    root,
    db: join(root, PROJECT_DB_FILE),
    meta: join(root, PROJECT_META_FILE),
    chapter: (n: number) => join(root, PROJECT_DIRS.chapters, chapterFileName(n)),
    summary: (n: number) => join(root, PROJECT_DIRS.summaries, chapterFileName(n)),
    workspace: (n: number) => join(root, PROJECT_DIRS.workspace, workspaceDirName(n)),
    /** 工作区内的中间产物（施工文档 §9 的 10 个文件） */
    workspaceFile: (n: number, file: WorkspaceFile) => join(root, PROJECT_DIRS.workspace, workspaceDirName(n), file),
    canonCharacters: join(root, PROJECT_DIRS.canonCharacters),
    canonWorld: join(root, PROJECT_DIRS.canonWorld),
    canonTimeline: join(root, PROJECT_DIRS.canonTimeline),
    canonFacts: join(root, PROJECT_DIRS.canonFacts),
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

/** 创建一个章节的工作区目录 */
export function ensureChapterWorkspace(rootDir: string, chapterNumber: number): string {
  const dir = projectPaths(rootDir).workspace(chapterNumber);
  mkdirSync(dir, { recursive: true });
  return dir;
}
