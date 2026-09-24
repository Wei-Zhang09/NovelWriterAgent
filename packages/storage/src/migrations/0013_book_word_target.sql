-- ═══════════════════════════════════════════════════════════════════
-- P2-1：每章字数目标（软约束）
-- 依据：用户决策 2026-09-25 ——「章节字数设定，可以在合理范围之内上下浮动」
--                                 「允许浮动，但偏离超阈值时提示我（不阻断）」
-- ═══════════════════════════════════════════════════════════════════
--
-- 设计要点：
--
-- 1. **软约束，绝不阻断**
--    字数是**结果指标**不是正确性指标。硬卡字数只会让模型为凑数注水，
--    那正是本项目一直在防的事（ADR-0007 Naturalness）。所以这里只存
--    目标值，偏离只产生 WARNING 级提示，永不产生 BLOCKING。
--
-- 2. **存在 books 而不是 projects**
--    §多书隔离：同一个项目下可以有多本书，每本书的篇幅目标天然不同
--    （短篇 vs 长篇）。存在 books 上，天然随 book_id 隔离，
--    不会出现「A 书的目标影响 B 书」的污染。
--
-- 3. **NULL 表示"未设定"，不是 0**
--    NULL → 走 Writer 的默认值（wordsPerScene=1200）。
--    用 0 表示未设定会让"目标 0 字"与"没设过"无法区分，所以
--    CHECK 明确拒绝 0 与负数 —— 它们不是"未设定"，是错误输入。
--
-- 4. **同时存阈值百分比**
--    偏离多少算"超阈值"是可调的（默认 40%）。与目标值一起存，
--    避免阈值散落在代码里无法调整。
--
-- ⚠ 不加索引：books 是"一本书一行"，全表扫描本来就是常数级。
--   加索引只会增加写放大（实测踩到：给一行表加索引是纯负担）。

ALTER TABLE books ADD COLUMN target_words_per_chapter INTEGER
  CHECK (target_words_per_chapter IS NULL OR target_words_per_chapter > 0);

ALTER TABLE books ADD COLUMN word_count_tolerance_pct INTEGER NOT NULL DEFAULT 40
  CHECK (word_count_tolerance_pct >= 0 AND word_count_tolerance_pct <= 200);
