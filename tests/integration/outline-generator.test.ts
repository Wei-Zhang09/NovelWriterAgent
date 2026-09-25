/**
 * 卷级大纲生成（开书向导 Phase 3）
 *
 * ## 这个测试真正在防什么
 *
 * 卷的章号范围必须满足三条**全局不变量**：
 *   ① 从第 1 章开始  ② 首尾相接不重叠  ③ 覆盖到 totalChapters
 *
 * 这三条**逐卷校验查不出来** —— 每一卷单独看都合法。
 * 而它们一旦不成立，后果是**静默的**：细纲（W5）按章号查"我在哪一卷"，
 * 查不到的章被当成"不属于任何卷"，于是那一章失去卷级约束。
 * 不报错，只是写得跑偏 —— 作者要到几十章之后才发现结构散了。
 *
 * 所以本测试的重点是**整体不变量**，而不是"函数返回了卷"（同义反复）。
 *
 * 另有一条同样静默的：`volumeOfChapter` 查不到时必须返回 undefined，
 * **不能兜底成第一卷** —— 那会让越界的章悄悄获得卷级约束。
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateOutlineSemantics, type OutlineOutput } from '@nwa/shared';
import { OutlineGenerator } from '@nwa/writing';
import type { StructuredResult } from '@nwa/harness';
import { createTestProject, type TestProject } from './helpers.js';

function ok(data: unknown): StructuredResult<never> {
  return { ok: true, data, attempts: 1, usedFallback: false } as unknown as StructuredResult<never>;
}

/** 造一卷 */
function vol(over: Partial<OutlineOutput['volumes'][0]> = {}) {
  return {
    name: '拳馆',
    function: '立人设与世界观，埋下徒弟这条主线',
    stage: 'OPENING' as const,
    contract: '读者开始关心主角能不能走出来',
    coreEvent: '主角盘下废弃拳馆，发现徒弟在打黑拳',
    startState: '自我放逐',
    endState: '重新站上拳台边缘',
    chapterStart: 1,
    chapterEnd: 30,
    wordTarget: 75000,
    ...over,
  };
}

/** 一份合法的三卷 200 章卷纲 */
function outline(over: Partial<OutlineOutput> = {}): OutlineOutput {
  return {
    totalChapters: 200,
    emotionCurve: '压抑期待 → 加压反转 → 爽感震撼 → 余韵圆满',
    volumes: [
      vol({ chapterStart: 1, chapterEnd: 40 }),
      vol({ name: '黑拳', stage: 'RISING', chapterStart: 41, chapterEnd: 140 }),
      vol({ name: '拳王', stage: 'CLIMAX', chapterStart: 141, chapterEnd: 200 }),
    ],
    ...over,
  };
}

const settings = {
  logline: '退役拳手回小城开拳馆',
  coreConflict: '保护徒弟',
  characters: [{ name: '沈砚', role: '主角' }],
  worldEntities: [{ name: '拳台规矩', description: '认输即止' }],
};

