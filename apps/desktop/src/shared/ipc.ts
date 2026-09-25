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
  /**
   * M5：自动保存（renderer 推增量，**主进程** debounce 落盘）。
   *
   * ⚠ 为什么单独一个通道而不是复用 INVOKE：
   *   autosave 是**高频单向**的（每次输入一次），走 INVOKE 会为每次
   *   按键建一个 requestId + Promise，且调用方其实不关心返回值。
   *   更重要的是语义：它不是"一次业务调用"，是"内容快照"。
   */
  AUTOSAVE: 'nwa:autosave',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
