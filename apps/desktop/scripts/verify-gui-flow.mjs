/**
 * GUI 端到端验证（STEP 2 验收）
 *
 * 与 verify-gui.mjs 的区别：
 *   verify-gui   只验证「界面渲染出来了」（STEP 0 的验收）
 *   本脚本         验证「真实用户流程能走通」（STEP 2 的验收）：
 *                  新建项目 → 新建书目 → 新建章节 → 章节出现在左栏
 *                  并且**驱动真实的 DOM**（点击按钮、填输入框），
 *                  而不是直接调 core 方法。
 *
 * 做法：主进程在 NWA_GUI_FLOW=1 时，等页面就绪后用 executeJavaScript
 *      在渲染进程里跑一段流程脚本，把每步结果收集回来。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const OUT = join(appRoot, 'dist', 'gui-flow-result.json');

if (existsSync(OUT)) unlinkSync(OUT);

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron', '.'],
  {
    cwd: appRoot,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      NWA_GUI_FLOW: '1',
      // ⚠ 隔离项目目录：GUI 流程验证会真实建书/建章，不得污染用户项目。
      NWA_PROJECTS_ROOT: join(tmpdir(), 'nwa-verify-flow'),
    },
    stdio: 'inherit',
  },
);

// 等子进程结束；退出码不直接采用 —— 以结果文件的判定为准，
// 因为 Electron 在 Windows 下偶发会以非 0 码退出而结果其实是成功的。
await new Promise((resolve) => child.on('exit', resolve));

if (!existsSync(OUT)) {
  console.error('✗ 未生成流程验证结果');
  process.exit(1);
}

const r = JSON.parse(readFileSync(OUT, 'utf8'));
console.log('\n=== GUI 端到端流程验证 ===');
for (const s of r.steps) {
  console.log(`  ${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
}
console.log(`\n判定：${r.pass ? '通过' : '未通过'}（${r.steps.filter((s) => s.ok).length}/${r.steps.length}）`);
if (r.error) console.log(`错误：${r.error}`);
process.exit(r.pass ? 0 : 1);
