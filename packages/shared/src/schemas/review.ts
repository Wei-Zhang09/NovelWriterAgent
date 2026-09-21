/**
 * Review 输出协议（施工文档 §32 / §33）
 *
 * ## §32 的核心主张：Reviewer 输出问题，不输出分数
 *
 *   ✗ { "score": 88 }              ← 禁止
 *   ✓ { overallStatus, issues[] }  ← 唯一合法形状
 *
 * 为什么这条要写在 schema 层而不是 prompt 层：
 *   分数是**自证成功**的温床 —— 模型给 88 分，人就倾向于接受。
 *   问题列表则强制它指出具体位置与依据，每条都能被复核。
 *   因此若模型返回 {"score":88}，Schema 直接判失败，
 *   **不做"从分数映射到问题列表"的容错** —— 那等于把自证成功请回来。
 *
 * ## §33 的严重级别
 *
 *   BLOCKING > MAJOR > MINOR > NOTE
 *   只有 BLOCKING = 0 才能进入 Commit。这条由代码强制，不靠人记。
 */
import { z } from 'zod';

/**
 * ⚠ 类别与严重级别的**权威定义在 schemas/enums.ts**（§33 的集中 enum 纪律：
 *   "禁止自由字符串"）。这里只做 re-export 与派生，不重复声明 ——
 *   两处各写一份必然漂移。
 */
import { ReviewCategory, ReviewSeverity } from './enums.js';
import type { ReviewCategory as ReviewCategoryType, ReviewSeverity as ReviewSeverityType } from './enums.js';
export type { ReviewCategoryType, ReviewSeverityType };

/** 全部类别（§33 的 15 类） */
export const REVIEW_CATEGORIES = ReviewCategory.options;
/** 全部严重级别 */
export const REVIEW_SEVERITIES = ReviewSeverity.options;

/**
 * MVP 实际启用的类别（ADR-0003）。
 *
 * 去掉 STYLE_ALIGNMENT（依赖 Style DNA，Full 阶段）。
 * 保留 NATURALNESS / AI_LIKE_PATTERN：由规则检测器支撑
 *   （writing/naturalness/detectors.ts），不依赖文风指纹。
 */
export const MVP_REVIEW_CATEGORIES = [
  'PLOT',
  'CHARACTER',
  'CONTINUITY',
  'TIMELINE',
  'WORLD_RULE',
  'FORESHADOWING',
  'PACING',
  'DIALOGUE',
  'EMOTION',
  'DESCRIPTION',
  'REPETITION',
  'NATURALNESS',
  'AI_LIKE_PATTERN',
  'HOOK',
] as const satisfies readonly (typeof ReviewCategory.options)[number][];

export const SEVERITY_ORDER: Readonly<Record<ReviewSeverity, number>> = {
  BLOCKING: 0,
  MAJOR: 1,
  MINOR: 2,
  NOTE: 3,
};

/** 整体状态：由 issues 推导，不允许模型自由填写 */
export const REVIEW_STATUSES = ['PASSED', 'NEEDS_REVISION', 'BLOCKED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** 问题位置：至少能定位到段；有场景信息时一并给出 */
export const ReviewLocationSchema = z.object({
  /** 段号（从 1 起）。正文按空行分段 */
  paragraph: z.number().int().positive().optional(),
  sceneId: z.string().optional(),
  /** 原文片段（便于人工定位；不要求精确匹配，因为模型可能改写标点） */
  excerpt: z.string().max(200).optional(),
});

export const ReviewIssueSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(REVIEW_SEVERITIES),
  category: z.enum(REVIEW_CATEGORIES),
  /** 问题是什么（陈述句，不写"建议"） */
  claim: z.string().min(1).max(500),
  /**
   * 依据：Canon fact id / 章节 id / 伏笔 id 等。
   *
   * ⚠ 允许为空**只在**类别本身不依赖外部依据时（如 PACING、DESCRIPTION）。
   *   CONTINUITY / TIMELINE / WORLD_RULE / FORESHADOWING 这几类
   *   必须有依据 —— 这条在 service 层用 assertEvidenceForCategory 强制。
   */
  evidence: z.array(z.string()).default([]),
  location: ReviewLocationSchema.optional(),
  /** 可执行的修改建议（动词开头） */
  suggestions: z.array(z.string()).default([]),
});

