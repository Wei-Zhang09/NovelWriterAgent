/**
 * M7 Diff 视图 —— 把 `diff.js` 的纯函数结果画出来（§十六 / §十七 / §三十七）。
 *
 * ## ⚠ 为什么单独一个文件
 *
 * 算法（`diff.js`）是纯函数、可穷举测试；渲染是 DOM 操作、只能靠 GUI 验证。
 * 两者关注点不同，混在一起会让"改算法"和"改样式"互相牵动。
 *
 * ## ⚠ 左右双栏而不是内联标记
 *
 * 内联标记（在正文里直接插 `<del>`/`<ins>`）读起来像"改错了的稿子"，
 * 而作者要看的是"**我这一版相对上一版动了哪些地方**"。
 * 双栏对照是版本对比的通行形态，且新增/删除的段落能各归其位。
 *
 * ## ⚠ 只对 modify 段做词级染色
 *
 * `diffParagraphs` 已经保证 equal 段的 `words` 为 null（字符级 LCS 不便宜）。
 * 这里不再自作主张补算 —— 补算等于把代价又加回来。
 */

import { diffParagraphs, summarizeHunks } from './diff.js';

const KIND_LABEL = {
  equal: '未改',
  insert: '新增',
  delete: '删除',
  modify: '改写',
};

const KIND_CLASS = {
  equal: '',
  insert: 'diff__para--insert',
  delete: 'diff__para--delete',
  modify: 'diff__para--modify',
};

/**
 * 渲染 Diff 面板。
 *
 * @param {object} ctx
 * @param {Function} ctx.el      元素构造器（闭包注入，见 blueprint-wizard 的教训）
 * @param {Function} ctx.invoke  IPC 调用
 * @param {object}   ctx.chapter 当前章节（需要 chapter.id）
 * @param {Function} ctx.msg     状态行工厂
 */
export function renderDiffPanel({ el, invoke, chapter, msg }) {
  const box = el('div', 'card diff');

  const head = el('div', 'card__head');
  head.append(el('span', 'card__title', '版本对比（Diff）'));
  box.append(head);

  const statusLine = msg();
  box.append(statusLine);

  // ── 选择两侧要比什么 ──
  const pick = el('div', 'btn-row');
  const fromSel = el('select', 'input');
  const toSel = el('select', 'input');
  fromSel.append(option(el, 'current', '当前正文'));
  toSel.append(option(el, 'current', '当前正文'));
  const fromWrap = el('label', 'corpus-field-row');
  fromWrap.append(el('span', 'kv-k', '对比基准'), fromSel);
  const toWrap = el('label', 'corpus-field-row');
  toWrap.append(el('span', 'kv-k', '对比目标'), toSel);
  pick.append(fromWrap, toWrap);
  box.append(pick);

  const goBtn = el('button', 'btn btn--primary', '对比');
  const btnRow = el('div', 'btn-row');
  btnRow.append(goBtn);
  box.append(btnRow);

  const out = el('div', 'diff__body');
  box.append(out);

  /** 版本列表（供下拉填充） */
  let versions = [];

  async function loadVersions() {
    const r = await invoke('manuscript.listVersions', { chapterId: chapter.id });
    if (!r.ok) {
      statusLine.textContent = `版本列表读取失败：${r.error.message}`;
      statusLine.className = 'form-msg form-msg--err';
      return;
    }
    versions = r.data.versions ?? [];
    for (const sel of [fromSel, toSel]) {
      // 清掉除 'current' 之外的旧选项，避免重复刷新后堆积
      for (const o of [...sel.options]) {
        if (o.value !== 'current') o.remove();
      }
      for (const v of versions) {
        // ⚠ 显示 seq 与来源、时间 —— 只显示 seq 作者不知道那是哪一次
        sel.append(
          option(
            el,
            v.id,
            `v${String(v.seq).padStart(3, '0')} · ${v.sourceType} · ${fmtTime(v.createdAt)}`,
          ),
        );
      }
    }
    // ⚠⚠ 默认对比**上一版**，不是最新版。
    //
    //   最新版是"最近一次保存"建出来的，内容**必然等于当前正文**
    //   （除非作者之后又改了没保存）。拿它当基准，默认结果永远是
    //   "完全一致" —— 面板看着像坏的，而作者想看的是"我刚改了什么"。
    //
    //   所以取第二新的那一版（即最近一次保存**之前**的状态）。
    //   只有一版时退回它自己（此时确实只能比这一版）。
    if (versions.length > 0) {
      fromSel.value = (versions[1] ?? versions[0]).id;
    }
  }

  async function run() {
    statusLine.textContent = '正在对比…';
    statusLine.className = 'form-msg';
    out.replaceChildren();

    const r = await invoke('manuscript.getDiff', {
      chapterId: chapter.id,
      from: fromSel.value,
      to: toSel.value,
    });
    if (!r.ok) {
      statusLine.textContent = `对比失败：${r.error.message}`;
      statusLine.className = 'form-msg form-msg--err';
      return;
    }

    // ⚠ 文件缺失必须明说 —— 当成空文本会显示成"整个版本被删光了"，
    //   而实际是文件不在了。两者对作者的含义完全不同
    if (!r.data.usable) {
      const which = [r.data.from.missing ? '基准' : null, r.data.to.missing ? '目标' : null]
        .filter(Boolean)
        .join('、');
      out.append(
        el(
          'div',
          'callout callout--err',
          `${which}版本的正文文件缺失（可能被人工清理）。无法对比 —— ` +
            '这里显示的不是"内容被删光了"，而是"文件不在了"。',
        ),
      );
      statusLine.textContent = '';
      return;
    }

    const hunks = diffParagraphs(r.data.from.text ?? '', r.data.to.text ?? '');
    const sum = summarizeHunks(hunks);

    statusLine.textContent =
      sum.changed === 0
        ? '两边内容完全一致。'
        : `共 ${sum.total} 段，其中改动 ${sum.changed} 段（改写 ${sum.modify} / 新增 ${sum.insert} / 删除 ${sum.delete}）。`;
    statusLine.className = sum.changed === 0 ? 'form-msg form-msg--ok' : 'form-msg';

    if (sum.changed === 0) return;

    // ⚠ 默认只显示改动段：一部长章有几百段，全列出来作者要滚很久
    //   才能找到真正变了的那几段 —— 那就失去 Diff 的意义了
    const onlyChanged = el('label', 'corpus-field-row');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = true;
    onlyChanged.append(cb, el('span', 'kv-k', '只看改动段'));
    out.append(onlyChanged);

    const list = el('div', 'diff__list');
    const paint = () => {
      list.replaceChildren();
      const shown = cb.checked ? hunks.filter((h) => h.kind !== 'equal') : hunks;
      if (shown.length === 0) {
        list.append(el('div', 'empty', '没有改动段。'));
        return;
      }
      for (const h of shown) list.append(renderHunk(el, h));
    };
    cb.addEventListener('change', paint);
    paint();
    out.append(list);
  }

  goBtn.addEventListener('click', () => void run());

  void (async () => {
    await loadVersions();
    await run();
  })();

  return box;
}

