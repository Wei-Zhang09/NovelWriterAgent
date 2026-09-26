/**
 * 开书向导（前置设定流程）—— W8 界面。
 *
 * ## 用户诉求（原话）
 * > 「应该配置 ai 生成大纲角色等等相关功能，再由用户进行选择、修改，
 * >    最后确认一切前置信息后，再开始写作呀」
 *
 * 所以这个界面要做四件事，缺一件流程就走不完：
 *   ① 生成（AI 产出草案）
 *   ② 选择（作者在候选/冲突里拍板 —— 这是「选择」的落点）
 *   ③ 修改（作者改 AI 的内容，不覆盖 AI 原稿）
 *   ④ 统一确认（全部确认后才允许开写）
 *
 * ## ⚠ 为什么必须让作者看见「门禁是否开着」
 *
 * 用户明确选过「允许跳过：不想用 AI 就直接手写或直接开写，
 * 向导只是个可选的快捷方式」。也就是说这个流程**不是强制的**。
 * 界面若不显示门禁状态，作者会以为"必须走完向导才能写"，
 * 或者反过来以为"走完了就一定拦得住"—— 两种误解都让人做出错误决定。
 * 所以门禁状态是**首屏第一块**内容，且如实显示「未启用」。
 *
 * ## ⚠ 冲突必须逐条问（用户决策原话）
 * > 「先弹窗逐条让我选（保留旧的 / 用新的 / 两个都留）—— 最可控但确认步骤最重」
 *
 * 用户明确接受了"确认步骤最重"这个代价。所以**不能**做成
 * "全部保留旧的"这种一键默认 —— 那等于替作者做了决定，
 * 而 AI 提议与作者原设定冲突时，哪一条对只有作者知道。
 *
 * ## ⚠ 数据来源
 * 全部走 W7 接的 IPC（`blueprint.*`）。这些通道在 W8 之前
 * **渲染层零调用** —— 后端建好的能力在界面上完全够不到。
 * 这正是 W7 端到端测试抓到的缺陷形态（能力齐全、没有入口），
 * 本轮补上入口这一层。
 */

/**
 * 步骤状态 → 标签与颜色。文字与颜色双编码（色盲可辨）
 *
 * ⚠ 这里**不硬编码步骤名与顺序** —— `blueprint.status` 已经返回
 *   `steps[]`（含 label）。再写一份副本就会与 core 的 `BLUEPRINT_STEPS`
 *   分叉：加了第五步时界面少显示一步，且没有任何地方会报错。
 */
const STEP_STATUS = {
  NOT_STARTED: ['chip--muted', '未开始'],
  GENERATED: ['chip--info', '已生成'],
  EDITED: ['chip--warn', '已编辑'],
  CONFIRMED: ['chip--ok', '已确认'],
};

/** 作者对单条冲突的决定（与后端 ConflictDecision 一致） */
const DECISIONS = [
  ['keep_existing', '保留我写的', '丢弃 AI 的这条提议'],
  ['use_new', '用 AI 的', '覆盖我写的那条'],
  ['keep_both', '两个都留', 'AI 的会改名后新建'],
];

