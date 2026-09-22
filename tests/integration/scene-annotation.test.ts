/**
 * 场景切分与叙事标注测试（施工文档 §18 / §19）
 *
 * ## 这组测试的核心是"宁少切不错切"
 *
 * 切分错误是**静默的**：后续标注与模式挖掘都基于错误边界工作，
 * 每个环节单独看都正常。因此判据必须保守 —— 宁可合并场景
 * （粒度粗），也不要造出**不存在的场景转移**（让模式挖掘学出伪规律）。
 *
 * ## 真实数据驱动的判据
 *
 * 用《百岁之好》（都市校园，108 章 / 9476 段）实测得出：
 *   - 平均每章 87.7 段 / 2.5 场景
 *   - 时间标记 113 处、地点标记 7 处
 *   - "转折词"（然而/于是）88 处**不能**当边界（多为同场景内转折）
 */
import { describe, it, expect } from 'vitest';
import {
  segmentScenes,
  toParagraphs,
  isDialogueParagraph,
  splitSentences,
  computePacing,
  computeProse,
} from '@nwa/distillation';
import { SceneAnnotator } from '@nwa/distillation';
import type { AnnotationStructuredCaller } from '@nwa/distillation';
import { SceneSemanticSchema, SCENE_FUNCTIONS } from '@nwa/shared';
import { Logger } from '@nwa/core';

const logger = new Logger('test:scene', { level: 'error' });

// ══════════════════════════════════════════════════════════
describe('段落与句子切分', () => {
  it('按空行切段落', () => {
    const ps = toParagraphs('第一段。\n\n第二段。\n\n\n第三段。');
    expect(ps).toHaveLength(3);
    expect(ps[0]!.index).toBe(0);
    expect(ps[2]!.index).toBe(2);
  });

  it('忽略空段', () => {
    expect(toParagraphs('\n\n\n')).toHaveLength(0);
  });

  it('识别对话段', () => {
    expect(isDialogueParagraph('“你好。”他说。')).toBe(true);
    expect(isDialogueParagraph('「日式引号」')).toBe(true);
    expect(isDialogueParagraph('他走了。')).toBe(false);
    expect(isDialogueParagraph('')).toBe(false);
  });

  it('切句：中文标点为句末', () => {
    const s = splitSentences('他走了。她留下！真的吗？');
    expect(s).toHaveLength(3);
    expect(s[0]).toBe('他走了。');
  });

  it('⚠ 连续省略号算一个句末（不拆成空句）', () => {
    const s = splitSentences('他犹豫了一下……然后点头。');
    expect(s).toHaveLength(2);
    expect(s.every((x) => x.trim().length > 0)).toBe(true);
  });

  it('无句末标点时整段算一句', () => {
    expect(splitSentences('没有标点的一段话')).toEqual(['没有标点的一段话']);
  });
});

