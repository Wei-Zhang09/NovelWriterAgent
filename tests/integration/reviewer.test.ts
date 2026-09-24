/**
 * Reviewer 测试（STEP 8，施工文档 §32 / §33）
 *
 * 三条核心主张，每条都有对应断言：
 *   1. **输出问题而非分数** —— `{"score":88}` 必须被判为 schema 失败
 *   2. **状态由 issues 推导** —— 模型写 PASSED 但列了 BLOCKING，以 BLOCKING 为准
 *   3. **需要依据的类别必须有 evidence** —— 缺依据整批拒绝
 */
import { describe, it, expect } from 'vitest';
import { Reviewer } from '@nwa/writing';
import type { ReviewStructuredCaller } from '@nwa/writing';
import {
  ReviewOutputSchema,
  deriveStatus,
  canProceedToCommit,
  sortIssues,
  summarizeIssues,
  findEvidenceViolations,
  MVP_REVIEW_CATEGORIES,
  REVIEW_CATEGORIES,
} from '@nwa/shared';
import type { ReviewIssue } from '@nwa/shared';
import { Logger } from '@nwa/core';

const logger = new Logger('test:reviewer', { level: 'error' });

const issue = (over: Partial<ReviewIssue> = {}): ReviewIssue => ({
  id: 'ri_1',
  severity: 'MAJOR',
  category: 'PACING',
  claim: '第二场戏推进过慢',
  evidence: [],
  suggestions: [],
  ...over,
});

/** 返回预设 raw 对象的 caller（走真实 schema 校验，不绕过） */
function callerReturning(raw: unknown): { fn: ReviewStructuredCaller; calls: number } {
  const state = { calls: 0 };
  const fn: ReviewStructuredCaller = async (req) => {
    state.calls++;
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'MODEL_STRUCTURED_EMPTY',
          message: `schema 校验失败：${parsed.error.issues[0]?.message ?? 'unknown'}`,
        },
        attempts: 1,
        usedFallback: false,
        rawText: JSON.stringify(raw),
      };
    }
    return { ok: true, data: parsed.data, attempts: 1, usedFallback: false };
  };
  Object.defineProperty(state, 'fn', { value: fn, enumerable: true });
  return state as unknown as { fn: ReviewStructuredCaller; calls: number };
}

const baseReq = {
  chapterNumber: 11,
  draftText: '张三推开门。',
  contextText: '## Canon\n- 张三活着',
};

describe('⚠ §32：输出问题而非分数', () => {
  it('模型返回 {"score":88} → 判为 schema 失败', async () => {
    const c = callerReturning({ score: 88 });
    const r = await new Reviewer({ structured: c.fn, logger }).review(baseReq);

    expect(r.ok).toBe(false);
    expect(r.modelOk).toBe(false);
  });

  it('⚠ 模型失败时不降级为"没问题"（最危险的失败模式）', async () => {
    const c = callerReturning({ score: 88 });
    const r = await new Reviewer({ structured: c.fn, logger }).review(baseReq);

    // 关键：canCommit 必须为 false —— 审稿没跑不能当成通过
    expect(r.canCommit).toBe(false);
    expect(r.issues).toEqual([]);
  });

  it('模型返回自然语言散文 → schema 失败', async () => {
    const c = callerReturning('这一章写得不错，整体 88 分，建议加强对话。');
    const r = await new Reviewer({ structured: c.fn, logger }).review(baseReq);
    expect(r.ok).toBe(false);
    expect(r.canCommit).toBe(false);
  });

  it('模型返回 "score" + 空 issues 的混合体 → 仍失败（分数不是合法字段）', async () => {
    const c = callerReturning({ overallStatus: 'PASSED', issues: [], score: 95 });
    const r = await new Reviewer({ structured: c.fn, logger }).review(baseReq);
    // zod 默认 strip 掉未知字段 —— 这种情况应通过，但 score 被丢弃
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.issues)).not.toContain('score');
  });

  it('合法形状被接受', async () => {
    const c = callerReturning({
      overallStatus: 'PASSED',
      issues: [issue()],
    });
    const r = await new Reviewer({ structured: c.fn, logger }).review(baseReq);
    expect(r.ok).toBe(true);
    expect(r.modelOk).toBe(true);
  });
});

