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
} as const;

const api = {
  invoke: (method: string, params?: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.invoke, { method, params }),
  appInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
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
