/**
 * 网络语料清洗测试（真实语料驱动）
 *
 * ## 触发这组测试的真实数据
 *
 * 用户提供《斗破苍穹》（网络转载，580 万字）与《百岁之好》（60 章）。
 * 实测发现七类噪声，其中**每一类都会静默污染 NDE 全链路**：
 *
 * | 噪声 | 规模 | 后果 |
 * |---|---|---|
 * | 反爬水印 `武动乾坤` | 40500 处 | 每句尾粘着另一部作品名 |
 * | 括号水印 `（手机阅读16kxs)` | 30 处 | 混进场景文本 |
 * | 内联水印 `更/新/最/快16kxs` | 62 处 | 粘在正文中间 |
 * | 作者话 `ps：求月票…` | 52 行 | 被当成叙事 |
 * | 目录行 `vip章 目录 第X章 …` | 101 行 | 造出空正文章节、章号错位 |
 * | 空壳标题行 | 54 处 | 抢走章节号 |
 * | 番外篇 | 1 处（3.2 万字） | 章号重置为 1 |
 *
 * ## ⚠ 本组测试的核心是"不误删正文"
 *
 * 清洗是**破坏性**操作。实测两次差点误删：
 *   1. 《百岁之好》有正当正文「心里惦记着未完待续的吻」
 *      → 因此「未完待续」只在**句末**才算促销
 *   2. 有「正文前半 + 促销后半」同段的情形
 *      → 因此按片段删而非整段删
 */
import { describe, it, expect } from 'vitest';
import { cleanWebNovel, findExtrasStart, isPromoText } from '@nwa/distillation';

describe('反爬水印（实测 40500 处）', () => {
  it('删掉句末标点前的水印，保留标点', () => {
    const t = '带起了一阵嘲讽的骚动武动乾坤。';
    const r = cleanWebNovel(t);
    expect(r.text).toBe('带起了一阵嘲讽的骚动。');
    expect(r.report.removedChars).toBeGreaterThan(0);
  });

  it('多处水印全部清掉', () => {
    const t = '甲武动乾坤。乙武动乾坤。丙武动乾坤。';
    const r = cleanWebNovel(t);
    expect(r.text).not.toContain('武动乾坤');
    expect(r.text).toContain('甲。');
    expect(r.text).toContain('丙。');
  });

  it('报告里记录水印规则', () => {
    const r = cleanWebNovel('甲武动乾坤。');
    const rule = r.report.rules.find((x) => x.name.includes('水印'));
    expect(rule).toBeDefined();
    expect(rule!.count).toBeGreaterThan(0);
  });
});

describe('括号水印', () => {
  it('删掉含手机阅读标记的括号片段', () => {
    const t = '萧炎道（手机阅读16kxs)。';
    const r = cleanWebNovel(t);
    expect(r.text).not.toContain('16kxs');
    expect(r.text).toContain('萧炎道');
  });

  it('⚠ 不含水印特征的括号内容保留（正文里的合法括号）', () => {
    const t = '他笑了（那是一种无奈的笑）。';
    const r = cleanWebNovel(t);
    expect(r.text).toBe(t);
  });

  it('⚠ 正文 + 括号促销混合时，只删括号不删正文', () => {
    const t = '目光迷离的望着那倩影，心中升起复杂的情绪（最后四天时间，拜请诸位弟兄点击下方推荐月票支持作者）';
    const r = cleanWebNovel(t);
    expect(r.text).toContain('目光迷离的望着那倩影');
    expect(r.text).not.toContain('推荐月票');
  });
});

