-- 0006_summary_approval.sql
--
-- 摘要人工确认关口（ADR-0006 约束 C，补缺口）
--
-- ## 为什么必须有这道关口
--
-- ADR-0006 引 webnovel-writer 的实战记录：
--
--   > 摘要是长程记忆的源头，错一条污染后面几百章
--
-- 因此 v1.0 的摘要投影**不得**全自动生成后立即成为后续章节的记忆源头：
--
--   Commit 后生成摘要 → UI 展示在验收卡 → 作者可修改 → 确认后才进 FTS 与 Context
--
-- ## 设计选择：用状态列而不是"默认不索引"
--
-- 若默认不索引、作者不确认就永远不索引，会导致"忘了确认 = 记忆永久缺失"。
-- 更糟的是没人知道缺了。因此：
--   - 摘要写入时 approved=0（待确认）
--   - **FTS 不索引未确认摘要**（保证记忆源头不被污染）
--   - 但 UI 明确列出"待确认的摘要"，可读可数，不会静默丢失
--
-- 即：宁可记忆缺失且可见，也不要记忆污染且不可见。

ALTER TABLE chapters ADD COLUMN summary_approved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chapters ADD COLUMN summary_approved_at TEXT;

-- 便于 UI 快速列出"待确认"的章节
CREATE INDEX idx_chapters_summary_pending
  ON chapters(book_id, summary_approved)
  WHERE summary IS NOT NULL;
