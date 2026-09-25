/**
 * Electron 主进程（ADR-0001 进程架构）
 *
 * 硬约束：
 *   主进程**不执行 SQLite 查询、不调用 LLM**，只做窗口生命周期与 IPC 路由。
 *   所有领域工作交给 utilityProcess "novel-core"。
 *
 * 理由（施工文档 §66）：单章长任务「允许几十分钟级」，
 * 若在主进程执行会阻塞 IPC 与窗口事件响应。
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import { Logger } from '@nwa/core';
import { FileSecretStore, defaultCredentialsPath } from '@nwa/harness';
import { IPC } from '../shared/ipc.js';

const here = dirname(fileURLToPath(import.meta.url));
const logger = new Logger('main');

let win: BrowserWindow | null = null;
let core: UtilityProcess | null = null;

/** 记录主进程到 core 的请求，用于把 core 的响应路由回渲染进程 */
const pending = new Map<string, (payload: unknown) => void>();

/**
 * 向 core 发一次请求（与 IPC 路由共用同一条通道）。
 *
 * ⚠ 抽出来是为了让 autosave 调度器能在**没有 renderer 参与**的情况下
 *   把内容落盘 —— 这正是 M5 的全部意义。
 */
function callCore(method: string, params?: unknown): Promise<unknown> {
  if (!core) {
    return Promise.resolve({
      ok: false,
      error: { code: 'WORKSPACE_CORRUPTED', message: 'core 进程未运行' },
    });
  }
  const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    core!.postMessage({ kind: 'request', requestId, method, params });
  });
}

// ─────────────────────────────────────────────────────────────
// M5：autosave 的 debounce **在主进程**（§八 / §十二）
//
// ⚠ 为什么不在 renderer 里 debounce（本节最关键的一处决策）
//
//   autosave 存在的唯一理由是"防止丢失"。而最常见的丢失场景正是
//   **renderer 自己崩掉**（OOM、页面异常、长章节渲染卡死）。
//   若 debounce 定时器活在 renderer 里，它随页面一起死 ——
//   恰好在最需要它的时候不工作。
//
//   放在主进程则不同：renderer 死了，主进程还在，定时器照常触发，
//   内容照样落盘。用户重开时就能看到"发现未恢复的编辑内容"。
//
//   代价：renderer 每次输入都要推一次文本（跨进程拷贝）。
//   权衡下来这是对的 —— 几百 KB 的拷贝远比丢掉作者刚写的三千字便宜。
// ─────────────────────────────────────────────────────────────

/** debounce 间隔（§八 建议 500–2000ms） */
const AUTOSAVE_DEBOUNCE_MS = 1500;

/** 每个章节一个待落盘的 pending 快照（按 chapterId 分组） */
interface PendingAutosave {
  chapterId: string;
  text: string;
  cursor: number;
  selectionStart: number;
  selectionEnd: number;
  scrollTop: number;
  timer: NodeJS.Timeout;
}
const pendingAutosaves = new Map<string, PendingAutosave>();

/** 组装落盘参数（三处调用共用，避免字段漏传） */
function autosaveParams(p: {
  chapterId: string;
  text: string;
  cursor?: number;
  selectionStart?: number;
  selectionEnd?: number;
  scrollTop?: number;
}): Record<string, unknown> {
  return {
    chapterId: p.chapterId,
    text: p.text,
    cursor: p.cursor ?? 0,
    selectionStart: p.selectionStart ?? p.cursor ?? 0,
    selectionEnd: p.selectionEnd ?? p.cursor ?? 0,
    scrollTop: p.scrollTop ?? 0,
  };
}

/**
 * 记录一次待落盘的编辑（renderer 每次输入调用）。
 *
 * ⚠ 同章节的后续调用**覆盖**前一个快照并重置定时器 —— 这才是 debounce。
 *   若改成排队，作者快速敲字会在队列里堆出几十个中间版本，
 *   只有最后一次是有意义的，前面全是无谓的磁盘写入。
 */
function scheduleAutosave(payload: {
  chapterId: string;
  text: string;
  cursor?: number;
  selectionStart?: number;
  selectionEnd?: number;
  scrollTop?: number;
}): void {
  const prev = pendingAutosaves.get(payload.chapterId);
  if (prev) clearTimeout(prev.timer);

  const timer = setTimeout(() => {
    pendingAutosaves.delete(payload.chapterId);
    void callCore('manuscript.autosave', autosaveParams(payload)).then((r) => {
      const res = r as { ok?: boolean; error?: { message?: string } } | undefined;
      if (res && res.ok === false) {
        // ⚠ 失败必须留日志：autosave 是静默的，没有日志就毫无痕迹。
        logger.warn('autosave 落盘失败', {
          chapterId: payload.chapterId,
          error: res.error?.message,
        });
      }
    });
  }, AUTOSAVE_DEBOUNCE_MS);

  pendingAutosaves.set(payload.chapterId, { ...autosaveParams(payload), timer } as PendingAutosave);
}

/**
 * 立即把待落盘内容写掉（切章 / 关窗 / renderer 崩溃时调用）。
 *
 * ⚠ 调用方**必须 await**：关窗流程要等它写完才能退出，
 *   否则进程先没了、内容还在内存里 —— 那正是它要防的事。
 */
async function flushAutosave(chapterId?: string): Promise<void> {
  const targets = [...pendingAutosaves.values()].filter(
    (t) => chapterId === undefined || t.chapterId === chapterId,
  );
  if (targets.length === 0) return;

  for (const t of targets) {
    clearTimeout(t.timer);
    pendingAutosaves.delete(t.chapterId);
  }
  await Promise.all(
    targets.map((t) => callCore('manuscript.autosave', autosaveParams(t))),
  );
  logger.info('已 flush 未落盘的自动保存', { count: targets.length });
}

function startCoreProcess(): void {
  const coreEntry = join(here, 'core-process.js');
  logger.info('启动 core utilityProcess', { entry: coreEntry });

  core = utilityProcess.fork(coreEntry, [], {
    serviceName: 'novel-core',
    // 子进程 stdout/stderr 转发到主进程，便于统一日志
    stdio: 'pipe',
  });

  core.stdout?.on('data', (d: Buffer) => process.stdout.write(`[core] ${d.toString()}`));
  core.stderr?.on('data', (d: Buffer) => process.stderr.write(`[core] ${d.toString()}`));

  core.on('message', (msg: CoreMessage) => {
    if (msg.kind === 'ready') {
      // core 就绪时告知加密后端状态（safeStorage 只有 main 能查询）
      core?.postMessage({
        kind: 'encryption-info',
        available: safeStorage.isEncryptionAvailable(),
      });
      return;
    }
    if (msg.kind === 'response') {
      const resolve = pending.get(msg.requestId);
      if (resolve) {
        pending.delete(msg.requestId);
        resolve(msg.payload);
      }
      return;
    }
    if (msg.kind === 'event') {
      // 领域事件广播给渲染进程（Run 状态、进度）
      win?.webContents.send(IPC.CORE_EVENT, msg.payload);
      return;
    }
    if (msg.kind === 'crypto-request') {
      // safeStorage 只有 main 进程能用（ADR-0001 的进程边界）。
      // core 侧发来加密请求，这里执行并把结果回传。
      void handleCryptoRequest(msg.requestId, msg.op, msg.payload);
      return;
    }
  });

  core.on('exit', (code) => {
    logger.warn('core utilityProcess 已退出', { code });
    // 崩溃不影响 UI 存活；恢复由 STEP 11 的 Repair 处理
    core = null;
    win?.webContents.send(IPC.CORE_EXITED, { code });
  });
}

interface CoreMessage {
  readonly kind: 'response' | 'event' | 'crypto-request' | 'ready';
  readonly requestId: string;
  readonly payload: unknown;
  readonly op?: string;
}

/**
 * 主进程侧的密钥存储。
 *
 * ⚠ 为什么密钥文件由 main 进程持有而不是 core：
 *   `safeStorage` 是 main 进程模块，utilityProcess 拿不到。
 *   因此加解密与文件读写都放在这里，core 只持有引用名。
 *   这同时带来一个安全收益：core（跑 LLM 调用的地方）无法绕过解密直接读盘。
 */
let secretStore: FileSecretStore | null = null;

function getSecretStore(): FileSecretStore {
  if (!secretStore) {
    secretStore = new FileSecretStore(defaultCredentialsPath(homedir()), {
      name: 'electron-safeStorage',
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (cipher) => safeStorage.decryptString(cipher),
    });
  }
  return secretStore;
}

