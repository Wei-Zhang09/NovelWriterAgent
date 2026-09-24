/**
 * 仓储层统一出口
 *
 * Usage:
 *   const db = new Database({ path, migrations: MIGRATIONS });
 *   const repos = createRepositories(db);
 *   repos.projects.create({ ... });
 */
import type { Database } from '../database.js';
import { ProjectRepository, BookRepository } from './projects.js';
import { ChapterRepository } from './chapters.js';
import { CharacterRepository } from './characters.js';
import { EvidenceRepository } from './evidence.js';
import { FactRepository } from './facts.js';
import { RunRepository } from './runs.js';
import { ForeshadowingRepository } from './foreshadowing.js';
import { CorpusRepository } from './corpus.js';
import { TimelineRepository } from './timeline.js';
import { CommitOverrideRepository } from './commit-overrides.js';
import { WorldRepository } from './world.js';

export interface Repositories {
  readonly projects: ProjectRepository;
  readonly books: BookRepository;
  readonly chapters: ChapterRepository;
  readonly characters: CharacterRepository;
  readonly evidence: EvidenceRepository;
  readonly facts: FactRepository;
  readonly runs: RunRepository;
  /** 伏笔账目（§14 六态机）—— STEP 8 引入 */
  readonly foreshadowing: ForeshadowingRepository;
  /** 语料库（§16/§45/§61）—— STEP 14 引入 */
  readonly corpus: CorpusRepository;
  /**
   * 时间线（P0-5）。
   *
   * ⚠ 表在 `0001_init.sql:227` 就建好了，但此前**全仓无代码使用它** ——
   *   「建了表没接线」。P0-5 补上仓储层，复用已有表，不另建。
   */
  readonly timeline: TimelineRepository;
  /**
   * Commit 绕过审计（P1 / §十二）。
   *
   * ⚠ 存在的理由：硬性前置检查（摘要必须已批准）总会有必须绕过的
   *   现实情形。没有正规通道，绕过就会变成改代码或直接改库 —— 不留痕。
   *   这张表让每次绕过都可审计，且记录**当时的状态快照**。
   */
  readonly commitOverrides: CommitOverrideRepository;
  /**
   * 世界观设定（P2-3）。
   *
   * ⚠ 表在 `0001_init.sql:214` 就建好了，但此前**全仓零引用**
   *   （ADR-0003 列为「Schema 预留，MVP 不写入」）。到了 Full 阶段
   *   就成了"表在那里，没人用" —— 与 timeline（P0-5）、
   *   characters（P2-2）同一类缺陷。
   */
  readonly world: WorldRepository;
}

export function createRepositories(db: Database): Repositories {
  return {
    projects: new ProjectRepository(db),
    books: new BookRepository(db),
    chapters: new ChapterRepository(db),
    characters: new CharacterRepository(db),
    evidence: new EvidenceRepository(db),
    facts: new FactRepository(db),
    runs: new RunRepository(db),
    foreshadowing: new ForeshadowingRepository(db),
    corpus: new CorpusRepository(db),
    timeline: new TimelineRepository(db),
    commitOverrides: new CommitOverrideRepository(db),
    world: new WorldRepository(db),
  };
}

export { ProjectRepository, BookRepository } from './projects.js';
export { ChapterRepository } from './chapters.js';
export { CharacterRepository } from './characters.js';
export { EvidenceRepository } from './evidence.js';
export { FactRepository } from './facts.js';
export { RunRepository } from './runs.js';
export { ForeshadowingRepository, FORESHADOW_STATUSES, FORESHADOW_TIERS } from './foreshadowing.js';
export { CorpusRepository, canProcess, PROCESSABLE_USAGE, CORPUS_SOURCE_TYPES, CORPUS_USAGE } from './corpus.js';
export { TimelineRepository } from './timeline.js';
export { CommitOverrideRepository } from './commit-overrides.js';
export { WorldRepository, confirmBookSettings } from './world.js';
export type { WorldEntityRow, CreateWorldEntityInput } from './world.js';
export type { CommitOverrideRow, OverriddenCheck } from './commit-overrides.js';
export type { CreateTimelineEventInput, TimelineQuery } from './timeline.js';
// ⚠ 类型隔离是用户要求的硬约束，导出唯一入口避免各调用方自写过滤
export {
  normalizeGenre,
  sameGenre,
  filterSkillsByGenre,
  filterDocumentsByGenre,
  filterScenesByGenre,
  listGenres,
  SKILL_SCOPES,
} from './genre.js';
export type { SkillScope, SkillFilter, FilterableSkill, SkillFilterResult } from './genre.js';
export type {
  CorpusDocumentRow,
  CorpusSceneRow,
  CorpusSourceType,
  CorpusUsage,
  RegisterDocumentInput,
  PersistSceneInput,
  PatternRow,
  SkillRow,
} from './corpus.js';
export type { ForeshadowingRow, ForeshadowStatus, ForeshadowTier } from './foreshadowing.js';
export type { ProjectRow, BookRow, CreateProjectInput } from './projects.js';
export type { ChapterRow } from './chapters.js';
export type { CharacterRow, CharacterStateRow } from './characters.js';
export type { EvidenceRow, CreateEvidenceInput } from './evidence.js';
export type { FactRow, FactStatus, ProposeFactInput } from './facts.js';
export type { RunRow, RunEventRow, CheckpointRow } from './runs.js';
export * from './types.js';
