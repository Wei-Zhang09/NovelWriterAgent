/**
 * 模式挖掘测试（施工文档 §20 / §21）
 *
 * ## 这组测试的核心
 *
 * 1. ⚠ **证据必须可回溯** —— 模型编造的编号会导致整条模式被丢弃
 *    （不是修补成"看起来有依据"，那比丢弃更危险）
 * 2. ⚠ **单作品模式必须降档** —— 只有 1 部作品支持的无法区分
 *    "叙事规律"与"这个作者的癖好"
 * 3. ⚠ **类型隔离** —— 写都市时不该拿到仙侠的 GENRE 模式
 * 4. ⚠ **七槽必须填满** —— 可选槽位会让模型走捷径
 * 5. ⚠ **空结果优于编造** —— 没有共性时返回空数组是正确行为
 */
import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nwa/core';
import {
  PatternMiner,
  sampleEvenly,
  discountBySample,
  MinedPatternSchema,
  type MinedPattern,
} from '@nwa/distillation';
import { analyzeCrossWork, resolveScope, filterByGenre } from '@nwa/distillation';
import type { CorpusSceneRow } from '@nwa/storage';

const logger = new Logger({ level: 'error', scope: 'test:mine' });

function scene(over: Partial<CorpusSceneRow> & { id: string }): CorpusSceneRow {
  return {
    document_id: 'doc_a',
    chapter_number: 1,
    scene_index: 0,
    text_path: `scenes/${over.id}.md`,
    scene_type: 'CONFLICT',
    annotation_json: '{}',
    created_at: '2026-01-01T00:00:00Z',
    annotated: 1,
    scene_function: 'CONFLICT',
    genre: '都市',
    ...over,
  } as CorpusSceneRow;
}

/** 构造一个返回指定模式的假 caller */
function fakeCaller(patterns: Partial<MinedPattern>[]) {
  return vi.fn(async () => ({
    ok: true as const,
    data: { patterns },
    attempts: 1,
  }));
}

const GOOD: Partial<MinedPattern> = {
  trigger: '冲突前先给读者信息差',
  context: ['读者知道角色不知道的事'],
  decision: ['让角色基于错误认知行动', '把真相留到下一场景'],
  mechanism: '读者因信息差产生焦虑，从而持续阅读',
  effect: ['张力上升'],
  boundary: ['不要在读者已猜到真相时继续拖'],
  evidence: ['S1'],
  confidence: 0.8,
  scope: 'GENRE',
};

describe('§20 七槽契约', () => {
  it('⚠ 七个槽位全部必填（可选槽位会让模型走捷径）', () => {
    // 少一个槽位应当解析失败
    for (const missing of [
      'trigger',
      'context',
      'decision',
      'mechanism',
      'effect',
      'boundary',
      'evidence',
    ] as const) {
      const bad = { ...GOOD } as Record<string, unknown>;
      delete bad[missing];
      expect(MinedPatternSchema.safeParse(bad).success).toBe(false);
    }
    expect(MinedPatternSchema.safeParse(GOOD).success).toBe(true);
  });

  it('⚠ boundary 不能为空数组（防滥用是硬要求）', () => {
    expect(MinedPatternSchema.safeParse({ ...GOOD, boundary: [] }).success).toBe(false);
  });

  it('scope 只能是三档之一', () => {
    expect(MinedPatternSchema.safeParse({ ...GOOD, scope: 'UNIVERSAL' }).success).toBe(true);
    expect(MinedPatternSchema.safeParse({ ...GOOD, scope: 'WHATEVER' }).success).toBe(false);
  });
});

