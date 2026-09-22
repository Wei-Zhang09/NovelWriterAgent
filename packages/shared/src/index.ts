/**
 * @nwa/shared —— 跨包数据契约（施工文档 §55 Rule 3）
 *
 * 分层：
 *   enums   —— 集中定义的枚举（研究报告 R8：禁止散落字符串）
 *   domain  —— 领域对象 Schema（camelCase，与 DB 行分离）
 *   tool    —— Tool 契约（Rule 4 的 input/output/permission/errorCode）
 *   plan    —— ChapterBrief / ScenePlan（§29 / §30）
 */
export * from './schemas/enums.js';
export * from './schemas/domain.js';
export * from './schemas/tool.js';
export * from './schemas/plan.js';
// ⚠ annotation 放在 plan 之后：它复用 plan.ts 的 SceneFunctionSchema
export * from './schemas/annotation.js';
export * from './schemas/review.js';
export * from './schemas/fact-extraction.js';
export * from './schemas/skill.js';
