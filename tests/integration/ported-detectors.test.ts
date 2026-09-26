/**
 * ADR-0009 移植检测器测试。
 *
 * ## ⚠ 本文件的两类用例
 *
 * **正例**：上游标记为命中的真实句式必须命中（证明移植没丢能力）。
 * **豁免例**：上游专门写豁免的假阳性必须**不**命中。
 *
 * 豁免例比正例更重要 —— 上游那些豁免（引号内台词、"是不是"问句、
 * "就是/也是/还是"里的"是"）都是踩过假阳性才加的。
 * 丢掉豁免会让误报率远超 ADR 设定的 30% 阈值，
 * 而"误报"的代价是**让作者去改本来没问题的句子**。
 */
import { describe, expect, it } from 'vitest';
import { detectAiPatterns } from '@nwa/writing';
import {
  findEmDashes,
  findNegationParade,
  findNotIsComparisons,
  findReverseNotIs,
  findTrailerEndings,
  findVoiceContrast,
} from '../../packages/writing/src/naturalness/ported-detectors.js';

/** 命中该 code 的段落号 */
const parasWith = (paras: string[], code: string) =>
  detectAiPatterns(paras)
    .filter((h) => h.code === code)
    .map((h) => h.paragraph);

describe('not_is_comparison（不是A，而是B）—— 上游标 ★★★★★ 最毒', () => {
  it('命中「不是A，而是B」', () => {
    expect(findNotIsComparisons('这不是结束，而是开始。')).toHaveLength(1);
  });

  it('命中紧凑形式「不是A是B」', () => {
    expect(findNotIsComparisons('那不是退缩是策略。')).toHaveLength(1);
  });

  it('命中「不是A，是B」', () => {
    expect(findNotIsComparisons('这不是失败，是提醒。')).toHaveLength(1);
  });

  it('⚠ 豁免引号内的台词（口语辩解是自然的，不是叙述层 AI 腔）', () => {
    expect(findNotIsComparisons('「这不是我的错，是他先动手的。」')).toHaveLength(0);
  });

  it('⚠ 豁免「是不是」问句', () => {
    expect(findNotIsComparisons('他是不是走了，而是留下？')).toHaveLength(0);
  });

  it('⚠ 不把「不是A，也不是B」里的第二个「不是」当成肯定项', () => {
    // 跨了分隔符还抓的话，第二个否定会被误判成"肯定项" —— 整句本来就没对比
    expect(findNotIsComparisons('不是他不想去，也不是他不敢去。')).toHaveLength(0);
  });

  it('⚠ 不把「就是/也是」里的「是」当成肯定项（合成词）', () => {
    expect(findNotIsComparisons('不是钱的问题，就是时间不够。')).toHaveLength(0);
  });

  it('普通否定句不命中（没有对比项）', () => {
    expect(findNotIsComparisons('他不是本地人。')).toHaveLength(0);
  });
});

describe('reverse_not_is（是A，不是B）', () => {
  it('命中「是A，不是B」', () => {
    expect(findReverseNotIs('这是策略，不是退缩。')).toHaveLength(1);
  });

  it('⚠ 豁免「就是…」里的「是」（合成词）', () => {
    expect(findReverseNotIs('他就是那样，不是装的。')).toHaveLength(0);
  });

  it('⚠ 豁免「还是…」里的「是」', () => {
    expect(findReverseNotIs('他还是老样子，不是改了。')).toHaveLength(0);
  });

  it('⚠ 豁免反问尾巴「不是吗」', () => {
    expect(findReverseNotIs('这是真的，不是吗。')).toHaveLength(0);
  });

  it('⚠ 豁免「是不是」问句', () => {
    expect(findReverseNotIs('是不是真的，不是重点。')).toHaveLength(0);
  });
});

describe('voice_contrast（音量反差腔）', () => {
  it('命中「声音不大，却…」', () => {
    expect(findVoiceContrast('他声音不大，却让全场安静下来。')).toHaveLength(1);
  });

  it('命中「声音不高，但…」', () => {
    expect(findVoiceContrast('声音不高，但每个字都砸在地上。')).toHaveLength(1);
  });

  it('⚠ 引号内的台词不命中（是人物在说话，不是叙述腔）', () => {
    expect(findVoiceContrast('「我声音不大，却听得见。」')).toHaveLength(0);
  });

  it('单纯描述音量不命中（没有反差转折）', () => {
    expect(findVoiceContrast('他声音不大。')).toHaveLength(0);
  });
});

