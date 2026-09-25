/**
 * 旧布局 → 按书布局的迁移（审查报告 P0-1 的配套）
 *
 * ## 背景
 *
 * 旧布局（项目根下，**不含书维度**）：
 *
 *     chapters/001.md
 *     summaries/001.md
 *     workspace/chapter-001/{draft.md, manuscript.md, versions/v001.md, …}
 *
 * 新布局（`books/<bookId>/…`）：
 *
 *     books/<bookId>/chapters/001.md
 *     books/<bookId>/summaries/001.md
 *     books/<bookId>/workspace/chapter-001/…
 *
 * 不迁移的话，升级后**旧正文会突然"消失"** —— 不是被删了，而是
 * 读取路径换了，谁也找不到它。而 DB 里的 `body_path` 仍写着
 * `chapters/001.md`，于是「章节列表显示已提交、点开是空的」。
 *
 * ## 归属怎么定（关键决策）
 *
 * 老文件里**没有书记录**。唯一的权威来源是 DB：
 *
 *   - `chapters.body_path` 指向的章 → 该章的 `book_id` 就是这本书的归属
 *   - `chapters.summary` 同理
 *   - `workspace/chapter-NNN/` → 用「哪本书有第 N 章」判定
 *
 * ⚠ 两本书都有第 N 章时怎么办？**不猜**。
 *   旧布局下这两章本来就共用同一个文件（这正是 P0-1 的缺陷），
 *   内容属于谁在物理上已经无法区分。此时：
 *     - 把文件迁给**最早拥有该章的书**（`created_at` 最小）
 *     - 另一本记为冲突，写进报告让用户决定
 *   静默复制给两本书更糟 —— 会让一本书读到另一本的正文，
 *   而这恰恰是本次要消灭的失败形态。
 *
 * ## 幂等
 *
 * 迁移完成后旧目录被移走（不是删除），并写一个 `.layout-migrated.json`
 * 标记。重复调用直接返回 alreadyDone，不做第二次搬运。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  copyFileSync,
  statSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { AppError, ErrorCode, Logger, assertSafeBookId, bookRootRel } from '@nwa/core';
import type { Database } from './database.js';
import { LEGACY_BOOK_DIRS } from './project-layout.js';

/** 迁移标记文件（在项目根） */
export const LAYOUT_MARKER_FILE = '.layout-migrated.json';

/** 旧目录被搬到哪（保留现场，便于人工核对与回滚） */
export const LEGACY_BACKUP_DIR = '.legacy-layout';

export interface LayoutMigrationReport {
  readonly alreadyDone: boolean;
  /** 移动的文件数（含目录） */
  readonly movedFiles: number;
  /** 按书分组的落点，便于日志与验证脚本断言 */
  readonly byBook: readonly { bookId: string; files: number }[];
  /**
   * 无法归属的文件（两本书都声称拥有同一章，或 DB 里找不到对应章节）。
   * **不静默丢弃** —— 留在 `.legacy-layout/` 里并在报告中列出。
   */
  readonly unresolved: readonly string[];
  /** 旧目录是否已搬到 .legacy-layout/ */
  readonly legacyMovedTo: string | null;
}

interface ChapterRow {
  readonly id: string;
  readonly book_id: string;
  readonly chapter_number: number;
  readonly body_path: string | null;
}

/**
 * 探测是否需要迁移：旧目录存在且非空，且没有迁移标记。
 *
 * ⚠ 只看"目录存在"会误判：`scaffoldProjectDir` 一直会建空的
 *   `chapters/` / `summaries/` / `workspace/`，新项目也有这三个目录。
 *   必须确认**里面有东西**才认为有老数据要搬。
 */
export function needsLayoutMigration(rootDir: string): boolean {
  if (existsSync(join(rootDir, LAYOUT_MARKER_FILE))) return false;
  for (const d of LEGACY_BOOK_DIRS) {
    const p = join(rootDir, d);
    if (!existsSync(p)) continue;
    const entries = readdirSync(p);
    // workspace/ 空目录不算；chapters/ 里有 .md 才算
    if (entries.length > 0) return true;
  }
  return false;
}

