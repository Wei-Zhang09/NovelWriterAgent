-- 0012_commit_force_audit.sql
--
-- 强制绕过 Summary Approval 的审计通道（P1）
--
-- ## 为什么需要这条通道
--
-- §十二 的硬要求是：Commit 需要 `summary != empty AND summary_approved == 1`。
-- 但现实里存在必须绕过的情形（作者确认这章不要摘要、紧急修复已发布章节）。
-- 若**没有**正规绕过通道，唯一的"绕过"就是有人去改代码或直接改库 ——
-- 那才是真正危险的：绕过不留痕，事后无法回答"这章为什么没有摘要"。
--
-- 所以设计成：**允许绕过，但必须显式声明并留下审计记录**。
-- 默认不允许绕过（`commitMode` 缺省为 'clean'）。
--
-- ## 为什么不复用 run_events
--
-- run_events.run_id 有外键指向 runs(id)，而 commit 可能发生在
-- **没有 agent run** 的上下文里（用户在 UI 直接点提交）。塞一个不存在的
-- run_id 会触发 FOREIGN KEY 失败 —— 而事件写入失败曾导致阶段永远卡在
-- RUNNING（见 llm-generation-pipelines 规则 40）。审计记录必须比业务流更
-- 可靠，所以单独建表、不挂外键。

-- ── 1. commit_mode 增加 FORCE ─────────────────────────────
--
-- ⚠ 必须**重建表**：SQLite 不支持修改 CHECK 约束。
--   已确认全仓**没有任何表**用外键引用 commit_manifests，
--   所以重建不会连带破坏其他表的外键。
--
-- ⚠ 重建顺序不能变：建新表 → 搬数据 → 删旧表 → 改名 →
--   重建索引。若先删旧表再建新表，中途失败会永久丢数据。
--
-- ⚠ 迁移由 database.ts 包在 BEGIN/COMMIT 里执行，失败会 ROLLBACK，
--   所以这里不需要自己开事务（嵌套 BEGIN 会报错）。

CREATE TABLE commit_manifests_new (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('PREPARING', 'APPLIED', 'COMMITTED', 'ROLLED_BACK', 'FAILED')),
  phase TEXT NOT NULL CHECK (phase IN ('prepared', 'staged', 'committing', 'committed')),
  applied_count INTEGER NOT NULL DEFAULT 0,
  -- ADR-0005 + P1：with_debt 是「带着已知质量债提交」，
  -- FORCE 是「显式绕过硬性前置检查」—— 两者语义不同，不可混用。
  -- FORCE 必须同时留下 commit_overrides 记录（见下）。
  commit_mode TEXT NOT NULL CHECK (commit_mode IN ('clean', 'with_debt', 'FORCE')),
  artifact_manifest_json TEXT NOT NULL,
  indexes_pending_json TEXT,
  fact_ids_json TEXT,
  foreshadowing_ids_json TEXT,
  quality_debt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  staged_at TEXT,
  applied_at TEXT,
  committed_at TEXT
);

INSERT INTO commit_manifests_new
  (id, chapter_id, status, phase, applied_count, commit_mode,
   artifact_manifest_json, indexes_pending_json, fact_ids_json,
   foreshadowing_ids_json, quality_debt_count, created_at, staged_at, applied_at, committed_at)
SELECT
   id, chapter_id, status, phase, applied_count, commit_mode,
   artifact_manifest_json, indexes_pending_json, fact_ids_json,
   foreshadowing_ids_json, quality_debt_count, created_at, staged_at, applied_at, committed_at
FROM commit_manifests;

DROP TABLE commit_manifests;

ALTER TABLE commit_manifests_new RENAME TO commit_manifests;

CREATE INDEX idx_commit_manifests_status ON commit_manifests(status);
CREATE INDEX idx_commit_manifests_chapter ON commit_manifests(chapter_id);

-- ── 2. 绕过审计表 ─────────────────────────────────────────

CREATE TABLE commit_overrides (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  -- 对应的提交清单。允许 NULL：绕过可能在 PREPARE 之前就被拒绝。
  manifest_id TEXT,
  -- 被绕过的具体检查项。当前只有 SUMMARY_APPROVAL，保留多值以便扩展。
  overridden_check TEXT NOT NULL,
  -- ⚠ 绕过时的**实际状态快照** —— 这是审计的核心。
  --   事后要能回答"当时摘要到底批没批"，而不是只知道"绕过了"。
  --   只记一个 boolean 会让"当时是空的"与"当时有但没批"无法区分，
  --   而这两种情况的责任完全不同。
  summary_approved_at_override INTEGER NOT NULL,
  summary_present_at_override INTEGER NOT NULL,
  -- 绕过理由（自由文本，供人工填写）
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_commit_overrides_chapter ON commit_overrides(chapter_id, created_at);
CREATE INDEX idx_commit_overrides_check ON commit_overrides(overridden_check, created_at);
