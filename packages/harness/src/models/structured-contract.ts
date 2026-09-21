/**
 * 结构化输出的契约注入（修复真实故障）
 *
 * ## 触发这个问题的事实
 *
 * 真实运行中 Planner 正常，但 **Reviewer 与 Summary 持续失败**：
 *   MODEL_STRUCTURED_EMPTY：ChapterSummary 校验失败：(root): Required
 *   （审稿则直接是未分类错误）
 *
 * 根因：小模型（本地 deepseek-v4-flash）**不会主动输出 JSON**，
 * 除非 prompt 明确要求。而各调用方的 prompt 质量参差：
 *   - Planner 的 prompt 里写了输出契约 → 成功
 *   - Reviewer 只说"请以 ReviewOutput 结构返回"，**没列字段** → 失败
 *   - Summary 的 prompt **完全没提 JSON** → 失败
 *
 * 靠"每个调用方自己记得写清楚"是不可靠的 —— 新加一个 Agent 就会再踩。
 *
 * ## 解决：在 gateway 层统一注入
 *
 * 结构化调用必然要 JSON，这是**调用的性质**，不是调用方的责任。
 * 因此在发送前自动追加一段契约说明，包含：
 *   1. 必须只输出一个 JSON 对象，不要散文、不要 markdown 围栏
 *   2. **具体字段清单与类型**（从 Zod schema 反推）
 *
 * 这样任何调用方（含将来的新 Agent）都自动获得可用的输出。
 */
import type { z } from 'zod';

/** Zod 的第一层类型名 → 人类可读说明 */
function describeZodType(schema: z.ZodTypeAny): string {
  const def = schema._def as { typeName?: string; [k: string]: unknown };
  const name = def.typeName ?? 'unknown';

  switch (name) {
    case 'ZodString':
      return '字符串';
    case 'ZodNumber':
      return '数字';
    case 'ZodBoolean':
      return '布尔值';
    case 'ZodEnum': {
      const values = (def['values'] as string[] | undefined) ?? [];
      return `枚举（取值之一：${values.join(' | ')}）`;
    }
    case 'ZodLiteral':
      return `固定值 ${JSON.stringify(def['value'])}`;
    case 'ZodArray': {
      const inner = describeZodType(def['type'] as z.ZodTypeAny);
      return `数组，每项为：${inner}`;
    }
    case 'ZodOptional':
      return `${describeZodType(def['innerType'] as z.ZodTypeAny)}（可选）`;
    case 'ZodNullable':
      return `${describeZodType(def['innerType'] as z.ZodTypeAny)} 或 null`;
    case 'ZodDefault':
      return `${describeZodType(def['innerType'] as z.ZodTypeAny)}（可省略，有默认值）`;
    case 'ZodObject':
      return '对象';
    case 'ZodRecord':
      return '对象（任意键）';
    case 'ZodUnknown':
    case 'ZodAny':
      return '任意值';
    default:
      return '值';
  }
}

/** 是否为可选字段 */
function isOptional(schema: z.ZodTypeAny): boolean {
  const name = (schema._def as { typeName?: string }).typeName;
  return name === 'ZodOptional' || name === 'ZodDefault';
}

/**
 * 从 Zod schema 生成字段清单文本（**只展开第一层**）。
 *
 * ⚠ 刻意只展开一层：小模型对深层嵌套的对象结构遵从度会显著下降，
 *   而我们的契约里需要精确填写的都是第一层的字段与第一层的数组元素。
 *   更深的结构由 schema 校验兜底，并在失败时触发重试。
 */
export function describeSchemaFields(schema: z.ZodTypeAny): string {
  const def = schema._def as { typeName?: string; shape?: () => Record<string, z.ZodTypeAny> };

  if (def.typeName !== 'ZodObject' || typeof def.shape !== 'function') {
    return `（本契约的顶层类型：${describeZodType(schema)}）`;
  }

  const shape = def.shape();
  const lines: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    const optional = isOptional(field);
    const kind = describeZodType(field);
    lines.push(`  "${key}": ${kind}${optional ? '［可省略］' : ''}`);

    // 数组的元素若是对象，展开其字段（这是最常需要精确填写的一层）
    let inner: z.ZodTypeAny = field;
    const dn = (inner._def as { typeName?: string }).typeName;
    if (dn === 'ZodOptional' || dn === 'ZodDefault') {
      inner = (inner._def as { innerType: z.ZodTypeAny }).innerType;
    }
    const dnn = (inner._def as { typeName?: string }).typeName;
    if (dnn === 'ZodArray') {
      const elem = (inner._def as { type: z.ZodTypeAny }).type;
      const en = (elem._def as { typeName?: string }).typeName;
      if (en === 'ZodObject') {
        const sub = describeSchemaFields(elem)
          .split('\n')
          .map((l) => `      ${l.trim()}`)
          .join('\n');
        lines.push('    每个元素包含：');
        lines.push(sub);
      }
    }
  }
  return lines.join('\n');
}

/** 构造要追加到消息末尾的契约段 */
export function buildStructuredContract(schemaName: string, schema: z.ZodTypeAny): string {
  return [
    '',
    `【输出格式要求（必须严格遵守）】`,
    `只输出**一个 JSON 对象**，不要散文、不要解释、不要 markdown 代码围栏。`,
    `对象名称为 ${schemaName}，字段如下：`,
    describeSchemaFields(schema),
    '',
    '注意：',
    '- 上列**未标注［可省略］**的字段必须全部出现，缺一个就算失败。',
    '- 字段名必须与上面完全一致（区分大小写），不要用中文键名。',
    '- 枚举字段只能取列出的值之一，不要自创。',
  ].join('\n');
}