/** 一段的左右对照 */
function renderHunk(el, h) {
  const row = el('div', `diff__para ${KIND_CLASS[h.kind] ?? ''}`);

  const tag = el('div', 'diff__tag');
  tag.append(el('span', `tag tag--${h.kind === 'equal' ? 'muted' : 'warn'}`, KIND_LABEL[h.kind] ?? h.kind));
  // ⚠ 两侧段号分开显示：插入段没有旧段号、删除段没有新段号。
  //   显示成同一个数字会让作者以为"第 5 段对第 5 段"，
  //   而实际那一段在另一侧根本不存在
  tag.append(
    el('span', 'diff__idx', `旧 ${h.oldIndex === null ? '—' : h.oldIndex + 1} / 新 ${h.newIndex === null ? '—' : h.newIndex + 1}`),
  );
  row.append(tag);

  const cols = el('div', 'diff__cols');
  cols.append(renderSide(el, h, 'left'));
  cols.append(renderSide(el, h, 'right'));
  row.append(cols);
  return row;
}

function renderSide(el, h, side) {
  const col = el('div', 'diff__col');
  const isLeft = side === 'left';
  const text = isLeft ? h.oldText : h.newText;
  const words = h.words;

  if (text === null || text === undefined) {
    // ⚠ 该侧没有对应段落（新增段在旧侧、删除段在新侧）——
    //   留一个明确的空位标记，而不是空白。空白会让作者以为渲染漏了
    col.append(el('div', 'diff__absent', isLeft ? '（旧版没有这一段）' : '（新版没有这一段）'));
    return col;
  }

  // 有词级结果且确实是改写段 → 按片段染色
  if (words && (h.kind === 'modify' || h.kind === 'equal')) {
    const segs = isLeft ? words.left : words.right;
    if (segs.length === 0) {
      col.append(el('div', 'diff__text', text));
      return col;
    }
    const p = el('div', 'diff__text');
    for (const s of segs) {
      if (s.changed) {
        // ⚠ 用 <mark> 而不是只加 class：<mark> 自带语义（屏幕阅读器会
        //   读作"标记"），且浏览器默认高亮在没加载 CSS 时也能看见
        const m = el('mark', 'diff__hl', s.text);
        p.append(m);
      } else {
        p.append(document.createTextNode(s.text));
      }
    }
    col.append(p);
    return col;
  }

  col.append(el('div', 'diff__text', text));
  return col;
}

function option(el, value, label) {
  const o = el('option', null, label);
  o.value = value;
  return o;
}

function fmtTime(iso) {
  if (!iso) return '—';
  // ⚠ 只取到分钟：秒级精度对作者没有意义，且会让下拉选项宽得看不全
  return String(iso).replace('T', ' ').slice(0, 16);
}
