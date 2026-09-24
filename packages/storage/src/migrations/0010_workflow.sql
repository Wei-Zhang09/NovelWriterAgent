-- 0010_workflow.sql
--
-- Novel Workflow 持久化（v1.0 闭环施工提示词 §三 P0-1 / §四 P0-2 / §二十 / §二十二）
--
-- ## 为什么需要这几张表
--
-- 现状：写作链由 UI 通过 IPC **逐个直连**驱动 ——
-- `writer.draft` → `review.run` → `revision.run` → `continuity.check`
-- → `commit.run`。后果有三：
--
--   1. **编排逻辑在调用方手里**（提示词 §三 明确禁止）。谁先谁后、能否
--      跳过、失败怎么办，全靠 UI 与脚本自觉 —— 换个调用方就换套规则。
--   2. **暂停实际等于取消**（P0-2 已确认的真 bug）：`runtime.pause()`
--      调 `controller.abort()`，run 循环捕获后把状态写成 `CANCELLED`。
--   3. **恢复依据在内存里**：`Map` / `Set` / `lastCompletedStage`。
--      进程一关全丢 —— 重启后无法知道哪些昂贵阶段已经跑完。
--
-- 提示词 §四 的要求很明确：**恢复依据必须落库**，内存只能当运行时缓存。
-- 这几张表就是那个「依据」。
--
-- ## 为什么 stage 单独一张表，而不是塞进 workflows 的 JSON 列
--
-- 提示词 §四 的硬要求是「**DONE 的 Stage 永远不会重复执行**」。这条要在
-- 恢复时被查询、被断言、被审计。塞进 JSON 里就只能整块读写，
-- 既无法用 SQL 判断「write 是否已 DONE」，也无法加唯一约束防止重复落库。
-- 拆成行之后 `UNIQUE(workflow_id, stage_id)` 让「同一 stage 两条记录」
-- 在数据库层就不可能发生 —— 这是**用约束代替自觉**。
--
-- ## 为什么不另建 timeline_events
--
-- 提示词 §七 建议新建 `timeline_events`，但扫描发现 **0001_init.sql:227
-- 已经有这张表**，且 schema 更好：它区分了 `story_time_value`（故事世界
-- 内可计算的发生时间）与 `narrative_chapter/offset`（叙事顺序）。
-- 提示词建议的字段把这两者混在一个 `event_time` 里，反而更弱。
-- 故 **复用已有表**（P0-5 只补代码，不补表）。

-- ── 工作流主表 ──
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_id TEXT REFERENCES chapters(id) ON DELETE CASCADE,
  chapter_number INTEGER,
  workflow_type TEXT NOT NULL DEFAULT 'novel',

  -- 提示词 §三 的 16 态：CREATED / BUILDING_CONTEXT / PLANNING /
  -- VERIFYING_PLAN / WRITING / REVIEWING / REVISING / CHECKING_CONTINUITY /
  -- SETTLING_STATE / READY_TO_COMMIT / COMMITTING / VERIFYING_COMMIT /
  -- DONE / FAILED / PAUSED / CANCELLED
  status TEXT NOT NULL,

  -- 当前（或即将执行的）stage
  current_stage TEXT,
  -- 恢复游标：最后一个成功完成的 stage。
  -- ⚠ 恢复时从这里往后跑，**前面的 DONE stage 一律跳过**。
  resume_cursor TEXT,

  -- 每个 stage 的输入/输出快照。stage 之间传递的是结构化结果，
  -- 不是内存引用 —— 进程重启后仍能据此重建上下文。
  stage_inputs_json TEXT NOT NULL DEFAULT '{}',
  stage_outputs_json TEXT NOT NULL DEFAULT '{}',
  -- 提示词 §二十二 Artifact First：关键中间结果都落成文件，
  -- 这里存它们的引用（类型 + 路径 + hash）
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  -- 自定义恢复点（阶段内的细粒度续跑，如「写到第 3 个场景」）
  checkpoint_json TEXT,
  error_json TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 恢复时按「未完成的工作流」查找：进程重启后要能快速捞出来
