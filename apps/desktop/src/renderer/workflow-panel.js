/**
 * 工作流面板（P1 — Workflow UI：按 Stage 展示进度）
 *
 * ## ⚠ 为什么必须补这个面板
 *
 * P0-1/P0-2 把「Novel Workflow」做成了**唯一**正确的编排入口：
 * 12 个 stage 的顺序由 `STAGE_ORDER` 写死，调用方改不了；暂停/恢复/
 * 重启恢复的依据全在数据库里。`workflow.start` 一句就能跑完整章。
 *
 * 但界面上**完全没有入口** —— 用户只能点 6 个逐步按钮
 * （规划 / 生成草稿 / 一致性检查 / 审稿 / 提交预检 / 生成摘要），
 * 自己记住顺序、自己判断该点哪个。那等于把编排逻辑重新交回给人，
 * 而工作流的存在意义正是"不依赖人记得住顺序"。
 *
 * 这与本项目反复出现的「后端有、界面够不到」是同一类缺陷的界面版本。
 *
 * ## ⚠ 为什么保留逐步按钮（与工作流面板共存）
 *
 * 逐步按钮不是多余的：改一句台词后只想重跑审阅、不想重跑整章时，
 * 它是唯一办法。工作流面板负责"正常写作"，逐步按钮负责"精细控制"。
 * 两者共存，面板置顶。
 *
 * ## ⚠ 模型列：如实显示「—」，不编造
 *
 * 卡片要求 stage 展开后显示"模型"，但后端**没有**按 stage 记录模型名
 * （`workflow_stages` 只有 status/attempts/started_at/ended_at/output）。
 * 这里如实显示「—」并注明原因 —— 显示一个猜出来的模型名比不显示更糟：
 * 用户会据此判断"这步用了哪个模型"，而那个判断是假的。
 */

/** stage 的中文名与一句话说明（UI 用，不参与逻辑） */
const STAGE_LABELS = {
  create_chapter: ['建章节', '由工作流自己创建章节并绑定'],
  build_context: ['构建上下文', '检索长程记忆、技能与真值'],
  plan: ['规划', '生成章节计划（brief + 场景）'],
  plan_verify: ['计划校验', '代码校验计划的完整性与一致性'],
  write: ['写正文', '逐场景生成草稿'],
  review: ['审稿', '确定性检查 + 模型审阅'],
  revision: ['改稿', '按审阅问题做替换式修订'],
  continuity: ['连续性检查', '对照 Canon / 角色状态 / 时间线'],
  state_settlement: ['状态结算', '提取→验证→应用角色与事实状态'],
  ready_to_commit: ['提交门禁', '摘要批准（§十二）与 BLOCKING 检查（§33）'],
  commit: ['提交', '原子写入正式章节（PREPARE→APPLY→VERIFY）'],
  verify: ['提交后校验', '确认章节状态与产物一致'],
};

/** stage 状态 → 图标。⚠ 语义：● 是"正在跑"，不是"待办" */
const STATUS_ICON = {
  PENDING: '○',
  RUNNING: '●',
  DONE: '✓',
  FAILED: '✗',
  SKIPPED: '–',
};

const TERMINAL = ['DONE', 'FAILED', 'CANCELLED'];

/**
 * 当前存活的面板轮询器 —— 模块级，**必须**是模块级。
 *
 * ⚠ 泄漏场景（真实存在，非理论）：`renderAgent()` 每次都新建面板，
 *   而它开头做的是 `a.replaceChildren()` —— 只把旧 DOM 摘下来，
 *   **不会**清掉旧面板的 `setInterval`。于是每渲染一次就多一个
 *   永不停止的轮询器，后台持续发 IPC。用户点几下就会累积一堆。
 *
 *   把停止函数放在模块作用域，新面板创建时先停掉上一个 ——
 *   保证任意时刻最多一个轮询器。
 */
let stopActivePoller = null;

