/**
 * M6 补漏 —— 版本面板（读某个版本的内容 / 恢复到某个版本）。
 *
 * ## 为什么需要这个文件
 *
 * M6（`e77da16`）建好了 `manuscript.listVersions` / `readVersion` /
 * `restoreVersion` 三个 IPC 与全部仓储逻辑，但**渲染层零调用** ——
 * 三个能力只被验证脚本直接调过，界面上够不到（W7 那条「定义存在 ≠
 * 被调用」的教训在渲染层重现了一次）。
 *
 * M7 的 Diff 面板顺带把版本列表渲染出来了，但它只做「对比」，
 * 「读某一版的内容」与「恢复到某一版」仍然没有入口 ——
 * 而「恢复到历史版本」正是 §十三 建版本节点的**唯一目的**：
 * 只能对比不能回退，等于版本功能只做了一半。
 *
 * ## ⚠ 与「恢复自动保存」是两个不同的动作，文案必须区分
 *
 *   `恢复自动保存`（编辑器工具栏，M5）→ 把 autosave 副本**载入编辑器**，
 *      正文一个字节不动，**未落盘**，作者还要点「保存」。
 *   `恢复此版本`（本面板）→ 把历史版本**写回正文**，**立即落盘**，
 *      并新建一个 RESTORED_VERSION 节点记录这次回退。
 *
 * 两者后果完全不同（一个可反悔、一个已改写磁盘）。此前后端把历史回退
 * 也标成 `RESTORED_AUTOSAVE`，会让版本列表显示成"恢复了自动保存" ——
 * 已一并修正为 `RESTORED_VERSION`。文案上也不许混用「恢复」二字了事。
 */
import { fmtTime } from './diff-view.js';

/** 版本来源 → 作者看得懂的说法（后端枚举名不是给作者看的） */
const SOURCE_TEXT = {
  AI_DRAFT: 'AI 初稿',
  AI_REVISION: 'AI 修订',
  USER_EDIT: '手动保存',
  RESTORED_AUTOSAVE: '恢复自动保存',
  RESTORED_VERSION: '版本回退',
};

/**
 * 版本面板。
 *
 * @param {object} opts
 * @param {Function} opts.el     元素工厂
 * @param {Function} opts.invoke IPC
 * @param {object}   opts.msg    消息行工厂
 * @param {object}   opts.chapter 当前章节
 * @param {Function} opts.onTextReplaced 正文被替换后的回调（编辑器据此刷新）
 */
