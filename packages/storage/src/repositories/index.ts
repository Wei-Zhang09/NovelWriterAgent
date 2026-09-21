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
  };
}

export { ProjectRepository, BookRepository } from './projects.js';
export { ChapterRepository } from './chapters.js';
export { CharacterRepository } from './characters.js';
export { EvidenceRepository } from './evidence.js';
export { FactRepository } from './facts.js';
export { RunRepository } from './runs.js';
export { ForeshadowingRepository, FORESHADOW_STATUSES, FORESHADOW_TIERS } from './foreshadowing.js';
export type { ForeshadowingRow, ForeshadowStatus, ForeshadowTier } from './foreshadowing.js';
export type { ProjectRow, BookRow, CreateProjectInput } from './projects.js';
export type { ChapterRow } from './chapters.js';
export type { CharacterRow, CharacterStateRow } from './characters.js';
export type { EvidenceRow, CreateEvidenceInput } from './evidence.js';
export type { FactRow, FactStatus, ProposeFactInput } from './facts.js';
export type { RunRow, RunEventRow, CheckpointRow } from './runs.js';
export * from './types.js';
