/**
 * 集成测试的共享脚手架
 *
 * 每个测试用独立的临时项目目录 + 独立 DB，避免相互污染。
 * 用 ':memory:' 会掩盖 WAL / 文件锁相关的问题，因此这里用真实文件。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, MIGRATIONS, createRepositories, scaffoldProjectDir, now, type Repositories } from '@nwa/storage';
import { bookId, chapterId, projectId, characterId } from '@nwa/core';

export interface TestProject {
  readonly dir: string;
  readonly db: Database;
  readonly repos: Repositories;
  readonly projectId: string;
  readonly bookId: string;
  cleanup(): void;
}

let counter = 0;

/** 建一个已迁移、已初始化一个项目 + 一本书的测试环境 */
export function createTestProject(): TestProject {
  const dir = mkdtempSync(join(tmpdir(), `nwa-test-${process.pid}-${++counter}-`));
  const pid = projectId();
  const bid = bookId();

  scaffoldProjectDir(dir, {
    id: pid,
    name: '测试项目',
    bookId: bid,
    title: '测试小说',
    createdAt: now(),
    schemaVersion: '0001_init',
  });

  const db = new Database({ path: join(dir, 'project.db'), migrations: MIGRATIONS });
  const repos = createRepositories(db);
  repos.projects.create({ id: pid, name: '测试项目', genre: 'urban_fantasy' });
  repos.books.create({ id: bid, projectId: pid, title: '测试小说' });

  return {
    dir,
    db,
    repos,
    projectId: pid,
    bookId: bid,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* 已关闭 */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export { chapterId, characterId };

/** 建一个章节（默认状态 DRAFT） */
export function makeChapter(t: TestProject, n: number, status = 'DRAFT') {
  return t.repos.chapters.create({
    id: chapterId(t.bookId, n),
    bookId: t.bookId,
    chapterNumber: n,
    title: `第 ${n} 章`,
    status,
  });
}
