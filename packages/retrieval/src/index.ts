/**
 * @nwa/retrieval —— 本地检索（施工文档 §11 + ADR-0004）
 *
 * 硬约束（§11）：**禁止返回没有来源的「无根记忆」**。
 * 检索结果类型中 sourceRef 为必填，缺失时抛错而非返回空来源。
 */
export * from './tokenizer.js';
