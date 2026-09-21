/**
 * @nwa/shared —— 跨包数据契约（施工文档 §55 Rule 3）
 *
 * 分层：
 *   enums   —— 集中定义的枚举（研究报告 R8：禁止散落字符串）
 *   domain  —— 领域对象 Schema（camelCase，与 DB 行分离）
 *   tool    —— Tool 契约（Rule 4 的 input/output/permission/errorCode）
 */
export * from './schemas/enums.js';
export * from './schemas/domain.js';
export * from './schemas/tool.js';