describe('内联水印（粘在正文中间）', () => {
  it('删掉「更/新/最/快16kxs」', () => {
    const t = '“砰，更/新/最/快16kxs砰”';
    const r = cleanWebNovel(t);
    expect(r.text).not.toContain('16kxs');
    expect(r.text).toContain('砰');
  });

  it('⚠ 水印后正文继续时，正文必须保留', () => {
    // 实测形态：手机快速阅读：16kxs中，药材丹药这一部分…
    const t = '手机快速阅读：16kxs中，药材丹药这一部分，刚好是由我全程掌管。';
    const r = cleanWebNovel(t);
    expect(r.text).toContain('药材丹药这一部分');
    expect(r.text).not.toContain('16kxs');
  });

  it('删掉「手机看小说访问wap.…」', () => {
    const t = '听得他这，白山略有些迟疑.手机看小说访问wap.16kxs';
    const r = cleanWebNovel(t);
    expect(r.text).not.toContain('wap');
    expect(r.text).toContain('白山略有些迟疑');
  });
});

describe('作者话/促销', () => {
  it('删掉 ps 开头的行', () => {
    const t = '正文内容。\nps：第二更到。第三更十二点后\n更多正文。';
    const r = cleanWebNovel(t);
    expect(r.text).not.toContain('第二更到');
    expect(r.text).toContain('正文内容。');
    expect(r.text).toContain('更多正文。');
  });

  it('删掉整行被括号包裹的求票段落', () => {
    const t = '正文。\n（第二更到，希望诸位弟兄能够丢几张推荐票，谢谢）\n后续正文。';
    const r = cleanWebNovel(t);
    expect(r.text).not.toContain('推荐票');
    expect(r.text).toContain('后续正文。');
  });

  it('⚠ 含逗号的求票段落（章末形态）被清掉', () => {
    // 真实形态：求票在**章末**，后面紧跟下一章标题
    const t = [
      '萧炎点了点头，转身离开。',
      '',
      '周初，大家看完更新，麻烦投几张票栗吧，万分感激了！未完待续，如欲中后事如何',
      '',
      '第一千一百一十三章 铜片',
      '',
      '正文继续。',
    ].join('\n');
    const r = cleanWebNovel(t);
    expect(r.text).not.toContain('未完待续');
    expect(r.text).not.toContain('票栗');
    // ⚠ 章末正文与下一章标题都必须保留
    expect(r.text).toContain('萧炎点了点头');
    expect(r.text).toContain('第一千一百一十三章 铜片');
    expect(r.text).toContain('正文继续。');
  });

  it('⚠ 促销段落里的前半正文要保住（正文+促销同段）', () => {
    const t = [
      '目光迷离的望着那逐渐消失在视野中的窈窕倩影，林修崖脑袋顿时耷了下来。',
      '',
      '（最后四天时间，拜请诸位弟兄点击下方推荐月票支持作者，土豆谢谢了）',
    ].join('\n');
    const r = cleanWebNovel(t);
    expect(r.text).toContain('林修崖脑袋顿时耷了下来');
    expect(r.text).not.toContain('推荐月票');
  });

  it('isPromoText 需要 ≥2 个信号词', () => {
    expect(isPromoText('月票')).toBe(false);
    expect(isPromoText('求月票，推荐票')).toBe(true);
  });
});

describe('⚠ 不误删正当正文（实测两次踩到）', () => {
  it('「未完待续的吻」是正文，不能删', () => {
    // 实测《百岁之好》：「心里惦记着未完待续的吻」
    const t = '他不是一个半途而废的人，心里惦记着未完待续的吻，但是夏林希脸色不对。';
    const r = cleanWebNovel(t);
    expect(r.text).toBe(t);
  });

  it('「课后习题都是未完待续，明天就要开始检查了」是正文', () => {
    const t = '他积攒了不少作业，课后习题都是未完待续，明天就要开始检查了。';
    const r = cleanWebNovel(t);
    expect(r.text).toBe(t);
  });

  it('⚠ 句末的「未完待续。」才算促销', () => {
    const t = '正文内容。\n拜求月票了，未完待续。\n后续。';
    const r = cleanWebNovel(t);
    expect(r.text).not.toContain('未完待续');
  });

  it('「第一回合」不是章节标题，也不是促销', () => {
    const t = '第一回合的接触，武器便是被击落。';
    const r = cleanWebNovel(t);
    expect(r.text).toBe(t);
  });
});

