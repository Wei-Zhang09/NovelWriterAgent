/**
 * @nwa/harness —— Novel Harness
 *
 * 组件（施工文档 §6.1）：Model Gateway / Tool Registry / Agent Runtime /
 * Context Engine / Skill Engine / Workflow Engine / Event Bus / Checkpoint /
 * Verification / Artifact Manager。
 *
 * 待 STEP 3–4 实现。关键约束：
 *   - 结构化输出走「单次工具调用提交」，宿主**绝不**从 assistant 文本抠 JSON
 *     （研究报告 §1.2 决策 4）
 *   - 审查类 Agent（Reviewer / Continuity）**只读**，不给 Write 权限
 *     （研究报告 §2.1 采纳 5）
 *   - 状态迁移由代码执行，模型只能 request_transition（§8.2）
 */
export const HARNESS_PACKAGE_READY = true;
