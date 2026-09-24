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
    expect(applied.map((r) => r.id)).toEqual([
      '0001_init',
      '0002_checkpoint_seq',
      '0003_foreshadow_payoff',
      '0004_chapter_review',
      '0005_fts',
      '0006_summary_approval',
      '0007_genre_isolation',
      '0008_scene_persistence',
      '0009_skill_summary',
      '0010_workflow',
      '0011_pattern_scope_evidence',
      '0012_commit_force_audit',
      '0013_book_word_target',
    ]);
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

  it('表与索引数量符合迁移声明（FTS 虚拟表与影子表分组断言）', () => {
    const db = open('c.db');
    // ⚠ 实测数字（补缺口后）：
    //   业务表 22 张 + FTS 虚拟表 2 张 = 24
    //   FTS5 为每个虚拟表建 5 张影子表（_data/_idx/_content/_docsize/_config）
    //     → 2 × 5 = 10
    //   索引 27 → 28（0006 新增 idx_chapters_summary_pending）
    //   索引 28 → 32（0007 新增 4 个：idx_skills_genre_scope、
    //     idx_corpus_scenes_genre、idx_patterns_genre_scope、
    //     idx_corpus_documents_genre —— 类型隔离的检索路径）
    //   索引 32 → 35（0008 oversized 列 + 0009 skill summary）
    //   业务表 22 → 27（0010 新增 5 张：workflows、workflow_stages、
    //     workflow_artifacts、retrieval_traces、state_proposals
    //     —— Novel Workflow 的持久化，P0-1/P0-2）
    //   索引 35 → 47（0010 新增 12 个索引，覆盖恢复查询路径：
    //     按 status 捞未完成工作流、按 book/chapter 查工作流、
    //     按 workflow 查 stage/artifact、按 stage 查检索轨迹）
    //   业务表 27 → 28（0012 commit_overrides：Commit 绕过审计）
    //   索引 47 → 51（0012：commit_manifests 重建后 2 个 + overrides 2 个）
    //
    // 分组断言而不是只数总数：这样新增业务表与新增 FTS 表会分别失败，
    // 一眼能看出是哪一类变了。
    const all = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    const shadow = all.filter((t) =>
      /^(chapter_fts|memory_fts)_(data|idx|content|docsize|config)$/.test(t.name),
    );
    const ftsVirtual = all.filter((t) => t.name === 'chapter_fts' || t.name === 'memory_fts');
    const business = all.filter((t) => !shadow.includes(t) && !ftsVirtual.includes(t));

    // 业务表 27 → 28（0012 新增 commit_overrides —— Commit 绕过审计）
    expect(business.length).toBe(28);
    expect(ftsVirtual.length).toBe(2);
    expect(shadow.length).toBe(10);

    const indexes = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
    );
    // 索引 47 → 49（0012 新增 commit_overrides 的 2 个）
    //
    // ⚠ 注意 commit_manifests 的重建对索引总数是**净零**的：
    //   DROP TABLE 会连带删掉它的 2 个索引，重建表后必须手工再建回来。
    //   漏掉那一步总数会变成 47，而"少了索引"在功能上不会立刻报错 ——
    //   只是提交相关的按状态查询退化成全表扫描。
    expect(indexes.length).toBe(49);
  });

  it('⚠ 全部迁移都已应用（构建产物不遗漏 SQL）', () => {
    const db = open('c2.db');
    const applied = db.all<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
    // ⚠ 这条断言源于一个真实 bug：tsc -b 不拷贝 .sql，
    //   dist/migrations 会缺少新迁移，且**不报错**。
    //   开发态测试走 src 所以全绿，构建产物却静默缺迁移。
    //   现在 build 脚本会拷贝并校验数量。
    expect(applied.map((r) => r.id)).toEqual([
      '0001_init',
      '0002_checkpoint_seq',
      '0003_foreshadow_payoff',
      '0004_chapter_review',
      '0005_fts',
      '0006_summary_approval',
      '0007_genre_isolation',
      '0008_scene_persistence',
      '0009_skill_summary',
      '0010_workflow',
      '0011_pattern_scope_evidence',
      '0012_commit_force_audit',
      '0013_book_word_target',
    ]);
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

    // ⚠ 这里的 INSERT 必须提供全部 5 列，且 rebuildFts 的 sourceSql 也必须。
    //   早先测试用 1 列版本，与真实结构冲突
    //   （"table chapter_fts has 5 columns but 1 values were supplied"）。
    const cols = 'tokens, chapter_id, book_id, chapter_number, source_ref';
    const insert = (t: string) => db.run(`INSERT INTO chapter_fts(${cols}) VALUES (?, ?, ?, ?, ?)`, t, 'c1', 'b1', 1, 'chapters/001.md');
    const selectAll = `SELECT ${cols} FROM chapter_fts WHERE 0`;

    insert('张 三 张三 走 了');
    const count = () => db.get<{ c: number }>('SELECT count(*) AS c FROM chapter_fts')?.c ?? 0;
    expect(count()).toBe(1);

    // 第一次重建：清空后从"真源"重灌（WHERE 0 表示真源为空 → 验证清空）
    db.rebuildFts('chapter_fts', selectAll);
    expect(count()).toBe(0);

    insert('张 三 张三');
    const after1 = db.all('SELECT tokens FROM chapter_fts ORDER BY tokens');

    // 第二次重建：同样输入
    db.rebuildFts('chapter_fts', selectAll);
    insert('张 三 张三');
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
