/**
 * Manuscript 编辑器验证（M4）
 *
 *   node apps/desktop/scripts/verify-manuscript-editor.mjs
 *
 * ## 要证明什么
 *
 * 编辑器是**渲染进程代码**，vitest 的 environment 是 node 跑不了它。
 * 但它承载的是本阶段最容易出错的一批规则，不能只靠"看一眼界面"验收：
 *
 *   1. §二  SAVE != COMMIT —— 保存**绝不**触发提交
 *   2. §三十 提交按钮**绝不**绕过检查（M4 阶段它必须什么都不提交）
 *   3. §十一 打开时**只检测不恢复**，绝不静默覆盖
 *   4. §十一 恢复后状态是 DIRTY（内容只在编辑器里，还没落盘）
 *   5. §九  五态可区分 —— 特别是 DIRTY 与 RECOVERABLE 不能同形
 *   6. §八  autosave 是 debounce（延迟落盘），且内容未变时不写
 *
 * ## ⚠ 为什么用最小 DOM 替身而不是 jsdom
 *
 * 沿用 `verify-workflow-panel.mjs` 的既有做法：只实现面板真正用到的 API。
 * 这样测的是**编辑器自己的逻辑**，而不是某个 DOM 库的行为 ——
 * 后者会在换库时给出与真实运行环境无关的结论。
 *
 * ## ⚠ 这里最要紧的一条纪律：断言必须查**数据流的下游终点**
 *
 * P2-4c 的假绿教训：断言查了 `textContent`（它包含由输入值拼出的提示），
 * 于是"改名从未提交"照样通过。所以本脚本的断言一律查
 * **IPC 调用序列**（编辑器对外唯一的副作用通道），
 * 而不是查界面上的文字。
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const editorPath = join(here, '..', 'src', 'renderer', 'manuscript-editor.js');

const steps = [];
const rec = (name, ok, detail) => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ─────────────────────────────────────────────────────────
// 最小 DOM 替身
// ─────────────────────────────────────────────────────────

/** 被捕获的定时器：手动触发，用来验证 debounce 真的是延迟的 */
const timers = new Map();
let timerSeq = 0;

globalThis.setTimeout = (fn, ms) => {
  const id = ++timerSeq;
  timers.set(id, { fn, ms });
  return id;
};
globalThis.clearTimeout = (id) => {
  timers.delete(id);
};

/** 手动跑掉所有待触发的定时器（模拟"时间到了"） */
function fireTimers() {
  const pending = [...timers.entries()];
  timers.clear();
  for (const [, t] of pending) t.fn();
  return pending.length;
}

const windowListeners = {};
globalThis.window = {
  addEventListener: (ev, fn) => {
    (windowListeners[ev] ??= []).push(fn);
  },
  removeEventListener: () => {},
};

