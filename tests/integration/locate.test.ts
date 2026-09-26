/**
 * M8 定位算法测试。
 *
 * ⚠ 施工计划点名的证伪测试：「故意把 offset 改错 → 断言 fallback 到
 *   excerpt 仍能定位」。这条在本文件里是 `offset 漂移` 那组 ——
 *   它是 M8 的核心价值：offset 会漂（模型改写标点、多打空格），
 *   没有回落就等于"审阅结论点不动"或"点错地方"。
 */
import { describe, expect, it } from 'vitest';
import { locateIssue, paragraphRange, paragraphRanges } from '../../apps/desktop/src/renderer/manuscript/locate.js';

const TEXT = ['雨落在青石板上。', '', '他没有回头，只是把伞收了起来。', '', '屋里没有人。'].join('\n');

describe('paragraphRanges / paragraphRange', () => {
  it('按空行分段，段号从 1 起', () => {
    const rs = paragraphRanges(TEXT);
    expect(rs).toHaveLength(3);
    expect(TEXT.slice(rs[0].start, rs[0].end)).toBe('雨落在青石板上。');
    expect(TEXT.slice(rs[2].start, rs[2].end)).toBe('屋里没有人。');
  });

  it('第 1 段不是第 0 段（段号差一是最常见的错）', () => {
    const r1 = paragraphRange(TEXT, 1);
    expect(TEXT.slice(r1.start, r1.end)).toBe('雨落在青石板上。');
  });

  it('越界段号返回 null', () => {
    expect(paragraphRange(TEXT, 99)).toBeNull();
    expect(paragraphRange(TEXT, 0)).toBeNull();
    expect(paragraphRange(TEXT, -1)).toBeNull();
  });

  it('空文本返回空数组（不抛错）', () => {
    expect(paragraphRanges('')).toEqual([]);
    expect(paragraphRanges(null)).toEqual([]);
    expect(paragraphRange('', 1)).toBeNull();
  });

  it('⚠ 多个连续空行只算一个分隔（不会切出空段）', () => {
    const rs = paragraphRanges('第一段。\n\n\n\n第二段。');
    expect(rs).toHaveLength(2);
  });

  it('⚠ 只有空白字符的行也算分隔', () => {
    const rs = paragraphRanges('第一段。\n   \n第二段。');
    expect(rs).toHaveLength(2);
  });
});

describe('① offset 精确命中', () => {
  it('offset 与 excerpt 一致时按 offset 定位', () => {
    const r = locateIssue(TEXT, { paragraph: 2, offset: 3, excerpt: '回头' });
    expect(r.via).toBe('offset');
    expect(r.drift).toBe(false);
    expect(TEXT.slice(r.start, r.end)).toBe('回头');
  });

  it('段首 offset=0 是合法位置', () => {
    const r = locateIssue(TEXT, { paragraph: 1, offset: 0, excerpt: '雨落' });
    expect(r.via).toBe('offset');
    expect(r.start).toBe(0);
    expect(TEXT.slice(r.start, r.end)).toBe('雨落');
  });

  it('⚠ 没有 excerpt 时仍按 offset 定位（无法校验但如实返回）', () => {
    const r = locateIssue(TEXT, { paragraph: 1, offset: 0 });
    expect(r.via).toBe('offset');
    expect(r.start).toBe(0);
  });
});

describe('⚠⚠ ② offset 漂移 → 回落到 excerpt（施工计划点名的证伪测试）', () => {
  it('offset 指错位置时，回落到 excerpt 找到正确位置', () => {
    // offset=6 处是"回头"，但 excerpt 说的是"伞收了起来"（在第 2 段后部）
    const r = locateIssue(TEXT, { paragraph: 2, offset: 0, excerpt: '把伞收了起来' });
    expect(r.via).toBe('excerpt');
    expect(r.drift).toBe(true);
    expect(TEXT.slice(r.start, r.end)).toBe('把伞收了起来');
  });

  it('⚠ 漂移时**不能**返回 offset 指的位置（否则高亮到无关文字）', () => {
    const wrong = locateIssue(TEXT, { paragraph: 2, offset: 0, excerpt: '把伞收了起来' });
    const atOffset = paragraphRange(TEXT, 2).start + 0;
    expect(wrong.start).not.toBe(atOffset);
  });

  it('offset 越出该段范围时回落', () => {
    const r = locateIssue(TEXT, { paragraph: 1, offset: 999, excerpt: '雨落' });
    expect(r.via).toBe('excerpt');
    expect(TEXT.slice(r.start, r.end)).toBe('雨落');
  });

  it('没有 paragraph 时 offset 无从解析，直接走 excerpt', () => {
    const r = locateIssue(TEXT, { offset: 3, excerpt: '屋里没有人' });
    expect(r.via).toBe('excerpt');
    expect(TEXT.slice(r.start, r.end)).toBe('屋里没有人');
  });
});

