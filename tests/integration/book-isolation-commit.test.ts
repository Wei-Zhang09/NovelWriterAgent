/**
 * P0-1 回归守卫：两本书的同章号**不得**互相覆盖
 *
 * ## 这个缺陷长什么样
 *
 * DB 层是 `UNIQUE(book_id, chapter_number)`（`0001_init.sql:43`）——
 * 明确允许 A 书第 1 章与 B 书第 1 章同时存在。
 *
 * 但磁盘层的路径是：
 *
 *     chapters/001.md
 *     summaries/001.md
 *     workspace/chapter-001/
 *
 * **只由章号拼成，不含书**。于是两本书各自的第 1 章映射到同一个文件：
 *
 *     提交 A 书第 1 章 → chapters/001.md = 【A 书的第 1 章正文】
 *     提交 B 书第 1 章 → chapters/001.md = 【B 书的第 1 章正文】  ← 覆盖
 *
 * 实测的失败形态（本测试第一版就复现过）：
 *
 *     A 行 body_path == B 行 body_path == 'chapters/001.md'
 *     A 的正文还在吗 → false
 *     而 A 行的 status 仍是 COMMITTED
 *
 * **不报错、不回滚、不可逆**。系统认为 A 的正文还在，用户点开却是
 * B 的内容。这是本项目最严重的一类缺陷：静默丢用户数据。
 *
 * ## 测试重点
 *
 * 不是"路径函数返回了带书的字符串"，而是**端到端**：
 * 真的跑两次提交，然后读**落盘文件**，确认两份正文都还在、且各归各的。
 *
 * ⚠ 断言必须查**数据流的下游终点**（磁盘上的正文），
 *   而不是 CommitRequest 或路径函数 —— 缺陷的形态恰恰是
 *   "上游传对了、下游写错了"。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Logger, chapterRel, summaryRel, workspaceRel } from '@nwa/core';
import { createCommitTools, COMMIT_SOURCE_FILE } from '@nwa/harness';
import type { CommitSourceKey } from '@nwa/harness';
import { createTestProject, makeChapter, type TestProject } from './helpers.js';

const logger = new Logger('test:book-isolation-commit', { level: 'error' });

let dir: string;
let t: TestProject | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nwa-bookiso-'));
});
afterEach(() => {
  t?.cleanup();
  t = null;
  rmSync(dir, { recursive: true, force: true });
});

/** 在工作区写一份产物（按书隔离） */
function writeWorkspace(bookId: string, n: number, file: string, text: string): void {
  const d = join(dir, workspaceRel(bookId, n));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), text, 'utf8');
}

/** 提交工具：readWorkspaceText 从真实磁盘读（与 core-process 同实现） */
function toolsOf(proj: TestProject) {
  return createCommitTools({
    db: proj.db,
    repos: proj.repos,
    rootDir: dir,
    logger,
    readWorkspaceText: (bookId: string, n: number, name: CommitSourceKey) => {
      const p = join(dir, workspaceRel(bookId, n), COMMIT_SOURCE_FILE[name]);
      return existsSync(p) ? readFileSync(p, 'utf8') : null;
    },
  });
}

/** 让章节通过审阅门禁（未审阅 = review_status NULL = 阻塞） */
function passReview(proj: TestProject, chapterId: string): void {
  proj.repos.chapters.saveReview(chapterId, { overallStatus: 'PASSED', issues: [] }, 'PASSED');
}

const TEXT_A = '【A 书的第 1 章正文】张三走进了雨里。';
const TEXT_B = '【B 书的第 1 章正文】李四把伞收了起来。';

