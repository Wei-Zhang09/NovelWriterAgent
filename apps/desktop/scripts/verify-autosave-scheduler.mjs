/**
 * 主进程 autosave 调度器验证（M5 / §八 §十二）
 *
 *   node apps/desktop/scripts/verify-autosave-scheduler.mjs
 *
 * ## 要证明什么
 *
 * M5 的核心决策是**把 autosave 的 debounce 从 renderer 移到主进程**。
 * 理由是：autosave 存在的唯一目的是防丢失，而最常见的丢失场景正是
 * renderer 自己崩掉 —— 定时器活在 renderer 里就会随页面一起死。
 *
 * 这个决策的价值全部体现在主进程的调度器上，而它是主进程代码，
 * vitest 跑不了（依赖 electron 的 app/ipcMain）。所以这里用
 * **最小 electron 替身**直接驱动 `scheduleAutosave` / `flushAutosave`。
 *
 * ## ⚠ 断言必须查数据流的下游终点
 *
 * 这里"下游终点"是 **core 收到的请求**。若只断言"定时器被创建了"，
 * 那么把 `callCore(...)` 整行删掉、只留定时器，测试照样通过 ——
 * 而那条改动会让 autosave 彻底不落盘。
 *
 * @verify-kind: standalone — 用最小 electron 替身直接驱动 scheduleAutosave；vitest 跑不了（依赖 app/ipcMain）
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const steps = [];
const rec = (name, ok, detail) => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ⚠ 读**编译产物**而不是 .ts 源码：源码里有 interface / 类型注解，
//   而 `new Function()` 只接受 JS。手工剥离类型是在重写一遍编译器，
//   且会在语法演进时悄悄失准 —— 直接读 tsc 的产出更可靠。
const mainPath = join(here, '..', 'dist', 'main', 'main.js');

const src = readFileSync(mainPath, 'utf8');

function slice(startMarker, endMarker, label) {
  const i = src.indexOf(startMarker);
  if (i === -1) throw new Error(`未找到起点：${label}`);
  const j = src.indexOf(endMarker, i);
  if (j === -1) throw new Error(`未找到终点：${label}`);
  return src.slice(i, j);
}

const schedSrc2 = slice(
  'const AUTOSAVE_DEBOUNCE_MS',
  'function startCoreProcess',
  'autosave 调度器',
);

// ── 替身：定时器、core 通道、logger ──
const timers = new Map();
let timerSeq = 0;
const fakeSetTimeout = (fn, ms) => {
  const id = ++timerSeq;
  timers.set(id, { fn, ms });
  return id;
};
const fakeClearTimeout = (id) => timers.delete(id);
function fireTimers() {
  const pending = [...timers.entries()];
  timers.clear();
  for (const [, t] of pending) t.fn();
  return pending.length;
}

/** core 收到的请求 —— 这是本验证的"下游终点" */
const coreCalls = [];
const fakeCallCore = (method, params) => {
  coreCalls.push({ method, params });
  return Promise.resolve({ ok: true });
};
const fakeLogger = { info() {}, warn(...a) { fakeLogger._warns.push(a); }, error() {}, _warns: [] };

const factory = new Function(
  'setTimeout',
  'clearTimeout',
  'callCore',
  'logger',
  'Promise',
  `${schedSrc2}
  return { scheduleAutosave, flushAutosave, pendingAutosaves, AUTOSAVE_DEBOUNCE_MS };`,
);

function makeScheduler() {
  timers.clear();
  coreCalls.length = 0;
  fakeLogger._warns.length = 0;
  return factory(fakeSetTimeout, fakeClearTimeout, fakeCallCore, fakeLogger, Promise);
}

const payload = (n, text) => ({
  chapterId: `ch-${n}`,
  text,
  cursor: 0,
  selectionStart: 0,
  selectionEnd: 0,
  scrollTop: 0,
});

// ═══════════════════════════════════════════════════════════
console.log('\n──── 1. debounce：连续输入只落盘一次 ────\n');
// ═══════════════════════════════════════════════════════════
{
  const s = makeScheduler();

  s.scheduleAutosave(payload(1, '第一次'));
  s.scheduleAutosave(payload(1, '第二次'));
  s.scheduleAutosave(payload(1, '第三次'));

  rec(
    '⚠ 连续三次输入**没有**立即落盘（debounce 生效）',
    coreCalls.length === 0,
    `立即落盘 ${coreCalls.length} 次`,
  );
  rec('待落盘快照只有 1 个（后写覆盖先写，不是排队）', s.pendingAutosaves.size === 1,
    `${s.pendingAutosaves.size} 个`);

  fireTimers();
  await new Promise((r) => setImmediate(r));

  rec('⚠ 定时器到点后只落盘 1 次（三次输入被合并）', coreCalls.length === 1,
    `落盘 ${coreCalls.length} 次`);
  rec('落盘的是**最后一次**内容', coreCalls[0]?.params.text === '第三次',
    coreCalls[0]?.params.text);
  rec('落盘走的是 manuscript.autosave', coreCalls[0]?.method === 'manuscript.autosave',
    coreCalls[0]?.method);
  rec('落盘后待落盘表清空', s.pendingAutosaves.size === 0, `${s.pendingAutosaves.size} 个`);
}

