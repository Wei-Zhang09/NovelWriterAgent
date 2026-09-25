-- ═══════════════════════════════════════════════════════════════════
-- M6：正文版本节点（第二阶段施工单 §十三 / §十四）
-- 依据：施工单 §13 §14；ADR-0008 §6（粒度）§7（AI 修订不得覆盖）
-- ═══════════════════════════════════════════════════════════════════
--
-- ## 为什么需要这张表
--
-- §14 要求可追踪的变化链：
--
--     AI Draft → AI Revision → User Edit → User Edit
--              → AI Revision → User Final Edit → Commit
--
-- 没有版本节点，这条链只能靠"最后一次保存的内容"回答，
-- 于是「作者改坏了想退回上一版」「Agent 改稿后想对比」都做不到 ——
-- 而 §15 明确 AI 修订**不得自动覆盖**用户正文，
-- 那条保护的前提正是"旧版本还在"。
--
-- ## 粒度（ADR-0008 §6，可测判据）
--
-- 只在三种情况建节点：
--   1. AI_DRAFT     —— Writer 出稿
--   2. AI_REVISION  —— Agent 修订产出
--   3. USER_EDIT    —— 手动保存**且内容 hash 与上一版本不同**
--   4. RESTORED_AUTOSAVE —— 用户显式恢复自动保存副本
--
-- ⚠ **自动保存不建版本**。否则作者敲一段字会产生几十个节点，
--   与 §41「不要复杂版本树 UI」直接冲突，而且真正的节点会被淹没 ——
--   「版本太多」和「没有版本」在可用性上是同一个结果。
--
-- ## ⚠ 为什么版本内容另存文件（content_path）而不是入库
--
-- 章节正文是几千字的文本，一章节几十个版本就是几十份副本。
-- 放进 SQLite 会让 DB 文件随写作线性膨胀，而备份/导出（§58 §59）
-- 搬的是 DB —— 一次备份要拷走全部历史正文。
--
-- 放文件则与既有工作区布局一致（§三十三 的 `versions/` 建议），
-- 且"版本"天然是可丢弃的（§十四 明确不做 Git 级能力）。
--
-- ## 为什么不存 parent_version_id 形成树
--
-- §41 明确排除复杂版本树 UI，§14 明确"不需要一开始做成 Git"。
-- 线性链（按 created_at 排序）足够表达"上一版是哪一版"，
-- 而 parent 指针一旦存在，就会有人开始画树 —— 那正是被排除的方向。
-- 需要时可按 `ORDER BY created_at DESC LIMIT 2` 取相邻两版。
--
-- ## content_hash 的作用
--
-- 判「这次保存要不要建节点」：hash 与最新版本相同则**不建**。
-- 否则作者反复按 Ctrl+S（内容没变）会堆出一串内容完全相同的节点，
-- 让"版本历史"变成噪声。
--
-- ⚠ 不加索引：查询路径是 `WHERE chapter_id = ? ORDER BY seq`，
--   由 idx_manuscript_versions_chapter 覆盖。
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE manuscript_versions (
  id TEXT PRIMARY KEY,
  -- 章节 id（chapters.id）。⚠ 与 manuscripts 不同，这里是**章级**，
  -- 因为版本属于"某一章正文"，章节被删则版本无意义。
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  -- 该章在书内的章号（冗余存储：工作区路径按章号拼接，
  -- 少了它每次读版本文件都要回查 chapters 表）
  chapter_number INTEGER NOT NULL,
  -- 单调递增序号（同章内从 1 起）。用序号而非时间排序：
  -- 同一毫秒内连续保存两次时，ISO 时间戳无法区分先后。
  seq INTEGER NOT NULL,

  -- AI_DRAFT / AI_REVISION / USER_EDIT / RESTORED_AUTOSAVE
  source_type TEXT NOT NULL,

  -- 版本内容文件相对**项目根**的路径（如 workspace/chapter-001/versions/v001.md）
  content_path TEXT NOT NULL,
  -- 内容 sha256（判重与锚点比对）
  content_hash TEXT NOT NULL,
  -- 该版本的字数（列表展示用，避免为显示字数逐个读文件）
  char_count INTEGER NOT NULL,
  -- 可选说明（如 AI 修订应用的替换条数），供 UI 展示
  note TEXT,

  created_at TEXT NOT NULL
);

CREATE INDEX idx_manuscript_versions_chapter
  ON manuscript_versions(chapter_id, seq);

-- 同一章内 seq 不得重复 —— 这是排序与"相邻两版"取值的正确性前提。
-- 并发写入（两个 IPC 同时保存）时若靠应用层算 max(seq)+1 会有竞态，
-- 这个约束让竞态表现为**写入失败**而不是**序号重复**：
-- 前者可重试，后者会让版本顺序静默错乱。
CREATE UNIQUE INDEX idx_manuscript_versions_seq
  ON manuscript_versions(chapter_id, seq);
