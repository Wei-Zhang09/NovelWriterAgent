/**
 * 渲染进程（纯 JS，无构建步骤）
 *
 * STEP 3 范围：在 STEP 2 的三栏工作台之上加「模型设置」。
 *   左栏 = 切对象（项目 / 书 / 章节列表）
 *   中栏 = 主体内容（项目信息 / 新建表单 / 章节详情 / 模型设置）
 *   右栏 = 动作 + 诊断（工具清单、权限分布、模型状态、最近一次调用）
 *
 * 约定（研究报告 §3.1 决策 1）：**状态必须由产物事实驱动，不由任务状态驱动**。
 * 因此章节状态直接来自 DB 行，而非任何「任务进度」字段。
 */
import { renderSkillPanel, renderBackupPanel } from './panels.js';
import { renderCorpusPanel } from './corpus-panel.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** 应用状态（v1.0 单项目） */
const state = {
  project: null,
  books: [],
  chapters: [],
  selectedBookId: null,
  tools: [],
  permissions: {},
  lastCall: null,
  modelConfig: null,
  lastModelTest: null,
  runStatus: null,
  lastRunEvents: null,
  contextReport: null,
  contextSlots: null,
  lastPlan: null,
  lastDraft: null,
  lastContinuity: null,
  lastReview: null,
  lastCanon: null,
  lastCommit: null,
  lastSearch: null,
};

async function call(method, params) {
  const r = await window.nwa.invoke(method, params);
  if (!r) return { ok: false, error: { code: 'NO_RESPONSE', message: 'core 无响应' } };
  return r;
}

/** 经 Tool Registry 调用（统一走权限与 schema 门禁） */
async function tool(name, input, permission) {
  const r = await call('tool.invoke', { name, input, permission });
  state.lastCall = { name, result: r, at: new Date().toISOString() };
  return r;
}

// ─────────────────────────────────────────────────────────────
// 左栏：项目 / 书 / 章节
// ─────────────────────────────────────────────────────────────

async function loadChapters() {
  if (!state.selectedBookId) {
    state.chapters = [];
    return;
  }
  const r = await tool('chapter.list', { bookId: state.selectedBookId });
  state.chapters = r.ok ? r.data.chapters : [];
}

async function loadProjects() {
  const r = await call('project.info');
  if (!r.ok) {
    $('nav').replaceChildren(el('div', 'empty', `加载失败：${r.error.message}`));
    return;
  }
  state.tools = r.data.tools ?? [];
  state.permissions = r.data.permissions ?? {};
  const projects = r.data.projects ?? [];

  if (projects.length === 0) {
    state.project = null;
    state.books = [];
    state.chapters = [];
  } else {
    state.project = projects[0];
    const b = await call('book.list', { projectId: state.project.id });
    state.books = b.ok ? b.data.books : [];

    // 选中书目：优先保留当前选择；若它已不存在（换了项目）则回退到第一本。
    // 注意：不能在 books 为空时保留旧 selectedBookId，否则中栏会渲染出
    // 一个指向不存在书目的"新建章节"表单（曾在本流程验证中暴露）。
    const stillValid = state.books.some((x) => x.id === state.selectedBookId);
    if (!stillValid) {
      state.selectedBookId = state.books[0]?.id ?? null;
    }
    await loadChapters();
  }

  renderNav(projects);
  renderCenter();
  renderAgent();
}

function renderNav(projects) {
  const nav = $('nav');
  nav.replaceChildren();

  if (projects.length === 0) {
    nav.append(el('div', 'empty', '还没有项目'));
    return;
  }

  nav.append(el('div', 'nav-section', '项目'));
  for (const p of projects) {
    const item = el('div', 'nav-item nav-item--active');
    item.append(el('span', 'nav-label', p.name));
    if (p.genre) item.append(el('span', 'nav-meta', p.genre));
    nav.append(item);
  }

  nav.append(el('div', 'nav-section', '书目'));
  if (state.books.length === 0) nav.append(el('div', 'empty', '还没有书'));
  for (const b of state.books) {
    const item = el('div', `nav-item${b.id === state.selectedBookId ? ' nav-item--active' : ''}`);
    item.append(el('span', 'nav-label', b.title));
    item.append(el('span', 'nav-meta', `至第 ${b.currentChapter} 章`));
    item.addEventListener('click', async () => {
      state.selectedBookId = b.id;
      await loadChapters();
      renderNav(projects);
      renderCenter();
      renderAgent();
    });
    nav.append(item);
  }

  nav.append(el('div', 'nav-section', `章节（${state.chapters.length}）`));
  if (state.chapters.length === 0) nav.append(el('div', 'empty', '还没有章节'));
  for (const c of state.chapters) {
    const item = el('div', 'nav-item nav-item--chapter');
    item.append(el('span', 'nav-label', `第 ${c.chapterNumber} 章`));
    item.append(statusChip(c.status));
    item.addEventListener('click', () => renderChapterDetail(c));
    nav.append(item);
  }
}

/** 状态标签：颜色 + 文字双编码；暂停/待操作不用危险色（研究报告 §3.1 决策 6） */
function statusChip(status) {
  const map = {
    DRAFT: ['chip--muted', '草稿'],
    PLANNING: ['chip--info', '规划中'],
    CONTEXT_READY: ['chip--info', '上下文就绪'],
    WRITING: ['chip--info', '写作中'],
    DRAFT_READY: ['chip--info', '待审稿'],
    REVIEWING: ['chip--warn', '审稿中'],
    REVIEW_READY: ['chip--warn', '待修订'],
    REVISING: ['chip--warn', '修订中'],
    CONTINUITY_CHECKING: ['chip--warn', '一致性检查'],
    READY_TO_COMMIT: ['chip--ok', '可提交'],
    COMMITTING: ['chip--ok', '提交中'],
    COMMITTED: ['chip--ok', '已提交'],
    PAUSED: ['chip--pause', '已暂停'],
    FAILED: ['chip--err', '失败'],
  };
  const [cls, text] = map[status] ?? ['chip--muted', status];
  return el('span', `chip ${cls}`, text);
}

// ─────────────────────────────────────────────────────────────
// 中栏：主体内容
// ─────────────────────────────────────────────────────────────

function kv(k, v) {
  const row = el('div', 'kv-row');
  row.append(el('span', 'kv-k', k));
  row.append(el('span', 'kv-v', v));
  return row;
}

function renderCenter() {
  const c = $('center');
  c.replaceChildren();

  if (!state.project) {
    c.append(el('h2', null, '开始'));
    c.append(el('p', 'hint', '还没有项目。用下面的表单创建第一个。'));
  } else {
    c.append(el('h2', null, state.project.name));
    const meta = el('div', 'kv');
    meta.append(kv('项目 ID', state.project.id));
    meta.append(kv('类型', state.project.genre ?? '—'));
    meta.append(kv('书目数', String(state.books.length)));
    meta.append(kv('章节数', String(state.chapters.length)));
    c.append(meta);
  }

  c.append(renderNewProjectForm());
  if (state.project && state.books.length === 0) c.append(renderNewBookForm());
  if (state.selectedBookId) c.append(renderNewChapterForm());
}

// ─────────────────────────────────────────────────────────────
// Agent Runtime 与状态机（STEP 4）
// ─────────────────────────────────────────────────────────────

async function loadRunStatus() {
  const r = await call('run.status');
  state.runStatus = r.ok ? r.data : null;
}

/**
 * Agent Runtime 面板。
 *
 * 展示三件在 STEP 4 才成立的事：
 *   1. 各 Agent 类型的权限上限（谁只读）—— 权限由代码下发，不由调用方决定
 *   2. 状态机的合法迁移目标 —— UI 只应显示能点的按钮
 *   3. Run 的事件流 —— 让「为什么走到这一步」可查（§39）
 */
