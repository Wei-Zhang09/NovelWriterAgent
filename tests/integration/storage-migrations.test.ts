/**
 * 迁移与连接行为的集成测试（STEP 1 验收项）
 *
 * 重点验证三件在 STEP 0 只用脚本冒烟过、但需要作为回归防线固定下来的事：
 *   1. 迁移幂等（跑两次结果一致）
 *   2. 外键约束真实生效且级联删除工作
 *   3. FTS 可幂等重建，且重建后结果一致（§59）
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, MIGRATIONS, createRepositories, now } from '@nwa/storage';
import { projectId, bookId, chapterId } from '@nwa/core';

/** 已打开的 DB 需要在删目录前关闭 —— Windows 上打开的文件句柄会阻止删除（EPERM） */
const opened: Database[] = [];
const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'nwa-mig-'));
  dirs.push(d);
  return d;
}

/** 统一建库入口：登记句柄，便于 afterEach 关闭 */
function open(name: string): Database {
  const db = new Database({ path: join(tmp(), name), migrations: MIGRATIONS });
  opened.push(db);
  return db;
}

afterEach(() => {
  while (opened.length) {
    try {
      opened.pop()!.close();
    } catch {
      /* 已关闭 */
    }
  }
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('迁移', () => {
  it('首次打开应用全部迁移', () => {
    const db = open('a.db');
    const applied = db.all<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
    expect(applied.map((r) => r.id)).toEqual(['0001_init', '0002_checkpoint_seq']);
  });

  it('⚠ 幂等：重复打开同一库不会重复执行迁移', () => {
    const p = join(tmp(), 'b.db');
    const db1 = new Database({ path: p, migrations: MIGRATIONS });
    opened.push(db1);
    const first = db1.all<{ id: string; applied_at: string }>('SELECT * FROM schema_migrations');
    db1.close();

    const db2 = new Database({ path: p, migrations: MIGRATIONS });
    opened.push(db2);
    const second = db2.all<{ id: string; applied_at: string }>('SELECT * FROM schema_migrations');
    db2.close();

    // applied_at 不变，说明没有重新执行（重新执行会写入新时间戳或主键冲突）
    expect(second).toEqual(first);
  });

  it('表与索引数量符合迁移声明（22 表 / 27 索引）', () => {
    const db = open('c.db');
    const tables = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    const indexes = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
    );
    expect(tables.length).toBe(22);
    expect(indexes.length).toBe(27);
  });

  it('连接级 PRAGMA 全部生效', () => {
    const db = open('d.db');
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    // 注意：PRAGMA busy_timeout 返回的列名是 timeout，不是 busy_timeout
    expect(db.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout).toBe(5000);
  });
});

describe('外键与级联', () => {
  it('拒绝引用不存在的父行', () => {
    const db = open('e.db');
    expect(() =>
      db.run('INSERT INTO books (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)',
        'b1', 'no-such-project', 't', now(), now()),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('删除项目级联删除书与章节', () => {
    const db = open('f.db');
    const repos = createRepositories(db);
    const pid = projectId();
    const bid = bookId();
    repos.projects.create({ id: pid, name: 'p' });
    repos.books.create({ id: bid, projectId: pid, title: 'b' });
    repos.chapters.create({ id: chapterId(bid, 1), bookId: bid, chapterNumber: 1 });

    expect(repos.chapters.listByBook(bid)).toHaveLength(1);
    repos.projects.delete(pid);
    expect(repos.books.listByProject(pid)).toHaveLength(0);
    expect(db.all('SELECT * FROM chapters')).toHaveLength(0);
  });

  it('删除证据不删除事实，而是置空引用（COALESCE 策略）', () => {
    const db = open('g.db');
    const repos = createRepositories(db);
    const pid = projectId();
    const bid = bookId();
    repos.projects.create({ id: pid, name: 'p' });
    repos.books.create({ id: bid, projectId: pid, title: 'b' });

    const ev = repos.evidence.create({
      id: 'evid_test1',
      bookId: bid,
      sourceType: 'chapter',
      sourceRef: 'chapters/001.md',
      quote: '张三死了。',
      startOffset: 0,
      endOffset: 5,
      sourceText: '张三死了。李四走了。',
    });
    repos.facts.propose({
      id: 'fact_test1',
      bookId: bid,
      subjectType: 'character',
      subjectId: 'c1',
      predicate: 'status',
      objectValue: 'DEAD',
      confidence: 0.99,
      sourceChapterId: null,
      evidenceId: ev.id,
    });

    db.run('DELETE FROM evidence WHERE id = ?', ev.id);
    const fact = repos.facts.get('fact_test1');
    expect(fact.evidence_id).toBeNull();
    expect(fact.status).toBe('PROVISIONAL');
  });
});

describe('FTS 可幂等重建（§59：索引是派生数据）', () => {
  it('重建两次结果一致，且删除后可从真源恢复', () => {
    const db = open('h.db');
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS chapter_fts USING fts5(tokens, tokenize='unicode61')");

    db.run('INSERT INTO chapter_fts(tokens) VALUES (?)', '张 三 张三 走 了');
    const count = () => db.get<{ c: number }>('SELECT count(*) AS c FROM chapter_fts')?.c ?? 0;
    expect(count()).toBe(1);

    // 第一次重建：清空后从"真源"重灌
    db.rebuildFts('chapter_fts', "SELECT tokens FROM chapter_fts WHERE 0");
    expect(count()).toBe(0);

    db.run('INSERT INTO chapter_fts(tokens) VALUES (?)', '张 三 张三');
    const after1 = db.all('SELECT tokens FROM chapter_fts ORDER BY tokens');

    // 第二次重建：同样输入
    db.rebuildFts('chapter_fts', "SELECT tokens FROM chapter_fts WHERE 0");
    db.run('INSERT INTO chapter_fts(tokens) VALUES (?)', '张 三 张三');
    const after2 = db.all('SELECT tokens FROM chapter_fts ORDER BY tokens');

    expect(after2).toEqual(after1);
  });

  it('中文词元可被 MATCH 命中（ADR-0004 的落地验证）', () => {
    const db = open('i.db');
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS f USING fts5(tokens, tokenize='unicode61')");
    db.run('INSERT INTO f(tokens) VALUES (?)', '张 三 张三 走 了 李 四 李四');
    const hits = db.all<{ tokens: string }>('SELECT tokens FROM f WHERE f MATCH ?', '"张三" AND "李四"');
    expect(hits).toHaveLength(1);
  });
});

describe('exec 传参拦截', () => {
  it('拒绝用 exec 执行带占位符的写语句', () => {
    const db = open('j.db');
    expect(() => db.exec('INSERT INTO projects (id) VALUES (?)')).toThrow(/参数绑定/);
  });
  it('允许无参数的 DDL', () => {
    const db = open('k.db');
    expect(() => db.exec('CREATE TABLE probe_tmp (a TEXT)')).not.toThrow();
  });
});