describe('② excerpt 搜索', () => {
  it('同一句出现两次时，优先取**所在段**内的那一个', () => {
    // ⚠ 段号必须数清楚：'a', '', 'b' 是**两段**（空行只做分隔，不产生段）。
    //   我第一版把它当成 5 段，测试挂了但实现是对的 ——
    //   与 M10 移植那次同一类错误（断言写错而非实现错）。
    const t = ['他没有回头。', '', '她喊了一声。', '', '她还是说，他没有回头。'].join('\n');
    expect(paragraphRanges(t)).toHaveLength(3);
    const r = locateIssue(t, { paragraph: 3, excerpt: '他没有回头' });
    expect(r.via).toBe('excerpt');
    // 第 3 段内的那次命中（而不是第 1 段那次）
    const p3 = paragraphRange(t, 3);
    expect(p3).not.toBeNull();
    expect(r.start).toBeGreaterThanOrEqual(p3.start);
    expect(r.start).toBeLessThanOrEqual(p3.end);
    // ⚠ 必须不是第一处（否则就是"取第一个命中"的老行为）
    expect(r.start).not.toBe(0);
  });

  it('⚠ 没有 paragraph 提示时取第一处（并如实报告）', () => {
    const t = ['他没有回头。', '', '他没有回头。'].join('\n');
    const r = locateIssue(t, { excerpt: '他没有回头' });
    expect(r.via).toBe('excerpt');
    expect(r.start).toBe(0);
  });

  it('excerpt 不存在于正文时继续往下回落', () => {
    const r = locateIssue(TEXT, { paragraph: 3, excerpt: '这句话正文里没有' });
    expect(r.via).toBe('paragraph');
  });
});

describe('③ 回落到段落开头', () => {
  it('只有 paragraph 时定位到整段', () => {
    const r = locateIssue(TEXT, { paragraph: 3 });
    expect(r.via).toBe('paragraph');
    expect(TEXT.slice(r.start, r.end)).toBe('屋里没有人。');
  });

  it('⚠ via 如实标出"只到段落"，不谎报精确定位', () => {
    const r = locateIssue(TEXT, { paragraph: 3 });
    expect(r.via).not.toBe('offset');
    expect(r.via).not.toBe('excerpt');
  });
});

describe('定位失败', () => {
  it('没有任何定位信息时返回 null（不返回 0）', () => {
    // ⚠ 返回 0 会让"定位失败"显示成"高亮第一句" —— 作者会以为
    //   Issue 说的是第一段，实际只是没定位上。
    expect(locateIssue(TEXT, {})).toBeNull();
    expect(locateIssue(TEXT, null)).toBeNull();
    expect(locateIssue(TEXT, undefined)).toBeNull();
  });

  it('段落越界且无 excerpt 时返回 null', () => {
    expect(locateIssue(TEXT, { paragraph: 99 })).toBeNull();
  });

  it('空正文返回 null', () => {
    expect(locateIssue('', { paragraph: 1 })).toBeNull();
  });

  it('⚠ 定位到段首时 start 可以是 0（合法），与"失败"必须能区分', () => {
    const ok = locateIssue(TEXT, { paragraph: 1 });
    expect(ok).not.toBeNull();
    expect(ok.start).toBe(0);
    // 失败是 null，成功是对象 —— 两者类型不同，调用方不可能混
    expect(locateIssue(TEXT, {})).toBeNull();
  });
});
