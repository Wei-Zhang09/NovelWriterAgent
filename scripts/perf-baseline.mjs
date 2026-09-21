/**
 * SQLite 性能基线（施工文档 §66 的目标验证）
 *
 * §66 目标：
 *   SQLite 查询：通常 < 100ms
 *   FTS 查询：  通常 < 200ms
 *
 * 做法：建一个规模可调的项目库，跑真实查询并用中位数/95 分位评估，
 *      而不是用单次耗时下结论（单次测量噪声极大）。
 *
 * 运行：node scripts/perf-baseline.mjs [每表行数]
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

const { Database, MIGRATIONS, createRepositories, now } = await import(
  `file://${join(ROOT, 'packages/storage/dist/index.js').replace(/\\/g, '/')}`
);
const { chapterId, characterId, projectId, bookId, factId, evidenceId } = await import(
  `file://${join(ROOT, 'packages/core/dist/index.js').replace(/\\/g, '/')}`
);

const CHAPTERS = Number(process.argv[2] ?? 500);
const FACTS_PER_CHAPTER = 6;
const CHARACTERS = 60;

const dir = mkdtempSync(join(tmpdir(), 'nwa-perf-'));
const db = new Database({ path: join(dir, 'perf.db'), migrations: MIGRATIONS });
const repos = createRepositories(db);

const pid = projectId();
const bid = bookId();
repos.projects.create({ id: pid, name: 'perf', genre: 'urban_fantasy' });
repos.books.create({ id: bid, projectId: pid, title: 'perf book' });

/** 测量：跑 N 次取中位数与 p95（毫秒） */
function measure(label, fn, iterations = 20) {
  // 预热
  for (let i = 0; i < 3; i++) fn();
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  return { label, median: +median.toFixed(2), p95: +p95.toFixed(2) };
}

// ── 造数据 ────────────────────────────────────────────────
console.log(`造数据：${CHAPTERS} 章 / ${CHARACTERS} 角色 / 每章 ${FACTS_PER_CHAPTER} 条事实…`);
const t0 = performance.now();
const charIds = Array.from({ length: CHARACTERS }, () => characterId());
db.transaction(() => {
  for (const [i, cid] of charIds.entries()) {
    repos.characters.create({ id: cid, bookId: bid, name: `角色${i}`, aliases: [`别名${i}`] });
  }
});
for (let n = 1; n <= CHAPTERS; n++) {
  const cid = chapterId(bid, n);
  db.transaction(() => {
    repos.chapters.create({ id: cid, bookId: bid, chapterNumber: n, title: `第 ${n} 章` });
    if (n % 3 !== 0) {
      // 模拟已提交章节：必须先进入 COMMITTING 才能写正式正文
      // （这是 §9.1 的代码层门禁，perf 脚本也必须遵守真实流程）
      repos.chapters.updateStatus(cid, 'COMMITTING');
      repos.chapters.setCommittedBody(cid, `chapters/${String(n).padStart(3, '0')}.md`, `第 ${n} 章摘要`);
    }
    for (let k = 0; k < FACTS_PER_CHAPTER; k++) {
      const charId = charIds[(n + k) % charIds.length];
      // object 与 quote 都随章节变化 —— 否则内容派生 ID 会把跨章的同型事实
      // 去重成一条，压测规模会远小于真实场景（曾出现 3000 条塌缩成 360 条）
      const quoteText = `状态是 S${k} 的第 ${n} 次记录`;
      const src = `第${n}章 ${charId} ${quoteText}`;
      const start = src.indexOf(quoteText);
      const evId = evidenceId({
        sourceRef: `chapters/${n}.md`,
        startOffset: start,
        endOffset: start + quoteText.length,
        quote: quoteText,
      });
      try {
        repos.evidence.create({
          id: evId, bookId: bid, sourceType: 'chapter', sourceRef: `chapters/${n}.md`,
          quote: quoteText, startOffset: start, endOffset: start + quoteText.length, sourceText: src,
        });
      } catch { /* 重复证据跳过 */ }

      const objVal = `S${k}_ch${n}`;
      const fid = factId({ subjectType: 'character', subjectId: charId, predicate: `p${k}`, objectValue: objVal });
      repos.facts.propose({
        id: fid, bookId: bid, subjectType: 'character', subjectId: charId,
        predicate: `p${k}`, objectValue: objVal, confidence: 0.9,
        sourceChapterId: cid, evidenceId: evId,
      });
      if (k === 0) { try { repos.facts.promoteToCanon(fid); } catch { /* 无证据则跳过 */ } }
    }
    if (n <= 50) {
      repos.characters.appendState({
        id: `cs_${n}`, characterId: charIds[n % charIds.length], chapterNumber: n,
        state: { location: `地点${n}`, hp: 100 - (n % 50) },
      });
    }
  });
}
const buildMs = performance.now() - t0;

