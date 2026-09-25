/**
 * Chapter Workspace 测试（STEP 7，施工文档 §9）
 *
 * 重点验证 §9.1 的核心原则与两条安全边界：
 *   1. 工作区路径**不得逃逸** rootDir（章节名是不可信输入）
 *   2. 递归删除**只能**作用于 `<root>/workspace/chapter-NNN`
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChapterWorkspace, WORKSPACE_FILES } from '@nwa/story';
import { Logger, ErrorCode } from '@nwa/core';

let root: string;
const logger = new Logger('test:workspace', { level: 'error' });

/** 测试用固定书 id（P0-1 起路径按书隔离，工作区必须知道自己在哪本书里） */
const TEST_BOOK_ID = 'book_test';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nwa-ws-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ws = (n: number, allowed?: readonly (keyof typeof WORKSPACE_FILES)[]) =>
  new ChapterWorkspace({
    rootDir: root,
    bookId: TEST_BOOK_ID,
    chapterNumber: n,
    logger,
    ...(allowed ? { allowedFiles: allowed } : {}),
  });

describe('目录结构（§9 图示）', () => {
  it('目录为 books/<bookId>/workspace/chapter-NNN（三位补零，按书隔离）', () => {
    expect(ws(31).dir).toBe(join(root, 'books', TEST_BOOK_ID, 'workspace', 'chapter-031'));
    expect(ws(1).dir).toBe(join(root, 'books', TEST_BOOK_ID, 'workspace', 'chapter-001'));
    expect(ws(1234).dir).toBe(join(root, 'books', TEST_BOOK_ID, 'workspace', 'chapter-1234'));
  });

  it('⚠ 不同书的同章号工作区互不重叠（P0-1 回归守卫）', () => {
    // 原缺陷：路径只由章号拼成，而 DB 是 UNIQUE(book_id, chapter_number)，
    // 允许两本书各有第 1 章 → 同一个目录 → 写 B 覆盖 A 未提交的中间产物。
    const a = new ChapterWorkspace({
      rootDir: root,
      bookId: 'book_aaa',
      chapterNumber: 1,
      logger,
    });
    const b = new ChapterWorkspace({
      rootDir: root,
      bookId: 'book_bbb',
      chapterNumber: 1,
      logger,
    });
    expect(a.dir).not.toBe(b.dir);

    // 行为级：A 写 draft 后 B 写 draft，A 的内容必须还在
    a.ensure();
    b.ensure();
    a.writeText('draft', '【A 书的第 1 章草稿】');
    b.writeText('draft', '【B 书的第 1 章草稿】');
    expect(a.readText('draft')).toBe('【A 书的第 1 章草稿】');
    expect(b.readText('draft')).toBe('【B 书的第 1 章草稿】');
  });

  it('ensure 幂等创建', () => {
    const w = ws(1);
    w.ensure();
    w.ensure();
    expect(existsSync(w.dir)).toBe(true);
  });

  it('文件名常量与 §9 图示一致', () => {
    expect(WORKSPACE_FILES.plan).toBe('plan.json');
    expect(WORKSPACE_FILES.scenePlan).toBe('scene-plan.json');
    expect(WORKSPACE_FILES.draft).toBe('draft.md');
    expect(WORKSPACE_FILES.revision).toBe('revision.md');
    expect(WORKSPACE_FILES.proposedFacts).toBe('proposed_facts.json');
    expect(WORKSPACE_FILES.proposedForeshadowing).toBe('proposed_foreshadowing.json');
  });
});

describe('⚠ 安全边界：路径逃逸', () => {
  it('章号非正整数时拒绝构造', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => ws(bad as number)).toThrow(/必须是正整数/);
    }
  });

  it('章号无法注入路径分隔符（类型强制为 number）', () => {
    // 即使传入字符串形式的路径，也因非整数被拒 —— 路径永远由章号数字拼接
    expect(() => ws('../../etc' as unknown as number)).toThrow();
  });

  it('promoteTo 拒绝逃逸到 rootDir 之外', () => {
    const w = ws(1);
    w.ensure();
    w.writeText('draft', '正文');
    expect(() => w.promoteTo('draft', join(root, '..', 'escaped.md'))).toThrow(/逃逸/);
  });

  it('promoteTo 允许 rootDir 内的目标（chapters/001.md）', () => {
    const w = ws(1);
    w.ensure();
    w.writeText('draft', '正文内容');
    const dst = w.promoteTo('draft', join(root, 'chapters', '001.md'));
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, 'utf8')).toBe('正文内容');
    // 迁移（rename）后源文件不应残留
    expect(w.has('draft')).toBe(false);
  });

  it('promoteTo 对不存在的产物报 COMMIT_FAILED', () => {
    const w = ws(1);
    w.ensure();
    try {
      w.promoteTo('draft', join(root, 'chapters', '001.md'));
      expect.unreachable('应当抛错');
    } catch (e) {
      expect((e as { code: string }).code).toBe(ErrorCode.COMMIT_FAILED);
    }
  });
});

