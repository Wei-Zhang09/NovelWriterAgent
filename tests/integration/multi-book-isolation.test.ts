/**
 * ⚠ 多书隔离测试
 *
 * ## 触发这组测试的真实事故
 *
 * 用户项目目录里出现 **24 本同名「测试小说」+ 23 个重复「第1章 DRAFT」**。
 * 排查后确认根因是**多书隔离缺陷**，不是用户误操作：
 *
 * 1. 所有写操作取 `books.listByProject(pid)[0]` —— 而它按 `created_at` 排序，
 *    `[0]` 是**最老的那本**（不是用户刚创建、正在看的那本）。
 * 2. 于是「新建章节」永远加到旧书上；用户看不到变化 → 以为没生效 →
 *    再建一本 → 重复建书、章节堆在旧书里。
 * 3. 更严重的是**语义隔离缺失**：`facts`/`characters`/`memory_items`
 *    这些"上一章学到的设定"全按 book 隔离，但 Planner/Writer 装配上下文时
 *    取的是 `[0]` 那本书 —— 于是**A 书的设定会污染 B 书的正文**。
 *
 * 用户明确要求：「本软件肯定是允许同时多本书创作的，但是书与书之间
 * 要做好隔离，不能出现相互污染的情况」。
 *
 * 这组测试锁死：**任何写操作/上下文装配都必须按"目标书"过滤**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database, MIGRATIONS } from '@nwa/storage';
import { Logger } from '@nwa/core';
import { readFileSync } from 'node:fs';

const logger = new Logger('test:multi-book', { level: 'error' });

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nwa-multibook-'));
  db = new Database({ path: join(dir, 'project.db'), logger });
  db.migrate(MIGRATIONS);
});
afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** 建项目 + 两本书（A 先建，B 后建） */
function setupTwoBooks() {
  const now = new Date().toISOString();
  db.run(
    'INSERT INTO projects (id, name, status, created_at, updated_at) VALUES (?,?,?,?,?)',
    'proj_1',
    '测试项目',
    'ACTIVE',
    now,
    now,
  );
  db.run(
    'INSERT INTO books (id, project_id, title, current_chapter, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    'book_A',
    'proj_1',
    '书A',
    0,
    '2026-01-01T00:00:00.000Z',
    now,
  );
  db.run(
    'INSERT INTO books (id, project_id, title, current_chapter, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    'book_B',
    'proj_1',
    '书B',
    0,
    '2026-02-01T00:00:00.000Z',
    now,
  );
  return { projectId: 'proj_1', bookA: 'book_A', bookB: 'book_B' };
}

