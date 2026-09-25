/**
 * 核心设定与角色生成（开书向导 Phase 2）
 *
 * ## 用户决策
 * > 冲突处理：「**先弹窗逐条让我选**（保留旧的 / 用新的 / 两个都留）」
 *
 * ## 这个测试真正在防什么
 *
 * 不是"函数返回了设定"（同义反复），而是**作者手写的内容会不会被丢**。
 *
 * 三个具体的数据丢失路径，各有一条断言：
 *   ① 作者已手写的同名角色被 AI 静默覆盖
 *   ② 作者在弹窗停留期间删掉的角色，被物化"复活"
 *   ③ 作者在停留期间**新建**的同名角色，被静默跳过（他以为 AI 参考了）
 *
 * ③ 最隐蔽：物化看起来成功，作者也没收到任何提示，
 *   但他刚建的角色根本没进 AI 的视野 —— 而界面上"已确认"。
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateSettingsSemantics,
  type SettingsOutput,
} from '@nwa/shared';
import { SettingsGenerator, detectSettingsConflicts, materializeSettings } from '@nwa/writing';
import type { StructuredResult } from '@nwa/harness';
import { createTestProject, type TestProject } from './helpers.js';

function ok(data: unknown): StructuredResult<never> {
  return { ok: true, data, attempts: 1, usedFallback: false } as unknown as StructuredResult<never>;
}

/** 一份合法的 Phase 2 产出 */
function settings(over: Partial<SettingsOutput> = {}): SettingsOutput {
  return {
    logline: '退役拳手回小城开拳馆，却发现徒弟在打地下黑拳',
    coreConflict: '他想保护徒弟，但徒弟要的正是他放弃过的那条路',
    characters: [
      {
        name: '沈砚',
        aliases: ['老沈'],
        role: '主角',
        profile: { 年龄: '三十六岁', 外貌: '左手有旧伤', 性格: '话少认死理' },
      },
    ],
    worldEntities: [
      { type: 'WORLD_RULE', name: '拳台规矩', description: '认输即止，不得追击' },
    ],
    ...over,
  };
}

const concept = {
  pitch: '退役拳手回小城开拳馆',
  genre: '都市',
  coreEmotion: '意难平',
  protagonist: '陈默',
  coreConflict: '保护徒弟',
  differentiation: '每赢一次失去一个记忆',
  estimatedChapters: 200,
};