// ════════════════════════════════════════════════════════════
describe('① 全局不变量（逐卷校验查不出来，必须整体看）', () => {
  it('合法的三卷 200 章 → 无问题', () => {
    expect(validateOutlineSemantics(outline())).toEqual([]);
  });

  it('⚠ 未从第 1 章开始 → 检出（前面的章不属于任何一卷）', () => {
    const out = outline({
      volumes: [
        vol({ chapterStart: 5, chapterEnd: 40 }),
        vol({ name: 'B', stage: 'RISING', chapterStart: 41, chapterEnd: 200 }),
      ],
    });
    const issues = validateOutlineSemantics(out);
    expect(issues.some((i) => i.includes('未从第 1 章开始'))).toBe(true);
  });

  it('⚠⚠ 中间断开 → 检出（那些章会失去卷级约束，静默跑偏）', () => {
    const out = outline({
      volumes: [
        vol({ chapterStart: 1, chapterEnd: 40 }),
        // 第 41-49 章无人负责
        vol({ name: 'B', stage: 'RISING', chapterStart: 50, chapterEnd: 200 }),
      ],
    });
    const issues = validateOutlineSemantics(out);
    expect(issues.some((i) => i.includes('9 章不属于任何一卷'))).toBe(true);
  });

  it('⚠⚠ 范围重叠 → 检出', () => {
    const out = outline({
      volumes: [
        vol({ chapterStart: 1, chapterEnd: 40 }),
        vol({ name: 'B', stage: 'RISING', chapterStart: 35, chapterEnd: 200 }),
      ],
    });
    const issues = validateOutlineSemantics(out);
    expect(issues.some((i) => i.includes('重叠'))).toBe(true);
  });

  it('⚠⚠ 末卷未覆盖到总章数 → 检出（末尾的章不属于任何一卷）', () => {
    const out = outline({
      volumes: [
        vol({ chapterStart: 1, chapterEnd: 40 }),
        vol({ name: 'B', stage: 'RISING', chapterStart: 41, chapterEnd: 150 }),
      ],
      totalChapters: 200,
    });
    const issues = validateOutlineSemantics(out);
    expect(issues.some((i) => i.includes('末尾的章不属于任何一卷'))).toBe(true);
  });

  it('⚠ 卷序打乱也要能正确检查（先排序再校验）', () => {
    // 模型给出的顺序可能乱 —— 若按给定顺序检查，会误报重叠/断开
    const out = outline({
      volumes: [
        vol({ name: 'C', stage: 'CLIMAX', chapterStart: 141, chapterEnd: 200 }),
        vol({ name: 'A', stage: 'OPENING', chapterStart: 1, chapterEnd: 40 }),
        vol({ name: 'B', stage: 'RISING', chapterStart: 41, chapterEnd: 140 }),
      ],
    });
    expect(validateOutlineSemantics(out), '打乱顺序的合法卷纲不该报错').toEqual([]);
  });

  it('⚠ 阶段回退 → 检出（高潮期之后不该再有开篇期）', () => {
    const out = outline({
      volumes: [
        vol({ name: 'A', stage: 'CLIMAX', chapterStart: 1, chapterEnd: 40 }),
        vol({ name: 'B', stage: 'OPENING', chapterStart: 41, chapterEnd: 200 }),
      ],
    });
    const issues = validateOutlineSemantics(out);
    expect(issues.some((i) => i.includes('阶段不得回退'))).toBe(true);
  });

  it('卷名重复 → 检出', () => {
    const out = outline({
      volumes: [
        vol({ name: '同名', chapterStart: 1, chapterEnd: 40 }),
        vol({ name: '同名', stage: 'RISING', chapterStart: 41, chapterEnd: 200 }),
      ],
    });
    expect(validateOutlineSemantics(out).some((i) => i.includes('卷名重复'))).toBe(true);
  });

  it('范围倒置 → 检出', () => {
    const out = outline({
      volumes: [vol({ chapterStart: 40, chapterEnd: 1 })],
      totalChapters: 40,
    });
    expect(validateOutlineSemantics(out).some((i) => i.includes('倒置'))).toBe(true);
  });

  it('占位符 → 检出', () => {
    const out = outline({
      volumes: [vol({ coreEvent: '待确认：主角的结局' })],
      totalChapters: 30,
    });
    expect(validateOutlineSemantics(out).some((i) => i.includes('占位文本'))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
describe('② 生成流程：断开的章号范围是最主要的修复场景', () => {
  it('一次成功 → 不重试', async () => {
    const structured = vi.fn().mockResolvedValue(ok(outline()));
    const gen = new OutlineGenerator({ structured });
    const r = await gen.generate({ settings, estimatedChapters: 200 });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
  });

  it('⚠⚠ 章号断开 → 触发修复重试，第二次正确则通过', async () => {
    const structured = vi
      .fn()
      .mockResolvedValueOnce(
        ok({
          ...outline(),
          volumes: [
            vol({ chapterStart: 1, chapterEnd: 40 }),
            vol({ name: 'B', stage: 'RISING', chapterStart: 50, chapterEnd: 200 }),
          ],
        }),
      )
      .mockResolvedValueOnce(ok(outline()));

    const gen = new OutlineGenerator({ structured });
    const r = await gen.generate({ settings, estimatedChapters: 200 });

    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);

    // ⚠ 修复指令必须带上**具体修法**（章号必须连续 + 举例），
    //   只说"范围有问题"模型会再给一版同样断开的
    const call2 = structured.mock.calls[1]![0] as { messages: { content: string }[] };
    const last = call2.messages[call2.messages.length - 1]!.content;
    expect(last).toContain('首尾相接');
    expect(last).toContain('200');
    expect(last).toContain('1-40');
  });

  it('修复耗尽 → 不抛错，返回结果 + issues', async () => {
    const structured = vi.fn().mockResolvedValue(
      ok({
        ...outline(),
        volumes: [
          vol({ chapterStart: 1, chapterEnd: 40 }),
          vol({ name: 'B', stage: 'RISING', chapterStart: 60, chapterEnd: 200 }),
        ],
      }),
    );
    const gen = new OutlineGenerator({ structured, maxSemanticRepair: 1 });
    const r = await gen.generate({ settings, estimatedChapters: 200 });
    expect(r.ok).toBe(true);
    expect(r.issues?.length).toBeGreaterThan(0);
    expect(structured).toHaveBeenCalledTimes(2);
  });

  it('上下文必须带上全书预计章数（总量锚点）与全部设定', async () => {
    const structured = vi.fn().mockResolvedValue(ok(outline()));
    const gen = new OutlineGenerator({ structured });
    await gen.generate({ settings, estimatedChapters: 200, bookTitle: '拳台' });
    const ctx = (structured.mock.calls[0]![0] as { messages: { content: string }[] }).messages
      .map((m) => m.content)
      .join('\n');
    expect(ctx).toContain('200 章');
    expect(ctx).toContain('沈砚');
    expect(ctx).toContain('拳台规矩');
    expect(ctx).toContain('拳台');
  });
});

// ════════════════════════════════════════════════════════════
describe('③⚠⚠ 仓储：全局不变量与"查不到不得兜底"', () => {
  let t: TestProject;
  const setup = (): TestProject => {
    t = createTestProject({ rootDir: mkdtempSync(join(tmpdir(), 'nwa-vol-')) });
    return t;
  };

  it('整体替换写入，并按章号顺序存 ord', () => {
    const p = setup();
    // 故意打乱顺序传入
    const shuffled: OutlineOutput = {
      ...outline(),
      volumes: [
        vol({ name: 'C', stage: 'CLIMAX', chapterStart: 141, chapterEnd: 200 }),
        vol({ name: 'A', stage: 'OPENING', chapterStart: 1, chapterEnd: 40 }),
        vol({ name: 'B', stage: 'RISING', chapterStart: 41, chapterEnd: 140 }),
      ],
    };
    const r = p.repos.volumes.replaceAll(p.bookId, shuffled, { replaceExisting: false });
    expect(r.created).toBe(3);

    const rows = p.repos.volumes.listByBook(p.bookId);
    expect(rows.map((x) => x.name), 'ord 必须按章号重算，不按传入顺序').toEqual(['A', 'B', 'C']);
    expect(rows.map((x) => x.ord)).toEqual([1, 2, 3]);
    p.cleanup();
  });

  it('⚠⚠ 已有卷时未显式声明 → 抛错，不静默覆盖作者的修改', () => {
    const p = setup();
    p.repos.volumes.replaceAll(p.bookId, outline(), { replaceExisting: false });
    expect(() =>
      p.repos.volumes.replaceAll(p.bookId, outline(), { replaceExisting: false }),
    ).toThrow(/已有 3 卷大纲/);
    // 原数据仍在
    expect(p.repos.volumes.countByBook(p.bookId)).toBe(3);
    p.cleanup();
  });

  it('显式声明后整体替换（不残留旧卷）', () => {
    const p = setup();
    p.repos.volumes.replaceAll(p.bookId, outline(), { replaceExisting: false });
    const twoVol: OutlineOutput = {
      totalChapters: 200,
      emotionCurve: 'x',
      volumes: [
        vol({ name: '上', chapterStart: 1, chapterEnd: 100 }),
        vol({ name: '下', stage: 'CLIMAX', chapterStart: 101, chapterEnd: 200 }),
      ],
    };
    p.repos.volumes.replaceAll(p.bookId, twoVol, { replaceExisting: true });
    const rows = p.repos.volumes.listByBook(p.bookId);
    expect(rows.length, '旧卷必须被清掉').toBe(2);
    expect(rows.map((x) => x.name)).toEqual(['上', '下']);
    p.cleanup();
  });

  it('⚠⚠ volumeOfChapter 查得到正确卷', () => {
    const p = setup();
    p.repos.volumes.replaceAll(p.bookId, outline(), { replaceExisting: false });
    expect(p.repos.volumes.volumeOfChapter(p.bookId, 1)!.name).toBe('拳馆');
    expect(p.repos.volumes.volumeOfChapter(p.bookId, 40)!.name).toBe('拳馆');
    expect(p.repos.volumes.volumeOfChapter(p.bookId, 41)!.name).toBe('黑拳');
    expect(p.repos.volumes.volumeOfChapter(p.bookId, 140)!.name).toBe('黑拳');
    expect(p.repos.volumes.volumeOfChapter(p.bookId, 200)!.name).toBe('拳王');
    p.cleanup();
  });

  it('⚠⚠ 越界章号 → 返回 undefined，**不得兜底成第一卷**', () => {
    const p = setup();
    p.repos.volumes.replaceAll(p.bookId, outline(), { replaceExisting: false });
    expect(
      p.repos.volumes.volumeOfChapter(p.bookId, 201),
      '兜底会让越界的章悄悄获得卷级约束',
    ).toBeUndefined();
    expect(p.repos.volumes.volumeOfChapter(p.bookId, 0)).toBeUndefined();
    p.cleanup();
  });

  it('⚠ 逐卷修改不得改变章号范围（那会破坏全局不变量）', () => {
    const p = setup();
    p.repos.volumes.replaceAll(p.bookId, outline(), { replaceExisting: false });
    const v = p.repos.volumes.listByBook(p.bookId)[0]!;
    // update 的签名里根本没有 chapter_start/end —— 让非法状态不可表达。
    // 这里断言"内容字段可改、范围字段不变"。
    const after = p.repos.volumes.update(v.id, { name: '改过的卷名', coreEvent: '新事件' });
    expect(after.name).toBe('改过的卷名');
    expect(after.chapter_start).toBe(1);
    expect(after.chapter_end).toBe(40);
    p.cleanup();
  });
});
