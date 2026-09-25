/**
 * 开书向导的模型输出契约（Phase 1：选题方向）
 *
 * ## 用户诉求（2026-09-25 原话）
 *
 * > 「应该配置 ai 生成大纲角色等等相关功能，再由用户进行选择、修改，
 * >    最后确认一切前置信息后，再开始写作呀」
 *
 * ## 参考项目 oh-story-claudecode 的 Phase 1（`workflow-setup.md`）
 *
 * 它先问作者三个问题：
 *   「你想让读者什么感觉？有没有喜欢的书想对标？
 *     你的优势是什么（脑洞好/文笔好/节奏感好/生活经验丰富）？」
 *
 * 然后按优势映射题材：
 *   脑洞好 → 系统文/诸天流/无限流
 *   文笔好 → 仙侠/历史/文艺向都市
 *   节奏感好 → 都市爽文/重生文/游戏文
 *   生活经验丰富 → 行业文/都市日常/种田文
 *
 * ## ⚠ 与本项目已有约束的一致性（重要）
 *
 * 本项目的 `AGENT_PLANNER` 提示词里有一条实测踩出来的铁律：
 *   「字段值必须是**具体的创作决定**，不得写「待确认」「TODO」这类占位文本。
 *     若上下文没有给出角色名/地点名，**由你决定**一个合理的名字并直接使用」
 *
 * 选题方向同理 —— **不得输出"待定"**。模型必须给出可判断的具体方案，
 * 作者才能"选择"。一堆占位符没有可选择性，等于没生成。
 *
 * ## ⚠ 为什么输出**多个候选**而不是一个方案
 *
 * 用户明确要求「再由用户进行**选择**、修改」。只给一个方案的话
 * "选择"这个动作不存在，作者只能"接受或重来"，那是二选一不是选择。
 *
 * ⚠ 但候选数**有上限且刻意偏小**（3 个）：
 *   候选一多，每个的质量都会下降，且作者的比较成本上升 ——
 *   3 个是"有得挑"与"挑得动"的平衡点。
 *
 * ## ⚠ 可计算字段不进模型契约
 *
 * 与 `annotation.ts` 同一条原则：`estimatedChapters` 这类**能从别处算出来**
 * 的值不让模型估。模型估的数不可复现（随提示词与采样变化），
 * 而一个"看起来合理"的估计值与真实测量值在下游无法区分。
 * 这里保留它的唯一理由是：**它是创作决定**（这本书打算写多长），
 * 不是从文本推导出来的量。所以它是必填的**意图**，不是"估计值"。
 */
import { z } from 'zod';

/**
 * 单条选题候选。
 *
 * ⚠ 字段的取舍标准：**每个字段都必须是作者能据以做决定的**。
 *   放一个模型自己也说不清的字段（如"创新度 0.73"）只会制造噪音 ——
 *   数字看起来客观，实际不可复现，还会挤占作者的注意力。
 */
export const ConceptCandidateSchema = z.object({
  /** 一句话卖点：作者扫一眼就知道这本书讲什么 */
  pitch: z.string().min(5, '一句话卖点不得为空').max(300),
  /** 题材（会被 normalizeGenre 归一化，如"都市校园"→"都市"） */
  genre: z.string().min(1).max(50),
  /** 想让读者产生的核心情绪（对标 oh-story 的"你想让读者什么感觉"） */
  coreEmotion: z.string().min(2).max(100),
  /**
   * 主角设定摘要。
   *
   * ⚠ 为什么是字符串而不是结构化的角色对象：
   *   这一步产出的是**方向**，角色卡是 Phase 2 的事。
   *   在方向阶段就要求完整角色结构，会让模型把精力放在填字段上，
   *   而不是把方向想清楚。
   */
  protagonist: z.string().min(2).max(300),
  /** 核心冲突：这本书的主要张力来自什么 */
  coreConflict: z.string().min(5).max(400),
  /** 差异化：凭什么与同类书不同（对标 oh-story 的"差异化"） */
  differentiation: z.string().min(5).max(400),
  /** 打算写多少章（创作意图，不是估计值） */
  estimatedChapters: z.number().int().min(10).max(5000),
});

