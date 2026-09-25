-- ═══════════════════════════════════════════════════════════════════
-- 开书向导 Phase 3：卷级大纲（volumes）
-- 依据：用户 2026-09-25 诉求「配置 AI 生成大纲角色等等相关功能，
--       再由用户进行选择、修改，最后确认一切前置信息后，再开始写作」
--       参考项目 oh-story-claudecode 的 Phase 3「卷级大纲（全书结构）」
-- ═══════════════════════════════════════════════════════════════════
--
-- ## 为什么是独立的表，而不是塞进 blueprint_steps.draft_json
--
-- W1 把「每步一行」作为开书向导的存储原则。卷为什么还要单独建表？
--
-- 判据是「**谁消费它**」：
--   blueprint_steps 是**流程状态**（哪一步做完了），消费方是向导界面本身。
--   而卷是**创作产物**，有三个别的消费方：
--     ① 细纲（W5）：每一章的细纲要落在某一卷的章节范围内
--     ② Planner（chapter.plan）：需要知道"这一章属于哪一卷、这一卷的功能是什么"
--     ③ 界面：作者要按卷浏览、逐卷修改
--
-- 存成一个 JSON blob 的后果：**改第 3 卷要读-改-写整个 blob**。
-- 而作者要求「用户选择、修改」—— 逐卷编辑是最常见的编辑动作。
-- 拆成行之后是定点更新，且 ① ② 可以用一条 SQL 查到。
--
-- ## 为什么卷与卷之间不能"合并"，只能整体替换
--
-- 角色表可以逐条合并（W3 的 keep_existing / use_new / keep_both）——
-- 每个角色是独立的。
--
-- ⚠ 卷**不是**：`chapter_start` / `chapter_end` 必须**首尾相接、从 1 开始、
--   互不重叠**。这是全局不变量，逐卷合并会让它失去意义
--   （保留旧的第 2 卷 + 用新的第 3 卷 → 章号范围可能断开或重叠）。
--
--   所以物化卷时必须**整体替换**，且因为替换会丢掉作者逐卷的修改，
--   物化接口要求显式声明 `replaceExisting`，不静默覆盖。
--
-- ## 为什么存 chapter_start / chapter_end 而不是只存章数
--
-- 章号是**绝对坐标**：细纲（W5）按章号索引，Planner 按章号查"我在哪一卷"。
-- 只存章数的话，每次查询都要从头累加前几卷 —— 而累加逻辑一旦有一处写错
-- （漏加一卷、off-by-one），就会出现"第 40 章被算进第 2 卷"这类静默错误。
-- 存绝对坐标则查询是常数级且不可能算错。
--
-- ## 关于 word_target
--
-- 可空。全书字数目标已由 `books.target_words_per_chapter`（0013）承担，
-- 卷级目标只是可选的分卷预算。不强求模型填 —— 逼它给每卷编一个数字
-- 会产出"看起来精确"的假数据（见 llm-generation-pipelines 规则 17：
-- 可计算字段不进模型契约；这里同理，填不出来就不填）。
--
-- ## 索引
--
-- 只加 UNIQUE(book_id, ord)：唯一的查询形态是"取某本书的全部卷"，
-- 该唯一索引即可覆盖。⚠ 不额外给 chapter_start 建索引 ——
-- 卷的数量是"个位数到十几"，全表扫描本来就是常数级，
-- 加索引只有写放大（同 0013/0014/0016/0018/0019 的判断）。
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE volumes (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  -- 卷序（从 1 起）。用 ord 而不是 volume_number，与 world_entities.ord 一致
  ord INTEGER NOT NULL,
  name TEXT NOT NULL,
  -- 功能：这一卷在全书里干什么（铺垫/起步/第一个大爽点…）
  function TEXT NOT NULL,
  -- 所属阶段：OPENING / RISING / CLIMAX / RESOLUTION
  -- 用英文码而不是中文，与 WORLD_TYPES 等既有枚举一致；
  -- 中文标签由渲染层映射（避免 JSON 里混入中文枚举值导致的比对问题）
  stage TEXT NOT NULL,
  -- 卷契约：本卷承诺给读者的快感/高光。可空 ——
  -- 单卷短篇里它与全书卖点重复，强制填会产出废话
  contract TEXT,
  -- 核心事件（一句话）
  core_event TEXT NOT NULL,
  -- 起始状态 → 结束状态（主角从 A 变成 B）
  start_state TEXT,
  end_state TEXT,
  -- 章节范围（绝对坐标，从 1 起，卷间首尾相接不重叠）
  chapter_start INTEGER NOT NULL,
  chapter_end INTEGER NOT NULL,
  -- 可选的分卷字数预算
  word_target INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, ord),
  -- ⚠ 范围合法性由 DB 兜底：物化层已有校验，但库层拒绝明显非法的行
  --   （chapter_end < chapter_start 是纯粹的输入错误，不是"未设定"）
  CHECK (chapter_start >= 1),
  CHECK (chapter_end >= chapter_start)
);
