-- ═══════════════════════════════════════════════════════════════════
-- NovelWriter Agent — 初始迁移
-- 依据：施工文档 §10 / ADR-0002 v2 / ADR-0004 / ADR-0005 / ADR-0006
-- 施工计划 §3.1：MVP 启用 12 张 + 预留 8 张 + 元数据 3 张
-- ═══════════════════════════════════════════════════════════════════
-- 注意：PRAGMA foreign_keys 是连接级设置，由 Database 构造函数统一施加，
--      不在迁移文件内重复设置。
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. 项目与书 ─────────────────────────────────────────────
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  genre TEXT,
  premise TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE books (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  current_chapter INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_books_project ON books(project_id);

-- ── 2. 章节 ─────────────────────────────────────────────────
CREATE TABLE chapters (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  plan_json TEXT,
  body_path TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, chapter_number)
);
CREATE INDEX idx_chapters_book_status ON chapters(book_id, status);

-- ── 3. 角色与角色状态 ────────────────────────────────────────
CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  aliases_json TEXT,
  role TEXT,
  current_status TEXT,
  profile_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_characters_book ON characters(book_id);

CREATE TABLE character_states (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  source_fact_ids_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(character_id, chapter_number)
);
CREATE INDEX idx_char_states_character ON character_states(character_id, chapter_number DESC);

-- ── 4. 证据（ADR 研究报告 R4：三字段必填 + 写入时校验） ──────
-- id 由 evidenceId() 内容派生，见 @nwa/core 的 ids.ts
CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  -- 以下三字段 NOT NULL：evidence 必须能回答「对应原文哪一句」（研究报告 R4）
  quote TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  CHECK (end_offset > start_offset),
  CHECK (length(quote) > 0)
);
CREATE INDEX idx_evidence_book ON evidence(book_id);
CREATE INDEX idx_evidence_source ON evidence(source_type, source_ref);

-- ── 5. 事实（ADR 研究报告 R7：id 内容派生） ─────────────────
-- id = factId(subject_type|subject_id|predicate|object_value)，不含 status/confidence
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  predicate TEXT NOT NULL,
  object_value TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CANON', 'PROVISIONAL', 'CONTRADICTED', 'RETIRED')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  -- 证据缺失不应删除事实，而应标记待补证据（ADR-0002 v2 外键策略）
  evidence_id TEXT REFERENCES evidence(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_facts_book_status ON facts(book_id, status);
CREATE INDEX idx_facts_subject ON facts(subject_type, subject_id, predicate);
CREATE INDEX idx_facts_chapter ON facts(source_chapter_id);
CREATE INDEX idx_facts_evidence ON facts(evidence_id);

-- ── 6. 提交清单（ADR-0002 v2） ───────────────────────────────
-- v1.0 新增表；原施工文档 §10 的 18 张表中没有它，但 §36 的原子性要求无法在无此表的情况下实现
CREATE TABLE commit_manifests (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('PREPARING', 'APPLIED', 'COMMITTED', 'ROLLED_BACK', 'FAILED')),
  -- ADR-0002 v2：phase 四态让中断点可精确定位
  phase TEXT NOT NULL CHECK (phase IN ('prepared', 'staged', 'committing', 'committed')),
  applied_count INTEGER NOT NULL DEFAULT 0,
  -- ADR-0005：区分正常提交与「带质量债提交」
  commit_mode TEXT NOT NULL CHECK (commit_mode IN ('clean', 'with_debt')),
  artifact_manifest_json TEXT NOT NULL,
  -- ADR-0002 v2：待重建的检索索引清单（FTS 不进事务，靠此标记补偿）
  indexes_pending_json TEXT,
  fact_ids_json TEXT,
  foreshadowing_ids_json TEXT,
  quality_debt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  staged_at TEXT,
  applied_at TEXT,
  committed_at TEXT
);
CREATE INDEX idx_commit_manifests_status ON commit_manifests(status);
CREATE INDEX idx_commit_manifests_chapter ON commit_manifests(chapter_id);

-- ── 7. 质量债（ADR-0005） ────────────────────────────────────
CREATE TABLE quality_debt (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  -- 来自 review.json 的 issue.id
  issue_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('MAJOR', 'MINOR', 'NOTE')),
  category TEXT NOT NULL,
  claim TEXT NOT NULL,
  evidence_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'ACCEPTED', 'RESOLVED', 'WAIVED')),
  -- ADR-0005：WAIVED 必须填理由（豁免权归人，模型不得自行豁免）
  waived_reason TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (status <> 'WAIVED' OR (waived_reason IS NOT NULL AND length(waived_reason) > 0))
);
CREATE INDEX idx_quality_debt_chapter ON quality_debt(chapter_id, status);

-- ── 8. 运行与事件（ADR-0006 约束 B） ─────────────────────────
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_type TEXT NOT NULL,
  status TEXT NOT NULL,
  current_step TEXT,
  model_profile_id TEXT,
  input_json TEXT,
  output_json TEXT,
  error_json TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX idx_runs_project_status ON runs(project_id, status);