describe('⚠ 安全边界：clear 只能删自己的工作区', () => {
  it('clear 删除并重建工作区目录', () => {
    const w = ws(5);
    w.ensure();
    w.writeText('draft', 'x');
    w.clear();
    expect(existsSync(w.dir)).toBe(true); // 重建了
    expect(w.has('draft')).toBe(false); // 内容清空
  });

  it('clear 不会碰相邻章的工作区', () => {
    const a = ws(1);
    const b = ws(2);
    a.ensure();
    b.ensure();
    b.writeText('draft', '第二章');
    a.clear();
    expect(b.has('draft')).toBe(true);
    expect(b.readText('draft')).toBe('第二章');
  });

  it('clear 不会碰 rootDir 下的其他目录（chapters/）', () => {
    const chaptersDir = join(root, 'chapters');
    mkdirSync(chaptersDir, { recursive: true });
    writeFileSync(join(chaptersDir, '001.md'), '正式章节，不该被动', 'utf8');

    ws(1).clear();

    expect(readFileSync(join(chaptersDir, '001.md'), 'utf8')).toBe('正式章节，不该被动');
  });
});

describe('读写产物', () => {
  it('writeText 覆盖而不是追加（产物是本次运行的完整结果）', () => {
    const w = ws(1);
    w.writeText('draft', '第一版');
    w.writeText('draft', '第二版');
    expect(w.readText('draft')).toBe('第二版');
  });

  it('writeJson 美化输出并保持可读', () => {
    const w = ws(1);
    w.writeJson('plan', { a: 1, b: [2, 3] });
    expect(w.readText('plan')).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });

  it('readText 对不存在的产物返回 null（不抛错）', () => {
    expect(ws(1).readText('draft')).toBeNull();
  });

  it('readJson 对损坏 JSON 返回 null 而不是崩溃', () => {
    const w = ws(1);
    w.ensure();
    writeFileSync(w.pathOf('plan'), '{ 这不是 JSON', 'utf8');
    expect(w.readJson('plan')).toBeNull();
  });

  it('中文内容按 UTF-8 正确读写', () => {
    const w = ws(1);
    const text = '他回头看了一眼……又走了。';
    w.writeText('draft', text);
    expect(w.readText('draft')).toBe(text);
  });

  it('中文按字符计字节数（快照用）', () => {
    const w = ws(1);
    w.writeText('draft', '中文');
    const snap = w.snapshot();
    const f = snap.files.find((x) => x.name === 'draft.md')!;
    expect(f.bytes).toBe(6); // 2 字 × 3 字节
  });
});

describe('文件白名单', () => {
  it('白名单外的 key 被拒绝写入', () => {
    const w = ws(1, ['draft']);
    expect(() => w.writeText('review', 'x')).toThrow(/白名单/);
  });

  it('白名单内的 key 正常读写', () => {
    const w = ws(1, ['draft']);
    w.writeText('draft', 'ok');
    expect(w.readText('draft')).toBe('ok');
  });

  it('默认白名单包含 §9 全部产物', () => {
    const w = ws(1);
    for (const key of Object.keys(WORKSPACE_FILES) as (keyof typeof WORKSPACE_FILES)[]) {
      expect(() => w.pathOf(key)).not.toThrow();
    }
  });
});

describe('snapshot', () => {
  it('正确报告草稿/修订的存在状态', () => {
    const w = ws(1);
    let s = w.snapshot();
    expect(s.hasDraft).toBe(false);
    expect(s.hasRevision).toBe(false);

    w.writeText('draft', '草稿');
    s = w.snapshot();
    expect(s.hasDraft).toBe(true);
    expect(s.hasRevision).toBe(false);
    expect(s.chapterNumber).toBe(1);

    w.writeText('revision', '修订');
    expect(w.snapshot().hasRevision).toBe(true);
  });

  it('只列出实际存在的文件', () => {
    const w = ws(1);
    expect(w.snapshot().files).toEqual([]);
    w.writeText('draft', 'x');
    expect(w.snapshot().files.map((f) => f.name)).toEqual(['draft.md']);
  });
});
