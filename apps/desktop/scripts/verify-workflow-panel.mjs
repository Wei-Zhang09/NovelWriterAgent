/**
 * 工作流面板轮询器泄漏验证（P1 Workflow UI）
 *
 *   node apps/desktop/scripts/verify-workflow-panel.mjs
 *
 * ## 要证明什么
 *
 * `renderAgent()` 开头做的是 `replaceChildren()` —— 只摘 DOM，
 * **不会**清掉旧面板的 `setInterval`。所以如果面板不自己注册"停止函数"，
 * 每渲染一次就多一个永不停止的轮询器，后台持续发 IPC。
 * 用户点几下（切章节、切书、跑一次动作都会触发 renderAgent）就会累积一堆。
 *
 * 本脚本用最小 DOM 替身真实调用 `renderWorkflowPanel()`：
 *   1. 连建 5 个面板 → 统计 `setInterval` 的净存活数
 *   2. 断言最多 1 个存活（模块级 stopActivePoller 保证）
 *
 * ⚠ 为什么不用 jsdom/happy-dom：vitest 的 environment 是 node，
 *   而这个面板是渲染进程代码（依赖 document）。与其为它改全局测试环境，
 *   不如用一个只实现所需 API 的最小替身 —— 这样测的是**面板的真实逻辑**，
 *   而不是某个 DOM 库的行为。
 *
 * @verify-kind: standalone — 针对轮询泄漏的反向验证脚本，只有 2 条断言，不适合混进聚合批次
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const panelPath = join(here, '..', 'src', 'renderer', 'workflow-panel.js');

const steps = [];
const rec = (name, ok, detail) => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ── 最小 DOM 替身 ────────────────────────────────────────
let liveIntervals = 0;
const createdIntervals = new Set();

globalThis.setInterval = (fn, ms) => {
  const id = Symbol('interval');
  createdIntervals.add(id);
  liveIntervals++;
  void fn;
  void ms;
  return id;
};
globalThis.clearInterval = (id) => {
  if (createdIntervals.delete(id)) liveIntervals--;
};
globalThis.window = { confirm: () => true };

function makeEl(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    children: [],
    dataset: {},
    disabled: false,
    type: '',
    value: '',
    checked: false,
    placeholder: '',
    style: {},
    _listeners: {},
    append(...kids) {
      for (const k of kids) this.children.push(k);
    },
    appendChild(k) {
      this.children.push(k);
      return k;
    },
    replaceChildren(...kids) {
      this.children = kids;
    },
    setAttribute(k, v) {
      this[k] = v;
    },
    addEventListener(ev, fn) {
      (this._listeners[ev] ??= []).push(fn);
    },
    querySelectorAll() {
      return [];
    },
  };
  return node;
}
globalThis.document = {
  createElement: (t) => makeEl(t),
  createTextNode: (t) => ({ textContent: t }),
  querySelectorAll: () => [],
  getElementById: () => null,
};

// ── 载入面板模块 ─────────────────────────────────────────
const src = readFileSync(panelPath, 'utf8');
const mod = await import(`data:text/javascript;base64,${Buffer.from(src, 'utf8').toString('base64')}`);
const { renderWorkflowPanel } = mod;

const el = (tag, cls, text) => {
  const n = makeEl(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ⚠ 必须让面板**真的开始轮询**，否则测不到泄漏。
//   第一版这里让 recoverable 返回 count:0，于是面板走"无未完成工作流"
//   分支、从不 startPolling —— 正反两次都是 0 个轮询器，
//   反向验证直接失败，暴露了这个测试根本没在测目标机制。
//
//   现在：recoverable 报 1 个未完成工作流 → 面板载入并 poll →
//   拿到 RUNNING 状态 → startPolling 被调用。
const invoke = async (method) => {
  if (method === 'workflow.recoverable') {
    return {
      ok: true,
      data: { count: 1, workflows: [{ workflowId: 'wf-test-1', status: 'RUNNING' }] },
    };
  }
  if (method === 'workflow.get') {
    // 永远 RUNNING —— 轮询器不会自己停，泄漏才看得出来
    return {
      ok: true,
      data: {
        workflowId: 'wf-test-1',
        status: 'RUNNING',
        chapterNumber: 1,
        currentStage: 'write',
        progress: { total: 12, done: 4, failed: 0, current: 'write' },
        stages: [],
        artifacts: [],
      },
    };
  }
  return { ok: false, error: { code: 'NO', message: 'n/a' } };
};

console.log('\n──── 连建 5 个面板，观察轮询器存活数 ────\n');

for (let i = 0; i < 5; i++) {
  renderWorkflowPanel({
    el,
    state: { selectedBookId: null },
    invoke,
    msg: makeEl('div'),
    refreshChapters: async () => {},
  });
  // 让 queueMicrotask 里的首屏逻辑跑完
  await new Promise((r) => setTimeout(r, 0));
  // 手动触发一次轮询：点"运行完整工作流"会 startPolling，
  // 但这里没有 bookId 会被挡下 —— 直接调内部的 startPolling 不可达，
  // 所以用 recoverable 路径（它会 poll 并 startPolling）。
  console.log(`  第 ${i + 1} 次渲染后：存活轮询器 ${liveIntervals}`);
}

// ⚠ 核心断言：不管建了多少个面板，存活轮询器最多 1 个
rec(
  '⚠ 连续 5 次重建面板后，存活轮询器 ≤ 1（无泄漏）',
  liveIntervals <= 1,
  `存活 ${liveIntervals} 个（建了 5 个面板）`,
);

// ── 反向验证：确认这个断言真的能失败 ──────────────────────
//
// ⚠ 把模块级的 stopActivePoller 机制去掉，再建 5 个面板 ——
//   如果存活数仍然 ≤1，说明本测试根本没在测那个机制。
console.log('\n──── 反向验证：去掉 stopActivePoller 后应泄漏 ────\n');

const brokenSrc = src
  .replace('  if (stopActivePoller) {\n    stopActivePoller();\n    stopActivePoller = null;\n  }\n', '')
  .replace('  stopActivePoller = stopPolling;\n', '');
if (brokenSrc === src) {
  rec('反向验证：成功构造"无 stopActivePoller"版本', false, '替换未生效，测试本身有问题');
} else {
  liveIntervals = 0;
  createdIntervals.clear();
  // 换一个模块实例（data: URL 每次都重新求值，但为保险加个查询串）
  const brokenMod = await import(
    `data:text/javascript;base64,${Buffer.from(brokenSrc, 'utf8').toString('base64')}#broken`
  );
  for (let i = 0; i < 5; i++) {
    brokenMod.renderWorkflowPanel({
      el,
      state: { selectedBookId: null },
      invoke,
      msg: makeEl('div'),
      refreshChapters: async () => {},
    });
    await new Promise((r) => setTimeout(r, 0));
  }
  rec(
    '⚠ 反向验证：去掉修复后确实泄漏（证明断言不是同义反复）',
    liveIntervals > 1,
    `存活 ${liveIntervals} 个`,
  );
}

const failed = steps.filter((s) => !s.ok);
console.log(`\n结果：${steps.length - failed.length}/${steps.length} 通过`);
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`);
process.exit(failed.length === 0 ? 0 : 1);