// ═══════════════════════════════════════════════════════════
console.log('\n──── 2. ⚠ 多章节互不干扰 ────\n');
// ═══════════════════════════════════════════════════════════
{
  const s = makeScheduler();

  s.scheduleAutosave(payload(1, '第一章的内容'));
  s.scheduleAutosave(payload(2, '第二章的内容'));

  rec('两个章节各有独立快照', s.pendingAutosaves.size === 2, `${s.pendingAutosaves.size} 个`);

  fireTimers();
  await new Promise((r) => setImmediate(r));

  const ids = coreCalls.map((c) => c.params.chapterId).sort();
  rec('⚠ 两章各自落盘，不互相覆盖', ids.length === 2 && ids[0] === 'ch-1' && ids[1] === 'ch-2',
    ids.join(','));
  rec('内容未串章', coreCalls.find((c) => c.params.chapterId === 'ch-1')?.params.text === '第一章的内容');
}

// ═══════════════════════════════════════════════════════════
console.log('\n──── 3. ⚠ flush：立即落盘（切章 / 崩溃 / 退出路径）────\n');
// ═══════════════════════════════════════════════════════════
{
  const s = makeScheduler();

  s.scheduleAutosave(payload(1, '还没到点就切章'));
  rec('flush 前未落盘', coreCalls.length === 0);

  await s.flushAutosave();

  rec('⚠ flush 立即落盘（不等定时器）', coreCalls.length === 1, `落盘 ${coreCalls.length} 次`);
  rec('flush 落盘的是待写内容', coreCalls[0]?.params.text === '还没到点就切章',
    coreCalls[0]?.params.text);
  rec('flush 后待落盘表清空', s.pendingAutosaves.size === 0, `${s.pendingAutosaves.size} 个`);

  // ⚠ flush 后定时器不该再触发第二次落盘（否则同一内容写两遍）
  fireTimers();
  await new Promise((r) => setImmediate(r));
  rec('⚠ flush 后原定时器不再重复落盘', coreCalls.length === 1, `落盘 ${coreCalls.length} 次`);
}

// ═══════════════════════════════════════════════════════════
console.log('\n──── 4. flush 指定章节时不误伤其他章节 ────\n');
// ═══════════════════════════════════════════════════════════
{
  const s = makeScheduler();

  s.scheduleAutosave(payload(1, '第一章'));
  s.scheduleAutosave(payload(2, '第二章'));

  await s.flushAutosave('ch-1');

  rec('只落盘指定章节', coreCalls.length === 1 && coreCalls[0].params.chapterId === 'ch-1',
    coreCalls.map((c) => c.params.chapterId).join(','));
  rec('⚠ 其他章节仍留在待落盘表（不被误清）', s.pendingAutosaves.size === 1 &&
    s.pendingAutosaves.has('ch-2'), `${s.pendingAutosaves.size} 个`);

  await s.flushAutosave();
  rec('无参 flush 落盘全部剩余章节', coreCalls.length === 2, `落盘 ${coreCalls.length} 次`);
}

// ═══════════════════════════════════════════════════════════
console.log('\n──── 5. 无待落盘内容时 flush 是空操作 ────\n');
// ═══════════════════════════════════════════════════════════
{
  const s = makeScheduler();
  await s.flushAutosave();
  rec('无内容时 flush 不发请求（避免无谓 IPC）', coreCalls.length === 0, `落盘 ${coreCalls.length} 次`);
}

// ═══════════════════════════════════════════════════════════
console.log('\n──── 6. 编辑器状态随快照一起落盘（§十一）────\n');
// ═══════════════════════════════════════════════════════════
{
  const s = makeScheduler();
  s.scheduleAutosave({
    chapterId: 'ch-1',
    text: '正文',
    cursor: 42,
    selectionStart: 10,
    selectionEnd: 20,
    scrollTop: 300,
  });
  fireTimers();
  await new Promise((r) => setImmediate(r));

  const p = coreCalls[0]?.params ?? {};
  rec('光标位置随快照落盘', p.cursor === 42, String(p.cursor));
  rec('选区随快照落盘', p.selectionStart === 10 && p.selectionEnd === 20,
    `${p.selectionStart}-${p.selectionEnd}`);
  rec('滚动位置随快照落盘', p.scrollTop === 300, String(p.scrollTop));
}

// ═══════════════════════════════════════════════════════════
console.log('\n──── 7. ⚠ 主进程与 core 共用同一通道（不是另起一条）────\n');
// ═══════════════════════════════════════════════════════════
{
  const s = makeScheduler();
  s.scheduleAutosave(payload(1, 'x'));
  fireTimers();
  await new Promise((r) => setImmediate(r));
  rec(
    '⚠ autosave 经 callCore 发出（与 IPC 路由同一通道）',
    coreCalls.length === 1 && coreCalls[0].method === 'manuscript.autosave',
    coreCalls[0]?.method ?? '(无)',
  );
}

// ═══════════════════════════════════════════════════════════
console.log('\n──── 8. ⚠ debounce 间隔在 §八 建议区间（500–2000ms）────\n');
// ═══════════════════════════════════════════════════════════
{
  const s = makeScheduler();
  rec(
    'debounce 间隔在 §八 建议区间内',
    s.AUTOSAVE_DEBOUNCE_MS >= 500 && s.AUTOSAVE_DEBOUNCE_MS <= 2000,
    `${s.AUTOSAVE_DEBOUNCE_MS}ms`,
  );
}

// ═══════════════════════════════════════════════════════════
const failed = steps.filter((x) => !x.ok);
console.log(`\n${'─'.repeat(56)}`);
console.log(`结果：${steps.length - failed.length}/${steps.length} 通过`);
if (failed.length > 0) {
  console.log('\n失败项：');
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  process.exit(1);
}
console.log('判定：通过');
