/**
 * 角色工具（施工文档 §52 Test A）
 *
 * ## ⚠ 为什么补这个文件
 *
 * §52 的 **Test A（新建小说）** 明确要求：
 * ```
 * create project → add character → add world rule → add outline
 * ```
 * 但实测全仓工具清单里**没有 character.create** —— 只有
 * `CharacterRepository`（存储层完整：create/get/listByBook/updateProfile），
 * 却没有任何工具暴露它。
 *
 * 这与 `detectProseIssues`（写了没接线）、`ChapterBrief.skillRefs`
 * （字段没人填）是**同一类缺陷**：底层能力齐备，但使用者够不到。
 * Test A 的第二步因此根本无法执行 —— 而代码审查时看不出来
 * （仓库层有完整实现，测试也不报错，因为压根没人调用）。
 *
 * ## 「add world rule」怎么落
 *
 * 不新造 world_rule 表 —— `facts` 已支持 `subject_type='WORLD'`
 * （见 `FACT_SUBJECT_TYPES`），世界规则就是 subjectType=WORLD 的事实。
 * 复用既有模型而非平行造一套，避免世界观设定存在两处。
 */
import { z } from 'zod';
import { ErrorCode, characterId } from '@nwa/core';
import type { Repositories } from '@nwa/storage';
import type { AnyToolDefinition } from '@nwa/shared';

export function createCharacterTools(repos: Repositories): AnyToolDefinition[] {
  const create: AnyToolDefinition = {
    name: 'character.create',
    description:
      '登记一个角色（§52 Test A 的 add character）。同名角色不会被重复创建。' +
      '⚠ 角色的**状态**（失明/死亡等）应通过 fact.add + fact.promote 成为 Canon，' +
      '而不是只写在这里 —— Canon 才是连续性检查的依据。',
    inputSchema: z.object({
      bookId: z.string().min(1),
      name: z.string().min(1, '角色名不得为空'),
      /** 别名（正文里识别同一角色用） */
      aliases: z.array(z.string().min(1)).optional(),
      /** 叙事定位，如 主角 / 配角 / 反派 */
      role: z.string().optional(),
      /** 当前状态（人类可读；判定用的 Canon 在 facts 里） */
      currentStatus: z.string().optional(),
      /** 自由档案（外貌、性格、背景等） */
      profile: z.unknown().optional(),
    }),
    outputSchema: z.object({
      characterId: z.string(),
      name: z.string(),
      /** false 表示同名已存在，复用了既有记录 */
      created: z.boolean(),
    }),
    permission: 'WRITE',
    errorCodes: [ErrorCode.TOOL_VALIDATION_ERROR, ErrorCode.STORAGE_QUERY_FAILED],
    execute: (input: {
      bookId: string;
      name: string;
      aliases?: string[];
      role?: string;
      currentStatus?: string;
      profile?: unknown;
    }) => {
      // ⚠ 同名去重：重复登记同名角色会让"这个角色是谁"产生歧义，
      //   而连续性检查按名字匹配正文 → 歧义直接变成误判。
      const existing = repos.characters
        .listByBook(input.bookId)
        .find((c) => c.name === input.name.trim());
      if (existing) {
        return { characterId: existing.id, name: existing.name, created: false };
      }

      // ⚠ `CharacterRepository.create` 需要显式 id（仓储层不生成 id），
      //   且**不接受 currentStatus** —— 建表时它被硬编码为 NULL。
      //   这不是缺陷：状态属于**可演变的事实**，应经 fact.add 落 Canon，
      //   而不是在角色档案上留一个会被忘掉更新的字段。
      //   若调用方传了 currentStatus，这里如实告知它不会被写入。
      const row = repos.characters.create({
        id: characterId(),
        bookId: input.bookId,
        name: input.name.trim(),
        aliases: input.aliases ?? [],
        role: input.role ?? null,
        profile: input.profile ?? null,
      });

      return { characterId: row.id, name: row.name, created: true };
    },
  };

  const list: AnyToolDefinition = {
    name: 'character.list',
    description: '列出某本书的全部角色（供 Writer / Reviewer 了解有哪些人物）。',
    inputSchema: z.object({ bookId: z.string().min(1) }),
    outputSchema: z.object({ characters: z.array(z.unknown()) }),
    permission: 'READ',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
    execute: ({ bookId }: { bookId: string }) => ({
      characters: repos.characters.listByBook(bookId).map((c) => ({
        id: c.id,
        name: c.name,
        aliases: c.aliases_json ? safeParse(c.aliases_json) : [],
        role: c.role,
        currentStatus: c.current_status,
        profile: c.profile_json ? safeParse(c.profile_json) : null,
      })),
    }),
  };

  const update: AnyToolDefinition = {
    name: 'character.update',
    description: '更新角色档案（叙事定位 / 当前状态 / 自由档案）。',
    inputSchema: z.object({
      characterId: z.string().min(1),
      role: z.string().optional(),
      currentStatus: z.string().optional(),
      profile: z.unknown().optional(),
    }),
    outputSchema: z.object({ characterId: z.string(), updated: z.boolean() }),
    permission: 'WRITE',
    errorCodes: [ErrorCode.TOOL_VALIDATION_ERROR, ErrorCode.STORAGE_QUERY_FAILED],
    execute: (input: {
      characterId: string;
      role?: string;
      currentStatus?: string;
      profile?: unknown;
    }) => {
      const patch: { role?: string | null; profile?: unknown; currentStatus?: string | null } = {};
      if (input.role !== undefined) patch.role = input.role;
      if (input.currentStatus !== undefined) patch.currentStatus = input.currentStatus;
      if (input.profile !== undefined) patch.profile = input.profile;
      if (Object.keys(patch).length === 0) {
        throw new Error('没有要更新的字段');
      }
      const row = repos.characters.updateProfile(input.characterId, patch);
      return { characterId: row.id, updated: true };
    },
  };

  return [create, list, update];
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
