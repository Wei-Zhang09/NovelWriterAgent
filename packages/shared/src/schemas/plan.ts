/**
 * 规划期 Schema（施工文档 §29 / §30）
 *
 * 这两个 Schema 是 Planner 与 Writer 之间的**结构化契约**：
 *   Planner 产出 ChapterBrief + ScenePlan（经 schema 校验）
 *   Writer 只接受已校验的对象，不接受自由文本
 *
 * ⚠ 为什么必须严格：
 *   研究报告 §1.2 决策 4 指出，自由文本生成再解析「必然」出现解析失败与字段幻觉。
 *   InkOS 的做法是让模型通过**恰好一次**结构化工具调用提交结果，宿主绝不从
 *   assistant 文本里抠 JSON（其 worker-agent.ts:299-303 原注释：
 *   "the host owns the tool result and never scrapes JSON out of assistant text"）。
 *   我们沿用同一原则。
 */
import { z } from 'zod';

/** 伏笔动词（§29 的 plant / reinforce / payoff 三类） */
export const ForeshadowingActionSchema = z.object({
  plant: z.array(z.string()).default([]),
  reinforce: z.array(z.string()).default([]),
  payoff: z.array(z.string()).default([]),
});
export type ForeshadowingAction = z.infer<typeof ForeshadowingActionSchema>;

/**
 * 叙事视角（P1）。
 *
 * ⚠ 这是**谁在看**，与 `mainCharacters`（本章有谁出场）是两件事。
 *   此前 Writer 把两者混为一谈 —— prompt 里写
 *   `人称与视角：${mainCharacters.join('、')} 视角`，
 *   等于让模型同时用三个人的眼睛写，正好与同句的"不要跳视角"矛盾。
 *   **出场角色多 ≠ 视角多。**
 */
export const NarrativePovSchema = z.enum([
  'FIRST_PERSON',      // 第一人称（我）
  'THIRD_LIMITED',     // 第三人称限制视角（跟随一个角色）
  'THIRD_OMNISCIENT',  // 第三人称全知（叙述者无所不知）
]);
export type NarrativePov = z.infer<typeof NarrativePovSchema>;

/**
 * 叙事距离（P1）—— 读者离角色内心有多近。
 *
 * 与视角正交：同样是第三人称限制视角，可以贴着角色写（近）
 * 也可以像旁观记录（远）。它决定"能不能直接写内心活动"。
 */
export const NarrativeDistanceSchema = z.enum([
  'CLOSE',   // 近距离：可写内心、体感
  'MEDIUM',  // 中距离：以言行暗示为主，偶尔内心
  'FAR',     // 远距离：只写可观察到的外部行为
]);
export type NarrativeDistance = z.infer<typeof NarrativeDistanceSchema>;

/**
 * 叙事位置（P1）—— 本场景在整章/整书结构中的位置。
 *
 * ⚠ 与 `sceneFunction`（场景承担什么叙事任务）不同：
 *   同一个 CONFLICT 可以是开篇铺垫也可以是终局对决。
 *   位置决定"读者已知多少"，从而决定能不能解释、要不要留白。
 */
export const NarrativePositionSchema = z.enum([
  'OPENING',     // 开篇（读者还在建立坐标）
  'RISING',      // 上升（信息与压力累积）
  'MIDPOINT',    // 中点（方向转折）
  'CLIMAX',      // 高潮（最大张力处）
  'FALLING',     // 下落（收束压力）
  'RESOLUTION',  // 收尾（回到稳定）
]);
export type NarrativePosition = z.infer<typeof NarrativePositionSchema>;

