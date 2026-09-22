/**
 * 技能与备份面板（STEP 22 UI polish）
 *
 * ## ⚠ 为什么必须补这两个面板
 *
 * STEP 17–21 把技能编译、技能检索、备份/恢复/导出都做完了，
 * 但**界面上完全没有入口** —— 只能靠 `pnpm verify:*` 脚本调用。
 *
 * 这是本项目反复出现的同一类缺陷的**界面版本**：
 *   - `detectProseIssues` 写了没接线
 *   - `ChapterBrief.skillRefs` 字段没人填
 *   - `book.create` / `character.create` 工具缺失
 *   - 现在：后端能力齐备，**UI 够不到**
 *
 * 对用户而言"后端有、界面没有"等同于"没有"。§73 的 v1.0 完成判定里
 * 「Skill Retrieval」这一项，在补上界面之前无法算真正完成。
 *
 * ## 面板内容
 * - **写作技能**：列出当前类型的可用技能（§21 类型隔离）、显示作用域与
 *   置信度、可下架（DEPRECATED）
 * - **备份与导出**：导出项目、校验导出物、从备份恢复
 */
/**
 * 技能面板。
 *
 * ⚠ 技能列表按**类型**过滤（§21）—— 面板要显示"当前在用什么类型的技能"，
 *   否则用户会以为库里所有技能都在生效（而 STYLE 默认是不可见的）。
 */
export function renderSkillPanel({ el, state, invoke, msg }) {
  const box = el('div', 'form form--rail');
  box.append(el('h3', null, '写作技能'));

  const genreRow = el('div', 'btn-row');
  const genreSel = el('select', 'input');
  for (const g of ['都市', '仙侠', '玄幻', '（不限）']) {
    const o = el('option', null, g);
    o.value = g === '（不限）' ? '' : g;
    genreSel.append(o);
  }
  genreSel.value = state.skillGenre ?? '都市';
  genreRow.append(el('span', 'perm-line', '类型'), genreSel);
  box.append(genreRow);

  const listBox = el('div', 'model-status');
  box.append(listBox);

  const allowStyleRow = el('label', 'perm-line');
  const allowStyle = el('input');
  allowStyle.type = 'checkbox';
  allowStyleRow.append(allowStyle, document.createTextNode(' 包含作者风格技能（默认关闭）'));
  box.append(allowStyleRow);

  box.append(
    el(
      'div',
      'perm-line',
      '⚠ 技能是策略建议不是硬要求。每条末尾的「不适用的情况」务必看 —— 用错场合比不用更糟。',
    ),
  );

  async function refresh() {
    listBox.replaceChildren(el('div', 'empty', '读取中…'));
    state.skillGenre = genreSel.value;
    const r = await invoke('skill.list', {
      genre: genreSel.value || null,
      allowStyle: allowStyle.checked,
      limit: 60,
    });
    if (!r.ok) {
      listBox.replaceChildren(el('div', 'empty', `读取失败：${r.error?.message ?? ''}`));
      return;
    }
    const d = r.data ?? {};
    listBox.replaceChildren();
    listBox.append(
      el(
        'div',
        'perm-line',
        `可检索 ${d.total} 个｜被类型隔离挡掉 ${d.excludedCount} 个`,
      ),
    );
    if ((d.skills ?? []).length === 0) {
      listBox.append(
        el('div', 'empty', '该类型下没有可用技能 —— 请先跑技能编译，或补同类型语料后重挖'),
      );
      return;
    }
    for (const s of d.skills) {
      const row = el('div', 'skill-row');
      row.append(el('div', 'skill-name', s.name));
      row.append(
        el(
          'div',
          'perm-line',
          `${s.scope}｜置信 ${s.confidence}｜v${s.version}｜${s.status}` +
            `｜证据 ${(s.evidenceRefs ?? []).length} 条`,
        ),
      );
      row.append(el('div', 'perm-line', s.summary));
      const anti = (s.antiPatterns ?? []).map((a) => (typeof a === 'string' ? a : a.rule));
      if (anti.length) {
        row.append(el('div', 'perm-line', `⚠ 不适用：${anti.join('；')}`));
      }
      listBox.append(row);
    }
  }

  genreSel.addEventListener('change', refresh);
  allowStyle.addEventListener('change', refresh);

  const btnRow = el('div', 'btn-row');
  const refreshBtn = el('button', 'btn', '刷新技能列表');
  btnRow.append(refreshBtn);
  box.append(btnRow, msg);
  refreshBtn.addEventListener('click', refresh);

  // ⚠ 首次渲染后自动加载一次：让用户一进来就看到"有没有技能"，
  //   而不是面对一个空面板还要自己点。
  queueMicrotask(refresh);

  return box;
}

/**
 * 备份与导出面板（§58）。
 *
 * ⚠ 恢复是**破坏性**操作，因此界面上：
 *   1. 默认按钮是「导出」与「校验」，恢复放在最后
 *   2. 恢复必须勾选确认框才可点
 *   3. 明确写出"恢复前会先备份现状"
 */
