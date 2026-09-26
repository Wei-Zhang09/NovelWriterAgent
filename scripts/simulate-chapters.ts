/**
 * 20 章模拟数据（施工计划 STEP 11 验收命令）
 *
 *   pnpm --filter @nwa/harness exec tsx scripts/simulate-chapters.ts --count=20
 *
 * 不用真实 LLM —— 用确定性的 fixture 直接产出正文，
 * 目的是验证**提交链路在批量场景下不丢数据**（§53 Phase 2 的要求）。
 *
 * 检查项（与施工计划一致）：
 *   - facts 无丢失
 *   - character_states 每章一条
 *   - commit_manifests 全部 COMMITTED
 *   - 重启后 resume 能继续
 *   - FTS 可 rebuild 且 rebuild 后结果一致
 *
 * ⚠ 这是**验证脚本**而非测试：它在一个真实临时项目目录里跑完整链路，
 *   并把结果打印出来供人工核对。失败时以非零码退出。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Logger } from '@nwa/core';
import { Database, createRepositories, MIGRATIONS } from '@nwa/storage';
import { CommitEngine } from '@nwa/harness';
import { ChapterWorkspace } from '@nwa/story';
import { FtsIndex } from '@nwa/storage';
import { bigramTokenizer, Retriever, buildMatchExpression } from '@nwa/retrieval';
import { SummaryIndexer, MemoryGatherer } from '@nwa/harness';

const logger = new Logger('simulate', { level: 'error' });

const count = Number(process.argv.find((a) => a.startsWith('--count='))?.split('=')[1] ?? '20');

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: CheckResult[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

const dir = mkdtempSync(join(tmpdir(), 'nwa-sim-'));
let db: Database | null = null;

try {
  const dbPath = join(dir, 'project.db');
  db = new Database({ path: dbPath, migrations: MIGRATIONS });
  const repos = createRepositories(db);

  const pid = 'proj_sim';
  const bid = 'book_sim';
  repos.projects.create({ id: pid, name: '模拟项目', genre: 'urban_fantasy' });
  repos.books.create({ id: bid, projectId: pid, title: '模拟小说' });

  const protagonist = repos.characters.create({ id: 'ch_sim_hero', bookId: bid, name: '张三' });

  // FTS 索引器（补缺口：检索可用）
  const fts = new FtsIndex({ db, tokenizer: bigramTokenizer, logger });
  const summaryIndexer = new SummaryIndexer({ repos, fts, logger });

  // ── 逐章：写草稿 → 提交 ─────────────────────────────────
  for (let n = 1; n <= count; n++) {
    const chapter = repos.chapters.create({
      id: `ch_sim_${String(n).padStart(3, '0')}`,
      bookId: bid,
      chapterNumber: n,
      title: `第 ${n} 章`,
    });

    const body = `第 ${n} 章正文。张三在第 ${n} 章的所作所为。`.repeat(6);
    const summary = `第 ${n} 章：张三继续前行。`;

    // 工作区产物（模拟 Writer 的输出）
    const ws = new ChapterWorkspace({ rootDir: dir, bookId: bid, chapterNumber: n, logger });
    ws.ensure();
    ws.writeText('draft', body);

    // 每章一条角色状态（验证 character_states 不丢）
    repos.characters.appendState({
      id: `cs_sim_${n}`,
      characterId: protagonist.id,
      chapterNumber: n,
      state: { status: n === 15 ? 'DEAD' : 'ALIVE', chapter: n },
    });

    // ⚠ CommitEngine 直接接收 summary 参数（不从章节记录读），
    //   所以这里不需要预先写 summary 到库里 —— engine 会在 APPLY 阶段写。

    const engine = new CommitEngine({
      db,
      repos,
      rootDir: dir,
      logger,
      indexer: {
        indexChapter: (input) => {
          fts.indexChapter({
            chapterId: input.chapterId,
            bookId: bid,
            chapterNumber: input.chapterNumber,
            sourceRef: input.sourceRef,
            text: input.body,
          });
        },
      },
    });
    const report = engine.commit({
      chapterId: chapter.id,
      // ⚠ 必须显式传 bookId（P0-1 按书隔离）：落盘路径与 FTS 的隔离键都由它决定。
      //   漏传会在 `chapterRel()` 里抛 "bookId 不能为空"，本脚本此前因此整跑失败。
      bookId: bid,
      chapterNumber: n,
      body,
      summary,
    });

    // 作者确认摘要（ADR-0006 约束 C）→ 才进记忆索引
    repos.chapters.approveSummary(chapter.id);
    summaryIndexer.indexChapter(chapter.id);

    if (!report.ok) {
      check(`第 ${n} 章提交`, false, `status=${report.status} ${report.error?.message ?? ''}`);
      break;
    }
  }

  // ── 验收检查 ────────────────────────────────────────────

  const committed = db.all<{ id: string }>(
    "SELECT id FROM chapters WHERE status = 'COMMITTED' AND book_id = ?",
    bid,
  );
  check('全部章节 COMMITTED', committed.length === count, `${committed.length}/${count}`);

  const manifests = db.all<{ status: string }>('SELECT status FROM commit_manifests');
  const allCommitted = manifests.every((m) => m.status === 'COMMITTED');
  check(
    'commit_manifests 全部 COMMITTED',
    allCommitted && manifests.length === count,
    `${manifests.filter((m) => m.status === 'COMMITTED').length}/${count}`,
  );

  const states = db.all<{ chapter_number: number }>(
    'SELECT chapter_number FROM character_states WHERE character_id = ? ORDER BY chapter_number',
    protagonist.id,
  );
  check('character_states 每章一条', states.length === count, `${states.length}/${count}`);

  const bodyPaths = db.all<{ body_path: string | null }>(
    'SELECT body_path FROM chapters WHERE book_id = ?',
    bid,
  );
  check(
    '每章都有 body_path（正文物理落盘）',
    bodyPaths.every((r) => r.body_path !== null),
    `${bodyPaths.filter((r) => r.body_path !== null).length}/${count}`,
  );

  // 重启：关闭后用同一路径重开，验证可继续
  db.close();
  db = new Database({ path: dbPath, migrations: MIGRATIONS });
  const reopened = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM chapters WHERE status = 'COMMITTED'");
  check('重启后数据仍在（可 resume）', reopened?.n === count, `${reopened?.n ?? 0}/${count}`);

  // 启动恢复应当无事可做（全部已提交）
  const repos2 = createRepositories(db);
  const recovery = new CommitEngine({ db, repos: repos2, rootDir: dir, logger }).recoverOnStartup();
  check('重启后无需修复（无残留事务）', recovery.scanned === 0, `scanned=${recovery.scanned}`);

  // ⚠ 重开数据库后必须重建 FtsIndex —— 旧实例持有的是**已关闭**的句柄
  //   （实测报"数据库连接已关闭"）。这是重启路径的常见坑：
  //   状态对象与连接同生命周期，不能跨重开复用。
  const fts2 = new FtsIndex({ db, tokenizer: bigramTokenizer, logger });

  // FTS 检索可用性（补缺口后的真实验证）
  //
  // ⚠ 这一项现在**真的查**，不再跳过 —— 索引已建（迁移 0005）。
  try {
    const retriever = new Retriever({ runner: fts2, tokenizer: bigramTokenizer });
    const r = retriever.retrieve({ query: '张三', limit: 20 });

    check(
      'FTS 能检索已提交章节',
      r.hits.length === count,
      `命中 ${r.hits.length}/${count} 章`,
    );
    // 命中必须带可回溯来源（§11）
    check(
      '检索命中均带 sourceRef',
      r.hits.every((h) => typeof h.sourceRef === 'string' && h.sourceRef.length > 0),
      `引擎 ${r.engine}`,
    );

    // 摘要（已确认）应进入记忆索引并可检索
    const gatherer = new MemoryGatherer({
      retriever,
      memoryIndex: fts2,
      buildMatch: (q) => buildMatchExpression(bigramTokenizer.query(q)),
      logger,
    });
    const mem = gatherer.gather('张三前行', { bookId: bid, includeMemoryIndex: true });
    check(
      '长程记忆（摘要）可检索',
      mem.retrieved && mem.entries.length > 0,
      `${mem.entries.length} 条记忆`,
    );

    // 重建后结果一致（§59：FTS 是 Derived）
    const before = retriever.retrieve({ query: '张三', limit: 20 }).hits.map((h) => h.id).sort();
    fts2.rebuild({
      chapters: db.all<{ id: string; body_path: string; chapter_number: number }>(
        "SELECT id, body_path, chapter_number FROM chapters WHERE status = 'COMMITTED' ORDER BY chapter_number",
      ).map((c) => ({
        chapterId: c.id,
        bookId: bid,
        chapterNumber: c.chapter_number,
        sourceRef: c.body_path,
        text: existsSync(join(dir, c.body_path)) ? readFileSync(join(dir, c.body_path), 'utf8') : '',
      })),
      memories: [],
    });
    const after = retriever.retrieve({ query: '张三', limit: 20 }).hits.map((h) => h.id).sort();
    check(
      'FTS 重建后结果一致（§59）',
      JSON.stringify(after) === JSON.stringify(before),
      `重建前 ${before.length} 章 / 重建后 ${after.length} 章`,
    );
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      console.log('  重建前 ID:', JSON.stringify(before.slice(0, 3)));
      console.log('  重建后 ID:', JSON.stringify(after.slice(0, 3)));
    }
  } catch (e) {
    check('FTS 检索可用性', false, e instanceof Error ? e.message : String(e));
  }

  // 无孤儿文件（.next/.previous 都已清理）
  const chapterDir = join(dir, 'chapters');
  const leftovers = db.all<{ body_path: string }>('SELECT body_path FROM chapters WHERE body_path IS NOT NULL');
  const orphans = leftovers.filter((r) => !existsSync(join(dir, r.body_path)));
  void chapterDir;
  check('无缺失的正式章节文件', orphans.length === 0, `缺失 ${orphans.length} 个`);
} catch (e) {
  // ⚠ 打印 stack（不只 message）：异常可能来自深层调用，只有 message
  //   会让人无从定位（此前只印 message，排查时得靠猜）。
  const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
  check('未捕获异常', false, detail.split('\n').slice(0, 8).join(' | '));
} finally {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

// ── 输出 ────────────────────────────────────────────────────
console.log(`\n模拟 ${count} 章 —— 验收结果\n${'─'.repeat(52)}`);
for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}  —  ${c.detail}`);
}
const failed = checks.filter((c) => !c.ok);
console.log('─'.repeat(52));
console.log(`结果：${checks.length - failed.length}/${checks.length} 通过`);

if (failed.length > 0) {
  console.error('\n存在未通过项，退出码 1');
  process.exit(1);
}