/**
 * 强度档位（P1）—— 供模型声明"情绪强度/张力有多高"。
 *
 * ⚠⚠ 为什么让模型给**档位**而不是像 `0.72` 这样的数值：
 *
 *   1. 模型给的浮点数**不可复现** —— 同一段文字两次调用会给出 0.72 / 0.68，
 *      而这个数会进入检索阈值比较（`emotionIntensity >= minEmotionIntensity`），
 *      于是"同一条技能这次命中、下次不命中"，问题还查不出来。
 *      这与 P0-4（模型给不出可靠字偏移）、P0-5（模型填不准 storyTimeValue）
 *      是同一类问题：**模型擅长判断，不擅长给数**。
 *   2. 阈值比较根本不需要浮点精度 —— LOW/MEDIUM/HIGH 三档足够区分
 *      "这段是缓冲"与"这段是高潮"。
 *
 *   所以分工是：**模型给判断（档位），代码算数值**（见 `resolveIntensity`）。
 *   数值仍然会出现在 Writer 的 prompt 里（可读性更好），但它由代码算出，
 *   来源可追溯（`IntensitySource`）。
 */
export const IntensityBandSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type IntensityBand = z.infer<typeof IntensityBandSchema>;

/**
 * 档位 → 数值。**唯一权威映射**，不要在两处各写一份。
 *
 * 取 0.2 / 0.55 / 0.9 而不是 0/0.5/1：
 *   - 不用 0 与 1 的端点值，是因为端点会让"模型没说"与"模型说极低"
 *     在比较时表现相同，而这两者的含义完全不同；
 *   - 0.2 与 0.9 也给"比 HIGH 还高"留了空间（未来可能加档位）。
 */
export const BAND_TO_INTENSITY: Readonly<Record<IntensityBand, number>> = {
  LOW: 0.2,
  MEDIUM: 0.55,
  HIGH: 0.9,
};

/** 数值来源 —— 决定这个数能不能信、以及为 null 时是谁的锅 */
export type IntensitySource =
  /** 由 Planner 声明的档位算出 */
  | 'DECLARED_BAND'
  /** 没有档位信息 —— 该维度不参与检索，如实记录而不是填默认值 */
  | 'UNKNOWN';

export interface ResolvedIntensity {
  /** 用于检索/展示的数值；`null` = 该维度不可用（**不是 0**） */
  readonly value: number | null;
  readonly source: IntensitySource;
}

/**
 * 把档位解析成数值。
 *
 * ⚠ 档位缺失时返回 `{ value: null, source: 'UNKNOWN' }` —— **绝不填默认值**。
 *   填一个 0.5 会让"模型没说"伪装成"模型说中等"，
 *   于是检索里的阈值比较照常运行，而它比较的是一个编造的数。
 *   这与 P0-6 的 `stability: 'NOT_RUN'` 是同一条纪律：
 *   **没有测量就如实标未测，不要给一个看起来合理的值。**
 */
export function resolveIntensity(band: IntensityBand | null | undefined): ResolvedIntensity {
  if (!band) return { value: null, source: 'UNKNOWN' };
  return { value: BAND_TO_INTENSITY[band], source: 'DECLARED_BAND' };
}

/**
 * Chapter Brief（施工文档 §29 的 11 个字段）
 */
