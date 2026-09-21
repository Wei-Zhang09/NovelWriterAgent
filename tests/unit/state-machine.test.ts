/**
 * 状态机测试（STEP 4 验收）
 *
 * 施工文档 §8.2：**状态迁移必须由代码执行**。
 * 这里穷举验证：合法路径放行、非法路径拦截、异常态语义正确。
 */
import { describe, it, expect } from 'vitest';
import { canTransition, assertTransition, allowedTargets, isTerminal, isAbnormal } from '@nwa/harness';
import { AppError } from '@nwa/core';
import type { ChapterStatus } from '@nwa/shared';

const t = (from: ChapterStatus, to: ChapterStatus, extra = {}) =>
  canTransition({ from, to, reason: 'test', ...extra });

describe('正常路径（施工文档 §8.1）', () => {
  const happyPath: [ChapterStatus, ChapterStatus][] = [
    ['DRAFT', 'PLANNING'],
    ['PLANNING', 'CONTEXT_READY'],
    ['CONTEXT_READY', 'WRITING'],
    ['WRITING', 'DRAFT_READY'],
    ['DRAFT_READY', 'REVIEWING'],
    ['REVIEWING', 'REVIEW_READY'],
    ['REVIEW_READY', 'REVISING'],
    ['REVISING', 'REVISION_READY'],
    ['REVISION_READY', 'CONTINUITY_CHECKING'],
    ['CONTINUITY_CHECKING', 'READY_TO_COMMIT'],
    ['READY_TO_COMMIT', 'COMMITTING'],
    ['COMMITTING', 'COMMITTED'],
  ];

  for (const [from, to] of happyPath) {
    it(`${from} → ${to} 允许`, () => {
      expect(t(from, to).allowed).toBe(true);
    });
  }

  it('REVIEW_READY 也可直接进一致性检查（无待修订项）', () => {
    expect(t('REVIEW_READY', 'CONTINUITY_CHECKING').allowed).toBe(true);
  });

  it('CONTINUITY_CHECKING 可退回 REVISING（发现一致性问题）', () => {
    expect(t('CONTINUITY_CHECKING', 'REVISING').allowed).toBe(true);
  });

  it('COMMITTED 可重开为 PLANNING（人工操作）', () => {
    expect(t('COMMITTED', 'PLANNING').allowed).toBe(true);
  });
});

describe('⚠ 非法迁移必须被拦截', () => {
  it('不能跳过规划直接写作', () => {
    const d = t('DRAFT', 'WRITING');
    expect(d.allowed).toBe(false);
    expect(d.message).toMatch(/非法状态迁移/);
    expect(d.details).toMatchObject({ from: 'DRAFT', to: 'WRITING' });
  });

  it('不能跳过审稿直接提交', () => {
    expect(t('DRAFT_READY', 'READY_TO_COMMIT').allowed).toBe(false);
  });

  it('不能从 DRAFT_READY 直接提交', () => {
    expect(t('DRAFT_READY', 'COMMITTING').allowed).toBe(false);
  });

  it('不能从 COMMITTING 回退到 READY_TO_COMMIT（提交中不可逆）', () => {
    expect(t('COMMITTING', 'READY_TO_COMMIT').allowed).toBe(false);
  });

  it('同状态迁移视为无操作', () => {
    const d = t('WRITING', 'WRITING');
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('NO_OP');
  });

  it('报错信息里列出该状态的所有合法目标（便于排查）', () => {
    const d = t('WRITING', 'COMMITTED');
    expect((d.details as { allowedFromHere: string[] }).allowedFromHere).toEqual(['DRAFT_READY']);
  });
});

