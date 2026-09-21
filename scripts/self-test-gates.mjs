/**
 * 门禁自检（meta-test）
 *
 * 为什么需要这个脚本：
 *   骨架开发中真实发生过 —— check-storage-exec.mjs 的第一版对**故意注入的违规代码**
 *   返回了「通过」（false negative）。一个不会失败的门禁等于没有门禁。
 *   因此每个门禁都必须被证明「违规时真的会失败」。
 *
 * 做法：向真实源码目录写入违规/合法样本，运行门禁，断言退出码，然后清理。
 * 所有样本用 __gateprobe__ 前缀，且用 try/finally 保证清理。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const PROBE = join(ROOT, 'packages', 'core', 'src', '__gateprobe__.ts');

function runGate(script, cwd = ROOT) {
  return spawnSync(process.execPath, [join(ROOT, 'scripts', script)], {
    cwd,
    encoding: 'utf8',
  });
}

const failures = [];
function expect(desc, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? '✓' : '✗'} ${desc}（退出码 ${actual}，期望 ${expected}）`);
  if (!ok) failures.push(desc);
}

const VIOLATIONS = [
  {
    name: '向 exec 传参（字符串 + 第二参数）',
    code: [
      'const db = { exec: (_s: string, _p?: unknown) => {}, run: (..._a: unknown[]) => {} };',
      "db.exec('INSERT INTO t(x) VALUES (?)', 'v');",
    ].join('\n'),
  },
  {
    name: '向 exec 传参（内层含括号的表达式）',
    code: [
      'const db = { exec: (_s: string, _p?: unknown) => {}, run: (..._a: unknown[]) => {} };',
      "db.exec('UPDATE t SET a=?', String(1 + 2));",
    ].join('\n'),
  },
  {
    name: '向 exec 传参（模板串）',
    code: [
      'const db = { exec: (_s: string, _p?: unknown) => {}, run: (..._a: unknown[]) => {} };',
      'const table = "t";',
      'db.exec(`INSERT INTO ${table}(x) VALUES (?)`, 42);',
    ].join('\n'),
  },
];

const LEGITIMATE = [
  {
    name: '合法 DDL / PRAGMA / 含逗号的字面量 SQL',
    code: [
      'const db = { exec: (_s: string) => {}, run: (..._a: unknown[]) => {} };',
      "db.exec('PRAGMA foreign_keys = ON');",
      'db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize=\'unicode61\')");',
      'db.exec("INSERT INTO t VALUES (1, \'a,b,c\')");',
      'db.exec(`CREATE TABLE u (a TEXT, b TEXT)`);',
      "db.run('INSERT INTO t(x) VALUES (?)', 'v');",
    ].join('\n'),
  },
];

const NEWLINE = String.fromCharCode(10);

console.log('=== 门禁自检：check:storage ===');
try {
  for (const v of VIOLATIONS) {
    writeFileSync(PROBE, v.code.split('\n').join(NEWLINE) + NEWLINE, 'utf8');
    expect(`捕获违规：${v.name}`, runGate('check-storage-exec.mjs').status, 1);
  }
  for (const l of LEGITIMATE) {
    writeFileSync(PROBE, l.code.split('\n').join(NEWLINE) + NEWLINE, 'utf8');
    expect(`不误报：${l.name}`, runGate('check-storage-exec.mjs').status, 0);
  }
} finally {
  if (existsSync(PROBE)) unlinkSync(PROBE);
}

console.log('=== 门禁自检：check:boundary ===');
// 边界门禁的违规样本不能写进真实包（会被 pnpm 依赖图影响），
// 改为验证「当前代码库本身合规」+ 「门禁在无违规时返回 0」。
expect('当前代码库合规', runGate('check-boundaries.mjs').status, 0);

if (failures.length > 0) {
  console.error(`\n✗ 门禁自检失败，${failures.length} 项未通过：`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\n✓ 门禁自检通过（违规可捕获、合法不误报）');