export const ChapterBriefSchema = z.object({
  chapterNumber: z.number().int().positive(),
  /** 本章目的：为什么需要这一章存在 */
  purpose: z.string().min(1, 'chapter purpose 不得为空'),
  /** 本章开始时的状态（自上而下承接） */
  previousState: z.string().min(1),
  /** 本章结束时应达到的状态（目标状态） */
  targetState: z.string().min(1),

  /**
   * 本章出场的主要角色 —— **不是**视角。
   *
   * ⚠⚠ 这个字段此前被 Writer 当成视角用（prompt 写
   *   `人称与视角：${mainCharacters.join('、')} 视角`），
   *   于是"本章有林晚、陈默、老板"被渲染成"林晚、陈默、老板视角"。
   *
   *   两个后果都是错的：
   *   1. 它同时给出了多个视角，与同一句的"不要跳视角"直接矛盾；
   *   2. 它把**出场**当成了**观察点** —— 而一章里出场 5 个人
   *      完全可以是单一视角（其余人只被看到）。
   *
   *   视角请用 `narrativePov` + ScenePlan.pov。
   */
  mainCharacters: z.array(z.string().min(1)).min(1, '至少一个主要角色'),
  locations: z.array(z.string()).default([]),

  /**
   * 本章叙事视角（P1）—— 全书统一的讲述方式。
   *
   * ⚠ 放在 brief 而不是只放 scene：视角是**整本书的契约**，
   *   逐场景各自声明会让"第三章突然变全知"这种问题无法被发现。
   *   ScenePlan 上的 `narrativePov` 是**场景级覆盖**（有明确理由时用，
   *   例如插叙段），缺省时以本字段为准。
   */
  narrativePov: NarrativePovSchema.optional(),
  /** 全书默认叙事距离（P1）；ScenePlan 可覆盖 */
  narrativeDistance: NarrativeDistanceSchema.optional(),

  /** 必须发生的事件（缺失即审稿不通过） */
  requiredEvents: z.array(z.string()).default([]),
  /** 禁止发生的事件（越界即审稿不通过） */
  forbiddenEvents: z.array(z.string()).default([]),

  emotionalArc: z.string().default(''),
  pacingPlan: z.string().default(''),

  foreshadowing: ForeshadowingActionSchema.default({ plant: [], reinforce: [], payoff: [] }),

  /** 章末钩子 */
  hook: z.string().default(''),

  /** 命中的 Skill id（由 Skill Engine 检索后回填） */
  skillRefs: z.array(z.string()).default([]),
});
export type ChapterBrief = z.infer<typeof ChapterBriefSchema>;

/**
 * Scene Function 分类（§19.1 的 15 类）—— **权威定义**。
 *
 * ⚠ 定义位置必须在 `ScenePlanSchema` **之前**：
 *   zod 的 `z.enum(...)` 是模块加载时求值的，若定义在后面，
 *   引用它会在初始化阶段抛 TDZ 错误（Cannot access before initialization）。
 *
 * ⚠ 这是唯一权威定义 —— `annotation.ts` 复用不重复声明（同 ReviewCategory 纪律）。
 *   两处各写一份会漂移，而枚举漂移的后果是 Planner 声明的 sceneFunction
 *   与标注器接受的值不一致，报错时还看不出原因。
 *
 * ⚠ 顺序也影响契约注入的枚举取值列表（`collectEnums`）——
 *   模型看到的合法值就是这里的顺序。
 */
export const SceneFunctionSchema = z.enum([
  'SETUP',
  'CONFLICT',
  'ESCALATION',
  'REVELATION',
  'REVERSAL',
  'CHARACTER_DEVELOPMENT',
  'RELATIONSHIP_CHANGE',
  'WORLD_BUILDING',
  'ACTION',
  'EMOTIONAL_PAYOFF',
  'COMEDY_RELIEF',
  'CLIMAX',
  'COOLDOWN',
  'HOOK',
  'CLIFFHANGER',
]);
export type SceneFunction = z.infer<typeof SceneFunctionSchema>;


/**
 * Scene Plan（施工文档 §30 的 14 个字段）
 */
