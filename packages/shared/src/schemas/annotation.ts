/**
 * 叙事标注 Schema（施工文档 §19）
 *
 * ## 设计原则：分「可机械计算」与「需语义理解」两层
 *
 * §19 的 SceneAnnotation 混了两类字段：
 *
 * | 类别 | 字段 | 来源 |
 * |---|---|---|
 * | 机械可算 | `pacing` / `prose` | 直接统计（段落密度、对话比、句长） |
 * | 需语义理解 | `sceneFunction` / `goals` / `conflicts` / `hook` | LLM 或规则启发 |
 *
 * 分开的理由：机械字段**永远不该由 LLM 生成** —— 那是可算的，
 * 让模型去"估"只会引入误差，且无法复现。反过来，语义字段
 * 在 LLM 不可用时必须**如实标 null**，不能编造。
 *
 * ## 为什么所有语义字段都是 optional
 *
 * 规则切分能给出边界，但给不出"这场戏的作用是什么"。
 * 若强行填默认值（如一律填 SETUP），模式挖掘会把
 * "所有场景都是 SETUP"当成统计事实 —— 那是伪造数据。
 * 因此宁可为 null，让下游知道"这场戏没标注"。
 */
import { z } from 'zod';
import { SceneFunctionSchema } from './plan.js';

/**
 * 场景功能分类（§19.1 的 15 类）。
 *
 * ⚠ 复用 plan.ts 的**权威定义**，不在此重复声明 ——
 *   两处各写一份会漂移（改了 A 忘了 B），而枚举漂移的后果是
 *   Planner 声明的 sceneFunction 与标注器接受的值不一致，
 *   报错时还看不出原因。这与 ReviewCategory 的处理同一纪律。
 */
export const SCENE_FUNCTIONS = SceneFunctionSchema.options;
export type { SceneFunction } from './plan.js';

/**
 * 场景切分依据（§18）。
 *
 * ⚠ 记录依据是必要的：模式挖掘要区分"这场戏为什么被切开"——
 *   按时间切与按地点切，对"节奏"这一维度的含义不同。
 */
export const BOUNDARY_REASONS = [
  'CHAPTER_START',
  'TIME_SHIFT',
  'PLACE_SHIFT',
  'POV_SHIFT',
  'CAST_SHIFT',
  'EVENT_SHIFT',
  'CONFLICT_SHIFT',
  'SEPARATOR',
  'LLM_DECIDED',
] as const;
export type BoundaryReason = (typeof BOUNDARY_REASONS)[number];

/** 目标（角色想要什么） */
export const GoalSchema = z.object({
  character: z.string().min(1),
  /** 目标内容（一句话） */
  goal: z.string().min(1),
  /** 是否在本场景内达成 */
  achieved: z.boolean().default(false),
});

/** 冲突 */
export const ConflictSchema = z.object({
  /** 冲突双方（可为人、环境、内心） */
  parties: z.array(z.string().min(1)).min(1),
  /** 冲突内容 */
  description: z.string().min(1),
  /** 强度 0~1 */
  intensity: z.number().min(0).max(1).default(0.5),
  /** 冲突类型 */
  kind: z.enum(['INTERPERSONAL', 'INTERNAL', 'ENVIRONMENTAL', 'SOCIETAL']).default('INTERPERSONAL'),
});

/** 动作/事件 */
export const ActionSchema = z.object({
  actor: z.string().default(''),
  action: z.string().min(1),
  /** 该动作造成的结果（可选） */
  consequence: z.string().default(''),
});

/** 情绪 */
export const EmotionSchema = z.object({
  character: z.string().default(''),
  emotion: z.string().min(1),
  /** 强度 0~1 */
  intensity: z.number().min(0).max(1).default(0.5),
  /** 呈现方式：明述 or 行为暗示（§34 关注后者） */
  expression: z.enum(['STATED', 'IMPLIED_BY_BEHAVIOR']).default('STATED'),
});

/** 信息流（谁知道什么 —— 悬念的基础） */
export const InformationFlowSchema = z.object({
  /** 信息内容 */
  content: z.string().min(1),
  /** 谁获知了（空数组 = 只有读者知道） */
  learnedBy: z.array(z.string()).default([]),
  /** 谁仍不知道（信息不对称） */
  stillUnknownTo: z.array(z.string()).default([]),
});

/** 钩子（章末/场景末的抓力） */
/**
 * 钩子（悬念/期待）。
 *
 * ⚠ 容错：模型表达钩子时**最自然的写法是一个字符串**
 *   （`"hook": "他是否已猜出行李箱里的电脑"`），而契约要求
 *   `{type, intensity}`。实测《清纯校花》486 章里有 7 个场景
 *   因此失败：
 *     - 5 个 `hook.type: Required`（返回了对象但漏了 type）
 *     - 2 个 `hook: Expected object, received string`（返回了字符串）
 *
 *   两种都是**表述形式问题，不是内容缺失** —— 模型明明给出了钩子。
 *   因此这里做**有损但诚实的容错**：
 *     - 字符串 → `{ type: <该字符串>, intensity: 0.5 }`
 *     - 对象缺 type → 用 hint/description 兜底；都没有才用占位符
 *
 *   ⚠ 为什么不干脆放宽成 `z.union([string, object])`：
 *     那会让下游（模式挖掘）面对两种形状，每次都要判断。
 *     归一成一种形状，下游逻辑才简单可靠。
 *
 *   ⚠ 也不丢弃整个场景的语义标注：hook 只是一个字段，
 *     丢弃会让**冲突/目标/情绪这些真正重要的信息一起消失**。
 */
