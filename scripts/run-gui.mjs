/**
 * 运行 GUI 验证（跨平台包装，供 pnpm verify:gui 调用）
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const appRoot = join(ROOT, 'apps', 'desktop');

const need = [
  join(appRoot, 'dist', 'main', 'main.js'),
  join(appRoot, 'dist', 'preload', 'preload.cjs'),
  join(appRoot, 'dist', 'renderer', 'index.html'),
];
const missing = need.filter((p) => !existsSync(p));
if (missing.length) {
  console.error('✗ 缺少构建产物，请先运行 pnpm build：');
  for (const m of missing) console.error('  ' + m);
  process.exit(1);
}

const r = spawnSync(process.execPath, ['scripts/verify-gui.mjs'], {
  cwd: appRoot,
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