CREATE INDEX idx_workflows_status ON workflows(status);
CREATE INDEX idx_workflows_book ON workflows(book_id, chapter_number);
CREATE INDEX idx_workflows_chapter ON workflows(chapter_id);

-- ── 工作流阶段 ──
CREATE TABLE workflow_stages (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  -- stage 标识：create_chapter / build_context / plan / plan_verify / write /
  -- review / revision / continuity / state_settlement / ready_to_commit /
  -- commit / verify
  stage_id TEXT NOT NULL,
  -- 执行顺序（不依赖插入顺序，排序稳定）
  ordinal INTEGER NOT NULL,

  -- PENDING / RUNNING / DONE / FAILED / SKIPPED
  status TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  -- 尝试次数（重试可见，避免"悄悄重试了 5 次"）
  attempts INTEGER NOT NULL DEFAULT 0,

  -- 结构化输出（提示词 §二十一：Stage 输出必须结构化，不是长字符串）
  output_json TEXT,
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  error_json TEXT,

  -- ⚠ 这条唯一约束是「DONE 的 Stage 不会重复执行」的数据库层保证：
  --   同一工作流的同一 stage 不可能有两行，因此不可能被"再跑一次"覆盖。
  UNIQUE(workflow_id, stage_id)
);

CREATE INDEX idx_workflow_stages_wf ON workflow_stages(workflow_id, ordinal);
CREATE INDEX idx_workflow_stages_status ON workflow_stages(workflow_id, status);

-- ── 工作流产物（§二十二 Artifact First）──
CREATE TABLE workflow_artifacts (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL,
  -- plan / draft / review / revision / continuity / proposed_state /
  -- commit_manifest / deviation
  artifact_type TEXT NOT NULL,
  chapter_id TEXT,
  -- 相对工作区的路径
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_workflow_artifacts_wf ON workflow_artifacts(workflow_id, stage_id);
CREATE INDEX idx_workflow_artifacts_type ON workflow_artifacts(workflow_id, artifact_type);

-- ── 检索轨迹（§五 Retrieval Trace）──
--
-- 提示词要求最终能回答「为什么这一章会引用那个旧章节」。没有这张表，
-- 检索结果用完即弃，事后只能靠猜。
CREATE TABLE retrieval_traces (
  id TEXT PRIMARY KEY,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE,
  run_id TEXT,
  -- 哪个 stage 发起的检索（planner / writer / reviewer / continuity）
  stage TEXT NOT NULL,
  query TEXT NOT NULL,
  retriever TEXT NOT NULL,
  hit_id TEXT NOT NULL,
  score REAL,
  -- 命中来源（chapter:12 / fact:xxx / skill:yyy）—— 让结论可回溯到原文
  source_ref TEXT,
  -- 为什么命中（人话，用于解释"这条为何被选进来"）
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_retrieval_traces_wf ON retrieval_traces(workflow_id, stage);
CREATE INDEX idx_retrieval_traces_hit ON retrieval_traces(hit_id);

-- ── 状态提议（§六 P0-4 State Settlement）──
--
-- 硬约束：**没有 VERIFIED 的 State Proposal 不得进入 Canon**。
-- 因此这张表必须有 status，且 Canon 写入路径必须校验它。
CREATE TABLE state_proposals (
  id TEXT PRIMARY KEY,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,

  facts_json TEXT NOT NULL DEFAULT '[]',
  character_states_json TEXT NOT NULL DEFAULT '[]',
  timeline_events_json TEXT NOT NULL DEFAULT '[]',
  foreshadowing_json TEXT NOT NULL DEFAULT '[]',
  relationships_json TEXT NOT NULL DEFAULT '[]',

  -- PROPOSED / VERIFIED / REJECTED
  status TEXT NOT NULL,
  -- 验证过程与依据（哪条通过、哪条被拒、为什么）
  verification_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_state_proposals_chapter ON state_proposals(chapter_id);
CREATE INDEX idx_state_proposals_wf ON state_proposals(workflow_id);
CREATE INDEX idx_state_proposals_status ON state_proposals(status);
