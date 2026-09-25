/**
 * ⚠ 多书隔离：提交路径的 FTS 索引归属（本轮修复）
 *
 * ## 这个缺陷长什么样
 *
 * `chapter_fts.book_id` 是**检索的隔离键** —— `FtsIndex.search()` 用
 * `WHERE (? IS NULL OR book_id = ?)` 过滤（`fts/index.ts:108`）。
 * 也就是说，这一列写错了，检索就会串书。
 *
 * 而这一列是**提交时写入的**，来源是 app 层注入的索引器：
 *
 *     // apps/desktop/src/main/core-process.ts（修复前）
 *     indexChapter: (input) => {
 *       fts.indexChapter({
 *         chapterId: input.chapterId,
 *         bookId: resolveBookId() ?? '',   // ← 缺陷
 *         ...
 *       });
 *     }
 *
 * `resolveBookId()` 未指定时**回退到"最近创建的书"**（不是最老的、
 * 也不是"本章所属的书"）。于是：
 *
 *   1. 给 B 书提交 → 正文被索引到 A 书名下
 *      → 搜 B 书会搜出 A 书的正文（**跨书污染**，用户硬要求禁止）
 *   2. 没有书时 → `?? ''` 写成空串
 *      → `book_id = ?` 永远不匹配空串 → 该章在**任何书里都搜不到**
 *        （静默丢内容：章节明明提交了，检索就是找不到）
 *
 * 两种形态都不会报错，且第二种连"搜出来是错的"都做不到 ——
 * 它是"搜不出来"，比串书更难发现。
 *
 * ## 为什么既有测试没抓到
 *
 * `verify:multibook`（14 条）验证的是 `chapter.list` / `canon.list` /
 * `search.query` 的**按书过滤行为**，但它**从不提交章节** ——
 * 所以 `chapter_fts` 一直是空的，"检索不串书"断言查的是
 * **一个没被写过的索引**，永远通过。
 *
 * 这与 M6 的 D 组假绿同源：**用例没走到缺陷真正生效的那条路径。**
 *
 * ## 本测试怎么抓
 *
 * 不走 Electron、不调模型：直接构造两个章节（分属 A/B 书）、
 * 跑**真实提交**、注入一个**记录 bookId 的假索引器**，
 * 然后断言索引器收到的 bookId 是章节真实所属的那本书。
 *
 * ⚠ 断言查的是**索引器实际收到的值**（数据流下游终点），
 *   不是 `CommitRequest` 里传了什么 —— 后者只是中间产物。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Logger , workspaceRel } from '@nwa/core';
import { createCommitTools } from '@nwa/harness';
import type { CommitSourceKey } from '@nwa/harness';
import { COMMIT_SOURCE_FILE } from '@nwa/harness';
import { createTestProject, makeChapter, type TestProject } from './helpers.js';

const logger = new Logger('test:fts-isolation', { level: 'error' });

let dir: string;
let t: TestProject | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nwa-ftsiso-'));
});

afterEach(() => {
  if (t) {
    t.cleanup();
    t = null;
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeWorkspace(
  bookId: string,
  chapterNumber: number,
  file: string,
  text: string,
): void {
  const d = join(dir, workspaceRel(bookId, chapterNumber));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), text, 'utf8');
}

/** 让章节通过审阅门禁（未审阅 = review_status NULL = 阻塞） */
function passReview(proj: TestProject, chapterId: string): void {
  proj.repos.chapters.saveReview(chapterId, { overallStatus: 'PASSED', issues: [] }, 'PASSED');
}

/**
 * 造一套提交工具，索引器**记录它收到的 bookId**。
 *
 * ⚠ 这是本测试的核心：把"索引器收到了什么"记下来。
 *   不记录的话，断言只能查 CommitRequest（上游中间产物）——
 *   而缺陷的形态恰恰是"上游传对了、下游写错了"。
 */
