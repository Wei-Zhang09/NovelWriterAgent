/**
 * 逐章细纲生成（开书向导 Phase 3）
 *
 * ## 用户诉求
 * > 「配置 AI 生成大纲角色等等相关功能，再由用户进行**选择**、修改」
 *
 * ## 这个测试真正在防什么
 *
 * 不是"函数返回了细纲"（同义反复），而是三件会**静默出错**的事：
 *
 * ① **章号缺口** —— 模型在"生成 10 章"的任务上常漏掉一两章（尤其过渡章），
 *    然后凑满数量。后果是静默的：细纲按章号索引，缺章的那一章失去意图约束，
 *    Planner 只能自由发挥。而作者看到"生成了 10 章细纲"不会察觉。
 *
 * ② **细纲没进 prompt** —— 细纲若不注入 `contextText`，它就只是一份
 *    "作者看过的文档"：门禁说"已确认"，模型却读不到。这是 W1 记录过的
 *    同一教训（`settings-gate` 的"门禁放行但 prompt 读到别的内容"）。
 *    所以本文件有一条**源码级接线断言**（见 ④）。
 *
 * ③ **分批把前一批抹掉** —— 细纲天然分批（「不强行一次产出 30 章细纲」），
 *    若 upsertBatch 清空整表，第二批会连同作者逐章改过的内容一起覆盖第一批。
 *
 * 另有两条边界：
 *   ④ 批量上限必须在**代码**里强制（只写在提示词里不是机制）
 *   ⑤ 修复耗尽**不抛错**，返回结果 + issues（作者不该丢掉已生成的 9 章）
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { validateChapterOutlinesSemantics, type ChapterOutlinesOutput } from '@nwa/shared';
import { ChapterOutlineGenerator } from '@nwa/writing';
import type { StructuredResult } from '@nwa/harness';
import { createTestProject, type TestProject } from './helpers.js';

function ok(data: unknown, attempts = 1): StructuredResult<never> {
  return { ok: true, data, attempts, usedFallback: false } as unknown as StructuredResult<never>;
}

/** 造一条合法细纲 */
function outline(over: Partial<ChapterOutlinesOutput['outlines'][0]> = {}) {
  return {
    chapterNumber: 1,
    coreEvent: '主角盘下废弃拳馆，发现徒弟在打黑拳',
    targetEmotion: '从自暴自弃的麻木 → 被徒弟激起的怒意与护念',
    protagonistGoal: '想赶走徒弟；必须选择是否承认自己当年的失败',
    positioning: 'ADVANCE' as const,
    structureFormula: '徒弟来访（立关系） + 主角拒绝（立旧伤） + 发现徒弟的手（转折）',
    hook: '他在徒弟手上看到了自己当年的旧伤',
    summary: {
      cause: '徒弟找上门说想学拳',
      development: '主角拒绝，两人争执',
      turn: '他看见徒弟手上的伤，位置与自己当年一模一样',
      climax: '他第一次没有立刻说「不」',
      ending: '他转身进屋，把门留了一条缝',
    },
    mainPlot: '主角从拒绝一切与拳台有关的事，到第一次动摇',
    cast: ['沈砚', '徒弟小满'],
    infoGap: '读者知道主角的旧伤来历，徒弟不知道',
    forbidden: '不得揭示当年那场比赛的真相',
    wordTarget: 2500,
    ...over,
  };
}

/** 造一批连续章号的细纲 */
function batch(start: number, end: number): ChapterOutlinesOutput {
  const outlines = [];
  for (let n = start; n <= end; n++) {
    outlines.push(outline({ chapterNumber: n, coreEvent: `第 ${n} 章的核心事件` }));
  }
  return { outlines };
}

const settings = {
  logline: '退役拳手回小城开拳馆',
  coreConflict: '保护徒弟',
  characters: [{ name: '沈砚', role: '主角' }],
  worldEntities: [{ name: '拳台规矩', description: '认输即止' }],
};