export function renderBlueprintWizard({ el, invoke, state, msg, refreshBooks }) {
  const box = el('div', 'view');
  const body = el('div', 'view__body');

  const head = el('div', 'view__head');
  head.append(el('h2', null, '开书向导'));
  const refresh = el('button', 'btn', '刷新');
  head.append(refresh);
  box.append(head);
  box.append(body);
  box.append(msg);

  /** 本次会话里保留的冲突列表（生成时算出的那些，物化时要原样回传） */
  let conflicts = [];
  /** 作者的逐条决定：{ [名字]: 'keep_existing' | 'use_new' | 'keep_both' } */
  let decisions = {};
  /** 当前正在编辑哪一步（点「修改」后进入） */
  let editing = null;

  const bookId = () => state.selectedBookId;

  /**
   * 提示信息写进**本视图自己的** msg 元素。
   *
   * ⚠ 不用 `document.querySelector('.form-msg')` 去找 —— 中栏同时只应有一个
   *   视图，但右栏面板里也有 form-msg（模型设置等）。按选择器找会命中错的
   *   那个，表现为"提示信息出现在别的面板里"或"哪里都不出现"。
   */
  let msgTimer = null;
  function showMsg(text, kind) {
    msg.textContent = text;
    msg.className = `form-msg form-msg--${kind}`;
    // ⚠ 成功提示要能自动消失（否则界面永远挂着一句旧话），
    //   但**错误提示不能** —— 作者需要它留在屏幕上对照着改
    if (msgTimer) clearTimeout(msgTimer);
    if (kind === 'ok') {
      msgTimer = setTimeout(() => {
        msg.textContent = '';
      }, 6000);
    }
  }

  /**
   * 没有书时：引导「新建书 → 进向导」。
   *
   * ⚠ 复用 `book.create` 这条**既有** IPC（与项目主页「新建书目」同一个），
   *   不新建通道。区别只在于这里建完**立刻**把当前书切过去并刷新向导，
   *   让作者一步进到步骤①。
   */
  function renderCreateBookPrompt() {
    const c = el('div', 'card');
    c.append(el('div', 'card__title', '先建一本书'));
    c.append(
      el(
        'div',
        'hint',
        '开书向导是**按书**进行的：选题方向、核心设定、卷纲、细纲都记在某一本书名下。' +
          '所以先建书，再进向导。',
      ),
    );

    const row = el('div', 'btn-row');
    const title = el('input', 'input');
    title.placeholder = '书名（必填）';
    const btn = el('button', 'btn btn--primary', '创建并进入向导');
    row.append(title, btn);
    const line = el('div', 'form-msg');
    c.append(row, line);

    btn.addEventListener('click', async () => {
      const name = title.value.trim();
      if (name.length === 0) {
        line.className = 'form-msg form-msg--err';
        line.textContent = '请填写书名';
        return;
      }
      setBusy(btn, true, '创建中…');
      const r = await invoke('book.create', { projectId: state.project.id, title: name });
      setBusy(btn, false);
      if (!r.ok) {
        line.className = 'form-msg form-msg--err';
        line.textContent = `${r.error.code}：${r.error.message}`;
        return;
      }
      // ⚠ 切到新书 —— 不切的话向导仍绑在旧书上（或没有书），
      //   作者会以为"创建了但向导还是空的"。
      state.selectedBookId = r.data.id;
      // ⚠ 让左栏书目列表跟着出现这本新书。`refreshBooks` 由 renderer.js
      //   注入 —— 它只刷左栏，**不重建中栏**（否则作者会被踢出向导）。
      await refreshBooks?.();
      line.className = 'form-msg form-msg--ok';
      line.textContent = `已创建「${r.data.title}」，正在进入向导…`;
      await render();
    });

    return c;
  }

  // ───────────────────────────────────────────────────────────
  // 门禁状态（首屏第一块 —— 见文件头注释）
  // ───────────────────────────────────────────────────────────
  async function loadStatus() {
    if (!bookId()) {
      // ── 没有书时先引导「新建书 → 进向导」─────────────────────
      //
      // ⚠ 用户决策（2026-09-26）：
      //   > 「没有书时，向导入口先引导「新建书 → 进向导」，
      //   >    确认后这本书直接可写（不在向导里再建书）」
      //
      // 所以这里**只**给建书入口，不让作者在向导内部接着走四步 ——
      // 向导是**按书**的（`bookId = state.selectedBookId`），没有书时
      // 每一步生成都没有落点（`blueprint_steps.book_id` 非空外键）。
      //
      // ⚠ 原来的文案「先在左栏选一本书」在**一本书都没有**时是死胡同：
      //   左栏书目区只会显示「还没有书」，没有可点的地方。
      if (!state.project) {
        body.replaceChildren(
          el('div', 'empty', '还没有项目。请先在「开始」页创建项目。'),
        );
        return null;
      }
      body.replaceChildren(renderCreateBookPrompt());
      return null;
    }
    const r = await invoke('blueprint.status', { bookId: bookId() });
    if (!r.ok) {
      // ⚠ 读不到就说读不到，不显示"未开始" ——
      //   那会让作者以为向导没走过，而实际是后端出错了
      body.replaceChildren(el('div', 'callout callout--err', `读取失败：${r.error.message}`));
      return null;
    }
    return r.data;
  }

  function renderGate(d) {
    const gate = el('div', 'callout');
    const g = el('div', 'kv');
    g.append(kv(el, '向导门禁', d.gateEnabled ? '已启用（前置未确认则拒绝开写）' : '未启用'));
    g.append(kv(el, '统一确认时间', d.confirmedAt ?? '尚未确认'));
    gate.append(g);

    if (!d.gateEnabled) {
      // ⚠ 如实说明"不拦"—— 作者选了可跳过，这是刻意设计而非缺陷
      gate.append(
        el(
          'div',
          'perm-line',
          '门禁未启用：不走向导也能直接开写。想强制自己先定好前置内容，可开启门禁。',
        ),
      );
    } else if (d.allowed) {
      gate.append(el('div', 'perm-line', '✓ 前置信息已确认，可以开写。'));
    } else {
      gate.append(el('div', 'perm-line', `✗ 暂不可开写：${d.message ?? d.reason ?? '前置未确认'}`));
    }
    return gate;
  }

  // ───────────────────────────────────────────────────────────
  // 步骤条
  // ───────────────────────────────────────────────────────────
  function renderSteps(d) {
    const wrap = el('div', 'card');
    wrap.append(el('div', 'card__title', '四个步骤'));
    const list = el('div', 'issue-list');
    for (const st of d.steps) {
      const row = el('div', 'issue-row');
      const [cls, text] = STEP_STATUS[st.status] ?? ['chip--muted', st.status];
      row.append(el('span', `chip ${cls}`, text));
      row.append(el('span', 'issue-row__msg', `${st.label}`));
      // ⚠ 步骤名旁边显示的是**真实状态**，不是"轮到你了"的提示 ——
      //   后者要额外维护一份顺序逻辑，且容易与实际状态分叉
      row.append(el('span', 'issue-row__meta', st.step));
      list.append(row);
    }
    wrap.append(list);
    return wrap;
  }

  // ───────────────────────────────────────────────────────────
  // ① CONCEPT：生成候选 → 作者选一个
  // ───────────────────────────────────────────────────────────
  function renderConceptPanel() {
    const c = el('div', 'card');
    c.append(el('div', 'card__title', '① 选题方向'));

    const genBtn = el('button', 'btn btn--primary', '生成 2-3 个方向');
    c.append(genBtn);

    const out = el('div', 'card__body');
    c.append(out);

    genBtn.addEventListener('click', async () => {
      setBusy(genBtn, true, '生成中…');
      out.replaceChildren(el('div', 'empty', '正在生成…（模型可能要十几秒）'));
      const r = await invoke('blueprint.generateConcept', { bookId: bookId(), params: {} });
      setBusy(genBtn, false);
      if (!r.ok) {
        out.replaceChildren(el('div', 'callout callout--err', `生成失败：${r.error.message}`));
        return;
      }
      const cands = r.data.candidates ?? [];
      out.replaceChildren();
      if (cands.length === 0) {
        // ⚠ schema 要求 min(2)，能到这儿说明后端没按契约返回 ——
        //   如实报出来而不是显示空列表让人以为"模型没想法"
        out.append(el('div', 'callout callout--warn', '模型没有返回候选（与契约不符）。'));
        return;
      }
      out.append(el('div', 'hint', `共 ${cands.length} 个方向。选一个作为全书方向：`));
      for (const [i, cd] of cands.entries()) {
        out.append(renderCandidate(cd, i));
      }
    });

    return c;
  }

  function renderCandidate(cd, i) {
    const card = el('div', 'card');
    const hd = el('div', 'card__head');
    hd.append(el('span', 'card__title', `方向 ${i + 1}`));
    card.append(hd);

    const g = el('div', 'kv');
    for (const [k, v] of [
      ['一句话卖点', cd.pitch],
      ['题材', cd.genre],
      ['核心情绪', cd.coreEmotion],
      ['主角', cd.protagonist],
      ['核心冲突', cd.coreConflict],
      ['差异化', cd.differentiation],
      ['预计章数', String(cd.estimatedChapters)],
    ]) {
      g.append(kv(el, k, v ?? '—'));
    }
    card.append(g);

    const pick = el('button', 'btn btn--primary', '选这个方向');
    pick.addEventListener('click', async () => {
      setBusy(pick, true, '保存中…');
      // ⚠ 选定即落库（存 draft）—— 落库后 Phase 2 才有依据。
      //   selectedReason 传 null：作者可能只是觉得顺眼，
      //   强制填理由会让人随便写一个，反而污染数据
      const r = await invoke('blueprint.chooseConcept', {
        bookId: bookId(),
        candidate: { ...cd, selectedReason: null },
      });
      setBusy(pick, false);
      if (!r.ok) {
        showMsg(`选定失败：${r.error.message}`, 'err');
        return;
      }
      showMsg('方向已选定，可以进行下一步。', 'ok');
      await render();
    });
    card.append(pick);
    return card;
  }

  // ───────────────────────────────────────────────────────────
  // ② SETTINGS：生成 → 逐条决定冲突 → 物化进正式表
  // ───────────────────────────────────────────────────────────
  function renderSettingsPanel() {
    const c = el('div', 'card');
    c.append(el('div', 'card__title', '② 核心设定与角色'));

    const genBtn = el('button', 'btn btn--primary', '生成设定与角色');
    c.append(genBtn);

    const out = el('div', 'card__body');
    c.append(out);

    genBtn.addEventListener('click', async () => {
      setBusy(genBtn, true, '生成中…');
      out.replaceChildren(el('div', 'empty', '正在生成…'));
      const r = await invoke('blueprint.generateSettings', { bookId: bookId(), params: {} });
      setBusy(genBtn, false);
      if (!r.ok) {
        out.replaceChildren(el('div', 'callout callout--err', `生成失败：${r.error.message}`));
        return;
      }
      // ⚠ 冲突只在生成时算得出来（SettingsOutput 里没有 conflicts 字段），
      //   必须留到物化时原样回传 —— 否则后端分不清
      //   "问过但决定缺失" 与 "作者期间新建的同名项"
      conflicts = r.data.conflicts ?? [];
      decisions = {};
      renderSettingsOutput(out, r.data);
    });

    // 已有草稿时直接显示（关掉软件再回来能接着改）
    void (async () => {
      const r = await invoke('blueprint.getStep', { bookId: bookId(), step: 'SETTINGS' });
      if (r.ok && r.data.status !== 'NOT_STARTED') {
        out.append(el('div', 'hint', `已有草稿（${r.data.status}）。重新生成会覆盖它。`));
      }
    })();

    return c;
  }

  function renderSettingsOutput(out, data) {
    out.replaceChildren();

    const chars = data.characters ?? [];
    const world = data.worldEntities ?? [];
    out.append(el('h3', null, `角色（${chars.length}）`));
    const cl = el('div', 'issue-list');
    for (const p of chars) {
      const row = el('div', 'issue-row');
      row.append(el('span', 'tag tag--info', p.role ?? '角色'));
      row.append(el('span', 'issue-row__msg', p.name));
      const prof = Object.entries(p.profile ?? {})
        .map(([k, v]) => `${k}：${v}`)
        .join('；');
      if (prof) row.append(el('span', 'issue-row__meta', prof));
      cl.append(row);
    }
    if (chars.length === 0) cl.append(el('div', 'empty', '没有角色提议'));
    out.append(cl);

    out.append(el('h3', null, `世界观（${world.length}）`));
    const wl = el('div', 'issue-list');
    for (const w of world) {
      const row = el('div', 'issue-row');
      row.append(el('span', 'tag tag--muted', w.type));
      row.append(el('span', 'issue-row__msg', w.name));
      if (w.description) row.append(el('span', 'issue-row__meta', w.description));
      wl.append(row);
    }
    if (world.length === 0) wl.append(el('div', 'empty', '没有世界观提议'));
    out.append(wl);

    // ── 冲突：逐条问（用户决策原话）──
    if (conflicts.length > 0) {
      out.append(el('h3', null, `⚠ 与已有内容冲突（${conflicts.length} 条，需逐条决定）`));
      out.append(
        el(
          'div',
          'callout callout--warn',
          '这些名字你已经有设定了。AI 的提议不会自动覆盖 —— 每条都要你拍板，' +
            '没决定的会被保守跳过（不覆盖你的内容）。',
        ),
      );
      for (const cf of conflicts) {
        out.append(renderConflict(cf));
      }
    } else {
      out.append(el('div', 'hint', '没有与已有内容重名，可直接应用。'));
    }

    const apply = el('button', 'btn btn--primary', '应用这些设定');
    out.append(apply);
    apply.addEventListener('click', async () => {
      // ⚠ 未决定的冲突**不替作者决定** —— 后端会保守跳过。
      //   这里如实提示有多少条没决定，让作者知道会发生什么
      const undecided = conflicts.filter((cf) => !decisions[keyOf(cf)]).length;
      if (undecided > 0) {
        showMsg(`有 ${undecided} 条冲突还没决定，这些会被跳过（不会覆盖你的内容）。`, 'warn');
      }
      setBusy(apply, true, '应用中…');
      const r = await invoke('blueprint.materializeSettings', {
        bookId: bookId(),
        output: { characters: data.characters, worldEntities: data.worldEntities },
        decisions,
        knownConflicts: conflicts.map(keyOf),
      });
      setBusy(apply, false);
      if (!r.ok) {
        showMsg(`应用失败：${r.error.message}`, 'err');
        return;
      }
      const d = r.data;
      showMsg(
        `已应用：新建角色 ${d.charactersCreated.length}、世界观 ${d.worldCreated.length}；` +
          `跳过 ${d.skipped.length}、改名 ${d.renamed.length}、失效 ${d.vanished.length}。`,
        'ok',
      );
      // ⚠⚠ 新冲突必须报出来（W3 的核心教训）：
      //   作者在向导停留期间自己新建了同名项 → 后端认不出（不在 knownConflicts 里）
      //   → 若不报，作者会以为自己刚建的角色已被 AI 参考
      if ((d.newConflicts ?? []).length > 0) {
        out.append(
          el(
            'div',
            'callout callout--err',
            `⚠ 出现 ${d.newConflicts.length} 条新冲突（你在生成之后新建了同名项）：` +
              `${d.newConflicts.join('、')} —— 这些**没有被写入**，请自行合并。`,
          ),
        );
      }
      await render();
    });
  }

  function renderConflict(cf) {
    const row = el('div', 'card');
    const hd = el('div', 'card__head');
    hd.append(el('span', 'tag tag--warn', cf.kind === 'character' ? '角色' : '世界观'));
    hd.append(el('span', 'card__title', cf.name));
    row.append(hd);

    const g = el('div', 'kv');
    g.append(kv(el, '你已写的', cf.existingSummary || '（空）'));
    g.append(kv(el, 'AI 提议', summarizeProposal(cf)));
    row.append(g);

    const picks = el('div', 'btn-row');
    const buttons = [];
    /** 把"当前选的是哪条"画出来 —— 否则作者不知道哪条拍过板 */
    const paintAll = () => {
      const cur = decisions[keyOf(cf)];
      for (const [value, b] of buttons) {
        b.className = `btn btn--small${cur === value ? ' btn--primary' : ''}`;
      }
    };
    for (const [value, label, hint] of DECISIONS) {
      const b = el('button', 'btn btn--small', label);
      b.title = hint;
      b.addEventListener('click', () => {
        decisions[keyOf(cf)] = value;
        paintAll();
      });
      buttons.push([value, b]);
      picks.append(b);
    }
    paintAll();
    row.append(picks);
    return row;
  }

  // ───────────────────────────────────────────────────────────
  // ③ OUTLINE / ④ DETAIL：生成 → 查看 → 可改
  // ───────────────────────────────────────────────────────────
  function renderOutlinePanel() {
    const c = el('div', 'card');
    c.append(el('div', 'card__title', '③ 卷级大纲'));

    const genBtn = el('button', 'btn btn--primary', '生成卷级大纲');
    c.append(genBtn);

    const out = el('div', 'card__body');
    c.append(out);

    genBtn.addEventListener('click', async () => {
      // ⚠ 重新生成会**整体替换**已有卷（章号范围是全局不变量，
      //   逐卷合并会造出重叠或空洞）。必须让作者知道这件事
      const st = await invoke('blueprint.getStep', { bookId: bookId(), step: 'OUTLINE' });
      if (st.ok && st.data.status !== 'NOT_STARTED') {
        const yes = window.confirm(
          '已有卷级大纲。重新生成会整体替换它（你逐卷改过的内容会丢失）。继续吗？',
        );
        if (!yes) return;
      }
      setBusy(genBtn, true, '生成中…');
      out.replaceChildren(el('div', 'empty', '正在生成…'));
      const r = await invoke('blueprint.generateOutline', { bookId: bookId(), params: {} });
      setBusy(genBtn, false);
      if (!r.ok) {
        out.replaceChildren(el('div', 'callout callout--err', `生成失败：${r.error.message}`));
        return;
      }
      renderVolumes(out, r.data.volumes ?? []);
      await render();
    });

    return c;
  }

  function renderVolumes(out, vols) {
    out.replaceChildren();
    out.append(el('h3', null, `共 ${vols.length} 卷`));
    const tbl = el('table', 'grid');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['卷', '阶段', '章节范围', '核心事件', '起始 → 结束状态']) {
      hr.append(el('th', null, h));
    }
    thead.append(hr);
    tbl.append(thead);

    const tb = el('tbody');
    for (const v of vols) {
      const tr = el('tr');
      tr.append(el('td', null, v.name));
      tr.append(el('td', null, v.stage ?? '—'));
      tr.append(el('td', 'grid__num', `${v.chapterStart}–${v.chapterEnd}`));
      tr.append(el('td', null, v.coreEvent));
      tr.append(el('td', null, `${v.startState ?? '—'} → ${v.endState ?? '—'}`));
      tb.append(tr);
    }
    tbl.append(tb);
    out.append(tbl);
  }

  /**
   * 篇幅目标（每章目标字数 + 允许偏离）。
   *
   * ## ⚠ 为什么必须在向导里也有
   *
   * 用户反馈（2026-09-26）：「还有关于章节字数的设定也没有」。
   *
   * 这个设定原本**只**存在于项目主页（`renderWordTargetForm`）——
   * 而作者走完向导后停在向导里，看不到它，就直接开写了。
   * 于是细纲的 `wordTarget` 回退到 `books.target_words_per_chapter`
   * 的默认值，作者的目标字数从未生效。
   *
   * ⚠ 与项目主页那份**共用同一个 IPC**（`book.setWordTarget`），
   *   不新建通道 —— 两处各写一套迟早分叉。
   *
   * ⚠ 按**书**隔离（多书硬要求）：读写都用当前 `bookId`。
   */
  function renderWordTargetPanel() {
    const c = el('div', 'card');
    c.append(el('div', 'card__title', '篇幅目标（每章字数）'));

    const book = state.books?.find((b) => b.id === bookId());

    const target = el('input', 'input');
    target.type = 'number';
    target.min = '1';
    target.placeholder = '如 2500';
    target.value = book?.targetWordsPerChapter ? String(book.targetWordsPerChapter) : '';

    const tol = el('input', 'input');
    tol.type = 'number';
    tol.min = '0';
    tol.max = '200';
    tol.value = String(book?.wordCountTolerancePct ?? 40);

    const row = el('div', 'btn-row');
    const saveBtn = el('button', 'btn btn--primary', '保存字数设定');
    const clearBtn = el('button', 'btn', '清除');
    row.append(saveBtn, clearBtn);

    const line = el('div', 'form-msg');

    c.append(
      el('div', 'form-label', '每章目标字数'),
      target,
      el('div', 'form-label', '允许偏离（%）'),
      tol,
      row,
      line,
      el('div', 'hint', '字数只做提示，不阻断提交 —— 硬卡字数会让模型为凑数注水。'),
    );

    async function save(words) {
      setBusy(saveBtn, true, '保存中…');
      const r = await invoke('book.setWordTarget', {
        bookId: bookId(),
        targetWords: words,
        tolerancePct: Number(tol.value) || 0,
      });
      setBusy(saveBtn, false);
      if (!r.ok) {
        line.className = 'form-msg form-msg--err';
        line.textContent = `${r.error.code}：${r.error.message}`;
        return;
      }
      line.className = 'form-msg form-msg--ok';
      line.textContent = words === null ? '已清除字数设定' : `已保存：每章 ${words} 字`;
    }

    saveBtn.addEventListener('click', () => {
      const n = Number(target.value);
      if (!Number.isInteger(n) || n < 1) {
        line.className = 'form-msg form-msg--err';
        line.textContent = '目标字数必须是 ≥1 的整数';
        return;
      }
      void save(n);
    });

    clearBtn.addEventListener('click', () => {
      target.value = '';
      void save(null);
    });

    return c;
  }

  function renderDetailPanel() {
    const c = el('div', 'card');
    c.append(el('div', 'card__title', '④ 逐章细纲'));

    // ⚠ 分批生成（对齐 oh-story 的铁律「不强行一次产出 30 章细纲」）：
    //   一次全出会超时/被截断，且模型后面的章会明显变水
    const range = el('div', 'btn-row');
    const from = numInput(el, '从第几章', 1);
    const to = numInput(el, '到第几章', 10);
    range.append(from.wrap, to.wrap);
    c.append(range);
    c.append(
      el('div', 'hint', '建议一次 5–15 章。按章保存，分批不会互相覆盖。'),
    );

    const genBtn = el('button', 'btn btn--primary', '生成这一段细纲');
    c.append(genBtn);

    const out = el('div', 'card__body');
    c.append(out);

    genBtn.addEventListener('click', async () => {
      const a = Number(from.input.value);
      const b = Number(to.input.value);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a) {
        showMsg('章节范围不合法：起始必须 ≥1 且不大于结束。', 'err');
        return;
      }
      if (b - a + 1 > 30) {
        showMsg(`一次 ${b - a + 1} 章太多了，建议不超过 30 章（模型会变水）。`, 'warn');
      }
      setBusy(genBtn, true, '生成中…');
      out.replaceChildren(el('div', 'empty', `正在生成第 ${a}–${b} 章…`));
      const r = await invoke('blueprint.generateChapterOutlines', {
        bookId: bookId(),
        startChapter: a,
        endChapter: b,
        params: {},
      });
      setBusy(genBtn, false);
      if (!r.ok) {
        out.replaceChildren(el('div', 'callout callout--err', `生成失败：${r.error.message}`));
        return;
      }
      out.replaceChildren();
      out.append(
        el(
          'div',
          'hint',
          `本次新建 ${r.data.created} 章、更新 ${r.data.updated} 章（按章保存）。`,
        ),
      );
      const list = el('div', 'issue-list');
      for (const o of r.data.outlines ?? []) {
        const row = el('div', 'issue-row');
        row.append(el('span', 'tag tag--muted', `第 ${o.chapterNumber} 章`));
        row.append(el('span', 'issue-row__msg', o.coreEvent));
        row.append(el('span', 'issue-row__meta', `情绪：${o.targetEmotion}`));
        list.append(row);
      }
      out.append(list);
      await render();
    });

    return c;
  }

  // ───────────────────────────────────────────────────────────
  // 修改（作者编辑某一步，不覆盖 AI 原稿）
  // ───────────────────────────────────────────────────────────
  function renderEditPanel(d) {
    const c = el('div', 'card');
    c.append(el('div', 'card__title', '修改内容'));

    const sel = el('select', 'input');
    for (const st of d.steps) {
      const o = el('option', null, `${st.label}（${st.status}）`);
      o.value = st.step;
      sel.append(o);
    }
    if (editing) sel.value = editing;
    c.append(sel);

    const area = el('textarea', 'input');
    area.rows = 10;
    area.placeholder = '读取中…';
    c.append(area);
    c.append(
      el(
        'div',
        'hint',
        '编辑内容单独保存（标为「已编辑」），不会覆盖 AI 原稿 —— 重新生成时你改过的还在。',
      ),
    );

    async function loadStep() {
      const step = sel.value;
      editing = step;
      area.value = '';
      area.placeholder = '读取中…';
      const r = await invoke('blueprint.getStep', { bookId: bookId(), step });
      if (!r.ok) {
        area.placeholder = `读取失败：${r.error.message}`;
        return;
      }
      if (r.data.content === null || r.data.content === undefined) {
        area.placeholder = '这一步还没有内容（先生成，或直接在这里手写）。';
        return;
      }
      area.value = JSON.stringify(r.data.content, null, 2);
      area.placeholder = '';
    }

    sel.addEventListener('change', () => void loadStep());

    const save = el('button', 'btn btn--primary', '保存修改');
    save.addEventListener('click', async () => {
      const text = area.value.trim();
      if (!text) {
        showMsg('内容为空，没有可保存的东西。', 'err');
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        // ⚠ 结构化数据用 JSON 编辑是刻意的取舍：四步的形状各不相同，
        //   给每一步做专用表单的工作量远超收益。但**必须把错误说清楚**，
        //   不能让作者面对一个"保存失败"却不知道哪一行坏了
        showMsg(`JSON 格式不对：${e.message}`, 'err');
        return;
      }
      setBusy(save, true, '保存中…');
      const r = await invoke('blueprint.saveStep', {
        bookId: bookId(),
        step: sel.value,
        content: parsed,
      });
      setBusy(save, false);
      if (!r.ok) {
        showMsg(`保存失败：${r.error.message}`, 'err');
        return;
      }
      showMsg('已保存（标为「已编辑」，AI 原稿仍在）。', 'ok');
      await render();
    });
    c.append(save);

    void loadStep();
    return c;
  }

  // ───────────────────────────────────────────────────────────
  // 统一确认
  // ───────────────────────────────────────────────────────────
  function renderConfirmPanel(d) {
    const c = el('div', 'card');
    c.append(el('div', 'card__title', '统一确认'));

    if (!d.gateEnabled) {
      c.append(
        el(
          'div',
          'callout',
          '门禁未启用 —— 确认与否都不影响开写。启用门禁后，"未确认"才会真正拦住写作。',
        ),
      );
    }

    // ⚠ 如实说明这次确认**同时**落实两道门禁（用户决策 2026-09-26）。
    //   不写清楚的话，作者在别处看到「设定未确认」会以为是另一件事没做完，
    //   而实际这次确认已经把它一起确认了 —— 那会让他重复找一个不存在的步骤。
    c.append(
      el(
        'div',
        'hint',
        '点「确认全部前置信息」会同时确认两件事：① 向导四步（选题/设定/卷纲/细纲）；' +
          '② 世界观设定（步骤②生成的那些条目）。' +
          '两道门禁都通过后，下面会出现「开始写第 1 章」。',
      ),
    );

    const btnRow = el('div', 'btn-row');

    const gateBtn = el('button', 'btn', d.gateEnabled ? '关闭门禁' : '启用门禁');
    gateBtn.addEventListener('click', async () => {
      setBusy(gateBtn, true, '切换中…');
      const r = await invoke('blueprint.setGate', {
        bookId: bookId(),
        enabled: !d.gateEnabled,
      });
      setBusy(gateBtn, false);
      if (!r.ok) {
        showMsg(`切换失败：${r.error.message}`, 'err');
        return;
      }
      await render();
    });
    btnRow.append(gateBtn);

    if (d.confirmedAt) {
      const revoke = el('button', 'btn btn--danger-soft', '撤回确认');
      revoke.addEventListener('click', async () => {
        setBusy(revoke, true, '撤回中…');
        const r = await invoke('blueprint.revokeConfirm', { bookId: bookId() });
        setBusy(revoke, false);
        if (!r.ok) {
          showMsg(`撤回失败：${r.error.message}`, 'err');
          return;
        }
        showMsg('已撤回统一确认。改动前置内容后需要重新确认。', 'ok');
        await render();
      });
      btnRow.append(revoke);
    } else {
      const confirm = el('button', 'btn btn--primary', '确认全部前置信息');
      confirm.addEventListener('click', async () => {
        // ⚠ 未开始的步骤不能静默跳过 —— 那会让"确认"变成一句空话。
        //   但用户选了"允许跳过"，所以这里问一句而不是直接拦
        const notStarted = d.steps.filter((s) => s.status === 'NOT_STARTED');
        if (notStarted.length > 0) {
          const names = notStarted.map((s) => s.label).join('、');
          const yes = window.confirm(
            `${names} 还没有内容。确认后门禁会认为前置已就绪，这些步骤仍是空的。继续吗？`,
          );
          if (!yes) return;
        }
        setBusy(confirm, true, '确认中…');
        const r = await invoke('blueprint.confirmAll', { bookId: bookId() });
        setBusy(confirm, false);
        if (!r.ok) {
          showMsg(`确认失败：${r.error.message}`, 'err');
          return;
        }
        showMsg(
          `已确认 ${r.data.steps} 个步骤，指纹 ${String(r.data.hash).slice(0, 12)}…` +
            (r.data.settings ? `｜同时确认了 ${r.data.settings.count} 条世界观设定` : ''),
          'ok',
        );
        await render();
      });
      btnRow.append(confirm);
    }

    c.append(btnRow);

    // ── 开始写第 1 章（确认后才出现）─────────────────────────
    //
    // ⚠ 用户决策（2026-09-26）：
    //   > 「开书向导完成后应该直接创建一本新书籍，并且可以开始生成第一章，
    //   >    至少得有个按钮吧」
    //
    // 确认之前**不显示**这个按钮：没确认就开写必然被门禁拦死，
    // 让作者点一个注定失败的按钮比不给他按钮更糟。
    if (d.confirmedAt) {
      c.append(renderStartWriting());
    }

    return c;
  }

  /**
   * 「开始写第 1 章」—— 从向导直接启动整章工作流。
   *
   * ## 为什么这里要重复一遍门禁判定
   *
   * `d.confirmedAt` 只说明**向导**确认过了。开写实际要过**两道**门禁，
   * 而另一道（世界观设定）可能在确认之后被改动 —— 那时哈希失配，
   * 开写仍会被拦。
   *
   * 所以这里主动查一次 `settings.status`：不通过就**明说哪一道没过**，
   * 而不是让作者点了按钮、等了十几秒、再收到一个后端报错。
   */
  function renderStartWriting() {
    const box = el('div', 'start-writing');

    // 是否已经写过：有章节就不再叫"第 1 章"
    const hasChapters = (state.chapters?.length ?? 0) > 0;
    const nextNo = hasChapters ? Math.max(...state.chapters.map((c) => c.chapterNumber)) + 1 : 1;

    const title = el('div', 'card__title', '开始写作');
    box.append(title);

    const hint = el('div', 'hint', '前置信息已确认，可以直接开写。');
    box.append(hint);

    const btn = el(
      'button',
      'btn btn--primary btn--lg',
      hasChapters ? `开始写第 ${nextNo} 章` : '开始写第 1 章',
    );
    const line = el('div', 'form-msg');
    box.append(btn, line);

    // ⚠ 按钮先禁用，等门禁查询回来再决定 —— 若查询期间作者点了，
    //   会绕过下面这道检查（虽然后端还会拦，但那样作者看到的是
    //   "工作流 FAILED"，而不是"设定没确认"这个可操作的原因）
    btn.disabled = true;

    void (async () => {
      const r = await invoke('settings.status', { bookId: bookId() });
      if (!r.ok) {
        line.className = 'form-msg form-msg--err';
        line.textContent = `无法确认设定门禁状态：${r.error.message}`;
        return; // 保持禁用：状态不明时不开写
      }
      if (!r.data.allowed) {
        line.className = 'form-msg form-msg--err';
        line.textContent =
          `还差一道门禁：${r.data.message}` +
          '（世界观设定在确认之后又被改动过。请在项目主页的「世界观设定」卡片里重新确认。）';
        return;
      }
      btn.disabled = false;
      line.className = 'form-msg form-msg--ok';
      line.textContent = `设定门禁已通过（${r.data.entryCount} 条设定）`;
    })();

    btn.addEventListener('click', async () => {
      setBusy(btn, true, '正在启动…');
      line.className = 'form-msg';
      line.textContent = '正在启动工作流…';

      // ⚠ 章号交给工作流自己决定（create_chapter 会建下一章）——
      //   与运行面板同一约定，避免 UI 与工作流各算一套"下一章是几"。
      const r = await invoke('workflow.start', { bookId: bookId() });
      setBusy(btn, false);
      if (!r.ok) {
        line.className = 'form-msg form-msg--err';
        line.textContent = `${r.error?.code}：${r.error?.message ?? ''}`;
        return;
      }
      line.className = 'form-msg form-msg--ok';
      line.textContent =
        `已启动：${r.data?.workflowId}｜写完整章需数分钟，` +
        '进度在右栏「写作流程」里看，可随时暂停。';
      // 刷新一次，让左栏章节列表跟着更新
      await render();
    });

    return box;
  }

  // ───────────────────────────────────────────────────────────
  // 主渲染
  // ───────────────────────────────────────────────────────────
  async function render() {
    msg.textContent = '';
    body.replaceChildren(el('div', 'empty', '正在读取…'));

    const d = await loadStatus();
    if (!d) return;

    // ⚠ 分块 append 并逐块记名：中途抛错时后面的面板会**整块缺失**，
    //   而界面上只表现为"某个按钮找不到" —— 不知道是从哪一块断的。
    //   记下最后成功的面板名，错误信息才有排查价值。
    const parts = [
      ['门禁', () => renderGate(d)],
      ['步骤条', () => renderSteps(d)],
      ['① 选题方向', () => renderConceptPanel()],
      ['② 核心设定', () => renderSettingsPanel()],
      ['③ 卷级大纲', () => renderOutlinePanel()],
      ['④ 逐章细纲', () => renderDetailPanel()],
      // ⚠ 篇幅目标排在细纲**之后、统一确认之前**：
      //   细纲的 `wordTarget` 就是按这个设定算的，作者该在看到细纲后、
      //   确认前调整它。放最前面会被当成"还没轮到"而跳过。
      ['篇幅目标', () => renderWordTargetPanel()],
      ['修改面板', () => renderEditPanel(d)],
      ['统一确认', () => renderConfirmPanel(d)],
    ];
    body.replaceChildren();
    const done = [];
    for (const [name, make] of parts) {
      try {
        body.append(make());
        done.push(name);
      } catch (e) {
        window.__wizardError = `面板「${name}」渲染失败：${e?.message ?? e}` +
          `（已完成：${done.join('、') || '无'}）`;
        body.append(el('div', 'callout callout--err', window.__wizardError));
        return;
      }
    }
    window.__wizardError = null;
  }

  refresh.addEventListener('click', () => void render());
  void render();
  return box;
}

