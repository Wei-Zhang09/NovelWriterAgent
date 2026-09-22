/**
 * AI 味模式检测测试（施工文档 §34）
 *
 * ## §34 的目标是「减少模板化和僵硬表达，而不是故意伪装成人类」
 *
 * 这决定了判据方向：检测**机械感**，不检测"像不像真人"。
 *
 * ## ⚠ 本组测试的两类断言，缺一不可
 *
 * 1. **该命中的命中**（模板化过渡、连接词堆叠…）
 * 2. ⚠ **不该命中的不命中** —— 尤其真人语料里的**好段落**。
 *    这里有一条真实的教训：第一版 `ai_adjective_pile` 用「"的"字密度」，
 *    结果把真人小说里**写得最好**的段落标成了问题：
 *    ```
 *    [12.8 字/的] 她其实不太记得他的长相，但对他空荡荡的袖管记忆犹新。
 *    ```
 *    「的」密度衡量的是**具体程度**，与 §34 要抓的**空泛**方向相反。
 *    下面专门有回归测试锁住这一点。
 */
import { describe, it, expect } from 'vitest';
import { detectAiPatterns } from '@nwa/writing';

const codes = (paras: string[]) => detectAiPatterns(paras).map((h) => h.code);

describe('§34 该命中的模式', () => {
  it('连接词堆叠（同段 ≥2 个书面连接词）', () => {
    expect(codes(['首先，他要解决资金问题。其次，他得找到人。'])).toContain(
      'ai_connective_stack',
    );
  });

  it('单个连接词不命中（正常写作）', () => {
    expect(codes(['首先，他要解决资金问题。'])).not.toContain('ai_connective_stack');
  });

  it('模板化过渡（段首套话）', () => {
    expect(codes(['于是，他决定离开。'])).toContain('ai_template_transition');
    expect(codes(['岁月如梭，转眼三年过去。'])).toContain('ai_template_transition');
  });

  it('⚠ 模板化过渡只认段首（避免误伤正文中的"于是"）', () => {
    expect(codes(['他想了很久，于是决定离开。'])).not.toContain('ai_template_transition');
  });

  it('情绪直接标签化（同段 ≥2 次）', () => {
    expect(codes(['他感到愤怒，她也感到愤怒。'])).toContain('ai_emotion_label');
  });

  it('单次情绪陈述不命中（正常写法）', () => {
    expect(codes(['他感到愤怒。'])).not.toContain('ai_emotion_label');
  });

  it('段末总结句（把意义替读者说尽）', () => {
    expect(codes(['他这才明白，有些事一旦错过就再也回不来。'])).toContain('ai_summary_tail');
    expect(codes(['这一切都说明了一个道理。'])).toContain('ai_summary_tail');
  });

  it('机械排比（同段 ≥3 个同结构短句）', () => {
    expect(codes(['他走了。他停了。他回头了。'])).toContain('ai_parallel_enumeration');
  });

  it('⚠ 排比检测对对话豁免（对话里的短句是正常语气）', () => {
    expect(codes(['“你来了。你坐下。你说话。”'])).not.toContain('ai_parallel_enumeration');
  });

  it('空泛环境套语（同段 ≥3 个）', () => {
    expect(codes(['阳光明媚，微风轻拂，鸟语花香。'])).toContain('ai_vague_scenery');
  });

  it('⚠ 空泛套语要求 ≥3 个（单个是正常描写）', () => {
    expect(codes(['阳光明媚，他推开门走了进去。'])).not.toContain('ai_vague_scenery');
  });

  it('抽象形容词堆叠（同段 ≥2 个空泛评价词）', () => {
    expect(codes(['她笑得温柔，眼神里有一种莫名的优雅。'])).toContain('ai_adjective_pile');
  });

  it('重复解释（相邻段落解释同一情绪）', () => {
    const hits = detectAiPatterns(['他感到愤怒。', '那股愤怒又一次涌上来。']);
    expect(hits.map((h) => h.code)).toContain('ai_explained_again');
  });
});

describe('⚠ 不该命中的（真人语料的正常写法）', () => {
  it('⚠ 回归：具体、有细节的段落**不得**被判为形容词堆叠', () => {
    // 这是第一版判据（"的"字密度）误伤的原文 —— 它其实是全书最好的段落之一。
    // 教训：「的」密度衡量具体程度，与"空泛"方向相反。
    const good = [
      '夏林希从门后观望，透过秋日泛黄的树叶，瞧见进门的那个人，果然是蒋正寒的父亲……她其实不太记得他的长相，但对他空荡荡的袖管记忆犹新。',
      '矮桌的角落里放着一只旧木匣，匣盖裂了缝，用麻线缠了两圈。他打开，里面只有一样东西，用一块褪色的蓝布包着。',
      '夜幕浸染天空，浓的像一块化不开的墨砚，老城区的路灯昏暗无光，照不亮弯弯曲曲的小巷。',
    ];
    expect(codes(good)).not.toContain('ai_adjective_pile');
  });

  it('⚠ 回归：真人语料的正常段落不应大面积命中任何规则', () => {
    // 取自《百岁之好》的连续正常段落
    const normal = [
      '高三开学不到一个月，蒋正寒一直坐在她的后面，他对她的唯一印象，就是一个埋首于题海中的背影，浓密的长发扎成一个马尾辫，偶尔会有几缕搭在他的书桌上。',
      '“叫了，”蒋正寒道，“我们一起走吧。”',
      '夏林希抬头，与蒋正寒对视。',
      '何老师的办公桌在中间，听说联考成绩出来了，其他老师也纷纷赶来围观，有一位老师出声问：“怎么样，我们尖子班那个第一名，她这次考试总分多少？”',
      '早饭结束以后，夏林希背起书包出门，路过厨房外的走廊时，她有意往里面瞥了一眼，看见那位彭阿姨正在低头刷碗，刘海挡住了额头，两鬓都是斑白的头发。',
    ];
    expect(detectAiPatterns(normal)).toEqual([]);
  });

  it('对话中的情绪词不算标签化（人物可以说出自己的感受）', () => {
    expect(codes(['“我很生气，”他说，“但我不想吵。”'])).not.toContain('ai_emotion_label');
  });

  it('具体景物描写不算空泛套语', () => {
    expect(
      codes(['对岸的芦苇荡和更远处灰蒙蒙的山脊，渡口下游泊着几条货船。']),
    ).not.toContain('ai_vague_scenery');
  });

  it('正常长短句交替不算机械排比', () => {
    expect(
      codes([
        '他推开门，屋里没人。桌上摆着一只碗，碗底还剩半口粥。他站了一会儿，把碗端起来，走到灶台边，舀了瓢水涮干净。',
      ]),
    ).not.toContain('ai_parallel_enumeration');
  });
});

describe('命中信息完整（供 UI 定位）', () => {
  it('每条命中带段号与片段', () => {
    const hits = detectAiPatterns(['正常段落。', '首先，他要解决资金问题。其次，他得找到人。']);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.paragraph).toBe(2);
    expect(hits[0]!.excerpt.length).toBeGreaterThan(0);
    expect(hits[0]!.detail.length).toBeGreaterThan(0);
  });

  it('空输入不崩', () => {
    expect(detectAiPatterns([])).toEqual([]);
  });
});