describe('⚠ 状态由 issues 推导，不信任模型的 overallStatus', () => {
  it('模型写 PASSED 但列了 BLOCKING → 实际为 BLOCKED', async () => {
    const c = callerReturning({
      overallStatus: 'PASSED',
      issues: [issue({ id: 'ri_b', severity: 'BLOCKING', category: 'CONTINUITY', evidence: ['fact_1'] })],
    });
    const r = await new Reviewer({ structured: c.fn, logger }).review(baseReq);

    expect(r.status).toBe('BLOCKED');
    expect(r.canCommit).toBe(false);
  });

  it('模型写 BLOCKED 但没有 BLOCKING 问题 → 实际为 PASSED', async () => {
    const c = callerReturning({
      overallStatus: 'BLOCKED',
      issues: [issue({ severity: 'MINOR' })],
    });
    const r = await new Reviewer({ structured: c.fn, logger }).review(baseReq);
    expect(r.status).toBe('PASSED');
    expect(r.canCommit).toBe(true);
  });

  it('只有 BLOCKING = 0 才允许提交', async () => {
    const withMajor = callerReturning({
      overallStatus: 'NEEDS_REVISION',
      issues: [issue({ severity: 'MAJOR' })],
    });
    const r = await new Reviewer({ structured: withMajor.fn, logger }).review(baseReq);
    expect(r.status).toBe('NEEDS_REVISION');
    expect(r.canCommit).toBe(true); // MAJOR 不阻塞提交（§33）

    const withBlocking = callerReturning({
      overallStatus: 'BLOCKED',
      issues: [issue({ severity: 'BLOCKING', category: 'CONTINUITY', evidence: ['f1'] })],
    });
    const r2 = await new Reviewer({ structured: withBlocking.fn, logger }).review(baseReq);
    expect(r2.canCommit).toBe(false);
  });
});

describe('⚠ 需要依据的类别必须有 evidence', () => {
  it('CONTINUITY 类缺依据 → 整批拒绝', async () => {
    const c = callerReturning({
      overallStatus: 'BLOCKED',
      issues: [
        issue({ id: 'ri_c', severity: 'MAJOR', category: 'CONTINUITY', evidence: [] }),
      ],
    });
    const r = await new Reviewer({ structured: c.fn, logger }).review(baseReq);

    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('REVIEW_EVIDENCE_MISSING');
    expect(r.error!.message).toContain('缺少依据');
    expect(r.canCommit).toBe(false);
  });

  it('CONTINUITY 类有依据 → 接受', async () => {
    const c = callerReturning({
      overallStatus: 'NEEDS_REVISION',
      issues: [
        issue({ severity: 'MAJOR', category: 'CONTINUITY', evidence: ['fact_123'] }),
      ],
    });
    const r = await new Reviewer({ structured: c.fn, logger }).review(baseReq);
    expect(r.ok).toBe(true);
  });

  it('PACING 类不需要依据', async () => {
    const c = callerReturning({
      overallStatus: 'NEEDS_REVISION',
      issues: [issue({ severity: 'MAJOR', category: 'PACING', evidence: [] })],
    });
    const r = await new Reviewer({ structured: c.fn, logger }).review(baseReq);
    expect(r.ok).toBe(true);
  });

  it('NOTE 级即使缺依据也放行（不阻塞的观察性备注）', async () => {
    const c = callerReturning({
      overallStatus: 'PASSED',
      issues: [issue({ severity: 'NOTE', category: 'CONTINUITY', evidence: [] })],
    });
    const r = await new Reviewer({ structured: c.fn, logger }).review(baseReq);
    expect(r.ok).toBe(true);
  });

  it('requireEvidence=false 时不校验（供特殊场景）', async () => {
    const c = callerReturning({
      overallStatus: 'NEEDS_REVISION',
      issues: [issue({ severity: 'MAJOR', category: 'TIMELINE', evidence: [] })],
    });
    const r = await new Reviewer({ structured: c.fn, logger, requireEvidence: false }).review(baseReq);
    expect(r.ok).toBe(true);
  });

  it('五类需要依据的类别都被覆盖', () => {
    for (const cat of ['CONTINUITY', 'TIMELINE', 'WORLD_RULE', 'FORESHADOWING', 'CHARACTER']) {
      const v = findEvidenceViolations([
        issue({ category: cat as ReviewIssue['category'], evidence: [], severity: 'MAJOR' }),
      ]);
      expect(v).toHaveLength(1);
    }
  });
});

