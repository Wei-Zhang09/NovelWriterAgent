/**
 * @nwa/storage —— SQLite 访问层
 *
 * ⚠ 所有数据库访问必须经由此包。其他包不得直接引用 node:sqlite。
 *   `scripts/check-boundaries.mjs` 的 R2 规则会在 CI 中强制这一点。
 *
 * 分两层：
 *   Database          —— 连接、PRAGMA、迁移、事务、exec 传参拦截
 *   Repositories      —— 领域方法，**不暴露裸 SQL**（施工计划 STEP 1）
 *   project-layout    —— 用户项目目录契约（施工计划 §6.1，兼容性契约）
 */
export { Database } from './database.js';
export type { DatabaseOptions, Migration } from './database.js';
export { MIGRATIONS } from './migrations/index.js';

export { createRepositories } from './repositories/index.js';
export { confirmBookSettings } from './repositories/world.js';
export {
  BlueprintRepository,
  BLUEPRINT_STEP_ORDER,
  stableStringify,
  assertBlueprintStep,
} from './repositories/blueprint.js';
export type { BlueprintStepRow, BookBlueprintRow } from './repositories/blueprint.js';
export type { WorldEntityRow, CreateWorldEntityInput } from './repositories/world.js';
export { TimelineRepository, toComparableHours } from './repositories/timeline.js';
export type { CreateTimelineEventInput, TimelineQuery, TimelineEventRow } from './repositories/timeline.js';
export type { Repositories } from './repositories/index.js';
// M3：用户正文仓储（§四/§十/§三十五）
export { ManuscriptRepository, MANUSCRIPT_VERSION_SOURCES } from './repositories/manuscript.js';
export type {
  ManuscriptVersion,
  ManuscriptVersionSource,
  ManuscriptSaveResult,
  EditorState,
  AutosaveSnapshot,
  AutosaveRecoveryCheck,
} from './repositories/manuscript.js';

export {
  ProjectRepository,
  BookRepository,
  ChapterRepository,
  CharacterRepository,
  EvidenceRepository,
  FactRepository,
  RunRepository,
  ForeshadowingRepository,
  CorpusRepository,
} from './repositories/index.js';

// ⚠ 语料库的许可判定是**代码强制的硬约束**（§61），
//   因此把常量与判定函数一并导出，避免调用方各自复制一份判断逻辑。
export {
  canProcess,
  PROCESSABLE_USAGE,
  CORPUS_SOURCE_TYPES,
  CORPUS_USAGE,
} from './repositories/index.js';

// ⚠ 类型隔离（用户要求：写某类型时才用该类型的内容）
export {
  normalizeGenre,
  sameGenre,
  filterSkillsByGenre,
  filterDocumentsByGenre,
  filterScenesByGenre,
  listGenres,
  SKILL_SCOPES,
} from './repositories/index.js';
export type { SkillScope, SkillFilter, FilterableSkill, SkillFilterResult } from './repositories/index.js';

export type {
  CorpusDocumentRow,
  CorpusSceneRow,
  CorpusSourceType,
  CorpusUsage,
  RegisterDocumentInput,
  PersistSceneInput,
  PatternRow,
  SkillRow,
  ForeshadowingRow,
  ForeshadowStatus,
  ForeshadowTier,
  ProjectRow,
  BookRow,
  CreateProjectInput,
  ChapterRow,
  CharacterRow,
  CharacterStateRow,
  EvidenceRow,
  CreateEvidenceInput,
  FactRow,
  FactStatus,
  ProposeFactInput,
  RunRow,
  RunEventRow,
  CheckpointRow,
  Timestamped,
} from './repositories/index.js';

export { now, requireRow, parseJsonColumn, serializeJsonColumn, toSqlBool, fromSqlBool } from './repositories/types.js';

export {
  scaffoldProjectDir,
  readProjectMeta,
  projectPaths,
  projectLevelPaths,
  ensureChapterWorkspace,
  ensureBookDirs,
  PROJECT_DIRS,
  LEGACY_BOOK_DIRS,
  PROJECT_DB_FILE,
  PROJECT_META_FILE,
  WORKSPACE_FILES,
} from './project-layout.js';
export type { ProjectMeta, WorkspaceFile } from './project-layout.js';
// 旧布局 → 按书布局的迁移（审查报告 P0-1 的配套）
export {
  migrateLegacyLayout,
  needsLayoutMigration,
  readLayoutMigrationReport,
  LAYOUT_MARKER_FILE,
  LEGACY_BACKUP_DIR,
} from './layout-migration.js';
export type { LayoutMigrationReport } from './layout-migration.js';

// ── FTS 检索索引（补缺口：ADR-0004 落地） ──────────────────
export { FtsIndex } from './fts/index.js';
export type { Tokenizer, IndexChapterInput, IndexMemoryInput } from './fts/index.js';
