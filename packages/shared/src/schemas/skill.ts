/**
 * 技能（施工文档 §23 / §24）
 *
 * ## §24 的核心纪律：Skill 不是 Prompt 模板
 *
 * 错误设计：
 * ```
 * 一个 Skill = 一大段 Prompt
 * ```
 *
 * 正确设计：
 * ```
 * Skill = Trigger + Rules + Constraints + Examples
 *       + Anti-patterns + Evidence + Confidence + Version
 * ```
 *
 * 拆成结构化字段**不是为了好看**，而是因为拆开之后技能才能：
 * - 搜索（按 sceneType / genre / category 检索）
 * - 排序（按 confidence）
 * - 组合（多个技能同时适用）
 * - 版本管理（同 id 递增 version）
 * - A/B 测试、禁用、更新、删除
 *
 * 一整段 prompt 文本这些**一个都做不到** —— 你只能整段塞给模型或整段丢弃。
 *
 * ## ⚠ `antiPatterns` 与 `rules` 同等重要
 *
 * 只说"该怎么做"的技能会诱导 Writer **到处套用同一招**。
 * `antiPatterns` 是每个技能自带的"什么时候会毁稿"清单 ——
 * 它来自模式挖掘的 `boundary` 槽位（§20），
 * 也就是从真实作品里观察到的**失效条件**。
 *
 * ## ⚠ `trigger` 决定检索命中，必须可判定
 *
 * `sceneTypes` 用 §19.1 的权威枚举，`genre` 用归一化后的类型。
 * 若写成自由文本（"当情绪张力较高时"），检索只能靠模糊匹配，
 * 结果是**要么全命中要么全不命中**，技能引擎形同虚设。
 */
import { z } from 'zod';
import { NarrativePositionSchema, NarrativePovSchema, SceneFunctionSchema } from './plan.js';

/** 技能状态（与 0001 迁移的 CHECK 约束一致） */
export const SKILL_STATUSES = [
  /** 刚编译出来，未经复核 */
  'CANDIDATE',
  /** 人工复核中 */
  'REVIEW',
  /** 已验证有效（有使用记录支撑） */
  'VALIDATED',
  /** 正式启用，Writer 会检索到 */
  'ACTIVE',
  /** 已废弃，不参与检索 */
  'DEPRECATED',
] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

/**
 * 技能类别（§23 的 category）。
 *
 * ⚠ 用固定枚举而非自由文本：类别是检索与统计的维度，
 *   自由文本会产生 "emotion"/"emotions"/"情绪" 三个同义类别，
 *   让"取所有情绪类技能"这种查询失效。
 */