/** §32 的输出契约 */
export const ReviewOutputSchema = z.object({
  overallStatus: z.enum(REVIEW_STATUSES),
  issues: z.array(ReviewIssueSchema),
  /** 可选：一句话概述。不参与判定 */
  summary: z.string().max(1000).optional(),
});

export type ReviewLocation = z.infer<typeof ReviewLocationSchema>;
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

/**
 * 需要外部依据的类别。
 *
 * 依据 = 指向 Canon / 计划 / 伏笔的 id。没有依据的断言等于"我觉得"，
 * 而"我觉得"不该阻塞别人的稿子。
 */
export const CATEGORIES_REQUIRING_EVIDENCE: readonly ReviewCategory[] = [
  'CONTINUITY',
  'TIMELINE',
  'WORLD_RULE',
  'FORESHADOWING',
  'CHARACTER',
];

/**
 * 从 issues 推导 overallStatus。
 *
 * ⚠ 刻意**不信任模型填的 overallStatus**：模型可能一边列出 BLOCKING
 *   一边写 "PASSED"。状态由 issues 机械推导 —— 这样"只有 BLOCKING=0
 *   才能提交"才真的成立，而不是靠模型自觉。
 */
export function deriveStatus(issues: readonly ReviewIssue[]): ReviewStatus {
  if (issues.some((i) => i.severity === 'BLOCKING')) return 'BLOCKED';
  if (issues.some((i) => i.severity === 'MAJOR')) return 'NEEDS_REVISION';
  return 'PASSED';
}

/** 是否允许进入 Commit：唯一条件 BLOCKING = 0 */
export function canProceedToCommit(issues: readonly ReviewIssue[]): boolean {
  return !issues.some((i) => i.severity === 'BLOCKING');
}

/** 按严重度排序（阻塞在前），同级按类别稳定排序，便于比对两次 review */
export function sortIssues(issues: readonly ReviewIssue[]): ReviewIssue[] {
  return [...issues].sort((a, b) => {
    const d = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (d !== 0) return d;
    const c = a.category.localeCompare(b.category);
    if (c !== 0) return c;
    return a.id.localeCompare(b.id);
  });
}

/** 统计（用于 UI 与报告） */
export function summarizeIssues(issues: readonly ReviewIssue[]): {
  total: number;
  bySeverity: Record<ReviewSeverity, number>;
  byCategory: Partial<Record<ReviewCategory, number>>;
} {
  const bySeverity: Record<ReviewSeverity, number> = {
    BLOCKING: 0,
    MAJOR: 0,
    MINOR: 0,
    NOTE: 0,
  };
  const byCategory: Partial<Record<ReviewCategory, number>> = {};
  for (const i of issues) {
    bySeverity[i.severity]++;
    byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
  }
  return { total: issues.length, bySeverity, byCategory };
}

/**
 * 校验类别与依据的匹配（§55 Rule 9 的延伸）。
 *
 * 返回违规项；调用方决定是拒绝整批还是降级。
 * 默认策略是**拒绝整批** —— 部分接受会让"依据"这个概念形同虚设。
 */
export function findEvidenceViolations(
  issues: readonly ReviewIssue[],
): { issueId: string; category: ReviewCategory }[] {
  return issues
    .filter(
      (i) =>
        CATEGORIES_REQUIRING_EVIDENCE.includes(i.category) &&
        i.evidence.length === 0 &&
        i.severity !== 'NOTE',
    )
    .map((i) => ({ issueId: i.id, category: i.category }));
}