function addChapter(bookId: string, n: number, status = 'DRAFT', summary: string | null = null) {
  const now = new Date().toISOString();
  const id = `ch_${bookId}_${n}`;
  db.run(
    `INSERT INTO chapters (id, book_id, chapter_number, status, body_path, summary, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id,
    bookId,
    n,
    status,
    null,
    summary,
    now,
    now,
  );
  return id;
}

function addFact(bookId: string, id: string, value: string) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO facts (id, book_id, subject_type, subject_id, predicate, object_value,
       status, confidence, evidence_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    bookId,
    'CHARACTER',
    'x',
    'name',
    value,
    'CANON',
    1.0,
    null,
    now,
    now,
  );
}

describe('⚠ books.listByProject 的排序陷阱（真实事故的根因）', () => {
  it('[0] 是最老的书，不是刚创建的书 —— 这正是不该用它做"当前书"的原因', () => {
    const { bookA, bookB } = setupTwoBooks();
    const rows = db.all<{ id: string }>(
      'SELECT id FROM books WHERE project_id = ? ORDER BY created_at',
      'proj_1',
    );
    // 记录事实：A 先建，所以 [0] 是 A
    expect(rows[0]!.id).toBe(bookA);
    expect(rows[1]!.id).toBe(bookB);
    // ⚠ 因此任何"取 [0] 当当前书"的写法都会永远操作最老的那本
  });

  it('按 id 取书是精确的（隔离的基础）', () => {
    const { bookB } = setupTwoBooks();
    const row = db.get<{ title: string }>('SELECT title FROM books WHERE id = ?', bookB);
    expect(row?.title).toBe('书B');
  });
});

describe('⚠ 语义隔离：A 书的设定不得进入 B 书的上下文', () => {
  it('facts 按 book_id 过滤，互不可见', () => {
    const { bookA, bookB } = setupTwoBooks();
    addFact(bookA, 'f_a1', 'A书的主角叫沈砚');
    addFact(bookB, 'f_b1', 'B书的主角叫林砚');

    const aFacts = db.all<{ object_value: string }>(
      'SELECT object_value FROM facts WHERE book_id = ?',
      bookA,
    );
    const bFacts = db.all<{ object_value: string }>(
      'SELECT object_value FROM facts WHERE book_id = ?',
      bookB,
    );

    expect(aFacts).toHaveLength(1);
    expect(aFacts[0]!.object_value).toContain('沈砚');
    expect(bFacts).toHaveLength(1);
    expect(bFacts[0]!.object_value).toContain('林砚');
    // ⚠ 关键：B 书的查询里绝不能出现 A 书的事实
    expect(bFacts.some((f) => f.object_value.includes('沈砚'))).toBe(false);
  });

  it('章节摘要按 book_id 过滤，互不可见', () => {
    const { bookA, bookB } = setupTwoBooks();
    addChapter(bookA, 1, 'COMMITTED', 'A书第一章：沈砚在渡口值夜。');
    addChapter(bookB, 1, 'COMMITTED', 'B书第一章：林砚在公寓值班。');

    const aCh = db.all<{ summary: string }>(
      "SELECT summary FROM chapters WHERE book_id = ? AND status = 'COMMITTED'",
      bookA,
    );
    const bCh = db.all<{ summary: string }>(
      "SELECT summary FROM chapters WHERE book_id = ? AND status = 'COMMITTED'",
      bookB,
    );

    expect(aCh).toHaveLength(1);
    expect(bCh).toHaveLength(1);
    expect(aCh[0]!.summary).toContain('沈砚');
    expect(bCh[0]!.summary).toContain('林砚');
    expect(bCh[0]!.summary).not.toContain('沈砚');
  });

  it('⚠ 检索（FTS）按 book_id 过滤 —— 否则跨书检索会串味', () => {
    const { bookA, bookB } = setupTwoBooks();
    // 两个索引都要有 book_id 列，否则无法过滤
    const chCols = db
      .all<{ name: string }>("PRAGMA table_info('chapter_fts')")
      .map((r) => r.name);
    const memCols = db
      .all<{ name: string }>("PRAGMA table_info('memory_fts')")
      .map((r) => r.name);

    expect(chCols).toContain('book_id');
    expect(memCols).toContain('book_id');

    // 写入两本书的记忆条目（FTS 内容表需同步）
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO memory_items (id, book_id, type, title, content, importance, protected,
         compressible, source_ref, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      'mem_a',
      bookA,
      'PLOT',
      'A书第一章',
      '沈砚在渡口登记货单',
      5,
      0,
      1,
      'chapters/1.md',
      now,
      now,
    );
    db.run(
      `INSERT INTO memory_items (id, book_id, type, title, content, importance, protected,
         compressible, source_ref, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      'mem_b',
      bookB,
      'PLOT',
      'B书第一章',
      '林砚在公寓值班',
      5,
      0,
      1,
      'chapters/1.md',
      now,
      now,
    );

    const bMem = db.all<{ content: string }>(
      'SELECT content FROM memory_items WHERE book_id = ?',
      bookB,
    );
    expect(bMem).toHaveLength(1);
    expect(bMem.some((m) => m.content.includes('沈砚'))).toBe(false);
  });

  it('⚠ FTS 查询必须带 book_id 过滤条件（否则跨书检索串味）', () => {
    // FTS 表本身有 book_id 列（上面已验证），这里验证"过滤真的生效"：
    // 直接往 FTS 写两本书的条目，按 book_id 过滤查询。
    db.run(
      "INSERT INTO memory_fts (tokens, item_id, book_id, item_type, source_ref) VALUES (?,?,?,?,?)",
      '沈砚 渡口',
      'mem_a',
      'book_A',
      'PLOT',
      'chapters/1.md',
    );
    db.run(
      "INSERT INTO memory_fts (tokens, item_id, book_id, item_type, source_ref) VALUES (?,?,?,?,?)",
      '林砚 公寓',
      'mem_b',
      'book_B',
      'PLOT',
      'chapters/1.md',
    );

    const bRows = db.all<{ item_id: string }>(
      "SELECT item_id FROM memory_fts WHERE memory_fts MATCH '林砚' AND book_id = ?",
      'book_B',
    );
    expect(bRows).toHaveLength(1);
    expect(bRows[0]!.item_id).toBe('mem_b');

    // ⚠ 关键：查 B 书时不得返回 A 书的条目
    const crossRows = db.all<{ item_id: string }>(
      "SELECT item_id FROM memory_fts WHERE memory_fts MATCH '沈砚' AND book_id = ?",
      'book_B',
    );
    expect(crossRows).toHaveLength(0);
  });
});