// ════════════════════════════════════════════════════════════
describe('① 章号连续性：本阶段最主要的静默缺陷', () => {
  it('合法的一批（1-10）→ 无问题', () => {
    expect(
      validateChapterOutlinesSemantics(batch(1, 10), { startChapter: 1, endChapter: 10 }),
    ).toEqual([]);
  });

  it('⚠⚠ 漏了中间一章 → 必须点名是哪一章', () => {
    const b = batch(1, 10);
    b.outlines = b.outlines.filter((o) => o.chapterNumber !== 7);
    const issues = validateChapterOutlinesSemantics(b, { startChapter: 1, endChapter: 10 });
    expect(issues.some((i) => i.includes('缺少第 7 章'))).toBe(true);
    // 条数也要报（作者看到"9 条"才知道少了）
    expect(issues.some((i) => i.includes('实际给出 9 章'))).toBe(true);
  });

  it('⚠⚠ 只给了前 8 章（凑满数量式偷工）→ 检出后两章', () => {
    const b = batch(1, 8);
    const issues = validateChapterOutlinesSemantics(b, { startChapter: 1, endChapter: 10 });
    expect(issues.some((i) => i.includes('缺少第 9 章'))).toBe(true);
    expect(issues.some((i) => i.includes('缺少第 10 章'))).toBe(true);
  });

  it('⚠ 章号越界 → 检出（模型多给了范围外的章）', () => {
    const b = batch(1, 11); // 要 1-10，给了 1-11
    const issues = validateChapterOutlinesSemantics(b, { startChapter: 1, endChapter: 10 });
    expect(issues.some((i) => i.includes('越界'))).toBe(true);
  });

  it('⚠ 章号重复 → 检出', () => {
    const b = batch(1, 10);
    b.outlines.push(outline({ chapterNumber: 5 }));
    const issues = validateChapterOutlinesSemantics(b, { startChapter: 1, endChapter: 10 });
    expect(issues.some((i) => i.includes('章号重复'))).toBe(true);
  });

  it('目标情绪只写标签 → 检出（标签对 Planner 没有信息量）', () => {
    const b = batch(1, 3);
    b.outlines[1]!.targetEmotion = '热血';
    const issues = validateChapterOutlinesSemantics(b, { startChapter: 1, endChapter: 3 });
    expect(issues.some((i) => i.includes('只写了标签'))).toBe(true);
  });

  it('结尾落点是状态判词 → 检出（Writer 不知道该落在哪）', () => {
    const b = batch(1, 3);
    b.outlines[0]!.summary.ending = '尘埃落定';
    const issues = validateChapterOutlinesSemantics(b, { startChapter: 1, endChapter: 3 });
    expect(issues.some((i) => i.includes('状态判词'))).toBe(true);
  });

  it('占位符 → 检出', () => {
    const b = batch(1, 3);
    b.outlines[0]!.coreEvent = '待确认：主角的结局';
    const issues = validateChapterOutlinesSemantics(b, { startChapter: 1, endChapter: 3 });
    expect(issues.some((i) => i.includes('占位文本'))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
describe('② 批量上限必须在代码里强制，不只写在提示词里', () => {
  it('⚠⚠ 请求 30 章 → 拒绝，不发模型调用', async () => {
    const structured = vi.fn().mockResolvedValue(ok(batch(1, 10)));
    const gen = new ChapterOutlineGenerator({ structured });
    const r = await gen.generate({ settings, startChapter: 1, endChapter: 30 });

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('BATCH_TOO_LARGE');
    expect(r.error?.message).toContain('10');
    // ⚠ 关键：**根本没调用模型** —— 若只在提示词里说，这里会真的发出去
    expect(structured).not.toHaveBeenCalled();
  });

  it('恰好 10 章 → 允许', async () => {
    const structured = vi.fn().mockResolvedValue(ok(batch(1, 10)));
    const gen = new ChapterOutlineGenerator({ structured });
    const r = await gen.generate({ settings, startChapter: 1, endChapter: 10 });
    expect(r.ok).toBe(true);
    expect(structured).toHaveBeenCalledTimes(1);
  });

  it('章号范围倒置 → 拒绝', async () => {
    const structured = vi.fn();
    const gen = new ChapterOutlineGenerator({ structured });
    const r = await gen.generate({ settings, startChapter: 10, endChapter: 1 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_RANGE');
    expect(structured).not.toHaveBeenCalled();
  });

  it('第二批（11-20）合法 —— 分批是设计用法，不是例外', async () => {
    const structured = vi.fn().mockResolvedValue(ok(batch(11, 20)));
    const gen = new ChapterOutlineGenerator({ structured });
    const r = await gen.generate({ settings, startChapter: 11, endChapter: 20 });
    expect(r.ok).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
describe('③ 修复重试：缺章必须被点名回灌', () => {
  it('⚠⚠ 漏章 → 触发修复，第二次补齐则通过', async () => {
    const missing = batch(1, 10);
    missing.outlines = missing.outlines.filter((o) => o.chapterNumber !== 7);
    const structured = vi
      .fn()
      .mockResolvedValueOnce(ok(missing))
      .mockResolvedValueOnce(ok(batch(1, 10)));

    const gen = new ChapterOutlineGenerator({ structured });
    const r = await gen.generate({ settings, startChapter: 1, endChapter: 10 });

    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);

    // ⚠ 修复指令必须**点名缺了第 7 章** ——
    //   只说"章号不连续"，模型会再给一版同样缺章的
    const msgs = (structured.mock.calls[1]![0] as { messages: { content: string }[] }).messages;
    const last = msgs[msgs.length - 1]!.content;
    expect(last).toContain('缺少第 7 章');
    expect(last).toContain('一章不漏');
  });

  it('⚠ 修复耗尽 → 不抛错，返回结果 + issues（作者不该丢掉已生成的 9 章）', async () => {
    const missing = batch(1, 10);
    missing.outlines = missing.outlines.filter((o) => o.chapterNumber !== 7);
    const structured = vi.fn().mockResolvedValue(ok(missing));

    const gen = new ChapterOutlineGenerator({ structured, maxSemanticRepair: 1 });
    const r = await gen.generate({ settings, startChapter: 1, endChapter: 10 });

    expect(r.ok, '有瑕疵不等于不可用').toBe(true);
    expect(r.output!.outlines.length).toBe(9);
    expect(r.issues!.some((i) => i.includes('缺少第 7 章'))).toBe(true);
    expect(structured).toHaveBeenCalledTimes(2);
  });

  it('结构化输出失败 → 不重试（重试同样的提示词无用）', async () => {
    const structured = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'MODEL_STRUCTURED_EMPTY', message: 'not json' },
      attempts: 1,
      usedFallback: false,
      rawText: 'oops',
    } as unknown as StructuredResult<never>);

    const gen = new ChapterOutlineGenerator({ structured });
    const r = await gen.generate({ settings, startChapter: 1, endChapter: 10 });
    expect(r.ok).toBe(false);
    expect(structured).toHaveBeenCalledTimes(1);
  });

  it('上下文必须带设定、卷、上一章落点、总量锚点', async () => {
    const structured = vi.fn().mockResolvedValue(ok(batch(1, 3)));
    const gen = new ChapterOutlineGenerator({ structured });
    await gen.generate({
      settings,
      startChapter: 1,
      endChapter: 3,
      bookTitle: '拳台',
      estimatedChapters: 200,
      volume: { name: '拳馆', coreEvent: '盘下拳馆', startState: '自我放逐', endState: '重新站上拳台' },
      previousOutline: { chapterNumber: 0, coreEvent: '序章', ending: '他关上了拳馆的门' },
    });
    const ctx = (structured.mock.calls[0]![0] as { messages: { content: string }[] }).messages
      .map((m) => m.content)
      .join('\n');
    expect(ctx).toContain('沈砚');
    expect(ctx).toContain('拳台规矩');
    expect(ctx).toContain('拳馆');
    expect(ctx).toContain('200 章');
    expect(ctx).toContain('他关上了拳馆的门');
  });
});

// ════════════════════════════════════════════════════════════
describe('④⚠⚠ 仓储：分批不互相覆盖 + 不兜底', () => {
  const setup = (): TestProject =>
    createTestProject({ rootDir: mkdtempSync(join(tmpdir(), 'nwa-cout-')) });

  it('写入一批 → 按章号升序可读回', () => {
    const p = setup();
    const r = p.repos.chapterOutlines.upsertBatch(p.bookId, batch(1, 10));
    expect(r.created).toBe(10);
    expect(r.updated).toBe(0);

    const rows = p.repos.chapterOutlines.listByBook(p.bookId);
    expect(rows.length).toBe(10);
    expect(rows.map((x) => x.chapterNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // 五段式要能解析回来
    expect(rows[0]!.summary.ending).toBe('他转身进屋，把门留了一条缝');
    expect(rows[0]!.cast).toEqual(['沈砚', '徒弟小满']);
    p.cleanup();
  });

  it('⚠⚠ 第二批**不抹掉**第一批（与卷相反：卷整体替换，细纲按章 upsert）', () => {
    const p = setup();
    p.repos.chapterOutlines.upsertBatch(p.bookId, batch(1, 10));
    // 作者改了第 3 章
    const before = p.repos.chapterOutlines.get(p.bookId, 3)!;
    expect(before.coreEvent).toBe('第 3 章的核心事件');

    // 第二批
    const r2 = p.repos.chapterOutlines.upsertBatch(p.bookId, batch(11, 20));
    expect(r2.created).toBe(10);
    expect(r2.updated).toBe(0);

    // ⚠ 第一批 10 章必须还在
    expect(p.repos.chapterOutlines.countByBook(p.bookId)).toBe(20);
    expect(p.repos.chapterOutlines.get(p.bookId, 3)!.coreEvent).toBe('第 3 章的核心事件');
    p.cleanup();
  });

  it('⚠ created/updated 必须分开报（都是 20 时总数看不出区别）', () => {
    const p = setup();
    p.repos.chapterOutlines.upsertBatch(p.bookId, batch(1, 10));
    const r2 = p.repos.chapterOutlines.upsertBatch(p.bookId, batch(1, 5));
    expect(r2.updated).toBe(5);
    expect(r2.created).toBe(0);
    p.cleanup();
  });

  it('⚠⚠ 缺章报告：能看出缺了哪几章', () => {
    const p = setup();
    const b = batch(1, 10);
    b.outlines = b.outlines.filter((o) => o.chapterNumber !== 7);
    p.repos.chapterOutlines.upsertBatch(p.bookId, b);
    const g = p.repos.chapterOutlines.gaps(p.bookId);
    expect(g.missing).toEqual([7]);
    expect(g.max).toBe(10);
    p.cleanup();
  });

  it('⚠⚠ 不存在的章 → 返回 undefined，不兜底', () => {
    const p = setup();
    p.repos.chapterOutlines.upsertBatch(p.bookId, batch(1, 5));
    expect(p.repos.chapterOutlines.get(p.bookId, 6)).toBeUndefined();
    p.cleanup();
  });

  it('⚠⚠ renderForPrompt 是细纲进 prompt 的唯一通道 —— 必须带全部关键字段', () => {
    const p = setup();
    p.repos.chapterOutlines.upsertBatch(p.bookId, batch(1, 3));
    const text = p.repos.chapterOutlines.renderForPrompt(p.bookId, 2);
    expect(text).toContain('第 2 章');
    expect(text).toContain('第 2 章的核心事件');
    expect(text).toContain('从自暴自弃的麻木');
    expect(text).toContain('他转身进屋');
    expect(text).toContain('不得揭示当年那场比赛的真相');
    p.cleanup();
  });

  it('⚠⚠ renderForPrompt 只注入当前章，不夹带邻章（避免稀释）', () => {
    const p = setup();
    p.repos.chapterOutlines.upsertBatch(p.bookId, batch(1, 10));
    const text = p.repos.chapterOutlines.renderForPrompt(p.bookId, 5);
    expect(text).toContain('第 5 章');
    expect(text, '默认不该带第 6 章').not.toContain('第 6 章');
    expect(text, '默认不该带第 4 章').not.toContain('第 4 章');
    p.cleanup();
  });

  it('⚠ 没有细纲 → 空串（不产生只有标题的空块）', () => {
    const p = setup();
    expect(p.repos.chapterOutlines.renderForPrompt(p.bookId, 1)).toBe('');
    p.cleanup();
  });
});

// ════════════════════════════════════════════════════════════
describe('⑤⚠⚠ 接线：细纲必须真的进 contextText（规则 30：没接线的能力等于不存在）', () => {
  it('⚠⚠ workflow-services 的规划阶段必须调用细纲注入', () => {
    const src = readFileSync(
      join(process.cwd(), 'apps/desktop/src/main/workflow-services.ts'),
      'utf8',
    );
    // ① 必须真的调用了注入函数
    expect(
      src.includes('buildChapterOutlineContext(deps, ch.book_id, ch.chapter_number)'),
      '细纲注入未被调用 —— 细纲会变成"作者看过但模型读不到"的文档',
    ).toBe(true);

    // ② 注入的产物必须进 contextText（Planner 实际读的字段）。
    //    ⚠ 只断言"调用了函数"不够：它可能被赋给一个没人用的变量。
    const idx = src.indexOf('const outlineContext = buildChapterOutlineContext');
    expect(idx, '未把细纲注入结果赋给变量').toBeGreaterThan(-1);
    const after = src.slice(idx, idx + 1200);
    expect(after, '细纲没有进 contextText').toContain('outlineContext,');
  });

  it('⚠ 细纲排在世界观与角色之前（意图先于约束读）', () => {
    const src = readFileSync(
      join(process.cwd(), 'apps/desktop/src/main/workflow-services.ts'),
      'utf8',
    );
    const idx = src.indexOf('const contextText = [');
    const line = src.slice(idx, idx + 200);
    const o = line.indexOf('outlineContext');
    const w = line.indexOf('worldContext');
    expect(o, '细纲应在最前').toBeGreaterThan(-1);
    expect(o < w, '细纲必须排在 worldContext 之前').toBe(true);
  });

  it('⚠ 细纲仓储必须挂到 repos 上（否则注入函数拿到 undefined）', () => {
    const src = readFileSync(
      join(process.cwd(), 'packages/storage/src/repositories/index.ts'),
      'utf8',
    );
    expect(src).toContain('chapterOutlines: new ChapterOutlineRepository(db)');
  });
});
