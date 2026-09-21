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
import { app, BrowserWindow, ipcMain, utilityProcess, type UtilityProcess } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Logger } from '@nwa/core';
import { IPC } from '../shared/ipc.js';

const here = dirname(fileURLToPath(import.meta.url));
const logger = new Logger('main');

let win: BrowserWindow | null = null;
let core: UtilityProcess | null = null;

/** 记录主进程到 core 的请求，用于把 core 的响应路由回渲染进程 */
const pending = new Map<string, (payload: unknown) => void>();

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
  });

  core.on('exit', (code) => {
    logger.warn('core utilityProcess 已退出', { code });
    // 崩溃不影响 UI 存活；恢复由 STEP 11 的 Repair 处理
    core = null;
    win?.webContents.send(IPC.CORE_EXITED, { code });
  });
}

interface CoreMessage {
  readonly kind: 'response' | 'event';
  readonly requestId: string;
  readonly payload: unknown;
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
            return {
              paneCount: panes, toolCount: toolRows, navSectionCount: navSections,
              formCount: forms, errorTexts: errors,
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
                && result.errorTexts.length === 0,
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

            return { steps };
          })()`;

          const res = (await win?.webContents.executeJavaScript(flow)) as {
            steps: { name: string; ok: boolean; detail?: string }[];
          };
          for (const s of res.steps) record(s.name, s.ok, s.detail);

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

  ipcMain.handle(IPC.APP_INFO, () => ({
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    version: app.getVersion(),
  }));
}

app.whenReady().then(() => {
  registerIpc();
  startCoreProcess();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  core?.kill();
  if (process.platform !== 'darwin') app.quit();
});
