/**
 * 开发启动：编译 TS → 启动 Electron。
 *
 * STEP 0 不引入热重载（vite/esbuild），理由：
 *   骨架阶段的首要目标是验证进程架构与 IPC 通路，不是开发体验。
 *   热重载在 STEP 2（UI 开始有真实页面）时再引入，避免过早增加构建复杂度。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))));
    p.on('error', reject);
  });
}

// 1. 编译 workspace 包（有依赖顺序，交给 tsc -b 处理）
console.log('[dev] 编译 TypeScript...');
await run('npx', ['tsc', '-b'], join(appRoot, '..', '..'));

// 2. 拷贝静态资源到 dist
const dist = join(appRoot, 'dist');
mkdirSync(join(dist, 'renderer'), { recursive: true });
mkdirSync(join(dist, 'migrations'), { recursive: true });
for (const f of ['index.html', 'style.css', 'renderer.js']) {
  copyFileSync(join(appRoot, 'src', 'renderer', f), join(dist, 'renderer', f));
}
// 迁移 SQL 需与 dist/migrations 同级，供 MIGRATIONS 运行时读取
const migSrc = join(appRoot, '..', '..', 'packages', 'storage', 'src', 'migrations');
const migDst = join(appRoot, '..', '..', 'packages', 'storage', 'dist', 'migrations');
if (existsSync(migSrc)) {
  mkdirSync(migDst, { recursive: true });
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync(migSrc).filter((x) => x.endsWith('.sql'))) {
    copyFileSync(join(migSrc, f), join(migDst, f));
  }
}

// 3. preload 是 .cts，单独编译为 .cjs（contextIsolation 需要 CommonJS preload）
console.log('[dev] 编译 preload...');
await run('npx', [
  'tsc',
  'src/preload/preload.cts',
  '--outDir', 'dist/preload',
  '--module', 'commonjs',
  '--target', 'ES2022',
  '--moduleResolution', 'node',
  '--esModuleInterop',
  '--skipLibCheck',
], appRoot);

// 4. 启动 Electron
console.log('[dev] 启动 Electron...');
await run('npx', ['electron', '.'], appRoot);
