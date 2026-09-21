-- 0004_chapter_review.sql
--
-- 为 chapters 增加审阅结果列（施工文档 §32 Review 输出协议）。
--
-- 为什么单独一列而不是复用 plan_json：
--   plan 是"打算怎么写"，review 是"写完之后发现的问题"，
--   两者生命周期不同（plan 在 PLANNING 阶段写，review 在 REVIEWING 阶段写），
--   合并会让"重跑审阅"污染计划，或"改计划"抹掉审阅结论。
--
-- 为什么存 JSON 而不是拆成 review_issues 表：
--   审阅结果是**一次运行的完整快照**，用途是展示与驱动 Revision，
--   不参与跨章检索或对账。拆表会引入 join 成本而无查询收益。
--   （若将来需要按类别统计历史趋势，再迁移到表 —— 那时才有真实需求。）
--
-- 另加 overall_status 冗余列：状态机门禁需要在不解析 JSON 的情况下
-- 判断"这一章能否提交"，放在列上便于加索引与约束。

ALTER TABLE chapters ADD COLUMN review_json TEXT;
ALTER TABLE chapters ADD COLUMN review_status TEXT;