/** 耗时（毫秒 → 人话）。缺任一端返回 null，不猜 */
function durationText(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null;
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function renderWorkflowPanel({ el, state, invoke, msg, refreshChapters }) {
  // ⚠ 先停掉上一个面板的轮询器（见 stopActivePoller 的说明）
  if (stopActivePoller) {
    stopActivePoller();
    stopActivePoller = null;
  }

  const box = el('div', 'form form--rail');
  box.append(el('h3', null, '工作流（一键跑完整章）'));

  // ⚠ 面板自己记 workflowId，不放进全局 state：
  //   工作流是"当前正在看的这一次运行"，切项目/切书后旧 id 就没意义了。
  let workflowId = state.lastWorkflowId ?? null;
  let timer = null;

  const startRow = el('div', 'btn-row');
  const startBtn = el('button', 'btn btn--primary', '运行完整工作流');
  const pauseBtn = el('button', 'btn', '暂停');
  const resumeBtn = el('button', 'btn', '恢复');
  const cancelBtn = el('button', 'btn btn--danger', '取消');
  pauseBtn.disabled = true;
  resumeBtn.disabled = true;
  cancelBtn.disabled = true;
  startRow.append(startBtn, pauseBtn, resumeBtn, cancelBtn);

  // ⚠ 用调用方传入的 msg 元素（panels.js 的约定），不自己再造一个：
  //   两套消息元素会让人不知道哪条状态显示在哪，且调用方无法清空它。
  const headMsg = msg;
  const progressLine = el('div', 'perm-line');
  const stagesBox = el('div', 'model-status');

  box.append(startRow, headMsg, progressLine, stagesBox);

  box.append(
    el(
      'div',
      'perm-line',
      '⚠ 这是**正常写作**的入口：顺序由代码控制，中断后可恢复（重启也不会重跑已完成的步骤）。' +
        '下方「写作流程」里的逐步按钮用于精细控制（如只重跑审稿）。',
    ),
  );

  // ── 渲染逐 stage 进度 ──────────────────────────────────
  function renderStages(view) {
    stagesBox.replaceChildren();
    const stages = view?.stages ?? [];
    if (stages.length === 0) {
      stagesBox.append(el('div', 'empty', '尚未开始'));
      return;
    }

    for (const s of stages) {
      const [label, hint] = STAGE_LABELS[s.stageId] ?? [s.stageId, ''];
      const icon = STATUS_ICON[s.status] ?? '?';
      const dur = durationText(s.startedAt, s.endedAt);

      // 用原生 <details> 展开：自带键盘可达性与无障碍语义
      const d = el('details', 'wf-stage');
      const sum = el('summary', 'wf-stage__head');
      sum.append(el('span', `wf-icon wf-icon--${s.status.toLowerCase()}`, icon));
      sum.append(el('span', 'wf-stage__name', label));
      const meta = [s.status];
      if (dur) meta.push(dur);
      // ⚠ attempts > 1 要显示：反复重试是"这步不稳定"的信号，
      //   藏起来会让用户以为一次就过了。
      if (s.attempts > 1) meta.push(`尝试 ${s.attempts} 次`);
      sum.append(el('span', 'wf-stage__meta', meta.join('｜')));
      d.append(sum);

      const body = el('div', 'wf-stage__body');
      if (hint) body.append(el('div', 'perm-line', hint));

      // ⚠ 模型列：后端未按 stage 记录，如实显示 —
      body.append(el('div', 'perm-line', '模型：—（后端未按 stage 记录模型名）'));

      if (s.error) {
        body.append(el('div', 'issue-msg', `错误：${s.error}`));
      }

      // 产物：路径 + 哈希。哈希短显示，避免刷屏
      const arts = (view.artifacts ?? []).filter((a) => a.stageId === s.stageId);
      if (arts.length) {
        body.append(el('div', 'perm-line', `产物（${arts.length}）`));
        for (const a of arts) {
          const shortHash = a.contentHash ? a.contentHash.slice(0, 12) : '（无哈希）';
          body.append(el('div', 'issue-src', `${a.artifactType}：${a.path}  sha256:${shortHash}…`));
        }
      }

      // 输出：JSON 可能很长，截断显示并说明截断
      if (s.output !== null && s.output !== undefined) {
        let text;
        try {
          text = JSON.stringify(s.output);
        } catch {
          text = String(s.output);
        }
        const LIMIT = 800;
        const shown = text.length > LIMIT ? `${text.slice(0, LIMIT)}…（共 ${text.length} 字，已截断）` : text;
        body.append(el('div', 'perm-line', '输出'));
        body.append(el('div', 'issue-src', shown));
      }

      d.append(body);
      stagesBox.append(d);
    }
  }

  function renderView(view) {
    if (!view) {
      progressLine.textContent = '';
      renderStages(null);
      return;
    }
    state.lastWorkflowId = view.workflowId;
    state.lastWorkflow = view;
    const p = view.progress ?? {};
    const parts = [
      `第 ${view.chapterNumber ?? '?'} 章`,
      view.status,
      `进度 ${p.done ?? 0}/${p.total ?? 0}`,
    ];
    if (view.currentStage) parts.push(`当前：${(STAGE_LABELS[view.currentStage] ?? [view.currentStage])[0]}`);
    progressLine.textContent = parts.join('｜');

    renderStages(view);

    const running = !TERMINAL.includes(view.status);
    pauseBtn.disabled = !running;
    // 恢复只在 PAUSED 有意义（FAILED 需人工修问题后重启流程）
    resumeBtn.disabled = view.status !== 'PAUSED';
    cancelBtn.disabled = !running;
    startBtn.disabled = running;
  }

  async function poll() {
    if (!workflowId) return;
    const r = await invoke('workflow.get', { workflowId });
    if (!r.ok) {
      headMsg.className = 'form-msg form-msg--err';
      headMsg.textContent = `读取进度失败：${r.error?.code}：${r.error?.message ?? ''}`;
      return;
    }
    renderView(r.data);
    if (TERMINAL.includes(r.data?.status)) {
      stopPolling();
      // 章节状态变了（可能已 COMMITTED）→ 刷新左栏
      if (typeof refreshChapters === 'function') await refreshChapters();
    }
  }

  function startPolling() {
    // ⚠ 这里**不能**调 stopPolling()。
    //
    //   实测踩到：stopPolling() 会把模块级注册清空
    //   （`if (stopActivePoller === stopPolling) stopActivePoller = null`），
    //   而 startPolling() 是在面板构造完之后、由首屏微任务调用的 ——
    //   于是刚注册的守卫被自己抹掉，下一次重建面板时
    //   `if (stopActivePoller)` 为假，旧轮询器永远停不下来。
    //   本文件的 verify 脚本（连建 5 个面板 → 存活 5 个）抓到了这一点。
    //
    //   所以这里只清定时器，不碰注册。
    if (timer !== null) clearInterval(timer);
    // ⚠ 轮询而不是订阅事件流：事件流是"发生了什么事"，
    //   而 UI 要的是"现在是什么状态"。状态查询天然幂等，
    //   错过一次轮询不会有后果；漏掉一条事件则会永远显示错的状态。
    timer = setInterval(() => void poll(), 1500);
  }

  /** 停止轮询并让出模块级槽位（真正的"这个面板不要了"） */
  function stopPolling() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    // 只有**自己**占着槽位时才清空，避免把别人的注册误删
    if (stopActivePoller === stopPolling) stopActivePoller = null;
  }

  // ⚠ 把停止函数注册到模块级：下一次 renderAgent() 重建面板时会先调它，
  //   否则旧面板的轮询器会一直跑下去（见 stopActivePoller 的说明）。
  stopActivePoller = stopPolling;

  // ── 动作 ──────────────────────────────────────────────
  startBtn.addEventListener('click', async () => {
    const bookId = state.selectedBookId;
    if (!bookId) {
      headMsg.className = 'form-msg form-msg--err';
      headMsg.textContent = '请先选择一本书（左栏）';
      return;
    }
    startBtn.disabled = true;
    headMsg.className = 'form-msg';
    headMsg.textContent = '正在启动工作流…';

    // ⚠ 章号交给工作流自己决定（create_chapter 会建下一章）。
    //   这里不传 chapterNumber：UI 算"下一章是几"会与工作流的判断
    //   重复且可能不一致（比如中间有跳号）。
    const r = await invoke('workflow.start', { bookId });
    if (!r.ok) {
      startBtn.disabled = false;
      headMsg.className = 'form-msg form-msg--err';
      headMsg.textContent = `${r.error?.code}：${r.error?.message ?? ''}`;
      return;
    }
    workflowId = r.data?.workflowId;
    headMsg.textContent = `已启动：${workflowId}（写完整章需数分钟，可随时暂停）`;
    await poll();
    startPolling();
  });

  pauseBtn.addEventListener('click', async () => {
    const r = await invoke('workflow.pause', { workflowId });
    headMsg.textContent = r.ok
      ? '已请求暂停 —— 会在当前步骤结束后停下（不会留下半个步骤）'
      : `暂停失败：${r.error?.message ?? ''}`;
    await poll();
  });

  resumeBtn.addEventListener('click', async () => {
    const r = await invoke('workflow.resume', { workflowId });
    if (!r.ok) {
      headMsg.className = 'form-msg form-msg--err';
      headMsg.textContent = `恢复失败：${r.error?.message ?? ''}`;
      return;
    }
    headMsg.className = 'form-msg';
    headMsg.textContent = '已恢复 —— 已完成的步骤不会重跑';
    await poll();
    startPolling();
  });

  cancelBtn.addEventListener('click', async () => {
    // ⚠ 取消**不可恢复**（与暂停语义不同），所以必须二次确认。
    //   误点一次就丢掉整章进度，代价太大。
    if (!window.confirm('取消后无法恢复（与「暂停」不同）。确定取消这个工作流？')) return;
    const r = await invoke('workflow.cancel', { workflowId });
    headMsg.textContent = r.ok ? '已取消（不可恢复）' : `取消失败：${r.error?.message ?? ''}`;
    stopPolling();
    await poll();
  });

  // ── 首屏：捞出可恢复的工作流（重启后能看到"上次没跑完的那次"）──
  queueMicrotask(async () => {
    const rec = await invoke('workflow.recoverable');
    if (rec.ok && (rec.data?.count ?? 0) > 0) {
      const first = rec.data.workflows?.[0];
      workflowId = first?.workflowId ?? null;
      headMsg.className = 'form-msg form-msg--warn';
      headMsg.textContent =
        `发现 ${rec.data.count} 个未完成的工作流（上次未跑完）。` +
        (workflowId ? '已载入最近一个，可点「恢复」继续。' : '');
      if (workflowId) {
        await poll();
        if (state.lastWorkflow && !TERMINAL.includes(state.lastWorkflow.status)) startPolling();
      }
      return;
    }
    if (workflowId) {
      await poll();
      if (state.lastWorkflow && !TERMINAL.includes(state.lastWorkflow.status)) startPolling();
    } else {
      renderView(null);
    }
  });

  return box;
}
