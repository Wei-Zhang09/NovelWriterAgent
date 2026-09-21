/**
 * @nwa/story —— Story Memory 层
 *
 * MVP 范围（ADR-0003）：Canon / Fact / Evidence / Character State。
 * 预留（Full）：Timeline / Foreshadowing / World Entity。
 *
 * STEP 8 已实现：Continuity Checker（十维度对账，只读）
 *
 * 待 STEP 9 实现：
 *   - Fact 抽取：从 draft 生成 proposed_facts（**只 propose，不直接写库**）
 *   - 冲突检测：与已有 Canon 矛盾时标记 CONTRADICTED，而非覆盖
 *   - Evidence 校验：quote 必须能在 source_ref 的 [start,end) 区间精确匹配（研究报告 R4）
 */
export {
  ChapterWorkspace,
  WORKSPACE_FILES,
} from './workspace/chapter-workspace.js';
export type {
  WorkspaceFileKey,
  ChapterWorkspaceOptions,
  WorkspaceSnapshot,
} from './workspace/chapter-workspace.js';

export {
  ContinuityChecker,
  CONTINUITY_DIMENSIONS,
} from './continuity/checker.js';
export type {
  ContinuityDimension,
  ContinuityIssue,
  ContinuityReport,
  IssueSeverity,
  ContinuityCheckerOptions,
} from './continuity/checker.js';

export const STORY_PACKAGE_READY = true;
