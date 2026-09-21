-- 0003_foreshadow_payoff.sql
--
-- 为 foreshadowing 增加「实际回收章」列。
--
-- 为什么需要新列而不是复用 expected_payoff_chapter：
--   两者语义不同 —— expected 是计划在第几章回收，actual 是实际在第几章回收。
--   施工文档 §14 的伏笔结构里只有 expectedPayoffChapter，但
--   「重复回收」与「超期未回收」两类检查都需要**实际**回收章才能判定：
--     - 超期检查：actual 为空 且 当前章 > expected  → 该收没收
--     - 账目检查：actual 已有值 却再次回收         → 重复回收
--   把 actual 塞进 expected 会让"计划"与"事实"混淆，事后无法区分
--   是排期变了还是账目错了。
--
-- 本迁移是可加的（ADD COLUMN），对既有数据无破坏。

ALTER TABLE foreshadowing ADD COLUMN payoff_chapter INTEGER;