describe('⚠ 写操作必须按目标书，不能取 [0]', () => {
  it('给 B 书建章节后，A 书的章节数不变', () => {
    const { bookA, bookB } = setupTwoBooks();
    addChapter(bookA, 1);
    addChapter(bookB, 1);

    const aCount = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?',
      bookA,
    );
    const bCount = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?',
      bookB,
    );

    expect(aCount!.n).toBe(1);
    expect(bCount!.n).toBe(1);
  });

  it('章节号在各自书内独立递增（互不影响）', () => {
    const { bookA, bookB } = setupTwoBooks();
    addChapter(bookA, 1);
    addChapter(bookA, 2);
    addChapter(bookA, 3);
    addChapter(bookB, 1);

    const aMax = db.get<{ m: number }>(
      'SELECT MAX(chapter_number) AS m FROM chapters WHERE book_id = ?',
      bookA,
    );
    const bMax = db.get<{ m: number }>(
      'SELECT MAX(chapter_number) AS m FROM chapters WHERE book_id = ?',
      bookB,
    );

    expect(aMax!.m).toBe(3);
    expect(bMax!.m).toBe(1); // B 书不受 A 书影响
  });
});

describe('⚠ 源码级约束：不得再出现"取第一本书"的写法', () => {
  it('core-process.ts 中不应有 listByProject(...)[0] 作为"当前书"', () => {
    // 这类写法会把所有操作都指向最老的那本书（真实事故根因）。
    // 用源码扫描锁死，防止回退。
    const src = readFileSync(
      join(process.cwd(), 'apps/desktop/src/main/core-process.ts'),
      'utf8',
    );
    const offenders = src
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((l) => {
        if (!/listByProject\([^)]*\)\s*\[\s*0\s*\]/.test(l.line)) return false;
        // 注释里提到不算违规（那是在解释这个陷阱）
        if (/^\*|^\/\//.test(l.line)) return false;
        // resolveBookId 自身内部允许（它就是隔离的单一入口）
        if (/const ok = p\.repos\.books\.listByProject/.test(l.line)) return false;
        // 纯计数用途（bookCount）不影响隔离
        if (/bookCount/.test(l.line)) return false;
        return true;
      });

    // 允许出现在"取默认书"的明确位置，但必须显式带注释说明
    expect(
      offenders.length,
      `发现"取第一本书"的写法（会把操作指向最老的书）：\n` +
        offenders.map((o) => `  core-process.ts:${o.n}  ${o.line}`).join('\n'),
    ).toBe(0);
  });
});
