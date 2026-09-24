/**
 * 每章字数目标（P2-1）
 *
 * ## 用户决策（2026-09-25）
 *
 *   「章节字数设定，可以在合理范围之内上下浮动」
 *   「允许浮动，但偏离超阈值时提示我（不阻断）」
 *
 * ## 这套测试要钉住什么
 *
 * 核心不是"字数算得对"（那是算术），而是**它不会阻断写作**：
 *
 *   1. 偏离**永远**是 NOTE 级，绝不是 BLOCKING —— 硬卡字数会激励模型
 *      为凑数注水（ADR-0007 / naturalness 一直在防的事）。
 *   2. 未设定目标时**不提示** —— 用默认值算出的偏离是"系统猜的"，
 *      拿去提醒作者像无故指责。
 *   3. 目标随 book 隔离 —— 多书隔离是硬要求，A 书的目标不得影响 B 书。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_WORD_TOLERANCE_PCT,
  assertValidWordTarget,
  checkWordCountDeviation,
  perSceneWords,
} from '@nwa/core';
import { Database, createRepositories, MIGRATIONS } from '@nwa/storage';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'nwa-word-target-'));
}

function setup() {
  const dir = tmp();
  const db = new Database({ path: join(dir, 'p.db'), migrations: MIGRATIONS });
  const repos = createRepositories(db);
  const project = repos.projects.create({ id: 'prj1', name: '测试项目' });
  const book = repos.books.create({ id: 'bk1', projectId: project.id, title: '书一' });
  return { dir, db, repos, book };
}

describe('偏离计算：只描述，不阻断', () => {
  it('在容忍区间内 → OK', () => {
    const d = checkWordCountDeviation(2500, 2500, 40);
    expect(d.withinTolerance).toBe(true);
    expect(d.direction).toBe('OK');
    expect(d.lowerBound).toBe(1500);
    expect(d.upperBound).toBe(3500);
  });

  it('边界值算通过（下界/上界本身属于可接受）', () => {
    expect(checkWordCountDeviation(1500, 2500, 40).withinTolerance).toBe(true);
    expect(checkWordCountDeviation(3500, 2500, 40).withinTolerance).toBe(true);
    // 越界一丁点就算偏离
    expect(checkWordCountDeviation(1499, 2500, 40).direction).toBe('UNDER');
    expect(checkWordCountDeviation(3501, 2500, 40).direction).toBe('OVER');
  });

  it('偏少 → UNDER，且提示里带具体差值', () => {
    const d = checkWordCountDeviation(1200, 2500, 40);
    expect(d.direction).toBe('UNDER');
    expect(d.withinTolerance).toBe(false);
    expect(d.message).toContain('300'); // 1500 - 1200
    expect(d.message).toContain('不影响提交');
  });

  it('偏多 → OVER，且提示里带具体差值', () => {
    const d = checkWordCountDeviation(4200, 2500, 40);
    expect(d.direction).toBe('OVER');
    expect(d.message).toContain('700'); // 4200 - 3500
    expect(d.message).toContain('不影响提交');
  });

  it('⚠ 提示语必须明说"不影响提交"（否则作者会为凑数注水）', () => {
    for (const actual of [100, 9999]) {
      expect(checkWordCountDeviation(actual, 2500, 40).message).toContain('不影响提交');
    }
  });

  it('容忍度为 0 → 只有精确命中才算通过', () => {
    const d = checkWordCountDeviation(2501, 2500, 0);
    expect(d.withinTolerance).toBe(false);
    expect(d.direction).toBe('OVER');
    expect(checkWordCountDeviation(2500, 2500, 0).withinTolerance).toBe(true);
  });

  it('极小目标 + 极窄容忍 → 下界不会变成 0 或负数', () => {
    const d = checkWordCountDeviation(1, 2, 0);
    expect(d.lowerBound).toBeGreaterThanOrEqual(1);
  });
});

describe('输入校验：只对作者手输的错值抛错', () => {
  it('正整数通过', () => {
    expect(() => assertValidWordTarget(2500)).not.toThrow();
    expect(() => assertValidWordTarget(1)).not.toThrow();
  });

  it('0 / 负数 / 小数 / NaN 被拒', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertValidWordTarget(bad)).toThrow(/正整数/);
    }
  });
});

describe('每场景字数换算', () => {
  it('整除', () => {
    expect(perSceneWords(3000, 3)).toBe(1000);
  });

  it('不整除时向下取整', () => {
    expect(perSceneWords(2500, 3)).toBe(833);
  });

  it('⚠ 场景数多于字数时也至少给 1（不能是 0 字）', () => {
    // "每场景 0 字"会让模型无所适从 —— 比给个偏小的数更糟
    expect(perSceneWords(2, 10)).toBe(1);
  });

  it('场景数为 0 时回落到整章目标（防御性）', () => {
    expect(perSceneWords(2500, 0)).toBe(2500);
  });
});

describe('仓储：目标随书隔离', () => {
  it('默认未设定（null），容忍度 40', () => {
    const { db, book } = setup();
    expect(book.target_words_per_chapter).toBeNull();
    expect(book.word_count_tolerance_pct).toBe(DEFAULT_WORD_TOLERANCE_PCT);
    db.close();
  });

  it('设定后可读回', () => {
    const { db, repos, book } = setup();
    const after = repos.books.setWordTarget(book.id, 2500, 30);
    expect(after.target_words_per_chapter).toBe(2500);
    expect(after.word_count_tolerance_pct).toBe(30);
    expect(repos.books.get(book.id).target_words_per_chapter).toBe(2500);
    db.close();
  });

  it('传 null 清除设定（与"没设过"一致）', () => {
    const { db, repos, book } = setup();
    repos.books.setWordTarget(book.id, 2500);
    const cleared = repos.books.setWordTarget(book.id, null);
    expect(cleared.target_words_per_chapter).toBeNull();
    db.close();
  });

  it('不传容忍度时沿用现值（不被静默重置）', () => {
    const { db, repos, book } = setup();
    repos.books.setWordTarget(book.id, 2500, 25);
    const after = repos.books.setWordTarget(book.id, 3000);
    expect(after.word_count_tolerance_pct).toBe(25);
    db.close();
  });

  it('0 / 负数被拒（不是"未设定"，是错误输入）', () => {
    const { db, repos, book } = setup();
    expect(() => repos.books.setWordTarget(book.id, 0)).toThrow(/正整数/);
    expect(() => repos.books.setWordTarget(book.id, -100)).toThrow(/正整数/);
    db.close();
  });

  it('容忍度越界被拒', () => {
    const { db, repos, book } = setup();
    expect(() => repos.books.setWordTarget(book.id, 2500, -1)).toThrow(/0~200/);
    expect(() => repos.books.setWordTarget(book.id, 2500, 201)).toThrow(/0~200/);
    db.close();
  });

  it('⚠ 多书隔离：A 书的目标不影响 B 书', () => {
    const { db, repos, book } = setup();
    const book2 = repos.books.create({
      id: 'bk2',
      projectId: book.project_id,
      title: '书二',
    });
    repos.books.setWordTarget(book.id, 8000, 10);

    expect(repos.books.get(book.id).target_words_per_chapter).toBe(8000);
    // B 书必须保持未设定 —— 否则"给 A 设目标"会污染 B 的篇幅
    expect(repos.books.get(book2.id).target_words_per_chapter).toBeNull();
    expect(repos.books.get(book2.id).word_count_tolerance_pct).toBe(
      DEFAULT_WORD_TOLERANCE_PCT,
    );
    db.close();
  });

  it('⚠ 数据库层也拒绝 0（CHECK 约束，不只靠应用层）', () => {
    const { db, book } = setup();
    // 绕过仓储直接写 —— 应用层校验不是唯一防线
    expect(() =>
      db.run('UPDATE books SET target_words_per_chapter = 0 WHERE id = ?', book.id),
    ).toThrow();
    db.close();
  });
});
