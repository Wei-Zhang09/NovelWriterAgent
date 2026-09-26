/**
 * M7 Diff 验收测试（施工计划指定的验收方式：纯函数可穷举）。
 *
 * ## ⚠ 本测试的核心目的：证明"只改一个词"不会被标成"整段已修改"
 *
 * 那是缺陷 F7 的实际表现：一段 300 字里改一个词，整段标红，
 * 作者看不出改了哪 —— 等于没做 Diff。
 *
 * 所以下面有一条**证伪用例**：把 `diffWords` 退化成"整段标红"
 * （即所有字都标 changed），"只改一词"的断言必须失败。
 * 见文件末尾的反向验证说明。
 */
import { describe, expect, it } from 'vitest';
import {
  CHANGE_KINDS,
  diffParagraphs,
  diffWords,
  splitParagraphs,
  summarizeHunks,
} from '../../apps/desktop/src/renderer/manuscript/diff.js';

describe('splitParagraphs', () => {
  it('按换行切段，空行不算段', () => {
    expect(splitParagraphs('第一段\n\n第二段\n\n\n第三段')).toEqual(['第一段', '第二段', '第三段']);
  });

  it('⚠ 行尾 CR 必须去掉（本仓混用 CRLF/LF）', () => {
    // 不去掉的话，同一段在两个版本里一个带 \r 一个不带，
    // 会被判为"已修改" —— 而内容其实完全一样
    const crlf = '第一段\r\n第二段\r\n';
    const lf = '第一段\n第二段\n';
    expect(splitParagraphs(crlf)).toEqual(splitParagraphs(lf));
    expect(splitParagraphs(crlf)[0]).toBe('第一段');
  });

  it('⚠ 行首行尾空白不影响判等（否则缩进变化会被当成改写）', () => {
    expect(splitParagraphs('  第一段  ')).toEqual(['第一段']);
  });

  it('非字符串输入返回空数组（不抛错）', () => {
    expect(splitParagraphs(null)).toEqual([]);
    expect(splitParagraphs(undefined)).toEqual([]);
  });
});

describe('diffParagraphs —— 三类变更各一例（施工计划要求）', () => {
  it('未改动 → 全部 equal，且不做词级比较（省算力）', () => {
    const hunks = diffParagraphs('甲\n乙\n丙', '甲\n乙\n丙');
    expect(hunks.map((h) => h.kind)).toEqual(['equal', 'equal', 'equal']);
    // ⚠ equal 段不带 words —— 字符级 LCS 不便宜，不该对没变的段做
    expect(hunks.every((h) => h.words === null)).toBe(true);
  });

  it('新增一段 → insert，且 oldIndex 为 null（该侧无对应段）', () => {
    const hunks = diffParagraphs('甲\n丙', '甲\n乙\n丙');
    const kinds = hunks.map((h) => h.kind);
    expect(kinds).toContain('insert');
    const ins = hunks.find((h) => h.kind === 'insert');
    expect(ins.newText).toBe('乙');
    // ⚠ oldIndex 必须是 null 而不是随便给个数字 ——
    //   界面据此决定"这一侧留不留空位"，给错索引会错位
    expect(ins.oldIndex).toBeNull();
    expect(ins.newIndex).toBe(1);
  });

  it('删除一段 → delete，且 newIndex 为 null', () => {
    const hunks = diffParagraphs('甲\n乙\n丙', '甲\n丙');
    const del = hunks.find((h) => h.kind === 'delete');
    expect(del).toBeTruthy();
    expect(del.oldText).toBe('乙');
    expect(del.newIndex).toBeNull();
  });

  it('改写一段 → modify（不是"删一段 + 加一段"）', () => {
    const hunks = diffParagraphs('甲\n乙\n丙', '甲\n乙改\n丙');
    // ⚠ 作者的直觉是"我改了这一段"；显示成删+增会让他以为段落顺序变了
    expect(hunks.map((h) => h.kind)).toEqual(['equal', 'modify', 'equal']);
    const mod = hunks[1];
    expect(mod.oldText).toBe('乙');
    expect(mod.newText).toBe('乙改');
    expect(mod.words).not.toBeNull();
  });

  it('⚠ 只改一个词：段内词级必须精确定位，而不是整段标红（F7）', () => {
    const oldP = '他推开拳馆那扇掉漆的木门，闻到一股汗味。';
    const newP = '他推开拳馆那扇破旧的木门，闻到一股汗味。';
    const hunks = diffParagraphs(oldP, newP);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].kind).toBe('modify');

    const { left, right } = hunks[0].words;

    // ⚠ 这是本条用例的**核心**：变化的片段必须远小于整段。
    //   若实现退化成"整段标红"，下面这条会失败。
    const changedLen = (segs) => segs.filter((s) => s.changed).reduce((n, s) => n + s.text.length, 0);
    expect(changedLen(left)).toBeLessThan(oldP.length / 3);
    expect(changedLen(right)).toBeLessThan(newP.length / 3);

    // 且变化内容确实是那处
    expect(left.filter((s) => s.changed).map((s) => s.text).join('')).toBe('掉漆');
    expect(right.filter((s) => s.changed).map((s) => s.text).join('')).toBe('破旧');

    // 未变的部分必须保留（否则界面无法显示上下文）
    expect(left.filter((s) => !s.changed).map((s) => s.text).join('')).toBe(
      '他推开拳馆那扇的木门，闻到一股汗味。',
    );
  });

  it('⚠ 插入一段后，后面的段落必须仍然对齐（按序号对齐会全盘错位）', () => {
    // 这是"为什么用 LCS 而不是按序号"的证伪用例
    const oldText = ['第一段', '第二段', '第三段', '第四段', '第五段'].join('\n');
    const newText = ['第一段', '插入的新段', '第二段', '第三段', '第四段', '第五段'].join('\n');
    const hunks = diffParagraphs(oldText, newText);

    const kinds = hunks.map((h) => h.kind);
    expect(kinds).toEqual(['equal', 'insert', 'equal', 'equal', 'equal', 'equal']);

    // ⚠ 关键：后面四段必须是 equal。按序号对齐的话它们全会被标成 modify
    expect(kinds.filter((k) => k === 'modify')).toHaveLength(0);
    expect(summarizeHunks(hunks).changed).toBe(1);
  });

  it('空 → 有内容：全是 insert', () => {
    const hunks = diffParagraphs('', '甲\n乙');
    expect(hunks.map((h) => h.kind)).toEqual(['insert', 'insert']);
  });

  it('有内容 → 空：全是 delete', () => {
    const hunks = diffParagraphs('甲\n乙', '');
    expect(hunks.map((h) => h.kind)).toEqual(['delete', 'delete']);
  });

  it('两边都空：零个 hunk（不是报错）', () => {
    expect(diffParagraphs('', '')).toEqual([]);
  });

  it('多段同时增删改 —— 结构仍自洽', () => {
    const oldText = ['一', '二', '三', '四', '五'].join('\n');
    const newText = ['一', '二改', '新插入', '四', '五'].join('\n');
    const hunks = diffParagraphs(oldText, newText);
    const s = summarizeHunks(hunks);
    expect(s.modify).toBe(1);
    expect(s.insert).toBe(1);
    expect(s.delete).toBe(1);
    expect(s.changed).toBe(3);
    // 每个 hunk 的 kind 必须是闭集内的值（防止拼错字符串悄悄漏过）
    expect(hunks.every((h) => CHANGE_KINDS.includes(h.kind))).toBe(true);
  });

  it('⚠ 每段至少被覆盖一次：oldIndex / newIndex 集合不丢段', () => {
    const oldText = ['一', '二', '三'].join('\n');
    const newText = ['一', '三', '四'].join('\n');
    const hunks = diffParagraphs(oldText, newText);

    const coveredOld = hunks.filter((h) => h.oldIndex !== null).map((h) => h.oldIndex).sort();
    const coveredNew = hunks.filter((h) => h.newIndex !== null).map((h) => h.newIndex).sort();
    // 旧版 3 段、新版 3 段都要被覆盖到（不重不漏）
    expect(coveredOld).toEqual([0, 1, 2]);
    expect(coveredNew).toEqual([0, 1, 2]);
  });
});

