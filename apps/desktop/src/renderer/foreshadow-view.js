/**
 * §41 导航「伏笔」入口（施工文档 §42 页面清单里的独立页）。
 *
 * ## ⚠ 这是伏笔在 UI 上的**第一个**入口
 *
 * 此前 `ForeshadowingRepository` 与六态机都在，但**没有任何 IPC**
 * —— 后端建好了、界面够不到。与 `character.create`（存储层完整、
 * 工具缺失）、`detectProseIssues`（写了没接线）是同一类缺陷。
 *
 * ## ⚠ 只显示"当前合法的下一步"，不显示全部状态
 *
 * 六态机的合法迁移是**有向且不可逆**的（PAID_OFF / ABANDONED 是终态）。
 * 若把六个状态都做成下拉框，用户会以为自己能随便改 —— 然后被后端
 * 拒绝，却不知道为什么。所以按钮只列合法目标，终态明确写"已是终态"。
 */

/** 六态 → 中文标签。⚠ 与仓储的 LEGAL_TRANSITIONS 同源语义，不是另一套状态 */
const STATUS_LABEL = {
  PLANNED: '已规划',
  PLANTED: '已埋设',
  DEVELOPING: '发展中',
  READY: '待回收',
  PAID_OFF: '已回收',
  ABANDONED: '已废弃',
};

/**
 * 合法迁移 —— ⚠ 这是对仓储 `LEGAL_TRANSITIONS` 的**展示用镜像**。
 *
 * 它只用来决定"显示哪些按钮"，**不做校验**：真正的判断在后端，
 * 前端算错最多是多显示一个按钮（点了会被明确拒绝），
 * 而不是让非法迁移通过。所以镜像不构成"两套状态机"。
 */
const NEXT = {
  PLANNED: ['PLANTED', 'ABANDONED'],
  PLANTED: ['DEVELOPING', 'READY', 'ABANDONED'],
  DEVELOPING: ['READY', 'PAID_OFF', 'ABANDONED'],
  READY: ['PAID_OFF', 'ABANDONED'],
  PAID_OFF: [],
  ABANDONED: [],
};

/** 状态色：终态用中性，进行中用强调，废弃用弱化 */
const STATUS_CLASS = {
  PLANNED: 'muted',
  PLANTED: 'info',
  DEVELOPING: 'info',
  READY: 'warn',
  PAID_OFF: 'ok',
  ABANDONED: 'muted',
};

const TIER_LABEL = { CORE: '核心', SIDE: '支线', DECOR: '点缀' };

export function renderForeshadowView({ el, invoke, state, msg }) {
  const box = el('div', 'view');

  const head = el('div', 'view__head');
  head.append(el('h2', null, '伏笔'));
  const refresh = el('button', 'btn', '刷新');
  head.append(refresh);
  box.append(head);

  const status = msg ?? el('div', 'form-msg');
  box.append(status);

  const body = el('div', 'view__body');
  box.append(body);

  async function advance(item, to) {
    status.className = 'form-msg';
    status.textContent = `正在把「${item.name}」推进到${STATUS_LABEL[to]}…`;
    const r = await invoke('foreshadow.advance', { foreshadowId: item.id, to });
    if (!r.ok) {
      // ⚠ 非法迁移的错误必须原样显示：它带合法目标列表，
      //   是用户唯一能知道"为什么不能这么改"的地方
      status.className = 'form-msg form-msg--err';
      status.textContent = r.error.message;
      return;
    }
    status.textContent = `「${r.data.name}」已推进到${STATUS_LABEL[r.data.status]}`;
    await load();
  }

  async function load() {
    body.replaceChildren(el('div', 'empty', '正在读取…'));

    const r = await invoke('foreshadow.list', { bookId: state.selectedBookId });
    body.replaceChildren();

    if (!r.ok) {
      body.append(el('div', 'callout callout--err', `读取失败：${r.error.message}`));
      return;
    }

    const items = r.data.items ?? [];
    if (items.length === 0) {
      body.append(
        el(
          'div',
          'empty',
          '这本书还没有伏笔记录。伏笔由状态结算从正文中抽取，' +
            '也可以在此查看已抽取的结果。',
        ),
      );
      return;
    }

    // ── 概览：按状态计数 ──
    const sum = el('div', 'kv');
    const byStatus = {};
    for (const it of items) byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;
    for (const [k, label] of Object.entries(STATUS_LABEL)) {
      if (byStatus[k]) sum.append(kvRow(el, label, String(byStatus[k])));
    }
    sum.append(kvRow(el, '总计', String(items.length)));
    body.append(sum);

    // ⚠ 待回收的伏笔单独提示：这是长篇里最容易"埋了忘了收"的东西
    const ready = items.filter((x) => x.status === 'READY');
    if (ready.length > 0) {
      body.append(
        el(
          'div',
          'callout callout--warn',
          `⚠ ${ready.length} 条伏笔处于「待回收」：${ready.map((x) => x.name).join('、')}`,
        ),
      );
    }

    // ── 明细 ──
    for (const it of items) {
      const card = el('div', 'card');
      const top = el('div', 'card__head');
      top.append(el('span', 'card__title', it.name));
      top.append(
        el('span', `tag tag--${STATUS_CLASS[it.status] ?? 'muted'}`, STATUS_LABEL[it.status] ?? it.status),
      );
      top.append(el('span', 'tag', TIER_LABEL[it.tier] ?? it.tier));
      if (it.importance > 1) top.append(el('span', 'tag', `重要度 ${it.importance}`));
      card.append(top);

      const meta = el('div', 'kv');
      meta.append(kvRow(el, '埋设章', it.setupChapter === null ? '—' : `第 ${it.setupChapter} 章`));
      meta.append(
        kvRow(
          el,
          '预期回收章',
          it.expectedPayoffChapter === null ? '—' : `第 ${it.expectedPayoffChapter} 章`,
        ),
      );
      if (it.description) meta.append(kvRow(el, '说明', it.description));
      card.append(meta);

      // ── 推进按钮：只列合法目标 ──
      const allowed = NEXT[it.status] ?? [];
      const bar = el('div', 'btn-row');
      if (allowed.length === 0) {
        bar.append(el('span', 'model-status', '已是终态，不可再推进'));
      } else {
        for (const to of allowed) {
          // ⚠ 废弃是**不可逆**的（终态），视觉上必须与普通推进区分
          const cls = to === 'ABANDONED' ? 'btn btn--danger-soft' : 'btn';
          const b = el('button', cls, `→ ${STATUS_LABEL[to]}`);
          b.addEventListener('click', () => void advance(it, to));
          bar.append(b);
        }
      }
      card.append(bar);
      body.append(card);
    }
  }

  refresh.addEventListener('click', () => void load());
  void load();
  return box;
}

function kvRow(el, k, v) {
  const row = el('div', 'kv-row');
  row.append(el('span', 'kv-k', k));
  row.append(el('span', 'kv-v', v));
  return row;
}