function makeEl(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    children: [],
    dataset: {},
    disabled: false,
    hidden: false,
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    scrollTop: 0,
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
    focus() {},
    addEventListener(ev, fn) {
      (this._listeners[ev] ??= []).push(fn);
    },
    /** 触发事件（测试用） */
    fire(ev, arg) {
      for (const fn of this._listeners[ev] ?? []) fn(arg ?? {});
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

// ─────────────────────────────────────────────────────────
// 载入编辑器模块（真实源码，不是替身）
// ─────────────────────────────────────────────────────────
const src = readFileSync(editorPath, 'utf8');
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(src, 'utf8').toString('base64')}`
);
const { renderManuscriptEditor } = mod;

const el = (tag, cls, text) => {
  const n = makeEl(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ─────────────────────────────────────────────────────────
// 假 IPC：记录**完整调用序列**（这是唯一的副作用通道）
// ─────────────────────────────────────────────────────────
function makeEnv(opts = {}) {
  const calls = [];
  const disk = { text: opts.diskText ?? '第一段正文。\n\n第二段正文。' };
  const recovery = {
    hasNewerAutosave: opts.hasRecovery ?? false,
    autosaveText: opts.autosaveText ?? '自动保存里的内容。',
    autosaveChars: (opts.autosaveText ?? '自动保存里的内容。').length,
    autosaveAt: '2026-09-25 12:00:00',
  };
  let recoveryLive = recovery.hasNewerAutosave;

  const invoke = async (method, params) => {
    calls.push({ method, params });

    // ⚠ 提交类调用**必须**被记录并显式失败：M4 阶段编辑器不该碰它。
    //   若编辑器真的调了 workspace.commit，下面的断言会立刻抓到。
    if (method === 'workspace.commit' || method === 'commit.run') {
      return { ok: true, data: { committed: true, __UNEXPECTED__: true } };
    }

    switch (method) {
      case 'manuscript.open':
        return {
          ok: true,
          data: {
            chapterId: 'ch-1',
            chapterNumber: 1,
            title: '雨夜来客',
            text: disk.text,
            sourceHash: 'h',
            committed: false,
            recovery: { ...recovery, hasNewerAutosave: recoveryLive },
          },
        };
      case 'manuscript.metrics': {
        const t = params.text ?? '';
        const paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
        return { ok: true, data: { chars: t.length, paragraphs: paras.length } };
      }
      case 'manuscript.save':
        disk.text = params.text;
        // ⚠ 返回值必须照**真实仓储**的契约写：`ManuscriptRepository.save()`
        //   返回的是 `bytes`（写了多少字节，排错用），**没有** `chars`。
        //   第一版 mock 里自作主张返回了 `chars`，于是编辑器读 `r.data.chars`
        //   这个真实缺陷在验证器里"通过"了 —— mock 与真实契约不一致时，
        //   验证器测的是一个不存在的世界。反向验证（F 组）当场抓到了它。
        return {
          ok: true,
          data: {
            changed: true,
            bytes: Buffer.byteLength(params.text, 'utf8'),
            savedAt: 'now',
            sourceHash: 'h2',
            path: '/tmp/manuscript.md',
          },
        };
      case 'manuscript.autosave':
        return { ok: true, data: { written: true, chars: params.text.length } };
      case 'manuscript.recoverAutosave':
        if (!recoveryLive) return { ok: true, data: { recovered: false, reason: '无' } };
        recoveryLive = false;
        return {
          ok: true,
          data: { recovered: true, text: recovery.autosaveText, savedAt: 't', sourceHash: 'h3' },
        };
      case 'manuscript.discardAutosave':
        recoveryLive = false;
        return { ok: true, data: { discarded: true } };
      default:
        return { ok: false, error: { code: 'NO', message: `未处理的 IPC：${method}` } };
    }
  };

  return { calls, invoke, disk, recovery, callsTo: (m) => calls.filter((c) => c.method === m) };
}

/** 从面板里捞出关键节点（按类名找，因为替身没有 querySelector） */
function find(root, pred) {
  if (pred(root)) return root;
  for (const k of root.children ?? []) {
    const hit = find(k, pred);
    if (hit) return hit;
  }
  return null;
}
const byClass = (root, cls) => find(root, (n) => String(n.className).split(/\s+/).includes(cls));
const byText = (root, t) => find(root, (n) => n.textContent === t);

const chapter = { id: 'ch-1', chapterNumber: 1, title: '雨夜来客', status: 'DRAFT' };

// ═══════════════════════════════════════════════════════════
console.log('\n──── 1. 打开：只检测不恢复（§十一）────\n');
// ═══════════════════════════════════════════════════════════
{
  const env = makeEnv({ hasRecovery: true, diskText: '磁盘上的正文。' });
  const box = renderManuscriptEditor({
    el,
    invoke: env.invoke,
    msg: () => el('div', 'form-msg'),
    chapter,
  });
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  const area = byClass(box, 'editor__area');
  rec(
    '⚠ 打开时编辑器内容 = 磁盘正文（不是 autosave）',
    area.value === '磁盘上的正文。',
    `编辑器="${area.value}"`,
  );
  rec(
    '⚠ 打开时**没有**调用 recoverAutosave（未静默覆盖）',
    env.callsTo('manuscript.recoverAutosave').length === 0,
    `调用 ${env.callsTo('manuscript.recoverAutosave').length} 次`,
  );
  const restoreBtn = byText(box, '恢复自动保存');
  const discardBtn = byText(box, '放弃自动保存');
  rec('有待恢复内容时，「恢复」「放弃」按钮可用', !restoreBtn.disabled && !discardBtn.disabled);

  const status = byClass(box, 'save-status');
  rec(
    '⚠ 状态显示 RECOVERABLE（与 DIRTY 不同形）',
    String(status.className).includes('save-status--recoverable'),
    `className="${status.className}"`,
  );
  rec('状态文案含「未恢复」', String(status.textContent).includes('未恢复'), status.textContent);
}

// ═══════════════════════════════════════════════════════════
console.log('\n──── 2. ⚠ SAVE != COMMIT（§二）────\n');
// ═══════════════════════════════════════════════════════════
{
  const env = makeEnv({ hasRecovery: false });
  const box = renderManuscriptEditor({
    el,
    invoke: env.invoke,
    msg: () => el('div', 'form-msg'),
    chapter,
  });
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  const area = byClass(box, 'editor__area');
  area.value = '我改过的正文。';
  area.fire('input');

  const saveBtn = byText(box, '保存');
  saveBtn.fire('click');
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  rec('保存调用了 manuscript.save', env.callsTo('manuscript.save').length === 1);
  rec(
    '⚠ 保存**没有**调用任何提交类 IPC（§二 SAVE != COMMIT）',
    env.callsTo('workspace.commit').length === 0 && env.callsTo('commit.run').length === 0,
    `commit 调用 ${env.callsTo('workspace.commit').length + env.callsTo('commit.run').length} 次`,
  );
  rec('保存写入了编辑器当前内容', env.disk.text === '我改过的正文。', `磁盘="${env.disk.text}"`);

  // ⚠ 保存提示里的字数必须来自 measureText（metrics），不是仓储返回的 bytes。
  //   曾经这里读 r.data.chars，界面显示"已保存 undefined 字"。
  const saveMsg = find(box, (n) => String(n.className).includes('form-msg'));
  rec(
    '⚠ 保存提示不出现 undefined（字数取自 metrics 口径）',
    !String(saveMsg?.textContent ?? '').includes('undefined'),
    saveMsg?.textContent ?? '',
  );
  rec(
    '保存提示含真实字数（与 metrics 一致）',
    String(saveMsg?.textContent ?? '').includes(String(env.callsTo('manuscript.metrics').at(-1)?.params.text?.length ?? -1)),
    saveMsg?.textContent ?? '',
  );

  const status = byClass(box, 'save-status');
  rec(
    '保存后状态回到 CLEAN',
    String(status.className).includes('save-status--clean'),
    `className="${status.className}"`,
  );
}

// ═══════════════════════════════════════════════════════════
console.log('\n──── 3. ⚠ 提交按钮不得绕过检查（§三十 §三十一）────\n');
// ═══════════════════════════════════════════════════════════
{
  const env = makeEnv({ hasRecovery: false });
  const box = renderManuscriptEditor({
    el,
    invoke: env.invoke,
    msg: () => el('div', 'form-msg'),
    chapter,
  });
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  const commitBtn = byText(box, '提交到正史（走检查）');
  rec('存在「提交到正史」按钮，且文案写明走检查', commitBtn !== null);

  commitBtn.fire('click');
  await new Promise((r) => process.nextTick(r));

  rec(
    '⚠ M4 阶段点提交**不触发任何提交 IPC**（检查面板在 M9）',
    env.callsTo('workspace.commit').length === 0 && env.callsTo('commit.run').length === 0,
    `commit 调用 ${env.callsTo('workspace.commit').length + env.callsTo('commit.run').length} 次`,
  );

  // ⚠ §三十：两个按钮的外观必须可区分。这里查**类名**而非颜色值 ——
  //   类名不同才是"样式系统里确实分了两种"，颜色值相同只是当前配色巧合。
  const saveCls = String(byText(box, '保存').className);
  const commitCls = String(commitBtn.className);
  rec(
    '⚠ 保存与提交的样式类不同（§三十 必须明显区分）',
    saveCls !== commitCls && commitCls.includes('btn--commit'),
    `保存="${saveCls}" 提交="${commitCls}"`,
  );
}

// ═══════════════════════════════════════════════════════════
console.log('\n──── 4. autosave：debounce + 内容未变不写（§八）────\n');
// ═══════════════════════════════════════════════════════════
{
  const env = makeEnv({ hasRecovery: false, diskText: '原始正文。' });
  const box = renderManuscriptEditor({
    el,
    invoke: env.invoke,
    msg: () => el('div', 'form-msg'),
    chapter,
  });
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  const area = byClass(box, 'editor__area');

  // 连续三次输入 —— 只应产生**一次** autosave（debounce 的语义）
  area.value = '第一次改动';
  area.fire('input');
  area.value = '第二次改动';
  area.fire('input');
  area.value = '第三次改动';
  area.fire('input');

  rec(
    '⚠ 输入后**立即**没有 autosave（确实是延迟，不是每次都写）',
    env.callsTo('manuscript.autosave').length === 0,
    `立即写了 ${env.callsTo('manuscript.autosave').length} 次`,
  );
  rec('定时器已排入队列（debounce 生效）', timers.size >= 1, `待触发 ${timers.size} 个`);

  fireTimers();
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  rec(
    '⚠ 三次连续输入只产生 1 次 autosave（debounce 合并）',
    env.callsTo('manuscript.autosave').length === 1,
    `写了 ${env.callsTo('manuscript.autosave').length} 次`,
  );
  rec(
    'autosave 写的是最新内容',
    env.callsTo('manuscript.autosave')[0]?.params.text === '第三次改动',
  );

  // 内容未变时再触发一次 → 不该写（无意义写入会刷新 mtime）
  const before = env.callsTo('manuscript.autosave').length;
  area.fire('input'); // value 未变
  fireTimers();
  await new Promise((r) => process.nextTick(r));
  rec(
    '⚠ 内容未变时不重复 autosave（避免刷新 mtime 制造假恢复提示）',
    env.callsTo('manuscript.autosave').length === before,
    `${before} → ${env.callsTo('manuscript.autosave').length}`,
  );
}

// ═══════════════════════════════════════════════════════════
console.log('\n──── 5. ⚠ 恢复后是 DIRTY，不是 CLEAN（§十一）────\n');
// ═══════════════════════════════════════════════════════════
{
  const env = makeEnv({
    hasRecovery: true,
    diskText: '磁盘正文。',
    autosaveText: '自动保存的正文。',
  });
  const box = renderManuscriptEditor({
    el,
    invoke: env.invoke,
    msg: () => el('div', 'form-msg'),
    chapter,
  });
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  const area = byClass(box, 'editor__area');
  const restoreBtn = byText(box, '恢复自动保存');
  restoreBtn.fire('click');
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  rec('恢复后编辑器内容是 autosave 内容', area.value === '自动保存的正文。', area.value);
  rec(
    '⚠ 恢复**没有**写磁盘（正文仍未变）',
    env.disk.text === '磁盘正文。',
    `磁盘="${env.disk.text}"`,
  );

  const status = byClass(box, 'save-status');
  rec(
    '⚠ 恢复后状态是 DIRTY 而非 CLEAN（内容只在编辑器里）',
    String(status.className).includes('save-status--dirty'),
    `className="${status.className}" text="${status.textContent}"`,
  );

  // 恢复后按钮应禁用（没有待恢复内容了）
  rec('恢复后「恢复」「放弃」按钮禁用', restoreBtn.disabled);

  // 再点保存 → 才落盘，且仍不提交
  byText(box, '保存').fire('click');
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));
  rec('恢复后点保存才写入磁盘', env.disk.text === '自动保存的正文。', `磁盘="${env.disk.text}"`);
  rec(
    '⚠ 整个恢复+保存流程仍未触发任何提交',
    env.callsTo('workspace.commit').length === 0 && env.callsTo('commit.run').length === 0,
  );
}

// ═══════════════════════════════════════════════════════════
console.log('\n──── 5b. ⚠ 恢复后**不改动**直接切章，副本仍须写出 ────\n');
// ═══════════════════════════════════════════════════════════
{
  // 这条是针对一个真实的错误实现：把"恢复进来的内容"也当成
  // "已自动保存的内容"，于是作者恢复后不动一字就切章，
  // flush 会跳过写入 —— 而磁盘上并没有这份内容，恢复等于白做。
  const env = makeEnv({
    hasRecovery: true,
    diskText: '磁盘正文。',
    autosaveText: '自动保存的正文。',
  });
  const box = renderManuscriptEditor({
    el,
    invoke: env.invoke,
    msg: () => el('div', 'form-msg'),
    chapter,
  });
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  byText(box, '恢复自动保存').fire('click');
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  const before = env.callsTo('manuscript.autosave').length;
  box.__cleanup(); // 模拟切章
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  rec(
    '⚠ 恢复后未改动就切章，副本仍被写出（否则恢复白做）',
    env.callsTo('manuscript.autosave').length === before + 1,
    `${before} → ${env.callsTo('manuscript.autosave').length}`,
  );
}

// ═══════════════════════════════════════════════════════════
console.log('\n──── 6. 放弃自动保存（§十一）────\n');
// ═══════════════════════════════════════════════════════════
{
  const env = makeEnv({ hasRecovery: true, diskText: '磁盘正文。' });
  const box = renderManuscriptEditor({
    el,
    invoke: env.invoke,
    msg: () => el('div', 'form-msg'),
    chapter,
  });
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  const discardBtn = byText(box, '放弃自动保存');
  discardBtn.fire('click');
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  rec('放弃调用了 discardAutosave', env.callsTo('manuscript.discardAutosave').length === 1);
  rec('放弃后状态回到 CLEAN（正文未变）', String(byClass(box, 'save-status').className).includes('save-status--clean'));
  rec('放弃后按钮禁用', discardBtn.disabled);
}

// ═══════════════════════════════════════════════════════════
console.log('\n──── 7. 视图切换：单一文本源（§六）────\n');
// ═══════════════════════════════════════════════════════════
{
  const env = makeEnv({ hasRecovery: false, diskText: '一段。\n\n二段。\n\n三段。' });
  const box = renderManuscriptEditor({
    el,
    invoke: env.invoke,
    msg: () => el('div', 'form-msg'),
    chapter,
  });
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  const area = byClass(box, 'editor__area');
  const preview = byClass(box, 'editor__preview');
  const viewBtn = byText(box, '预览');

  rec('初始为编辑态（预览隐藏）', preview.hidden === true && area.hidden === false);

  viewBtn.fire('click');
  rec('切换后预览显示、编辑区隐藏', preview.hidden === false && area.hidden === true);
  rec(
    '⚠ 预览由**当前文本**重新渲染（3 段 → 3 个段落节点）',
    preview.children.length === 3,
    `${preview.children.length} 个段落`,
  );

  // 改文本后再切回预览 —— 预览必须反映最新文本（这就是"单一文本源"）
  viewBtn.fire('click'); // 回编辑态
  area.value = '改后一段。\n\n改后二段。';
  area.fire('input');
  viewBtn.fire('click'); // 再进预览
  rec(
    '⚠ 改动后再看预览，段落数随文本变化（无缓存、无需同步）',
    preview.children.length === 2,
    `${preview.children.length} 个段落`,
  );
}

// ═══════════════════════════════════════════════════════════
console.log('\n──── 8. Ctrl+S 只在编辑器聚焦时拦截 ────\n');
// ═══════════════════════════════════════════════════════════
{
  const env = makeEnv({ hasRecovery: false });
  const box = renderManuscriptEditor({
    el,
    invoke: env.invoke,
    msg: () => el('div', 'form-msg'),
    chapter,
  });
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  const area = byClass(box, 'editor__area');
  area.value = 'Ctrl+S 的内容。';
  area.fire('input');

  let prevented = false;
  area.fire('keydown', {
    ctrlKey: true,
    metaKey: false,
    key: 's',
    preventDefault: () => {
      prevented = true;
    },
  });
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  rec('编辑器内 Ctrl+S 被拦截并 preventDefault', prevented);
  rec('Ctrl+S 触发了保存', env.callsTo('manuscript.save').length === 1);
  rec(
    '⚠ Ctrl+S 仍未触发提交',
    env.callsTo('workspace.commit').length === 0 && env.callsTo('commit.run').length === 0,
  );

  // 非 Ctrl+S 不应被拦截
  let prevented2 = false;
  area.fire('keydown', {
    ctrlKey: false,
    metaKey: false,
    key: 'a',
    preventDefault: () => {
      prevented2 = true;
    },
  });
  rec('普通按键不被拦截（不吞键盘输入）', !prevented2);

  // ⚠ 拦截只挂在编辑器元素上，不是 window —— 别处按 Ctrl+S 不受影响
  rec(
    '⚠ Ctrl+S 监听器挂在编辑器元素上（不是全局 window）',
    (windowListeners.keydown ?? []).length === 0,
    `window keydown 监听器 ${(windowListeners.keydown ?? []).length} 个`,
  );
}

// ═══════════════════════════════════════════════════════════
console.log('\n──── 9. 离开前 flush 未触发的 autosave ────\n');
// ═══════════════════════════════════════════════════════════
{
  const env = makeEnv({ hasRecovery: false, diskText: '原正文。' });
  const box = renderManuscriptEditor({
    el,
    invoke: env.invoke,
    msg: () => el('div', 'form-msg'),
    chapter,
  });
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  const area = byClass(box, 'editor__area');
  area.value = '刚写完的最后一句。';
  area.fire('input');
  // 定时器还没触发就切章
  const before = env.callsTo('manuscript.autosave').length;

  box.__cleanup();
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));

  rec(
    '⚠ 切章前 flush：未到点的 autosave 被立即写掉（否则最后几句只在内存里）',
    env.callsTo('manuscript.autosave').length === before + 1,
    `${before} → ${env.callsTo('manuscript.autosave').length}`,
  );
  rec(
    'flush 写入的是最后的内容',
    env.callsTo('manuscript.autosave').at(-1)?.params.text === '刚写完的最后一句。',
  );
}

// ═══════════════════════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════════════════════
const failed = steps.filter((s) => !s.ok);
console.log(`\n${'─'.repeat(56)}`);
console.log(`结果：${steps.length - failed.length}/${steps.length} 通过`);
if (failed.length > 0) {
  console.log('\n失败项：');
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  process.exit(1);
}
console.log('判定：通过');
