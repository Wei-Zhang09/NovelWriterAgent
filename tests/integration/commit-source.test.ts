/**
 * 提交源优先级链（M0，ADR-0008）
 *
 * ## 这个缺陷长什么样
 *
 * 引入 `manuscript.md`（用户正在编辑的正文）之前，提交路径是：
 *
 *     const revision = readWorkspaceText(n, 'revision');
 *     const draft    = readWorkspaceText(n, 'draft');
 *     const body     = revision ?? draft;
 *
 * **从不读用户正文**。用户在工作台里改了 3 段、按了保存，
 * 然后点「提交到正史」—— 进入正史的是 **AI 的 revision**，
 * 用户的手改内容被丢弃。
 *
 * 最危险的地方在于**它不会报错**：`revision ?? draft` 永远能取到值，
 * 流程一路绿灯，manifest 正常写、章节正常提交、UI 显示"提交成功"。
 * 这是"看起来全绿、实际丢数据"，比直接失败难发现得多。
 *
 * ## 测试重点
 *
 * 不是"函数返回了对的值"，而是**端到端**：
 * 造一个三份稿内容互不相同的章节，真的跑提交，然后读
 * `chapters/001.md` 的实际内容 —— 必须是用户改的那份。
 *
 * ⚠ 关键：断言读的是**落盘文件**，不是函数返回值。
 *   只看返回值会漏掉"选对了但写错了"这类问题。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Logger, chapterRel, workspaceRel } from '@nwa/core';
import { createCommitTools, COMMIT_SOURCE_ORDER, COMMIT_SOURCE_FILE } from '@nwa/harness';
import type { CommitSourceKey } from '@nwa/harness';
import { createTestProject, makeChapter, type TestProject } from './helpers.js';

const logger = new Logger('test:commit-source', { level: 'error' });

let dir: string;
let t: TestProject | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nwa-csrc-'));
});
afterEach(() => {
  if (t) {
    t.cleanup();
    t = null;
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 在工作区写一份产物（模拟 Writer / Agent / 用户分别写过） */
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

const chapterFile = (bookId: string, n = 1) => join(dir, chapterRel(bookId, n));

/** 造一套提交工具，readWorkspaceText 从真实磁盘读（与 core-process 同实现） */
function toolsOf(proj: TestProject) {
  return createCommitTools({
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
}

/**
 * 让章节通过审阅门禁。
 *
 * ⚠ 必须显式做：`hasBlockingReview()` 把**未审阅**（review_status=NULL）
 *   也视为阻塞（`chapters.ts:153`，"没审过就提交等于跳过质量关口"）。
 *   不设这一条，所有提交都会在到达提交源逻辑**之前**抛 BLOCKING ——
 *   测试会以错误的理由失败，掩盖真正要验的东西。
 */
function passReview(proj: TestProject, chapterId: string): void {
  proj.repos.chapters.saveReview(
    chapterId,
    { overallStatus: 'PASSED', issues: [] },
    'PASSED',
  );
}

const USER_TEXT = '他垂下眼睛，手指无意识地攥紧衣角。';
const AI_REVISION = '他非常悲伤，感到十分痛苦。';
const AI_DRAFT = '他很难过。';

describe('⚠ 提交源优先级链：manuscript ?? revision ?? draft', () => {
  it('⚠⚠ 三份稿都在时，提交的必须是用户改的那份（本测试是本阶段成立的判据）', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);
    passReview(proj, chapter.id);

    writeWorkspace(proj.bookId, 1, 'draft.md', AI_DRAFT);
    writeWorkspace(proj.bookId, 1, 'revision.md', AI_REVISION);
    writeWorkspace(proj.bookId, 1, 'manuscript.md', USER_TEXT);

    const tools = toolsOf(proj);
    const commit = tools.find((x) => x.name === 'workspace.commit')!;
    const report = commit.execute({ chapterId: chapter.id, commitMode: 'FORCE', forceReason: '测试' });

    expect(report.ok).toBe(true);
    // ⚠ 读**落盘文件**而不是返回值：用户真正关心的是正史里是什么
    const written = readFileSync(chapterFile(proj.bookId, 1), 'utf8');
    expect(written).toContain(USER_TEXT);
    // 反向：AI 的修订稿**不得**出现在正史里
    expect(written).not.toContain(AI_REVISION);
    expect(written).not.toContain(AI_DRAFT);
  });

  it('⚠ 没有 manuscript 时退回 revision（不因为引入用户稿而破坏原行为）', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);
    passReview(proj, chapter.id);

    writeWorkspace(proj.bookId, 1, 'draft.md', AI_DRAFT);
    writeWorkspace(proj.bookId, 1, 'revision.md', AI_REVISION);

    const tools = toolsOf(proj);
    const commit = tools.find((x) => x.name === 'workspace.commit')!;
    commit.execute({ chapterId: chapter.id, commitMode: 'FORCE', forceReason: '测试' });

    const written = readFileSync(chapterFile(proj.bookId, 1), 'utf8');
    expect(written).toContain(AI_REVISION);
    expect(written).not.toContain(AI_DRAFT);
  });

  it('只有 draft 时用 draft', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);
    passReview(proj, chapter.id);
    writeWorkspace(proj.bookId, 1, 'draft.md', AI_DRAFT);

    const tools = toolsOf(proj);
    const commit = tools.find((x) => x.name === 'workspace.commit')!;
    commit.execute({ chapterId: chapter.id, commitMode: 'FORCE', forceReason: '测试' });

    expect(readFileSync(chapterFile(proj.bookId, 1), 'utf8')).toContain(AI_DRAFT);
  });

  it('⚠ 三份都没有 → 拒绝提交（不编造正文）', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);
    passReview(proj, chapter.id);

    const tools = toolsOf(proj);
    const commit = tools.find((x) => x.name === 'workspace.commit')!;
    expect(() =>
      commit.execute({ chapterId: chapter.id, commitMode: 'FORCE', forceReason: '测试' }),
    ).toThrow(/没有正文可提交/);
  });

  it('⚠ 优先级顺序是契约：manuscript 必须在 revision 之前', () => {
    // 顺序写反（如 ['revision','manuscript','draft']）会让用户改动继续被丢弃，
    // 而其他测试**照样通过**（因为它们都有 manuscript 或都没有）。
    expect(COMMIT_SOURCE_ORDER[0]).toBe('manuscript');
    expect(COMMIT_SOURCE_ORDER).toEqual(['manuscript', 'revision', 'draft']);
  });
});