function toolsOf(proj: TestProject) {
  const indexed: { chapterId: string; bookId: string; chapterNumber: number }[] = [];
  const tools = createCommitTools({
    db: proj.db,
    repos: proj.repos,
    rootDir: dir,
    logger,
    readWorkspaceText: (bookId: string, chapterNumber: number, name: CommitSourceKey) => {
      const d = join(dir, workspaceRel(bookId, chapterNumber));
      const p = join(d, COMMIT_SOURCE_FILE[name]);
      return existsSync(p) ? readFileSync(p, 'utf8') : null;
    },
    indexer: {
      indexChapter: (input) => {
        indexed.push({
          chapterId: input.chapterId,
          bookId: input.bookId,
          chapterNumber: input.chapterNumber,
        });
      },
    },
  });
  return { tools, indexed };
}

describe('⚠ 多书隔离：提交路径的 FTS book_id 归属', () => {
  it('⚠⚠ 给 B 书提交 → 索引器收到的 bookId 必须是 B 书（不是 A 书）', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;

    // A 书先建（比 B 老）—— "取第一本 / 最近创建" 都会落到别的书上，
    // 正是缺陷形态的触发条件
    const bookB = proj.repos.books.create({
      id: 'book_zzz_newer',
      projectId: proj.projectId,
      title: 'B 书（较新）',
    });
    const chapterA = makeChapter(proj, 1);
    const chapterB = proj.repos.chapters.create({
      id: `chapter_${bookB.id}_001`,
      bookId: bookB.id,
      chapterNumber: 1,
      title: 'B 书第 1 章',
      status: 'DRAFT',
    });

    passReview(proj, chapterA.id);
    passReview(proj, chapterB.id);

    writeWorkspace(bookB.id, 1, 'draft.md', 'B 书的正文。');
    writeWorkspace(proj.bookId, 2, 'draft.md', 'A 书第 2 章的正文。');

    const { tools, indexed } = toolsOf(proj);
    const commit = tools.find((x) => x.name === 'workspace.commit')!;

    // 提交 B 书的章节
    const report = commit.execute({
      chapterId: chapterB.id,
      commitMode: 'FORCE',
      forceReason: '测试',
    });
    expect(report.ok).toBe(true);

    // ⚠ 下游终点：索引器收到的 bookId 必须是 B 书
    expect(indexed).toHaveLength(1);
    expect(indexed[0]!.chapterId).toBe(chapterB.id);
    expect(indexed[0]!.bookId).toBe(bookB.id);
    // 反向：绝不能是 A 书（也不能是空串）
    expect(indexed[0]!.bookId).not.toBe(proj.bookId);
    expect(indexed[0]!.bookId).not.toBe('');
  });

  it('⚠ 两本书各提交一章 → 各自的索引 bookId 分别正确（不互相覆盖）', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;

    const bookB = proj.repos.books.create({
      id: 'book_zzz_newer',
      projectId: proj.projectId,
      title: 'B 书（较新）',
    });
    const chapterA = makeChapter(proj, 1);
    const chapterB = proj.repos.chapters.create({
      id: `chapter_${bookB.id}_001`,
      bookId: bookB.id,
      chapterNumber: 1,
      title: 'B 书第 1 章',
      status: 'DRAFT',
    });
    passReview(proj, chapterA.id);
    passReview(proj, chapterB.id);

    // ⚠ 两章的章号相同（各书第 1 章）。P0-1 修复前它们共用同一个工作区
    //   路径 —— 写第二份会覆盖第一份，提交 A 书时读到的其实是 B 书的草稿。
    //   现在按书隔离，两份草稿各自独立，因此这里必须分别写入。
    writeWorkspace(proj.bookId, 1, 'draft.md', 'A 书的第 1 章正文。');
    writeWorkspace(bookB.id, 1, 'draft.md', 'B 书的第 1 章正文。');

    const { tools, indexed } = toolsOf(proj);
    const commit = tools.find((x) => x.name === 'workspace.commit')!;

    commit.execute({ chapterId: chapterA.id, commitMode: 'FORCE', forceReason: '测试' });
    commit.execute({ chapterId: chapterB.id, commitMode: 'FORCE', forceReason: '测试' });

    expect(indexed).toHaveLength(2);
    const byChapter = new Map(indexed.map((x) => [x.chapterId, x.bookId]));
    expect(byChapter.get(chapterA.id)).toBe(proj.bookId);
    expect(byChapter.get(chapterB.id)).toBe(bookB.id);
  });

  it('⚠ 索引的 bookId 永远非空（空串会让该章在任何书里都搜不到）', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);
    passReview(proj, chapter.id);
    writeWorkspace(proj.bookId, 1, 'draft.md', '正文。');

    const { tools, indexed } = toolsOf(proj);
    const commit = tools.find((x) => x.name === 'workspace.commit')!;
    commit.execute({ chapterId: chapter.id, commitMode: 'FORCE', forceReason: '测试' });

    expect(indexed).toHaveLength(1);
    expect(indexed[0]!.bookId.trim()).not.toBe('');
  });

  it('⚠ 索引的 bookId 与 chapters 表里的真实归属一致（逐行核对）', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;

    const bookB = proj.repos.books.create({
      id: 'book_zzz_newer',
      projectId: proj.projectId,
      title: 'B 书（较新）',
    });
    const chapterA = makeChapter(proj, 1);
    const chapterB = proj.repos.chapters.create({
      id: `chapter_${bookB.id}_001`,
      bookId: bookB.id,
      chapterNumber: 2,
      title: 'B 书第 2 章',
      status: 'DRAFT',
    });
    passReview(proj, chapterA.id);
    passReview(proj, chapterB.id);
    writeWorkspace(proj.bookId, 1, 'draft.md', 'A 书正文。');
    writeWorkspace(bookB.id, 2, 'draft.md', 'B 书正文。');

    const { tools, indexed } = toolsOf(proj);
    const commit = tools.find((x) => x.name === 'workspace.commit')!;
    commit.execute({ chapterId: chapterA.id, commitMode: 'FORCE', forceReason: '测试' });
    commit.execute({ chapterId: chapterB.id, commitMode: 'FORCE', forceReason: '测试' });

    // ⚠ 逐行回查 chapters 表 —— 这才是"权威归属"
    for (const row of indexed) {
      const ch = proj.repos.chapters.get(row.chapterId);
      expect(row.bookId).toBe(ch.book_id);
    }
  });

  it('⚠ 不注入索引器时提交仍成功（索引是 Derived，不该阻断真源写入）', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);
    passReview(proj, chapter.id);
    writeWorkspace(proj.bookId, 1, 'draft.md', '正文。');

    const tools = createCommitTools({
      db: proj.db,
      repos: proj.repos,
      rootDir: dir,
      logger,
      readWorkspaceText: (bookId: string, chapterNumber: number, name: CommitSourceKey) => {
        const d = join(dir, workspaceRel(bookId, chapterNumber));
        const p = join(d, COMMIT_SOURCE_FILE[name]);
        return existsSync(p) ? readFileSync(p, 'utf8') : null;
      },
    });
    const commit = tools.find((x) => x.name === 'workspace.commit')!;
    const report = commit.execute({
      chapterId: chapter.id,
      commitMode: 'FORCE',
      forceReason: '测试',
    });
    // ⚠ 只断言工具**实际返回**的字段。`workspace.commit` 不暴露
    //   `indexesRebuilt`（那是 CommitEngine 的字段）—— 第一版这里断言
    //   `report.indexesRebuilt` 拿到 undefined 而失败，属**假红**：
    //   断言查了一个调用方拿不到的字段。
    expect(report.ok).toBe(true);
    expect(report.status).toBe('COMMITTED');
  });
});