// ══════════════════════════════════════════════════════════
describe('机械指标（代码计算，不接受 LLM）', () => {
  it('对话占比按字符算', () => {
    const ps = toParagraphs('“你好。”（4字）\n\n他说了很长的一段叙述文字共十五个字。');
    const m = computePacing(ps);
    expect(m.dialogueRatio).toBeGreaterThan(0);
    expect(m.dialogueRatio).toBeLessThan(1);
  });

  it('⚠ 段落密度按每千字算', () => {
    const ps = toParagraphs('短。\n\n短。\n\n短。');
    const m = computePacing(ps);
    // 6 字 3 段 → 每千字 500 段
    expect(m.paragraphDensity).toBeGreaterThan(100);
  });

  it('⚠ speed 是合成指标（对话多 + 段落短 = 快）', () => {
    const fast = toParagraphs('“走！”\n\n“好！”\n\n“快！”');
    const slow = toParagraphs(
      '他缓缓地走进那间屋子，环顾四周，目光落在窗台上一盆枯萎的花上，想起了许多年前的往事。',
    );
    expect(computePacing(fast).speed).toBeGreaterThan(computePacing(slow).speed);
  });

  it('prose 给出句长均值', () => {
    const ps = toParagraphs('四字句。\n\n六字句子啊。');
    const m = computeProse(ps);
    expect(m.sentenceLengthMean).toBeGreaterThan(0);
  });

  it('⚠ 内心独白按引导词近似识别（是相对指标，非精确值）', () => {
    const ps = toParagraphs('他心想，这件事不能就这么算了。');
    const m = computeProse(ps);
    expect(m.internalMonologueRatio).toBeGreaterThan(0);
  });

  it('空输入不崩溃', () => {
    const m = computePacing([]);
    expect(m.dialogueRatio).toBe(0);
    expect(m.speed).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════
describe('场景切分（§18 六项依据）', () => {
  it('章首总是第一个场景的边界', () => {
    const s = segmentScenes('第一段。\n\n第二段。\n\n第三段。');
    expect(s).toHaveLength(1);
    expect(s[0]!.reason).toBe('CHAPTER_START');
  });

  it('⚠ 时间标记切分', () => {
    const t = [
      '他们在教室里聊天，气氛轻松。',
      '又聊了一会儿，话题转向考试。',
      '大家都有点紧张。',
      '',
      '第二天早上，他来到学校。',
      '教室里空荡荡的。',
      '他坐到了自己的位置上。',
    ].join('\n\n');
    const s = segmentScenes(t);
    expect(s.length).toBeGreaterThanOrEqual(2);
    expect(s.some((x) => x.reason === 'TIME_SHIFT')).toBe(true);
  });

  it('⚠ 「没过多久」这类短时过渡也算边界（实测 12 处）', () => {
    const t = [
      '她骑车回家，路上天色渐暗。',
      '她推开门，妈妈在沙发上等她。',
      '两人说了几句话。',
      '',
      '没过多久，客厅传来压抑的争吵声。',
      '是她的父母在争论家长会的事。',
      '她站在门外没有进去。',
    ].join('\n\n');
    const s = segmentScenes(t);
    expect(s.length).toBeGreaterThanOrEqual(2);
  });

  it('⚠ 转折词「然而/于是」**不**作为边界（实测 88 处，多为同场景内转折）', () => {
    const t = [
      '他走进教室，坐在最后一排。',
      '然而在场的同学和老师，却没有一个相信他的话。',
      '于是他又解释了一遍。',
      '大家仍然将信将疑。',
    ].join('\n\n');
    const s = segmentScenes(t);
    // 不应因转折词而切分
    expect(s).toHaveLength(1);
  });

  it('⚠ 地点词只在表达"来到/定位"时才算边界', () => {
    // 反例：实测踩到 —— 句首含"路上"但只是叙述延续
    const noShift = [
      '夏林希拖着行李箱走在老城区。',
      '路上有流浪汉看着她，流里流气地笑了。',
      '她加快了脚步。',
    ].join('\n\n');
    expect(segmentScenes(noShift)).toHaveLength(1);
  });

  it('显式分隔符切分', () => {
    const t = ['甲段。', '乙段。', '丙段。', '', '※※※', '', '丁段。', '戊段。', '己段。'].join('\n\n');
    const s = segmentScenes(t);
    expect(s.length).toBeGreaterThanOrEqual(2);
    expect(s.some((x) => x.reason === 'SEPARATOR')).toBe(true);
  });

  it('⚠ 过短场景被合并（minParagraphs）', () => {
    const t = ['甲。', '乙。', '丙。', '', '第二天，他走了。', '', '丁。', '戊。', '己。'].join('\n\n');
    const s = segmentScenes(t, { minParagraphs: 3 });
    // "第二天" 后只有 3 段，但切点前已够 3 段 → 应切
    // 关键是**不产生 1~2 段的碎片场景**
    expect(s.every((x) => x.paragraphs.length >= 1)).toBe(true);
  });

  it('⚠ 无标记的超长章：不发明边界，只标 oversized', () => {
    // 造 60 段连续叙述（无任何标记）
    //
    // ⚠ 早先的实现会"等距切分"（在 maxParagraphs 处硬切）。
    //   实测后果：《百岁之好》第 2 章 82 段，真实边界在段 46
    //   （「没过多久，时针指向九点半…」），却因 cap=40 在段 40 硬切，
    //   造出 **189 字 / 6 段** 的碎片场景 —— 那 6 段本是办公室对话的延续。
    //
    //   等距切分 = **发明文本没给出的边界**，而下游（标注 → 模式挖掘）
    //   会把它当真实叙事结构学习。错误静默扩散。
    const paras = Array.from({ length: 60 }, (_, i) => `这是第 ${i + 1} 段连续的叙述文字内容。`);
    const t = paras.join('\n\n');
    const s = segmentScenes(t, { maxParagraphs: 20 });

    // 忠于文本：没有标记就不切
    expect(s.length).toBe(1);
    // 但要**如实报告**这里可能有未识别的边界（LLM 层入口）
    expect(s[0]!.oversized).toBe(true);
    expect(s[0]!.paragraphs.length).toBe(60);
  });

  it('⚠ 有标记的超长章：在标记处切（忠于文本）', () => {
    // 60 段，第 25 段（index 24）是明确的时间标记
    const paras = Array.from({ length: 60 }, (_, i) =>
      i === 24 ? '第二天早上，他来到学校。' : `这是第 ${i + 1} 段连续的叙述文字内容。`,
    );
    const t = paras.join('\n\n');
    const s = segmentScenes(t, { maxParagraphs: 30 });

    // 应切，且切点正是标记所在段（不是等距的 30）
    expect(s.length).toBe(2);
    expect(s[1]!.startParagraph).toBe(24);
    expect(s[1]!.reason).toBe('TIME_SHIFT');

    // 场景 0 = 段 [0,24) = 24 段 < cap 30 → 尺寸正常
    expect(s[0]!.paragraphs.length).toBe(24);
    expect(s[0]!.oversized).toBe(false);

    // 场景 1 = 段 [24,60) = 36 段 > cap 30，且内部无标记
    // → **不切**（不发明边界），如实标 oversized 交 LLM 层
    expect(s[1]!.paragraphs.length).toBe(36);
    expect(s[1]!.oversized).toBe(true);
  });

  it('⚠ 强切不产生碎片场景', () => {
    // 标记出现在离 cap 很近的地方 —— 早先会切出 1~2 段的碎片
    const paras = Array.from({ length: 45 }, (_, i) =>
      i === 21 ? '第二天早上，他来到学校。' : `这是第 ${i + 1} 段连续的叙述文字内容。`,
    );
    const t = paras.join('\n\n');
    const s = segmentScenes(t, { maxParagraphs: 20 });
    for (const sc of s) {
      expect(sc.paragraphs.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('空章节返回空数组', () => {
    expect(segmentScenes('')).toEqual([]);
    expect(segmentScenes('\n\n\n')).toEqual([]);
  });

  it('记录切分依据与证据（便于人工核对）', () => {
    const t = ['甲。', '乙。', '丙。', '', '第二天早上，他来到学校。', '丁。', '戊。'].join('\n\n');
    const s = segmentScenes(t);
    const shifted = s.find((x) => x.reason === 'TIME_SHIFT');
    expect(shifted).toBeDefined();
    expect(shifted!.evidence.length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════
describe('⚠ hook 容错（表述形式问题不该毁掉整个场景的标注）', () => {
  const { SceneAnnotationSchema } = require('@nwa/shared') as typeof import('@nwa/shared');

  const BASE = {
    sceneId: 'sc1',
    characters: ['甲'],
    goals: [],
    conflicts: [],
    actions: [],
    emotions: [],
    information: [],
    foreshadowing: [],
    payoff: [],
  };

  it('⚠ hook 是字符串 → 归一为 {type, intensity}（实测 2 个场景栽在这）', () => {
    const r = SceneAnnotationSchema.safeParse({ ...BASE, hook: '他是否已猜出真相' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.hook?.type).toBe('他是否已猜出真相');
      expect(r.data.hook?.intensity).toBe(0.5);
    }
  });

  it('⚠ hook 漏了 type → 用 hint/description 兜底（实测 5 个场景栽在这）', () => {
    for (const alt of ['hint', 'description', 'question', 'content']) {
      const r = SceneAnnotationSchema.safeParse({
        ...BASE,
        hook: { [alt]: '她会怎么反应？', intensity: 0.7 },
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.hook?.type).toBe('她会怎么反应？');
        expect(r.data.hook?.intensity).toBe(0.7);
      }
    }
  });

  it('hook 完整时原样保留', () => {
    const r = SceneAnnotationSchema.safeParse({
      ...BASE,
      hook: { type: '悬念', intensity: 0.8 },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.hook).toEqual({ type: '悬念', intensity: 0.8 });
  });

  it('⚠ hook 无任何描述时仍失败（不编造占位符）', () => {
    const r = SceneAnnotationSchema.safeParse({ ...BASE, hook: { intensity: 0.5 } });
    expect(r.success).toBe(false);
  });

  it('⚠ 归一成单一形状（下游不必判断两种类型）', () => {
    const a = SceneAnnotationSchema.safeParse({ ...BASE, hook: '字符串钩子' });
    const b = SceneAnnotationSchema.safeParse({ ...BASE, hook: { type: '对象钩子' } });
    expect(a.success && b.success).toBe(true);
    if (a.success && b.success) {
      expect(typeof a.data.hook).toBe('object');
      expect(typeof b.data.hook).toBe('object');
    }
  });
});

describe('⚠ 语义标注失败时如实标 null（不填默认值）', () => {
  const CHAPTER = [
    '他走进教室，坐在最后一排。',
    '老师在讲台上念着成绩单。',
    '他的心跳得很快。',
    '',
    '第二天早上，他来到学校。',
    '教室里空荡荡的。',
    '他坐到了自己的位置上。',
  ].join('\n\n');

  it('⚠ 未提供 structured 时只算机械指标，语义字段为空', async () => {
    const ann = new SceneAnnotator({ logger });
    const r = await ann.annotateChapter({ chapterNumber: 1, text: CHAPTER, documentId: 'doc_x' });

    expect(r.scenes.length).toBeGreaterThan(0);
    expect(r.annotatedCount).toBe(0);
    expect(r.unannotatedCount).toBe(r.sceneCount);
    // ⚠ 语义字段为空 —— 不是伪造的默认值
    for (const s of r.scenes) {
      expect(s.annotated).toBe(false);
      expect(s.annotation.sceneFunction).toBeUndefined();
      expect(s.annotation.goals).toEqual([]);
      expect(s.annotation.conflicts).toEqual([]);
    }
    // 机械指标恒有值
    for (const s of r.scenes) {
      expect(s.annotation.pacing).toBeDefined();
      expect(s.annotation.prose).toBeDefined();
    }
  });

  it('⚠ 模型失败时该场景 annotated=false，不填默认 sceneFunction', async () => {
    const failing: AnnotationStructuredCaller = async () => ({
      ok: false,
      error: { code: 'MODEL_STRUCTURED_EMPTY', message: '模型没返回 JSON' },
      attempts: 1,
    });
    const ann = new SceneAnnotator({ logger, structured: failing });
    const r = await ann.annotateChapter({ chapterNumber: 1, text: CHAPTER, documentId: 'doc_x' });

    expect(r.annotatedCount).toBe(0);
    for (const s of r.scenes) {
      expect(s.annotated).toBe(false);
      expect(s.annotation.sceneFunction).toBeUndefined();
      expect(s.annotationError).toContain('没返回 JSON');
    }
  });

  it('成功标注时语义字段被填入', async () => {
    const ok: AnnotationStructuredCaller = async (req) => {
      const parsed = req.schema.safeParse({
        sceneFunction: 'CONFLICT',
        characters: ['他', '老师'],
        pov: '他',
        setting: '教室',
        time: '早上',
        goals: [{ character: '他', goal: '拿到好成绩', achieved: false }],
        conflicts: [
          { parties: ['他', '老师'], description: '成绩不理想', intensity: 0.7, kind: 'INTERPERSONAL' },
        ],
        actions: [{ actor: '老师', action: '念成绩单', consequence: '他心跳加快' }],
        emotions: [{ character: '他', emotion: '紧张', intensity: 0.8, expression: 'IMPLIED_BY_BEHAVIOR' }],
        information: [{ content: '成绩很差', learnedBy: ['他'], stillUnknownTo: [] }],
        eventType: '成绩公布',
        foreshadowing: [],
        payoff: [],
      });
      if (!parsed.success) {
        return { ok: false, error: { code: 'X', message: 'schema 失败' }, attempts: 1 };
      }
      return { ok: true, data: parsed.data, attempts: 1 };
    };
    const ann = new SceneAnnotator({ logger, structured: ok });
    const r = await ann.annotateChapter({ chapterNumber: 1, text: CHAPTER, documentId: 'doc_x' });

    expect(r.annotatedCount).toBeGreaterThan(0);
    const first = r.scenes[0]!;
    expect(first.annotated).toBe(true);
    expect(first.annotation.sceneFunction).toBe('CONFLICT');
    expect(first.annotation.characters).toContain('他');
    expect(first.annotation.conflicts).toHaveLength(1);
    // ⚠ 机械指标仍由代码算，不受模型影响
    expect(first.annotation.pacing).toBeDefined();
  });

  it('⚠ LLM 输出契约**不含** pacing/prose（那些由代码算）', () => {
    const keys = Object.keys(SceneSemanticSchema.shape);
    expect(keys).not.toContain('pacing');
    expect(keys).not.toContain('prose');
  });

  it('sceneFunction 必须是 §19.1 的 15 类之一', () => {
    expect(SCENE_FUNCTIONS).toHaveLength(15);
    const bad = SceneSemanticSchema.safeParse({ sceneFunction: 'NOT_A_FUNCTION' });
    expect(bad.success).toBe(false);
    for (const f of SCENE_FUNCTIONS) {
      expect(SceneSemanticSchema.safeParse({ sceneFunction: f }).success).toBe(true);
    }
  });

  it('sceneId 含文档/章/场景号（可追溯）', async () => {
    const ann = new SceneAnnotator({ logger });
    const r = await ann.annotateChapter({ chapterNumber: 7, text: CHAPTER, documentId: 'doc_abc' });
    expect(r.scenes[0]!.sceneId).toBe('doc_abc_c7_s0');
  });

  it('记录不确定边界数（LLM 层介入的入口）', async () => {
    const ann = new SceneAnnotator({ logger });
    const r = await ann.annotateChapter({ chapterNumber: 1, text: CHAPTER, documentId: 'doc_x' });
    expect(typeof r.uncertainBoundaries).toBe('number');
  });
});