export function renderVersionPanel({ el, invoke, msg, chapter, onTextReplaced }) {
  const box = el('div', 'versions');

  const head = el('div', 'versions__head');
  head.append(el('h3', null, '版本历史'));
  // ⚠ 说清「保存」与「提交」的区别 —— 版本属于保存层，不涉及正史
  head.append(
    el(
      'div',
      'hint',
      '版本由保存与 AI 生成产生（自动保存不建版本）。恢复某个版本会把正文改回该版并立即写入磁盘，' +
        '但**不会**提交到正史。',
    ),
  );
  box.append(head);

  const statusLine = msg();
  box.append(statusLine);

  const list = el('div', 'versions__list');
  box.append(list);

  /** 当前展开查看内容的版本 id */
  let opened = null;
  let versions = [];

  function renderList() {
    list.replaceChildren();
    if (versions.length === 0) {
      list.append(el('div', 'empty', '还没有版本。保存一次正文即可产生第一个版本。'));
      return;
    }
    for (const v of versions) {
      list.append(renderRow(v));
    }
  }

  function renderRow(v) {
    const row = el('div', 'versions__row');

    const line = el('div', 'versions__line');
    line.append(
      el('span', 'versions__seq', `v${String(v.seq).padStart(3, '0')}`),
      // ⚠ 显示来源与时间：只显示 v001 作者不知道那是哪一次
      el('span', 'versions__src', SOURCE_TEXT[v.sourceType] ?? v.sourceType),
      el('span', 'versions__time', fmtTime(v.createdAt)),
      el('span', 'versions__chars', `${v.charCount} 字`),
    );
    if (v.note) line.append(el('span', 'versions__note', v.note));
    row.append(line);

    const btns = el('div', 'btn-row');

    const btnRead = el('button', 'btn btn--small', opened === v.id ? '收起' : '查看内容');
    btnRead.addEventListener('click', () => {
      opened = opened === v.id ? null : v.id;
      renderList();
      if (opened) void readContent(v.id);
    });
    btns.append(btnRead);

    const btnRestore = el('button', 'btn btn--small btn--danger', '恢复此版本');
    btnRestore.addEventListener('click', () => void doRestore(v));
    btns.append(btnRestore);

    row.append(btns);

    if (opened === v.id) {
      const content = el('div', 'versions__content');
      content.dataset.versionId = v.id;
      content.textContent = '正在读取…';
      row.append(content);
    }
    return row;
  }

  async function readContent(versionId) {
    const r = await invoke('manuscript.readVersion', { versionId });
    const holder = list.querySelector(`.versions__content[data-version-id="${versionId}"]`);
    if (!holder) return;
    if (!r.ok) {
      holder.className = 'versions__content versions__content--err';
      holder.textContent = `读取失败：${r.error.message}`;
      return;
    }
    // ⚠ 文件缺失必须明说。当成空文本显示会让作者以为"这一版是空的"，
    //   而实际是版本文件被人工清理了（§十四 允许清理）—— 两者含义完全不同。
    if (r.data.missing) {
      holder.className = 'versions__content versions__content--err';
      holder.textContent =
        '这一版的正文文件已不存在（可能被人工清理）。这不是"内容为空"，' +
        '而是文件不在了 —— 因此无法查看或恢复。';
      return;
    }
    holder.className = 'versions__content';
    holder.textContent = r.data.text ?? '';
  }

  async function doRestore(v) {
    // ⚠ 立即落盘 + 不改回退点，必须确认。
    //   文案要说清三件事：改什么、立刻生效、能不能反悔。
    const yes = window.confirm(
      `把正文恢复到 v${String(v.seq).padStart(3, '0')}（${SOURCE_TEXT[v.sourceType] ?? v.sourceType}，` +
        `${v.charCount} 字）？\n\n` +
        '· 会立即改写磁盘上的正文，未保存的编辑内容将丢失；\n' +
        '· 会新建一个版本节点记录这次回退；\n' +
        '· 中间版本不会被删除，需要时可以再恢复回来。',
    );
    if (!yes) return;

    const r = await invoke('manuscript.restoreVersion', { versionId: v.id });
    if (!r.ok) {
      statusLine.className = 'form-msg form-msg--err';
      statusLine.textContent = `恢复失败：${r.error.message}`;
      return;
    }

    statusLine.className = 'form-msg form-msg--ok';
    statusLine.textContent =
      `已恢复到 v${String(v.seq).padStart(3, '0')}，正文已写入磁盘（${r.data.text?.length ?? 0} 字）。` +
      '⚠ 这只是保存层，尚未提交到正史。';

    // ⚠ 通知编辑器：正文已被**后端**改写，编辑器里的文本源必须同步，
    //   否则作者看到的还是旧内容，接着一按保存就把刚恢复的版本又覆盖掉。
    if (typeof onTextReplaced === 'function') {
      onTextReplaced(r.data.text ?? '');
    }
    opened = null;
    await load();
  }

  async function load() {
    const r = await invoke('manuscript.listVersions', { chapterId: chapter.id });
    if (!r.ok) {
      statusLine.className = 'form-msg form-msg--err';
      statusLine.textContent = `版本列表读取失败：${r.error.message}`;
      return;
    }
    versions = r.data.versions ?? [];
    renderList();
  }

  void load();

  /** 供编辑器在保存后刷新（保存会产生新版本） */
  box.refreshVersions = load;

  return box;
}
