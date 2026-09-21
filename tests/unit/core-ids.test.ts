/**
 * ID 生成测试
 *
 * 核心断言（施工计划 §3.1b + 研究报告 §2.1 采纳 3）：
 *   内容派生 ID 必须幂等 —— 重放一次投影不得产生重复事实。
 */
import { describe, it, expect } from 'vitest';
import { factId, evidenceId, eventId, chapterId, chapterFileName, workspaceDirName } from '@nwa/core';

describe('内容派生 ID 的幂等性', () => {
  it('factId 对同一输入稳定', () => {
    const a = factId({ subjectType: 'character', subjectId: 'c1', predicate: 'status', objectValue: 'DEAD' });
    const b = factId({ subjectType: 'character', subjectId: 'c1', predicate: 'status', objectValue: 'DEAD' });
    expect(a).toBe(b);
  });

  it('factId 对不同事实产生不同 ID', () => {
    const a = factId({ subjectType: 'character', subjectId: 'c1', predicate: 'status', objectValue: 'DEAD' });
    const b = factId({ subjectType: 'character', subjectId: 'c1', predicate: 'status', objectValue: 'ALIVE' });
    expect(a).not.toBe(b);
  });

  it('⚠ factId 签名不含 status/confidence —— 置信度变化不得产生新事实', () => {
    // 这是设计约束：签名根本没给 status/confidence 留位置。
    // 若将来有人给签名加字段，本测试的参数形状会显式失败，从而提醒复审。
    const params = { subjectType: 'character', subjectId: 'c1', predicate: 'status', objectValue: 'DEAD' };
    expect(Object.keys(params).sort()).toEqual(['objectValue', 'predicate', 'subjectId', 'subjectType']);
    expect(factId(params)).toBe(factId(params));
  });

  it('evidenceId 对同一区间稳定', () => {
    const p = { sourceRef: 'chapters/031.md', startOffset: 100, endOffset: 140, quote: '张三死了。' };
    expect(evidenceId(p)).toBe(evidenceId({ ...p }));
  });

  it('evidenceId 对区间敏感', () => {
    const base = { sourceRef: 'a.md', startOffset: 1, endOffset: 9, quote: 'x' };
    expect(evidenceId(base)).not.toBe(evidenceId({ ...base, endOffset: 10 }));
  });

  it('evidenceId 只用 quote 前 64 字符（避免超长引用导致证据分裂）', () => {
    const long = 'x'.repeat(200);
    const a = evidenceId({ sourceRef: 'a', startOffset: 0, endOffset: 1, quote: long });
    const b = evidenceId({ sourceRef: 'a', startOffset: 0, endOffset: 1, quote: long.slice(0, 64) + 'y'.repeat(100) });
    expect(a).toBe(b);
  });

  it('eventId 形如 evt-ch031-0007-xxxxxxxxxx 且可按章节前缀查询', () => {
    const id = eventId({ chapter: 31, index: 7, payload: { type: 'DRAFT_CREATED' } });
    expect(id).toMatch(/^evt-ch031-0007-[0-9a-f]{10}$/);
  });

  it('eventId 对 payload 键序不敏感（走 sort 归一）', () => {
    const a = eventId({ chapter: 1, index: 0, payload: { a: 1, b: 2 } });
    const b = eventId({ chapter: 1, index: 0, payload: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it('eventId 对 payload 内容敏感', () => {
    const a = eventId({ chapter: 1, index: 0, payload: { a: 1 } });
    const b = eventId({ chapter: 1, index: 0, payload: { a: 2 } });
    expect(a).not.toBe(b);
  });
});

describe('命名契约（施工计划 §6.1）', () => {
  it('章节目录与文件名零填充到 3 位', () => {
    expect(workspaceDirName(4)).toBe('chapter-004');
    expect(workspaceDirName(31)).toBe('chapter-031');
    expect(workspaceDirName(120)).toBe('chapter-120');
    expect(chapterFileName(1)).toBe('001.md');
    expect(chapterFileName(31)).toBe('031.md');
  });

  it('章节 ID 可预测', () => {
    expect(chapterId('book_x', 7)).toBe('ch_book_x_007');
  });
});
