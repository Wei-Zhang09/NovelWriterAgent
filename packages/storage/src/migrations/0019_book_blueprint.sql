-- ═══════════════════════════════════════════════════════════════════
-- 开书向导（前置设定流程）：blueprint_steps + book_blueprints
-- 依据：用户 2026-09-25 诉求「配置 AI 生成大纲角色等等相关功能，再由用户
--       进行选择、修改，最后确认一切前置信息后，再开始写作」
--       用户决策：「每步生成后都落入数据库草稿（step 状态：未开始/已生成/
--       已编辑/已确认），随时可关软件再回来继续」「允许跳过，不强制」
-- ═══════════════════════════════════════════════════════════════════
--
-- ## 为什么要这两张表
--
-- 参考项目 oh-story-claudecode 的开书流程是 Phase 1→2→3：
--   Phase 1 选题方向 → Phase 2 核心设定 → Phase 3 卷纲 + 逐章细纲，
--   **默认停在细纲交付，不自动写正文**。
--
-- 我们此前只有「作者手填设定 + 确认门禁」（settings-gate 已实现），
-- 缺「AI 生成草案」与「大纲」这个产物本身 —— 全仓 grep `大纲`/`outline`
-- 只命中两处注释。本迁移补上数据层。
--
-- ## 为什么按步拆行（blueprint_steps）而不是一个大 JSON
--
-- 用户明确要求**每步独立状态**（未开始/已生成/已编辑/已确认），
-- 且**随时可关软件再回来继续**。拆行之后：
--   - 某一步重新生成不影响其它步的确认状态
--   - 界面可以按步显示进度
--   - 关软件后恢复只需读这几行
-- 存成一个大 JSON 的话，「哪几步做完了」就变成要靠解析 JSON 结构判断，
-- 新增一步就得改解析逻辑。
--
-- ## draft_json 与 edited_json 分开存（关键设计）
--
-- AI 原始产出与用户改过的版本**必须能分别取出**：
--   1. 用户要求「选择、修改」—— 得先看到 AI 原稿才能选；
--      若只存一份，用户点「重新生成」就永久丢失自己改过的内容。
--   2. 「这一步是 AI 生成的还是我改过的」是可审计的事实，
--      不该靠比对推断。
-- 有效内容 = `edited_json ?? draft_json`（用户改过就用改过的）。
--
-- ## ⚠ SETTINGS 步的有效内容不在这张表里
--
-- 角色与世界设定的**权威副本**是 `characters` / `world_entities` 两张表 ——
-- 那才是 prompt 真正读到的东西。若把它们的副本也塞进 draft_json 并参与
-- 门禁哈希，就会出现「门禁放行、prompt 读到的却是别的内容」这种
-- 假绿（哈希的对象不是被消费的对象）。
--
-- 所以 SETTINGS 步在 `blueprint_steps` 里只记录**流程状态**；
-- 它的有效内容由仓储在读时从 `characters` + `world_entities` 现取。
-- `draft_json` 对它而言只是"AI 提议的暂存区"，确认时物化进正式表。
--
-- ## book_blueprints 只存"统一确认"的指纹
--
-- 与 settings-gate 同一设计（`books.settings_confirmed_hash`）：
-- 存**内容指纹**而不是布尔量，这样"确认后又改了"能被读时判定，
-- 不需要每个写入口都记得清标记 —— 那是"靠调用方守规矩"，新增入口就漏。
--
-- 统一确认（用户说的「最后确认一切前置信息」）= 记录当前四步内容的指纹。
-- 之后任何一步内容变化 → 指纹对不上 → 门禁拦。零调用方配合。
--
-- ## 索引
--
-- 只加 UNIQUE(book_id, step)：唯一的查询形态是"取某本书的全部步"，
-- 该唯一索引即可覆盖，另加普通索引只有写放大（同 0013/0014/0016/0018 判断）。
-- ═══════════════════════════════════════════════════════════════════

-- ── 开书向导：每步一行 ──────────────────────────────────────────────
CREATE TABLE blueprint_steps (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  -- CONCEPT（选题方向）/ SETTINGS（核心设定+角色）/ OUTLINE（卷纲）/ DETAIL（逐章细纲）
  step TEXT NOT NULL,
  -- NOT_STARTED / GENERATED / EDITED / CONFIRMED
  status TEXT NOT NULL,
  -- AI 原始产出（保留原稿，「重新生成」时用户仍能对照）
  draft_json TEXT,
  -- 用户编辑后的版本；NULL = 用户没改过，用 draft
  edited_json TEXT,
  generated_at TEXT,
  edited_at TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, step)
);

-- ── 开书向导：每本书一行（统一确认的指纹） ──────────────────────────
CREATE TABLE book_blueprints (
  book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  -- 统一确认时记录的四步内容指纹；NULL = 从未统一确认
  confirmed_hash TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