export const ScenePlanSchema = z.object({
  sceneId: z.string().min(1),
  purpose: z.string().min(1, 'scene purpose 不得为空'),
  /**
   * 视角人物（自由文本，§30 原字段）—— 「谁在看」。
   *
   * ⚠ 这是**具体的角色名**（"林晚"），不是"本章有谁出场"。
   *   若本场景没有单一视角人物（全知叙述），留空即可。
   */
  pov: z.string().default(''),
  /**
   * 叙事视角（枚举，P1）—— 「用第几人称看」。
   *
   * ⚠ 与 `pov` 分工：`pov` 说**是谁**，这里说**怎么讲**。
   *   两者都缺时 Writer 只能自己决定，而"跳视角"正是这么发生的。
   */
  narrativePov: NarrativePovSchema.optional(),
  /** 叙事距离（P1）—— 决定能不能直接写内心 */
  narrativeDistance: NarrativeDistanceSchema.optional(),
  /**
   * 叙事位置（P1）—— 本场景在结构中的位置。
   *
   * ⚠ 与 `sceneFunction` 正交：位置决定"读者已知多少"，
   *   从而决定该解释还是该留白。技能检索会用到它。
   */
  narrativePosition: NarrativePositionSchema.optional(),
  setting: z.string().default(''),

  startState: z.string().default(''),
  /** ⚠ §31 的规则 10：每个 Scene 必须改变至少一个状态 */
  endState: z.string().min(1, 'scene 必须声明 endState（每个 Scene 都要改变状态）'),

  goal: z.string().default(''),
  conflict: z.string().default(''),
  obstacle: z.string().default(''),

  turningPoint: z.string().optional(),
  reveal: z.string().optional(),

  emotionalCurve: z.string().default(''),
  pacing: z.string().default(''),

  /**
   * 本场景情绪强度档位（P1）—— §25 Emotion 维度的**数据来源**。
   *
   * ⚠ 这是修一个真实的空转：此前 Writer 检索技能时写死
   *   `emotionIntensity: null`，注释说"从 emotionalCurve 无法可靠推断"。
   *   那个判断是对的（自然语言推不出数值），但结论错了 ——
   *   正确做法不是永久传 null，而是**让 Planner 声明档位**，
   *   由代码映射成数值（`resolveIntensity`）。
   *
   *   传 null 的后果：所有声明了 `minEmotionIntensity` 的技能
   *   永远拿不到那 0.3 分，该维度**从未生效过**。
   */
  emotionIntensityBand: IntensityBandSchema.optional(),
  /**
   * 本场景张力档位（P1）。
   *
   * ⚠ 与 `emotionIntensityBand` 分开：情绪强度是"角色有多激动"，
   *   张力是"读者有多紧张"。追车戏可以情绪平（角色冷静）而张力高。
   *   合成一个维度会让"冷静的危机"无法被检索到。
   */
  tensionBand: IntensityBandSchema.optional(),

  /**
   * 场景功能（§19.1 的 15 类）—— Skill Engine 检索的**主键**（§25）。
   *
   * ⚠ 为什么必须由 Planner 声明而不是事后推断：
   *   §25 的检索输入第一项就是 `Scene Type`。没有它，技能检索只能
   *   退化成"按置信度取前几个" —— 那会把"冲突要拉张力"的技能
   *   注入到缓冲场景里，正好写反。
   *
   * ⚠ 用**权威枚举**（SceneFunctionSchema）而非自由文本：
   *   自由文本会让"COOLDOWN"与"缓冲"变成两个值，检索直接失效。
   *   这也让输出契约能列出合法取值（模型不必猜）。
   *
   * 设为可选是为了兼容既有计划（缺省时引擎退化为不按功能过滤，
   * 而不是报错 —— 一个缺字段不该让整章无法生成）。
   */
  sceneFunction: SceneFunctionSchema.optional(),

  activeSkills: z.array(z.string()).default([]),
  continuityConstraints: z.array(z.string()).default([]),

  endingHook: z.string().optional(),
});
export type ScenePlan = z.infer<typeof ScenePlanSchema>;

/**
 * Planner 的完整输出。
 *
 * ⚠ 这是「单次工具调用提交」的 payload 形状 —— Planner 必须一次性提交
 *   brief + 全部 scenes，而不是分多次给片段让宿主拼接。
 */
export const PlanOutputSchema = z.object({
  brief: ChapterBriefSchema,
  scenes: z.array(ScenePlanSchema).min(1, '至少一个场景'),
});
export type PlanOutput = z.infer<typeof PlanOutputSchema>;



/**
 * 校验 Plan 的**业务约束**（超出 zod 能表达的范围）。
 *
 * 返回问题列表（空数组表示通过）。设计成返回列表而不是抛错，
 * 是因为 Planner 需要用这些问题做一次"自我修复"重试，
 * 而不是直接失败整个 Run。
 */
