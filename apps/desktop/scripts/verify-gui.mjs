/**
 * GUI 启动验证（STEP 0 手工验收用）
 *
 * 与 smoke.mjs 的区别：smoke 只验证 main→core→storage 链路；
 * 本脚本验证**真实主进程 + preload + 渲染进程**三件套能否协同渲染出三栏 UI。
 *
 * 做法：用 `electron .` 启动真实应用（带 NWA_GUI_PROBE=1），
 *      main.ts 在该环境变量下会于窗口就绪后把渲染进程的 DOM 状态写盘并退出。
 *      这样测的是真实路径，不是替身。
 *
 * 运行：node scripts/verify-gui.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const PROBE_OUT = join(appRoot, 'dist', 'gui-result.json');

if (existsSync(PROBE_OUT)) unlinkSync(PROBE_OUT);

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron', '.'],
  {
    cwd: appRoot,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      NWA_GUI_PROBE: '1',
      // ⚠ 隔离项目目录：GUI 验证会真实建书/建章，
      //   写进用户真实项目会造成污染（曾累积 24 本重名书）。
      NWA_PROJECTS_ROOT: join(tmpdir(), 'nwa-verify-gui'),
    },
    stdio: 'inherit',
  },
);

const code = await new Promise((resolve) => child.on('exit', resolve));

if (!existsSync(PROBE_OUT)) {
  console.error('✗ 未生成 GUI 探针结果，应用可能未启动成功');
  process.exit(1);
}

const result = JSON.parse(readFileSync(PROBE_OUT, 'utf8'));
console.log('\n=== GUI 验证结果 ===');
console.log(`三栏数量: ${result.paneCount}（期望 3）`);
console.log(`自检项数量: ${result.checkCount}`);
console.log(`通过项: ${result.okChecks}`);
if (result.failedChecks?.length) {
  console.log('失败项:');
  for (const f of result.failedChecks) console.log('  ' + f);
}
console.log('');
for (const c of result.checks ?? []) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.label} — ${c.value}`);
}
console.log(`\n判定：${result.pass ? '通过' : '未通过'}（electron 退出码 ${code}）`);
process.exit(result.pass ? 0 : 1);