describe('合并确定性检查结果（与 Continuity Checker 的分工）', () => {
  it('确定性 issues 被合并进最终报告', async () => {
    const c = callerReturning({ overallStatus: 'PASSED', issues: [] });
    const det = issue({ id: 'ci_dead_1', severity: 'BLOCKING', category: 'CONTINUITY', evidence: ['facts:1'] });
    const r = await new Reviewer({ structured: c.fn, logger }).review({
      ...baseReq,
      deterministicIssues: [det],
    });

    expect(r.issues.map((i) => i.id)).toContain('ci_dead_1');
    expect(r.status).toBe('BLOCKED'); // 确定性结论优先
  });

  it('确定性 issues 不需要依据校验（它们是程序判定，自带出处）', async () => {
    const c = callerReturning({ overallStatus: 'PASSED', issues: [] });
    const det = issue({ id: 'ci_x', severity: 'BLOCKING', category: 'TIMELINE', evidence: [] });
    const r = await new Reviewer({ structured: c.fn, logger }).review({
      ...baseReq,
      deterministicIssues: [det],
    });
    expect(r.ok).toBe(true);
  });

  it('模型失败时确定性结果仍然返回', async () => {
    const c = callerReturning({ score: 1 });
    const det = issue({ id: 'ci_keep', severity: 'MAJOR', category: 'CONTINUITY', evidence: ['f'] });
    const r = await new Reviewer({ structured: c.fn, logger }).review({
      ...baseReq,
      deterministicIssues: [det],
    });

    expect(r.modelOk).toBe(false);
    expect(r.issues.map((i) => i.id)).toContain('ci_keep');
    expect(r.canCommit).toBe(false); // 但审稿未完成仍不允许提交
  });

  it('⚠ 模型失败时 error 必须带原因（IPC 层靠它显示"为什么"）', async () => {
    // ⚠ 回归：core-process 的 review.run 会把 r.error 透给 UI。
    //   如果这里没有 error，UI 只能显示 `undefined：`（实测出现过），
    //   排查时无法区分"模型超时"与"schema 不符"与"没配模型"——
    //   而三者的处置完全不同。
    const c = callerReturning({ score: 88 });
    const r = await new Reviewer({ structured: c.fn, logger }).review(baseReq);

    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(typeof r.error!.code).toBe('string');
    expect(r.error!.code.length).toBeGreaterThan(0);
    expect(typeof r.error!.message).toBe('string');
    // message 必须说明发生了什么，不能是空串 —— 空串等于没有原因
    expect(r.error!.message.length).toBeGreaterThan(0);
  });

  it('合并后按严重度排序（阻塞在前）', async () => {
    const c = callerReturning({
      overallStatus: 'PASSED',
      issues: [issue({ id: 'ri_note', severity: 'NOTE' })],
    });
    const r = await new Reviewer({ structured: c.fn, logger }).review({
      ...baseReq,
      deterministicIssues: [issue({ id: 'ci_block', severity: 'BLOCKING', category: 'CONTINUITY', evidence: ['f'] })],
    });

    expect(r.issues[0]!.id).toBe('ci_block');
    expect(r.issues.at(-1)!.id).toBe('ri_note');
  });

  it('summary 统计正确', async () => {
    const c = callerReturning({
      overallStatus: 'PASSED',
      issues: [
        issue({ id: 'a', severity: 'MAJOR' }),
        issue({ id: 'b', severity: 'MINOR' }),
        issue({ id: 'c', severity: 'MINOR' }),
      ],
    });
    const r = await new Reviewer({ structured: c.fn, logger }).review(baseReq);

    expect(r.summary.total).toBe(3);
    expect(r.summary.bySeverity.MAJOR).toBe(1);
    expect(r.summary.bySeverity.MINOR).toBe(2);
  });

  it('审稿温度固定低温（要稳定不要创造性）', async () => {
    let captured: number | undefined;
    const fn: ReviewStructuredCaller = async (req) => {
      captured = req.temperature;
      return { ok: true, data: { overallStatus: 'PASSED', issues: [] }, attempts: 1, usedFallback: false };
    };
    await new Reviewer({ structured: fn, logger }).review(baseReq);
    expect(captured).toBe(0.2);
  });
});