// ── 小工具 ────────────────────────────────────────────────────

function kv(el, k, v) {
  const row = el('div', 'kv-row');
  row.append(el('span', 'kv-k', k));
  row.append(el('span', 'kv-v', v));
  return row;
}

/** 冲突的键：与后端一致（去空白） */
function keyOf(cf) {
  return String(cf.name ?? '').replace(/\s+/g, '').trim();
}

function summarizeProposal(cf) {
  const p = cf.proposal ?? {};
  if (cf.kind === 'character') {
    const prof = Object.entries(p.profile ?? {})
      .map(([k, v]) => `${k}：${v}`)
      .join('；');
    return [p.role, prof].filter(Boolean).join(' / ') || '（无描述）';
  }
  return p.description ?? '（无描述）';
}

/**
 * ⚠ `el` 必须**从闭包传进来**：它是 renderBlueprintWizard 的注入参数，
 *   不是模块级函数。写成模块级函数直接引用 el 会在运行时报
 *   "el is not defined" —— 而且是在渲染到那一块时才炸，
 *   表现为"后面的面板整块缺失"（实测踩到）。
 */
function numInput(el, label, def) {
  const wrap = el('label', 'corpus-field-row');
  wrap.append(el('span', 'kv-k', label));
  const input = el('input', 'input');
  input.type = 'number';
  input.min = '1';
  input.value = String(def);
  wrap.append(input);
  return { wrap, input };
}

function setBusy(btn, busy, busyText) {
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.textContent = busyText;
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.label ?? btn.textContent;
    btn.disabled = false;
  }
}


