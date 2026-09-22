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

  mainCharacters: z.array(z.string().min(1)).min(1, '至少一个主要角色'),
  locations: z.array(z.string()).default([]),

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
  pov: z.string().default(''),
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

  return issues;
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