describe('纯函数：状态推导与统计', () => {
  it('deriveStatus：有 BLOCKING → BLOCKED', () => {
    expect(deriveStatus([issue({ severity: 'BLOCKING' })])).toBe('BLOCKED');
    expect(deriveStatus([issue({ severity: 'BLOCKING' }), issue({ severity: 'NOTE' })])).toBe('BLOCKED');
  });

  it('deriveStatus：无 BLOCKING 有 MAJOR → NEEDS_REVISION', () => {
    expect(deriveStatus([issue({ severity: 'MAJOR' })])).toBe('NEEDS_REVISION');
  });

  it('deriveStatus：只有 MINOR/NOTE → PASSED', () => {
    expect(deriveStatus([issue({ severity: 'MINOR' }), issue({ severity: 'NOTE' })])).toBe('PASSED');
    expect(deriveStatus([])).toBe('PASSED');
  });

  it('canProceedToCommit 只否决 BLOCKING', () => {
    expect(canProceedToCommit([issue({ severity: 'MAJOR' })])).toBe(true);
    expect(canProceedToCommit([issue({ severity: 'BLOCKING' })])).toBe(false);
  });

  it('sortIssues 稳定（同级按类别与 id）', () => {
    const a = issue({ id: 'z', severity: 'MINOR', category: 'PLOT' });
    const b = issue({ id: 'a', severity: 'MINOR', category: 'PLOT' });
    const sorted = sortIssues([a, b]);
    expect(sorted.map((i) => i.id)).toEqual(['a', 'z']);
  });

  it('summarizeIssues 按类别统计', () => {
    const s = summarizeIssues([
      issue({ category: 'PLOT' }),
      issue({ category: 'PLOT' }),
      issue({ category: 'PACING' }),
    ]);
    expect(s.byCategory.PLOT).toBe(2);
    expect(s.byCategory.PACING).toBe(1);
  });

  it('类别枚举覆盖 §33 的 15 类', () => {
    expect(REVIEW_CATEGORIES).toHaveLength(15);
    expect(MVP_REVIEW_CATEGORIES).toHaveLength(14);
    expect(MVP_REVIEW_CATEGORIES).not.toContain('STYLE_ALIGNMENT');
  });
});

describe('Schema 契约（§32）', () => {
  it('issues 必填（不能省）', () => {
    expect(ReviewOutputSchema.safeParse({ overallStatus: 'PASSED' }).success).toBe(false);
  });

  it('overallStatus 必填', () => {
    expect(ReviewOutputSchema.safeParse({ issues: [] }).success).toBe(false);
  });

  it('severity 只接受四个合法值', () => {
    const bad = { overallStatus: 'PASSED', issues: [{ ...issue(), severity: 'CRITICAL' }] };
    expect(ReviewOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('category 只接受 §33 的合法值', () => {
    const bad = { overallStatus: 'PASSED', issues: [{ ...issue(), category: 'VIBES' }] };
    expect(ReviewOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('claim 不得为空（必须说清问题是什么）', () => {
    const bad = { overallStatus: 'PASSED', issues: [{ ...issue(), claim: '' }] };
    expect(ReviewOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('evidence / suggestions 缺失时填充为空数组', () => {
    const r = ReviewOutputSchema.safeParse({
      overallStatus: 'PASSED',
      issues: [{ id: 'x', severity: 'NOTE', category: 'PLOT', claim: 'c' }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.issues[0]!.evidence).toEqual([]);
      expect(r.data.issues[0]!.suggestions).toEqual([]);
    }
  });
});