CREATE TABLE run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- ADR-0006 约束 B：集中 enum 的事件类型（禁止自由字符串）
  event_type TEXT NOT NULL,
  -- ADR-0006 约束 B：OBSERVABILITY 类可过期删除，STATE 类必须长期保留
  category TEXT NOT NULL CHECK (category IN ('OBSERVABILITY', 'STATE')),
  step TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_run_events_run ON run_events(run_id, created_at);
CREATE INDEX idx_run_events_category ON run_events(category, created_at);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- 阶段级 checkpoint（研究报告 R2）：恢复时从最近完成阶段继续，不重跑昂贵调用
  stage TEXT NOT NULL,
  state_json TEXT NOT NULL,
  artifact_manifest_json TEXT NOT NULL,
  -- 恢复时用于校验 DB schema 版本是否兼容
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_checkpoints_run ON checkpoints(run_id, created_at DESC);

-- ── 9. 检索元数据（ADR-0004） ────────────────────────────────
-- 分词器版本化：变更分词器必须全量 rebuild FTS
CREATE TABLE tokenizer_meta (
  name TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  dict_hash TEXT,
  tokenizer_kind TEXT NOT NULL CHECK (tokenizer_kind IN ('jieba', 'bigram')),
  applied_at TEXT NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════
-- 以下为 v1.0-Full 启用表：MVP 建表但不写入，避免 Full 阶段改表
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE world_entities (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  data_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_world_entities_book ON world_entities(book_id, type);

-- Timeline（研究报告 §2.2 差异 3：事件时间与叙述时间必须分离）
CREATE TABLE timeline_events (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  -- story_time：故事世界内的发生时间（可计算类型，相对天数）
  story_time_value REAL,
  story_time_unit TEXT,
  -- display 是自由文本补充，不是主字段
  story_time_display TEXT,
  -- narrative_order：在第几章、章内第几段被叙述
  narrative_chapter INTEGER,
  narrative_offset INTEGER,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  importance INTEGER DEFAULT 1,
  data_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_timeline_book_chapter ON timeline_events(book_id, narrative_chapter);
CREATE INDEX idx_timeline_story_time ON timeline_events(book_id, story_time_value);

CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'CANON', 'DYNAMIC_STATE', 'SEMANTIC', 'RELATIONSHIP',
    'PLOT', 'SETTING', 'STYLE', 'LESSON'
  )),
  title TEXT,
  content TEXT NOT NULL,
  importance INTEGER DEFAULT 1,
  protected INTEGER DEFAULT 0,
  compressible INTEGER DEFAULT 1,
  source_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_memory_book_type ON memory_items(book_id, type, importance DESC);

CREATE TABLE foreshadowing (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  setup_chapter INTEGER,
  expected_payoff_chapter INTEGER,
  -- 六态机（研究报告 §2.2 差异 2：参考项目全代际只有 2-3 态且无推进规则）
  status TEXT NOT NULL CHECK (status IN (
    'PLANNED', 'PLANTED', 'DEVELOPING', 'READY', 'PAID_OFF', 'ABANDONED'
  )),
  tier TEXT NOT NULL DEFAULT 'SIDE' CHECK (tier IN ('CORE', 'SIDE', 'DECOR')),
  importance INTEGER DEFAULT 1,
  description TEXT,
  evidence_ids_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_foreshadow_book_status ON foreshadowing(book_id, status);

CREATE TABLE distilled_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  trigger_json TEXT,
  rules_json TEXT NOT NULL,
  examples_json TEXT,
  anti_patterns_json TEXT,
  evidence_refs_json TEXT,
  confidence REAL NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CANDIDATE', 'REVIEW', 'VALIDATED', 'ACTIVE', 'DEPRECATED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_distilled_skills_status ON distilled_skills(status, category);

CREATE TABLE corpus_documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  source_type TEXT NOT NULL,
  license_type TEXT NOT NULL CHECK (license_type IN (
    'PUBLIC_DOMAIN', 'USER_OWNED', 'USER_LICENSED', 'REFERENCE_ONLY', 'UNKNOWN'
  )),
  local_path TEXT,
  genre TEXT,
  popularity_tags_json TEXT,
  quality_tags_json TEXT,
  allowed_usage TEXT NOT NULL CHECK (allowed_usage IN (
    'FULL_ANALYSIS', 'DISTILLATION_ONLY', 'RETRIEVAL_ONLY', 'NO_PROCESSING'
  )),
  content_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE corpus_scenes (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES corpus_documents(id) ON DELETE CASCADE,
  chapter_number INTEGER,
  scene_index INTEGER,
  text_path TEXT,
  scene_type TEXT,
  annotation_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_corpus_scenes_doc ON corpus_scenes(document_id, chapter_number, scene_index);

CREATE TABLE distillation_patterns (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  trigger_json TEXT,
  pattern_json TEXT NOT NULL,
  strategy_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  -- 跨作品对比（§21）需要按这些字段聚合，故从 pattern_json 冗余为独立列
  mechanism TEXT,
  genre TEXT,
  scene_function TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_patterns_category ON distillation_patterns(category);
CREATE INDEX idx_patterns_mechanism ON distillation_patterns(mechanism);
