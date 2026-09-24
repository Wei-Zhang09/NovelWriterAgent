/**
 * 世界观设定工具（P2-3）
 *
 * ## ⚠ 为什么补这个文件
 *
 * `world_entities` 表在 `0001_init.sql:214` 就建好了，但**全仓零引用**
 * （P2-3 核查：引用次数 = 0）。ADR-0003 当时列为「Schema 预留，MVP 不写入」——
 * 预留合理，但到 Full 阶段就成了"表在那里，没人用"。
 *
 * 与 `character.create`（P2-2 补上）、`timeline`（P0-5 补上）同一类缺陷：
 * 底层表齐备，使用者够不到。
 *
 * ## 为什么世界观不走 `facts`（虽然 character-tools 的注释说可以）
 *
 * `character-tools.ts` 的注释写「add world rule 用 facts 的
 * subjectType='WORLD'」—— 那对**单条规则**（"灵力不可再生"）是合适的。
 * 但世界观设定整体是一份**作者要先写完、确认、再开写**的文档，
 * 它需要：
 *   - 分门别类（地理 / 势力 / 规则 / 器物）
 *   - 编辑与排序（作者会反复改）
 *   - 一个整体的"确认"动作
 * facts 是**逐条事实 + 证据 + Canon 推进**的模型，用来承载一份
 * 待编辑的设定文档会把两件事混在一起。
 *
 * 所以分工是：
 *   - `world.*` 工具 → 作者手写的**设定草稿**（可编辑，DRAFT/CONFIRMED）
 *   - `fact.*` 工具 → 从正文里**推断出的**事实（有证据，走 Canon 推进）
 * 两者不重复：设定是"作者定的规矩"，事实是"正文里发生过什么"。
 */
import { z } from 'zod';
import { ErrorCode, worldEntityId } from '@nwa/core';
import type { Repositories } from '@nwa/storage';
import type { AnyToolDefinition } from '@nwa/shared';

/** 设定种类。用固定枚举而不是自由字符串 —— 自由字符串会让分类退化成摆设 */
export const WORLD_TYPES = [
  'WORLD_RULE',
  'LOCATION',
  'FACTION',
  'ITEM',
  'CONCEPT',
  'CUSTOM',
] as const;

export function createWorldTools(repos: Repositories): AnyToolDefinition[] {
  const create: AnyToolDefinition = {
    name: 'world.create',
    description:
      '登记一条世界观设定（地理 / 势力 / 规则 / 器物 / 概念）。' +
      '新建的设定是 DRAFT（草稿）；作者确认后才成为 Agent 写作的依据。',
    inputSchema: z.object({
      bookId: z.string().min(1),
      type: z.enum(WORLD_TYPES),
      name: z.string().min(1, '设定名称不得为空'),
      description: z.string().optional(),
      data: z.unknown().optional(),
    }),
    outputSchema: z.object({
      worldEntityId: z.string(),
      name: z.string(),
      status: z.string(),
    }),
    permission: 'WRITE',
    errorCodes: [ErrorCode.TOOL_VALIDATION_ERROR, ErrorCode.STORAGE_QUERY_FAILED],
    execute: (input: {
      bookId: string;
      type: (typeof WORLD_TYPES)[number];
      name: string;
      description?: string;
      data?: unknown;
    }) => {
      const row = repos.world.create({
        id: worldEntityId(),
        bookId: input.bookId,
        type: input.type,
        name: input.name.trim(),
        description: input.description ?? null,
        ...(input.data !== undefined ? { data: input.data } : {}),
      });
      return { worldEntityId: row.id, name: row.name, status: row.status };
    },
  };

  const list: AnyToolDefinition = {
    name: 'world.list',
    description: '列出某本书的全部世界观设定（含每条的状态与当前确认判定）。',
    inputSchema: z.object({ bookId: z.string().min(1) }),
    outputSchema: z.object({ entities: z.array(z.unknown()) }),
    permission: 'READ',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
    execute: ({ bookId }: { bookId: string }) => ({
      entities: repos.world.listByBook(bookId).map((r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        description: r.description,
        status: r.status,
        ord: r.ord,
      })),
    }),
  };

  const update: AnyToolDefinition = {
    name: 'world.update',
    description:
      '修改一条世界观设定。⚠ 修改已确认的设定会让整本书退回「未确认」——' +
      '这是刻意的：否则作者可以在 Agent 按设定写到一半时偷偷改设定。',
    inputSchema: z.object({
      worldEntityId: z.string().min(1),
      type: z.enum(WORLD_TYPES).optional(),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      data: z.unknown().optional(),
    }),
    outputSchema: z.object({ worldEntityId: z.string(), updated: z.boolean() }),
    permission: 'WRITE',
    errorCodes: [
      ErrorCode.TOOL_VALIDATION_ERROR,
      ErrorCode.STORAGE_QUERY_FAILED,
    ],
    execute: (input: {
      worldEntityId: string;
      type?: (typeof WORLD_TYPES)[number];
      name?: string;
      description?: string;
      data?: unknown;
    }) => {
      const patch: {
        type?: string;
        name?: string;
        description?: string;
        data?: unknown;
      } = {};
      if (input.type !== undefined) patch.type = input.type;
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.description !== undefined) patch.description = input.description;
      if (input.data !== undefined) patch.data = input.data;
      if (Object.keys(patch).length === 0) {
        throw new Error('没有要更新的字段');
      }
      const row = repos.world.update(input.worldEntityId, patch);
      return { worldEntityId: row.id, updated: true };
    },
  };

  const remove: AnyToolDefinition = {
    name: 'world.remove',
    description: '删除一条世界观设定。',
    inputSchema: z.object({ worldEntityId: z.string().min(1) }),
    outputSchema: z.object({ worldEntityId: z.string(), removed: z.boolean() }),
    permission: 'WRITE',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
    execute: ({ worldEntityId }: { worldEntityId: string }) => {
      repos.world.remove(worldEntityId);
      return { worldEntityId, removed: true };
    },
  };

  return [create, list, update, remove];
}
