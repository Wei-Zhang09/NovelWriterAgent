-- 0007_genre_isolation.sql
--
-- 语料/技能的类型隔离（用户要求）
--
-- ## 需求原话
--
--   > 要做好区分，在写对应类型小说时，才使用对应的内容。
--
-- 即：写玄幻时不能用都市言情的技能；写都市时不能用修仙的模式。
-- 这不是"建议"，而必须由代码强制 —— 否则跨类型注入会让
-- Writer 拿到与当前题材不匹配的写法（例如把修仙的"渡劫"节奏
-- 用在校园恋爱文里）。
--
-- ## 现状缺口
--
-- 已核对 0001_init.sql：
--   - corpus_documents.genre    ✅ 已有
--   - distillation_patterns.genre ✅ 已有
--   - **distilled_skills.genre   ❌ 缺失**
--   - corpus_scenes.genre        ❌ 缺失
--
-- 技能是**最终被 Writer 使用**的东西，它没有 genre 就无法做
-- 类型过滤 —— 这是最关键的缺口。
--
-- ## 为什么 scenes 也要 genre
--
-- 场景标注结果用于模式挖掘。若不按类型分组统计，
-- "玄幻 + 都市"混在一起算出的 trigger 频率是**伪相关**：
-- 某个 trigger 在玄幻里高频、在都市里罕见，混算后会得到一个
-- 看似"通用"的中频值，实际两边都不适用。
--
-- ## 为什么 skill 还要 scope
--
-- 除类型外还有**跨类型通用**的手法（如"用行为代替情绪直述"）。
-- 因此不能简单按 genre 等值过滤，需要三档：
--   UNIVERSAL  跨类型通用（任何题材都适用）
--   GENRE      类型专属（只在同 genre 下适用）
--   STYLE      作者风格（默认不跨作者使用，§21 要求）
--
-- 这与施工文档 §21 的分层一致：
--   Universal-ish / Genre-specific / Subgenre-specific / Style-specific

-- ── distilled_skills：加类型与作用域 ──
ALTER TABLE distilled_skills ADD COLUMN genre TEXT;
ALTER TABLE distilled_skills ADD COLUMN scope TEXT NOT NULL DEFAULT 'GENRE'
  CHECK (scope IN ('UNIVERSAL', 'GENRE', 'STYLE'));
-- 来源作品（STYLE 作用域需要，便于"不跨作者使用"）
ALTER TABLE distilled_skills ADD COLUMN source_document_ids_json TEXT;

-- 按类型检索技能（STEP 18 注入时的主查询路径）
CREATE INDEX idx_skills_genre_scope
  ON distilled_skills(genre, scope, status, confidence DESC);

-- ── corpus_scenes：加类型，避免跨类型混算统计 ──
ALTER TABLE corpus_scenes ADD COLUMN genre TEXT;

CREATE INDEX idx_corpus_scenes_genre
  ON corpus_scenes(genre, scene_type);

-- ── distillation_patterns：补作用域 ──
-- genre 列 0001 已有；这里补 scope 以便与 skills 对齐
ALTER TABLE distillation_patterns ADD COLUMN scope TEXT NOT NULL DEFAULT 'GENRE'
  CHECK (scope IN ('UNIVERSAL', 'GENRE', 'STYLE'));

CREATE INDEX idx_patterns_genre_scope
  ON distillation_patterns(genre, scope, confidence DESC);

-- ── corpus_documents：补作用域与主题标签 ──
-- 一部作品可能跨子类型（如"玄幻+修仙"），因此除主 genre 外
-- 保留可检索的标签，供 STEP 16 做 subgenre 分层
ALTER TABLE corpus_documents ADD COLUMN subgenre TEXT;
ALTER TABLE corpus_documents ADD COLUMN synopsis TEXT;

CREATE INDEX idx_corpus_documents_genre
  ON corpus_documents(genre, subgenre);