export type ConceptCandidate = z.infer<typeof ConceptCandidateSchema>;

/**
 * Phase 1 的完整输出：若干候选。
 *
 * ⚠ 下限 2、上限 3：
 *   下限 2 保证"选择"这个动作有意义；
 *   上限 3 保证每个候选的质量（候选越多，单个越敷衍）。
 *   zod 的 min/max 会拒绝不合规的输出，而不是默默接受 ——
 *   这是"宿主绝不抠 JSON、也不容错到失真"原则的延续。
 */
export const ConceptOutputSchema = z.object({
  candidates: z.array(ConceptCandidateSchema).min(2).max(3),
});

export type ConceptOutput = z.infer<typeof ConceptOutputSchema>;

/**
 * 用户确认/编辑后的选题（进入 Phase 2 的输入）。
 *
 * ⚠ 与候选的区别：候选是**备选方案**，这个是**定下来的那一个**。
 *   分开两个 schema 而不是复用，是因为它们的必填项不同 ——
 *   定稿必须明确"为什么选它"，而候选不需要解释自己为什么存在。
 */
export const BlueprintConceptSchema = ConceptCandidateSchema.extend({
  /** 作者选择它的理由（可空：作者可能只是觉得顺眼） */
  selectedReason: z.string().max(500).nullable(),
});

export type BlueprintConcept = z.infer<typeof BlueprintConceptSchema>;

/**
 * 给模型看的 JSON 形状提示。
 *
 * ⚠ 与 `PLAN_SHAPE_HINT` 同一条设计：形状提示是**契约的一部分**，
 *   放在 schema 旁边而不是散在提示词里 —— 否则改了 schema 忘了改提示词，
 *   模型就会按旧形状输出，然后被 schema 拒绝。
 */
export const CONCEPT_SHAPE_HINT = `{
  "candidates": [
    {
      "pitch": "一句话卖点，如：退役拳手回到小城开拳馆，却发现徒弟在打地下黑拳",
      "genre": "都市",
      "coreEmotion": "意难平",
      "protagonist": "主角是谁、他有什么旧伤或执念",
      "coreConflict": "核心冲突是什么，张力从哪来",
      "differentiation": "与同类书的差异在哪",
      "estimatedChapters": 200
    }
  ]
}`;

/**
 * 校验选题的**业务约束**（超出 zod 能表达的范围）。
 *
 * 返回问题列表（空数组表示通过）。设计成返回列表而不是抛错，
 * 与 `validatePlanSemantics` 一致 —— 调用方可以据此做一次自我修复重试。
 */
