/**
 * 运行端到端冒烟（跨平台包装，供 pnpm verify:smoke 调用）
 *
 * 前置：workspace 包必须已构建（冒烟加载的是 dist 产物）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const appRoot = join(ROOT, 'apps', 'desktop');

const need = [
  join(ROOT, 'packages', 'storage', 'dist', 'index.js'),
  join(appRoot, 'dist', 'main', 'core-process.js'),
  join(appRoot, 'dist', 'renderer', 'index.html'),
];
const missing = need.filter((p) => !existsSync(p));
if (missing.length) {
  console.error('✗ 缺少构建产物，请先运行 pnpm build：');
  for (const m of missing) console.error('  ' + m);
  process.exit(1);
}

const r = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron', 'scripts/smoke.mjs'],
  { cwd: appRoot, stdio: 'inherit', shell: process.platform === 'win32',
    env: { ...process.env, ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/' } },
);
process.exit(r.status ?? 1);