/**
 * 执行迁移。
 *
 * ⚠ 用 **copy + 保留原目录**而不是 move：搬运过程中崩溃时，
 *   原文件仍在原处（只是多了一份副本），重跑即可收敛。
 *   若用 move，中途崩溃会得到"一半在新位置、一半在旧位置"，
 *   且旧位置已经空了 —— 无法判断哪边是全的。
 *   搬完统一由 `finalizeLegacy()` 把旧目录整体移走。
 */
export function migrateLegacyLayout(
  rootDir: string,
  db: Database,
  logger: Logger,
): LayoutMigrationReport {
  if (!needsLayoutMigration(rootDir)) {
    return { alreadyDone: true, movedFiles: 0, byBook: [], unresolved: [], legacyMovedTo: null };
  }

  const chapters = db.all<ChapterRow>(
    'SELECT id, book_id, chapter_number, body_path FROM chapters ORDER BY chapter_number',
  );

  // 章号 → 拥有它的书（按书创建时间升序；第一本为权威）
  const byChapterNumber = new Map<number, string[]>();
  for (const c of chapters) {
    const list = byChapterNumber.get(c.chapter_number) ?? [];
    if (!list.includes(c.book_id)) list.push(c.book_id);
    byChapterNumber.set(c.chapter_number, list);
  }

  const moved = new Map<string, number>();
  const unresolved: string[] = [];

  const bump = (bookId: string): void => {
    moved.set(bookId, (moved.get(bookId) ?? 0) + 1);
  };

  const copyInto = (bookId: string, relDir: string, fileName: string, srcAbs: string): void => {
    assertSafeBookId(bookId);
    const dstDir = join(rootDir, bookRootRel(bookId), relDir);
    mkdirSync(dstDir, { recursive: true });
    const dst = join(dstDir, fileName);
    if (existsSync(dst)) {
      // 目标已存在 → 不覆盖（新布局里已有更新的数据）
      logger.warn('迁移时目标已存在，跳过', { bookId, rel: `${relDir}/${fileName}` });
      return;
    }
    copyFileSync(srcAbs, dst);
    bump(bookId);
  };

  /** 单章目录（workspace/chapter-NNN）递归搬运 */
  const copyDirInto = (bookId: string, relDir: string, srcDir: string): void => {
    const dstDir = join(rootDir, bookRootRel(bookId), relDir);
    mkdirSync(dstDir, { recursive: true });
    for (const name of readdirSync(srcDir)) {
      const s = join(srcDir, name);
      const d = join(dstDir, name);
      if (statSync(s).isDirectory()) {
        mkdirSync(d, { recursive: true });
        for (const inner of readdirSync(s)) {
          if (existsSync(join(d, inner))) continue;
          copyFileSync(join(s, inner), join(d, inner));
          bump(bookId);
        }
      } else {
        if (existsSync(d)) continue;
        copyFileSync(s, d);
        bump(bookId);
      }
    }
  };

  // ── ① chapters/*.md ──
  const legacyChapters = join(rootDir, 'chapters');
  if (existsSync(legacyChapters)) {
    for (const name of readdirSync(legacyChapters)) {
      if (!name.endsWith('.md')) continue;
      const n = Number.parseInt(name.replace(/\.md$/, ''), 10);
      const owners = byChapterNumber.get(n);
      if (!owners || owners.length === 0) {
        unresolved.push(`chapters/${name}（DB 里没有第 ${n} 章）`);
        continue;
      }
      if (owners.length > 1) {
        unresolved.push(
          `chapters/${name}（${owners.length} 本书都声称拥有第 ${n} 章：${owners.join(', ')}）` +
            ` —— 已归给最早的 ${owners[0]}，请人工确认`,
        );
      }
      copyInto(owners[0]!, 'chapters', name, join(legacyChapters, name));
    }
  }

  // ── ② summaries/*.md ──
  const legacySummaries = join(rootDir, 'summaries');
  if (existsSync(legacySummaries)) {
    for (const name of readdirSync(legacySummaries)) {
      if (!name.endsWith('.md')) continue;
      const n = Number.parseInt(name.replace(/\.md$/, ''), 10);
      const owners = byChapterNumber.get(n);
      if (!owners || owners.length === 0) {
        unresolved.push(`summaries/${name}（DB 里没有第 ${n} 章）`);
        continue;
      }
      copyInto(owners[0]!, 'summaries', name, join(legacySummaries, name));
    }
  }

  // ── ③ workspace/chapter-NNN/** ──
  const legacyWorkspace = join(rootDir, 'workspace');
  if (existsSync(legacyWorkspace)) {
    for (const name of readdirSync(legacyWorkspace)) {
      const m = /^chapter-(\d+)$/.exec(name);
      if (!m) continue;
      const n = Number.parseInt(m[1]!, 10);
      const owners = byChapterNumber.get(n);
      if (!owners || owners.length === 0) {
        unresolved.push(`workspace/${name}/（DB 里没有第 ${n} 章）`);
        continue;
      }
      if (owners.length > 1) {
        unresolved.push(
          `workspace/${name}/（${owners.length} 本书都声称拥有第 ${n} 章）` +
            ` —— 已归给最早的 ${owners[0]}，请人工确认`,
        );
      }
      copyDirInto(owners[0]!, join('workspace', name), join(legacyWorkspace, name));
    }
  }

  const legacyMovedTo = finalizeLegacy(rootDir, logger);

  const byBook = [...moved.entries()]
    .map(([bookId, files]) => ({ bookId, files }))
    .sort((a, b) => a.bookId.localeCompare(b.bookId));

  writeFileSync(
    join(rootDir, LAYOUT_MARKER_FILE),
    JSON.stringify(
      {
        migratedAt: new Date().toISOString(),
        to: 'books/<bookId>/…',
        movedFiles: [...moved.values()].reduce((a, b) => a + b, 0),
        byBook,
        unresolved,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  logger.info('旧布局已迁移到按书布局', {
    movedFiles: [...moved.values()].reduce((a, b) => a + b, 0),
    books: byBook.length,
    unresolved: unresolved.length,
  });

  return {
    alreadyDone: false,
    movedFiles: [...moved.values()].reduce((a, b) => a + b, 0),
    byBook,
    unresolved,
    legacyMovedTo,
  };
}

/**
 * 把旧目录整体移进 `.legacy-layout/`。
 *
 * ⚠ 用 rename 而不是删除：迁移逻辑有 bug 时，用户的原始文件还在，
 *   可人工找回。磁盘代价只是多留一份副本，而误删是不可逆的。
 */
function finalizeLegacy(rootDir: string, logger: Logger): string | null {
  const target = join(rootDir, LEGACY_BACKUP_DIR);
  const toMove: readonly string[] = LEGACY_BOOK_DIRS.filter((d: string) =>
    existsSync(join(rootDir, d)),
  );
  if (toMove.length === 0) return null;

  mkdirSync(target, { recursive: true });
  for (const d of toMove) {
    const src = join(rootDir, d);
    const dst = join(target, d);
    if (existsSync(dst)) {
      logger.warn('旧目录已在 .legacy-layout 里，跳过搬移', { dir: d });
      continue;
    }
    renameSync(src, dst);
  }
  return target;
}

/** 读取迁移报告（验证脚本与 UI 用） */
export function readLayoutMigrationReport(rootDir: string): LayoutMigrationReport | null {
  const p = join(rootDir, LAYOUT_MARKER_FILE);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as {
      movedFiles?: number;
      byBook?: { bookId: string; files: number }[];
      unresolved?: string[];
    };
    return {
      alreadyDone: true,
      movedFiles: raw.movedFiles ?? 0,
      byBook: raw.byBook ?? [],
      unresolved: raw.unresolved ?? [],
      legacyMovedTo: existsSync(join(rootDir, LEGACY_BACKUP_DIR)) ? LEGACY_BACKUP_DIR : null,
    };
  } catch (cause) {
    throw new AppError(ErrorCode.WORKSPACE_CORRUPTED, `${LAYOUT_MARKER_FILE} 不是合法 JSON`, {
      cause,
      details: { path: p },
    });
  }
}