describe('⚠ 证据必须可回溯（§46）', () => {
  it('⚠ 证据编号不存在 → 整条模式被丢弃（不修补）', async () => {
    // 模型声称证据是 S9，但只给了 3 个场景
    const caller = fakeCaller([{ ...GOOD, evidence: ['S9', 'S99'] }]);
    const miner = new PatternMiner({ logger, structured: caller as never });

    const r = await miner.mineGroup({
      scenes: [scene({ id: 'sc1' }), scene({ id: 'sc2' }), scene({ id: 'sc3' })],
      sceneFunction: 'CONFLICT',
      textOf: () => '正文内容',
      genre: '都市',
    });

    // ⚠ 丢弃而非修补：编造证据说明这条模式可能是幻觉产物
    expect(r.patterns.length).toBe(0);
  });

  it('证据编号存在 → 映射回真实 sceneId', async () => {
    const caller = fakeCaller([{ ...GOOD, evidence: ['S1', 'S3'] }]);
    const miner = new PatternMiner({ logger, structured: caller as never });

    const r = await miner.mineGroup({
      scenes: [scene({ id: 'sc1' }), scene({ id: 'sc2' }), scene({ id: 'sc3' })],
      sceneFunction: 'CONFLICT',
      textOf: () => '正文内容',
      genre: '都市',
    });

    expect(r.patterns.length).toBe(1);
    expect(r.patterns[0]!.evidenceSceneIds).toEqual(['sc1', 'sc3']);
    expect(r.patterns[0]!.droppedEvidence).toEqual([]);
  });

  it('部分编号无效 → 保留有效的，但**如实记录**丢弃的', async () => {
    const caller = fakeCaller([{ ...GOOD, evidence: ['S1', 'S7'] }]);
    const miner = new PatternMiner({ logger, structured: caller as never });

    const r = await miner.mineGroup({
      scenes: [scene({ id: 'sc1' }), scene({ id: 'sc2' })],
      sceneFunction: 'CONFLICT',
      textOf: () => '正文内容',
      genre: '都市',
    });

    expect(r.patterns.length).toBe(1);
    expect(r.patterns[0]!.evidenceSceneIds).toEqual(['sc1']);
    // ⚠ 不静默丢弃 —— 记录模型编造了什么
    expect(r.patterns[0]!.droppedEvidence).toEqual(['S7']);
  });

  it('证据写成 [S1] 或小写 s1 也能识别（格式容错）', async () => {
    const caller = fakeCaller([{ ...GOOD, evidence: ['[S1]', 's2'] }]);
    const miner = new PatternMiner({ logger, structured: caller as never });

    const r = await miner.mineGroup({
      scenes: [scene({ id: 'sc1' }), scene({ id: 'sc2' })],
      sceneFunction: 'CONFLICT',
      textOf: () => '正文内容',
      genre: '都市',
    });

    expect(r.patterns[0]!.evidenceSceneIds).toEqual(['sc1', 'sc2']);
  });
});

describe('⚠ 类型隔离（§21）', () => {
  it('filterByGenre 归一化后比较（修仙 与 仙侠 同类）', () => {
    const scenes = [
      scene({ id: 'a', genre: '修仙' }),
      scene({ id: 'b', genre: '都市' }),
      scene({ id: 'c', genre: '仙侠' }),
    ];
    // 查"仙侠"应同时命中"修仙"
    expect(filterByGenre(scenes, '仙侠').map((s) => s.id)).toEqual(['a', 'c']);
    expect(filterByGenre(scenes, '都市').map((s) => s.id)).toEqual(['b']);
  });

  it('genre 为 null 时不过滤（返回全部）', () => {
    const scenes = [scene({ id: 'a', genre: '修仙' }), scene({ id: 'b', genre: '都市' })];
    expect(filterByGenre(scenes, null).length).toBe(2);
  });
});