export function validatePlanSemantics(plan: PlanOutput): string[] {
  const issues: string[] = [];

  // 1. chapterNumber 一致性：brief 的章号必须与 scenes 声明的一致（若有）
  for (const [i, s] of plan.scenes.entries()) {
    if (!s.sceneId) issues.push(`scene[${i}] 缺少 sceneId`);
  }

  // 2. sceneId 不得重复
  const ids = plan.scenes.map((s) => s.sceneId);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length > 0) issues.push(`sceneId 重复：${[...new Set(dup)].join(', ')}`);

  // 3. requiredEvents 与 forbiddenEvents 不得冲突
  const required = new Set(plan.brief.requiredEvents);
  for (const f of plan.brief.forbiddenEvents) {
    if (required.has(f)) {
      issues.push(`事件同时出现在 required 与 forbidden：${f}`);
    }
  }

  // 4. §31 规则 10：每个 Scene 必须改变至少一个状态
  for (const [i, s] of plan.scenes.entries()) {
    if (s.startState && s.startState === s.endState) {
      issues.push(`scene[${i}](${s.sceneId}) 的 startState 与 endState 相同 —— 场景没有推进`);
    }
  }

  // 5. 伏笔回收不应在登记之前（同一章内不校验顺序，但不得只回收不登记）
  if (plan.brief.foreshadowing.payoff.length > 0 && plan.brief.foreshadowing.plant.length === 0) {
    // 这是"可能"的问题：回收已有伏笔是允许的，只在提示层面记录
    issues.push(
      '本章有伏笔回收但无新登记 —— 若回收的是既有伏笔可忽略，否则应补充 plant',
    );
  }

  // 6. ⚠ 占位符检测（实测踩到）
  //
  // 模型在材料不足时会把「待确认：…」「例如…」原样写进字段，产出一份
  // 看着有结构、实则没有创作决定的大纲：
  //   hook: "待确认：章末钩子，例如主角发现了一个关键物品或信息"
  // 这种计划传给 Writer 等于没给方向，写出来的东西必然空转。
  //
  // 因此在语义层拦下来（而不是只靠 prompt 劝阻 —— prompt 会失效，
  // 校验不会）。
  const placeholders = findPlaceholders(plan);
  for (const p of placeholders) {
    issues.push(`${p.field} 含占位符「${p.hit}」—— 必须给出具体的创作决定，不得留待确认`);
  }

  // 7. ⚠⚠ 视角与出场角色的关系（P1）
  //
  // 这一条修的是此前 prompt 里的概念错误：把「本章出场的人」
  // 当成「视角」用。既然视角现在有了独立字段，就必须校验两者
  // 不矛盾 —— 否则 Planner 会声明一个不在场的人当视角人物，
  // 而 Writer 会照着写出一段"某人看着自己不在场的场面"。
  //
  // ⚠⚠ 但这里**必须容忍模型把视角类型写进 pov 字段**。
  //   实测证据：本仓库既有的 planner 测试夹具写的正是
  //   `pov: '第三人称限知'` —— 一个视角类型，而不是人名。
  //   模型天然会把 §30 那个自由文本的 `pov` 当成"视角"来填。
  //
  //   若把这种情况判为 blocking，后果是**每一章都要修复重试**，
  //   而修复重试会再产出一个同样的值 —— 直到次数用尽后整章失败。
  //   这就是"误报比漏检更糟"的具体形态。
  //
  //   所以：看起来像视角类型的 → 不当人名校验（Writer 侧照样能
  //   正确理解，因为它也读 narrativePov）；只有看起来像**人名**
  //   却不在场的，才是真问题。
  for (const [i, s] of plan.scenes.entries()) {
    const pov = (s.pov ?? '').trim();
    if (pov.length === 0) continue;
    if (looksLikeViewpointType(pov)) continue; // 模型填成了视角类型 —— 容忍

    // 全知视角不存在"视角人物" —— 声明了就是自相矛盾
    const effectivePov = s.narrativePov ?? plan.brief.narrativePov;
    if (effectivePov === 'THIRD_OMNISCIENT') {
      issues.push(
        `scene[${i}](${s.sceneId}) 声明了视角人物「${pov}」但叙事视角是 THIRD_OMNISCIENT —— ` +
          '全知叙述没有单一视角人物，两者只能留一个',
      );
      continue;
    }

    // 视角人物必须在场（容错匹配：模型常写成"林晚（视角）"这类）
    const inCast = plan.brief.mainCharacters.some((c) => looseNameMatch(c, pov));
    if (!inCast) {
      issues.push(
        `scene[${i}](${s.sceneId}) 的视角人物「${pov}」不在本章出场角色里` +
          `（${plan.brief.mainCharacters.join('、')}）—— 视角人物必须在场`,
      );
    }
  }

  return issues;
}

