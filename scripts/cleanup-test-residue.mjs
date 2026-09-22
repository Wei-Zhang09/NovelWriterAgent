/**
 * 清理 verify 脚本写进真实项目目录的测试垃圾
 *
 *   node scripts/cleanup-test-residue.mjs          # 只预览
 *   node scripts/cleanup-test-residue.mjs --apply  # 执行
 *
 * ## ⚠ 背景（这是一次真实事故的善后）
 *
 * `project.open` 只读 `params.dir`，而 8 个 verify 脚本传的是 `rootDir`
 * —— 参数被**静默忽略**。脚本以为在临时目录跑，实际全部打开了用户的
 * 真实项目目录 `~/NovelWriterProjects`，往里面写测试书目/章节/导出物。
 *
 * 根因已修（project.open 接受 rootDir 别名 + 源码级防回退测试）。
 * 本脚本清理**已经写进去的**残留。
 *
 * ## ⚠ 清理原则
 *
 * 1. **只删特征明确的测试产物** —— 按书名前缀匹配，不做"清空目录"
 * 2. **绝不碰 models.json** —— 用户的模型配置（含加密密钥）
 * 3. **默认只预览**，`--apply` 才真删
 * 4. **先备份**（由调用方负责；本脚本只删，不做打包 ——
 *    打包逻辑越简单越不容易出错）
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const APPLY = process.argv.includes('--apply');
const ROOT = process.env['NWA_CLEAN_ROOT'] ?? join(homedir(), 'NovelWriterProjects');

/** 测试书目的标题前缀（verify 脚本的固定命名） */
const TEST_BOOK_PREFIXES = ['技能验证-', '技能验证项目-', '备份验证'];
/** 测试产生的目录（相对项目根） */
const TEST_DIRS = [
  { dir: 'exports', prefix: 'export-' },
  { dir: 'workspace', prefix: 'chapter-' },
];

function main() {
  if (!existsSync(ROOT)) {
    console.log(`项目目录不存在：${ROOT}`);
    return;
  }
  console.log(`项目目录：${ROOT}\n`);

  // 用 sqlite3 CLI 读（避免依赖编译产物；只读查询足够）
  const dbPath = join(ROOT, 'project.db');
  const books = dbPath && existsSync(dbPath) ? readBooks(dbPath) : [];

  const targets = books.filter((b) => TEST_BOOK_PREFIXES.some((p) => b.title.startsWith(p)));

  console.log('── 将删除的测试书目 ──');
  if (targets.length === 0) console.log('  （无）');
  for (const b of targets) {
    console.log(`  ${b.title}  （${b.chapters} 个章节）`);
  }

  console.log('\n── 将删除的测试目录 ──');
  const dirs = [];
  for (const { dir, prefix } of TEST_DIRS) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const e of readdirSync(abs)) {
      if (e.startsWith(prefix)) dirs.push(`${dir}/${e}`);
    }
  }
  if (dirs.length === 0) console.log('  （无）');
  for (const d of dirs) console.log(`  ${d}`);

  console.log('\n── 保留不动 ──');
  for (const f of ['models.json', 'project.db', 'chapters', 'summaries', 'canon', 'corpus', 'skills']) {
    if (existsSync(join(ROOT, f))) console.log(`  ✓ ${f}`);
  }
  console.log('  ⚠ models.json（模型配置 + 加密密钥）绝不触碰');

  if (!APPLY) {
    console.log('\n⚠ 默认只预览。要真正执行请加 --apply');
    return;
  }

  console.log('\n── 执行清理 ──');
  // 删书目（用 sqlite3 执行；外键 CASCADE 会带走其章节）
  if (targets.length > 0) {
    const ids = targets.map((b) => `'${b.id}'`).join(',');
    runSql(dbPath, `PRAGMA foreign_keys=ON; DELETE FROM books WHERE id IN (${ids});`);
    console.log(`  已删除 ${targets.length} 本测试书`);
  }
  for (const d of dirs) {
    rmSync(join(ROOT, d), { recursive: true, force: true });
    console.log(`  已删除 ${d}`);
  }
  console.log('\n✅ 清理完成');
}

/** 用 better-sqlite3 之外的方式读：直接 spawn sqlite3 不一定可用，故用 node:sqlite */
function readBooks(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT id, title FROM books').all();
    return rows.map((b) => {
      const n = db
        .prepare('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?')
        .get(b.id);
      return { id: b.id, title: b.title, chapters: n?.n ?? 0 };
    });
  } finally {
    db.close();
  }
}

function runSql(dbPath, sql) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

main();
