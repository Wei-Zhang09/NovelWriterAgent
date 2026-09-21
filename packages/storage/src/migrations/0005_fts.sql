-- 0005_fts.sql
--
-- FTS5 检索索引（施工文档 §11 / §59，ADR-0004）
--
-- ## 为什么现在才建
--
-- STEP 11 完成时 FTS 表尚不存在，`verify:simulate` 里那一项被诚实标注为
-- "跳过：FTS 表尚未建立"。补缺口时补上。
--
-- ## ADR-0004：为什么不用内置 tokenizer 直接索引中文
--
-- STEP 0 实测：SQLite FTS5 内置 unicode61 把**整段连续中文当单一 token** ——
-- 「张三走了，李四来了」被切成 ["第三章","张三走了","李…"]，
-- 8 个查询词对 13 个文档-词对实测查全率仅 1/13，检索形同不存在。
--
-- 因此索引侧写入**预分词后的文本**（空格分隔），查询侧用同一分词器
-- （见 @nwa/retrieval 的 tokenizer）。
-- 内容列用 `content=''` 的外部内容表模式，避免重复存储原文。
--
-- ## 为什么不进事务（ADR-0002 的索引划分）
--
-- FTS 是 **Derived**（§59：可 rebuild）。全量重建代价高，不适合放进
-- Commit 事务；因此 Commit 只在 manifest 里记 pending 标记，崩溃后补做。
-- 这与会导航的 artifacts/index.json 不同 —— 后者进事务。

-- 章节正文索引（chapter_fts）
CREATE VIRTUAL TABLE chapter_fts USING fts5(
  -- 预分词后的文本（空格分隔）。查询走同一分词器。
  tokens,
  -- 未参与索引的元数据列
  chapter_id UNINDEXED,
  book_id UNINDEXED,
  chapter_number UNINDEXED,
  source_ref UNINDEXED
);

-- 长程记忆索引（memory_fts）：摘要 / 事实 / 伏笔等可检索条目
CREATE VIRTUAL TABLE memory_fts USING fts5(
  tokens,
  item_id UNINDEXED,
  book_id UNINDEXED,
  item_type UNINDEXED,
  source_ref UNINDEXED
);