describe('negation_parade（否定排比）', () => {
  it('⚠ 两处否定**不**命中，三处才命中（已用上游脚本实测确认）', () => {
    // ⚠ 第一版我把期望写成"两处就命中"，实测上游脚本对
    //   「没有灯光，没有声音。」返回 findings: [] —— 是**我的断言错了**，
    //   不是移植错了。上游正则 `(?:没有[^，,]{1,12}[，,]){2}` 要求
    //   两处"没有X，"之后还有内容，两处否定时第二段后无逗号。
    //   教训：移植的验收标准是"与上游一致"，不是"我觉得应该命中"。
    expect(findNegationParade('没有灯光，没有声音。')).toHaveLength(0);
    expect(findNegationParade('没有灯光，没有声音，没有温度。')).toHaveLength(1);
  });

  it('命中「没X，没有Y，只是Z」', () => {
    const hits = findNegationParade('没人在意，没有人在看，只是他还在站着。');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('单个否定不命中', () => {
    expect(findNegationParade('没有灯光。')).toHaveLength(0);
  });

  it('⚠ 去重叠：两条正则命中同一段时只报一次', () => {
    // 重复报告会让作者看到两条一模一样的提示，反而忽略真正的问题
    const hits = findNegationParade('没有灯光，没有声音，没人在意，没有人在看。');
    const starts = hits.map((h) => h.start);
    expect(new Set(starts).size).toBe(starts.length);
  });
});

describe('trailer_ending / trailer_summary（章末体）', () => {
  it('命中章末预告体', () => {
    const r = findTrailerEndings(['他站起身，走出门去。', '没人知道接下来会发生什么。']);
    expect(r.endings.length).toBeGreaterThan(0);
  });

  it('命中章末总结体', () => {
    const r = findTrailerEndings(['这一夜注定无眠。']);
    expect(r.summaries.length).toBeGreaterThan(0);
  });

  it('⚠ 窗口外的章末词不命中（只回看 600 字）', () => {
    // ⚠ 注意窗口是**600 字**而不是"最后几段"。
    //   第一版我用 40 段填充（每段 18 字 ≈ 720 字）以为能把它推出窗口，
    //   实测上游脚本对「殊不知 + 40 段」**仍然命中** —— 因为回看是从后往前
    //   累积到 600 字，开头那一段仍在窗口内。
    //   这里用足够长的填充（>600 字）才能真正验证窗口边界。
    const filler = Array.from({ length: 60 }, () => '他往前走了一段很长的路，四周什么声音也没有，只有脚下的石子被踩得沙沙作响。');
    const paras = ['殊不知这件事另有隐情。', ...filler];
    const r = findTrailerEndings(paras);
    expect(r.endings).toHaveLength(0);
  });

  it('⚠ 报的是**实际段号**，不是第 1 段', () => {
    const r = findTrailerEndings(['第一段。', '第二段。', '谁也不知道答案。']);
    expect(r.endings[0]?.paragraph).toBe(3);
  });
});

describe('em_dash（破折号）—— 与作者偏好一致（少用破折号）', () => {
  it('命中中文破折号', () => {
    expect(findEmDashes('他停住了——不是因为害怕。')).toHaveLength(1);
  });

  it('命中单个长破折号', () => {
    expect(findEmDashes('他停住了—不是因为害怕。')).toHaveLength(1);
  });

  it('⚠ 省略号不命中（作者偏好用省略号替代破折号）', () => {
    // 上游的标点归一默认清除省略号，与作者偏好直接冲突 ——
    // 所以只移植检测，且检测**不能**把省略号当成问题
    expect(findEmDashes('他停住了……不是因为害怕。')).toHaveLength(0);
  });
});

describe('接入 detectAiPatterns 后的整体行为', () => {
  it('⚠ 移植类别出现在统一契约里，且带 severity 与 offset', () => {
    const hits = detectAiPatterns(['这不是结束，而是开始。']);
    const h = hits.find((x) => x.code === 'not_is_comparison');
    expect(h).toBeTruthy();
    // 上游标 blocking，本项目**如实保留**该分级（供后续校准）
    expect(h?.severity).toBe('blocking');
    // 字符级检测器能给出精确偏移
    expect(h?.offset).toBeGreaterThanOrEqual(0);
  });

  it('⚠ 自研的段级规则 offset 为 -1（段级布尔判定给不出精确偏移）', () => {
    const hits = detectAiPatterns(['首先，他要解决资金问题。其次，他得找到人。']);
    const h = hits.find((x) => x.code === 'ai_connective_stack' || x.code === 'ai_template_transition');
    expect(h).toBeTruthy();
    // ⚠ 用 -1 而不是 0：0 是合法偏移（段首），混用会让 UI 把整段命中画在段首
    expect(h?.offset).toBe(-1);
  });

  it('⚠ 同一段同一 code 只报一次（正则可能在一段里命中多处）', () => {
    const hits = detectAiPatterns(['这不是A，而是B。那不是C，而是D。']);
    const keys = hits.map((h) => `${h.paragraph}:${h.code}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('正常正文不命中移植类别（误报检查）', () => {
    const normal = ['雨落在青石板上。', '他把伞收起来，靠在门边。', '屋里没有人。'];
    const ported = detectAiPatterns(normal).filter((h) =>
      ['not_is_comparison', 'reverse_not_is', 'voice_contrast', 'negation_parade', 'trailer_ending', 'trailer_summary'].includes(h.code),
    );
    expect(ported).toEqual([]);
  });

  it('章末体命中带**实际段号**（不是第 1 段）', () => {
    const paras = ['第一段。', '第二段。', '谁也不知道。'];
    expect(parasWith(paras, 'trailer_ending')).toEqual([3]);
  });

  it('空输入不抛错', () => {
    expect(detectAiPatterns([])).toEqual([]);
  });
});
