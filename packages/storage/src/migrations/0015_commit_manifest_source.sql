-- ═══════════════════════════════════════════════════════════════════
-- M0：记录提交源（manuscript.md / revision.md / draft.md）
-- 依据：第二阶段施工单 §四 + ADR-0008
-- ═══════════════════════════════════════════════════════════════════
--
-- ## 为什么需要记录"这次提交的是哪份稿"
--
-- 引入 manuscript.md（用户正在编辑的正文）后，提交源从一个变成了三个：
--
--     manuscript.md  ??  revision.md  ??  draft.md
--     （用户改的）        （AI 修订）      （AI 初稿）
--
-- 三者内容可能**完全不同**。此前 manifest 只记 `artifact_manifest_json`
-- 里的产物清单，无法回答"第 31 章那次提交，进正史的到底是用户的手改稿
-- 还是 AI 的修订稿"。
--
-- 这不是纯粹的可观测性问题。施工单 §15 要求"AI Revision 不允许直接覆盖
-- 用户正文"，而**验证这条规则是否被遵守，唯一办法就是看提交记录里
-- 写的是哪份稿**。没有这一列，规则只能靠读代码相信。
--
-- ## 为什么是独立列而不是塞进 JSON
--
-- `artifact_manifest_json` 存的是"写了哪些文件"（路径 + 哈希），
-- 是**产物清单**；source 是"正文取自哪个输入"，是**决策记录**。
-- 混进 JSON 后无法用 SQL 查询"有多少章提交的是 draft 而非 manuscript"——
-- 而这个问题正是排查"用户改了半天没生效"的第一个问题。
--
-- ## 为什么允许 NULL
--
-- 0015 之前的提交记录没有这个信息，且**不可事后推断**
-- （文件可能已被后续操作覆盖）。填一个猜测值比留空更糟：
-- 留空表示"未知"，填值表示"确定是这份"，两者不能混。
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE commit_manifests
  ADD COLUMN source TEXT
  CHECK (source IS NULL OR source IN ('manuscript.md', 'revision.md', 'draft.md'));

-- 排查用：找出"提交的不是用户正文"的章节
-- （manuscript.md 存在却提交了 revision/draft —— 即用户改动可能被丢弃）
CREATE INDEX idx_commit_manifests_source ON commit_manifests(source);