export function validateConceptSemantics(output: ConceptOutput): string[] {
  const issues: string[] = [];

  // 1. 占位符检测 —— 与 AGENT_PLANNER 的同一条实测教训
  const PLACEHOLDERS = ['待确认', '待定', 'TODO', 'todo', '例如…', '（此处填写）', 'xxx'];
  for (const [i, c] of output.candidates.entries()) {
    for (const [field, value] of Object.entries(c)) {
      if (typeof value !== 'string') continue;
      for (const p of PLACEHOLDERS) {
        if (value.includes(p)) {
          issues.push(`candidates[${i}].${field} 含占位文本「${p}」—— 必须给出具体决定`);
        }
      }
    }
  }

  // 2. 候选之间必须真的不同。
  //
  // ⚠ 这不是形式要求：模型在"给多个候选"的任务上容易给出
  //   **同一个方向的三种说法**（换了措辞但卖点相同）。
  //   那样作者没有可选择性，而界面看起来"生成了 3 个候选"——
  //   比只给 1 个更糟，因为它假装给了选择。
  const pitches = output.candidates.map((c) => c.pitch.trim());
  const uniquePitches = new Set(pitches);
  if (uniquePitches.size !== pitches.length) {
    issues.push('候选之间存在完全相同的 pitch —— 请给出真正不同的方向');
  }

  // 3. 题材不得全部相同：三个候选都是同一题材，等于没得选
  const genres = new Set(output.candidates.map((c) => c.genre.trim()));
  if (genres.size === 1 && output.candidates.length > 1) {
    issues.push(
      `全部候选都是「${[...genres][0]}」题材 —— 作者无从选择，请给出不同题材方向`,
    );
  }

  return issues;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 2：核心设定与角色
// ═══════════════════════════════════════════════════════════════════

/**
 * ⚠⚠ 本阶段最重要的一条设计：**产出必须落在两张已有的正式表上**
 *
 * 角色 → `characters`，世界观 → `world_entities`。
 *
 * 理由是 W1 已经吃过一次亏的教训：**哈希/门禁的对象必须是被消费的对象**。
 * 那两张表是 `renderCharacterBlock` / `renderWorldBlock` 唯一读取的来源，
 * 也就是 prompt 真正看到的东西。若本阶段把梗概、世界观骨架另存一份
 * （比如塞进 blueprint 的 draft_json），就会出现
 * **门禁说"已确认"、prompt 却读不到** —— 作者以为 Agent 按设定写了，其实没有。
 *
 * 所以：`characters` / `world_entities` 是**权威副本**，
 * blueprint 的 draft_json 只是"AI 提议的暂存区"。
 *
 * 世界观骨架怎么拆？`WORLD_TYPES` 是闭集（WORLD_RULE / LOCATION /
 * FACTION / ITEM / CONCEPT / CUSTOM），没有"世界观总述"这一格。
 * 所以骨架拆成多条实体：
 *   - 时代背景/核心设定 → `CONCEPT`
 *   - 力量体系         → `WORLD_RULE`（它确实是"世界怎么运转"的规矩）
 *   - 社会结构         → `FACTION` 或 `CONCEPT`（由模型判断）
 * 这比新增一个类型好：新增类型会让 `WORLD_TYPES` 的闭集失去意义，
 * 而"骨架"本质就是若干条设定，本来就不该是一个整体。
 */

/** 单条角色提议（物化进 `characters` 表） */
export const CharacterProposalSchema = z.object({
  name: z.string().min(1, '角色名不得为空').max(100),
  /** 别名（逗号分隔的自由文本 → 数组） */
  aliases: z.array(z.string().min(1)).max(10).default([]),
  /** 定位：主角 / 配角 / 反派 / 导师 … */
  role: z.string().max(100).nullable().default(null),
  /**
   * 档案：外貌、性格、背景、旧伤等。
   *
   * ⚠ 用**对象**而不是字符串数组：`renderProfile` 对对象会渲染成
   *   `键：值；键：值`，比裸数组可读得多，且作者在界面上能按字段改。
   *   键用中文（与界面表单的字段名一致），值必须是具体内容。
   */
  profile: z.record(z.string().max(50), z.string().max(500)).default({}),
});

export type CharacterProposal = z.infer<typeof CharacterProposalSchema>;

/** 单条世界观提议（物化进 `world_entities` 表） */
export const WorldProposalSchema = z.object({
  /** 必须落在 WORLD_TYPES 闭集内（见 harness/tools/world-tools.ts） */
  type: z.enum(['WORLD_RULE', 'LOCATION', 'FACTION', 'ITEM', 'CONCEPT', 'CUSTOM']),
  name: z.string().min(1, '设定名称不得为空').max(100),
  description: z.string().min(1, '设定内容不得为空').max(1000),
});

export type WorldProposal = z.infer<typeof WorldProposalSchema>;

/**
 * Phase 2 完整输出。
 *
 * ⚠ 数量上限是**刻意的**，不是随便定的：
 *   - 角色 ≤ 8：长篇角色可以上百，但**核心设定阶段**只需要立得住的那几个。
 *     一次生成 30 个角色，作者既读不完也改不动，"逐条选择"会变成负担。
 *     其余角色在写作过程中按需增补。
 *   - 世界观 ≤ 12：同理。骨架是"不知道就会写错"的那几条，
 *     不是设定百科。
 *
 * ⚠ 下限刻意很松（角色 ≥1、世界观 ≥0）：
 *   有的题材（都市日常）确实不需要世界观条目，强行要求会逼模型编。
 *   而"没有设定 → 放行"本来就是本项目 settings-gate 的既定语义。
 */
export const SettingsOutputSchema = z.object({
  /** 一句话梗概：主角 + 目标 + 阻碍 + 反转 */
  logline: z.string().min(5, '一句话梗概不得为空').max(400),
  /** 主线矛盾 */
  coreConflict: z.string().min(5, '主线矛盾不得为空').max(600),
  characters: z.array(CharacterProposalSchema).min(1).max(8),
  worldEntities: z.array(WorldProposalSchema).max(12).default([]),
});

export type SettingsOutput = z.infer<typeof SettingsOutputSchema>;

/** 给模型看的形状提示 */
export const SETTINGS_SHAPE_HINT = `{
  "logline": "主角 + 目标 + 阻碍 + 反转，一句话概括全书",
  "coreConflict": "主线矛盾是什么，张力从哪来",
  "characters": [
    {
      "name": "沈砚",
      "aliases": ["老沈"],
      "role": "主角",
      "profile": {
        "年龄": "三十六岁",
        "外貌": "左手有旧伤，冬天会抖",
        "性格": "话少，认死理",
        "背景": "曾是省队拳手，因伤退役",
        "动机": "想证明那场比赛不是他的错"
      }
    }
  ],
  "worldEntities": [
    {
      "type": "WORLD_RULE",
      "name": "记忆代价",
      "description": "每使用一次能力，就永久失去一段与使用对象相关的记忆"
    }
  ]
}`;

/**
 * 校验核心设定的**业务约束**。
 *
 * 与 `validateConceptSemantics` 同形状（返回问题列表，不抛错），
 * 便于生成器做一次自我修复重试。
 */
export function validateSettingsSemantics(output: SettingsOutput): string[] {
  const issues: string[] = [];

  // 1. 占位符检测（本项目 Planner 的实测教训）
  const PLACEHOLDERS = ['待确认', '待定', 'TODO', 'todo', '例如…', '（此处填写）'];
  const scan = (path: string, v: unknown): void => {
    if (typeof v === 'string') {
      for (const p of PLACEHOLDERS) {
        if (v.includes(p)) issues.push(`${path} 含占位文本「${p}」—— 必须给出具体内容`);
      }
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => scan(`${path}[${i}]`, x));
    else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) scan(`${path}.${k}`, val);
    }
  };
  scan('logline', output.logline);
  scan('coreConflict', output.coreConflict);
  output.characters.forEach((c, i) => scan(`characters[${i}]`, c));
  output.worldEntities.forEach((w, i) => scan(`worldEntities[${i}]`, w));

  // 2. 角色名不得重复 —— 重名会在物化时撞 characters 的唯一性/语义，
  //    且作者无法分辨"两个沈砚"是不是同一个人
  const names = output.characters.map((c) => c.name.trim());
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length > 0) {
    issues.push(`角色名重复：${[...new Set(dup)].join('、')} —— 请合并或改名`);
  }

  // 3. 世界观条目名不得重复（同上理由）
  const wnames = output.worldEntities.map((w) => w.name.trim());
  const wdup = wnames.filter((n, i) => wnames.indexOf(n) !== i);
  if (wdup.length > 0) {
    issues.push(`世界观设定名重复：${[...new Set(wdup)].join('、')} —— 请合并或改名`);
  }

  // 4. ⚠ 主角必须存在。
  //
  //    这不是形式要求：没有主角的设定表意味着模型没理解"这是给谁写的故事"，
  //    后续大纲会围绕一群配角展开，作者要到写正文时才发现。
  //    （不强制 role 字段的写法，因为模型可能写"男主""主人公"等变体）
  const hasProtagonist = output.characters.some((c) =>
    /主角|男主|女主|主人公/.test(`${c.role ?? ''} ${c.name}`),
  );
  if (!hasProtagonist) {
    issues.push('角色列表中没有任何一个被标为主角 —— 请明确谁是主角');
  }

  // 5. profile 不得为空对象：一个没有档案的角色等于只有一个名字，
  //    对写作没有帮助（模型只知道"有个叫沈砚的人"）
  output.characters.forEach((c, i) => {
    if (Object.keys(c.profile).length === 0) {
      issues.push(`characters[${i}]（${c.name}）的档案为空 —— 至少给出外貌/性格/背景之一`);
    }
  });

  return issues;
}