describe('⚠ 提交源被记录（可验证 §15「AI 不覆盖用户正文」）', () => {
  it('⚠ manifest 记录 source=manuscript.md（不看记录就无法验证规则被遵守）', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);
    passReview(proj, chapter.id);
    writeWorkspace(proj.bookId, 1, 'draft.md', AI_DRAFT);
    writeWorkspace(proj.bookId, 1, 'revision.md', AI_REVISION);
    writeWorkspace(proj.bookId, 1, 'manuscript.md', USER_TEXT);

    const tools = toolsOf(proj);
    const commit = tools.find((x) => x.name === 'workspace.commit')!;
    commit.execute({ chapterId: chapter.id, commitMode: 'FORCE', forceReason: '测试' });

    const row = proj.db.get<{ source: string | null }>(
      'SELECT source FROM commit_manifests WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1',
      chapter.id,
    );
    expect(row?.source).toBe('manuscript.md');
  });

  it('⚠ 退回 revision 时 source 如实记为 revision.md（不能一律写 manuscript）', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);
    passReview(proj, chapter.id);
    writeWorkspace(proj.bookId, 1, 'revision.md', AI_REVISION);

    const tools = toolsOf(proj);
    const commit = tools.find((x) => x.name === 'workspace.commit')!;
    commit.execute({ chapterId: chapter.id, commitMode: 'FORCE', forceReason: '测试' });

    const row = proj.db.get<{ source: string | null }>(
      'SELECT source FROM commit_manifests WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1',
      chapter.id,
    );
    expect(row?.source).toBe('revision.md');
  });

  it('⚠ dryRun（提交预览）与真实提交给出同一个 source', () => {
    // 预览说提交 A、实际提交 B 是最难查的一类 bug
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);
    passReview(proj, chapter.id);
    writeWorkspace(proj.bookId, 1, 'draft.md', AI_DRAFT);
    writeWorkspace(proj.bookId, 1, 'manuscript.md', USER_TEXT);

    const tools = toolsOf(proj);
    const dry = tools.find((x) => x.name === 'workspace.proposeCommit')!;
    const commit = tools.find((x) => x.name === 'workspace.commit')!;

    const preview = dry.execute({ chapterId: chapter.id });
    expect(preview.source).toBe('manuscript.md');

    commit.execute({ chapterId: chapter.id, commitMode: 'FORCE', forceReason: '测试' });
    const row = proj.db.get<{ source: string | null }>(
      'SELECT source FROM commit_manifests WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1',
      chapter.id,
    );
    expect(row?.source).toBe(preview.source);
  });
});

describe('⚠ Save ≠ Commit（manuscript 存在本身不改变门禁）', () => {
  it('⚠ 有 manuscript 不等于可以跳过 BLOCKING 审阅', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);
    passReview(proj, chapter.id);
    writeWorkspace(proj.bookId, 1, 'manuscript.md', USER_TEXT);

    // 造一条 BLOCKING 审阅
    proj.repos.chapters.saveReview(
      chapter.id,
      {
        overallStatus: 'BLOCKED',
        issues: [
          {
            id: 'i1',
            severity: 'BLOCKING',
            category: 'CONTINUITY',
            claim: '与已有设定冲突',
            evidence: [],
            suggestions: [],
          },
        ],
      },
      'BLOCKED',
    );

    const tools = toolsOf(proj);
    const commit = tools.find((x) => x.name === 'workspace.commit')!;
    expect(() => commit.execute({ chapterId: chapter.id })).toThrow(/BLOCKING/);
  });
});