export const HookSchema = z.preprocess(
  (raw) => {
    // ⚠ null → undefined：模型有时用 null 表示"这个场景没有钩子"。
    //   归一成 undefined（而不是让 null 通过），下游只需处理**一种**
    //   "缺失"形态。`.optional()` 只接受 undefined，不接受 null。
    if (raw === null) return undefined;
    // 字符串 → 包成对象
    if (typeof raw === 'string') {
      const t = raw.trim();
      return t ? { type: t, intensity: 0.5 } : undefined;
    }
    if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      // 漏了 type：用其他可能承载描述的字段兜底
      if (typeof o['type'] !== 'string' || (o['type'] as string).trim() === '') {
        const alt =
          (typeof o['hint'] === 'string' && o['hint']) ||
          (typeof o['description'] === 'string' && o['description']) ||
          (typeof o['question'] === 'string' && o['question']) ||
          (typeof o['content'] === 'string' && o['content']);
        if (alt) return { ...o, type: alt };
        // 确实没有任何描述 → 交给下面的校验失败（不编造）
      }
    }
    return raw;
  },
  // ⚠ 内层必须 `.optional()`：`z.preprocess` 返回 `ZodEffects`，
  //   而**外层的 `.optional()` 拦不住内层的 undefined** ——
  //   字段缺失时 preprocess 收到 undefined 并原样返回，
  //   内层 object schema 就报 "hook: Required"。
  //
  //   实测：《清纯校花》第 349/353 章报 `hook: Required` 就是这个原因
  //   （模型没给 hook，本应合法）。这是修 hook 容错时**我自己引入的回归**。
  z
    .object({
      type: z.string().min(1),
      intensity: z.number().min(0).max(1).default(0.5),
    })
    .optional(),
);

/**
 * 机械可算的节奏指标。
 *
 * ⚠ 这些**必须由代码计算**，不接受 LLM 输出 ——
 *   它们有确定定义，让模型估会引入不可复现的误差。
 */
export const PacingSchema = z.object({
  /** 段落密度（每千字的段落数） */
  paragraphDensity: z.number().min(0),
  /** 对话占比 0~1（对话段字符数 / 总字符数） */
  dialogueRatio: z.number().min(0).max(1),
  /** 节奏速度 0~1（对话多 + 段落短 = 快） */
  speed: z.number().min(0).max(1),
});

export const ProseSchema = z.object({
  sentenceLengthMean: z.number().min(0),
  dialogueRatio: z.number().min(0).max(1),
  descriptionRatio: z.number().min(0).max(1),
  internalMonologueRatio: z.number().min(0).max(1),
});

/**
 * 场景标注（§19）。
 *
 * ⚠ 语义字段全部 optional：规则切分给不出它们，
 *   强行填默认值会把伪造数据当成统计事实。
 */
export const SceneAnnotationSchema = z.object({
  sceneId: z.string().min(1),

  // ── 基础信息（规则可给部分） ──
  characters: z.array(z.string()).default([]),
  pov: z.string().optional(),
  setting: z.string().optional(),
  time: z.string().optional(),

  // ── 语义标注（需 LLM；不可用时为 null/空） ──
  goals: z.array(GoalSchema).default([]),
  conflicts: z.array(ConflictSchema).default([]),
  actions: z.array(ActionSchema).default([]),
  emotions: z.array(EmotionSchema).default([]),
  information: z.array(InformationFlowSchema).default([]),

  eventType: z.string().optional(),
  sceneFunction: SceneFunctionSchema.optional(),

  hook: HookSchema.optional(),
  foreshadowing: z.array(z.string()).default([]),
  payoff: z.array(z.string()).default([]),

  // ── 机械指标（代码计算，不接受 LLM） ──
  pacing: PacingSchema.optional(),
  prose: ProseSchema.optional(),
});

export type SceneAnnotation = z.infer<typeof SceneAnnotationSchema>;
export type GoalAnnotation = z.infer<typeof GoalSchema>;
export type ConflictAnnotation = z.infer<typeof ConflictSchema>;
export type ActionAnnotation = z.infer<typeof ActionSchema>;
export type EmotionAnnotation = z.infer<typeof EmotionSchema>;
export type InformationFlowAnnotation = z.infer<typeof InformationFlowSchema>;

/**
 * LLM 标注输出的契约（只含语义字段）。
 *
 * ⚠ 刻意**不含** pacing/prose：那两项由代码算。
 *   若让模型一起输出，它可能给出"看起来合理但与实际不符"的数字，
 *   而这类错误在统计时无法察觉。
 */
export const SceneSemanticSchema = z.object({
  sceneFunction: SceneFunctionSchema,
  characters: z.array(z.string()).default([]),
  pov: z.string().default(''),
  setting: z.string().default(''),
  time: z.string().default(''),
  goals: z.array(GoalSchema).default([]),
  conflicts: z.array(ConflictSchema).default([]),
  actions: z.array(ActionSchema).default([]),
  emotions: z.array(EmotionSchema).default([]),
  information: z.array(InformationFlowSchema).default([]),
  eventType: z.string().default(''),
  hook: HookSchema.optional(),
  foreshadowing: z.array(z.string()).default([]),
  payoff: z.array(z.string()).default([]),
});

export type SceneSemantic = z.infer<typeof SceneSemanticSchema>;