function renderRuntimePanel() {
  const box = el('div', 'form form--rail');
  box.append(el('h3', null, 'Agent 与状态机'));

  const rs = state.runStatus;

  // ── Run 控制（补缺口：Pause / Resume / Cancel 的 UI 入口）──
  const runMsg = el('div', 'form-msg');
  const ctlRow = el('div', 'btn-row');
  const pauseBtn = el('button', 'btn', '暂停');
  const resumeBtn = el('button', 'btn', '恢复');
  const cancelBtn = el('button', 'btn', '取消');
  ctlRow.append(pauseBtn, resumeBtn, cancelBtn);
  box.append(ctlRow, runMsg);
  box.append(el('div', 'perm-line', '暂停保留已完成步骤；取消不可恢复'));

  // ⚠ run.status 返回的字段名是 active（不是 activeRuns）
  const activeRunId = () => {
    const list = state.runStatus?.active ?? [];
    return list[0]?.runId ?? null;
  };

  const doRun = async (method, label) => {
    const runId = activeRunId();
    if (!runId) {
      runMsg.className = 'form-msg form-msg--err';
      runMsg.textContent = '当前没有运行中的 Run';
      return;
    }
    runMsg.className = 'form-msg';
    runMsg.textContent = `${label}中…`;
    const r = await call(method, { runId });
    if (!r.ok) {
      runMsg.className = 'form-msg form-msg--err';
      runMsg.textContent = `${r.error.code}: ${r.error.message}`;
      return;
    }
    const d = r.data ?? {};
    runMsg.className = 'form-msg form-msg--ok';
    runMsg.textContent = d.resumeFrom
      ? `${label}成功 —— 从 checkpoint「${d.resumeFrom}」继续（已完成步骤不重跑）`
      : `${label}成功`;
    await loadRunStatus();
    renderAgent();
  };

  pauseBtn.addEventListener('click', () => doRun('run.pause', '暂停'));
  resumeBtn.addEventListener('click', () => doRun('run.resume', '恢复'));
  cancelBtn.addEventListener('click', () => doRun('run.cancel', '取消'));

  const readyRow = el('div', 'kv-row');
  readyRow.append(el('span', 'kv-k', 'Agent 可用'));
  readyRow.append(
    el('span', `chip ${rs?.agentReady ? 'chip--ok' : 'chip--muted'}`,
      rs?.agentReady ? '就绪' : (rs ? '需先配置模型' : '读取中…')),
  );
  box.append(readyRow);

  // 各 Agent 类型的权限（只读的用中性色，不是危险色）
  if (rs?.agentPermissions) {
    box.append(el('div', 'kv-row', ''));
    const plist = el('div', 'kv');
    for (const [agent, perm] of Object.entries(rs.agentPermissions)) {
      const row = el('div', 'kv-row');
      row.append(el('span', 'kv-k', agent));
      row.append(el('span', `perm perm--${String(perm).toLowerCase()}`, String(perm)));
      plist.append(row);
    }
    box.append(plist);
  }

  // 运行探针
  const goal = el('input');
  goal.placeholder = '探针目标（可选）';
  goal.value = '请回复 ok';
  const runBtn = el('button', 'btn btn--primary', '运行探针 Agent');
  const msg = el('div', 'form-msg');
  box.append(goal, runBtn, msg);

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    msg.className = 'form-msg';
    msg.textContent = '运行中…';
    const r = await call('agent.runProbe', { agentType: 'reviewer', goal: goal.value });
    runBtn.disabled = false;
    if (r.ok) {
      const d = r.data;
      state.lastRunEvents = d.events ?? [];
      msg.className = d.status === 'SUCCEEDED' ? 'form-msg form-msg--ok' : 'form-msg form-msg--err';
      msg.textContent = `Run ${d.status}（${d.runId}），事件 ${state.lastRunEvents.length} 条`
        + (d.error ? ` — ${d.error.code}: ${d.error.message}` : '');
    } else {
      msg.className = 'form-msg form-msg--err';
      msg.textContent = `${r.error.code}: ${r.error.message}`;
    }
    await loadRunStatus();
    renderAgent();
  });

  // 状态机可视化：展示 DRAFT 下的合法迁移（证明非法迁移在 UI 层也不可达）
  box.append(el('div', 'kv-row', ''));
  const stBtn = el('button', 'btn', '查看状态机（DRAFT）');
  const stBox = el('div', 'model-status');
  stBtn.addEventListener('click', async () => {
    const r = await call('state.allowedTargets', { from: 'DRAFT' });
    if (r.ok) {
      stBox.replaceChildren(
        el('div', 'perm-line', `DRAFT → ${r.data.allowed.join(', ')}`),
      );
      // 同时演示一个非法迁移被拒
      const bad = await call('state.canTransition', { from: 'DRAFT', to: 'COMMITTED' });
      if (bad.ok) {
        stBox.append(el('div', 'perm-line', `DRAFT → COMMITTED 被拒：${bad.data.allowed ? '允许（异常）' : bad.data.message}`));
      }
    }
  });
  box.append(stBtn, stBox);

  // 事件流
  if (state.lastRunEvents?.length) {
    box.append(el('div', 'kv-row', ''));
    const evBox = el('div', 'model-status');
    evBox.append(el('div', 'perm-line', '最近 Run 的事件流：'));
    for (const e of state.lastRunEvents.slice(0, 12)) {
      evBox.append(el('div', 'perm-line', `  [${e.category}] ${e.type}`));
    }
    box.append(evBox);
  }

  return box;
}

// ─────────────────────────────────────────────────────────────
// 模型设置（STEP 3）
// ─────────────────────────────────────────────────────────────

async function loadModelConfig() {
  const r = await call('model.config.get');
  state.modelConfig = r.ok ? r.data : null;
}

/**
 * 模型设置面板。
 *
 * 关键设计：密钥输入框是 type=password，提交后立刻清空，
 * 且**任何读取路径都不回显密钥**（core 只返回引用名 savedKeyRefs）。
 */
