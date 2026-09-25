/**
 * §43 章节流水线进度条（Chapter Workspace UI 顶部）
 *
 * ```text
 * 第 31 章
 * Planning ✓  Writing ✓  Review ✓  Revision ●  Continuity ○  Commit ○
 * ```
 *
 * ## ⚠ 为什么单独一个文件而不是塞进 manuscript-editor.js
 *
 * 进度条与编辑器是**两个关注点**：
 *   - 进度条回答"这一章走到哪了"（跨阶段，只读）
 *   - 编辑器回答"这段字怎么写"（单阶段，可写）
 * 混在一个文件里，改进度条会碰到编辑器的 autosave / 光标逻辑，
 * 而两者连数据来源都不同（产物文件 vs 正文文本）。
 *
 * ## ⚠ 状态由产物事实驱动（研究报告 §3.1 决策 1）
 *
 * 六步的完成判据全部来自**工作区产物文件是否存在**与**章节行状态**，
 * 不来自任何"任务进度"字段。详见主进程 `manuscript.pipeline`。
 *
 * 这一点直接决定了本组件的行为：**它不做本地状态推断**。
 * 每个阶段是否完成只信后端返回，前端不"猜"（比如看到 draft 就认为
 * review 也过了）—— 猜出来的进度条比没有进度条更危险，因为它会让人
 * 以为某一步已经做过了。
 */

/** 步骤状态的视觉编码：颜色 + 字符双编码（研究报告 §3.1 决策 6） */
const ICON = { done: '✓', current: '●', todo: '○' };

/**
 * 渲染流水线进度条。
 *
 * @param opts.el      创建元素（调用方注入，保持与其它 renderer 一致）
 * @param opts.invoke  IPC 调用（`call` 的签名）
 * @param opts.chapter 章节对象（至少要有 id 与 chapterNumber）
 */
export function renderPipeline({ el, invoke, chapter }) {
  const box = el('div', 'pipeline');
  // ⚠ 先给出"加载中"占位而不是空白：空白无法区分
  //   "还没加载"与"这一章什么都没做"，两者该采取的行动完全不同。
  box.append(el('span', 'pipeline__loading', '正在读取章节进度…'));

  void (async () => {
    const r = await invoke('manuscript.pipeline', { chapterId: chapter.id });
    box.replaceChildren();

    if (!r.ok) {
      // ⚠ 读不到就说读不到，不退回"全部未开始" —— 那是在编造进度
      box.append(el('span', 'pipeline__err', `进度读取失败：${r.error.message}`));
      return;
    }

    const steps = r.data.steps ?? [];
    steps.forEach((s, i) => {
      if (i > 0) box.append(el('span', 'pipeline__arrow', '›'));

      const cls =
        'pipeline__step pipeline__step--' +
        (s.done ? 'done' : s.current ? 'current' : 'todo');
      const node = el('span', cls);
      node.append(el('span', 'pipeline__mark', ICON[s.done ? 'done' : s.current ? 'current' : 'todo']));
      node.append(el('span', 'pipeline__label', s.label));

      // 无障碍：图标是纯视觉编码，读屏软件需要文字状态
      node.setAttribute(
        'title',
        `${s.label}：${s.done ? '已完成' : s.current ? '进行中' : '未开始'}`,
      );
      box.append(node);
    });

    // ⚠ 概览数字用"已完成/总数"，并明确写出未提交
    //   —— §三十 要求作者一眼看出这份正文是不是已经是正史
    const summary = el(
      'span',
      r.data.committed ? 'pipeline__sum pipeline__sum--ok' : 'pipeline__sum',
      r.data.committed
        ? `已提交为正式章节（${r.data.doneCount}/${r.data.total}）`
        : `未提交 · 中间产物在 workspace/（${r.data.doneCount}/${r.data.total}）`,
    );
    box.append(summary);
  })();

  return box;
}