export const SKILL_CATEGORIES = [
  'emotion', // 情绪表达
  'pacing', // 节奏控制
  'dialogue', // 对话
  'description', // 描写
  'conflict', // 冲突构造
  'characterization', // 人物塑造
  'structure', // 结构（开场/转折/收束）
  'information', // 信息释放与悬念
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/**
 * 触发条件 —— 决定技能何时被检索到。
 *
 * ⚠ 全部字段都必须**可判定**（枚举或数值），不能是模糊描述。
 */
export const SkillTriggerSchema = z.object({
  /** 适用的场景功能（§19.1 权威枚举） */
  sceneTypes: z.array(SceneFunctionSchema).default([]),
  /**
   * 适用类型（归一化后的，如 "都市"）。
   *
   * ⚠ 空数组表示"不限类型"，与 UNIVERSAL 作用域一致。
   */
  genres: z.array(z.string()).default([]),
  /** 情绪强度要求（可选，避免过度约束导致检索不到） */
  minEmotionIntensity: z.number().min(0).max(1).optional(),
  /**
   * 适用叙事视角（P1）。空数组 = 不限视角。
   *
   * ⚠ 用**权威枚举**而不是自由文本：自由文本会让"第一人称"
   *   与"FIRST_PERSON"变成两个值，检索静默失效。
   *
   * ⚠ 视角不符时是**降权**不是排除 —— 视角是场景属性，
   *   而手法往往可以跨视角迁移（"把情绪拆到动作"在三种视角下都成立）。
   *   一票否决会让技能库在小样本下几乎检索不到东西。
   */
  povs: z.array(NarrativePovSchema).default([]),
  /**
   * 适用叙事位置（P1）。空数组 = 不限位置。
   *
   * ⚠ 与 `sceneTypes` 正交：位置决定"读者已知多少"，
   *   同一个场景功能在不同位置需要不同写法。
   */
  narrativePositions: z.array(NarrativePositionSchema).default([]),
  /**
   * 张力要求（P1）。空 = 不限。
   *
   * ⚠ 与 `minEmotionIntensity` 独立：冷静的危机（低情绪、高张力）
   *   与崩溃的独白（高情绪、低张力）是两种不同的场景。
   */
  minTension: z.number().min(0).max(1).optional(),
  /** 额外的前置条件（人类可读，供 Writer 判断，不参与索引） */
  notes: z.string().optional(),
});

export type SkillTrigger = z.infer<typeof SkillTriggerSchema>;

/**
 * 一条可执行的规则。
 *
 * ⚠ 规则必须是**可执行的动作**，不能是评价。
 *   "写得更细腻"无法执行；"把情绪拆到动作与旁白"可以。
 *   这个约束在编译时由 prompt 保证，在落库时无法机械校验 ——
 *   因此 `rules` 是 string[] 而非结构化对象。
 */
export const SkillRuleSchema = z.object({
  /** 动作本身 */
  rule: z.string().min(2),
  /** 为什么有效（读者心理机制）—— 让 Writer 理解而非机械套用 */
  rationale: z.string().optional(),
});

export const SkillExampleSchema = z.object({
  /** 场景 id（可回溯到原文，§46） */
  sceneId: z.string().min(1),
  /** 摘录（可能是片段，不是全文） */
  excerpt: z.string().optional(),
  /** 这条例子说明了什么 */
  demonstrates: z.string().optional(),
});

/**
 * 完整技能。
 *
 * ⚠ 与 §24 的八要素一一对应，缺一不可。
 */
export const SkillSchema = z.object({
  id: z.string().min(1),
  name: z
    .string()
    .min(1)
    // 技能名是标识符（用于检索与日志），统一 snake_case
    .regex(/^[a-z][a-z0-9_]*$/, '技能名必须是 snake_case（小写字母开头）'),
  category: z.enum(SKILL_CATEGORIES),
  /** 一句话说明这个技能解决什么问题（供 Writer 在候选列表里判断） */
  summary: z.string().min(4),
  trigger: SkillTriggerSchema,
  rules: z.array(SkillRuleSchema).min(1),
  /**
   * ⚠ 反模式（防滥用）—— 至少一条。
   *
   * 强制非空：一个说不出"什么时候不该用"的技能，
   * 本质上还没被理解透，不该进入 Writer 的上下文。
   */
  antiPatterns: z.array(z.string().min(2)).min(1),
  examples: z.array(SkillExampleSchema).default([]),
  /** 证据场景 id（§46 可回溯） */
  evidenceRefs: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  version: z.number().int().min(1),
  status: z.enum(SKILL_STATUSES),
  /** 作用域（§21 三档） */
  scope: z.enum(['UNIVERSAL', 'GENRE', 'STYLE']),
  /** 归一化后的类型（UNIVERSAL 时为 null） */
  genre: z.string().nullable().default(null),
  /** 来源作品（跨作品证据） */
  sourceDocumentIds: z.array(z.string()).default([]),
});

export type Skill = z.infer<typeof SkillSchema>;

/** 编译器的 LLM 输出契约（id/version/status 由代码填，不让模型决定） */
export const CompiledSkillSchema = z.object({
  name: z
    .string()
    .min(2)
    .regex(/^[a-z][a-z0-9_]*$/, 'name 必须是 snake_case，如 high_tension_emotion'),
  category: z.enum(SKILL_CATEGORIES),
  summary: z.string().min(4),
  trigger: SkillTriggerSchema,
  rules: z.array(SkillRuleSchema).min(1),
  antiPatterns: z.array(z.string().min(2)).min(1),
});

export type CompiledSkill = z.infer<typeof CompiledSkillSchema>;

export const CompileOutputSchema = z.object({
  skills: z.array(CompiledSkillSchema),
});
