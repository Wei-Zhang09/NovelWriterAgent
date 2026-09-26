/**
 * 运行全部「可离线单跑」验证脚本（standalone 批次）
 *
 * ## 为什么需要它
 *
 * 这些脚本各自能跑，但此前**没有任何入口一次跑完** —— `verify:all` 只串了 5 个。
 * 实测代价：`verify:manuscript-editor` 在 M6/M7 加相对导入后整跑崩溃，
 * 连续四个里程碑无人发现（详见 check-verify-coverage.mjs 的说明）。
 *
 * 本脚本 + check-verify-coverage.mjs 合起来构成闭环：
 *   - 覆盖度门禁保证「每个脚本都被显式归类」，新增脚本不归类就失败
 *   - 本脚本把 standalone 批次真正跑起来，归类不再只是纸面声明
 *
 * ## ⚠ 隔离：绝不写用户的真实项目目录
 *
 * 这些脚本走真实 IPC，而 IPC 的 PROJECTS_ROOT 默认是 `~/NovelWriterProjects`。
 * 不隔离就会往用户的真实创作目录里写验证数据（历史上真发生过：24 本重名
 * 「测试小说」）。所以这里强制把 NWA_PROJECTS_ROOT / NWA_CORPUS_ROOT 指向
 * 临时目录，且每次开跑前清空。
 *
 * 需要真实模型（needs-model）的脚本**不在此列** —— 见 check-verify-coverage.mjs。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

/** standalone 批次：顺序固定，便于对照。 */
const SCRIPTS = [
  'verify:manuscript-editor',
  'verify:autosave-scheduler',
  'verify:workflow-panel',
  'verify:corpus',
  'verify:corpus-import',
  'verify:multibook',
  'verify:endpoint',
  'verify:backup',
  'verify:prune',
];

// ── 隔离目录 ──────────────────────────────────────────────
const ISO = join(tmpdir(), 'nwa-verify-standalone');
rmSync(ISO, { recursive: true, force: true });
mkdirSync(ISO, { recursive: true });

const env = {
  ...process.env,
  NWA_PROJECTS_ROOT: join(ISO, 'projects'),
  NWA_CORPUS_ROOT: join(ISO, 'corpus'),
};

// 构建产物必须就位（多数脚本加载 dist）
const need = [
  join(ROOT, 'packages', 'storage', 'dist', 'index.js'),
  join(ROOT, 'apps', 'desktop', 'dist', 'main', 'core-process.js'),
];
const missing = need.filter((p) => !existsSync(p));
if (missing.length) {
  console.error('✗ 缺少构建产物，请先运行 pnpm build：');
  for (const m of missing) console.error('  ' + m);
  process.exit(1);
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const results = [];

for (const key of SCRIPTS) {
  process.stdout.write(`\n${'═'.repeat(56)}\n▶ ${key}\n${'═'.repeat(56)}\n`);
  const started = Date.now();
  // ⚠ Windows 上 pnpm 是 .cmd 垫片，必须经 shell 才能启动；但 shell:true
  //   同时传 args 数组会触发 DEP0190（只拼接不转义）。所以传**单个命令字符串**。
  //   命令来自固定常量 SCRIPTS，不含外部输入。
  const r = spawnSync(`${pnpm} ${key}`, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    env,
  });
  const code = r.status ?? 1;
  results.push({ key, code, ms: Date.now() - started });
}

// ── 汇总 ──────────────────────────────────────────────────
console.log(`\n${'═'.repeat(56)}\nstandalone 批次汇总\n${'═'.repeat(56)}`);
for (const r of results) {
  console.log(`  ${r.code === 0 ? '✓' : '✗'} ${r.key.padEnd(26)} ${(r.ms / 1000).toFixed(1)}s`);
}
const failed = results.filter((r) => r.code !== 0);
console.log('─'.repeat(56));
console.log(`结果：${results.length - failed.length}/${results.length} 通过`);

// ⚠ 清理：别把验证数据留给下一次运行（历史踩过：脚本只 mkdir 从不清理）
rmSync(ISO, { recursive: true, force: true });

if (failed.length > 0) {
  console.log(`\n失败：${failed.map((f) => f.key).join(', ')}`);
  process.exit(1);
}
