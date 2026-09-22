-- 0008_scene_persistence.sql
--
-- 场景标注持久化（STEP 15 → STEP 16 的衔接）
--
-- ## 为什么需要新字段
--
-- 0001 的 `corpus_scenes` 只有 id/document_id/chapter_number/scene_index/
-- text_path/scene_type/annotation_json/created_at，不足以支撑 STEP 16 的
-- 模式挖掘。缺的关键项：
--
-- ### 1. `annotated` 标志（**最关键**）
--
-- 语义标注可能失败（模型不可用/超时/schema 不符）。失败时语义字段为空，
-- 但**"空"不等于"没有 sceneFunction"** —— 前者是"没标注"，后者是
-- "标注了但确实没有"。
--
-- 若没有这个标志，模式挖掘会把两者混为一谈：
--   「统计 sceneFunction 分布」时，未标注场景会被当作
--   "sceneFunction 未知的一类"，而它的占比只反映**标注失败率**，
--   不是叙事事实。这种污染是静默的。
--
-- ### 2. `scene_function` 独立列（冗余自 annotation_json）
--
-- 模式挖掘要按场景功能**聚合统计**（§20/§21 的跨作品对比）。
-- 从 JSON 里取需要全表扫描 + 解析，无法走索引。
-- 冗余为独立列 + 索引，聚合才可用。
--
-- ### 3. `pacing_json` / `prose_json` 独立存储
--
-- 这两项是**代码算的机械指标**，与"模型给的语义标注"性质不同。
-- 分开存的理由：语义标注失败时机械指标仍然有效（它们不依赖模型），
-- 混在 annotation_json 里会让"这个场景有没有可用数据"变得含糊。
--
-- ### 4. `boundary_reason`（§18 的切分依据）
--
-- 模式挖掘要区分"这场戏为什么被切开" —— 按时间切与按地点切，
-- 对"节奏"这一维度的含义不同。
--
-- ### 5. `chars` / `paragraph_count`
--
-- 场景长度的基础统计。从 text 实时算需要读文件，无法用于聚合查询。
--
-- ## 为什么文本用文件而不是 DB 列
--
-- §46 要求证据可回溯到原文。把场景文本写成文件
-- （`scenes/cNNN_sM.md`）比塞进 DB 更适合人工核对 ——
-- 可以直接打开看，也能被 diff 工具比较。
-- DB 只存 `text_path`。

ALTER TABLE corpus_scenes ADD COLUMN annotated INTEGER NOT NULL DEFAULT 0;

-- 场景功能（冗余自 annotation_json，用于聚合与索引）
ALTER TABLE corpus_scenes ADD COLUMN scene_function TEXT;

-- 机械指标（代码算，独立于语义标注）
ALTER TABLE corpus_scenes ADD COLUMN pacing_json TEXT;
ALTER TABLE corpus_scenes ADD COLUMN prose_json TEXT;

-- 切分依据（§18 六项）
ALTER TABLE corpus_scenes ADD COLUMN boundary_reason TEXT;
-- 切分证据文本（便于人工核对边界是否合理）
ALTER TABLE corpus_scenes ADD COLUMN boundary_evidence TEXT;
-- 边界是否不确定（已切，但依据不硬）
ALTER TABLE corpus_scenes ADD COLUMN boundary_uncertain INTEGER NOT NULL DEFAULT 0;

-- ⚠ 超长且无切分依据（**没切**，找不到依据）—— §18 LLM 切分的入口。
--   与 boundary_uncertain 语义不同：前者"切了但依据软"，这个"没切"。
ALTER TABLE corpus_scenes ADD COLUMN oversized INTEGER NOT NULL DEFAULT 0;

-- 基础统计
ALTER TABLE corpus_scenes ADD COLUMN chars INTEGER NOT NULL DEFAULT 0;
ALTER TABLE corpus_scenes ADD COLUMN paragraph_count INTEGER NOT NULL DEFAULT 0;

-- 标注失败原因（annotated=0 时有值，便于诊断）
ALTER TABLE corpus_scenes ADD COLUMN annotation_error TEXT;

-- ── 索引（STEP 16 的聚合查询路径） ──

-- ⚠ 只索引已标注场景：模式挖掘只该看有语义标注的场景，
--   把未标注的排除在查询之外（而不是在应用层 filter）
CREATE INDEX idx_corpus_scenes_annotated
  ON corpus_scenes(document_id, annotated, scene_function);

-- 按类型 + 场景功能聚合（跨作品对比的主查询）
CREATE INDEX idx_corpus_scenes_genre_function
  ON corpus_scenes(genre, scene_function, annotated);

-- 按切分依据统计
CREATE INDEX idx_corpus_scenes_boundary
  ON corpus_scenes(boundary_reason);
