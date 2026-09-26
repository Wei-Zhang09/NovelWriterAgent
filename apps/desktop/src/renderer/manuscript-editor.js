/**
 * Manuscript 编辑器（M4 — 第二阶段施工单 §六 §七 §二十六 §二十七 §二十八 §二十九 §三十）
 *
 * ## ⚠ 这个文件存在的理由：一个已经被记录在案的缺陷类别
 *
 * 施工单 §六 的标题就是「编辑与预览的**关系**」。最容易做错的版本是
 * 「编辑区 + 预览区并排」，看起来体贴，实际上制造了一个必须靠人维护的
 * 同步关系：
 *
 *     作者在左边改了字 → 右边还是旧的 → 作者以为右边是"最新渲染结果"
 *
 * 这个缺陷不会报错，只会让作者在某一刻发现"预览里没有我昨天改的那段"。
 * 所以这里采用**单一文本源 + 视图切换**（§六 的推荐做法）：
 * `textarea` 与预览读的是**同一个字符串**，预览每次都由当前文本重新渲染，
 * 不存在"两份内容需要保持同步"这个状态。
 *
 * ## ⚠ 第二类缺陷：保存与提交外观相同
 *
 * §三十 要求「保存」与「提交到正史」必须明显区分。这不只是配色问题 ——
 * 若两者视觉权重相同，作者会以为"保存了就是定稿了"，
 * 于是从未走过 Review/Continuity/Verification 的文本被当成正史。
 * 这里：保存是次要按钮（`.btn`），提交到正史是危险色按钮（`.btn--commit`），
 * 且提交按钮上直接写着"（走检查）"。
 *
 * ## ⚠ 第三类：状态显示说了谎
 *
 * 保存状态有五种，其中两种最容易被做成同一个样子：
 *   DIRTY       有未保存修改
 *   RECOVERABLE 磁盘上有比当前更新的自动保存副本（**内容不同**）
 * 若都显示"未保存"，作者就无法判断"我该点保存还是点恢复"。
 * 这里五态各有独立文案与颜色（§九）。
 *
 * ## 渲染层约束
 *
 * - 纯 ES module，**不引入打包器**（沿用 renderer 的既有形态）
 * - 所有正文读写走 IPC（§三十四：renderer 不直接读磁盘）
 * - ⚠ 本文件不得出现反引号模板字符串拼接 HTML 后经 executeJavaScript 执行 ——
 *   GUI 断言区（main.ts）才受那条约束；本文件用 DOM API 构造节点，天然安全。
 */

/** 保存状态 → 文案与样式（§九：五态必须可区分） */
const SAVE_STATUS = {
  CLEAN: { text: '✓ 已保存', cls: 'save-status--clean' },
  DIRTY: { text: '● 未保存', cls: 'save-status--dirty' },
  SAVING: { text: '… 保存中', cls: 'save-status--saving' },
  SAVE_FAILED: { text: '✗ 保存失败', cls: 'save-status--failed' },
  RECOVERABLE: { text: '⟲ 发现未恢复的编辑内容', cls: 'save-status--recoverable' },
};

/**
 * ⚠ M5 起 debounce **不在 renderer**（§八）。
 *
 *   autosave 存在的唯一理由是防丢失，而最常见的丢失场景正是
 *   renderer 自己崩掉（OOM / 页面异常）。定时器活在 renderer 里
 *   就会随页面一起死 —— 恰好在最需要它的时候不工作。
 *
 *   所以 renderer 只做一件事：**每次输入把快照推给主进程**
 *   （`window.nwa.autosave`），由主进程 debounce + 落盘。
 *   页面死了，主进程还在，快照照样写成文件。
 */

/**
 * 编辑器面板。
 *
 * @param {object} opts
 * @param {Function} opts.el      —— 节点工厂（与 renderer 一致）
 * @param {Function} opts.invoke  —— IPC 调用（call(method, params)）
 * @param {Function} opts.msg     —— 消息行工厂
 * @param {object}   opts.chapter —— 章节行（id / chapterNumber / title / status）
 */
import { renderDiffPanel } from './manuscript/diff-view.js';