describe('⚠ 跨作品分析：单作品不能冒充类型规律', () => {
  it('识别只有单作品支持的组', () => {
    const scenes = [
      scene({ id: 'a', document_id: 'doc_a', scene_function: 'CONFLICT' }),
      scene({ id: 'b', document_id: 'doc_a', scene_function: 'CONFLICT' }),
      scene({ id: 'c', document_id: 'doc_b', scene_function: 'SETUP' }),
    ];
    const a = analyzeCrossWork(scenes);
    expect(a.singleWorkGroups).toBe(2);
    expect(a.comparableGroups).toBe(0);
    expect(a.coverage.find((c) => c.sceneFunction === 'CONFLICT')!.documents).toBe(1);
  });

  it('≥2 部作品才算可跨作品对比', () => {
    const scenes = [
      scene({ id: 'a', document_id: 'doc_a' }),
      scene({ id: 'b', document_id: 'doc_b' }),
    ];
    const a = analyzeCrossWork(scenes);
    expect(a.comparableGroups).toBe(1);
    expect(a.coverage[0]!.crossWork).toBe(true);
  });

  it('无 sceneFunction 的场景不参与分组', () => {
    const scenes = [scene({ id: 'a', scene_function: null })];
    expect(analyzeCrossWork(scenes).coverage.length).toBe(0);
  });
});

describe('⚠ resolveScope：按作品数覆盖模型自报的作用域', () => {
  it('⚠ 单作品 → 降档为 STYLE（无法区分规律与作者癖好）', () => {
    const r = resolveScope('UNIVERSAL', 1);
    expect(r.scope).toBe('STYLE');
    expect(r.reason).toContain('1 部作品');
  });

  it('2 部作品 + 模型说 UNIVERSAL → 降为 GENRE（证据不足）', () => {
    expect(resolveScope('UNIVERSAL', 2).scope).toBe('GENRE');
  });

  it('2 部作品 + 模型说 GENRE → 尊重模型判断', () => {
    expect(resolveScope('GENRE', 2).scope).toBe('GENRE');
  });

  it('≥3 部作品 → 尊重模型判断', () => {
    expect(resolveScope('UNIVERSAL', 3).scope).toBe('UNIVERSAL');
  });
});

describe('⚠ 置信度按样本量折扣', () => {
  it('样本越少折扣越大（防止抽样偏差冒充普遍规律）', () => {
    // n<5 折半
    expect(discountBySample(0.9, 3)).toBe(0.45);
    // n=5~7 折 0.65
    expect(discountBySample(0.9, 6)).toBeCloseTo(0.59, 2);
    // n=8~14 折 0.8
    expect(discountBySample(0.9, 10)).toBeCloseTo(0.72, 2);
    // n>=15 不打折
    expect(discountBySample(0.9, 20)).toBe(0.9);
  });

  it('⚠ 宁可低估：3 个样本的 0.9 不该与 20 个样本同权', () => {
    expect(discountBySample(0.9, 3)).toBeLessThan(discountBySample(0.9, 20));
  });
});

describe('均匀抽样（避免模式只反映作品开头）', () => {
  it('超过上限时均匀取样而非取前 N', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const s = sampleEvenly(items, 5);
    expect(s.length).toBe(5);
    // 应覆盖到末尾，而非只取前 5 个
    expect(s[s.length - 1]).toBeGreaterThan(10);
    // 第一个仍是开头
    expect(s[0]).toBe(0);
  });

  it('不超过上限时原样返回', () => {
    expect(sampleEvenly([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });
});

describe('⚠ 失败要如实上报，不吞', () => {
  it('调用失败时该组返回 error（不伪装成"没模式"）', async () => {
    const caller = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'MODEL_TIMEOUT', message: '超时了' },
      attempts: 3,
    }));
    const miner = new PatternMiner({ logger, structured: caller as never });

    const r = await miner.mineGroup({
      scenes: [scene({ id: 'sc1' })],
      sceneFunction: 'CONFLICT',
      textOf: () => '正文',
      genre: '都市',
    });

    expect(r.patterns.length).toBe(0);
    expect(r.error).toContain('超时');
  });

  it('⚠ 空数组是合法结果（没有共性时不该硬凑）', async () => {
    const caller = fakeCaller([]);
    const miner = new PatternMiner({ logger, structured: caller as never });

    const r = await miner.mineGroup({
      scenes: [scene({ id: 'sc1' })],
      sceneFunction: 'CONFLICT',
      textOf: () => '正文',
      genre: '都市',
    });

    expect(r.patterns.length).toBe(0);
    expect(r.error).toBeUndefined();
  });

  it('mine() 汇总失败组数', async () => {
    let n = 0;
    const caller = vi.fn(async () => {
      n++;
      if (n === 1) return { ok: false as const, error: { code: 'X', message: '炸了' }, attempts: 1 };
      return { ok: true as const, data: { patterns: [{ ...GOOD, evidence: ['S1'] }] }, attempts: 1 };
    });
    const miner = new PatternMiner({ logger, structured: caller as never });

    const r = await miner.mine({
      scenes: [
        scene({ id: 'a', scene_function: 'CONFLICT' }),
        scene({ id: 'b', scene_function: 'SETUP' }),
      ],
      textOf: () => '正文',
      genre: '都市',
    });

    expect(r.groups).toBe(2);
    expect(r.failedGroups).toBe(1);
    expect(r.failures.length).toBe(1);
    expect(r.patterns.length).toBe(1);
  });
});

