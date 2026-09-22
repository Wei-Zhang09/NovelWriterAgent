/**
 * 语料导入 + 蒸馏链面板（§16 / §58 / §61）
 *
 * ## ⚠ 为什么补这个
 *
 * 用户问"软件应该具备后期导入小说进行蒸馏的入口，这个有吗" ——
 * 实测答案是**没有**：
 *   - 导入能力只存在于 `scripts/verify-books.mjs`（硬编码书单）
 *   - 无导入 IPC，界面完全无入口
 *
 * 也就是说要导入新小说，用户只能去改脚本源码。
 *
 * ## ⚠ 版权登记是必填项，不是可选项（§61）
 *
 * 面板上把「许可」放在显眼位置并给出后果说明：
 *   - 选 UNKNOWN → 自动降级为「仅可检索」，**不能蒸馏**（会明确提示）
 *   - 其他许可 → 可进蒸馏链
 *
 * 这样"允许导入但风险自负"生效，同时用户清楚知道后果。
 */
export function renderCorpusPanel({ el, invoke, msg }) {
  const box = el('div', 'form form--rail');
  box.append(el('h3', null, '语料导入与蒸馏'));

  // ── 1. 选文件 ──
  const fileRow = el('div', 'btn-row');
  const fileLabel = el('span', 'perm-line', '未选择文件');
  const pickBtn = el('button', 'btn', '选择小说文件');
  fileRow.append(pickBtn);
  box.append(fileRow, fileLabel);

  let pickedPath = null;
  pickBtn.addEventListener('click', async () => {
    // ⚠ 文件对话框在主进程（dialog 是主进程 API），preload 已暴露 pickFile
    const p = await window.nwa.pickFile();
    if (!p) {
      fileLabel.textContent = '未选择文件（已取消）';
      pickedPath = null;
      return;
    }
    pickedPath = p;
    fileLabel.textContent = `已选择：${p}`;
    // 用文件名预填标题
    const base = p.split(/[\\/]/).pop() ?? '';
    if (!titleInput.value) titleInput.value = base.replace(/\.(txt|md)$/i, '');
  });

  // ── 2. 元信息（含版权登记）──
  const fields = el('div', 'corpus-fields');
  const titleInput = input(el, '书名');
  const authorInput = input(el, '作者');
  const genreInput = input(el, '类型（如 都市 / 仙侠 / 玄幻）');
  const basisInput = input(el, '版权依据说明（§61 要求能说明为什么可以处理）');

  const licenseSel = el('select', 'input');
  for (const [v, label] of [
    ['USER_OWNED', 'USER_OWNED（我自己拥有/购买）'],
    ['USER_LICENSED', 'USER_LICENSED（已获授权）'],
    ['PUBLIC_DOMAIN', 'PUBLIC_DOMAIN（公版）'],
    ['REFERENCE_ONLY', 'REFERENCE_ONLY（仅参考）'],
    ['UNKNOWN', 'UNKNOWN（不清楚 —— 不能用于蒸馏）'],
  ]) {
    const o = el('option', null, label);
    o.value = v;
    licenseSel.append(o);
  }

  fields.append(
    row(el, '书名', titleInput),
    row(el, '作者', authorInput),
    row(el, '类型', genreInput),
    row(el, '许可', licenseSel),
    row(el, '依据', basisInput),
  );
  box.append(fields);

  // ⚠ 许可后果提示 —— 选 UNKNOWN 时必须让用户看见后果
  const licenseHint = el('div', 'perm-line');
  const refreshHint = () => {
    licenseHint.textContent =
      licenseSel.value === 'UNKNOWN'
        ? '⚠ 许可不明：语料可导入并用于检索，但**不能进入蒸馏链**（§61）。'
        : '该许可允许进入蒸馏链（标注 → 挖掘 → 编译技能）。';
  };
  licenseSel.addEventListener('change', refreshHint);
  refreshHint();
  box.append(licenseHint);

  const cleanRow = el('label', 'perm-line');
  const cleanChk = el('input');
  cleanChk.type = 'checkbox';
  cleanChk.checked = true;
  cleanRow.append(cleanChk, document.createTextNode(' 清洗网络转载噪声（水印/作者话/番外）'));
  box.append(cleanRow);

  // ── 3. 导入 ──
  const importRow = el('div', 'btn-row');
  const importBtn = el('button', 'btn btn--primary', '导入');
  importRow.append(importBtn);
  box.append(importRow);

  const resultBox = el('div', 'model-status');
  box.append(resultBox);

  importBtn.addEventListener('click', async () => {
    if (!pickedPath) {
      msg.className = 'form-msg form-msg--err';
      msg.textContent = '请先选择文件';
      return;
    }
    importBtn.disabled = true;
    msg.className = 'form-msg';
    msg.textContent = '导入中（大文件需要一会儿）…';
    try {
      const r = await invoke('corpus.import', {
        filePath: pickedPath,
        title: titleInput.value.trim() || undefined,
        author: authorInput.value.trim() || null,
        genre: genreInput.value.trim() || null,
        licenseType: licenseSel.value,
        licenseBasis: basisInput.value.trim() || undefined,
        clean: cleanChk.checked,
      });
      if (!r.ok) {
        msg.className = 'form-msg form-msg--err';
        msg.textContent = `导入失败：${r.error?.message ?? ''}`;
        return;
      }
      const d = r.data;
      msg.textContent = `已导入《${d.title}》：${d.chapterCount} 章 / ${d.chars} 字`;
      resultBox.replaceChildren();
      resultBox.append(el('div', 'perm-line', `文档 ID：${d.documentId}`));
      resultBox.append(el('div', 'perm-line', `切分策略：${d.strategy ?? '—'}`));
      if (d.removedChars) {
        const rules = (d.cleanRules ?? []).map((x) => `${x.name}×${x.count}`).join('、');
        resultBox.append(
          el('div', 'perm-line', `清洗掉 ${d.removedChars} 字（${rules || '无明细'}）`),
        );
      }
      // ⚠ 章节号缺口是**源文本自身**的问题，如实显示
      for (const g of d.declaredGaps ?? []) {
        resultBox.append(
          el('div', 'perm-line', `⚠ 源文本缺章号：第 ${g.after} 章之后直接到第 ${g.before} 章`),
        );
      }
      // ⚠ 许可警告（UNKNOWN 时的降级说明）
      if (d.licenseWarning) {
        resultBox.append(el('div', 'perm-line form-msg--err', `⚠ ${d.licenseWarning}`));
      }
      await refreshOverview();
    } finally {
      importBtn.disabled = false;
    }
  });

  // ── 4. 语料概览 ──
  box.append(el('h3', null, '语料库'));
  const overviewBox = el('div', 'model-status');
  box.append(overviewBox);

  async function refreshOverview() {
    overviewBox.replaceChildren(el('div', 'empty', '读取中…'));
    const r = await invoke('corpus.overview', {});
    if (!r.ok) {
      overviewBox.replaceChildren(el('div', 'empty', `读取失败：${r.error?.message ?? ''}`));
      return;
    }
    const d = r.data;
    overviewBox.replaceChildren();
    overviewBox.append(
      el(
        'div',
        'perm-line',
        `共 ${d.totals.documents} 部（可蒸馏 ${d.totals.processable} 部）｜` +
          `场景 ${d.totals.scenes}｜已标注 ${d.totals.annotated}`,
      ),
    );
    for (const doc of d.documents) {
      const rowEl = el('div', 'skill-row');
      rowEl.append(el('div', 'skill-name', doc.title));
      rowEl.append(
        el(
          'div',
          'perm-line',
          `${doc.genre ?? '未标类型'}${doc.subgenre ? '/' + doc.subgenre : ''}｜` +
            `${doc.licenseType} → ${doc.allowedUsage}｜` +
            `场景 ${doc.annotated}/${doc.scenes}${doc.failed ? `（失败 ${doc.failed}）` : ''}`,
        ),
      );
      if (!doc.processable) {
        rowEl.append(
          el('div', 'perm-line form-msg--err', '⚠ 该语料不允许蒸馏（§61 许可限制）'),
        );
      } else {
        // 蒸馏按钮：只对允许蒸馏的语料显示
        const dr = el('div', 'btn-row');
        const dBtn = el('button', 'btn', '蒸馏这部（标注→挖掘→编译）');
        dr.append(dBtn);
        rowEl.append(dr);
        dBtn.addEventListener('click', async () => {
          dBtn.disabled = true;
          msg.className = 'form-msg';
          msg.textContent = `蒸馏《${doc.title}》中…（标注耗时与章数成正比，请耐心等）`;
          try {
            const res = await invoke('corpus.distill', {
              documentId: doc.documentId,
              genre: doc.genre,
            });
            const stages = res.data?.stages ?? [];
            if (!res.ok) {
              msg.className = 'form-msg form-msg--err';
              msg.textContent =
                `蒸馏在「${res.data?.stoppedAt ?? '未知'}」阶段停止：` +
                `${stages.find((s) => !s.ok)?.detail ?? res.error?.message ?? ''}`;
            } else {
              msg.textContent = `蒸馏完成：${stages.map((s) => s.stage).join(' → ')}`;
            }
            await refreshOverview();
          } finally {
            dBtn.disabled = false;
          }
        });
      }
      overviewBox.append(rowEl);
    }
  }

  // 首次自动加载
  queueMicrotask(refreshOverview);

  return box;
}

function input(el, placeholder) {
  const i = el('input', 'input');
  i.placeholder = placeholder;
  return i;
}

function row(el, label, control) {
  const r = el('div', 'corpus-field-row');
  r.append(el('span', 'perm-line', label), control);
  return r;
}