// ════════════════════════════════════════════════════════════
describe('① 语义校验：设定必须能据此写作', () => {
  it('合法设定 → 无问题', () => {
    expect(validateSettingsSemantics(settings())).toEqual([]);
  });

  it('⚠ 没有主角 → 检出（模型没理解给谁写故事）', () => {
    const out = settings({
      characters: [
        { name: '林晚', aliases: [], role: '配角', profile: { 性格: '外向' } },
      ],
    });
    expect(validateSettingsSemantics(out).some((i) => i.includes('主角'))).toBe(true);
  });

  it('⚠ 角色档案为空 → 检出（只有一个名字对写作没帮助）', () => {
    const out = settings({
      characters: [
        { name: '沈砚', aliases: [], role: '主角', profile: {} },
      ],
    });
    expect(validateSettingsSemantics(out).some((i) => i.includes('档案为空'))).toBe(true);
  });

  it('⚠ 角色名重复 → 检出（作者分不清是不是同一个人）', () => {
    const out = settings({
      characters: [
        { name: '沈砚', aliases: [], role: '主角', profile: { 性格: '话少' } },
        { name: '沈砚', aliases: [], role: '配角', profile: { 性格: '开朗' } },
      ],
    });
    expect(validateSettingsSemantics(out).some((i) => i.includes('角色名重复'))).toBe(true);
  });

  it('⚠ 占位符 → 检出', () => {
    const out = settings({
      characters: [
        { name: '沈砚', aliases: [], role: '主角', profile: { 背景: '待确认' } },
      ],
    });
    expect(validateSettingsSemantics(out).some((i) => i.includes('占位文本'))).toBe(true);
  });

  it('⚠ 都市日常无世界观设定 → 合法（不强迫模型编设定）', () => {
    const out = settings({ worldEntities: [] });
    expect(validateSettingsSemantics(out)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════
describe('② 生成流程', () => {
  it('一次成功 → 不重试', async () => {
    const structured = vi.fn().mockResolvedValue(ok(settings()));
    const gen = new SettingsGenerator({ structured });
    const r = await gen.generate({ concept });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
    expect(structured).toHaveBeenCalledTimes(1);
  });

  it('⚠ 没有主角 → 触发修复重试', async () => {
    const structured = vi
      .fn()
      .mockResolvedValueOnce(
        ok(
          settings({
            characters: [
              { name: '林晚', aliases: [], role: '配角', profile: { 性格: '外向' } },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(ok(settings()));

    const gen = new SettingsGenerator({ structured });
    const r = await gen.generate({ concept });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);

    // ⚠ 修复指令必须真被追加，否则重试只是重发同样提示词
    const call2 = structured.mock.calls[1]![0] as { messages: { content: string }[] };
    expect(call2.messages[call2.messages.length - 1]!.content).toContain('主角');
  });

  it('⚠ 上下文必须列出作者已手写的内容，并明确要求不要重复', async () => {
    const structured = vi.fn().mockResolvedValue(ok(settings()));
    const gen = new SettingsGenerator({ structured });
    await gen.generate({
      concept,
      existingCharacters: [{ name: '沈砚', summary: '作者手写的主角' }],
      existingWorld: [{ name: '拳台规矩', summary: '作者手写的规则' }],
    });
    const ctx = (structured.mock.calls[0]![0] as { messages: { content: string }[] }).messages
      .map((m) => m.content)
      .join('\n');
    expect(ctx).toContain('作者已手写的角色');
    expect(ctx).toContain('沈砚');
    expect(ctx).toContain('不要重复提议');
  });

  it('修复耗尽 → 不抛错，返回结果 + issues', async () => {
    const structured = vi.fn().mockResolvedValue(
      ok(settings({ characters: [{ name: '林晚', aliases: [], role: '配角', profile: { 性格: 'x' } }] })),
    );
    const gen = new SettingsGenerator({ structured });
    const r = await gen.generate({ concept });
    expect(r.ok).toBe(true);
    expect(r.issues?.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════
describe('③ 冲突检出（供界面逐条询问）', () => {
  it('同名角色被检出，且带双方内容供作者判断', () => {
    const c = detectSettingsConflicts(settings(), {
      characters: [{ name: '沈砚', summary: '作者手写：左手有旧伤' }],
      world: [],
    });
    expect(c.length).toBe(1);
    expect(c[0]!.kind).toBe('character');
    expect(c[0]!.existingSummary).toContain('作者手写');
    expect((c[0] as { proposal: { name: string } }).proposal.name).toBe('沈砚');
  });

  it('⚠ 名字带空格/全角差异也算冲突（否则物化时才炸）', () => {
    const c = detectSettingsConflicts(settings(), {
      characters: [{ name: '沈 砚', summary: '作者手写' }],
      world: [],
    });
    expect(c.length, '「沈砚」与「沈 砚」应判为同名').toBe(1);
  });

  it('无重名 → 无冲突', () => {
    const c = detectSettingsConflicts(settings(), {
      characters: [{ name: '陈默', summary: '另一个人' }],
      world: [],
    });
    expect(c).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════
describe('④⚠⚠ 物化：作者手写的内容不得被丢', () => {
  let t: TestProject;
  const setup = (): TestProject => {
    t = createTestProject({ rootDir: mkdtempSync(join(tmpdir(), 'nwa-mat-')) });
    return t;
  };

  it('无冲突 → 全部写入正式表（prompt 读得到）', () => {
    const p = setup();
    const r = materializeSettings(p.repos, { bookId: p.bookId, output: settings() });
    expect(r.charactersCreated).toContain('沈砚');
    expect(r.worldCreated).toContain('拳台规矩');

    // ⚠ 断言查的是**正式表**（prompt 的真正来源），不是返回值
    const chars = p.repos.characters.listByBook(p.bookId);
    expect(chars.map((c) => c.name)).toContain('沈砚');
    const world = p.repos.world.listByBook(p.bookId);
    expect(world.map((w) => w.name)).toContain('拳台规矩');
    p.cleanup();
  });

  it('⚠⚠ keep_existing → 作者的内容**一字不动**', () => {
    const p = setup();
    // 作者手写
    p.repos.characters.create({
      id: 'char_author',
      bookId: p.bookId,
      name: '沈砚',
      role: '主角',
      profile: { 外貌: '作者写的：左手有旧伤，冬天会抖' },
    });

    const r = materializeSettings(p.repos, {
      bookId: p.bookId,
      output: settings(),
      knownConflicts: ['沈砚', '拳台规矩'],
      decisions: { 沈砚: 'keep_existing', 拳台规矩: 'keep_existing' },
    });

    expect(r.skipped).toContain('沈砚');
    const c = p.repos.characters.listByBook(p.bookId);
    expect(c.length, '不该新建第二个沈砚').toBe(1);
    expect(c[0]!.profile_json, '作者的内容必须原样保留').toContain('作者写的');
    expect(c[0]!.profile_json).not.toContain('三十六岁');
    p.cleanup();
  });

  it('⚠ use_new → 覆盖内容但**保留同一行**（不删不建）', () => {
    const p = setup();
    p.repos.characters.create({
      id: 'char_author',
      bookId: p.bookId,
      name: '沈砚',
      role: '主角',
      profile: { 外貌: '旧的' },
    });

    materializeSettings(p.repos, {
      bookId: p.bookId,
      output: settings(),
      knownConflicts: ['沈砚', '拳台规矩'],
      decisions: { 沈砚: 'use_new', 拳台规矩: 'use_new' },
    });

    const c = p.repos.characters.listByBook(p.bookId);
    expect(c.length).toBe(1);
    // ⚠ id 必须不变 —— 章节/事实表可能引用它，换 id 等于断链
    expect(c[0]!.id).toBe('char_author');
    expect(c[0]!.profile_json).toContain('三十六岁');
    p.cleanup();
  });

  it('⚠ keep_both → AI 的改名后新建，两个都在', () => {
    const p = setup();
    p.repos.characters.create({
      id: 'char_author',
      bookId: p.bookId,
      name: '沈砚',
      role: '主角',
      profile: { 外貌: '作者写的' },
    });
    // ⚠ 冲突双方都必须真实存在 —— 只声明 knownConflicts 而不建行，
    //   会被正确地判成 vanished（作者删过了），而不是 renamed。
    p.repos.world.create({
      id: 'world_author',
      bookId: p.bookId,
      type: 'WORLD_RULE',
      name: '拳台规矩',
      description: '作者写的规则',
    });

    const r = materializeSettings(p.repos, {
      bookId: p.bookId,
      output: settings(),
      knownConflicts: ['沈砚', '拳台规矩'],
      decisions: { 沈砚: 'keep_both', 拳台规矩: 'keep_both' },
    });

    expect(r.renamed.length).toBe(2);
    const names = p.repos.characters.listByBook(p.bookId).map((c) => c.name);
    expect(names).toContain('沈砚');
    expect(names.some((n) => n.includes('AI'))).toBe(true);
    p.cleanup();
  });

  it('⚠⚠ 界面漏问（决定缺失）→ 保守跳过，绝不覆盖作者内容', () => {
    const p = setup();
    p.repos.characters.create({
      id: 'char_author',
      bookId: p.bookId,
      name: '沈砚',
      role: '主角',
      profile: { 外貌: '作者写的' },
    });

    const r = materializeSettings(p.repos, {
      bookId: p.bookId,
      output: settings(),
      knownConflicts: ['沈砚'],
      // ⚠ 故意不给 decisions
    });

    expect(r.skipped).toContain('沈砚');
    expect(p.repos.characters.listByBook(p.bookId)[0]!.profile_json).toContain('作者写的');
    p.cleanup();
  });

  it('⚠⚠ 作者在停留期间**删掉**了旧角色 → 不复活它（那是撤销作者的删除）', () => {
    const p = setup();
    // 生成时检出过冲突，但作者在弹窗期间把旧角色删了
    // （正式表里现在没有沈砚）
    const r = materializeSettings(p.repos, {
      bookId: p.bookId,
      output: settings(),
      knownConflicts: ['沈砚'],
      decisions: { 沈砚: 'use_new' },
    });

    expect(r.vanished).toContain('沈砚');
    const names = p.repos.characters.listByBook(p.bookId).map((c) => c.name);
    expect(names, '不该创建已消失的条目').not.toContain('沈砚');
    p.cleanup();
  });

  it('⚠⚠ 作者在停留期间**新建**同名角色 → 报为新冲突，不静默跳过', () => {
    const p = setup();
    // 生成时没有沈砚（不在 knownConflicts），但作者在弹窗期间建了一个
    p.repos.characters.create({
      id: 'char_author',
      bookId: p.bookId,
      name: '沈砚',
      role: '主角',
      profile: { 外貌: '作者刚写的' },
    });

    const r = materializeSettings(p.repos, {
      bookId: p.bookId,
      output: settings(),
      knownConflicts: [], // 生成时无冲突
      decisions: {},
    });

    expect(
      r.newConflicts,
      '新出现的冲突必须报回界面 —— 否则作者以为自己新建的角色被参考了',
    ).toContain('沈砚');
    expect(r.skipped).toContain('沈砚');
    // 作者的内容仍在
    expect(p.repos.characters.listByBook(p.bookId)[0]!.profile_json).toContain('作者刚写的');
    p.cleanup();
  });
});
