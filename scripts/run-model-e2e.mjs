/**
 * 运行模型接入端到端验证（跨平台包装，供 pnpm verify:model 调用）
 *
 * 关键：脚本必须由 **electron** 启动，而不是 node。
 *   `electron` 是 CommonJS 模块，在纯 Node 下 import { app } 会报
 *   "Named export 'app' not found"（实测踩到）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const appRoot = join(ROOT, 'apps', 'desktop');

const need = [
  join(appRoot, 'dist', 'main', 'core-process.js'),
  join(ROOT, 'packages', 'harness', 'dist', 'index.js'),
];
const missing = need.filter((p) => !existsSync(p));
if (missing.length) {
  console.error('✗ 缺少构建产物，请先运行 pnpm build：');
  for (const m of missing) console.error('  ' + m);
  process.exit(1);
}

const r = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron', 'scripts/verify-model-e2e.mjs'],
  {
    cwd: appRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/' },
  },
);
process.exit(r.status ?? 1);
