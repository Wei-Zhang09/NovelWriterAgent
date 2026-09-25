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
import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const OUT = join(appRoot, 'dist', 'gui-flow-result.json');

if (existsSync(OUT)) unlinkSync(OUT);

// ⚠ 每次从**干净的项目目录**开始。
//
// 原实现只删结果文件、不删项目目录，于是上一轮留下的
// `workspace/chapters/NN/manuscript.md` 会被下一轮读到 ——
// 断言"编辑器初值为空"就会失败，而失败原因与本次改动毫无关系。
// 更糟的是它会**掩盖**真实缺陷：上一轮存下的正文恰好让
// "保存后状态回到已保存"之类的断言通过。
//
// 这与 STEP 21 修过的「verify 脚本污染真实项目」是同一类问题：
// 验证脚本的状态必须在它自己控制之下。
const PROJECTS = join(tmpdir(), 'nwa-verify-flow');
if (existsSync(PROJECTS)) rmSync(PROJECTS, { recursive: true, force: true });

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
      NWA_PROJECTS_ROOT: PROJECTS,
      // ⚠ 界面结构验证不应真实调用 LLM（会消耗配额、拖慢、且引入超时假失败）。
      //   指向不存在的路径 → agentReady=false → 界面显示"需先配置模型"，
      //   正好也是我们要断言的"诚实失败"路径。
      NWA_USER_MODELS_PATH: join(tmpdir(), 'nwa-verify-flow-no-model.json'),
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
