/**
 * M8 —— Review Issue 列表 + 点条目定位到正文（§十八 / §三十八）。
 *
 * ## 与定位算法的分工
 *
 * 定位算得对不对在 `locate.js`（纯函数，单测穷举）；
 * 本文件只负责把它接到 DOM 上：渲染列表、点击后滚动 + 选中。
 * 这样"高亮到别的句子"这类错误能在单测层被抓住，不用靠 GUI 断言。
 *
 * ## ⚠⚠ 点 Issue 会**移动光标**，而光标位置是 autosave 快照的一部分
 *
 * 定位后必须把新的 selectionStart/End 推给 autosave（`pushSnapshot`），
 * 否则作者点了几条 Issue、切章再回来，恢复出来的光标停在旧位置 ——
 * 而正文已经滚到别处了。
 *
 * ## ⚠ 只定位，不改正文
 *
 * 高亮用 `setSelectionRange` + 滚动，**不插入任何标记**。
 * 往正文里插高亮标记会污染 textarea 的 value，
 * 而那个 value 就是"作者以为的正文"，接着一保存就把标记写进正文了。
 */
import { locateIssue } from './locate.js';

const SEVERITY_TEXT = {
  BLOCKING: '阻断',
  MAJOR: '严重',
  MINOR: '轻微',
};

const SEVERITY_CLASS = {
  BLOCKING: 'issue-row--blocking',
  MAJOR: 'issue-row--major',
  MINOR: 'issue-row--minor',
};

/** via → 作者看得懂的说法 */
const VIA_TEXT = {
  offset: '',
  excerpt: '（定位已按原文搜索校正）',
  paragraph: '（只定位到所在段落，未精确到句子）',
};

/**
 * Issue 面板。
 *
 * @param {object} opts
 * @param {Function} opts.el
 * @param {Function} opts.invoke
 * @param {object}   opts.msg
 * @param {object}   opts.chapter
 * @param {Function} opts.getText       取编辑器当前文本
 * @param {Function} opts.locateAndFocus 定位并选中（由编辑器提供，能操作 textarea）
 */
export function renderIssuePanel({ el, invoke, msg, chapter, getText, locateAndFocus }) {
  const box = el('div', 'issues');

  const head = el('div', 'issues__head');
  head.append(el('h3', null, '审阅问题'));
  const refreshBtn = el('button', 'btn btn--small', '刷新');
  head.append(refreshBtn);
  box.append(head);

  const statusLine = msg();
  box.append(statusLine);

  const list = el('div', 'issues__list');
  box.append(list);

  let issues = [];

  function render() {
    list.replaceChildren();
    if (issues.length === 0) {
      list.append(el('div', 'empty', '本章还没有审阅结论。跑一次审阅后，问题会列在这里。'));
      return;
    }
    // ⚠ 阻断项排最前：作者最需要先看到"这个不修就提交不了"
    const order = { BLOCKING: 0, MAJOR: 1, MINOR: 2 };
    const sorted = [...issues].sort(
      (a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9),
    );

    for (const it of sorted) {
      const row = el('div', `issue-row ${SEVERITY_CLASS[it.severity] ?? ''}`);
      row.dataset.issueId = it.id;

      const top = el('div', 'issue-row__top');
      top.append(el('span', 'issue-row__sev', SEVERITY_TEXT[it.severity] ?? it.severity));
      top.append(el('span', 'issue-row__cat', it.category));
      row.append(top);

      row.append(el('div', 'issue-row__claim', it.claim));

      if (it.suggestions && it.suggestions.length > 0) {
        const ul = el('ul', 'issue-row__sug');
        for (const s of it.suggestions) ul.append(el('li', null, s));
        row.append(ul);
      }

      // ⚠ 有没有定位信息要**如实**显示：没有的话点不动，
      //   而作者会以为"点了没反应是软件坏了"。不如直接说清。
      const loc = it.location ?? null;
      const btn = el('button', 'btn btn--small', loc ? '定位到正文' : '无定位信息');
      btn.disabled = !loc;
      if (loc) {
        btn.addEventListener('click', () => {
          const text = typeof getText === 'function' ? getText() : '';
          const r = locateIssue(text, loc);
          if (r === null) {
            statusLine.className = 'form-msg form-msg--warn';
            statusLine.textContent =
              '定位失败：这条问题记录的段落/片段在当前正文里找不到。' +
              '正文可能已改动较多，建议重跑一次审阅。';
            return;
          }
          const focused = typeof locateAndFocus === 'function' ? locateAndFocus(r) : false;
          statusLine.className = 'form-msg';
          // ⚠ 定位层级如实告知 —— 只到段落时作者要知道"没精确到句子"，
          //   否则会以为软件定位不准。
          statusLine.textContent =
            '已定位到第 ' + (r.paragraph ?? '?') + ' 段' + (VIA_TEXT[r.via] ?? '') + '。';
          if (!focused) {
            statusLine.className = 'form-msg form-msg--warn';
            statusLine.textContent += '（编辑器未就绪，未能选中）';
          }
          if (r.drift) {
            statusLine.className = 'form-msg form-msg--warn';
            statusLine.textContent +=
              '⚠ 这份审阅记录的字符偏移与当前正文对不上（正文改过），已按原文片段重新定位。';
          }
        });
      }
      row.append(btn);
      list.append(row);
    }
  }

  async function load() {
    const r = await invoke('review.get', { chapterId: chapter.id });
    if (!r.ok) {
      statusLine.className = 'form-msg form-msg--err';
      statusLine.textContent = `审阅结论读取失败：${r.error.message}`;
      return;
    }
    // ⚠ review 可能是 null（还没跑过审阅）或形状异常 ——
    //   直接取 .issues 会抛错，而抛错会让后面的面板整块缺失
    const review = r.data.review ?? null;
    issues = Array.isArray(review?.issues) ? review.issues : [];

    const blocking = issues.filter((i) => i.severity === 'BLOCKING').length;
    statusLine.className = blocking > 0 ? 'form-msg form-msg--err' : 'form-msg';
    statusLine.textContent =
      issues.length === 0
        ? '没有审阅问题。'
        : `共 ${issues.length} 条` + (blocking > 0 ? `，其中阻断 ${blocking} 条（不修完无法提交到正史）` : '') + '。';
    render();
  }

  refreshBtn.addEventListener('click', () => void load());
  void load();

  box.refreshIssues = load;
  return box;
}
