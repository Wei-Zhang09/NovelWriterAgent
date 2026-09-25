/**
 * 旧布局迁移（P0-1 的配套）
 *
 * ## 为什么必须有这个迁移
 *
 * 布局从
 *
 *     chapters/001.md
 *     summaries/001.md
 *     workspace/chapter-001/
 *
 * 改成
 *
 *     books/<bookId>/chapters/001.md
 *     books/<bookId>/summaries/001.md
 *     books/<bookId>/workspace/chapter-001/
 *
 * 升级后读取路径换了，而老项目的文件还在老地方 —— **不迁移就等于
 * 旧正文突然"消失"**：DB 里 `body_path` 仍写着 `chapters/001.md`，
 * 章节列表显示"已提交"，点开却是空的。用户会以为数据丢了。
 *
 * ## 测试重点
 *
 * 不是"函数返回了 report"，而是**搬完之后文件真的在新位置、
 * 内容逐字不变**。以及三条容易做错的边界：
 *
 *   - 幂等：跑两次不会搬两遍、不会覆盖
 *   - 不猜归属：两本书都声称拥有同一章时不静默复制给两本
 *   - 老文件保留：搬完旧目录进 `.legacy-layout/`，不删除
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Logger, bookRootRel, bookId, projectId } from '@nwa/core';
import {
  Database,
  MIGRATIONS,
  createRepositories,
  scaffoldProjectDir,
  migrateLegacyLayout,
  needsLayoutMigration,
  readLayoutMigrationReport,
  LAYOUT_MARKER_FILE,
  LEGACY_BACKUP_DIR,
  now,
} from '@nwa/storage';

const logger = new Logger('test:layout-migration', { level: 'error' });

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nwa-layoutmig-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly db: Database;
  readonly bid: string;
  readonly chapterId: string;
}

/** 造一个"老项目"：DB 里有一本书第 1 章，磁盘上是旧布局 */
function makeLegacyProject(opts?: { withSecondBook?: boolean }): Fixture {
  const pid = projectId();
  const bid = bookId();
  scaffoldProjectDir(root, {
    id: pid,
    name: '老项目',
    bookId: bid,
    title: '旧书',
    createdAt: now(),
    schemaVersion: '0001_init',
  });

  const db = new Database({ path: join(root, 'project.db'), migrations: MIGRATIONS });
  const repos = createRepositories(db);
  repos.projects.create({ id: pid, name: '老项目', genre: 'urban_fantasy' });
  repos.books.create({ id: bid, projectId: pid, title: '旧书' });

  const chapterId = `chapter_${bid}_001`;
  repos.chapters.create({
    id: chapterId,
    bookId: bid,
    chapterNumber: 1,
    title: '第 1 章',
    status: 'COMMITTED',
  });
  // 旧布局的 body_path（不含书）
  // 老项目的 body_path 是旧布局（不含书）—— 这正是迁移要处理的
  repos.chapters.setCommittedBody(chapterId, 'chapters/001.md', '旧摘要');

  if (opts?.withSecondBook) {
    const bid2 = bookId();
    repos.books.create({ id: bid2, projectId: pid, title: '第二本' });
    repos.chapters.create({
      id: `chapter_${bid2}_001`,
      bookId: bid2,
      chapterNumber: 1,
      title: '第二本第 1 章',
      status: 'COMMITTED',
    });
  }

  // 磁盘上的旧布局文件
  mkdirSync(join(root, 'chapters'), { recursive: true });
  writeFileSync(join(root, 'chapters', '001.md'), '【旧布局的第 1 章正文】', 'utf8');
  mkdirSync(join(root, 'summaries'), { recursive: true });
  writeFileSync(join(root, 'summaries', '001.md'), '旧摘要', 'utf8');
  const wsDir = join(root, 'workspace', 'chapter-001');
  mkdirSync(join(wsDir, 'versions'), { recursive: true });
  writeFileSync(join(wsDir, 'manuscript.md'), '用户手写的未提交正文', 'utf8');
  writeFileSync(join(wsDir, 'versions', 'v001.md'), '第一版', 'utf8');

  return { db, bid, chapterId };
}