function renderModelSettings() {
  const box = el('div', 'form form--rail');
  box.append(el('h3', null, '模型设置'));

  const cfg = state.modelConfig;

  // 加密后端状态（§38 的关键提示）
  const enc = el('div', 'kv-row');
  enc.append(el('span', 'kv-k', '密钥加密'));
  if (cfg) {
    const ok = cfg.encryption?.available;
    enc.append(
      el('span', `chip ${ok ? 'chip--ok' : 'chip--err'}`,
        ok ? `已启用（${cfg.encryption.backend}）` : '不可用 —— 拒绝保存密钥'),
    );
  } else {
    enc.append(el('span', 'chip chip--muted', '读取中…'));
  }
  box.append(enc);

  if (cfg?.configured) {
    const list = el('div', 'kv');
    for (const p of cfg.profiles) {
      list.append(kv(`${p.id}`, `${p.model} @ ${p.endpoint}`));
      list.append(kv('　temperature', String(p.temperature)));
      list.append(kv('　maxTokens', String(p.maxTokens)));
      list.append(kv('　重试次数', String(p.maxAttempts)));
      list.append(kv('　密钥引用', cfg.savedKeyRefs.includes(p.apiKeyRef) ? `${p.apiKeyRef} ✓ 已保存` : `${p.apiKeyRef} ✗ 未设置`));
    }
    box.append(list);
    const slotLine = el('div', 'kv-row');
    slotLine.append(el('span', 'kv-k', '槽位'));
    slotLine.append(el('span', 'kv-v', Object.entries(cfg.slots).map(([k, v]) => `${k}→${v}`).join('  ')));
    box.append(slotLine);
  } else {
    box.append(el('div', 'callout', '尚未配置模型。填写下面的表单即可开始。'));
  }

  // ── 表单 ──
  const makeRow = (label, placeholder, type = 'text') => {
    const row = el('div', 'form-row');
    row.append(el('label', 'form-label', label));
    const inp = el('input');
    inp.type = type;
    inp.placeholder = placeholder;
    row.append(inp);
    box.append(row);
    return inp;
  };

  const id = makeRow('Profile ID', '例如 default（自定义标识）');
  const endpoint = makeRow('Endpoint', '例如 https://api.deepseek.com/v1');
  const model = makeRow('模型名', '例如 deepseek-chat');
  const apiKey = makeRow('API Key', 'sk-… （留空则不修改已保存的密钥）', 'password');
  const temperature = makeRow('temperature', '0.8');
  const maxTokens = makeRow('maxTokens', '4096');
  const maxAttempts = makeRow('最大重试次数', '3');
  // ⚠ 超时必须有设置项：写一章正文要生成多个场景、每个可能上千字，
  //   60 秒（旧默认）几乎必然超时（实测：规划能过、写作报
  //   "请求超时（60000ms）"）。默认给 180 秒。
  const timeoutSec = makeRow('单次请求超时（秒）', '180');

  if (cfg?.profiles?.length) {
    const p = cfg.profiles[0];
    id.value = p.id;
    endpoint.value = p.endpoint;
    model.value = p.model;
    temperature.value = String(p.temperature);
    maxTokens.value = String(p.maxTokens);
    maxAttempts.value = String(p.maxAttempts);
    timeoutSec.value = String(Math.round((p.timeoutMs ?? 180000) / 1000));
  } else {
    id.value = 'default';
    temperature.value = '0.8';
    maxTokens.value = '4096';
    maxAttempts.value = '3';
    timeoutSec.value = '180';
  }

  const saveBtn = el('button', 'btn btn--primary', '保存配置');
  const testBtn = el('button', 'btn', '测试连通');
  const btnRow = el('div', 'btn-row');
  btnRow.append(saveBtn, testBtn);
  box.append(btnRow);

  const msg = el('div', 'form-msg');
  box.append(msg);

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    msg.className = 'form-msg';
    msg.textContent = '保存中…';
    // 明文密钥只在这一条 IPC 里出现一次，之后立刻从 DOM 清掉
    const payload = {
      profile: {
        id: id.value.trim(),
        endpoint: endpoint.value.trim(),
        model: model.value.trim(),
        temperature: Number(temperature.value) || 0.8,
        maxTokens: Number(maxTokens.value) || 4096,
        maxAttempts: Number(maxAttempts.value) || 3,
        timeoutMs: (Number(timeoutSec.value) || 180) * 1000,
      },
      apiKey: apiKey.value.length > 0 ? apiKey.value : null,
      useForAllSlots: true,
    };
    apiKey.value = '';
    const r = await call('model.config.save', payload);
    saveBtn.disabled = false;
    if (r.ok) {
      const d = r.data;
      // ⚠ 明确报告 agentReady —— 保存成功但 Runtime 未建成时，
      //   用户会再次陷入"配了却用不了"，所以这里必须说清楚。
      if (d.agentReady) {
        msg.className = 'form-msg form-msg--ok';
        msg.textContent = `已保存 profile ${d.profileId}，模型已就绪（agentReady）`;
      } else {
        msg.className = 'form-msg form-msg--err';
        msg.textContent = `配置已保存，但模型未就绪：${d.rebuildError ?? 'Runtime 未建立'}`
          + ' —— 请检查 endpoint / 模型名是否正确';
      }
      await loadModelConfig();
      renderCenter();
      renderAgent();
      // 刷新 Runtime 状态（"就绪 / 需先配置模型"芯片）
      await loadRunStatus();
    } else {
      msg.className = 'form-msg form-msg--err';
      msg.textContent = r.error.message;
    }
  });

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    msg.className = 'form-msg';
    msg.textContent = '正在发送真实请求…';
    const r = await call('model.test', { slot: 'utility' });
    testBtn.disabled = false;
    state.lastModelTest = r.ok ? r.data : { ok: false, error: r.error };
    if (r.ok && r.data.ok) {
      msg.className = 'form-msg form-msg--ok';
      msg.textContent =
        `连通成功：${r.data.model} 用时 ${r.data.latencyMs}ms，` +
        `tokens in=${r.data.usage.inputTokens} out=${r.data.usage.outputTokens}，` +
        `回复「${r.data.text.trim()}」`;
    } else {
      msg.className = 'form-msg form-msg--err';
      const e = r.ok ? r.data.error : r.error;
      msg.textContent = `失败 ${e.code}：${e.message}`;
    }
    renderAgent();
  });

  return box;
}

function renderNewProjectForm() {
  const box = el('div', 'form');
  box.append(el('h3', null, '新建项目'));
  const name = el('input');
  name.placeholder = '项目名（必填）';
  const genre = el('input');
  genre.placeholder = '类型，如 urban_fantasy（可选）';
  const btn = el('button', 'btn btn--primary', '创建项目');
  const msg = el('div', 'form-msg');

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    msg.textContent = '';
    const r = await tool('project.create', {
      name: name.value.trim(),
      genre: genre.value.trim() || null,
    });
    btn.disabled = false;
    if (r.ok) {
      msg.className = 'form-msg form-msg--ok';
      msg.textContent = `已创建：${r.data.name}`;
      name.value = '';
      genre.value = '';
      await loadProjects();
    } else {
      msg.className = 'form-msg form-msg--err';
      // 展示字段级校验信息（Tool Registry 的结构化错误）
      const d = r.error.details;
      msg.textContent = Array.isArray(d)
        ? d.map((x) => `${x.path || '(root)'}: ${x.message}`).join('；')
        : r.error.message;
    }
  });

  box.append(name, genre, btn, msg);
  return box;
}

function renderNewBookForm() {
  const box = el('div', 'form');
  box.append(el('h3', null, '新建书目'));

  const msg = el('div', 'form-msg');
  const existing = state.books;

  // ⚠ 已有书目时必须先把"现有几本"摆出来。
  //
  // 真实事故：用户连点「创建书目」产生了 **24 本同名「测试小说」**，
  // 因为表单对"已有书"完全无感知，而且新建后**不会自动选中新书** ——
  // 用户以为没生效就再点一次。
  if (existing.length > 0) {
    box.append(el('div', 'perm-line',
      `当前项目已有 ${existing.length} 本书（左栏可切换）：`));
    const list = el('div', 'perm-line');
    list.textContent = existing.map((b) => `· ${b.title}`).join('\n');
    list.style.whiteSpace = 'pre-line';
    box.append(list);
    // 默认折叠新建表单：防误操作，但仍支持有意创建多本书
    const toggle = el('button', 'btn', '＋ 再建一本');
    const holder = el('div');
    holder.style.display = 'none';
    toggle.addEventListener('click', () => {
      holder.style.display = holder.style.display === 'none' ? 'block' : 'none';
      toggle.textContent = holder.style.display === 'none' ? '＋ 再建一本' : '收起';
    });
    box.append(toggle, holder);
    box.append(msg);
    holder.append(buildBookCreateRow(msg));
    return box;
  }

  // 还没有书 → 直接给出表单
  box.append(buildBookCreateRow(msg), msg);
  return box;
}

/** 书名输入 + 创建按钮（新建/追加共用） */
function buildBookCreateRow(msg) {
  const row = el('div');
  const title = el('input');
  title.placeholder = '书名（必填）';
  const btn = el('button', 'btn btn--primary', '创建书目');

  btn.addEventListener('click', async () => {
    const name = title.value.trim();
    if (name.length === 0) {
      msg.className = 'form-msg form-msg--err';
      msg.textContent = '请填写书名';
      return;
    }
    // ⚠ 同名提醒：24 本同名书正是这样产生的
    if (state.books.some((b) => b.title === name)) {
      msg.className = 'form-msg form-msg--err';
      msg.textContent = `已存在同名书目「${name}」—— 若确实需要两本同名书，请再点一次确认`;
      if (btn.dataset.confirmed !== name) {
        btn.dataset.confirmed = name;
        return;
      }
    } else {
      btn.dataset.confirmed = '';
    }

    btn.disabled = true;
    msg.textContent = '';
    const r = await call('book.create', { projectId: state.project.id, title: name });
    btn.disabled = false;
    if (r.ok) {
      msg.className = 'form-msg form-msg--ok';
      msg.textContent = `已创建「${r.data.title}」并切换过去`;
      title.value = '';
      btn.dataset.confirmed = '';
      // ⚠ 新建后**自动选中新书** —— 否则用户接着建章节时会加到旧书上
      state.selectedBookId = r.data.id ?? state.selectedBookId;
      await loadProjects();
    } else {
      msg.className = 'form-msg form-msg--err';
      msg.textContent = r.error.message;
    }
  });

  row.append(title, btn);
  return row;
}