export function renderBackupPanel({ el, invoke, msg }) {
  const box = el('div', 'form form--rail');
  box.append(el('h3', null, '备份与导出'));

  const outBox = el('div', 'model-status');
  box.append(outBox);

  // ── 导出 ──
  const exportRow = el('div', 'btn-row');
  const exportBtn = el('button', 'btn btn--primary', '导出项目');
  exportRow.append(exportBtn);
  box.append(exportRow);

  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    msg.className = 'form-msg';
    msg.textContent = '导出中…';
    const r = await invoke('backup.export', {});
    exportBtn.disabled = false;
    if (!r.ok) {
      msg.className = 'form-msg form-msg--err';
      msg.textContent = `导出失败：${r.error?.message ?? ''}`;
      return;
    }
    const d = r.data;
    msg.textContent = `已导出 ${d.files} 个文件（${Math.round(d.bytes / 1024)} KB）`;
    outBox.replaceChildren();
    outBox.append(el('div', 'perm-line', `位置：${d.outDir}`));
    // ⚠ 如实显示排除了什么 —— 否则用户以为"导出了整个项目"
    for (const x of d.excluded ?? []) outBox.append(el('div', 'perm-line', `未包含：${x}`));
  });

  // ── 校验 ──
  const verifyRow = el('div', 'btn-row');
  const dirInput = el('input', 'input');
  dirInput.placeholder = '备份目录路径';
  const verifyBtn = el('button', 'btn', '校验完整性');
  verifyRow.append(dirInput, verifyBtn);
  box.append(verifyRow);

  verifyBtn.addEventListener('click', async () => {
    const dir = dirInput.value.trim();
    if (!dir) {
      msg.className = 'form-msg form-msg--err';
      msg.textContent = '请先填备份目录';
      return;
    }
    const r = await invoke('backup.verify', { dir });
    const d = r.data ?? {};
    msg.className = d.ok ? 'form-msg' : 'form-msg form-msg--err';
    msg.textContent = d.ok
      ? `校验通过（${d.checked} 个文件）`
      : `校验失败：${(d.problems ?? []).join('；')}`;
  });

  // ── 恢复（危险操作，需显式确认）──
  box.append(el('h3', null, '从备份恢复'));
  box.append(
    el(
      'div',
      'perm-line',
      '⚠ 恢复会覆盖目标项目。恢复前会先把现状移到 .pre-restore-*（可回滚）。' +
        '若目标是当前打开的项目，请先关闭它 —— Windows 不允许移动已打开的项目目录。',
    ),
  );

  const restoreRow = el('div', 'btn-row');
  const targetInput = el('input', 'input');
  targetInput.placeholder = '目标项目目录路径';
  restoreRow.append(targetInput);
  box.append(restoreRow);

  const confirmRow = el('label', 'perm-line');
  const confirm = el('input');
  confirm.type = 'checkbox';
  confirmRow.append(confirm, document.createTextNode(' 我确认要覆盖目标项目'));
  box.append(confirmRow);

  const restoreBtn = el('button', 'btn btn--danger', '执行恢复');
  restoreBtn.disabled = true;
  confirm.addEventListener('change', () => {
    restoreBtn.disabled = !confirm.checked;
  });
  const restoreBtnRow = el('div', 'btn-row');
  restoreBtnRow.append(restoreBtn);
  box.append(restoreBtnRow);

  restoreBtn.addEventListener('click', async () => {
    const backupDir = dirInput.value.trim();
    const targetDir = targetInput.value.trim();
    if (!backupDir || !targetDir) {
      msg.className = 'form-msg form-msg--err';
      msg.textContent = '备份目录与目标目录都要填';
      return;
    }
    restoreBtn.disabled = true;
    msg.className = 'form-msg';
    msg.textContent = '恢复中…';
    const r = await invoke('backup.restore', { backupDir, targetDir, overwrite: true });
    const d = r.data ?? {};
    if (!d.ok) {
      msg.className = 'form-msg form-msg--err';
      msg.textContent = `恢复失败：${d.error?.code} — ${d.error?.message ?? ''}`;
      restoreBtn.disabled = false;
      return;
    }
    msg.textContent =
      `恢复完成（校验 ${d.verified} 个文件）` +
      (d.ftsRebuilt ? `｜FTS 已重建 ${d.ftsRebuilt.chapters} 章` : '｜⚠ FTS 未重建');
    for (const w of d.warnings ?? []) outBox.append(el('div', 'perm-line', `⚠ ${w}`));
    restoreBtn.disabled = false;
  });

  // ── FTS 重建（§59：派生数据可重建）──
  const rebuildRow = el('div', 'btn-row');
  const rebuildBtn = el('button', 'btn', '重建检索索引');
  rebuildRow.append(rebuildBtn);
  box.append(rebuildRow);
  rebuildBtn.addEventListener('click', async () => {
    const r = await invoke('backup.rebuildFts', {});
    msg.className = r.ok ? 'form-msg' : 'form-msg form-msg--err';
    msg.textContent = r.ok
      ? `索引已重建：${r.data.chapters} 章 / ${r.data.memories} 条记忆`
      : `重建失败：${r.error?.message ?? ''}`;
  });

  return box;
}
