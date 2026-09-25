-- ═══════════════════════════════════════════════════════════════════
-- 开书向导 Phase 3：逐章细纲（chapter_outlines）
-- 依据：用户 2026-09-25 诉求「配置 AI 生成大纲角色等等相关功能，
--       再由用户进行选择、修改，最后确认一切前置信息后，再开始写作」
--       参考项目 oh-story-claudecode 的 Phase 3「细纲（第 N 章）」
-- ═══════════════════════════════════════════════════════════════════
--
-- ## ⚠⚠ 为什么按 (book_id, chapter_number) 而不是 chapter_id
--
-- 这是本表最重要的设计决定。
--
-- 开书向导发生在**写作之前** —— 那时 `chapters` 表里**一行都没有**。
-- 作者是先规划完 30 章的细纲，再一章一章地写。
--
-- 所以细纲**不能**用 chapter_id 关联：
--   ① 向导阶段没有 chapter_id 可填
--   ② 若为了填 chapter_id 而预先创建 30 行 DRAFT 章节，会污染章节列表 ——
--      那些章节一行正文都没有，却出现在"章节"导航里，
--      作者分不清"规划过的"与"开始写的"
--
-- 用 chapter_number 关联则两个问题都不存在：
--   细纲独立存在，章节按需创建，两者靠 (book_id, chapter_number) 对齐。
--
-- ## ⚠⚠ 与 chapters.plan_json 的分工（不得混淆）
--
-- 两张表都描述"第 N 章要发生什么"，但**层次不同**：
--
--   chapter_outlines（本表）= **作者确认的意图**
--     开书时定下，全书级，人工确认过。
--     字段：核心事件 / 目标情绪 / 主角目标与关键选择 / 结构公式 /
--           章首钩子 / 五段式概括 / 出场顺序 / 视角信息差
--
--   chapters.plan_json（已有）= **Planner 的执行计划**
--     写每一章时生成，含 scene 切分、视角、强度档位、伏笔动作。
--
-- 关系是**输入与产出**，不是同一件事：
--   细纲是 Planner 的**输入**（注入 contextText 作为"作者已确认的意图"），
--   plan_json 是 Planner 的输出。plan 可以比细纲更细（加 scene），
--   但**不得与细纲矛盾** —— 矛盾的判定由作者在界面比对，本层不做自动合并。
--
-- ⚠ 为什么不做"细纲与 plan 自动同步"：
--   两者粒度不同（细纲是章级意图，plan 是场景级执行），
--   自动同步只能靠猜哪条对应哪条。本项目已有教训：
--   两份表达同一事实的数据必然分叉，且分叉是静默的。
--   这里靠**单向依赖**（细纲 → 注入 → plan）避免分叉，
--   而不是靠双向同步。
--
-- ## 为什么 summary_json 用 JSON 而不是五个列
--
-- 五段式（起因/发展/转折/高潮/结尾）是**一个整体的结构**，
-- 从不单独查询或更新其中一段（作者改的是"这一章的情节概括"，
-- 不是"这一章的转折段"）。拆五列只会让写入变成五个字段的拼装，
-- 且新增段（如 oh-story 后续可能加的"钩子段"）要改表。
--
-- ⚠ 与 volumes 的判断相反，理由是**查询形态不同**：
--   卷的 chapter_start/end 要参与 SQL 范围查询（volumeOfChapter），
--   所以必须成列；五段式从不参与查询，所以成 JSON。
--
-- ## 索引
--
-- UNIQUE(book_id, chapter_number) 是唯一的索引需求：
--   两个查询形态（按章取一条、按书列全部）都由它覆盖。
-- ⚠ 不额外建索引（同 0013/0014/0016/0018/0019/0020 的判断）。
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE chapter_outlines (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  -- ⚠ 章号，不是 chapter_id —— 向导阶段章节尚不存在（见文件头注释）
  chapter_number INTEGER NOT NULL,
  -- 核心事件（一句话；供 Planner 与界面统一消费）
  core_event TEXT NOT NULL,
  -- 目标情绪：具体情绪前状态 → 后状态。不得只写"热血"这类标签
  target_emotion TEXT NOT NULL,
  -- 主角本章要什么 + 必须做出的判断或选择
  protagonist_goal TEXT NOT NULL,
  -- 章节定位：高压 / 推进 / 修炼试错 / 关系回收 / 低压生活 / 信息整理
  positioning TEXT,
  -- 本章结构公式：节点1（目的）+ 节点2（目的）+ …
  structure_formula TEXT,
  -- 章首钩子
  hook TEXT NOT NULL,
  -- 五段式内容概括 {cause, development, turn, climax, ending}
  summary_json TEXT NOT NULL,
  -- 主线推进
  main_plot TEXT,
  -- 出场顺序（角色/势力/关键物件，按实际出现顺序）
  cast_json TEXT,
  -- 视角 / 信息差：谁知道什么、读者知道什么、主角误判什么
  info_gap TEXT,
  -- 本章禁止提前释放（只写本章特有的，不逐章复读卷级禁忌）
  forbidden TEXT,
  -- 字数目标。可空 → 回退到 books.target_words_per_chapter（0013）
  word_target INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, chapter_number),
  -- 章号从 1 起；DB 兜底拒绝明显非法的输入
  CHECK (chapter_number >= 1)
);
