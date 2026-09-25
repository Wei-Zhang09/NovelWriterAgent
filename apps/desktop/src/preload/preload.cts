/**
 * Preload —— 渲染进程与主进程之间的唯一桥（ADR-0001）
 *
 * 只暴露白名单方法，不暴露 ipcRenderer 本身。
 */
import { contextBridge, ipcRenderer } from 'electron';

const IPC_CHANNELS = {
  invoke: 'nwa:invoke',
  appInfo: 'nwa:app-info',
  coreEvent: 'nwa:core-event',
  coreExited: 'nwa:core-exited',
  pickFile: 'nwa:pickFile',
  autosave: 'nwa:autosave',
  autosaveFlush: 'nwa:autosave-flush',
} as const;

const api = {
  invoke: (method: string, params?: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.invoke, { method, params }),
  appInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
  /** 选择语料文件（§16 导入入口）—— 返回绝对路径或 null（用户取消） */
  pickFile: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.pickFile),
  /**
   * M5：推送一次内容快照（§八）。
   *
   * ⚠ `send` 而非 `invoke`：**主进程**负责 debounce 落盘，renderer 不等结果。
   *   这不是省事 —— 而是让 autosave 在 renderer 崩溃后仍能完成：
   *   内容已经在主进程手里了，页面死不死都不影响落盘。
   */
  autosave: (payload: {
    chapterId: string;
    text: string;
    cursor?: number;
    selectionStart?: number;
    selectionEnd?: number;
    scrollTop?: number;
  }): void => ipcRenderer.send(IPC_CHANNELS.autosave, payload),
  /**
   * M5：切章/关窗前 flush 未落盘内容（§十二）。
   *
   * ⚠ 必须 await：确认写完了才能切章，否则作者最后几句只在内存里。
   */
  flushAutosave: (chapterId?: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.autosaveFlush, chapterId ? { chapterId } : {}),
  onCoreEvent: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(IPC_CHANNELS.coreEvent, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.coreEvent, listener);
  },
  onCoreExited: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(IPC_CHANNELS.coreExited, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.coreExited, listener);
  },
};

contextBridge.exposeInMainWorld('nwa', api);

export type NwaApi = typeof api;
