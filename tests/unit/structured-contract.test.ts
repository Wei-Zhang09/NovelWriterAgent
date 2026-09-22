/**
 * 结构化输出契约注入测试（修复真实故障）
 *
 * ## 触发这个问题的事实
 *
 * 真实运行：Planner 成功，但 **Reviewer 与 Summary 持续失败**：
 *   MODEL_STRUCTURED_EMPTY：ChapterSummary 校验失败：(root): Required
 *
 * 根因：小模型（本地 deepseek-v4-flash）不会主动输出 JSON，除非 prompt 明确要求。
 * 而各调用方 prompt 质量参差：
 *   - Planner 写了输出契约 → 成功
 *   - Reviewer 只说"请以 ReviewOutput 结构返回"、没列字段 → 失败
 *   - Summary 完全没提 JSON → 失败
 *
 * 靠"每个调用方自己记得写清楚"不可靠 —— 新增 Agent 就会再踩。
 * 因此在 gateway 层统一注入契约。
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildStructuredContract, describeSchemaFields, unwrapSchema } from '@nwa/harness';

describe('契约文本包含必需字段（小模型靠它才知道要输出什么）', () => {
  it('列出全部字段名与类型', () => {
    const s = z.object({ summary: z.string(), count: z.number(), ok: z.boolean() });
    const t = buildStructuredContract('X', s);

    expect(t).toContain('"summary"');
    expect(t).toContain('"count"');
    expect(t).toContain('"ok"');
    expect(t).toContain('字符串');
    expect(t).toContain('数字');
    expect(t).toContain('布尔值');
  });

  it('⚠ 明示"缺一个字段就算失败"（这是 Required 报错的根因）', () => {
    const t = buildStructuredContract('X', z.object({ a: z.string() }));
    expect(t).toContain('必须全部出现');
    expect(t).toContain('缺一个就算失败');
  });

  it('要求只输出 JSON、不要围栏', () => {
    const t = buildStructuredContract('X', z.object({ a: z.string() }));
    expect(t).toContain('只输出**一个 JSON 对象**');
    expect(t).toContain('markdown 代码围栏');
  });

  it('展开数组元素对象的字段（最常需要精确填写的一层）', () => {
    const s = z.object({
      issues: z.array(z.object({ id: z.string(), severity: z.enum(['BLOCKING', 'MINOR']) })),
    });
    const t = buildStructuredContract('ReviewOutput', s);
    expect(t).toContain('每个元素包含');
    expect(t).toContain('"id"');
    expect(t).toContain('"severity"');
    expect(t).toContain('BLOCKING');
  });

  it('枚举列出全部取值（避免模型自创）', () => {
    const t = buildStructuredContract('X', z.object({ s: z.enum(['A', 'B', 'C']) }));
    expect(t).toContain('A | B | C');
  });

  it('标注可选字段（带 default 的字段不该被当成必填）', () => {
    const s = z.object({
      required: z.string(),
      optional: z.string().optional(),
      withDefault: z.array(z.string()).default([]),
    });
    const t = buildStructuredContract('X', s);
    expect(t).toContain('［可省略］');
    // required 那一行不应带可省略标记
    const reqLine = t.split('\n').find((l) => l.includes('"required"'))!;
    expect(reqLine).not.toContain('可省略');
  });

  it('处理 nullable', () => {
    const t = buildStructuredContract('X', z.object({ a: z.string().nullable() }));
    expect(t).toContain('或 null');
  });
});

describe('describeSchemaFields 的具体行为', () => {
  it('对象 schema 输出逐行字段', () => {
    const lines = describeSchemaFields(z.object({ a: z.string(), b: z.number() })).split('\n');
    expect(lines).toHaveLength(2);
  });

  it('非对象 schema 给出说明而不是崩溃', () => {
    const t = describeSchemaFields(z.string());
    expect(t).toContain('顶层类型');
  });

  it('不展开深层嵌套（避免小模型遵从度下降）', () => {
    const s = z.object({
      outer: z.object({ inner: z.object({ deep: z.string() }) }),
    });
    const t = buildStructuredContract('X', s);
    // 只说明 outer 是对象，不列出 inner/deep
    expect(t).toContain('"outer"');
    expect(t).not.toContain('"deep"');
  });
});

describe('⚠ 解开 schema 外层包装（实测踩到）', () => {
  it('z.preprocess 包装后仍能列出字段（否则契约退化成「顶层类型：值」）', () => {
    // 实测场景：RevisionOutputSchema 用 .preprocess 容忍裸数组，
    // 结果顶层变成 ZodEffects，字段清单描述不出来 → 模型看不到要输出什么
    const s = z.preprocess(
      (v) => (Array.isArray(v) ? { edits: v } : v),
      z.object({ edits: z.array(z.object({ find: z.string() })) }),
    );
    const t = buildStructuredContract('RevisionOutput', s);

    expect(t).toContain('"edits"');
    expect(t).toContain('每个元素包含');
    expect(t).toContain('"find"');
    expect(t).not.toContain('顶层类型');
  });

  it('unwrapSchema 取出内部对象', () => {
    const inner = z.object({ a: z.string() });
    const wrapped = z.preprocess((v) => v, inner);
    expect(unwrapSchema(wrapped)).toBe(inner);
  });

  it('未包装的 schema 原样返回', () => {
    const s = z.object({ a: z.string() });
    expect(unwrapSchema(s)).toBe(s);
  });

  it('多层包装也能解开', () => {
    const inner = z.object({ a: z.string() });
    const twice = z.preprocess((v) => v, z.preprocess((v) => v, inner));
    expect(unwrapSchema(twice)).toBe(inner);
  });

  it('普通 schema 的行为完全不受影响', () => {
    const t = buildStructuredContract('X', z.object({ a: z.string() }));
    expect(t).toContain('"a"');
    expect(t).toContain('字符串');
  });
});