/**
 * 判断一段文本是不是**视角类型**而不是人名（P1）。
 *
 * ⚠ 存在的理由是实测：模型会把 §30 的自由文本字段 `pov`
 *   填成"第三人称限知""第一人称"这类视角类型，而不是角色名。
 *   这是**可以理解的行为**（字段名就叫 pov），不是错误 ——
 *   强行判错会让每章都卡在修复重试上。
 *
 * 判定偏宽松：宁可把一个奇怪的人名当成视角类型（漏检），
 * 也不要把视角类型当成人名（误报 → 修复重试 → 整章失败）。
 */
function looksLikeViewpointType(s: string): boolean {
  // 中英文视角术语。不要求精确匹配 —— 模型会写成
  // "第三人称限知""有限第三人称视角""third-person limited" 等多种形式。
  return /第一人称|第二人称|第三人称|全知|限知|限制视角|有限视角|多视角|视角切换|first[-\s]?person|third[-\s]?person|omniscient|limited/i.test(
    s,
  );
}

/**
 * 容错的名字匹配（P1）。
 *
 * ⚠ 为什么不用严格相等：实测模型会把同一角色写成
 *   「林晚」「林晚（视角）」「林晚 Lin Wan」等多种形式。
 *   严格相等会产生大量**假阳性**，而假阳性的代价是
 *   Planner 反复自我修复（浪费一次调用）甚至最终失败 ——
 *   比漏检一个真问题更糟。
 *
 * 所以规则是：任一方包含另一方即视为同一角色，并忽略
 * 括号补充说明与空白。**宁可漏检，不要误报。**
 */
function looseNameMatch(a: string, b: string): boolean {
  const norm = (s: string): string =>
    s
      // 去掉括号补充（中英文括号）
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/\s+/g, '')
      .trim();
  const x = norm(a);
  const y = norm(b);
  if (x.length === 0 || y.length === 0) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** 判定为占位符的文本模式 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /待确认/,
  /待定/,
  /TODO/i,
  /TBD/i,
  /待填写/,
  /请填写/,
  /此处填/,
  /（\s*空\s*）/,
  /\(\s*空\s*\)/,
  /^\s*例如[：:]/,
  /例如：.*(物品|信息|事件|人物).*$/,
  /^(待|未)(补充|说明|明确|给出)/,
  /占位/,
  /\$\{.*\}/,
  /<[^>]*填写[^>]*>/,
];

/** 检查计划里是否残留占位符；返回 [{field, hit}] */
export function findPlaceholders(plan: PlanOutput): { field: string; hit: string }[] {
  const out: { field: string; hit: string }[] = [];

  const scan = (field: string, value: unknown): void => {
    if (typeof value === 'string') {
      for (const re of PLACEHOLDER_PATTERNS) {
        const m = value.match(re);
        if (m) {
          out.push({ field, hit: value.slice(0, 40) });
          return; // 一个字段只报一次
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const [i, v] of value.entries()) scan(`${field}[${i}]`, v);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        scan(`${field}.${k}`, v);
      }
    }
  };

  scan('brief', plan.brief);
  scan('scenes', plan.scenes);
  return out;
}

/**
 * 区分为「阻塞性问题」与「提示」。
 *
 * 阻塞性问题必须修复（如 sceneId 重复），提示则允许带病继续。
 */
export function splitPlanIssues(issues: readonly string[]): {
  blocking: string[];
  advisory: string[];
} {
  const blocking: string[] = [];
  const advisory: string[] = [];
  for (const i of issues) {
    if (i.includes('可忽略')) advisory.push(i);
    else blocking.push(i);
  }
  return { blocking, advisory };
}