function renderNewChapterForm() {
  const box = el('div', 'form');
  box.append(el('h3', null, '新建章节'));
  const num = el('input');
  num.type = 'number';
  num.min = '1';
  num.value = String((state.chapters.at(-1)?.chapterNumber ?? 0) + 1);
  const title = el('input');
  title.placeholder = '标题（可选）';
  const btn = el('button', 'btn btn--primary', '创建章节');
  const msg = el('div', 'form-msg');

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    msg.textContent = '';
    const r = await tool('chapter.create', {
      bookId: state.selectedBookId,
      chapterNumber: Number(num.value),
      title: title.value.trim() || null,
    });
    btn.disabled = false;
    if (r.ok) {
      msg.className = 'form-msg form-msg--ok';
      msg.textContent = `已创建第 ${r.data.chapterNumber} 章（状态 ${r.data.status}）`;
      title.value = '';
      await loadProjects();
    } else {
      msg.className = 'form-msg form-msg--err';
      msg.textContent = r.error.message;
    }
  });

  box.append(num, title, btn, msg);
  return box;
}

function renderChapterDetail(c) {
  const ctr = $('center');
  ctr.replaceChildren();
  ctr.append(el('h2', null, `第 ${c.chapterNumber} 章`));
  if (c.title) ctr.append(el('p', 'hint', c.title));

  const meta = el('div', 'kv');
  meta.append(kv('章节 ID', c.id));
  meta.append(kv('状态', c.status));
  meta.append(kv('正文路径', c.bodyPath ?? '（尚无 —— 未提交的章节不产生正式正文）'));
  meta.append(kv('摘要', c.summary ?? '—'));
  meta.append(kv('创建时间', c.createdAt));
  ctr.append(meta);

  const note = el('div', 'callout');
  note.textContent =
    '正式正文只在 Commit 完成后写入 chapters/。' +
    '未提交章节的中间产物位于 workspace/（施工计划 §6.1）。';
  ctr.append(note);

  const back = el('button', 'btn', '返回');
  back.addEventListener('click', () => {
    renderCenter();
    renderAgent();
  });
  ctr.append(back);
}

// ─────────────────────────────────────────────────────────────
// 右栏：动作 + 诊断
// ─────────────────────────────────────────────────────────────

/**
 * 可折叠面板分组（STEP 22 UI polish）。
 *
 * ⚠ 用原生 `<details>`/`<summary>` 而不是自写折叠：
 *   原生元素自带键盘可达性（Enter/Space 切换）、无障碍语义
 *   （屏幕阅读器读作"可展开区域"）与浏览器的展开状态记忆。
 *   自写这些要额外处理，且很容易漏 —— 而漏了无障碍是看不见的缺陷。
 *
 * ⚠ 分组按**使用频率**而非功能模块：日常写作只用「写作流程」，
 *   排错才需要「系统诊断」。默认折叠诊断类，减少视觉噪声。
 */
function panelGroup(title, open) {
  const d = el('details', 'panel-group');
  if (open) d.setAttribute('open', '');
  const sum = el('summary', 'panel-group__head', title);
  d.append(sum);
  return d;
}

