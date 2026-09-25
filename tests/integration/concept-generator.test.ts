/**
 * 选题方向生成（开书向导 Phase 1）
 *
 * ## 用户诉求
 * > 「配置 AI 生成大纲角色等等相关功能，再由用户进行**选择**、修改」
 *
 * ## 这个测试真正在防什么
 *
 * 不是"函数返回了候选"（那是同义反复），而是**"选择"这个动作是否成立**。
 *
 * 实测最容易出的问题：模型在"给多个候选"的任务上给出
 * **同一个方向的三种说法** —— 措辞不同、卖点相同。
 * 界面显示"生成了 3 个候选"，作者却挑不出东西。
 * 这比只给 1 个候选**更糟**，因为它假装给了选择。
 *
 * 所以本测试的重点是：
 *   ① 候选同题材 / 同 pitch → 必须被检出并触发修复重试
 *   ② 占位符（待确认/TODO）→ 必须被检出（本项目 Planner 的实测教训）
 *   ③ 修复重试**耗尽后不抛错**，返回结果 + issues
 *      （"候选相近"不是"结果不可用"，判断权交给界面）
 *   ④ 结构化输出失败**不重试**（那是模型没按契约输出，重试无用）
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConceptOutputSchema,
  validateConceptSemantics,
  type ConceptOutput,
} from '@nwa/shared';
import { ConceptGenerator, renderRequest } from '@nwa/writing';
import type { StructuredResult } from '@nwa/harness';

/** 造一个合法候选 */
function cand(over: Partial<ConceptOutput['candidates'][0]> = {}) {
  return {
    pitch: '退役拳手回小城开拳馆，却发现徒弟在打地下黑拳',
    genre: '都市',
    coreEmotion: '意难平',
    protagonist: '陈默，三十六岁，右手有旧伤',
    coreConflict: '他想保护徒弟，但徒弟要的正是他放弃过的那条路',
    differentiation: '同类书主角一路赢，这本主角每赢一次就失去一个记忆',
    estimatedChapters: 200,
    ...over,
  };
}

/** 造一个成功响应 */
function ok(data: unknown, attempts = 1): StructuredResult<never> {
  return { ok: true, data, attempts, usedFallback: false } as unknown as StructuredResult<never>;
}

/** 造一个失败响应 */
function fail(code: string, msg: string): StructuredResult<never> {
  return {
    ok: false,
    error: { code, message: msg },
    attempts: 1,
    usedFallback: false,
    rawText: 'not json',
  } as unknown as StructuredResult<never>;
}

describe('① 语义校验：候选必须真的可选', () => {
  it('三个真正不同的候选 → 无问题', () => {
    const out: ConceptOutput = {
      candidates: [
        cand(),
        cand({
          pitch: '殡仪馆化妆师能看见死者最后一段记忆',
          genre: '悬疑',
          coreConflict: '他靠这个能力破案，但每看一次就少一段自己的记忆',
        }),
      ],
    };
    expect(validateConceptSemantics(out)).toEqual([]);
  });

  it('⚠ 全部候选同题材 → 检出（作者无从选择）', () => {
    const out: ConceptOutput = {
      candidates: [
        cand({ pitch: 'A 方向' }),
        cand({ pitch: 'B 方向' }),
        cand({ pitch: 'C 方向' }),
      ],
    };
    const issues = validateConceptSemantics(out);
    expect(issues.some((i) => i.includes('都市') && i.includes('无从选择'))).toBe(true);
  });

  it('⚠ 两个候选 pitch 完全相同 → 检出', () => {
    const out: ConceptOutput = {
      candidates: [cand({ genre: '都市' }), cand({ genre: '悬疑' })],
    };
    const issues = validateConceptSemantics(out);
    expect(issues.some((i) => i.includes('完全相同'))).toBe(true);
  });

  it('⚠ 占位符文本 → 检出（本项目 Planner 的实测教训）', () => {
    const out: ConceptOutput = {
      candidates: [
        cand({ pitch: '待确认：主角的身世背景' }),
        cand({ pitch: 'B 方向', genre: '悬疑' }),
      ],
    };
    const issues = validateConceptSemantics(out);
    expect(issues.some((i) => i.includes('占位文本'))).toBe(true);
  });
});

