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
export type { Repositories } from './repositories/index.js';

export {
  ProjectRepository,
  BookRepository,
  ChapterRepository,
  CharacterRepository,
  EvidenceRepository,
  FactRepository,
  RunRepository,
} from './repositories/index.js';

export type {
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
  ensureChapterWorkspace,
  PROJECT_DIRS,
  PROJECT_DB_FILE,
  PROJECT_META_FILE,
  WORKSPACE_FILES,
} from './project-layout.js';
export type { ProjectMeta, WorkspaceFile } from './project-layout.js';

// ── FTS 检索索引（补缺口：ADR-0004 落地） ──────────────────
export { FtsIndex } from './fts/index.js';
export type { Tokenizer, IndexChapterInput, IndexMemoryInput } from './fts/index.js';