function renderAgent() {
  const a = $('agent');
  a.replaceChildren();

  // ⚠ 分组重排（STEP 22 UI polish）。
  //
  //   原状：14 个面板**平铺**在右栏 —— 工具列表、权限分布、模型状态
  //   与「章节规划/正文生成/审稿/提交」混在一起，用户要滚很久才能
  //   找到当前该点的按钮。而中栏大半是空的。
  //
  //   现在按**使用频率**分 4 组，诊断类默认折叠：
  //     写作流程   ← 默认展开（日常只用这一组）
  //     质量与记忆
  //     检索与上下文
  //     系统诊断   ← 默认折叠（排错时才看）
  //
  //   ⚠ 用原生 <details>/<summary> 而非自写折叠：原生元素自带
  //     键盘可达性与无障碍语义，自写要额外处理这些且容易漏。
  const g1 = panelGroup('写作流程', true);
  const g2 = panelGroup('质量与记忆', false);
  const g3 = panelGroup('检索与上下文', false);
  const g4 = panelGroup('系统诊断', false);
  a.append(g1, g2, g3, g4);

  // 诊断组：工具与权限（排错用，默认折叠）
  g4.append(el('h3', null, `已注册工具（${state.tools.length}）`));
  const list = el('div', 'tool-list');
  for (const t of state.tools) {
    const row = el('div', 'tool-row');
    row.append(el('span', 'tool-name', t.name));
    row.append(el('span', `perm perm--${t.permission.toLowerCase()}`, t.permission));
    list.append(row);
  }
  g4.append(list);

  g4.append(el('h3', null, '权限分布'));
  const perms = el('div', 'perm-summary');
  const entries = Object.entries(state.permissions).filter(([, names]) => names.length > 0);
  if (entries.length === 0) perms.append(el('div', 'empty', '—'));
  for (const [level, names] of entries) {
    perms.append(el('div', 'perm-line', `${level}: ${names.length} 个`));
  }
  g4.append(perms);

  // 模型状态（STEP 3）
  g4.append(el('h3', null, '模型'));
  const modelBox = el('div', 'model-status');
  const mc = state.modelConfig;
  if (!mc) {
    modelBox.append(el('div', 'empty', '未读取'));
  } else if (!mc.configured) {
    modelBox.append(el('div', 'perm-line', '未配置 —— 见中栏「模型设置」'));
  } else {
    for (const p of mc.profiles) {
      modelBox.append(el('div', 'perm-line', `${p.id}: ${p.model}`));
      const hasKey = mc.savedKeyRefs.includes(p.apiKeyRef);
      modelBox.append(el('div', 'perm-line', `  密钥：${hasKey ? '已保存' : '未设置'}`));
    }
    modelBox.append(el('div', 'perm-line',
      `加密：${mc.encryption?.available ? '已启用' : '不可用'}`));
  }
  if (state.lastModelTest) {
    const t = state.lastModelTest;
    modelBox.append(el('div', 'perm-line',
      t.ok ? `连通 ✓ ${t.latencyMs}ms  in=${t.usage?.inputTokens} out=${t.usage?.outputTokens}`
           : `连通 ✗ ${t.error?.code}`));
  }
  g4.append(modelBox);

  // ── Planner 面板（STEP 6） ──
  const planBox = el('div', 'form form--rail');
  planBox.append(el('h3', null, '章节规划'));
  const planMsg = el('div', 'form-msg');

  const planRow = el('div', 'btn-row');
  const planBtn = el('button', 'btn btn--primary', '规划当前章节');
  planRow.append(planBtn);
  planBox.append(planRow, planMsg);

  const planDetail = el('div', 'model-status');
  planBox.append(planDetail);

  planBtn.addEventListener('click', async () => {
    // 需要一个目标章节：取左栏第一个章节
    const first = state.chapters[0];
    if (!first) {
      planMsg.className = 'form-msg form-msg--err';
      planMsg.textContent = '还没有章节 —— 请先在中栏创建一章';
      return;
    }
    planBtn.disabled = true;
    planMsg.className = 'form-msg';
    planMsg.textContent = `正在规划第 ${first.chapterNumber} 章…（会真实调用模型）`;

    const r = await call('planner.planChapter', { chapterId: first.id });
    planBtn.disabled = false;

    if (!r.ok) {
      planMsg.className = 'form-msg form-msg--err';
      planMsg.textContent = `${r.error.code}: ${r.error.message}`;
      return;
    }
    const d = r.data;
    if (!d.ok) {
      planMsg.className = 'form-msg form-msg--err';
      // ⚠ 不要把 message 截到 80 字 —— HTTP 错误的原因（如
      //   "model 'xxx' does not exist"）常在后半段，截断后用户
      //   只知道"被拒"，不知道为何被拒。
      planMsg.textContent = `规划失败（尝试 ${d.attempts} 次）`
        + (d.error ? ` ${d.error.code}: ${d.error.message}` : '')
        + (d.issues?.length ? ` | 问题：${d.issues.join('；')}` : '');
      planDetail.replaceChildren();
      // 展示错误详情（如 HTTP 响应体），便于直接定位配置问题
      const ev = d.error && d.error.details ? d.error.details : null;
      if (ev) {
        const body = ev.body ?? ev.rawTextHead;
        if (typeof body === 'string' && body.length > 0) {
          planDetail.append(el('div', 'issue-src', `服务端返回：${body.slice(0, 400)}`));
        }
        if (typeof ev.status === 'number') {
          planDetail.append(el('div', 'issue-src', `HTTP ${ev.status}`));
        }
      }
      return;
    }

    state.lastPlan = d;
    planMsg.className = 'form-msg form-msg--ok';
    planMsg.textContent = `规划成功：${d.scenes.length} 个场景，尝试 ${d.attempts} 次，上下文 ${d.contextTokens} tokens`
      + (d.issues?.length ? `（提示 ${d.issues.length} 条）` : '');

    planDetail.replaceChildren();
    planDetail.append(el('div', 'perm-line', `目的：${d.brief.purpose}`));
    planDetail.append(el('div', 'perm-line', `状态：${d.brief.previousState} → ${d.brief.targetState}`));
    planDetail.append(el('div', 'perm-line', `角色：${d.brief.mainCharacters.join('、')}`));
    planDetail.append(el('div', 'perm-line', `钩子：${d.brief.hook}`));
    for (const sc of d.scenes) {
      planDetail.append(el('div', 'perm-line', `  · ${sc.sceneId}: ${sc.purpose}`));
    }
  });

  g1.append(planBox);

  // ── Writer 面板（STEP 7） ──
  const writeBox = el('div', 'form form--rail');
  writeBox.append(el('h3', null, '正文生成'));
  const writeMsg = el('div', 'form-msg');

  const writeRow = el('div', 'btn-row');
  const writeBtn = el('button', 'btn btn--primary', '生成草稿');
  writeRow.append(writeBtn);
  writeBox.append(writeRow, writeMsg);

  const writeDetail = el('div', 'model-status');
  writeBox.append(writeDetail);

  // 明确告知产物去向 —— 避免误以为已写入正式章节
  writeBox.append(el('div', 'perm-line', '产物写入工作区 draft.md，不碰正式章节与 Canon'));

  writeBtn.addEventListener('click', async () => {
    const first = state.chapters[0];
    if (!first) {
      writeMsg.className = 'form-msg form-msg--err';
      writeMsg.textContent = '还没有章节 —— 请先在中栏创建一章';
      return;
    }
    if (!state.lastPlan) {
      writeMsg.className = 'form-msg form-msg--err';
      writeMsg.textContent = '该章还没有计划 —— 请先点上方「规划当前章节」';
      return;
    }
    writeBtn.disabled = true;
    writeMsg.className = 'form-msg';
    writeMsg.textContent = `正在生成第 ${first.chapterNumber} 章草稿…（逐场景调用模型）`;

    const r = await call('writer.draft', { chapterId: first.id });
    writeBtn.disabled = false;

    if (!r.ok) {
      writeMsg.className = 'form-msg form-msg--err';
      writeMsg.textContent = `${r.error.code}: ${r.error.message}`;
      return;
    }
    const d = r.data;
    if (!d.ok) {
      writeMsg.className = 'form-msg form-msg--err';
      writeMsg.textContent = d.failedSceneIndex !== null
        ? `生成中断于第 ${d.failedSceneIndex + 1} 个场景（已完成部分已保留）：${d.error.code}`
        : `生成失败：${d.error.code}`;
      return;
    }

    state.lastDraft = d;
    writeMsg.className = 'form-msg form-msg--ok';
    writeMsg.textContent = `生成成功：${d.sceneCount} 个场景，${d.totalChars} 字`
      + `（输入 ${d.usage.inputTokens} / 输出 ${d.usage.outputTokens} tokens）`;

    writeDetail.replaceChildren();
    writeDetail.append(el('div', 'perm-line', `工作区：${d.draftPath.replace(/\\/g, '/').split('/').slice(-3).join('/')}`));
    writeDetail.append(el('div', 'perm-line', '状态：未提交（仅在工作区）'));

    // ⚠ 模型自报的偏离说明必须显示出来（P1）。
    //   它是"模型承认自己没按计划写"的信号 —— 不显示就等于没记。
    //   ⚠ 同时说明**已从正文剥离**：否则用户会以为正文里也有。
    if (d.deviationCount > 0) {
      const box = el('div', 'perm-line perm-line--warn');
      box.textContent = `⚠ 模型自报偏离计划 ${d.deviationCount} 处（已从正文剥离，仅作复核提示）：`;
      writeDetail.append(box);
      for (const t of d.deviations) {
        writeDetail.append(el('div', 'draft-deviation', `· ${t}`));
      }
    }

    const prev = el('div', 'draft-preview');
    prev.textContent = d.preview + (d.preview.length >= 300 ? '……' : '');
    writeDetail.append(prev);
  });

  g1.append(writeBox);

  // ── 一致性检查面板（STEP 8） ──
  const contBox = el('div', 'form form--rail');
  contBox.append(el('h3', null, '一致性检查'));
  const contMsg = el('div', 'form-msg');

  const contRow = el('div', 'btn-row');
  const contBtn = el('button', 'btn btn--primary', '检查当前章');
  contRow.append(contBtn);
  contBox.append(contRow, contMsg);
  contBox.append(el('div', 'perm-line', '只读：只报告问题，不修改草稿'));

  const contDetail = el('div', 'model-status');
  contBox.append(contDetail);

  contBtn.addEventListener('click', async () => {
    const first = state.chapters[0];
    if (!first) {
      contMsg.className = 'form-msg form-msg--err';
      contMsg.textContent = '还没有章节';
      return;
    }
    contBtn.disabled = true;
    contMsg.className = 'form-msg';
    contMsg.textContent = '正在与 Canon 对账…';

    const r = await call('continuity.check', { chapterId: first.id });
    contBtn.disabled = false;

    if (!r.ok) {
      contMsg.className = 'form-msg form-msg--err';
      contMsg.textContent = `${r.error.code}: ${r.error.message}`;
      contDetail.replaceChildren();
      return;
    }
    const d = r.data;
    state.lastContinuity = d;
    contMsg.className = d.ok ? 'form-msg form-msg--ok' : 'form-msg form-msg--err';
    contMsg.textContent = d.ok
      ? `通过：无阻塞问题（${d.warningCount} 条提示，对账 ${d.checked.canonFacts} 条 Canon / ${d.checked.characters} 个角色）`
      : `发现 ${d.blockingCount} 个阻塞问题、${d.warningCount} 条提示`;

    contDetail.replaceChildren();
    for (const i of d.issues) {
      const row = el('div', 'issue-row');
      const tag = el('span', i.severity === 'BLOCKING' ? 'tag tag--err' : 'tag tag--warn',
        i.severity === 'BLOCKING' ? '阻塞' : '提示');
      row.append(tag);
      const body = el('div', 'issue-body');
      body.append(el('div', 'issue-msg', `${i.code}【${i.dimension}】${i.message}`));
      // 出处必须展示 —— 每条问题都能被人独立复核
      body.append(el('div', 'issue-src', `出处：${i.sourceRef}`));
      row.append(body);
      contDetail.append(row);
    }
  });

  g2.append(contBox);

  // ── 审阅面板（STEP 8） ──
  const revBox = el('div', 'form form--rail');
  revBox.append(el('h3', null, '审稿'));
  const revMsg = el('div', 'form-msg');

  const revRow = el('div', 'btn-row');
  const revBtn = el('button', 'btn btn--primary', '审阅当前章');
  revRow.append(revBtn);
  revBox.append(revRow, revMsg);
  revBox.append(el('div', 'perm-line', '确定性检查 + 模型审阅；只有 BLOCKING = 0 才能提交'));
  const gateLine = el('div', 'perm-line');
  revBox.append(gateLine);

  const revDetail = el('div', 'model-status');
  revBox.append(revDetail);

  revBtn.addEventListener('click', async () => {
    const first = state.chapters[0];
    if (!first) {
      revMsg.className = 'form-msg form-msg--err';
      revMsg.textContent = '还没有章节';
      return;
    }
    revBtn.disabled = true;
    revMsg.className = 'form-msg';
    revMsg.textContent = '正在审阅…（确定性检查 + 模型）';

    const r = await call('review.run', { chapterId: first.id });
    revBtn.disabled = false;

    if (!r.ok) {
      revMsg.className = 'form-msg form-msg--err';
      revMsg.textContent = `${r.error.code}: ${r.error.message}`;
      revDetail.replaceChildren();
      return;
    }
    const d = r.data;
    state.lastReview = d;
    revMsg.className = d.canCommit ? 'form-msg form-msg--ok' : 'form-msg form-msg--err';
    revMsg.textContent = `${d.status}：${d.issueCount} 个问题`
      + `（阻塞 ${d.blockingCount}）`
      + (d.modelOk ? '' : '｜模型未参与') + (d.modelNote || '');

    revDetail.replaceChildren();
    for (const i of d.issues) {
      const row = el('div', 'issue-row');
      const cls = i.severity === 'BLOCKING' ? 'tag tag--err' : 'tag tag--warn';
      row.append(el('span', cls, i.severity === 'BLOCKING' ? '阻塞' : i.severity));
      const body = el('div', 'issue-body');
      body.append(el('div', 'issue-msg', `[${i.category}] ${i.claim}`));
      if (i.evidence.length > 0) {
        body.append(el('div', 'issue-src', `依据：${i.evidence.join('、')}`));
      }
      row.append(body);
      revDetail.append(row);
    }

    // 门禁预检：明确告诉用户"还差什么"
    const g = await call('gate.check', { chapterId: first.id });
    if (g.ok) {
      const gd = g.data;
      gateLine.textContent = gd.met
        ? '门禁：✅ 可以提交'
        : `门禁：❌ 还差 —— ${gd.missing.join('；')}`;
      gateLine.className = gd.met ? 'perm-line perm-line--ok' : 'perm-line perm-line--err';
    }
  });

  g1.append(revBox);

  // ── 事实 / Canon 面板（STEP 9） ──
  const canonBox = el('div', 'form form--rail');
  canonBox.append(el('h3', null, '事实与 Canon'));
  const canonMsg = el('div', 'form-msg');

  const canonRow = el('div', 'btn-row');
  const extractBtn = el('button', 'btn', '抽取事实');
  const promoteBtn = el('button', 'btn btn--primary', '提升为 Canon');
  const canonRefreshBtn = el('button', 'btn', '刷新');
  canonRow.append(extractBtn, promoteBtn, canonRefreshBtn);
  canonBox.append(canonRow, canonMsg);
  // 明确两步走 —— 避免误以为抽取即入库
  canonBox.append(el('div', 'perm-line', '抽取只产出候选（不写库）；提升才写事实库'));

  const canonDetail = el('div', 'model-status');
  canonBox.append(canonDetail);

  const firstChapter = () => state.chapters[0];

  async function refreshCanon() {
    const r = await call('canon.list', { bookId: state.selectedBookId });
    if (!r.ok) return;
    const d = r.data;
    state.lastCanon = d;
    canonDetail.replaceChildren();
    const line = (label, list, showValue) => {
      canonDetail.append(el('div', 'perm-line',
        `${label}：${list.length} 条`
        + (list.length && showValue ? `（${list.slice(0, 3).map((f) => `${f.subject}.${f.predicate}=${f.objectValue}`).join('；')}${list.length > 3 ? '…' : ''}）` : '')));
    };
    line('Canon', d.canon, true);
    line('待验证', d.provisional, true);
    line('冲突待裁决', d.contradicted, true);
    if (d.conflicts.length > 0) {
      canonDetail.append(el('div', 'issue-src',
        `⚠ 存在 ${d.conflicts.length} 组同主体同谓词的不同取值，需人工裁决`));
    }
  }

  extractBtn.addEventListener('click', async () => {
    const c = firstChapter();
    if (!c) { canonMsg.className = 'form-msg form-msg--err'; canonMsg.textContent = '还没有章节'; return; }
    extractBtn.disabled = true;
    canonMsg.className = 'form-msg';
    canonMsg.textContent = '正在抽取事实…';

    const r = await call('canon.extract', { chapterId: c.id });
    extractBtn.disabled = false;
    if (!r.ok) {
      canonMsg.className = 'form-msg form-msg--err';
      canonMsg.textContent = `${r.error.code}: ${r.error.message}`;
      return;
    }
    const d = r.data;
    if (!d.ok) {
      // 整批拒绝时说明原因 —— 这是"不允许部分写入"的可见性
      canonMsg.className = 'form-msg form-msg--err';
      canonMsg.textContent = `抽取被拒绝（未写入任何候选）：${d.error ? d.error.message.slice(0, 110) : ''}`
        + (d.rejected.length ? `｜首条：${d.rejected[0].reason}` : '');
      return;
    }
    canonMsg.className = 'form-msg form-msg--ok';
    canonMsg.textContent = `抽取到 ${d.proposedCount} 条候选（未写库）`
      + (d.conflictCount ? `，其中 ${d.conflictCount} 条与已有 Canon 冲突` : '');
    canonDetail.replaceChildren();
    for (const f of d.facts) {
      canonDetail.append(el('div', 'perm-line',
        `${f.subjectName}.${f.predicate} = ${f.objectValue}`
        + `（置信 ${f.confidence}${f.isDefining ? '，定义性' : ''}）`));
      canonDetail.append(el('div', 'issue-src', `引文：${f.quote.slice(0, 60)}`));
    }
  });

  promoteBtn.addEventListener('click', async () => {
    const c = firstChapter();
    if (!c) { canonMsg.className = 'form-msg form-msg--err'; canonMsg.textContent = '还没有章节'; return; }
    promoteBtn.disabled = true;
    const r = await call('canon.promote', { chapterId: c.id });
    promoteBtn.disabled = false;
    if (!r.ok) {
      canonMsg.className = 'form-msg form-msg--err';
      canonMsg.textContent = `${r.error.code}: ${r.error.message}`;
      return;
    }
    const d = r.data;
    canonMsg.className = 'form-msg form-msg--ok';
    canonMsg.textContent = `提升完成：Canon ${d.canonCount}、待验证 ${d.provisionalCount}`
      + `、冲突 ${d.contradictedCount}、跳过 ${d.skippedCount}`;
    await refreshCanon();
  });

  canonRefreshBtn.addEventListener('click', refreshCanon);

  g2.append(canonBox);

  // ── 改稿面板（补缺口）──
  const revBox2 = el('div', 'form form--rail');
  revBox2.append(el('h3', null, '改稿'));
  const revMsg2 = el('div', 'form-msg');
  const revRow2 = el('div', 'btn-row');
  const reviseBtn = el('button', 'btn btn--primary', '按审稿问题改稿');
  revRow2.append(reviseBtn);
  revBox2.append(revRow2, revMsg2);
  revBox2.append(el('div', 'perm-line', '只改被指出的问题；写 revision.md，不覆盖原稿'));
  revBox2.append(el('div', 'perm-line', '⚠ 改完必须重新审稿 —— 改稿可能引入新问题'));
  const revDetail2 = el('div', 'model-status');
  revBox2.append(revDetail2);

  reviseBtn.addEventListener('click', async () => {
    const c = firstCh();
    if (!c) {
      revMsg2.className = 'form-msg form-msg--err';
      revMsg2.textContent = '还没有章节';
      return;
    }
    reviseBtn.disabled = true;
    revMsg2.className = 'form-msg';
    revMsg2.textContent = '正在按审稿问题定向改稿（逐个问题修改）…';

    const r = await call('revision.run', { chapterId: c.id });
    reviseBtn.disabled = false;
    if (!r.ok) {
      revMsg2.className = 'form-msg form-msg--err';
      revMsg2.textContent = `${r.error.code}: ${r.error.message}`;
      return;
    }
    const d = r.data;
    if (!d.ok) {
      revMsg2.className = 'form-msg form-msg--err';
      revMsg2.textContent = `改稿失败：${d.error ? d.error.message : ''}`;
      return;
    }
    // 无阻塞问题时产品会主动跳过（改稿在"本来就能提交"时是负收益）
    if (d.skipped) {
      revMsg2.className = 'form-msg';
      revMsg2.textContent = d.reason || '无需改稿';
      revDetail2.replaceChildren();
      return;
    }
    revMsg2.className = d.appliedEdits > 0 ? 'form-msg form-msg--ok' : 'form-msg form-msg--err';
    revMsg2.textContent = d.appliedEdits > 0
      ? `已解决 ${d.resolved}/${d.totalTargets} 个问题｜应用 ${d.appliedEdits} 条替换（${d.deltaChars >= 0 ? '+' : ''}${d.deltaChars} 字） —— 请重新审稿`
      : `未做修改：${d.totalTargets} 个问题都没有可应用的替换`;
    revDetail2.replaceChildren();
    for (const o of d.outcomes) {
      revDetail2.append(el('div', 'perm-line',
        `${o.applied ? '✓ 已改' : '— 未改'}［${o.category}/${o.severity}］${
          o.applied ? `改 ${o.editCount} 处${o.canonical ? `（统一为「${o.canonical}」）` : ''}` : (o.skippedReason || '')
        }`.slice(0, 130)));
    }
    if (d.rolledBack > 0) {
      revDetail2.append(el('div', 'perm-line',
        `⚠ ${d.rolledBack} 组替换被整组回退（同一问题需多处同改，任一处匹配失败即放弃，避免只改一半）`));
    }
    // ⚠ 改稿修不了时明确告知该怎么办（否则用户只看到"提交被拦"无从下手）
    if (d.needsRegeneration) {
      revMsg2.className = 'form-msg form-msg--err';
      revMsg2.textContent = `改稿无法解决：${d.regenerationReason || '建议重新生成本章正文'}`;
      revDetail2.append(el('div', 'perm-line', '→ 建议操作：重新生成本章正文（重新写作比逐处修补更可靠）'));
    }
  });

  g1.append(revBox2);

  // ── 提交面板（STEP 11）【MVP 门槛】──
  const commitBox = el('div', 'form form--rail');
  commitBox.append(el('h3', null, '提交为正式章节'));
  const commitMsg = el('div', 'form-msg');

  const commitRow = el('div', 'btn-row');
  const precheckBtn = el('button', 'btn', '提交预检');
  const commitBtn = el('button', 'btn btn--primary', '确认提交');
  commitRow.append(precheckBtn, commitBtn);
  commitBox.append(commitRow, commitMsg);
  commitBox.append(el('div', 'perm-line', '三阶段 PREPARE→APPLY→VERIFY；中断可恢复'));

  const commitDetail = el('div', 'model-status');
  commitBox.append(commitDetail);

  const firstCh = () => state.chapters[0];

  precheckBtn.addEventListener('click', async () => {
    const c = firstCh();
    if (!c) { commitMsg.className = 'form-msg form-msg--err'; commitMsg.textContent = '还没有章节'; return; }
    const r = await call('commit.propose', { chapterId: c.id });
    if (!r.ok) {
      commitMsg.className = 'form-msg form-msg--err';
      commitMsg.textContent = `${r.error.code}: ${r.error.message}`;
      return;
    }
    const d = r.data;
    commitMsg.className = d.ready ? 'form-msg form-msg--ok' : 'form-msg form-msg--err';
    commitMsg.textContent = d.ready
      ? `可以提交（源：${d.source}）`
      : `不可提交：${d.blockers.join('；')}`;
    commitDetail.replaceChildren();
    for (const w of d.willWrite) {
      commitDetail.append(el('div', 'perm-line', `将写入 ${w.path}${w.bytes ? `（${w.bytes} 字节）` : ''}`));
    }
  });

  commitBtn.addEventListener('click', async () => {
    const c = firstCh();
    if (!c) { commitMsg.className = 'form-msg form-msg--err'; commitMsg.textContent = '还没有章节'; return; }
    commitBtn.disabled = true;
    commitMsg.className = 'form-msg';
    commitMsg.textContent = '正在提交…';

    const r = await call('commit.run', { chapterId: c.id });
    commitBtn.disabled = false;
    if (!r.ok) {
      commitMsg.className = 'form-msg form-msg--err';
      commitMsg.textContent = `${r.error.code}: ${r.error.message}`;
      return;
    }
    const d = r.data;
    state.lastCommit = d;
    commitMsg.className = d.ok ? 'form-msg form-msg--ok' : 'form-msg form-msg--err';
    commitMsg.textContent = d.ok
      ? `已提交：${d.chapterPath}（${d.phase}，${d.appliedCount} 项产物）`
      : `提交失败：${d.status} — ${d.error ? d.error.message.slice(0, 80) : ''}`;
    await refreshChapters();
  });

  g1.append(commitBox);

  // ── 检索面板（补缺口：FTS 可用） ──
  const searchBox = el('div', 'form form--rail');
  searchBox.append(el('h3', null, '检索'));
  const searchMsg = el('div', 'form-msg');

  const searchRow = el('div', 'btn-row');
  const searchInput = el('input', 'input');
  searchInput.placeholder = '检索关键词（中文）';
  const searchBtn = el('button', 'btn btn--primary', '检索');
  searchRow.append(searchInput, searchBtn);
  searchBox.append(searchRow, searchMsg);
  searchBox.append(el('div', 'perm-line', 'FTS + bm25；结果均带出处'));
  const searchDetail = el('div', 'model-status');
  searchBox.append(searchDetail);

  searchBtn.addEventListener('click', async () => {
    const q = searchInput.value.trim();
    if (!q) {
      searchMsg.className = 'form-msg form-msg--err';
      searchMsg.textContent = '请输入检索词';
      return;
    }
    searchMsg.className = 'form-msg';
    searchMsg.textContent = '检索中…';
    const r = await call('search.query', { query: q, limit: 8, bookId: state.selectedBookId });
    if (!r.ok) {
      searchMsg.className = 'form-msg form-msg--err';
      searchMsg.textContent = `${r.error.code}: ${r.error.message}`;
      return;
    }
    const d = r.data;
    state.lastSearch = d;
    searchMsg.className = 'form-msg form-msg--ok';
    searchMsg.textContent = `章节 ${d.chapters.length} 条 / 记忆 ${d.memories.length} 条`
      + `（${d.engine}，${d.tookMs}ms，词元 ${d.matchedTokens.length} 个）`;

    searchDetail.replaceChildren();
    for (const h of d.chapters) {
      searchDetail.append(el('div', 'perm-line', `[章] ${h.sourceRef}（${h.score}）`));
    }
    for (const m of d.memories) {
      searchDetail.append(el('div', 'perm-line', `[忆] ${m.sourceRef}（${m.score}）`));
    }
  });

  g3.append(searchBox);

  // ── 摘要确认面板（ADR-0006 约束 C）──
  const sumBox = el('div', 'form form--rail');
  sumBox.append(el('h3', null, '摘要确认'));
  const sumMsg = el('div', 'form-msg');
  const sumRow = el('div', 'btn-row');
  const sumGenBtn = el('button', 'btn btn--primary', '生成摘要');
  const sumRefreshBtn = el('button', 'btn', '刷新待确认');
  sumRow.append(sumGenBtn, sumRefreshBtn);
  sumBox.append(sumRow, sumMsg);
  // 必须说明为什么需要确认
  sumBox.append(el('div', 'perm-line', '未确认的摘要不进检索（摘要是长程记忆的源头）'));
  const sumDetail = el('div', 'model-status');
  sumBox.append(sumDetail);

  async function refreshPending() {
    const r = await call('summary.pending', { bookId: state.selectedBookId });
    if (!r.ok) return;
    const d = r.data;
    sumMsg.className = d.pending.length > 0 ? 'form-msg form-msg--err' : 'form-msg form-msg--ok';
    sumMsg.textContent = d.pending.length > 0
      ? `${d.pending.length} 条摘要待确认（已确认 ${d.approvedCount} 条）—— 未确认不进检索`
      : `全部已确认（${d.approvedCount} 条）`;
    sumDetail.replaceChildren();
    for (const item of d.pending) {
      const row = el('div', 'issue-row');
      const body = el('div', 'issue-body');
      body.append(el('div', 'issue-msg', `第 ${item.chapterNumber} 章：${item.summary.slice(0, 60)}`));
      const okBtn = el('button', 'btn btn--small', '确认');
      okBtn.addEventListener('click', async () => {
        okBtn.disabled = true;
        const res = await call('summary.approve', { chapterId: item.chapterId });
        if (res.ok) await refreshPending();
        else okBtn.disabled = false;
      });
      row.append(body, okBtn);
      sumDetail.append(row);
    }
  }
  sumGenBtn.addEventListener('click', async () => {
    const c = firstCh();
    if (!c) {
      sumMsg.className = 'form-msg form-msg--err';
      sumMsg.textContent = '还没有章节';
      return;
    }
    sumGenBtn.disabled = true;
    sumMsg.className = 'form-msg';
    sumMsg.textContent = '正在生成摘要（会读完本章正文）…';
    // ⚠ 生成为 _候选_，仍需在下方点「确认」才进检索
    const r = await call('summary.generate', { chapterId: c.id });
    sumGenBtn.disabled = false;
    if (!r.ok) {
      sumMsg.className = 'form-msg form-msg--err';
      sumMsg.textContent = `${r.error.code}: ${r.error.message}`;
      return;
    }
    const d = r.data;
    if (!d.ok) {
      sumMsg.className = 'form-msg form-msg--err';
      sumMsg.textContent = `摘要生成失败：${d.error ? d.error.message : ''}`;
      return;
    }
    sumMsg.className = 'form-msg form-msg--ok';
    sumMsg.textContent = `摘要已生成（未确认，尚未进检索）：${d.summary.slice(0, 50)}…`;
    sumDetail.replaceChildren();
    sumDetail.append(el('div', 'issue-msg', d.summary));
    if (d.endState) sumDetail.append(el('div', 'issue-src', `结束状态：${d.endState}`));
    for (const f of d.keyFacts ?? []) {
      sumDetail.append(el('div', 'issue-src', `· ${f}`));
    }
    await refreshPending();
  });

  sumRefreshBtn.addEventListener('click', refreshPending);

  g2.append(sumBox);

  // ── Context Engine 面板（STEP 5） ──
  const ctxBox = el('div', 'form form--rail');
  // ⚠ 标题必须是 form 内的**第一个** h3 —— 流程验证与 UI 都按它定位面板
  ctxBox.append(el('h3', null, '上下文装配'));
  const ctxMsg = el('div', 'form-msg');

  const ctxBtnRow = el('div', 'btn-row');
  const asmBtn = el('button', 'btn btn--primary', '装配上下文');
  const slotBtn = el('button', 'btn', '查看槽位');
  ctxBtnRow.append(asmBtn, slotBtn);
  ctxBox.append(ctxBtnRow, ctxMsg);

  // 两个"必须被拒绝"的演示按钮 —— 让约束可见
  const demoRow = el('div', 'btn-row');
  const obBtn = el('button', 'btn btn--danger-soft', '演示：Protected 超预算');
  const rlBtn = el('button', 'btn btn--danger-soft', '演示：无来源条目');
  demoRow.append(obBtn, rlBtn);
  ctxBox.append(demoRow);

  const ctxDetail = el('div', 'model-status');
  ctxBox.append(ctxDetail);

  asmBtn.addEventListener('click', async () => {
    asmBtn.disabled = true;
    ctxMsg.className = 'form-msg';
    ctxMsg.textContent = '装配中…';
    const r = await call('context.assemble', { bookId: state.selectedBookId });
    asmBtn.disabled = false;
    if (!r.ok) {
      ctxMsg.className = 'form-msg form-msg--err';
      ctxMsg.textContent = `${r.error.code}: ${r.error.message}`;
      return;
    }
    state.contextReport = r.data;
    const rep = r.data.report;
    ctxMsg.className = 'form-msg form-msg--ok';
    ctxMsg.textContent = `成功：总 ${rep.totalTokens} tokens（预算 ${rep.budgetTokens}）`
      + `，Protected ${rep.protectedTokens}/${rep.protectedBudgetTokens}`;

    ctxDetail.replaceChildren();
    ctxDetail.append(el('div', 'perm-line',
      `Canon ${r.data.counts.canon} 条 · 记忆 ${r.data.counts.memory} 条`));
    for (const sl of rep.slots) {
      if (sl.includedCount === 0 && sl.budgetTokens === 0) continue;
      const mark = sl.isProtected ? '🔒' : '  ';
      ctxDetail.append(el('div', 'perm-line',
        `${mark} ${sl.slot}: ${sl.includedCount} 入 / ${sl.droppedCount} 弃, ${sl.usedTokens}t`));
    }
  });

  slotBtn.addEventListener('click', async () => {
    const r = await call('context.slots', { bookId: state.selectedBookId });
    if (!r.ok) return;
    state.contextSlots = r.data.slots;
    ctxDetail.replaceChildren();
    for (const sl of r.data.slots) {
      ctxDetail.append(el('div', 'perm-line',
        `${sl.isProtected ? '🔒' : '  '} ${sl.name} (${sl.budgetTokens}t, ${sl.fillPolicy})`));
    }
  });

  obBtn.addEventListener('click', async () => {
    const r = await call('context.demoRejection', { kind: 'overBudget' });
    ctxMsg.className = r.ok ? 'form-msg form-msg--ok' : 'form-msg form-msg--err';
    ctxMsg.textContent = r.ok
      ? `✓ 已被拒绝：${r.data.error.code} — ${r.data.error.message.slice(0, 90)}`
      : `✗ 预期被拒但成功了：${r.error?.message ?? ''}`;
  });

  rlBtn.addEventListener('click', async () => {
    const r = await call('context.demoRejection', { kind: 'rootless' });
    ctxMsg.className = r.ok ? 'form-msg form-msg--ok' : 'form-msg form-msg--err';
    ctxMsg.textContent = r.ok
      ? `✓ 已被拒绝：${r.data.error.code} — ${r.data.error.message.slice(0, 90)}`
      : `✗ 预期被拒但成功了：${r.error?.message ?? ''}`;
  });

  g3.append(ctxBox);

  // 模型设置与 Runtime 面板常驻右栏 —— 不放在中栏，因为中栏会被章节详情替换，
  // 那会让用户"点进章节后再也找不到它们"（曾在本流程验证中暴露）。
  // ── 技能与备份（STEP 22 补的界面入口）──
  //
  // ⚠ STEP 17–21 把技能编译/检索与备份恢复都做完了，但界面上没有入口，
  //   只能靠 verify 脚本调用。对用户而言"后端有、界面没有" = 没有。
  const skillMsg = el('div', 'form-msg');
  g2.append(renderSkillPanel({ el, state, invoke: call, msg: skillMsg }));

  // ── 语料导入与蒸馏（§16 §58 §61）──
  //
  // ⚠ 此前**完全没有这个入口** —— 导入只存在于 verify-books.mjs
  //   （硬编码书单），用户无法导入自己的小说。
  const corpusMsg = el('div', 'form-msg');
  g2.append(renderCorpusPanel({ el, invoke: call, msg: corpusMsg }));

  const backupMsg = el('div', 'form-msg');
  g3.append(renderBackupPanel({ el, invoke: call, msg: backupMsg }));

  g4.append(renderRuntimePanel());
  g4.append(renderModelSettings());

  g4.append(el('h3', null, '最近一次工具调用'));
  const diag = el('div', 'diag');
  if (!state.lastCall) {
    diag.textContent = '（尚未调用）';
  } else {
    const { name, result, at } = state.lastCall;
    diag.textContent = [
      `工具: ${name}`,
      `时间: ${at}`,
      `结果: ${result.ok ? '成功' : `失败 ${result.error.code}`}`,
      result.ok ? '' : `消息: ${result.error.message}`,
    ].filter(Boolean).join('\n');
  }
  g4.append(diag);
}

// ─────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────

async function boot() {
  const info = await window.nwa.appInfo();
  $('ver').textContent = `Electron ${info.electron} · Node ${info.node}`;

  const open = await call('project.open', {});
  if (!open.ok) {
    $('center').replaceChildren(el('div', 'empty', `打开项目失败：${open.error.message}`));
    return;
  }
  await loadModelConfig();
  await loadProjects();
  await loadRunStatus();
}

window.nwa.onCoreExited((p) => {
  const d = $('agent');
  if (d) {
    d.prepend(el('div', 'callout callout--err',
      `core 进程已退出（code ${p.code}）—— UI 存活，验证了 ADR-0001 的进程隔离`));
  }
});

boot().catch((e) => {
  $('center').replaceChildren(el('div', 'empty', `启动失败：${e.message}`));
});

// 供 GUI 探针读取
window.__nwaState = state;
