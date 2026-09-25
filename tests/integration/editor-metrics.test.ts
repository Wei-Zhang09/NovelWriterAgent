/**
 * 编辑器文本度量（M4，第二阶段施工单 §二十八 / §二十九）
 *
 * ## 本文件要证伪的核心主张
 *
 * **"编辑器自己数字数就行"** —— 这是 §28 最容易出的实现。
 *
 * 它不会让任何测试失败，只会让作者看到：
 *
 *     编辑器显示   4,328 字
 *     章节目标判定  3,912 字
 *
 * 两个数字都"对"，但没人能解释差在哪。这类争议无解，
 * 因为它不是算法错，是**两套口径并存**。
 *
 * 所以本文件的第一组断言是**对照**：
 * `measureText()` 的结果必须与 Writer 的 `totalChars` 逐字相等，
 * 且段落切分必须与 `@nwa/writing` 的 `splitParagraphs()` 逐字相等。
 * 两处任一改动而另一处没跟上，这里立刻失败。
 */

import { describe, it, expect } from 'vitest';
import {
  measureText,
  splitParagraphs as coreSplitParagraphs,
  paragraphIndexOf,
  paragraphRange,
} from '@nwa/core';
import { splitParagraphs as writingSplitParagraphs } from '@nwa/writing';

describe('④ 编辑器文本度量（M4 / §二十八 §二十九）', () => {
  describe('① 口径对照 —— 与既有实现逐字一致', () => {
    const samples: [string, string][] = [
      ['空文本', ''],
      ['单段', '雨落在青石板上。'],
      ['两段（一个空行）', '第一段。\n\n第二段。'],
      ['两段（三个空行）', '第一段。\n\n\n\n第二段。'],
      ['段首有空格', '  第一段。\n\n第二段。  '],
      ['行首空格不算分段', '第一段第一行\n  第一段第二行'],
      ['只有空行', '\n\n\n'],
      ['省略号与破折号计入字数', '他停了一下……然后走了。'],
      ['中英混排', 'Chapter 31\n\n雨夜来客，wind and rain。'],
    ];

    it.each(samples)('段落切分与 @nwa/writing 一致：%s', (_label, text) => {
      // ⚠ 这是 M4 最重要的断言：两处段落号必须同源。
      //   Review 的 location.paragraph 由 @nwa/writing 产出，
      //   编辑器用 @nwa/core 的段落号去定位 —— 不一致就会"跳错段"。
      expect(coreSplitParagraphs(text)).toEqual(writingSplitParagraphs(text));
    });

    it('空文本：全 0，而不是"1 段"', () => {
      const m = measureText('');
      // "空文本有 1 段"会让"还没有正文"与"有 1 个空段"无法区分
      expect(m).toEqual({ chars: 0, paragraphs: 0, charsWithoutSpaces: 0 });
    });

    it('字数 = text.length（与 Writer 的 totalChars 同口径）', () => {
      const text = '雨落在青石板上，他没有回头……';
      expect(measureText(text).chars).toBe(text.length);
    });

    it('⚠ 标点计入字数（省略号、破折号都算）', () => {
      const text = '他停了一下……然后走了。';
      // 12 个字符全部计入 —— 本项目允许用省略号代替破折号，
      // 若剔除标点，作者按字数规划篇幅时会与计数器对不上
      expect(measureText(text).chars).toBe(12);
    });

    it('charsWithoutSpaces 只作参考，且确实小于等于 chars', () => {
      const text = 'Chapter 31\n\n雨夜来客';
      const m = measureText(text);
      expect(m.charsWithoutSpaces).toBeLessThan(m.chars);
      expect(m.charsWithoutSpaces).toBe(text.replace(/\s/g, '').length);
    });

    it('段落数：连续多个空行只算一次分段', () => {
      expect(measureText('一。\n\n\n\n二。').paragraphs).toBe(2);
    });

    it('段落数：单换行不分段', () => {
      expect(measureText('第一行\n第二行').paragraphs).toBe(1);
    });

    it('纯空行文本：0 段', () => {
      expect(measureText('\n\n\n').paragraphs).toBe(0);
    });
  });

  describe('② 段落定位（M8 的"点问题跳段"依赖它）', () => {
    const text = '第一段内容。\n\n第二段内容。\n\n第三段内容。';

    it('按内容片段找到段落号（从 1 起）', () => {
      expect(paragraphIndexOf(text, '第二段')).toBe(2);
      expect(paragraphIndexOf(text, '第三段')).toBe(3);
    });

    it('找不到返回 null，不返回 0 或 -1', () => {
      // 用 0 表示失败会让判断条件写成 `if (n)` —— 隐式约定
      expect(paragraphIndexOf(text, '不存在的片段')).toBeNull();
    });

    it('空 needle 返回 null（避免"空串命中每一段"）', () => {
      expect(paragraphIndexOf(text, '')).toBeNull();
    });

    it('paragraphRange 返回段落在原文中的实际偏移', () => {
      const r = paragraphRange(text, 2);
      expect(r).not.toBeNull();
      expect(text.slice(r!.start, r!.end)).toBe('第二段内容。');
    });

    it('⚠ paragraphRange 不包含段首缩进与前后空行', () => {
      const padded = '  第一段。  \n\n  第二段。  ';
      const r = paragraphRange(padded, 1);
      // 若返回"重新拼接后的位置"，会丢掉缩进与空行，
      // 于是"跳转后光标位置"与"作者看到的段落开头"差几个字符
      expect(padded.slice(r!.start, r!.end)).toBe('第一段。');
      expect(r!.start).toBe(2);
    });

    it('段落号越界返回 null（不抛错）', () => {
      expect(paragraphRange(text, 99)).toBeNull();
      expect(paragraphRange(text, 0)).toBeNull();
      expect(paragraphRange(text, -1)).toBeNull();
      expect(paragraphRange(text, 1.5)).toBeNull();
    });

    it('paragraphRange 与 paragraphIndexOf 自洽', () => {
      for (let n = 1; n <= 3; n++) {
        const r = paragraphRange(text, n)!;
        const seg = text.slice(r.start, r.end);
        expect(paragraphIndexOf(text, seg)).toBe(n);
      }
    });
  });

  describe('③ ⚠ 与 Writer 字数口径的对照（防"两套数字"）', () => {
    it('measureText(text).chars 必须等于 Writer 的 totalChars 口径', () => {
      // Writer 的 totalChars 就是 fullText.length（writer.ts:397）
      const fullText = '第一场景的正文。\n\n第二场景的正文。';
      expect(measureText(fullText).chars).toBe(fullText.length);
    });

    it('场景拼接后的全文度量 = 各场景文本拼接后的度量（不丢字符）', () => {
      const scenes = ['场景一。', '场景二。', '场景三。'];
      const joined = scenes.join('\n\n');
      // 若编辑器按"段落拼接"统计，段间分隔符会被重复计入
      expect(measureText(joined).chars).toBe(joined.length);
      expect(measureText(joined).paragraphs).toBe(3);
    });
  });
});
