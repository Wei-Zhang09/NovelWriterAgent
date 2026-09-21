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

  // GUI 探针：仅在 NWA_GUI_PROBE=1 时启用（CI/手工验收用）。
  // 生产路径不受影响；探针把渲染进程的 DOM 状态写盘后退出。
  if (process.env.NWA_GUI_PROBE === '1') {
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        void win?.webContents
          .executeJavaScript(`(() => ({
            paneCount: document.querySelectorAll('.pane').length,
            checkCount: document.querySelectorAll('.check').length,
            okChecks: [...document.querySelectorAll('.check .dot--ok')].length,
            failedChecks: [...document.querySelectorAll('.check')]
              .filter(el => el.querySelector('.dot--err'))
              .map(el => (el.querySelector('.label')?.textContent ?? '') + ': ' + (el.querySelector('.value')?.textContent ?? '')),
            checks: [...document.querySelectorAll('.check')].map(el => ({
              ok: !!el.querySelector('.dot--ok'),
              label: el.querySelector('.label')?.textContent ?? '',
              value: el.querySelector('.value')?.textContent ?? '',
            })),
            version: document.getElementById('ver')?.textContent ?? '',
          }))()`)
          .then((result) => {
            const out = {
              ...result,
              pass: result.paneCount === 3 && result.checkCount >= 5 && result.failedChecks.length === 0,
            };
            const fs = { writeFileSync };
            fs.writeFileSync(join(here, '../gui-result.json'), JSON.stringify(out, null, 2), 'utf8');
            logger.info('GUI 探针完成', { pass: out.pass, okChecks: out.okChecks });
            app.exit(out.pass ? 0 : 1);
          })
          .catch((err: unknown) => {
            logger.error('GUI 探针执行失败', err);
            app.exit(1);
          });
      }, 3500);
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
