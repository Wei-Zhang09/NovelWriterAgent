/**
 * M9 —— 提交前检查面板（§三十一 / §三十二）。
 *
 * ## 七项检查，失败时说人话
 *
 * 判据全在主进程（`commit.precheck`），本文件只负责渲染与
 * 「重新检查」。判定逻辑绝不在这里再写一遍 —— 那是第二处实现，
 * 迟早与提交时用的判定分叉（§31 要防的正是"面板说可以、提交被拒"）。
 *
 * ## ⚠ 面板是**预检**，不是提交
 *
 * 「提交到正史」由「写作流程」跑完整工作流完成（§三十 的边界）。
 * 本面板只回答"现在还差什么"，点提交按钮只是把结果摆给作者看 ——
 * 不让它直接调 commit 是刻意的：§三十一 要求提交必须经过这七项，
 * 而绕过检查的提交入口本身就是个缺陷。
 */
export function renderCommitPrecheck({ el, invoke, msg, chapter, getText }) {
  const box = el('div', 'precheck');

  const head = el('div', 'precheck__head');
  head.append(el('h3', null, '提交前检查'));
  const recheckBtn = el('button', 'btn btn--small', '重新检查');
  head.append(recheckBtn);
  box.append(head);

  const statusLine = msg();
  box.append(statusLine);

  const list = el('div', 'precheck__list');
  box.append(list);

  /**
   * 跑一次检查并渲染。
   *
   * ⚠ 必须把**编辑器当前文本**传过去：作者改了还没保存时，磁盘正文是旧的，
   *   只比磁盘的话三项锚点检查都会显示"对应当前版本"，
   *   而实际提交用的是编辑器里那份 —— 检查了个寂寞。
   */
  async function run() {
    const text = typeof getText === 'function' ? getText() : undefined;
    const r = await invoke('commit.precheck', {
      chapterId: chapter.id,
      ...(typeof text === 'string' ? { editorText: text } : {}),
    });
    if (!r.ok) {
      statusLine.className = 'form-msg form-msg--err';
      statusLine.textContent = `检查失败：${r.error.message}`;
      list.replaceChildren();
      return;
    }

    const d = r.data;
    list.replaceChildren();

    statusLine.className = d.canCommit ? 'form-msg form-msg--ok' : 'form-msg form-msg--err';
    statusLine.textContent = d.canCommit
      ? '七项检查全部通过，可以提交。'
      : `还有 ${d.failedCount} 项未通过，现在提交会被拒。`;

    for (const c of d.checks) {
      const row = el('div', `precheck__row ${c.ok ? 'precheck__row--ok' : 'precheck__row--fail'}`);
      row.dataset.checkId = c.id;

      const top = el('div', 'precheck__top');
      top.append(el('span', 'precheck__mark', c.ok ? '✓' : '✗'));
      top.append(el('span', 'precheck__label', c.label));
      row.append(top);

      row.append(el('div', 'precheck__msg', c.message));
      // ⚠ 失败时给"下一步该做什么"，只说"未通过"等于让作者自己猜
      if (!c.ok && c.hint) row.append(el('div', 'precheck__hint', '→ ' + c.hint));

      // ⚠ stale 项把两个哈希的前 8 位摆出来：作者只知道"过期了"
      //   却不知道该重跑什么，看到"a1b2c3d4 vs e5f6a7b8"才明白
      //   这份结论对应的是另一版正文
      const st = (d.staleness ?? []).find((s) => s.artifact === c.id);
      if (st && !c.ok && st.status !== 'MISSING') {
        row.append(
          el(
            'div',
            'precheck__hash',
            `结论依据 ${st.anchoredHash ?? '（无锚点）'} / 当前正文 ${st.currentHash ?? '（无）'}`,
          ),
        );
      }

      list.append(row);
    }
  }

  recheckBtn.addEventListener('click', () => void run());

  // ⚠ 挂载时**不**立刻跑：编辑器加载正文是异步的（`manuscript.open`），
  //   面板构造时 `area.value` 还是空串 —— 此时预检会得出
  //   「编辑器文本 '' ≠ 磁盘正文」→ 误报"有未保存改动"，
  //   连带三项锚点判定一起失败。实测就是这个现象：
  //   界面显示 saved:✗，而独立调 IPC（带上真实文本）是 saved:✓。
  //
  //   所以由编辑器在**正文加载完成后**显式调 `refreshPrecheck()`。

  box.refreshPrecheck = run;
  return box;
}
