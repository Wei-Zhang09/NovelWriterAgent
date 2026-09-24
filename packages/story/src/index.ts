/**
 * @nwa/story —— Story Memory 层
 *
 * MVP 范围（ADR-0003）：Canon / Fact / Evidence / Character State。
 * 预留（Full）：Timeline / Foreshadowing / World Entity。
 *
 * STEP 8 已实现：Continuity Checker（十维度对账，只读）
 * STEP 9 已实现：Fact 抽取 + Canon 提升（只 propose，不直接写库）
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

export { FactExtractor } from './canon/fact-extractor.js';
export type {
  FactExtractorOptions,
  ExtractStructuredCaller,
  KnownCharacter,
  ExtractionResult,
  ExtractionRequest,
} from './canon/fact-extractor.js';
export { CanonPromoter } from './canon/canon-promoter.js';
export type { PromotePolicy, PromoteOutcome, PromoteReport } from './canon/canon-promoter.js';

// ── State Settlement（§六 P0-4）────────────────────────────
export { StateExtractor } from './state/state-extractor.js';
export type {
  StateExtractorOptions,
  StateExtractionRequest,
  StateExtractionResult,
} from './state/state-extractor.js';
export {
  StateVerifier,
  verifyQuoteSpan,
  resolveQuoteSpan,
  resolveAndVerifySpan,
  overallStatus,
} from './state/state-verifier.js';
export type { StateVerifierOptions, VerifyInput } from './state/state-verifier.js';
export { StateProposalRepository } from './state/state-proposal.js';
export type { StateProposalRecord } from './state/state-proposal.js';
export { StateSettlement } from './state/state-settlement.js';
export type { StateSettlementOptions, SettleResult } from './state/state-settlement.js';

export const STORY_PACKAGE_READY = true;

// ── Backup / Import / Export（STEP 21 / §58 §59） ────────────
export { exportProject, verifyExport, EXPORT_FORMAT_VERSION } from './backup/export-project.js';
export type { ExportManifest, ExportOptions, ExportResult } from './backup/export-project.js';
export { restoreBackup, rebuildFts, BACKUP_DIRS } from './backup/restore-backup.js';
export type { RestoreOptions, RestoreResult } from './backup/restore-backup.js';