const counts = {
  chapters: db.get('SELECT count(*) c FROM chapters').c,
  facts: db.get('SELECT count(*) c FROM facts').c,
  evidence: db.get('SELECT count(*) c FROM evidence').c,
  charStates: db.get('SELECT count(*) c FROM character_states').c,
};
console.log(`造数据耗时 ${(buildMs / 1000).toFixed(1)}s`, counts);
console.log('');

// ── 查询基线 ──────────────────────────────────────────────
const results = [];
results.push(measure('章节按号查（每章必经路径）', () =>
  repos.chapters.getByNumber(bid, Math.floor(Math.random() * CHAPTERS) + 1)));
results.push(measure('章节列表（全书）', () => repos.chapters.listByBook(bid)));
results.push(measure('countCommitted（进度判定）', () => repos.chapters.countCommitted(bid)));
results.push(measure('角色状态 as-of 查询', () => {
  const cid = charIds[Math.floor(Math.random() * charIds.length)];
  return repos.characters.stateAt(cid, CHAPTERS);
}));
results.push(measure('facts 按状态过滤（CANON）', () => repos.facts.listByStatus(bid, 'CANON')));
results.push(measure('facts 按主体查（每章 Commit 必经）', () => {
  const cid = charIds[Math.floor(Math.random() * charIds.length)];
  return repos.facts.listBySubject(bid, 'character', cid);
}));
results.push(measure('矛盾检测（全表 GROUP BY）', () => repos.facts.findCanonConflicts(bid)));
results.push(measure('证据按来源查', () => repos.evidence.listBySource('chapter', `chapters/${Math.floor(Math.random() * CHAPTERS) + 1}.md`)));
results.push(measure('角色按名查（含别名回退）', () => repos.characters.findByName(bid, `别名${Math.floor(Math.random() * CHARACTERS)}`)));

console.log('SQLite 查询基线（中位数 / p95，目标 < 100ms）');
console.log('─'.repeat(72));
let worst = 0;
for (const r of results) {
  const ok = r.median < 100;
  worst = Math.max(worst, r.median);
  console.log(`${ok ? '✓' : '✗'} ${r.label.padEnd(34)} ${String(r.median).padStart(8)} / ${String(r.p95).padStart(8)} ms`);
}

// ── FTS 基线 ──────────────────────────────────────────────
console.log('');
db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS perf_fts USING fts5(tokens, tokenize='unicode61')");

const { bigramTokenizer, buildMatchExpression } = await import(
  `file://${join(ROOT, 'packages/retrieval/dist/index.js').replace(/\\/g, '/')}`
);

const tFts = performance.now();
db.transaction(() => {
  const rows = db.all('SELECT chapter_number, summary FROM chapters WHERE summary IS NOT NULL');
  const ins = db.prepare('INSERT INTO perf_fts(rowid, tokens) VALUES (?, ?)');
  for (const r of rows) {
    ins.run(r.chapter_number, bigramTokenizer.index(`${r.summary} 张三 李四 城门 戒指 裂纹 月光`));
  }
});
const ftsBuildMs = performance.now() - tFts;

const ftsResults = [];
for (const q of ['张三', '李四', '城门', '戒指']) {
  ftsResults.push(measure(`FTS 中文检索「${q}」`, () => {
    const tokens = bigramTokenizer.query(q);
    return db.all('SELECT rowid FROM perf_fts WHERE perf_fts MATCH ?', buildMatchExpression(tokens));
  }));
}

console.log(`FTS 索引构建：${(ftsBuildMs / 1000).toFixed(2)}s（${counts.chapters} 行）`);
console.log('FTS 查询基线（中位数 / p95，目标 < 200ms）');
console.log('─'.repeat(72));
for (const r of ftsResults) {
  const ok = r.median < 200;
  console.log(`${ok ? '✓' : '✗'} ${r.label.padEnd(34)} ${String(r.median).padStart(8)} / ${String(r.p95).padStart(8)} ms`);
}

// ── 结果落盘 ──────────────────────────────────────────────
const summary = {
  generatedAt: now(),
  node: process.version,
  electron: 'n/a（本脚本跑在纯 Node 下）',
  scale: { chapters: CHAPTERS, characters: CHARACTERS, factsPerChapter: FACTS_PER_CHAPTER, ...counts },
  buildMs: +buildMs.toFixed(1),
  sqliteQueries: results,
  ftsQueries: ftsResults,
  thresholds: { sqliteMedianMs: 100, ftsMedianMs: 200 },
  worstSqliteMedianMs: worst,
};
const out = join(ROOT, 'docs', 'operations', 'perf-baseline.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(summary, null, 2), 'utf8');

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n结果已写入 docs/operations/perf-baseline.json`);
