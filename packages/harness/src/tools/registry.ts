/**
 * Tool Registry（施工文档 §6.3 / §55 Rule 4）
 *
 * 这是对 InkOS 的**刻意不同**（研究报告 §1.3 差异 1）：
 *   InkOS 没有 Registry、没有 permission 字段，权限靠「工具在不在数组里」
 *   + session kind 分支隐式表达。实测发现它的
 *   `PRODUCTION_MUTATION_TOOL_NAMES` 与真实工具表**两处维护**，
 *   新增工具容易忘记加入 → 权限泄漏。
 *
 * 我们要求：
 *   1. 每个工具显式声明 permission，Registry 统一比对（单点判定）
 *   2. schema 双向校验（输入 + 输出都校验），不信任工具实现的返回值
 *   3. 任何失败都转成结构化 ToolResult，不让异常穿透
 */
import { AppError, ErrorCode, Logger } from '@nwa/core';
import {
  permissionSatisfies,
  type AnyToolDefinition,
  type ToolContext,
  type ToolDefinition,
  type ToolPermissionSchema,
} from '@nwa/shared';
import type { z } from 'zod';

type Permission = z.infer<typeof ToolPermissionSchema>;

export interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly permission: Permission;
  readonly errorCodes: readonly string[];
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();
  private readonly logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? new Logger('harness:tools');
  }

  /**
   * 注册工具。
   *
   * 拒绝重复注册 —— 静默覆盖会让「注册了哪个版本」变得不可知。
   */
  register<I, O>(tool: ToolDefinition<I, O>): void {
    if (this.tools.has(tool.name)) {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, `工具名重复注册：${tool.name}`);
    }
    if (!tool.name || !/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/.test(tool.name)) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `工具名必须形如 namespace.action（小写驼峰）：${tool.name}`,
      );
    }
    if (tool.errorCodes.length === 0) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `工具必须声明可能的错误码（§55 Rule 4）：${tool.name}`,
      );
    }
    this.tools.set(tool.name, tool as unknown as AnyToolDefinition);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()]
      .map((t) => ({
        name: t.name,
        description: t.description,
        permission: t.permission,
        errorCodes: t.errorCodes,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 生成权限报告（InkOS 因缺此能力而审计困难，见研究报告 §1.3 差异 1） */
  permissionReport(): Record<Permission, string[]> {
    const report: Record<Permission, string[]> = {
      READ: [], PROPOSE_WRITE: [], WRITE: [], COMMIT: [], ADMIN: [],
    };
    for (const t of this.tools.values()) report[t.permission].push(t.name);
    for (const k of Object.keys(report) as Permission[]) report[k].sort();
    return report;
  }

  /**
   * 调用工具。
   *
   * 流程：存在性 → 权限 → 输入校验 → 执行 → 输出校验。
   * 输入/输出校验失败都返回结构化错误，而不是抛异常穿透到调用方。
   */
  async invoke<O = unknown>(name: string, rawInput: unknown, ctx: ToolContext): Promise<
    | { ok: true; data: O; toolName: string; durationMs: number }
    | { ok: false; error: { code: string; message: string; details?: unknown }; toolName: string; durationMs: number }
  > {
    const t0 = Date.now();
    const tool = this.tools.get(name);
    const elapsed = () => Date.now() - t0;

    if (!tool) {
      return {
        ok: false,
        toolName: name,
        durationMs: elapsed(),
        error: { code: ErrorCode.TOOL_VALIDATION_ERROR, message: `未注册的工具：${name}` },
      };
    }

    if (!permissionSatisfies(ctx.callerPermission, tool.permission)) {
      const err = new AppError(
        ErrorCode.TOOL_PERMISSION_DENIED,
        `权限不足：${name} 需要 ${tool.permission}，调用方为 ${ctx.callerPermission}`,
        { details: { tool: name, required: tool.permission, caller: ctx.callerPermission } },
      );
      this.logger.warn('工具权限被拒', { tool: name, required: tool.permission, caller: ctx.callerPermission });
      return { ok: false, toolName: name, durationMs: elapsed(), error: err.toJSON() };
    }

    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const err = new AppError(ErrorCode.TOOL_VALIDATION_ERROR, `输入校验失败：${name}`, {
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return { ok: false, toolName: name, durationMs: elapsed(), error: err.toJSON() };
    }

    let out: unknown;
    try {
      out = await tool.execute(parsed.data, ctx);
    } catch (caught) {
      // 不吞异常：转成结构化结果，并保证调用方能拿到原始错误码与信息
      const err = AppError.from(caught);
      this.logger.error(`工具执行失败：${name}`, caught, { tool: name });
      return { ok: false, toolName: name, durationMs: elapsed(), error: err.toJSON() };
    }

    // 输出也校验 —— 不信任工具实现返回的结构（Rule 4 的另一半）
    const outParsed = tool.outputSchema.safeParse(out);
    if (!outParsed.success) {
      const err = new AppError(ErrorCode.TOOL_VALIDATION_ERROR, `输出校验失败：${name}`, {
        details: outParsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      this.logger.error(`工具输出不合契约：${name}`, undefined, { tool: name });
      return { ok: false, toolName: name, durationMs: elapsed(), error: err.toJSON() };
    }

    return { ok: true, data: outParsed.data as O, toolName: name, durationMs: elapsed() };
  }
}