describe('目录行（实测 101 处，会造出空章节）', () => {
  it('删掉「vip章 目录 第X章 …」行', () => {
    const t = '正文。\nvip章 目录 第五百四十章 胜!\n更多正文。';
    const r = cleanWebNovel(t);
    expect(r.text).not.toContain('目录');
    expect(r.text).toContain('更多正文。');
  });

  it('报告里记录目录行规则', () => {
    const r = cleanWebNovel('甲。\nvip章 目录 第一章 开端\n乙。');
    const rule = r.report.rules.find((x) => x.name.includes('目录'));
    expect(rule).toBeDefined();
  });
});

describe('空壳标题行（实测 54 处）', () => {
  it('⚠ 后面无正文的标题行被删（否则抢走章节号）', () => {
    const t = [
      '第五百四十章 药皇，韩枫!',
      '',
      '第五百一十二章药皇，韩枫！',
      '',
      '内院深处，一处幽静楼阁。',
    ].join('\n');
    const r = cleanWebNovel(t);
    // 空壳被删，真章节保留
    expect(r.text).not.toMatch(/^第五百四十章 药皇，韩枫!/m);
    expect(r.text).toContain('第五百一十二章药皇，韩枫！');
    expect(r.text).toContain('内院深处');
  });

  it('正常章节（后面有正文）不受影响', () => {
    const t = '第一章 开端\n\n正文内容在这里。\n\n第二章 冲突\n\n更多正文。';
    const r = cleanWebNovel(t);
    expect(r.text).toContain('第一章 开端');
    expect(r.text).toContain('第二章 冲突');
  });
});

describe('番外篇（章节号重置）', () => {
  it('findExtrasStart 找到章号重置点', () => {
    const t = ['第两百章 甲', '正文', '', '第一章 番外', '番外正文'].join('\n');
    expect(findExtrasStart(t)).toBeGreaterThan(0);
  });

  it('⚠ 正文里提到「第一章」不算重置', () => {
    // 实测踩到：「在第一章，如果时间再快十天…」导致 87% 处误切
    const t = ['第两百章 甲', '正文', '', '土豆刚来到时，在第一章，如果时间再快十天，那么写书也是三年了。', '更多正文'].join('\n');
    expect(findExtrasStart(t)).toBe(-1);
  });

  it('章号未达 100 时不判番外（避免误切短篇）', () => {
    const t = ['第五十章 甲', '正文', '', '第一章 乙', '正文'].join('\n');
    expect(findExtrasStart(t)).toBe(-1);
  });

  it('dropExtras=false 时保留番外', () => {
    const t = ['第两百章 甲', '正文', '', '第一章 番外', '番外正文'].join('\n');
    const r = cleanWebNovel(t, { dropExtras: false });
    expect(r.text).toContain('番外正文');
  });
});

describe('清洗报告（可审计性）', () => {
  it('每条规则都记录次数与删除量', () => {
    const t = '甲武动乾坤。\nps：求月票，推荐票\n乙。';
    const r = cleanWebNovel(t);
    expect(r.report.rules.length).toBeGreaterThan(0);
    for (const rule of r.report.rules) {
      expect(rule.count).toBeGreaterThan(0);
      expect(rule.removedChars).toBeGreaterThan(0);
    }
  });

  it('记录删除占比', () => {
    const r = cleanWebNovel('甲武动乾坤。');
    expect(r.report.removedRatio).toBeGreaterThan(0);
    expect(r.report.removedRatio).toBeLessThan(1);
  });

  it('附样例供人工核对', () => {
    const r = cleanWebNovel('甲武动乾坤。');
    expect(r.report.samples.length).toBeGreaterThan(0);
  });

  it('干净的文本不改动、报告为空', () => {
    const clean = '第一章 开端\n\n这是一段完全干净的正文，没有任何噪声。\n\n第二章 冲突\n\n更多干净的正文。';
    const r = cleanWebNovel(clean);
    expect(r.text).toBe(clean);
    expect(r.report.removedChars).toBe(0);
  });
});