describe('② 生成流程：修复重试与失败语义', () => {
  it('一次成功 → 不重试', async () => {
    const structured = vi.fn().mockResolvedValue(
      ok({
        candidates: [cand(), cand({ genre: '悬疑', pitch: '殡仪馆化妆师能看见死者记忆' })],
      }),
    );
    const gen = new ConceptGenerator({ structured });
    const r = await gen.generate({ desiredEmotion: '意难平' });

    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.output?.candidates.length).toBe(2);
    expect(structured).toHaveBeenCalledTimes(1);
  });

  it('⚠ 候选同题材 → 触发修复重试，第二次给出不同题材则通过', async () => {
    const structured = vi
      .fn()
      // 第一次：三个同题材
      .mockResolvedValueOnce(
        ok({ candidates: [cand({ pitch: 'A' }), cand({ pitch: 'B' })] }),
      )
      // 第二次：不同题材
      .mockResolvedValueOnce(
        ok({
          candidates: [cand({ pitch: 'A' }), cand({ pitch: 'B', genre: '悬疑' })],
        }),
      );

    const gen = new ConceptGenerator({ structured });
    const r = await gen.generate({});

    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(r.issues).toBeUndefined();
    expect(structured).toHaveBeenCalledTimes(2);

    // ⚠ 修复指令必须真的被追加进消息里 —— 否则"重试"只是重发同一份提示词，
    //   模型多半会给出同样的结果，重试等于白烧配额。
    const secondCall = structured.mock.calls[1]![0] as { messages: { content: string }[] };
    const lastMsg = secondCall.messages[secondCall.messages.length - 1]!.content;
    expect(lastMsg).toContain('无从选择');
  });

  it('⚠⚠ 修复耗尽后不抛错：返回结果 + issues（判断权交给界面）', async () => {
    // 模型两次都给同题材 —— 这是真实会发生的
    const structured = vi
      .fn()
      .mockResolvedValue(ok({ candidates: [cand({ pitch: 'A' }), cand({ pitch: 'B' })] }));

    const gen = new ConceptGenerator({ structured });
    const r = await gen.generate({});

    expect(r.ok).toBe(true); // ⚠ 不是 false —— 候选可用，只是有瑕疵
    expect(r.output?.candidates.length).toBe(2);
    expect(r.issues?.length).toBeGreaterThan(0);
    expect(r.attempts).toBe(2); // 1 次原始 + 1 次修复
  });

  it('⚠ 结构化输出失败 → 不重试（重发同样提示词无用）', async () => {
    const structured = vi.fn().mockResolvedValue(fail('MODEL_STRUCTURED_EMPTY', '模型没输出 JSON'));
    const gen = new ConceptGenerator({ structured });
    const r = await gen.generate({});

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('MODEL_STRUCTURED_EMPTY');
    expect(structured).toHaveBeenCalledTimes(1);
    // 失败时必须带上原始输出片段，否则无法区分"形状错"与"被截断"
    expect((r.error?.details as { rawTextHead?: string })?.rawTextHead).toBe('not json');
  });

  it('语义修复次数可配置；设为 0 时只试一次', async () => {
    const structured = vi
      .fn()
      .mockResolvedValue(ok({ candidates: [cand({ pitch: 'A' }), cand({ pitch: 'B' })] }));
    const gen = new ConceptGenerator({ structured, maxSemanticRepair: 0 });
    const r = await gen.generate({});
    expect(structured).toHaveBeenCalledTimes(1);
    expect(r.issues?.length).toBeGreaterThan(0);
  });
});

describe('③ 请求渲染', () => {
  it('⚠ 空字段不渲染成「（未提供）」—— 那会让模型盯着缺什么', () => {
    const text = renderRequest({ desiredEmotion: '爽感' });
    expect(text).toContain('爽感');
    expect(text).not.toContain('未提供');
    expect(text).not.toContain('（空）');
  });

  it('完全没给信息也要能生成（信息不足就由你决定）', () => {
    const text = renderRequest({});
    expect(text).toContain('未提供任何偏好信息');
    expect(text).toContain('自主');
  });
});

describe('④ schema 契约', () => {
  it('候选数下限 2、上限 3（保证"选择"有意义且质量不稀释）', () => {
    expect(ConceptOutputSchema.safeParse({ candidates: [cand()] }).success).toBe(false);
    // ⚠ pitch 有 min(5) —— 用 1 字符的 'A' 会被拒，那是长度约束不是数量约束
    expect(
      ConceptOutputSchema.safeParse({
        candidates: [
          cand({ pitch: '方向甲的具体卖点' }),
          cand({ pitch: '方向乙的具体卖点' }),
          cand({ pitch: '方向丙的具体卖点' }),
        ],
      }).success,
    ).toBe(true);
    expect(
      ConceptOutputSchema.safeParse({
        candidates: [
          cand({ pitch: '方向甲的具体卖点' }),
          cand({ pitch: '方向乙的具体卖点' }),
          cand({ pitch: '方向丙的具体卖点' }),
          cand({ pitch: '方向丁的具体卖点' }),
        ],
      }).success,
    ).toBe(false);
  });

  it('estimatedChapters 越界被拒（10-5000）', () => {
    expect(ConceptOutputSchema.safeParse({ candidates: [cand({ estimatedChapters: 5 }), cand()] }).success).toBe(false);
  });
});