describe('旧布局迁移（P0-1）', () => {
  it('⚠⚠ 旧正文搬到 books/<bookId>/chapters/001.md，内容逐字不变', () => {
    const f = makeLegacyProject();

    const report = migrateLegacyLayout(root, f.db, logger);
    expect(report.alreadyDone).toBe(false);
    expect(report.movedFiles).toBeGreaterThan(0);

    // ⚠ 下游终点：新位置的文件真的存在且内容对
    const newPath = join(root, bookRootRel(f.bid), 'chapters', '001.md');
    expect(existsSync(newPath)).toBe(true);
    expect(readFileSync(newPath, 'utf8')).toBe('【旧布局的第 1 章正文】');

    // 摘要
    expect(readFileSync(join(root, bookRootRel(f.bid), 'summaries', '001.md'), 'utf8')).toBe(
      '旧摘要',
    );

    // 工作区（含子目录 versions/）
    const ws = join(root, bookRootRel(f.bid), 'workspace', 'chapter-001');
    expect(readFileSync(join(ws, 'manuscript.md'), 'utf8')).toBe('用户手写的未提交正文');
    expect(readFileSync(join(ws, 'versions', 'v001.md'), 'utf8')).toBe('第一版');

    f.db.close();
  });

  it('⚠ 迁移幂等：第二次调用不再搬，且不覆盖已迁移的内容', () => {
    const f = makeLegacyProject();
    migrateLegacyLayout(root, f.db, logger);

    const second = migrateLegacyLayout(root, f.db, logger);
    expect(second.alreadyDone).toBe(true);
    expect(second.movedFiles).toBe(0);

    // 内容仍是对的（没被搬第二遍弄坏）
    expect(readFileSync(join(root, bookRootRel(f.bid), 'chapters', '001.md'), 'utf8')).toBe(
      '【旧布局的第 1 章正文】',
    );
    f.db.close();
  });

  it('⚠ 旧目录被移进 .legacy-layout/ 保留，不删除（迁移有 bug 时能找回）', () => {
    const f = makeLegacyProject();
    const report = migrateLegacyLayout(root, f.db, logger);

    // 返回的是绝对路径（便于日志/UI 直接展示给用户去哪里找）
    expect(report.legacyMovedTo).toBe(join(root, LEGACY_BACKUP_DIR));
    // 原位置已空
    expect(existsSync(join(root, 'chapters'))).toBe(false);
    // 但内容在 .legacy-layout/ 里还在
    expect(
      readFileSync(join(root, LEGACY_BACKUP_DIR, 'chapters', '001.md'), 'utf8'),
    ).toBe('【旧布局的第 1 章正文】');
    f.db.close();
  });

  it('⚠ 迁移标记文件记录了归属与未决项（可审计）', () => {
    const f = makeLegacyProject();
    migrateLegacyLayout(root, f.db, logger);

    expect(existsSync(join(root, LAYOUT_MARKER_FILE))).toBe(true);
    const report = readLayoutMigrationReport(root);
    expect(report).not.toBeNull();
    expect(report!.byBook.map((b) => b.bookId)).toContain(f.bid);
    expect(report!.movedFiles).toBeGreaterThan(0);
    f.db.close();
  });

  it('⚠ 两本书都声称拥有第 1 章 → 归给最早的那本，并记入 unresolved（不静默复制）', () => {
    const f = makeLegacyProject({ withSecondBook: true });
    const report = migrateLegacyLayout(root, f.db, logger);

    // 必须如实报出冲突，而不是装作无事发生
    expect(report.unresolved.length).toBeGreaterThan(0);
    expect(report.unresolved.join('\n')).toContain('都声称拥有第 1 章');

    // 只搬到一本（不复制给两本 —— 那会让一本读到另一本的正文）
    const booksDir = join(root, 'books');
    const owners = readdirSync(booksDir).filter((b) =>
      existsSync(join(booksDir, b, 'chapters', '001.md')),
    );
    expect(owners).toHaveLength(1);
    expect(owners[0]).toBe(f.bid);
    f.db.close();
  });

  it('⚠ DB 里没有对应章节的旧文件 → 记入 unresolved，不丢弃', () => {
    const f = makeLegacyProject();
    // 多放一个 DB 里不存在的第 9 章
    writeFileSync(join(root, 'chapters', '009.md'), '孤儿文件', 'utf8');

    const report = migrateLegacyLayout(root, f.db, logger);
    expect(report.unresolved.join('\n')).toContain('009.md');
    // 原文件仍在（留在 .legacy-layout 里）
    expect(readFileSync(join(root, LEGACY_BACKUP_DIR, 'chapters', '009.md'), 'utf8')).toBe(
      '孤儿文件',
    );
    f.db.close();
  });

  it('⚠ 新项目（旧目录为空）不触发迁移', () => {
    const pid = projectId();
    const bid = bookId();
    scaffoldProjectDir(root, {
      id: pid,
      name: '新项目',
      bookId: bid,
      title: '新书',
      createdAt: now(),
      schemaVersion: '0001_init',
    });
    // scaffoldProjectDir 会建空的 chapters/ summaries/ workspace/ —— 但不该触发迁移
    expect(needsLayoutMigration(root)).toBe(false);

    const db = new Database({ path: join(root, 'project.db'), migrations: MIGRATIONS });
    const report = migrateLegacyLayout(root, db, logger);
    expect(report.alreadyDone).toBe(true);
    db.close();
  });

  it('⚠ 目标已存在同名文件时不覆盖（新布局里已有更新数据）', () => {
    const f = makeLegacyProject();
    // 预先在新位置放一份"更新的"内容
    const dstDir = join(root, bookRootRel(f.bid), 'chapters');
    mkdirSync(dstDir, { recursive: true });
    writeFileSync(join(dstDir, '001.md'), '新布局里已有的内容', 'utf8');

    migrateLegacyLayout(root, f.db, logger);

    // ⚠ 不能被旧内容覆盖
    expect(readFileSync(join(dstDir, '001.md'), 'utf8')).toBe('新布局里已有的内容');
    f.db.close();
  });
});
