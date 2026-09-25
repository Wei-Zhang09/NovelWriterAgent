/**
 * @nwa/core —— 零依赖基础层
 *
 * 职责：错误码、ID 生成、分层日志、配置校验。
 * 本包不得依赖任何其他 @nwa/* 包，也不得依赖 electron / zod。
 */
export * from './errors.js';
export * from './ids.js';
export * from './logging.js';
export * from './config.js';
export * from './text-similarity.js';
export * from './rule-conflict.js';
export * from './scope-evidence.js';
export * from './summary.js';
export * from './word-target.js';
export * from './settings-gate.js';
export * from './world-rule-conflict.js';
export * from './staleness.js';
export * from './editor-metrics.js';
