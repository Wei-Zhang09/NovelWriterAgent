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
import { buildStructuredContract, describeSchemaFields, unwrapSchema, extractJson } from '@nwa/harness';

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

  it('⚠ 列出深层嵌套里的枚举取值（模型无法猜出合法值）', () => {
    // 实测踩到：技能编译 7 个组全部作废 —— 模型自创了
    // RELATIONSHIP / INTRODUCE / GROUP_SCENE / DAILY_LIFE 等
    // 不存在的场景类型。因为契约只说"用大写枚举"，没列取值。
    const s = z.object({
      trigger: z.object({
        sceneTypes: z.array(z.enum(['CONFLICT', 'SETUP'])),
        genres: z.array(z.string()),
      }),
    });
    const t = buildStructuredContract('X', s);

    // 枚举取值必须出现（路径 + 取值）
    expect(t).toContain('trigger.sceneTypes');
    expect(t).toContain('CONFLICT');
    expect(t).toContain('SETUP');
    expect(t).toContain('枚举字段的合法取值');
  });

  it('⚠ 枚举取值列出但对象结构仍保持浅（两者不冲突）', () => {
    const s = z.object({
      outer: z.object({ inner: z.object({ mode: z.enum(['A', 'B']) }) }),
    });
    const t = buildStructuredContract('X', s);
    // 结构不展开（尊重小模型遵从度的既有取舍）
    expect(t).not.toContain('"inner"');
    // 但枚举取值仍要列（否则模型只能编）
    expect(t).toContain('outer.inner.mode');
    expect(t).toContain('A | B');
  });

  it('数组里的枚举也列出', () => {
    const s = z.object({ items: z.array(z.enum(['X', 'Y'])) });
    expect(buildStructuredContract('X', s)).toContain('X | Y');
  });

  it('preprocess 包装后的枚举仍能列出', () => {
    const s = z.preprocess(
      (v) => v,
      z.object({ scope: z.enum(['UNIVERSAL', 'GENRE', 'STYLE']) }),
    );
    const t = buildStructuredContract('X', s);
    expect(t).toContain('UNIVERSAL | GENRE | STYLE');
  });

  it('没有枚举时不留空段', () => {
    const t = buildStructuredContract('X', z.object({ a: z.string() }));
    expect(t).not.toContain('枚举字段的合法取值');
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


describe('⚠ extractJson 区分「截断」与「不是 JSON」（实测踩到）', () => {
  it('正常的 JSON 能解析', () => {
    expect(extractJson('{"edits":[]}')).toEqual({ edits: [] });
  });

  it('围栏包裹的 JSON 能解析', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('⚠ 被截断的 JSON 抛出 TruncatedOutputError（不是返回 undefined）', () => {
    // 实测：edits 数组太长被 maxTokens 砍断，
    // 三种解析全部失败 → 返回 undefined → schema 报 `(root): Required`，
    // 看起来像"模型没给 edits 字段"，实际是输出被截断。
    // 报错误导会让人去改 prompt，而真正该做的是调大 maxTokens。
    const truncated = '{\n  "edits": [\n    {\n      "find": "他继续走。探杖点一下，脚跟着落一下';
    expect(() => extractJson(truncated)).toThrow(/截断/);
  });

  it('截断错误带 head/tail/length 便于诊断', () => {
    const truncated = '{"edits":[{"find":"很长的内容'.repeat(3);
    try {
      extractJson(truncated);
      expect.unreachable('应当抛出');
    } catch (e) {
      expect((e as Error).message).toContain('maxTokens');
      expect((e as { details: { length: number } }).details.length).toBeGreaterThan(0);
    }
  });

  it('不是 JSON 的散文仍返回 undefined（不误判为截断）', () => {
    expect(extractJson('这是一段散文，没有任何结构。')).toBeUndefined();
  });

  it('完整但字段不对的 JSON 不报截断（交给 schema 校验）', () => {
    expect(extractJson('{"wrong":1}')).toEqual({ wrong: 1 });
  });

  it('括号闭合的 JSON 不报截断', () => {
    expect(extractJson('{"a":[1,2,3]}')).toEqual({ a: [1, 2, 3] });
  });

  it('字符串里的括号不干扰深度计算', () => {
    expect(extractJson('{"a":"{未闭合"}')).toEqual({ a: '{未闭合' });
  });
});