describe('⚠ maxGroups 必须真的生效（声明了却不生效比没有更糟）', () => {
  it('maxGroups=1 时只挖 1 组（不让调用方对代价有错误预期）', async () => {
    const caller = fakeCaller([{ ...GOOD, evidence: ['S1'] }]);
    const miner = new PatternMiner({ logger, structured: caller as never });

    const r = await miner.mine({
      scenes: [
        scene({ id: 'a', scene_function: 'CONFLICT' }),
        scene({ id: 'b', scene_function: 'SETUP' }),
        scene({ id: 'c', scene_function: 'COOLDOWN' }),
      ],
      textOf: () => '正文',
      genre: '都市',
      maxGroups: 1,
    });

    expect(r.groups).toBe(1);
    // 只调用了一次模型
    expect(caller).toHaveBeenCalledTimes(1);
  });

  it('maxGroups=0 视为"全部"（0 表示不限制，不是"一组都不挖"）', async () => {
    const caller = fakeCaller([{ ...GOOD, evidence: ['S1'] }]);
    const miner = new PatternMiner({ logger, structured: caller as never });

    const r = await miner.mine({
      scenes: [
        scene({ id: 'a', scene_function: 'CONFLICT' }),
        scene({ id: 'b', scene_function: 'SETUP' }),
      ],
      textOf: () => '正文',
      genre: '都市',
      maxGroups: 0,
    });

    expect(r.groups).toBe(2);
  });

  it('不传 maxGroups 时挖全部', async () => {
    const caller = fakeCaller([{ ...GOOD, evidence: ['S1'] }]);
    const miner = new PatternMiner({ logger, structured: caller as never });

    const r = await miner.mine({
      scenes: [
        scene({ id: 'a', scene_function: 'CONFLICT' }),
        scene({ id: 'b', scene_function: 'SETUP' }),
        scene({ id: 'c', scene_function: 'COOLDOWN' }),
      ],
      textOf: () => '正文',
      genre: '都市',
    });

    expect(r.groups).toBe(3);
  });
});

describe('分组挖掘', () => {
  it('⚠ 无 sceneFunction 的场景被跳过（不归入 unknown）', async () => {
    const caller = fakeCaller([{ ...GOOD, evidence: ['S1'] }]);
    const miner = new PatternMiner({ logger, structured: caller as never });

    const r = await miner.mine({
      scenes: [
        scene({ id: 'a', scene_function: 'CONFLICT' }),
        scene({ id: 'b', scene_function: null }),
      ],
      textOf: () => '正文',
      genre: '都市',
    });

    // 只有 CONFLICT 一组 —— 归入 unknown 会挖出"杂项场景的共性"，
    // 那是统计噪声不是叙事规律
    expect(r.groups).toBe(1);
  });
});