describe('diffWords', () => {
  it('完全相同 → 全部 not changed', () => {
    const { left, right } = diffWords('一样的内容', '一样的内容');
    expect(left.every((s) => !s.changed)).toBe(true);
    expect(right.every((s) => !s.changed)).toBe(true);
  });

  it('相邻同类型片段会合并（少产出零碎 span）', () => {
    const { left } = diffWords('abc', 'xyz');
    // 三个字都是变化的 → 应合并成一段而不是三段
    expect(left).toHaveLength(1);
    expect(left[0].text).toBe('abc');
    expect(left[0].changed).toBe(true);
  });

  it('纯新增 → 右侧有 changed、左侧为空', () => {
    const { left, right } = diffWords('', '新增内容');
    expect(left).toEqual([]);
    expect(right).toHaveLength(1);
    expect(right[0].changed).toBe(true);
  });

  it('中文按字比较（按空格分词会把整段当成一个词）', () => {
    // 这是"为什么按字符而不是按词"的证伪用例：
    // 按 \s+ 分词的话整段中文是**一个词**，一个字的改动会变成整段替换。
    //
    // ⚠ 注意改动的方向：'他走了' 是 '他跑走了' 的子序列，
    //   所以变化在**右侧**（多了一个「跑」），左侧原样。
    //   第一版把断言写在左侧，得到空串 —— 是断言写错了，不是实现错了。
    const { left, right } = diffWords('他走了', '他跑走了');
    expect(left.filter((s) => s.changed)).toHaveLength(0);

    const changed = right.filter((s) => s.changed).map((s) => s.text).join('');
    expect(changed).toBe('跑');
    // ⚠ 关键：变化片段必须远小于整段（按词分词的话这里是整段 4 个字）
    expect(changed.length).toBeLessThan('他跑走了'.length);
  });

  it('中文替换：两侧都只标出变化的字', () => {
    const { left, right } = diffWords('他慢慢走了', '他慢慢跑远了');
    const lc = left.filter((s) => s.changed).map((s) => s.text).join('');
    const rc = right.filter((s) => s.changed).map((s) => s.text).join('');
    expect(lc).toBe('走');
    expect(rc).toBe('跑远');
    // 共同的前缀「他慢慢」必须保留为未变化
    expect(left[0].changed).toBe(false);
    expect(left[0].text).toContain('他慢慢');
  });
});

describe('summarizeHunks', () => {
  it('changed 不含 equal —— 作者关心的是"改了哪几段"', () => {
    const hunks = diffParagraphs('一\n二\n三', '一\n二改\n三\n四');
    const s = summarizeHunks(hunks);
    expect(s.changed).toBe(s.insert + s.delete + s.modify);
    expect(s.changed).toBe(2);
    expect(s.total).toBe(4);
  });

  it('空输入不抛错', () => {
    expect(summarizeHunks(null).changed).toBe(0);
  });
});