async function handleCryptoRequest(requestId: string, op: string | undefined, payload: unknown): Promise<void> {
  const reply = (ok: boolean, value?: unknown, error?: string) => {
    core?.postMessage({ kind: 'crypto-response', requestId, ok, value, error });
  };
  try {
    const store = getSecretStore();
    const p = (payload ?? {}) as { ref?: string; value?: string };
    switch (op) {
      case 'get':
        reply(true, await store.get(String(p.ref)));
        break;
      case 'set':
        await store.set(String(p.ref), String(p.value));
        reply(true, undefined);
        break;
      case 'delete':
        await store.delete(String(p.ref));
        reply(true, undefined);
        break;
      case 'listRefs':
        reply(true, await store.listRefs());
        break;
      default:
        reply(false, undefined, `未知的加密操作：${op}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('加密请求失败', err, { op });
    reply(false, undefined, message);
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#111318',
    show: false,
    webPreferences: {
      preload: join(here, '../preload/preload.cjs'),
      // ADR-0001：渲染进程不得直接访问 Node
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win?.show());

  const rendererPath = join(here, '../renderer/index.html');
  void win.loadFile(rendererPath);

  // GUI 探针：仅在环境变量开启时启用（CI/验收用），生产路径不受影响。
  if (process.env.NWA_GUI_PROBE === '1') {
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        void win?.webContents
          .executeJavaScript(`(() => {
            const panes = document.querySelectorAll('.pane').length;
            const toolRows = document.querySelectorAll('.tool-row').length;
            const navSections = document.querySelectorAll('.nav-section').length;
            const forms = document.querySelectorAll('.form').length;
            const errors = [...document.querySelectorAll('.form-msg--err, .callout--err')]
              .map(e => e.textContent);
            // ⚠ P1 Workflow UI：面板必须真的渲染出来。
            //   只断言"没报错"是不够的 —— 面板没被挂载时页面同样干净，
            //   那正是"后端有、界面够不到"这类缺陷的表现。
            const wfPanel = [...document.querySelectorAll('.form--rail h3')]
              .some(h => h.textContent.includes('工作流'));
            const wfStageRows = document.querySelectorAll('.wf-stage').length;
            const wfButtons = [...document.querySelectorAll('.btn')]
              .filter(b => /运行完整工作流|暂停|恢复|取消/.test(b.textContent))
              .map(b => b.textContent);
            return {
              paneCount: panes, toolCount: toolRows, navSectionCount: navSections,
              formCount: forms, errorTexts: errors,
              workflowPanelPresent: wfPanel,
              workflowStageRows: wfStageRows,
              workflowButtons: wfButtons,
              version: document.getElementById('ver')?.textContent ?? '',
              brand: document.querySelector('.brand')?.textContent ?? '',
            };
          })()`)
          .then((result) => {
            const out = {
              ...result,
              // 三栏齐全 + 8 个工具已注册 + 至少一个表单 + 无错误提示
              pass: result.paneCount === 3
                && result.toolCount >= 8
                && result.formCount >= 1
                && result.errorTexts.length === 0
                // 工作流面板与四个控制按钮都在（缺任一说明面板没挂上）
                && result.workflowPanelPresent === true
                && result.workflowButtons.length >= 4,
            };
            writeFileSync(join(here, '../gui-result.json'), JSON.stringify(out, null, 2), 'utf8');
            logger.info('GUI 探针完成', { pass: out.pass, toolCount: out.toolCount });
            app.exit(out.pass ? 0 : 1);
          })
          .catch((err: unknown) => {
            logger.error('GUI 探针执行失败', err);
            app.exit(1);
          });
      }, 3500);
    });
  }

  // GUI 流程验证：驱动真实 DOM 走完「新建项目 → 书目 → 章节」。
  if (process.env.NWA_GUI_FLOW === '1') {
    win.webContents.on('did-finish-load', () => {
      // 等 boot() 完成（它会打开项目并渲染首屏）
      setTimeout(async () => {
        const steps: { name: string; ok: boolean; detail?: string }[] = [];
        const record = (name: string, ok: boolean, detail?: string) => {
          steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
          logger.info(`flow: ${name} ${ok ? 'OK' : 'FAIL'}`, { detail });
        };

        // ⚠ renderer 读不到磁盘，而 §43 进度条的判据**就是工作区文件是否存在**。
        //   所以把文件清单注入页面，让断言能独立验算「后端报的步骤」
        //   与「磁盘上真实有的产物」是否一致 —— 只查 DOM 文字
        //   等于只验证了后端自己说的话。
        // ⚠ main.ts 拿不到 core-process 的 PROJECTS_ROOT（两个进程），
        //   按同一环境变量约定自行解析 —— 验证脚本已注入 NWA_PROJECTS_ROOT。
        const projectsRoot = process.env['NWA_PROJECTS_ROOT']
          ?? join(homedir(), 'NovelWriterProjects');

        // ⚠ 按书隔离（P0-1）：工作区在 books/<bookId>/workspace/chapter-001。
        //   不扫项目根的 workspace/（那是旧布局，新项目下恒为空 ——
        //   会让"探针读到文件"这条恒假，而它正是防空转通过的守卫）。
        //   书 id 不硬编码：遍历 books/ 取第一本即可（验证项目里只有一本）。
        // ⚠ 必须**延迟解析**：这段代码在流程跑之前执行，而工作区目录
        //   是流程中间才创建的。提前解析会缓存一个不存在的路径，
        //   导致流程结束后仍读空目录 —— 守卫恒假。
        const resolveWsChapterDir = (): string => {
          const booksDir = join(projectsRoot, 'books');
          if (existsSync(booksDir)) {
            for (const b of readdirSync(booksDir)) {
              const d = join(booksDir, b, 'workspace', 'chapter-001');
              if (existsSync(d)) return d;
            }
          }
          // 兼容尚未迁移的旧布局（项目根）
          const legacy = join(projectsRoot, 'workspace', 'chapter-001');
          if (existsSync(legacy)) return legacy;
          // 还没有任何工作区 → 返回一个不存在的路径，files 为空，
          // 守卫会如实报 FAIL（而不是静默通过）
          return join(projectsRoot, 'books', '__none__', 'workspace', 'chapter-001');
        };
        const wsChapterDir = resolveWsChapterDir();
        const wsFiles = existsSync(wsChapterDir) ? readdirSync(wsChapterDir) : [];

        try {
          const flow = `(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const $ = (id) => document.getElementById(id);
            const btnByText = (root, text) =>
              [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text);
            const setInput = (inp, v) => {
              inp.value = v;
              inp.dispatchEvent(new Event('input', { bubbles: true }));
            };
            const steps = [];
            const rec = (name, ok, detail) => steps.push({ name, ok, detail });
            // §43 进度条自报的已完成步骤（带出页面，交给主进程与磁盘比对）
            let pipelineDone = [];
            let pipelineLabels = [];

            // 等首屏渲染完成
            for (let i = 0; i < 40 && !document.querySelector('.form'); i++) await sleep(250);

            // 1) 三栏 + 工具清单
            rec('三栏渲染', document.querySelectorAll('.pane').length === 3,
                'panes=' + document.querySelectorAll('.pane').length);
            const toolsBefore = document.querySelectorAll('.tool-row').length;
            rec('工具已注册', toolsBefore >= 8, 'tools=' + toolsBefore);

            // 2) 新建项目
            const projForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('新建项目'));
            if (!projForm) { rec('找到新建项目表单', false); return { steps }; }
            const name = document.title + '-项目-' + Date.now();
            setInput(projForm.querySelectorAll('input')[0], name);
            setInput(projForm.querySelectorAll('input')[1], 'urban_fantasy');
            btnByText(projForm, '创建项目').click();
            await sleep(1800);
            const projMsg = projForm.querySelector('.form-msg')?.textContent ?? '';
            rec('新建项目', projMsg.includes('已创建'), projMsg);

            // 3) 新建书目（首个项目创建后中栏会出现该书目表单）
            await sleep(400);
            const bookForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('新建书目'));
            if (!bookForm) { rec('找到新建书目表单', false, '中栏表单未出现'); return { steps }; }
            rec('找到新建书目表单', true);
            setInput(bookForm.querySelectorAll('input')[0], '测试小说');
            btnByText(bookForm, '创建书目').click();
            await sleep(1800);
            const bookMsg = bookForm.querySelector('.form-msg')?.textContent ?? '';
            rec('新建书目', bookMsg.includes('已创建'), bookMsg);

            // 4) 新建章节
            await sleep(400);
            const chForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('新建章节'));
            if (!chForm) { rec('找到新建章节表单', false); return { steps }; }
            rec('找到新建章节表单', true);
            setInput(chForm.querySelectorAll('input')[1], '第一章 开端');
            btnByText(chForm, '创建章节').click();
            await sleep(1800);
            const chMsg = chForm.querySelector('.form-msg')?.textContent ?? '';
            rec('新建章节', chMsg.includes('已创建'), chMsg);

            // 5) 章节出现在左栏，且状态为草稿
            await sleep(500);
            const chapterItems = [...document.querySelectorAll('.nav-item--chapter')];
            rec('章节出现在左栏', chapterItems.length >= 1, 'chapters=' + chapterItems.length);
            const chipText = chapterItems[0]?.querySelector('.chip')?.textContent ?? '';
            rec('章节状态标签为草稿', chipText === '草稿', 'chip=' + chipText);

            // 6) 点击章节可查看详情，且正文路径为空（未提交）
            chapterItems[0]?.click();
            await sleep(600);
            const detailText = $('center')?.textContent ?? '';
            rec('章节详情可打开', detailText.includes('第 1 章'), '');
            rec('未提交章节无正式正文', detailText.includes('未提交的章节不产生正式正文'), '');

            // 6b) M4：Manuscript 编辑器（§六 §九 §二十七 §二十八 §三十）
            //     ⚠ 本区块内禁止出现反引号（工程约定 1）—— 外层是模板字面量。
            await sleep(900);
            const editor = document.querySelector('.editor');
            rec('编辑器已挂载', !!editor, '');
            if (editor) {
              const area = editor.querySelector('.editor__area');
              rec('编辑器有文本区', !!area, '');
              rec('文本区初值为空（未提交章节尚无正文）',
                  (area?.value ?? 'x') === '', 'value=' + JSON.stringify(area?.value ?? ''));

              const saveStatus = editor.querySelector('.save-status');
              rec('显示保存状态（五态之一）',
                  !!saveStatus && /已保存|未保存|保存中|保存失败|未恢复/.test(saveStatus.textContent),
                  saveStatus?.textContent ?? '');
              rec('初始状态为已保存',
                  (saveStatus?.textContent ?? '').includes('已保存'), saveStatus?.textContent ?? '');

              const stats = [...editor.querySelectorAll('.editor__stat')].map(n => n.textContent);
              rec('显示字数与段落数', stats.some(t => /\\d+ 字/.test(t)) && stats.some(t => /\\d+ 段/.test(t)),
                  stats.join(' | '));

              const bar = editor.querySelector('.editor__bar');
              const barBtns = bar ? [...bar.querySelectorAll('button')].map(b => b.textContent.trim()) : [];
              rec('工具栏含保存/预览', barBtns.includes('保存') && barBtns.includes('预览'), barBtns.join('/'));

              // §三十：保存与提交到正史必须明显区分（文案 + 样式类）
              const commitBtn = bar ? [...bar.querySelectorAll('button')].find(b => b.textContent.includes('提交到正史')) : null;
              const saveBtn = bar ? [...bar.querySelectorAll('button')].find(b => b.textContent.trim() === '保存') : null;
              rec('有「提交到正史」按钮且文案写明走检查',
                  !!commitBtn && commitBtn.textContent.includes('走检查'), commitBtn?.textContent ?? '');
              rec('保存与提交样式类不同（§三十）',
                  !!saveBtn && !!commitBtn && saveBtn.className !== commitBtn.className,
                  (saveBtn?.className ?? '') + ' vs ' + (commitBtn?.className ?? ''));

              // 真实操作：输入 → 字数变化 → 保存 → 状态回到已保存
              const setArea = (v) => {
                area.value = v;
                area.dispatchEvent(new Event('input', { bubbles: true }));
              };
              setArea('雨落在青石板上。\\n\\n他没有回头。');
              await sleep(700);
              const statsAfter = [...editor.querySelectorAll('.editor__stat')].map(n => n.textContent);
              rec('输入后字数已更新', statsAfter.some(t => t.includes('字') && !t.startsWith('0 字') && !t.startsWith('—')),
                  statsAfter.join(' | '));
              rec('输入后段落数为 2', statsAfter.some(t => t === '2 段'), statsAfter.join(' | '));

              const stDirty = editor.querySelector('.save-status');
              rec('输入后状态变为未保存',
                  (stDirty?.textContent ?? '').includes('未保存'), stDirty?.textContent ?? '');

              // 视图切换（§六：单一文本源 + 视图切换）
              const viewBtn = bar ? [...bar.querySelectorAll('button')].find(b => b.textContent.trim() === '预览') : null;
              viewBtn?.click();
              await sleep(400);
              const preview = editor.querySelector('.editor__preview');
              rec('预览显示 2 个段落',
                  !!preview && !preview.hidden && preview.querySelectorAll('.editor__para').length === 2,
                  'paras=' + (preview?.querySelectorAll('.editor__para').length ?? -1));
              const backBtn = bar ? [...bar.querySelectorAll('button')].find(b => b.textContent.trim() === '编辑') : null;
              backBtn?.click();
              await sleep(300);

              // 保存（§二：保存不得进入 Canon）
              saveBtn?.click();
              await sleep(1200);
              const stSaved = editor.querySelector('.save-status');
              rec('保存后状态回到已保存',
                  (stSaved?.textContent ?? '').includes('已保存'), stSaved?.textContent ?? '');
              const saveMsg = editor.querySelector('.form-msg')?.textContent ?? '';
              rec('保存提示明确说明未提交', saveMsg.includes('未提交') || saveMsg.includes('不影响正史'), saveMsg);
              rec('⚠ 保存提示不出现 undefined（字数须来自 metrics 口径）', !saveMsg.includes('undefined'), saveMsg);

              // ⚠ §二 的下游终点断言：保存后章节状态仍是草稿、仍无正式正文
              const chapterChip = document.querySelector('.nav-item--chapter .chip')?.textContent ?? '';
              rec('⚠ 保存后章节状态仍为草稿（SAVE != COMMIT）', chapterChip === '草稿', 'chip=' + chapterChip);
              const detailAfter = $('center')?.textContent ?? '';
              rec('⚠ 保存后仍无正式正文（未进 Canon）',
                  detailAfter.includes('未提交的章节不产生正式正文'), '');

              // 6c) M6：版本节点（§十三 §十四）
              //     ⚠ 本区块内禁止出现反引号（工程约定 1）。
              //     走**渲染进程真实桥**而不是直接调仓储 ——
              //     上一轮「undefined 字」正是只有真 GUI 路径才暴露。
              const cid = chapterItems[0]?.dataset?.chapterId ?? '';
              rec('章节节点带 chapterId（版本操作的前提）', cid.length > 0, 'cid=' + cid);

              // ⚠ IPC 返回的是信封 { ok, data }（与 renderer 的 call() 一致）——
              //   本文件第一版直接读 r.versions 得到 0 条，断言"失败"而库里其实有数据。
              //   断言读错层级会得到假红（比假绿好，但同样是在报错误的东西）。
              const callIpc = async (m, prm) => {
                const r = await window.nwa.invoke(m, prm);
                return (r && r.ok) ? r.data : null;
              };

              const verList = await callIpc('manuscript.listVersions', { chapterId: cid });
              const vers = verList?.versions ?? [];
              rec('⚠ 手动保存后产生版本节点', vers.length >= 1, 'versions=' + vers.length);
              rec('⚠ 版本来源为 USER_EDIT（手动保存）',
                  vers[0]?.sourceType === 'USER_EDIT', 'source=' + (vers[0]?.sourceType ?? ''));
              rec('⚠ 版本带内容 hash（判重与锚点的依据）',
                  typeof vers[0]?.contentHash === 'string' && vers[0].contentHash.length === 64,
                  'hash=' + String(vers[0]?.contentHash ?? ''));

              // 内容未变再保存一次 → 不产生新版本（hash 判重）
              saveBtn?.click();
              await sleep(1200);
              const verList2 = await callIpc('manuscript.listVersions', { chapterId: cid });
              rec('⚠ 内容未变时重复保存不产生新版本',
                  (verList2?.versions ?? []).length === vers.length,
                  'before=' + vers.length + ' after=' + ((verList2?.versions ?? []).length));

              // §十三：版本正文落文件且可读回
              if (vers[0]) {
                const vr = await callIpc('manuscript.readVersion', { versionId: vers[0].id });
                rec('⚠ 版本正文可读回且非空',
                    typeof vr?.text === 'string' && vr.text.length > 0,
                    'missing=' + String(vr?.missing) + ' len=' + (vr?.text ? vr.text.length : -1));
              }

              // §十三：恢复到历史版本 → 正文变回该版本内容，且**不碰 Canon**
              if (vers[0]) {
                setArea('这是被改坏的新内容。');
                await sleep(600);
                saveBtn?.click();
                await sleep(1200);
                const verList3 = await callIpc('manuscript.listVersions', { chapterId: cid });
                rec('改动后产生第二个版本节点',
                    (verList3?.versions ?? []).length === vers.length + 1,
                    'versions=' + ((verList3?.versions ?? []).length));

                // 恢复到 v001
                const target = (verList3?.versions ?? []).find(v => v.seq === 1);
                if (target) {
                  const rr = await callIpc('manuscript.restoreVersion', { versionId: target.id });
                  rec('⚠ 恢复历史版本成功', !!rr, 'ok=' + String(!!rr));
                  rec('⚠ 恢复后正文变回该版本内容',
                      (rr?.text ?? '').indexOf('雨落') >= 0, 'len=' + (rr?.text ? rr.text.length : -1));
                  const chipAfter = document.querySelector('.nav-item--chapter .chip')?.textContent ?? '';
                  rec('⚠ 恢复后章节状态仍为草稿（恢复 != 提交）',
                      chipAfter === '草稿', 'chip=' + chipAfter);
                }
              }
            }

            // 7) 模型设置面板（STEP 3）—— 常驻右栏，故在章节详情打开后仍应存在
            const modelForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('模型设置'));
            rec('模型设置面板常驻（章节详情打开后仍在）', !!modelForm, '');

            // ⚠⚠ 只查"在不在 DOM 里"是不够的 —— 折叠组里的面板照样在 DOM 里，
            //   但用户**看不见**。上一轮 STEP 22 分组后模型设置被放进
            //   「系统诊断」组（默认折叠），用户实测反馈"模型配置 UI 不见了"，
            //   而旧断言一直通过。可见性必须单独断言。
            if (modelForm) {
              const closedAncestor = modelForm.closest('details:not([open])');
              rec('⚠⚠ 模型设置面板对用户**可见**（不在折叠组里）',
                  closedAncestor === null,
                  closedAncestor
                    ? '被折叠在：' + (closedAncestor.querySelector('summary')?.textContent ?? '?')
                    : '可见');
            }
            if (modelForm) {
              // ⚠ 「设为全部槽位的默认模型」必须**可见可改**。
              //   原先渲染端硬编码 useForAllSlots:true —— 每保存一个 profile
              //   就静默把四个槽位全改指向它，界面上毫无提示。
              const slotBox = modelForm.querySelector('#use-for-all-slots');
              rec('⚠ 槽位接管开关可见（不再静默抢走槽位）', Boolean(slotBox),
                  slotBox ? 'type=' + slotBox.type + ' checked=' + slotBox.checked : '缺失');
              const slotLbl = slotBox
                ? modelForm.querySelector('label[for="use-for-all-slots"]') : null;
              rec('⚠ 槽位接管开关有可读标签', Boolean(slotLbl && slotLbl.textContent.length > 4),
                  slotLbl ? slotLbl.textContent : '无标签');

              const labels = [...modelForm.querySelectorAll('.form-label')].map(l => l.textContent);
              rec('含 endpoint / 模型名 / API Key 三项',
                  labels.some(l => l.includes('Endpoint')) &&
                  labels.some(l => l.includes('模型名')) &&
                  labels.some(l => l.includes('API Key')),
                  labels.join('/'));
              const pwd = [...modelForm.querySelectorAll('input')].find(i => i.type === 'password');
              rec('API Key 为密码输入框', !!pwd, '');
              const encText = modelForm.textContent;
              rec('显示密钥加密状态',
                  encText.includes('已启用') || encText.includes('不可用'), '');
              const testBtn = btnByText(modelForm, '测试连通');
              rec('有连通测试按钮', !!testBtn, '');
            }

            // 8) Agent Runtime 面板（STEP 4）
            const rtForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('Agent 与状态机'));
            rec('Agent Runtime 面板存在', !!rtForm, '');
            if (rtForm) {
              const txt = rtForm.textContent;
              rec('显示 Agent 可用状态', txt.includes('就绪') || txt.includes('需先配置模型'), '');
              // 权限表：reviewer 应为 READ
              const permRows = [...rtForm.querySelectorAll('.perm')].map(p => p.textContent.trim());
              rec('展示各 Agent 权限', permRows.length >= 4, permRows.join(','));
              rec('⚠ 审查类 Agent 权限为 READ', permRows.includes('READ'), permRows.join(','));
              const probeBtn = btnByText(rtForm, '运行探针 Agent');
              rec('有探针运行按钮', !!probeBtn, '');
              const smBtn = btnByText(rtForm, '查看状态机（DRAFT）');
              rec('有状态机查看按钮', !!smBtn, '');
              if (smBtn) {
                smBtn.click();
                await sleep(800);
                const smTxt = rtForm.textContent;
                // 状态机面板应展示 DRAFT 的合法目标，并证明非法迁移被拒
                rec('状态机展示合法迁移', smTxt.includes('DRAFT →'), '');
                rec('⚠ 非法迁移被拒并说明原因',
                    smTxt.includes('被拒') || smTxt.includes('非法状态迁移'), '');
              }
            }

            // 9) Context Engine 面板（STEP 5）
            const ctxForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('上下文装配'));
            rec('Context 面板存在', !!ctxForm, '');
            if (ctxForm) {
              const asmBtn = btnByText(ctxForm, '装配上下文');
              rec('有装配按钮', !!asmBtn, '');
              if (asmBtn) {
                asmBtn.click();
                // 轮询等待结果文案出现，而不是固定 sleep —— 固定 sleep 会读到
                // 点击前的文本（"装配中…"），产生假失败（实测踩到）
                let msgText = '';
                for (let i = 0; i < 30; i++) {
                  await sleep(200);
                  const m = ctxForm.querySelector('.form-msg')?.textContent ?? '';
                  if (m.includes('成功') || m.includes('失败') || m.includes('CONTEXT_')) {
                    msgText = m;
                    break;
                  }
                }
                // ⚠ 必须**重新查询**面板：前面的步骤调用过 renderAgent()，
                //   它会重建右栏 DOM，使先前持有的 ctxForm 成为游离节点 ——
                //   在游离节点上读 textContent 会拿不到新内容（实测踩到）。
                const liveCtx = [...document.querySelectorAll('.form')]
                  .find(f => f.querySelector('h3')?.textContent.includes('上下文装配'));
                const t = liveCtx ? liveCtx.textContent : '';
                // ⚠ 本段代码位于外层的模板字符串内，因此不能使用反引号或美元花括号插值，
                //   否则会被外层模板提前求值（曾导致 TS 编译失败，且被 tsc -b 的
                //   增量缓存掩盖成"typecheck 通过"）。故改用字符串拼接。
                const snippet = (t.match(/总[^，]{0,40}/) || ['(未匹配到 总)'])[0];
                // ⚠ 正则里不能写反斜杠转义：本段代码在外层模板字符串内，
                //   \\s 会被传成字面量 "\\s"（在浏览器里匹配反斜杠+s，而非空白），
                //   导致断言永远为 false（实测踩到，排查了多轮）。
                //   改用不含反斜杠的等价写法。
                const hasTotal = t.indexOf('总') >= 0 && t.indexOf('tokens') >= 0
                  && /[0-9]+/.test(t);
                rec('装配成功并显示 token 统计', hasTotal,
                    'msg=' + msgText.slice(0, 50) + ' | panelSnip=' + snippet + ' | panelLen=' + t.length);
                rec('显示 Protected 占用', t.includes('Protected'), '');
              }

              const slotBtn = btnByText(ctxForm, '查看槽位');
              if (slotBtn) {
                slotBtn.click();
                await sleep(700);
                const t = ctxForm.textContent;
                rec('列出槽位规格', t.includes('protectedCanon') && t.includes('topMemory'), '');
              }

              // ⚠ 最关键的两项：演示「必须被拒绝」的两条约束
              const obBtn = btnByText(ctxForm, '演示：Protected 超预算');
              rec('有超预算演示按钮', !!obBtn, '');
              if (obBtn) {
                obBtn.click();
                await sleep(900);
                const t = ctxForm.textContent;
                rec('⚠ Protected 超预算确实被拒绝',
                    t.includes('已被拒绝') && t.includes('CONTEXT_BUDGET_EXCEEDED'), '');
              }

              const rlBtn = btnByText(ctxForm, '演示：无来源条目');
              rec('有无来源演示按钮', !!rlBtn, '');
              if (rlBtn) {
                rlBtn.click();
                await sleep(900);
                const t = ctxForm.textContent;
                rec('⚠ 无来源条目确实被拒绝',
                    t.includes('已被拒绝') && t.includes('CONTEXT_BUILD_FAILED'), '');
              }
            }

            // 10) Planner 面板（STEP 6）
            const planForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('章节规划'));
            rec('Planner 面板存在', !!planForm, '');
            if (planForm) {
              const pBtn = btnByText(planForm, '规划当前章节');
              rec('有规划按钮', !!pBtn, '');
              if (pBtn) {
                pBtn.click();
                // 轮询等待结果。窗口放大到 60 次（15s）—— 配置了模型时
                // 规划会真实调用 LLM，10s 可能不够（实测踩到：poll 窗口
                // 到期后读到空字符串，断言假失败）。
                let msg = '';
                for (let i = 0; i < 60; i++) {
                  await sleep(250);
                  const m = planForm.querySelector('.form-msg')?.textContent || '';
                  if (m.includes('正在规划')) continue; // 仍在进行中
                  if (m.length > 0) {
                    msg = m;
                    break;
                  }
                }
                // 三种可接受结果：明确报未配模型 / 规划成功 / 提示还没有章节
                rec('⚠ 规划给出明确结果（成功或明确错误，不静默失败）',
                    msg.includes('MODEL_AUTH_FAILED') || msg.includes('规划成功')
                    || msg.includes('还没有章节') || msg.includes('规划失败')
                    || msg.includes('MODEL_'),
                    msg.slice(0, 100) || '(15s 内无响应)');
              }
            }

            // 11) Writer 面板（STEP 7）
            const writeForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('正文生成'));
            rec('Writer 面板存在', !!writeForm, '');
            if (writeForm) {
              // 必须明确告知产物去向 —— 避免误以为已写入正式章节
              const notice = writeForm.textContent;
              rec('⚠ 明确标注产物只进工作区',
                  notice.includes('工作区') && notice.includes('不碰正式章节'), '');

              const wBtn = btnByText(writeForm, '生成草稿');
              rec('有生成草稿按钮', !!wBtn, '');
              if (wBtn) {
                wBtn.click();
                let msg = '';
                for (let i = 0; i < 40; i++) {
                  await sleep(250);
                  const m = writeForm.querySelector('.form-msg')?.textContent || '';
                  if (m.includes('生成成功') || m.includes('生成失败') || m.includes('还没有章节')
                      || m.includes('还没有计划') || m.includes('MODEL_')) {
                    msg = m;
                    break;
                  }
                }
                // 未配置模型时应明确报错；若已配置则应提示"还没有计划"（因为本流程未真跑 Planner）
                rec('⚠ 生成前置条件不满足时给出明确提示',
                    msg.includes('MODEL_AUTH_FAILED') || msg.includes('还没有计划')
                    || msg.includes('生成成功') || msg.includes('还没有章节'),
                    msg.slice(0, 80));
              }
            }

            // 12) 一致性检查面板（STEP 8）
            const contForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('一致性检查'));
            rec('一致性检查面板存在', !!contForm, '');
            if (contForm) {
              // 必须标注只读 —— 避免误以为会自动修复
              rec('⚠ 明确标注只读（不自动修复）',
                  contForm.textContent.includes('只读') && contForm.textContent.includes('不修改草稿'), '');

              const cBtn = btnByText(contForm, '检查当前章');
              rec('有检查按钮', !!cBtn, '');
              if (cBtn) {
                cBtn.click();
                let msg = '';
                for (let i = 0; i < 40; i++) {
                  await sleep(250);
                  const m = contForm.querySelector('.form-msg')?.textContent || '';
                  if (m.includes('通过：') || m.includes('发现') || m.includes('还没有')
                      || m.includes('还没有草稿') || m.includes('TOOL_') || m.includes('STORAGE_')) {
                    msg = m;
                    break;
                  }
                }
                // 没草稿时应明确提示"请先生成草稿"，而不是静默失败
                rec('⚠ 无草稿时给出明确提示',
                    msg.includes('还没有草稿') || msg.includes('还没有章节')
                    || msg.includes('通过：') || msg.includes('发现'),
                    msg.slice(0, 80));
              }
            }

            // 13) 审阅面板（STEP 8）
            const revForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('审稿'));
            rec('审稿面板存在', !!revForm, '');
            if (revForm) {
              // 必须写明"只有 BLOCKING = 0 才能提交"—— 把 §33 变成可见约束
              rec('⚠ 标注 BLOCKING = 0 提交门槛',
                  revForm.textContent.includes('BLOCKING = 0'), '');

              const rBtn = btnByText(revForm, '审阅当前章');
              rec('有审阅按钮', !!rBtn, '');
              if (rBtn) {
                rBtn.click();
                let msg = '';
                for (let i = 0; i < 40; i++) {
                  await sleep(250);
                  const m = revForm.querySelector('.form-msg')?.textContent || '';
                  if (m.includes('PASSED') || m.includes('BLOCKED') || m.includes('NEEDS_REVISION')
                      || m.includes('还没有') || m.includes('TOOL_') || m.includes('仍未')) {
                    msg = m;
                    break;
                  }
                }
                rec('⚠ 无草稿时给出明确提示',
                    msg.includes('还没有草稿') || msg.includes('还没有章节')
                    || msg.includes('PASSED') || msg.includes('BLOCKED') || msg.includes('NEEDS_REVISION'),
                    msg.slice(0, 90));
              }
            }

            // 14) 事实与 Canon 面板（STEP 9）
            const canonForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('事实与 Canon'));
            rec('事实面板存在', !!canonForm, '');
            if (canonForm) {
              // 必须写明两步走 —— 避免误以为抽取即入库
              rec('⚠ 标注"抽取不写库、提升才写库"',
                  canonForm.textContent.includes('不写库') && canonForm.textContent.includes('提升才写'), '');

              const exBtn = btnByText(canonForm, '抽取事实');
              rec('有抽取按钮', !!exBtn, '');
              if (exBtn) {
                exBtn.click();
                let msg = '';
                for (let i = 0; i < 40; i++) {
                  await sleep(250);
                  const m = canonForm.querySelector('.form-msg')?.textContent || '';
                  if (m.includes('抽取到') || m.includes('抽取被拒绝') || m.includes('还没有')
                      || m.includes('MODEL_')) {
                    msg = m;
                    break;
                  }
                }
                rec('⚠ 无草稿时给出明确提示',
                    msg.includes('还没有草稿') || msg.includes('还没有章节')
                    || msg.includes('MODEL_AUTH_FAILED')
                    || msg.includes('抽取到') || msg.includes('抽取被拒绝'),
                    msg.slice(0, 90));
              }
            }

            // 15) 提交面板（STEP 11）【MVP 门槛】
            const commitForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('提交为正式章节'));
            rec('提交面板存在', !!commitForm, '');
            if (commitForm) {
              // 必须标注三阶段 —— 让"中断可恢复"这件事在界面上可见
              rec('⚠ 标注三阶段 PREPARE→APPLY→VERIFY',
                  commitForm.textContent.includes('PREPARE') && commitForm.textContent.includes('VERIFY'), '');

              const pcBtn = btnByText(commitForm, '提交预检');
              rec('有提交预检按钮', !!pcBtn, '');
              if (pcBtn) {
                pcBtn.click();
                let msg = '';
                for (let i = 0; i < 40; i++) {
                  await sleep(250);
                  const m = commitForm.querySelector('.form-msg')?.textContent || '';
                  if (m.includes('可以提交') || m.includes('不可提交') || m.includes('还没有')) {
                    msg = m;
                    break;
                  }
                }
                // 无草稿时应明确列出阻塞项，而不是静默
                rec('⚠ 预检给出明确阻塞项或放行',
                    msg.includes('可以提交') || msg.includes('不可提交') || msg.includes('还没有'),
                    msg.slice(0, 90));
              }
            }

            // 16) 检索面板（补缺口：FTS 可用）
            const searchForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('检索'));
            rec('检索面板存在', !!searchForm, '');
            if (searchForm) {
              const inp = searchForm.querySelector('input');
              rec('有检索输入框', !!inp, '');
              if (inp) {
                inp.value = '测试';
                const sBtn = btnByText(searchForm, '检索');
                if (sBtn) {
                  sBtn.click();
                  let msg = '';
                  for (let i = 0; i < 40; i++) {
                    await sleep(250);
                    const m = searchForm.querySelector('.form-msg')?.textContent || '';
                    if (m.includes('章节') || m.includes('请输入') || m.includes('STORAGE')) {
                      msg = m;
                      break;
                    }
                  }
                  rec('⚠ 检索返回结果或明确错误',
                      msg.includes('章节') || msg.includes('请输入'), msg.slice(0, 80));
                }
              }
            }

            // 17) 摘要确认面板（ADR-0006 约束 C）
            const sumForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('摘要确认'));
            rec('摘要确认面板存在', !!sumForm, '');
            if (sumForm) {
              // 必须说明"未确认不进检索"的理由
              rec('⚠ 标注未确认摘要不进检索',
                  sumForm.textContent.includes('不进检索'), '');
              const rBtn2 = btnByText(sumForm, '刷新待确认');
              rec('有待确认刷新按钮', !!rBtn2, '');
            }

            // 17b) 篇幅目标面板（P2-1）
            //
            // ⚠ 这条断言存在的理由：本项目反复出现"后端能力有了、界面够不到"
            //   的缺陷（角色/世界观至今如此）。新面板必须被真的挂载才算完成。
            //
            // ⚠ 面板在中栏（书目总览），而前面第 6 步点了章节 → 中栏已被
            //   章节详情占据。所以这里必须**先点回书目** —— 这同时也验证了
            //   作者确实能走到这个面板（不是"代码里有、界面到不了"）。
            const bookNav = [...document.querySelectorAll('.nav-item')]
              .find(n => n.querySelector('.nav-label')?.textContent === '测试小说');
            rec('左栏能点回书目（篇幅目标面板的可达路径）', !!bookNav, '');
            if (bookNav) {
              bookNav.click();
              await sleep(900);
            }
            const wcForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('篇幅目标'));
            rec('⚠ 篇幅目标面板已挂载（P2-1 后端能力有界面入口）', !!wcForm, '');
            if (wcForm) {
              const saveB = btnByText(wcForm, '保存');
              const clearB = btnByText(wcForm, '清除设定');
              rec('篇幅目标面板有保存/清除按钮', !!saveB && !!clearB, '');
              // ⚠ 必须说明"不阻断" —— 否则作者会为凑字数往正文灌水
              rec('⚠ 标注字数只提示不阻断（防凑数注水）',
                  wcForm.textContent.includes('不阻断'), '');
              const tolInput = [...wcForm.querySelectorAll('input')]
                .find(i => i.max === '200');
              rec('可设定偏离容忍度', !!tolInput, '');
              // ⚠ 真的点一次保存：只断言"面板在"会漏掉"按钮点了没反应"
              if (saveB) {
                const targetInput = [...wcForm.querySelectorAll('input')]
                  .find(i => i.type === 'number' && i.max !== '200');
                if (targetInput) setInput(targetInput, '2500');
                saveB.click();
                await sleep(1200);
                const m = wcForm.querySelector('.form-msg')?.textContent ?? '';
                rec('⚠ 保存目标字数真的生效（不是空壳按钮）',
                    m.includes('2500'), m.slice(0, 70));
              }
            }

            // 17c) 角色设定面板（P2-2）
            //
            // ⚠ 本项目反复出现"后端能力有了、界面够不到"：角色表与
            //   character.* 工具早就有，但界面零入口、也不进 Writer prompt。
            //   这条断言必须**真的添加一个角色**，只断言"面板在"会漏掉
            //   "按钮点了没反应"（character.create 不是 IPC 方法，
            //   第一版直接 call() 就是坏的 —— 是这条断言该抓的东西）。
            const charForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('角色设定'));
            rec('⚠ 角色设定面板已挂载（P2-2 后端能力有界面入口）', !!charForm, '');
            if (charForm) {
              rec('⚠ 标注角色会注入规划与写作',
                  charForm.textContent.includes('注入'), '');
              const cInputs = [...charForm.querySelectorAll('input')];
              if (cInputs[0]) setInput(cInputs[0], '沈砚');
              if (cInputs[2]) setInput(cInputs[2], '主角');
              const addB = btnByText(charForm, '添加角色');
              rec('有添加角色按钮', !!addB, '');
              if (addB) {
                addB.click();
                await sleep(1200);
                const cm = charForm.querySelector('.form-msg')?.textContent ?? '';
                rec('⚠ 添加角色真的生效（不是空壳按钮）',
                    cm.includes('沈砚'), cm.slice(0, 70));
                rec('⚠ 角色出现在列表中（真的落库了）',
                    charForm.textContent.includes('沈砚'), '');

                // ── 17c-2) 角色编辑 / 删除（P2-4c）──
                //
                // ⚠ 与设定（P2-4b）同类死胡同，但更深一层：设定那边只是
                //   缺 UI；角色这边 character.update 的 schema **不接受
                //   name/aliases**、仓储层连 remove 都没有。
                //   作者最常要改的恰恰是**打错的名字**（角色名是识别
                //   "谁是谁"的键），所以必须真点、真改、真验证落库。
                const cRows = [...charForm.querySelectorAll('.issue-row')];
                rec('角色列表每条都有编辑/删除入口',
                    cRows.length > 0 && cRows.every(r2 =>
                      !!btnByText(r2, '编辑') && !!btnByText(r2, '删除')),
                    '行数 ' + cRows.length);

                if (cRows.length > 0) {
                  // ── 改名：这是此前**根本做不到**的操作 ──
                  const ceBtn = btnByText(cRows[0], '编辑');
                  ceBtn?.click();
                  await sleep(300);
                  const ceBox = cRows[0].querySelector('.char-edit');
                  rec('⚠ 点编辑就地展开角色编辑框', !!ceBox, '');
                  if (ceBox) {
                    const ceName = ceBox.querySelector('input');
                    setInput(ceName, '沈砚之');
                    btnByText(ceBox, '保存')?.click();
                    await sleep(1500);
                    const cem = charForm.querySelector('.form-msg')?.textContent ?? '';
                    rec('⚠ 角色改名真的落库（此前 update 不接受 name）',
                        cem.includes('沈砚之'), cem.slice(0, 80));
                    rec('⚠ 改名提示会影响连续性检查',
                        cem.includes('连续性'), cem.slice(0, 90));
                    // ⚠ 必须查**列表行**，不能查 charForm.textContent：
                    //   后者包含上面那条成功提示，而提示文本是由**输入框**
                    //   拼出来的，不是从库里读回来的 —— 于是"漏提交 name"
                    //   这种缺陷照样通过（实测假绿：注入后仍 114/114）。
                    //   列表是 refresh() 后由 character.list 重建的，才是真证据。
                    const cRowsAfter = [...charForm.querySelectorAll('.issue-row')];
                    const cNameShown = cRowsAfter[0]
                      ?.querySelector('.issue-msg')?.textContent ?? '';
                    rec('⚠ 列表行显示的是新名字（从库里读回来）',
                        cNameShown.includes('沈砚之'), cNameShown.slice(0, 60));
                    rec('⚠ 列表行不再是旧名字',
                        !cNameShown.includes('沈砚 '), cNameShown.slice(0, 60));
                  }

                  // ── 删除：未勾选必须禁用 ──
                  const cRows2 = [...charForm.querySelectorAll('.issue-row')];
                  const cdBtn = cRows2[0] && btnByText(cRows2[0], '删除');
                  cdBtn?.click();
                  await sleep(300);
                  const cdBox = cRows2[0]?.querySelector('.char-del');
                  rec('⚠ 点删除展开确认区（角色）', !!cdBox, '');
                  if (cdBox) {
                    const cdoBtn = btnByText(cdBox, '删除');
                    rec('⚠ 未勾选时删除按钮禁用（防误删，角色）',
                        !!cdoBtn && cdoBtn.disabled, '');
                    const ccb = cdBox.querySelector('input[type=checkbox]');
                    if (ccb && cdoBtn) {
                      ccb.click();
                      await sleep(200);
                      rec('⚠ 勾选后删除按钮才可用（角色）', !cdoBtn.disabled, '');
                      cdoBtn.click();
                      await sleep(1500);
                      const cdm = charForm.querySelector('.form-msg')?.textContent ?? '';
                      rec('⚠ 角色删除真的生效', cdm.includes('已删除'), cdm.slice(0, 80));
                      const cLeft = charForm.querySelectorAll('.issue-row').length;
                      rec('⚠ 删除后角色列表确实少一条', cLeft === cRows2.length - 1,
                          '剩余 ' + cLeft + ' / 原 ' + cRows2.length);
                    }
                  }
                }
              }
            }

            // 17d) 世界观设定 + 确认门禁（P2-3）
            //
            // ⚠ 这条断言必须**真的添加设定并真的点确认**，然后验证
            //   门禁状态从"未确认"翻到"已确认"。只断言"面板在"会漏掉
            //   world.create 不是 IPC 方法这类问题（P2-2 踩过同一个坑）。
            const setForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('世界观设定'));
            rec('⚠ 世界观设定面板已挂载（P2-3 world_entities 零引用已接线）',
                !!setForm, '');
            if (setForm) {
              const sInputs = [...setForm.querySelectorAll('input')];
              if (sInputs[0]) setInput(sInputs[0], '灵力枯竭');
              const sArea = setForm.querySelector('textarea');
              if (sArea) setInput(sArea, '施法会消耗寿命，不可逆');
              const sAdd = btnByText(setForm, '添加设定');
              rec('有添加设定按钮', !!sAdd, '');
              if (sAdd) {
                sAdd.click();
                await sleep(1500);
                const sm = setForm.querySelector('.form-msg')?.textContent ?? '';
                rec('⚠ 添加设定真的生效', sm.includes('灵力枯竭'), sm.slice(0, 70));
                // 未确认时门禁必须拦
                const before = setForm.querySelector('.perm-line')?.textContent ?? '';
                rec('⚠ 未确认时门禁显示为拦截状态',
                    before.includes('尚未确认'), before.slice(0, 70));
                const cBtn = btnByText(setForm, '确认全部设定');
                rec('有确认设定按钮', !!cBtn, '');
                if (cBtn) {
                  cBtn.click();
                  await sleep(1500);
                  const cm2 = setForm.querySelector('.form-msg')?.textContent ?? '';
                  rec('⚠ 确认设定真的生效', cm2.includes('已确认'), cm2.slice(0, 70));
                  const after = setForm.querySelector('.perm-line')?.textContent ?? '';
                  rec('⚠ 确认后门禁放行（作者可以开写了）',
                      after.includes('已确认'), after.slice(0, 70));

                  // ── 17e) 设定编辑 / 删除（P2-4 补完）──
                  //
                  // ⚠ 在此之前设定**只能加不能改不能删**：作者打错一个字，
                  //   那条设定就永久错着，还会带着错字进 prompt 并参与
                  //   连续性判定。world.update/world.remove 早已存在，
                  //   缺的只是 UI 入口 —— 所以这里必须真点按钮验证接线，
                  //   不能只断言"编辑/删除按钮在"。
                  const rows = [...setForm.querySelectorAll('.issue-row')];
                  rec('设定列表每条都有编辑/删除入口',
                      rows.length > 0 && rows.every(r =>
                        !!btnByText(r, '编辑') && !!btnByText(r, '删除')), '行数 ' + rows.length);

                  if (rows.length > 0) {
                    // ── 编辑：改名字后保存，必须真的落库 ──
                    const eBtn = btnByText(rows[0], '编辑');
                    eBtn?.click();
                    await sleep(300);
                    const eBox = rows[0].querySelector('.world-edit');
                    rec('⚠ 点编辑就地展开编辑框', !!eBox, '');
                    if (eBox) {
                      const eName = eBox.querySelector('input');
                      setInput(eName, '灵力枯竭（改）');
                      btnByText(eBox, '保存')?.click();
                      await sleep(1500);
                      const em = setForm.querySelector('.form-msg')?.textContent ?? '';
                      rec('⚠ 编辑真的落库', em.includes('灵力枯竭（改）'), em.slice(0, 80));
                      // 改已确认设定 → 必须明确告知退回未确认（否则作者
                      // 发现写作被门禁拦住时不知何故）
                      rec('⚠ 改已确认设定会提示退回未确认',
                          em.includes('退回') && em.includes('重新确认'), em.slice(0, 90));
                    }

                    // ── 删除：未勾选时按钮必须禁用（真破坏性不可撤销）──
                    const rows2 = [...setForm.querySelectorAll('.issue-row')];
                    const dBtn = rows2[0] && btnByText(rows2[0], '删除');
                    dBtn?.click();
                    await sleep(300);
                    const dBox = rows2[0]?.querySelector('.world-del');
                    rec('⚠ 点删除展开确认区', !!dBox, '');
                    if (dBox) {
                      const doBtn = btnByText(dBox, '删除');
                      rec('⚠ 未勾选时删除按钮禁用（防误删）', !!doBtn && doBtn.disabled, '');
                      const cb = dBox.querySelector('input[type=checkbox]');
                      if (cb && doBtn) {
                        cb.click();
                        await sleep(200);
                        rec('⚠ 勾选后删除按钮才可用', !doBtn.disabled, '');
                        doBtn.click();
                        await sleep(1500);
                        const dm = setForm.querySelector('.form-msg')?.textContent ?? '';
                        rec('⚠ 删除真的生效', dm.includes('已删除'), dm.slice(0, 80));
                        const left = setForm.querySelectorAll('.issue-row').length;
                        rec('⚠ 删除后列表确实少一条', left === rows2.length - 1,
                            '剩余 ' + left + ' / 原 ' + rows2.length);
                      }
                    }
                  }
                }
              }
            }

            // 18) Run 控制（补缺口：Pause / Resume / Cancel 入口）
            const runForm = [...document.querySelectorAll('.form')]
              .find(f => f.querySelector('h3')?.textContent.includes('Agent 与状态机'));
            rec('Agent 与状态机面板存在', !!runForm, '');
            if (runForm) {
              const pBtn2 = btnByText(runForm, '暂停');
              const rBtn3 = btnByText(runForm, '恢复');
              const cBtn2 = btnByText(runForm, '取消');
              rec('有暂停/恢复/取消三个按钮', !!pBtn2 && !!rBtn3 && !!cBtn2, '');
              rec('标注暂停与取消的语义区别',
                  runForm.textContent.includes('保留已完成步骤') && runForm.textContent.includes('不可恢复'), '');
              if (pBtn2) {
                pBtn2.click();
                await sleep(800);
                const m = runForm.querySelector('.form-msg')?.textContent || '';
                // 无运行中的 Run 时应明确提示，而不是静默
                rec('⚠ 无运行中 Run 时给出明确提示',
                    m.includes('没有运行中的 Run') || m.includes('MODEL_AUTH_FAILED') || m.includes('成功'),
                    m.slice(0, 80));
              }
            }

            // ── STEP 22 UI polish 检查 ──
            //
            // ⚠ 检查的是"分组真的存在且默认状态正确"，而不是"渲染没报错" ——
            //   面板平铺时也不会报错，但用户体验是滚不到底。
            const groups = [...document.querySelectorAll('.panel-group')];
            rec('⚠ 右栏已分组（不再是 14 个面板平铺）',
                groups.length === 5, 'groups=' + groups.length);

            // ⚠ 默认展开「模型」与「写作流程」两组。
            //
            //   模型配置**必须可见**：它是所有写作动作的前提，没配模型
            //   规划/生成草稿/审稿全部不可用。曾经它被折叠在「系统诊断」里，
            //   用户实测反馈"模型配置 UI 不见了"。
            //   写作流程是日常唯一会用的一组，保持展开。
            const openGroups = groups.filter(g => g.hasAttribute('open'));
            const openNames = openGroups.map(g => g.querySelector('summary')?.textContent ?? '');
            rec('⚠ 默认展开「模型」与「写作流程」（模型配置必须看得见）',
                openNames.length === 2 &&
                openNames.includes('模型') && openNames.includes('写作流程'),
                'open=' + openNames.join('、'));

            // ⚠ 原生 details 自带无障碍语义与键盘可达性 —— 断言用的是原生元素
            rec('⚠ 折叠用原生 details/summary（自带无障碍与键盘可达）',
                groups.every(g => g.tagName === 'DETAILS' &&
                  g.firstElementChild?.tagName === 'SUMMARY'),
                groups.map(g => g.tagName).join(','));

            // 写作流程组里应有规划/正文/审稿/提交
            // ⚠ 按组名取，不能取 openGroups[0] —— 组的顺序变了，
            //   按下标取会拿到「模型」组的内容（实测踩到）。
            const wfGroup = groups.find(g =>
              (g.querySelector('summary')?.textContent ?? '').includes('写作流程'));
            const workflow = wfGroup?.textContent ?? '';
            rec('「写作流程」含规划/正文/审稿/提交',
                ['章节规划', '正文生成', '审稿', '提交为正式章节'].every(k => workflow.includes(k)),
                workflow.slice(0, 60).replace(/\s+/g, ' '));

            // ── 技能面板（STEP 17–21 的后端能力，此前无界面入口）──
            const skillPanel = [...document.querySelectorAll('.form--rail')]
              .find(f => f.querySelector('h3')?.textContent.includes('写作技能'));
            rec('⚠ 技能面板已挂载（后端能力有了界面入口）', Boolean(skillPanel));

            if (skillPanel) {
              // 等自动加载完成
              for (let i = 0; i < 20 && skillPanel.textContent.includes('读取中'); i++) await sleep(200);
              const t = skillPanel.textContent;
              // ⚠ 用"包含"而非正则：正则要穿过模板字符串与
              //   executeJavaScript 两层转义，极易写错 —— 实测第一次就写错，
              //   报"没读到数据"而实际读到了（误报比漏报更浪费时间）。
              rec('⚠ 技能面板真的读到了数据（不是空壳）',
                  t.includes('可检索') && t.includes('个'),
                  t.replace(/\s+/g, ' ').slice(0, 90));
              rec('技能面板显示类型隔离信息',
                  t.includes('被类型隔离挡掉'));
              rec('⚠ 技能面板强调「不适用的情况」（防滥用）',
                  t.includes('不适用') || t.includes('用错场合'));
            }

            // ── 备份面板 ──
            const backupPanel = [...document.querySelectorAll('.form--rail')]
              .find(f => f.querySelector('h3')?.textContent.includes('备份与导出'));
            rec('⚠ 备份面板已挂载', Boolean(backupPanel));
            if (backupPanel) {
              const t = backupPanel.textContent;
              rec('备份面板含导出/校验/恢复/重建索引四项',
                  ['导出项目', '校验完整性', '执行恢复', '重建检索索引'].every(k => t.includes(k)));
              // ⚠ 恢复按钮必须默认禁用（破坏性操作需显式确认）
              const restoreBtn = [...backupPanel.querySelectorAll('button')]
                .find(b => b.textContent.trim() === '执行恢复');
              rec('⚠ 恢复按钮默认禁用（破坏性操作需勾选确认）',
                  Boolean(restoreBtn?.disabled));
            }

            // 6e) §43 章节流水线进度条
            //     ⚠ 本区块内禁止出现反引号（工程约定 1）。
            //     ⚠ 断言查**下游终点**：不只看 DOM 里有没有这个元素，
            //       要查步骤文字与后端判据是否一致。
            {
              // ⚠ 前面的区块点过「左栏能点回书目」→ 中栏已切到书目视图，
              //   而进度条只在**章节详情**里。不先切回去就会查不到元素
              //   （实测踩到：报"进度条已渲染"FAIL，而代码其实是对的）。
              chapterItems[0]?.click();
              await sleep(900);
              const bar = document.querySelector('.pipeline');
              rec('§43 进度条已渲染在章节详情顶部', Boolean(bar));

              const stepNodes = [...(bar?.querySelectorAll('.pipeline__step') ?? [])];
              const labels = stepNodes.map(n => (n.querySelector('.pipeline__label')?.textContent ?? ''));
              rec('§43 六个步骤齐全（Planning…Commit）',
                  labels.join(',') === 'Planning,Writing,Review,Revision,Continuity,Commit',
                  labels.join(' '));

              // ⚠ 判据来自产物文件：这一章刚写完正文（draft.md 存在），
              //   但没跑过审阅/连续性 → 必须显示 Writing 已完成、Review 是当前步
              const stateOf = (name) => {
                const n = stepNodes.find(x => (x.querySelector('.pipeline__label')?.textContent ?? '') === name);
                if (!n) return '缺失';
                const c = n.className;
                if (c.includes('--done')) return 'done';
                if (c.includes('--current')) return 'current';
                if (c.includes('--todo')) return 'todo';
                return '未知';
              };
              // ⚠ 关键：**用磁盘上的真实产物独立验算**进度条报的步骤。
              //   只断言"Writing 是 done"是硬编码预期 —— 模型没配好时
              //   压根没有 draft.md，那条断言查的是环境而不是代码。
              //   这里改成"后端报的 done 集合 == 文件推出的 done 集合"，
              //   无论环境怎样都必须成立（实测：本环境 0/6，因为只存过正文）。
              const actualDone = labels.filter(l => stateOf(l) === 'done');

              rec('⚠ Commit 未完成（本章未提交，§三十 SAVE != COMMIT）',
                  stateOf('Commit') !== 'done', 'Commit=' + stateOf('Commit'));

              // ⚠ 与磁盘真实产物的独立验算放在**页面外**做（见 res.pipelineDone）——
              //   注入时机在流程开始前，那时 workspace 还没被创建，
              //   在这里比对会拿空列表比空列表，**空转通过**（实测踩到）。
              pipelineDone = actualDone;
              pipelineLabels = labels;

              // ⚠ 最多只能有一个「进行中」—— 同时出现多个 ● 会让作者
              //   不知道现在该做什么（反向验证 A 组就是这个缺陷）
              const currents = labels.filter(l => stateOf(l) === 'current');
              rec('⚠ 至多一个「进行中」步骤（不会同时多个 ●）',
                  currents.length <= 1, 'current=' + currents.join('、'));

              // ⚠ 双编码：图标字符必须在（色觉障碍/灰度截图也要能分辨）
              const marks = stepNodes.map(n => (n.querySelector('.pipeline__mark')?.textContent ?? ''));
              rec('⚠ 状态是字符 + 颜色双编码（✓ ● ○）',
                  marks.every(m => ['✓', '●', '○'].includes(m)), marks.join(''));

              // ⚠ 未提交时必须明确写出来（作者要一眼看出这不是正史）
              const sum = bar?.querySelector('.pipeline__sum')?.textContent ?? '';
              rec('⚠ 未提交状态明确标出', sum.includes('未提交'), sum.slice(0, 40));
            }

            // 6f) §41 顶栏四要素 + 时间线/伏笔独立入口
            {
              // ── 顶栏四要素 ──
              for (const [id, label] of [['fact-project', '项目'], ['fact-chapter', '当前章'],
                                          ['fact-model', '模型'], ['fact-run', 'Run']]) {
                const n = $(id);
                rec('§41 顶栏含「' + label + '」', Boolean(n),
                    n ? n.textContent.slice(0, 30) : '缺失');
              }
              // ⚠ 顶栏必须显示**真实**项目名，不是占位符
              const projText = $('fact-project')?.textContent ?? '';
              rec('⚠ 顶栏「项目」显示真实项目名（非占位符）',
                  projText.length > 0 && projText !== '—' && projText !== '未打开', projText);
              // ⚠ 本章未配模型 → 必须明说未配置，不能空着
              const modelText = $('fact-model')?.textContent ?? '';
              rec('⚠ 顶栏「模型」未配置时明确显示（不空着）',
                  modelText.length > 0, 'model=' + modelText);

              // ── 时间线 / 伏笔各自独立入口 ──
              const viewItems = [...document.querySelectorAll('.nav-item--view')];
              rec('⚠ 左栏有时间线/伏笔独立入口（此前后端有、UI 无入口）',
                  viewItems.length === 2, 'views=' + viewItems.length);
              const viewNames = viewItems.map(n => n.dataset.view);
              rec('两个入口分别是 timeline 与 foreshadow',
                  viewNames.join(',') === 'timeline,foreshadow', viewNames.join(' '));

              // 点进时间线：必须真的渲染出视图（不是空壳入口）
              const tlItem = viewItems.find(n => n.dataset.view === 'timeline');
              tlItem?.click();
              await sleep(900);
              const tlText = $('center')?.textContent ?? '';
              rec('⚠ 点「时间线」真的渲染出视图（非空壳入口）',
                  tlText.includes('时间线') && (tlText.includes('事件总数') || tlText.includes('读取失败')),
                  tlText.slice(0, 50).replace(/\s+/g, ' '));
              // ⚠ 进账目视图后顶栏「当前章」应清空 —— 否则顶栏与中栏说的不是一件事
              rec('⚠ 进账目视图后顶栏「当前章」清空（顶栏与内容一致）',
                  ($('fact-chapter')?.textContent ?? '') === '未选择',
                  '当前章=' + ($('fact-chapter')?.textContent ?? ''));

              // 点进伏笔
              const fsItem = viewItems.find(n => n.dataset.view === 'foreshadow');
              fsItem?.click();
              await sleep(900);
              const fsText = $('center')?.textContent ?? '';
              rec('⚠ 点「伏笔」真的渲染出视图（非空壳入口）',
                  fsText.includes('伏笔') && (fsText.includes('读取失败') || fsText.includes('还没有伏笔') || fsText.includes('总计')),
                  fsText.slice(0, 50).replace(/\s+/g, ' '));

              // 回到章节详情，避免影响后续断言
              chapterItems[0]?.click();
              await sleep(700);
            }

            // 6d) 主题切换 + 偏好持久化（浅/暗主题、当前书）
            //     ⚠ 本区块内禁止出现反引号（工程约定 1）。
            //     ⚠ 断言必须查**下游终点**：不能只看按钮文字变了，
            //       要查 <html data-theme> 真的改了，且真的写进了 prefs.json。
            {
              // ⚠ 6c 区块里的 callIpc 被它自己的花括号圈住了，这里要重新定义
              const callIpc = async (m, prm) => {
                const r = await window.nwa.invoke(m, prm);
                return (r && r.ok) ? r.data : null;
              };
              const before = document.documentElement.getAttribute('data-theme');
              const btn = $('theme');
              rec('主题切换按钮存在', Boolean(btn), 'btn=' + (btn ? btn.textContent.trim() : '缺失'));

              btn?.click();
              // 等一次 IPC 往返（点击 → prefs.set → 落盘）
              await new Promise((r) => setTimeout(r, 300));
              const after = document.documentElement.getAttribute('data-theme');
              rec('⚠ 点击后 data-theme 真的切换了', before !== after, before + ' → ' + after);

              // ⚠ 查落盘终点：主进程 prefs.get 应能读回刚切换的主题
              const saved = await callIpc('prefs.get', {});
              rec('⚠ 主题已落盘（prefs.json 可读回）',
                  saved?.theme === after,
                  'prefs.theme=' + String(saved?.theme));

              // 当前书：记住"正在写哪本"，重开时据此恢复
              const st = window.__nwaState;
              rec('⚠ 当前书 id 已记住（重开据此恢复，不再退回最老那本）',
                  Boolean(st?.prefs?.lastBookId),
                  'lastBookId=' + String(st?.prefs?.lastBookId ?? '(空)'));

              // ⚠ 读回偏好后必须真的作用到 <html> 上，否则"记住了但没用"
              const reApplied = st?.prefs?.theme === after;
              rec('⚠ 读回的偏好作用于界面（不是只存不用）', reApplied,
                  'state.prefs.theme=' + String(st?.prefs?.theme));

              // 切回暗色，避免影响后续断言对颜色的假设
              if (after === 'light') { btn?.click(); await new Promise((r) => setTimeout(r, 300)); }
            }

            return { steps, pipelineDone, pipelineLabels };
          })()`;

          const flowWithFiles = `const __wsFiles = ${JSON.stringify(wsFiles)};\n` + flow;
          const res = (await win?.webContents.executeJavaScript(flowWithFiles)) as {
            steps: { name: string; ok: boolean; detail?: string }[];
            pipelineDone?: string[];
            pipelineLabels?: string[];
          };
          for (const s of res.steps) record(s.name, s.ok, s.detail);

          // ── §43 独立验算：拿**流程结束后**的磁盘真实产物，与进度条自报的比对 ──
          // ⚠ 必须在流程跑完后读：流程中间才会写出 manuscript.md / versions/，
          //   注入时读会得到空目录，比对就变成"空 vs 空"的空转通过。
          {
            const done = res.pipelineDone ?? [];
            const labels = res.pipelineLabels ?? [];
            // ⚠ 在这里**重新解析**：wsChapterDir 是流程前算的，而工作区
            //   目录由流程中间创建 —— 用旧值会读空目录，比对变成空转。
            const dir = resolveWsChapterDir();
            const files = existsSync(dir) ? readdirSync(dir) : [];
            const fileFor: Record<string, string> = {
              Planning: 'plan.json', Writing: 'draft.md', Review: 'review.json',
              Revision: 'revision.md', Continuity: 'continuity.json',
            };
            const expect = Object.entries(fileFor)
              .filter(([, f]) => files.includes(f))
              .map(([n]) => n);

            // ⚠ 先证明探针真的看到了文件 —— 否则下面的比对毫无意义（空转通过）
            record(
              '⚠ 探针确实读到工作区文件（防"空 vs 空"空转通过）',
              files.length > 0,
              `files=[${files.join('、')}]`,
            );
            record(
              '⚠ 进度条与磁盘真实产物一致（独立验算，不硬编码预期）',
              expect.join(',') === done.join(','),
              `文件推出=[${expect.join(' ')}] 进度条报=[${done.join(' ')}]`,
            );
            record(
              '⚠ 六个步骤标签齐全',
              labels.join(',') === 'Planning,Writing,Review,Revision,Continuity,Commit',
              labels.join(' '),
            );
          }

          const pass = steps.length > 0 && steps.every((s) => s.ok);
          writeFileSync(
            join(here, '../gui-flow-result.json'),
            JSON.stringify({ steps, pass }, null, 2),
            'utf8',
          );
          app.exit(pass ? 0 : 1);
        } catch (err) {
          writeFileSync(
            join(here, '../gui-flow-result.json'),
            JSON.stringify({ steps, pass: false, error: String(err) }, null, 2),
            'utf8',
          );
          logger.error('GUI 流程验证失败', err);
          app.exit(1);
        }
      }, 3000);
    });
  }

  /**
   * M5：**renderer 崩溃时**把未落盘的内容冲掉。
   *
   * ⚠ 这是把 debounce 放主进程的**全部理由**在这里兑现：
   *   页面已经死了，但它最后一次推过来的快照还在主进程内存里。
   *   不在这里 flush，那份快照就随窗口一起消失 ——
   *   而"作者刚写完一段、页面崩了"正是最需要恢复的场景。
   */
  win.webContents.on('render-process-gone', (_e, details) => {
    logger.error('渲染进程异常退出，立即 flush 自动保存', details);
    void flushAutosave();
  });

  win.on('closed', () => {
    win = null;
  });
}

/** 主进程只做路由，不解释业务语义 */
function registerIpc(): void {
  ipcMain.handle(IPC.INVOKE, async (_event, request: { method: string; params?: unknown }) => {
    if (!core) {
      return { ok: false, error: { code: 'WORKSPACE_CORRUPTED', message: 'core 进程未运行' } };
    }
    const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const result = await new Promise<unknown>((resolve) => {
      pending.set(requestId, resolve);
      core!.postMessage({ kind: 'request', requestId, method: request.method, params: request.params });
    });
    return result;
  });

  /**
   * 选择语料文件（§16 导入入口）。
   *
   * ⚠ 文件对话框必须在**主进程**执行（`dialog` 是主进程 API），
   *   而 core 进程负责业务 —— 所以这里单独一个通道，
   *   不塞进通用的 `INVOKE` 路由。
   */
  ipcMain.handle('nwa:pickFile', async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: '选择要导入的小说',
      properties: ['openFile'],
      filters: [
        { name: '文本文件', extensions: ['txt', 'md'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });

  ipcMain.handle(IPC.APP_INFO, () => ({
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    version: app.getVersion(),
  }));

  /**
   * M5：自动保存（§八 / §十二）。
   *
   * ⚠ 用 `ipcMain.on`（单向）而不是 `handle`：renderer 不需要等结果，
   *   而等待会让每次按键都挂一个 Promise —— 高频路径上不该有这种开销。
   */
  ipcMain.on(
    IPC.AUTOSAVE,
    (
      _e,
      payload: {
        chapterId: string;
        text: string;
        cursor?: number;
        selectionStart?: number;
        selectionEnd?: number;
        scrollTop?: number;
      },
    ) => {
      if (!payload || typeof payload.chapterId !== 'string') return;
      scheduleAutosave(payload);
    },
  );

  /**
   * M5：切章前 flush（§十二）。
   *
   * ⚠ 这是"切章保护"真正生效的地方：debounce 未到点的内容若不冲掉，
   *   作者写完最后一句立刻切走，那几句就只存在于内存里。
   *   renderer 主动请求 + 等待完成，确认落盘后才切。
   */
  ipcMain.handle('nwa:autosave-flush', async (_e, payload?: { chapterId?: string }) => {
    await flushAutosave(payload?.chapterId);
    return { ok: true };
  });
}

app.whenReady().then(() => {
  registerIpc();
  startCoreProcess();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * ⚠ 退出前必须**等** autosave 落盘（§十二）。
 *
 *   原实现直接 `app.quit()` —— debounce 那 1.5 秒内写下的内容
 *   会随进程一起消失。关窗是最常见的"停止写作"动作，
 *   恰好也是最后一次改动最容易被丢掉的一刻。
 *
 *   `before-quit` 里 preventDefault + 异步 flush + 再 quit 是 Electron
 *   的标准做法：直接 await 在 quit 流程里不生效，因为 quit 不会等。
 */
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || pendingAutosaves.size === 0) return;
  e.preventDefault();
  quitting = true;
  void flushAutosave().finally(() => {
    core?.kill();
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
