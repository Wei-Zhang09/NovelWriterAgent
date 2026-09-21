/**
 * Tool 契约（施工文档 §55 Rule 4 + §6.3）
 *
 * Rule 4：任何 Agent Tool 必须有 input schema / output schema / permission / error code。
 * 这四样在类型层强制，缺失即编译不过。
 */
import { z } from 'zod';

/** 工具权限分级（施工文档 §6.4） */
export const ToolPermissionSchema = z.enum(['READ', 'PROPOSE_WRITE', 'WRITE', 'COMMIT', 'ADMIN']);

/** 工具调用上下文：由 Agent Runtime 注入，模型无法伪造 */
export interface ToolContext {
  readonly runId: string;
  readonly projectId: string;
  /** 调用方的权限级别；每个工具声明自身所需级别，由 Registry 比对 */
  readonly callerPermission: z.infer<typeof ToolPermissionSchema>;
  /** 事件记录回调（§55 Rule 8：异常必须落 run_events） */
  readonly emit: (eventType: string, payload?: unknown) => void;
}

/** Tool 定义（不含 execute，便于类型推导时不被实现干扰） */
export interface ToolDefinition<I, O> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly permission: z.infer<typeof ToolPermissionSchema>;
  /** 该工具可能抛出的错误码（§56），用于生成文档与测试断言 */
  readonly errorCodes: readonly string[];
  readonly execute: (input: I, ctx: ToolContext) => Promise<O> | O;
}

/**
 * 异构工具列表的元素类型。
 *
 * 为什么不用 `ToolDefinition<unknown, unknown>`：
 *   TypeScript 的函数参数是**逆变**的，`(input: {id:string}) => X` 不能赋给
 *   `(input: unknown) => X`。因此异构列表必须用一个「擦除泛型」的类型。
 *
 * 为什么这里是安全的：
 *   调用方永远不直接调用 execute —— 一律经 ToolRegistry.invoke()，
 *   由它用 inputSchema.safeParse() 校验后再调用。类型在边界处已由 Zod 保证。
 */
export interface AnyToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown, z.ZodTypeDef, unknown>;
  readonly outputSchema: z.ZodType<unknown, z.ZodTypeDef, unknown>;
  readonly permission: z.infer<typeof ToolPermissionSchema>;
  readonly errorCodes: readonly string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly execute: (input: any, ctx: ToolContext) => unknown;
}

/** 权限比较：调用方权限必须 ≥ 工具要求 */
const RANK: Record<z.infer<typeof ToolPermissionSchema>, number> = {
  READ: 0,
  PROPOSE_WRITE: 1,
  WRITE: 2,
  COMMIT: 3,
  ADMIN: 4,
};

export function permissionSatisfies(
  caller: z.infer<typeof ToolPermissionSchema>,
  required: z.infer<typeof ToolPermissionSchema>,
): boolean {
  return RANK[caller] >= RANK[required];
}

/** 工具调用结果：成功与失败都是结构化数据，不用异常穿透 */
export type ToolResult<O> =
  | { readonly ok: true; readonly data: O; readonly toolName: string; readonly durationMs: number }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
      readonly toolName: string;
      readonly durationMs: number;
    };