describe('⚠⚠ P0-1：两本书的同章号提交不互相覆盖', () => {
  it('⚠⚠ 两书各提交第 1 章 → 两份正文都还在，各归各的（本测试是本修复成立的判据）', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;

    // B 书（同一项目下的第二本）
    const bookB = proj.repos.books.create({
      id: 'book_bbb_second',
      projectId: proj.projectId,
      title: '第二本书',
    });

    // 两本书各有第 1 章 —— DB 允许（UNIQUE(book_id, chapter_number)）
    const chA = makeChapter(proj, 1);
    const chB = proj.repos.chapters.create({
      id: `chapter_${bookB.id}_001`,
      bookId: bookB.id,
      chapterNumber: 1,
      title: 'B 书第 1 章',
      status: 'DRAFT',
    });
    passReview(proj, chA.id);
    passReview(proj, chB.id);

    writeWorkspace(proj.bookId, 1, 'draft.md', TEXT_A);
    writeWorkspace(bookB.id, 1, 'draft.md', TEXT_B);

    const tools = toolsOf(proj);
    const commit = tools.find((x) => x.name === 'workspace.commit')!;

    // 先提交 A 书，再提交 B 书（顺序即原缺陷的触发顺序）
    const rA = commit.execute({ chapterId: chA.id, commitMode: 'FORCE', forceReason: '测试' });
    const rB = commit.execute({ chapterId: chB.id, commitMode: 'FORCE', forceReason: '测试' });
    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(true);

    // ── ① 两章的 body_path 必须**不同**（原缺陷下两者都是 chapters/001.md）──
    const rowA = proj.repos.chapters.get(chA.id);
    const rowB = proj.repos.chapters.get(chB.id);
    expect(rowA.body_path).toBe(chapterRel(proj.bookId, 1));
    expect(rowB.body_path).toBe(chapterRel(bookB.id, 1));
    expect(rowA.body_path).not.toBe(rowB.body_path);

    // ── ② 下游终点：磁盘上两份正文都还在，且内容各归各的 ──
    const fileA = join(dir, rowA.body_path!);
    const fileB = join(dir, rowB.body_path!);
    expect(existsSync(fileA)).toBe(true);
    expect(existsSync(fileB)).toBe(true);

    const onDiskA = readFileSync(fileA, 'utf8');
    const onDiskB = readFileSync(fileB, 'utf8');
    expect(onDiskA).toContain(TEXT_A);
    expect(onDiskB).toContain(TEXT_B);

    // ── ③ 反向：A 的正文不得被 B 的内容污染（这是原缺陷的核心症状）──
    expect(onDiskA).not.toContain('李四');
    expect(onDiskB).not.toContain('张三');

    // ── ④ A 书的状态仍自洽：说 COMMITTED，正文就真的在 ──
    expect(rowA.status).toBe('COMMITTED');
    expect(onDiskA.length).toBeGreaterThan(0);
  });

  it('⚠ 两书同章号的摘要不互相覆盖', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const bookB = proj.repos.books.create({
      id: 'book_bbb_sum',
      projectId: proj.projectId,
      title: '第二本书',
    });
    const chA = makeChapter(proj, 1);
    const chB = proj.repos.chapters.create({
      id: `chapter_${bookB.id}_001`,
      bookId: bookB.id,
      chapterNumber: 1,
      title: 'B 书第 1 章',
      status: 'DRAFT',
    });
    passReview(proj, chA.id);
    passReview(proj, chB.id);
    writeWorkspace(proj.bookId, 1, 'draft.md', TEXT_A);
    writeWorkspace(bookB.id, 1, 'draft.md', TEXT_B);

    // ⚠ 摘要不是 commit 的入参 —— 它是**章节行上的字段**，且必须已批准
    //   （§十二：未批准的摘要不进检索，提交会让这一章的记忆贡献静默为零）。
    proj.repos.chapters.setSummaryCandidate(chA.id, 'A 书的摘要');
    proj.repos.chapters.approveSummary(chA.id);
    proj.repos.chapters.setSummaryCandidate(chB.id, 'B 书的摘要');
    proj.repos.chapters.approveSummary(chB.id);

    const tools = toolsOf(proj);
    const commit = tools.find((x) => x.name === 'workspace.commit')!;
    commit.execute({ chapterId: chA.id, commitMode: 'FORCE', forceReason: '测试' });
    commit.execute({ chapterId: chB.id, commitMode: 'FORCE', forceReason: '测试' });

    const sumA = join(dir, summaryRel(proj.bookId, 1));
    const sumB = join(dir, summaryRel(bookB.id, 1));
    expect(sumA).not.toBe(sumB);
    expect(readFileSync(sumA, 'utf8')).toContain('A 书的摘要');
    expect(readFileSync(sumB, 'utf8')).toContain('B 书的摘要');
  });

  it('⚠ 两书同章号的工作区互不干扰（未提交的中间产物也不串）', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const bookB = proj.repos.books.create({
      id: 'book_bbb_ws',
      projectId: proj.projectId,
      title: '第二本书',
    });

    writeWorkspace(proj.bookId, 1, 'draft.md', TEXT_A);
    writeWorkspace(bookB.id, 1, 'draft.md', TEXT_B);

    // ⚠ 直接读工作区：这是"未提交的中间产物"是否串书的判据
    const wsA = join(dir, workspaceRel(proj.bookId, 1), 'draft.md');
    const wsB = join(dir, workspaceRel(bookB.id, 1), 'draft.md');
    expect(readFileSync(wsA, 'utf8')).toBe(TEXT_A);
    expect(readFileSync(wsB, 'utf8')).toBe(TEXT_B);
  });

  it('⚠ 提交预览（dryRun）报的落盘路径也带书（不能预览一个路径、写另一个）', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const bookB = proj.repos.books.create({
      id: 'book_bbb_dry',
      projectId: proj.projectId,
      title: '第二本书',
    });
    const chB = proj.repos.chapters.create({
      id: `chapter_${bookB.id}_001`,
      bookId: bookB.id,
      chapterNumber: 1,
      title: 'B 书第 1 章',
      status: 'DRAFT',
    });
    passReview(proj, chB.id);
    writeWorkspace(bookB.id, 1, 'draft.md', TEXT_B);

    const tools = toolsOf(proj);
    // ⚠ 预览走独立工具 `workspace.proposeCommit`（commit 没有 dryRun 入参）
    const propose = tools.find((x) => x.name === 'workspace.proposeCommit')!;
    const preview = propose.execute({ chapterId: chB.id }) as {
      willWrite?: { path: string }[];
    };

    const paths = (preview.willWrite ?? []).map((w) => w.path);
    expect(paths.length).toBeGreaterThan(0);
    // 预览里的每条路径都必须带 B 书的书维度
    // （'artifacts/index.json' 是项目级文件，不受书隔离影响，排除）
    const perBook = paths.filter((x) => x !== 'artifacts/index.json');
    expect(perBook.length).toBeGreaterThan(0);
    for (const x of perBook) {
      expect(x).toContain(bookB.id);
    }
    // 反向：预览路径必须与真实落盘一致（不能预览一个、写另一个）
    expect(perBook).toContain(chapterRel(bookB.id, 1));
    expect(perBook).toContain(summaryRel(bookB.id, 1));
  });
});
