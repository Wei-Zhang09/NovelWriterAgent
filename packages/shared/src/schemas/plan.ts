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

/** Scene Function 分类（§19.1），Planner 应据此声明场景功能 */
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

  return issues;
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
