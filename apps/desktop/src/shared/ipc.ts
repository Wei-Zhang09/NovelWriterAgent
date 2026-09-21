/**
 * IPC channel 常量 —— main / preload 的唯一来源。
 *
 * 禁止在任何地方硬编码 channel 字符串（研究报告 R8 的同一条原则）。
 */
export const IPC = {
  INVOKE: 'nwa:invoke',
  APP_INFO: 'nwa:app-info',
  CORE_EVENT: 'nwa:core-event',
  CORE_EXITED: 'nwa:core-exited',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