export function renderManuscriptEditor({ el, invoke, msg, chapter }) {
  const box = el('div', 'editor');

  // ── 本地状态（每次打开章节重建，不跨章残留）──
  /** 编辑器里**当前**的文本 —— 唯一文本源 */
  let text = '';
  /** 最近一次与磁盘一致的内容（用于判 dirty 与"内容未变不重写"）*/
  let savedText = '';
  /** 磁盘上的正文（不含 autosave），用于区分 DIRTY 与 RECOVERABLE */
  let diskText = '';
  /**
   * 最近一次**自动保存**写下去的内容。
   *
   * ⚠ 与 `savedText` 是两个不同的东西，不能互相代替：
   *   `savedText`      = 与磁盘正文一致的那份（保存成功的同步点）
   *   `lastAutosavedText` = 上次 autosave 写进副本的内容
   * 用 `savedText` 做 autosave 的跳过判据，会让"作者改一个字后停手"
   * 每次 input 事件都重写同一份副本 —— 无意义写入刷新 mtime，
   * 而 mtime 正是恢复提示的展示依据。
   */
  let lastAutosavedText = null;
  let saving = false;
  /** 视图：'edit' | 'preview' */
  let view = 'edit';

  // ─────────────────────────────────────────────────────────
  // 头部：章节元信息（§二十九）
  // ─────────────────────────────────────────────────────────
  const head = el('div', 'editor__head');
  const title = el('h2', null, `第 ${chapter.chapterNumber} 章${chapter.title ? ` · ${chapter.title}` : ''}`);
  head.append(title);

  const meta = el('div', 'editor__meta');
  const metaChars = el('span', 'editor__stat', '');
  const metaParas = el('span', 'editor__stat', '');
  const metaSaved = el('span', 'save-status save-status--clean', SAVE_STATUS.CLEAN.text);
  const metaWorkflow = el('span', 'editor__stat', `Workflow: ${chapter.status ?? '—'}`);
  meta.append(metaChars, metaParas, metaSaved, metaWorkflow);
  head.append(meta);
  box.append(head);

  // ─────────────────────────────────────────────────────────
  // 工具栏（§二十七：第一版只放这些，不堆排版功能）
  // ─────────────────────────────────────────────────────────
  const bar = el('div', 'editor__bar');

  const btnSave = el('button', 'btn', '保存');
  const btnView = el('button', 'btn', '预览');
  const btnRestore = el('button', 'btn', '恢复自动保存');
  const btnDiscard = el('button', 'btn btn--danger', '放弃自动保存');
  // ⚠ §三十：提交到正史必须与保存明显区分。文案里直接写"走检查"，
  //   因为作者最容易误解的正是"提交会不会跳过检查"。
  const btnCommit = el('button', 'btn btn--commit', '提交到正史（走检查）');

  btnRestore.disabled = true;
  btnDiscard.disabled = true;

  bar.append(btnSave, btnView, btnRestore, btnDiscard, btnCommit);
  box.append(bar);

  const statusLine = msg();
  box.append(statusLine);

  // ─────────────────────────────────────────────────────────
  // 主体：单一文本源 + 视图切换（§六）
  // ─────────────────────────────────────────────────────────
  const body = el('div', 'editor__body');

  const area = document.createElement('textarea');
  area.className = 'editor__area';
  area.setAttribute('spellcheck', 'false');
  // ⚠ 不设 placeholder —— "还没有正文"这件事由头部状态说明，
  //   编辑器里出现提示文字会被误当成正文的一部分。
  body.append(area);

  const preview = el('div', 'editor__preview');
  preview.hidden = true;
  body.append(preview);
  box.append(body);

  // ─────────────────────────────────────────────────────────
  // 底部：选中信息（§二十八：当前选中文字数）
  // ─────────────────────────────────────────────────────────
  const foot = el('div', 'editor__foot');
  const selInfo = el('span', 'editor__stat', '');
  foot.append(selInfo);
  box.append(foot);

  // ─────────────────────────────────────────────────────────
  // M7：版本对比（Diff）
  //
  // ⚠ 放在编辑器内部而不是独立入口：Diff 的对象就是"这一章的正文"，
  //   作者要先打开章节才谈得上对比。做成全局入口的话，
  //   还得在入口里再选一次章节 —— 多一步且容易选错。
  // ─────────────────────────────────────────────────────────
  box.append(renderDiffPanel({ el, invoke, chapter, msg }));

  // ─────────────────────────────────────────────────────────
  // 度量：**必须**用 core 的 measureText 口径（否则与 Writer 数字对不上）
  //   这里通过 IPC 拿度量，而不是在 renderer 里再写一遍计数 ——
  //   在 renderer 里写就是第二套口径，正是 M4 要防的缺陷。
  // ─────────────────────────────────────────────────────────

  async function refreshMetrics() {
    const r = await invoke('manuscript.metrics', { chapterId: chapter.id, text });
    if (r.ok) {
      metaChars.textContent = `${r.data.chars} 字`;
      metaParas.textContent = `${r.data.paragraphs} 段`;
    } else {
      // ⚠ 拿不到度量时如实显示「—」，不本地估算：
      //   估算出来的数字与真实口径不一致时，作者会以为"软件算错了"。
      metaChars.textContent = '— 字';
      metaParas.textContent = '— 段';
    }
    updateSelection();
  }

  function updateSelection() {
    const s = area.selectionStart;
    const e = area.selectionEnd;
    if (view === 'edit' && e > s) {
      selInfo.textContent = `选中 ${e - s} 字`;
    } else {
      selInfo.textContent = '';
    }
  }

  function setStatus(next) {
    const s = SAVE_STATUS[next] ?? SAVE_STATUS.CLEAN;
    metaSaved.className = `save-status ${s.cls}`;
    metaSaved.textContent = s.text;
  }

  /**
   * 重算保存状态。
   *
   * ⚠ 判据顺序很重要：**先看磁盘是否有更新的 autosave**，再看内容是否变脏。
   *   反过来会让"有 autosave 待恢复 + 编辑器没改"显示成"已保存" ——
   *   作者就永远看不到那个待恢复提示。
   */
  function recomputeStatus() {
    if (saving) return setStatus('SAVING');
    if (hasRecovery) return setStatus('RECOVERABLE');
    setStatus(text === savedText ? 'CLEAN' : 'DIRTY');
  }

  let hasRecovery = false;

  function renderPreview() {
    preview.replaceChildren();
    // ⚠ 预览**每次都由当前 text 重新渲染**，不缓存。
    //   缓存就是"两份内容需要同步"这个状态的开端。
    const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
    if (paras.length === 0) {
      preview.append(el('p', 'empty', '（本章还没有正文）'));
      return;
    }
    for (const p of paras) {
      preview.append(el('p', 'editor__para', p));
    }
  }

  function toggleView() {
    view = view === 'edit' ? 'preview' : 'edit';
    const editing = view === 'edit';
    area.hidden = !editing;
    preview.hidden = editing;
    btnView.textContent = editing ? '预览' : '编辑';
    if (editing) {
      area.focus();
      updateSelection();
    } else {
      selInfo.textContent = '';
      renderPreview();
    }
  }

  // ─────────────────────────────────────────────────────────
  // 自动保存（§八 / §十二）
  //
  // ⚠ 写的是**旁路副本**，不碰正式正文 —— 由仓储层保证。
  //   若这里改成"自动保存即保存"，§十二 的切章保护就失去意义。
  // ─────────────────────────────────────────────────────────
  /**
   * 把当前快照推给主进程（§八）。
   *
   * ⚠ 判据是"与上次推过的内容不同"，**不是**"与磁盘正文不同"：
   *   后者会让作者改一个字后停手时，每次 input 都推一遍同样的内容 ——
   *   主进程的 debounce 虽然会合并，但这是在无谓地跨进程拷贝整章文本。
   *   内容与磁盘正文相同时也没必要推（没有"未保存的改动"可救）。
   */
  function pushSnapshot() {
    if (text === savedText || text === lastAutosavedText) return;
    lastAutosavedText = text;
    window.nwa.autosave({
      chapterId: chapter.id,
      text,
      cursor: area.selectionStart,
      selectionStart: area.selectionStart,
      selectionEnd: area.selectionEnd,
      scrollTop: area.scrollTop,
    });
  }

  /**
   * 切章/关窗前让主进程把未落盘的快照写掉（§十二）。
   *
   * ⚠ 必须 await：确认写完了才能切章。
   */
  async function flushAutosave() {
    pushSnapshot();
    try {
      await window.nwa.flushAutosave(chapter.id);
    } catch {
      // ⚠ 失败不阻断切章：flush 是尽力而为的保护，
      //   为它挡住用户的切章动作得不偿失（正文本身在编辑器里还在）。
    }
  }

  // ─────────────────────────────────────────────────────────
  // 保存（§十：Ctrl+S 与按钮同一条路径）
  // ─────────────────────────────────────────────────────────
  async function doSave() {
    if (saving) return;
    saving = true;
    setStatus('SAVING');
    const r = await invoke('manuscript.save', { chapterId: chapter.id, text });
    saving = false;
    if (!r.ok) {
      setStatus('SAVE_FAILED');
      statusLine.className = 'form-msg form-msg--err';
      statusLine.textContent = `保存失败：${r.error.message}`;
      return;
    }
    savedText = text;
    diskText = text;
    // 保存后副本已被仓储清掉 —— 下次 autosave 应从"当前内容"重新起算
    lastAutosavedText = text;
    // 保存成功后 autosave 已被仓储清掉（用户已显式保存）
    hasRecovery = false;
    btnRestore.disabled = true;
    btnDiscard.disabled = true;
    recomputeStatus();
    // ⚠ 字数取 `metaChars`（来自 `manuscript.metrics`，即 core 的 `measureText`），
    //   **不是** `r.data.chars` —— 仓储的 `save()` 返回的是 `bytes`（写了多少字节，
    //   排错用），不是字数。曾经这里读 `r.data.chars`，界面显示"已保存 undefined 字"。
    //   即使在 renderer 里写 `text.length` 也不该做：那是第二套口径的开端，
    //   而 M4 的全部意义就是让编辑器与 Writer 用同一个数字。
    await refreshMetrics();
    statusLine.className = 'form-msg form-msg--ok';
    statusLine.textContent = r.data.changed
      ? '已保存 ' + metaChars.textContent + '（未提交，不影响正史）'
      : '内容未变，未重复写入';
  }

  // ─────────────────────────────────────────────────────────
  // 打开：**只检测不恢复**（§十一）
  // ─────────────────────────────────────────────────────────
  async function load() {
    const r = await invoke('manuscript.open', { chapterId: chapter.id });
    if (!r.ok) {
      statusLine.className = 'form-msg form-msg--err';
      statusLine.textContent = `打开失败：${r.error.message}`;
      return;
    }
    diskText = r.data.text ?? '';
    text = diskText;
    savedText = diskText;
    area.value = text;

    const rec = r.data.recovery ?? {};
    hasRecovery = Boolean(rec.hasNewerAutosave);
    btnRestore.disabled = !hasRecovery;
    btnDiscard.disabled = !hasRecovery;

    // ⚠ 只提示，不覆盖。§十一 明令「不要直接静默覆盖」。
    if (hasRecovery) {
      statusLine.className = 'form-msg form-msg--warn';
      statusLine.textContent =
        `发现未恢复的编辑内容（${rec.autosaveChars ?? '?'} 字，${rec.autosaveAt ?? '时间未知'}）。` +
        '点「恢复自动保存」载入，或点「放弃自动保存」丢弃。当前显示的是磁盘正文。';
    } else {
      statusLine.className = 'form-msg';
      statusLine.textContent = r.data.committed
        ? '本章已提交到正史。此处的修改不会自动同步到正史。'
        : '编辑中。保存不会进入正史，需点「提交到正史」并走检查。';
    }

    recomputeStatus();
    await refreshMetrics();
  }

  async function doRestore() {
    const r = await invoke('manuscript.recoverAutosave', { chapterId: chapter.id });
    if (!r.ok) {
      statusLine.className = 'form-msg form-msg--err';
      statusLine.textContent = `恢复失败：${r.error.message}`;
      return;
    }
    if (!r.data.recovered) {
      statusLine.className = 'form-msg form-msg--warn';
      statusLine.textContent = `没有可恢复的内容：${r.data.reason ?? '未知原因'}`;
      return;
    }
    text = r.data.text ?? '';
    area.value = text;
    // ⚠ 恢复进来的内容**尚未落盘**，也不是"已自动保存的内容"：
    //   若把它当成 lastAutosavedText，作者接着不改动切章时
    //   flush 会跳过写入 —— 而磁盘上并没有这份内容。
    lastAutosavedText = null;
    hasRecovery = false;
    btnRestore.disabled = true;
    btnDiscard.disabled = true;
    // ⚠ 恢复后状态是 DIRTY（编辑器内容 ≠ 磁盘正文），不是 CLEAN：
    //   恢复只是把 autosave 载入编辑器，还没有写进正文。
    recomputeStatus();
    await refreshMetrics();
    statusLine.className = 'form-msg form-msg--ok';
    statusLine.textContent = '已载入自动保存内容。⚠ 还需点「保存」才会写入正文。';
  }

  async function doDiscard() {
    const r = await invoke('manuscript.discardAutosave', { chapterId: chapter.id });
    if (!r.ok) {
      statusLine.className = 'form-msg form-msg--err';
      statusLine.textContent = `放弃失败：${r.error.message}`;
      return;
    }
    hasRecovery = false;
    btnRestore.disabled = true;
    btnDiscard.disabled = true;
    recomputeStatus();
    statusLine.className = 'form-msg';
    statusLine.textContent = '已放弃自动保存内容（正文未变）。';
  }

  // ─────────────────────────────────────────────────────────
  // 事件接线
  // ─────────────────────────────────────────────────────────
  area.addEventListener('input', () => {
    text = area.value;
    recomputeStatus();
    // ⚠ 只推快照，不自己 debounce —— debounce 在主进程（M5）
    pushSnapshot();
    void refreshMetrics();
  });
  area.addEventListener('keyup', updateSelection);
  area.addEventListener('mouseup', updateSelection);
  area.addEventListener('select', updateSelection);

  /**
   * ⚠ Ctrl/Cmd+S 必须在**编辑器获得焦点时**才拦截。
   *   全局拦截会让作者在别处按 Ctrl+S 时被吞掉（比如未来的设定编辑器），
   *   而且默认的"保存网页"行为被拦掉后没有替代动作 —— 那才是真正的 bug。
   */
  area.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      void doSave();
    }
  });

  btnSave.addEventListener('click', () => void doSave());
  btnView.addEventListener('click', toggleView);
  btnRestore.addEventListener('click', () => void doRestore());
  btnDiscard.addEventListener('click', () => void doDiscard());

  btnCommit.addEventListener('click', () => {
    // ⚠ M4 只做入口与说明，真正的提交链路在 M9（提交前检查面板）。
    //   这里**不**直接调 workspace.commit —— 那会绕过 §三十一 要求的
    //   提交前检查（Review / Continuity / State Settlement）。
    statusLine.className = 'form-msg form-msg--warn';
    statusLine.textContent =
      '提交前检查面板尚未接入（M9）。当前请先点「保存」，' +
      '再到右栏「写作流程」跑完整工作流完成提交。';
  });

  /**
   * ⚠ 切章/离开前 flush：主进程 debounce 未到点的快照若不冲掉，
   *   作者写完最后一句立刻切走，那几句就只存在于内存里。
   *
   *   M5 起这条保护有**两层**：
   *     1. 这里（renderer 主动 flush，正常切章路径）
   *     2. 主进程的 `render-process-gone` / `before-quit`（崩溃与退出路径）
   *   第二层才是把 debounce 移到主进程的意义 —— 页面已经死了，
   *   它最后推过去的快照仍然能落盘。
   */
  window.addEventListener('beforeunload', () => {
    void flushAutosave();
  });

  // 对外暴露清理钩子（切章时由调用方触发）
  box.__cleanup = () => {
    void flushAutosave();
  };

  void load();
  return box;
}