describe('异常态语义', () => {
  it('任何正常状态都可暂停', () => {
    for (const s of ['DRAFT', 'WRITING', 'REVIEWING', 'READY_TO_COMMIT'] as ChapterStatus[]) {
      expect(t(s, 'PAUSED').allowed).toBe(true);
    }
  });

  it('任何状态都可失败', () => {
    expect(t('WRITING', 'FAILED').allowed).toBe(true);
    expect(t('COMMITTED', 'FAILED').allowed).toBe(true);
  });

  it('⚠ PAUSED 只能迁移到 RESUMING（不能直接跳回原状态）', () => {
    const d = t('PAUSED', 'WRITING');
    expect(d.allowed).toBe(false);
    expect(d.message).toMatch(/PAUSED 只能迁移到 RESUMING/);
  });

  it('RESUMING 可回到正常状态', () => {
    expect(t('RESUMING', 'WRITING').allowed).toBe(true);
    expect(t('RESUMING', 'REVIEWING').allowed).toBe(true);
  });

  it('RESUMING 不能回到异常态（避免恢复中再暂停的歧义）', () => {
    expect(t('RESUMING', 'ROLLING_BACK').allowed).toBe(false);
  });

  it('⚠ FAILED 是人工介入态，不接受自动迁移', () => {
    const d = t('FAILED', 'WRITING');
    expect(d.allowed).toBe(false);
    expect(d.message).toMatch(/人工介入态/);
  });

  it('FAILED 也不能被暂停（已需人工处理）', () => {
    expect(t('FAILED', 'PAUSED').allowed).toBe(false);
  });

  it('ROLLING_BACK 同样不接受自动迁移', () => {
    expect(t('ROLLING_BACK', 'DRAFT').allowed).toBe(false);
  });

  it('RETRYING 可回到正常态或失败', () => {
    expect(t('RETRYING', 'WRITING').allowed).toBe(true);
    expect(t('RETRYING', 'FAILED').allowed).toBe(true);
  });
});

describe('前置条件（§8.2 的系统校验）', () => {
  it('前置条件未满足时拒绝合法迁移', () => {
    const d = canTransition({
      from: 'DRAFT_READY',
      to: 'REVIEWING',
      reason: '开始审稿',
      preconditionsMet: false,
      missingPreconditions: ['draft.md 不存在'],
    });
    expect(d.allowed).toBe(false);
    expect(d.message).toMatch(/前置条件未满足/);
    expect((d.details as { missing: string[] }).missing).toEqual(['draft.md 不存在']);
  });

  it('未传前置条件时不拦截（调用方明确表示不关心）', () => {
    expect(t('DRAFT_READY', 'REVIEWING').allowed).toBe(true);
  });
});

describe('assertTransition', () => {
  it('合法时静默通过', () => {
    expect(() => assertTransition({ from: 'DRAFT', to: 'PLANNING', reason: 'r' })).not.toThrow();
  });

  it('非法时抛 AppError 且带完整上下文', () => {
    let err: unknown;
    try {
      assertTransition({ from: 'DRAFT', to: 'COMMITTED', reason: '想直接提交' });
    } catch (e) {
      err = e;
    }
    expect(AppError.isAppError(err)).toBe(true);
    if (AppError.isAppError(err)) {
      expect(err.details).toMatchObject({ from: 'DRAFT', to: 'COMMITTED', reason: '想直接提交' });
    }
  });
});

describe('辅助判定', () => {
  it('allowedTargets 供 UI 只显示可点按钮', () => {
    expect(allowedTargets('DRAFT')).toContain('PLANNING');
    expect(allowedTargets('DRAFT')).toContain('PAUSED');
    expect(allowedTargets('PAUSED')).toEqual(['RESUMING']);
    expect(allowedTargets('FAILED')).toEqual([]);
  });

  it('isTerminal 只认 COMMITTED', () => {
    expect(isTerminal('COMMITTED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(false);
  });

  it('isAbnormal 覆盖四个异常态', () => {
    for (const s of ['PAUSED', 'FAILED', 'RETRYING', 'ROLLING_BACK'] as ChapterStatus[]) {
      expect(isAbnormal(s)).toBe(true);
    }
    expect(isAbnormal('WRITING')).toBe(false);
  });
});
