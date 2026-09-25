/**
 * §41 导航「时间线」入口（施工文档 §42 页面清单里的独立页）。
 *
 * ## ⚠ 为什么单独一个文件
 *
 * 时间线与伏笔都是**只读或半只读的账目视图**，与"写作流程"面板
 * （按钮驱动、会改状态）的关注点不同。混在一起会让"看账"和"干活"
 * 挤在同一个文件里，改一处碰另一处。
 *
 * ## 数据来源
 *
 * `timeline.query` IPC —— 它一直存在，但 renderer **0 处调用**
 * （实测确认），所以后端建好的时间线在界面上完全够不到。
 *
 * ## ⚠ 必须显示"不可比较"的数量
 *
 * 后端 `timeline.query` 明确单独报 `comparableCount`：事件里可能有一批
 * 没有明确时间锚点（`dayUnknown`），它们**不参与顺序检查**。
 * 只显示"共 N 个事件"会让人以为顺序全查过了 —— 而实际可能一个都没查。
 */

/** 六态机里时间线没有状态，但严重级别要能一眼分辨 */
const SEV_CLASS = { BLOCKING: 'err', WARNING: 'warn', INFO: 'info' };

export function renderTimelineView({ el, invoke, state }) {
  const box = el('div', 'view');

  const head = el('div', 'view__head');
  head.append(el('h2', null, '时间线'));
  const refresh = el('button', 'btn', '刷新');
  head.append(refresh);
  box.append(head);

  const body = el('div', 'view__body');
  box.append(body);

  async function load() {
    body.replaceChildren(el('div', 'empty', '正在读取…'));

    // ⚠ 显式传 bookId：多书隔离要求当前书明确，不靠后端回退
    const r = await invoke('timeline.query', { bookId: state.selectedBookId });
    body.replaceChildren();

    if (!r.ok) {
      // ⚠ 读不到就说读不到，不显示"暂无事件" ——
      //   那会让人以为这本书真的没有时间线事件
      body.append(el('div', 'callout callout--err', `读取失败：${r.error.message}`));
      return;
    }

    const d = r.data;

    // ── 概览：⚠ 必须区分"事件数"与"可比较数" ──
    const sum = el('div', 'kv');
    sum.append(kv(el, '事件总数', String(d.count)));
    sum.append(
      kv(
        el,
        '可比较（参与顺序检查）',
        d.comparableCount === null ? '未检查' : String(d.comparableCount),
      ),
    );
    sum.append(kv(el, '阻塞问题', String(d.blockingCount)));
    sum.append(kv(el, '警告', String(d.warningCount)));
    body.append(sum);

    if (d.comparableCount !== null && d.comparableCount < d.count) {
      body.append(
        el(
          'div',
          'callout',
          `⚠ ${d.count - d.comparableCount} 个事件没有明确时间锚点，**未参与**顺序检查。` +
            '所以"没有问题"不等于"顺序都对"。',
        ),
      );
    }

    // ── 问题列表 ──
    if ((d.issues ?? []).length > 0) {
      body.append(el('h3', null, `检查结果（${d.issues.length}）`));
      const list = el('div', 'issue-list');
      for (const it of d.issues) {
        const row = el('div', 'issue-row');
        row.append(el('span', `tag tag--${SEV_CLASS[it.severity] ?? 'info'}`, it.severity));
        row.append(el('span', 'issue-row__msg', it.message));
        if ((it.chapters ?? []).length > 0) {
          row.append(el('span', 'issue-row__meta', `第 ${it.chapters.join(' / ')} 章`));
        }
        list.append(row);
      }
      body.append(list);
    }

    // ── 限制说明（后端如实报告的能力边界）──
    if ((d.limitations ?? []).length > 0) {
      const lim = el('div', 'callout');
      lim.append(el('div', null, '检查能力的边界：'));
      for (const l of d.limitations) lim.append(el('div', 'perm-line', `· ${l}`));
      body.append(lim);
    }

    // ── 事件列表 ──
    body.append(el('h3', null, `事件（${(d.events ?? []).length}）`));
    if ((d.events ?? []).length === 0) {
      // ⚠ 区分"真的没有"与"读不到"：这里已经确认读取成功，所以是前者
      body.append(el('div', 'empty', '这本书还没有时间线事件。'));
      return;
    }

    const tbl = el('table', 'grid');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['章', '标题', '故事时间', '人物', '地点', '叙述方式']) {
      hr.append(el('th', null, h));
    }
    thead.append(hr);
    tbl.append(thead);

    const tb = el('tbody');
    for (const e of d.events) {
      const tr = el('tr');
      tr.append(el('td', 'grid__num', String(e.chapter)));
      tr.append(el('td', null, e.title ?? '—'));
      // ⚠ dayUnknown 的事件明确标出 —— 它是"不可比较"的来源
      tr.append(
        el(
          'td',
          e.dayUnknown ? 'grid__warn' : null,
          e.dayUnknown ? `${e.storyDisplay ?? '?'}（无明确日锚点）` : (e.storyDisplay ?? '—'),
        ),
      );
      tr.append(el('td', null, (e.characters ?? []).join('、') || '—'));
      tr.append(el('td', null, e.location ?? '—'));
      tr.append(el('td', null, e.narrativeMode ?? '—'));
      tb.append(tr);
    }
    tbl.append(tb);
    body.append(tbl);
  }

  refresh.addEventListener('click', () => void load());
  void load();
  return box;
}

function kv(el, k, v) {
  const row = el('div', 'kv-row');
  row.append(el('span', 'kv-k', k));
  row.append(el('span', 'kv-v', v));
  return row;
}
