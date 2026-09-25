/**
 * Reviser（改稿）测试 —— 替换式 + 关联替换 + 未解决重试
 *
 * ## 触发这组测试的两个真实故障
 *
 * **故障一（改稿毁稿）**：第一版让模型"输出修改后的完整正文"，逐 issue 各改一遍。
 *
 *   第 1 章：审稿 10 问题、**阻塞 0**（可提交）
 *          → 改稿（+875 字，草稿 19912 → 修订 22535 字节，+13%）
 *          → 复审 **阻塞 1**（不可提交）← 改稿引入了新问题
 *
 * 模型没有"只改被指出的地方"，而是顺手扩写了别处。
 * → 改为替换式：模型输出 { find, replace }，由代码精确应用。
 *
 * **故障二（逐条替换修不了前后矛盾）**：改稿后第 2 章仍有 3 个阻塞问题，
 * 都是同一事物在多处描述不一致（木匣位置／铜扣三种纹样／潮汐倒计时）。
 * 修"三种纹样"必须选定一种、再把另外两处改成它 —— 逐条独立替换做不到。
 * → 引入关联替换（issueId 分组 + canonical 校验 + 整组回退）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Reviser, RevisionOutputSchema } from '@nwa/writing';
import type { RevisionStructuredCaller } from '@nwa/writing';
import { ChapterWorkspace } from '@nwa/story';
import { Logger } from '@nwa/core';
import type { ReviewIssue } from '@nwa/shared';

let dir: string;
const logger = new Logger('test:reviser', { level: 'error' });

/** 测试用固定书 id（P0-1 起路径按书隔离，工作区必须知道自己在哪本书里） */
const TEST_BOOK_ID = 'book_test';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nwa-rev-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const issue = (over: Partial<ReviewIssue> = {}): ReviewIssue => ({
  id: 'ri_1',
  severity: 'MAJOR',
  category: 'CONTINUITY',
  claim: '同一场景被重复描写',
  evidence: [],
  suggestions: [],
  ...over,
});

// 含重复段落的稿子
const DRAFT = [
  '沈砚走进仓库。',
  '韩素撕下纸片写下号码。',
  '韩素撕下纸片写下号码。',
  '门开了又合。',
].join('\n');

/** 含"前后矛盾"的稿子：同一物件三种纹样（真实故障二的简化版） */
const CONTRADICTION_DRAFT = [
  '他取出铜扣，扣面是锻打的痕迹，一锤一锤敲出来的。',
  '灯下再看，铜扣上压着波浪纹。',
  '他把铜扣翻过来，歪斜的锚形纹样朝上。',
].join('\n');

/** 返回预设 edits 的 structured 替身（走真实 schema 校验） */
function callerReturning(raw: unknown): RevisionStructuredCaller {
  return async (req) => {
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: 'MODEL_STRUCTURED_EMPTY', message: 'schema 失败' },
        attempts: 1,
        rawText: JSON.stringify(raw),
      };
    }
    return { ok: true, data: parsed.data, attempts: 1 };
  };
}

/** 按轮次返回不同结果的替身（第一轮 / 第二轮） */
function callerByPass(pass1: unknown, pass2: unknown): RevisionStructuredCaller {
  let n = 0;
  return async (req) => {
    n++;
    const raw = n === 1 ? pass1 : pass2;
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: 'MODEL_STRUCTURED_EMPTY', message: 'schema 失败' },
        attempts: 1,
        rawText: JSON.stringify(raw),
      };
    }
    return { ok: true, data: parsed.data, attempts: 1 };
  };
}

function reviserOf(raw: unknown, n = 1, opts: Partial<{ retryUnresolved: boolean }> = {}) {
  const ws = new ChapterWorkspace({ rootDir: dir, bookId: TEST_BOOK_ID, chapterNumber: n, logger });
  ws.ensure();
  return {
    reviser: new Reviser({ structured: callerReturning(raw), workspace: ws, logger, ...opts }),
    ws,
  };
}

// ══════════════════════════════════════════════════════════
describe('⚠ 核心保证：只改被引用的片段，其余逐字节不变', () => {
  it('精确匹配的替换被应用，其他文字原样保留', async () => {
    const { reviser, ws } = reviserOf({
      edits: [
        {
          find: '韩素撕下纸片写下号码。\n韩素撕下纸片写下号码。',
          replace: '韩素撕下纸片写下号码。',
          reason: '删除重复',
        },
      ],
    });
    ws.writeText('draft', DRAFT);

    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(r.ok).toBe(true);
    expect(r.appliedEdits).toBe(1);
    expect(r.text).toContain('沈砚走进仓库。');
    expect(r.text).toContain('门开了又合。');
    expect(r.text!.match(/韩素撕下纸片写下号码。/g)).toHaveLength(1);
  });

  it('⚠ 未被引用的文字不可能被改动（机制保证，非 prompt 承诺）', async () => {
    const { reviser } = reviserOf({
      edits: [{ find: '门开了又合。', replace: '门开了，又合上。', reason: '细化' }],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(r.text).toBe(DRAFT.replace('门开了又合。', '门开了，又合上。'));
  });

  it('replace 为空字符串 = 删除该片段（小范围删除）', async () => {
    // 用足够长的正文，使目标句占比低于 15% 删除上限
    const text = '门开了又合。\n' + '其余正文照常进行。'.repeat(30);
    const { reviser } = reviserOf({
      edits: [{ find: '门开了又合。', replace: '', reason: '删掉这句' }],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: text, issues: [issue()] });
    expect(r.text).not.toContain('门开了又合。');
    expect(r.appliedEdits).toBe(1);
  });

  it('⚠ 单条删除超过全文 30% → 拒绝（实测删掉 59% 正文把稿子毁掉）', async () => {
    // 真实事故：第 1 章一次改稿删掉 3226/5458 = 59% 正文（5458 → 2210 字）。
    // 当时上限 70% 所以被放行 —— 但**删除是不可逆的信息损失**，
    // 替换（哪怕改动大）至少保留改写后的内容，删除一旦删错就永久没了。
    const big = '他走进院子。' + '这一段描写很长。'.repeat(60); // 远超 30%
    const text = big + '\n\n' + '其余正文。'.repeat(40);
    const { reviser } = reviserOf({
      edits: [{ find: big, replace: '', reason: '删除冗余段落' }],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: text, issues: [issue()] });

    expect(r.appliedEdits).toBe(0);
    expect(r.text).toBe(text); // 一个字都不能少
    expect(r.rejectedEdits).toBeGreaterThan(0);
  });

  it('删除上限按占比判定，中等段落删除正常放行', async () => {
    const target = '他走进院子。';
    const text = target + '其余正文。'.repeat(200);
    const { reviser } = reviserOf({
      edits: [{ find: target, replace: '', reason: '删掉这句' }],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: text, issues: [issue()] });
    expect(r.appliedEdits).toBe(1);
    expect(r.text).not.toContain('他走进院子。');
  });

  it('⚠ 只有删除超限导致修不动时才报「需重新生成」（实测第 2 章场景）', async () => {
    // 实测第 2 章：整章把同一段情节近乎逐字演了两遍，
    // 修它必须删掉约 50% 正文 —— 那已不是"修订"而是草稿本身坏了。
    // 系统应如实报出"需重新生成正文"，而不是静默卡在门禁前。
    const dup = '他上车，接过包裹，指腹触到压印，凉。' + '随后是一段描写。'.repeat(30);
    const text = dup + '\n\n' + dup; // 整段重复两遍
    const { reviser } = reviserOf({
      edits: [{ find: dup, replace: '', reason: '删除重复段落', issueId: 'ri_1' }],
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: text,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });

    // 删除占比约 50% → 超上限被拒 → 该阻塞问题未解决
    expect(r.appliedEdits).toBe(0);
    expect(r.outcomes[0]!.applied).toBe(false);
    expect(r.needsRegeneration).toBe(true);
    expect(r.regenerationReason).toContain('重新生成');
  });

  it('改稿成功时不该报「需重新生成」', async () => {
    const { reviser } = reviserOf({
      edits: [{ find: '门开了又合。', replace: '门开了。', reason: '', issueId: 'ri_1' }],
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });
    expect(r.needsRegeneration).toBeUndefined();
  });

  it('⚠ 多条小删除累计超过 35% → 拒绝（防掏空整章）', async () => {
    // 单条都在 30% 以内，但合起来会掏空整章 —— 双限额的意义
    const seg = '他走进院子。这一段描写。'.repeat(8); // 每段约 12%
    const parts = [seg, seg, seg, seg];
    const text = parts.join('\n\n') + '\n\n' + '其余正文。'.repeat(20);
    const { reviser } = reviserOf({
      edits: [
        { find: parts[0], replace: '', reason: '' },
        { find: parts[1], replace: '', reason: '' },
        { find: parts[2], replace: '', reason: '' },
      ],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: text, issues: [issue()] });

    // 前两条可能通过，累计超限后第三条被拒
    expect(r.rejectedEdits).toBeGreaterThan(0);
    expect(r.text!.length).toBeGreaterThan(text.length * 0.65);
  });

  it('⚠ 删除矛盾段落（25%）正常放行 —— 这是模型的常用改法', async () => {
    // 实测：15% 上限会把模型的正常改法全部拒绝（3 次/5 章），
    // 因为处理"这段与后文矛盾"的常用手段就是删掉整段。
    const contradiction = '这一段与后文矛盾。'.repeat(40); // 约 25%
    const text = contradiction + '\n\n' + '其余正文内容。'.repeat(120);
    const { reviser } = reviserOf({
      edits: [{ find: contradiction, replace: '', reason: '删除矛盾段落' }],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: text, issues: [issue()] });
    expect(r.appliedEdits).toBe(1);
  });

  it('⚠ 替换文本是原文的前缀（截断残迹）→ 拒绝，避免静默删掉后半段', async () => {
    // 实测：find 443 字 → replace 231 字，replace 正是 find 的开头一段。
    // 应用后等于静默删掉 find 的后半部分，而日志里只显示为一次"缩短"。
    const full = '门开了又合。' + '他站在那里很久，没有动。'.repeat(8);
    const truncated = full.slice(0, Math.floor(full.length * 0.5));
    const text = '开头。\n\n' + full + '\n\n结尾。';
    const { reviser } = reviserOf({
      edits: [{ find: full, replace: truncated, reason: '缩短' }],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: text, issues: [issue()] });

    expect(r.appliedEdits).toBe(0);
    expect(r.text).toBe(text);
  });

  it('替换后字符变化量如实报告', async () => {
    const { reviser } = reviserOf({
      edits: [{ find: '门开了又合。', replace: '门开了。', reason: '简化' }],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });
    expect(r.deltaChars).toBe(-2); // 门开了又合。(6字) → 门开了。(4字)
  });
});

// ══════════════════════════════════════════════════════════
describe('⚠ 关联替换：同一问题多处不一致必须一起改', () => {
  it('⚠ 三类纹样统一为一种（真实故障二的场景）', async () => {
    const { reviser } = reviserOf({
      edits: [
        {
          find: '扣面是锻打的痕迹，一锤一锤敲出来的。',
          replace: '扣面压着波浪纹。',
          reason: '统一为波浪纹',
          issueId: 'ri_1',
          canonical: '波浪纹',
        },
        {
          find: '歪斜的锚形纹样朝上。',
          replace: '波浪纹朝上。',
          reason: '统一为波浪纹',
          issueId: 'ri_1',
          canonical: '波浪纹',
        },
      ],
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: CONTRADICTION_DRAFT,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING', claim: '铜扣纹样前后矛盾' })],
    });

    expect(r.appliedEdits).toBe(2);
    // 三种说法只剩一种
    expect(r.text).not.toContain('锻打的痕迹');
    expect(r.text).not.toContain('歪斜的锚');
    expect(r.text!.match(/波浪纹/g)).toHaveLength(3); // 原本 1 处 + 新改 2 处
  });

  it('⚠ 组内任一条匹配失败 → 整组回退（避免只改一半留下更隐蔽的矛盾）', async () => {
    const { reviser } = reviserOf({
      edits: [
        {
          find: '扣面是锻打的痕迹，一锤一锤敲出来的。',
          replace: '扣面压着波浪纹。',
          reason: '',
          issueId: 'ri_1',
          canonical: '波浪纹',
        },
        {
          // 这条在正文里不存在 → 整组作废
          find: '这段文字根本不在正文里',
          replace: '波浪纹朝上。',
          reason: '',
          issueId: 'ri_1',
          canonical: '波浪纹',
        },
      ],
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: CONTRADICTION_DRAFT,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });

    // ⚠ 正文必须完全不变 —— 只改一处比不改更糟
    expect(r.text).toBe(CONTRADICTION_DRAFT);
    // 第一轮回退 + 第二轮（定向重试）同样回退 → 两条记录
    expect(r.rolledBackGroups.length).toBeGreaterThanOrEqual(1);
    expect(r.rolledBackGroups[0]!.issueId).toBe('ri_1');
    expect(r.rolledBackGroups[0]!.reason).toContain('仅 1 条能应用');
    expect(r.rolledBackGroups[0]!.reason).toContain('整组放弃');
    expect(r.appliedEdits).toBe(0);
  });

  it('⚠ canonical 不是从原文选定的 → 整组作废（防止凭空发明第三种说法）', async () => {
    const { reviser } = reviserOf({
      edits: [
        {
          find: '扣面是锻打的痕迹，一锤一锤敲出来的。',
          replace: '扣面压着螺旋纹。',
          reason: '',
          issueId: 'ri_1',
          // 正文里没有"螺旋纹"这种说法 —— 是模型自己发明的
          canonical: '螺旋纹',
        },
        {
          find: '歪斜的锚形纹样朝上。',
          replace: '螺旋纹朝上。',
          reason: '',
          issueId: 'ri_1',
          canonical: '螺旋纹',
        },
      ],
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: CONTRADICTION_DRAFT,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });

    expect(r.text).toBe(CONTRADICTION_DRAFT);
    expect(r.appliedEdits).toBe(0);
    expect(r.rejectedEdits).toBeGreaterThan(0);
    expect(r.rejectedEdits).toBeGreaterThan(0);
  });

  it('canonical 出现在任一条 find 中即视为合法（原文里确实有这种说法）', async () => {
    const { reviser } = reviserOf({
      edits: [
        {
          find: '扣面是锻打的痕迹，一锤一锤敲出来的。',
          replace: '扣面压着波浪纹。',
          reason: '',
          issueId: 'ri_1',
          canonical: '波浪纹', // 第二处的 find 里有
        },
        {
          find: '歪斜的锚形纹样朝上。',
          replace: '波浪纹朝上。',
          reason: '',
          issueId: 'ri_1',
          canonical: '波浪纹',
        },
      ],
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: CONTRADICTION_DRAFT,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });
    expect(r.appliedEdits).toBe(2);
    expect(r.outcomes[0]!.canonical).toBe('波浪纹');
  });

  it('同一 issue 的替换条数如实统计（不是笼统的 1）', async () => {
    const { reviser } = reviserOf({
      edits: [
        {
          find: '扣面是锻打的痕迹，一锤一锤敲出来的。',
          replace: '波浪纹。',
          reason: '',
          issueId: 'ri_1',
          canonical: '波浪纹',
        },
        {
          find: '歪斜的锚形纹样朝上。',
          replace: '波浪纹朝上。',
          reason: '',
          issueId: 'ri_1',
          canonical: '波浪纹',
        },
      ],
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: CONTRADICTION_DRAFT,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });
    expect(r.outcomes[0]!.editCount).toBe(2);
  });

  it('⚠ 单条替换带无意义的 canonical 时不该被拒（实测：6 条被误杀）', async () => {
    // 真实故障：模型对"只改一处"的问题也习惯性填 canonical，
    // 填的往往是修改意图（如"把设定信息拆散到动作与旁白"）而非事实。
    // 若对单条也做 canonical 校验，合法替换会被全部误杀。
    const { reviser } = reviserOf({
      edits: [
        {
          find: '门开了又合。',
          replace: '门开了。',
          reason: '压缩节奏',
          issueId: 'ri_1',
          canonical: '把设定信息拆散到动作与旁白', // 是意图，不是原文里的说法
        },
      ],
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });

    expect(r.appliedEdits).toBe(1);
    expect(r.text).toContain('门开了。');
    expect(r.outcomes[0]!.applied).toBe(true);
  });

  it('⚠ 多条替换时 canonical 仍必须来自原文（防止发明第三种说法）', async () => {
    const { reviser } = reviserOf({
      edits: [
        { find: '扣面是锻打的痕迹，一锤一锤敲出来的。', replace: '螺旋纹。', reason: '', issueId: 'ri_1', canonical: '螺旋纹' },
        { find: '歪斜的锚形纹样朝上。', replace: '螺旋纹朝上。', reason: '', issueId: 'ri_1', canonical: '螺旋纹' },
      ],
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: CONTRADICTION_DRAFT,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });
    // 正文里没有"螺旋纹" → 整组作废
    expect(r.appliedEdits).toBe(0);
    expect(r.text).toBe(CONTRADICTION_DRAFT);
  });

  it('无 issueId 的替换按独立处理（不受整组约束）', async () => {
    const { reviser } = reviserOf({
      edits: [
        { find: '门开了又合。', replace: '门开了。', reason: '' },
        { find: '不存在的片段', replace: 'X', reason: '' },
      ],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });
    expect(r.appliedEdits).toBe(1);
    expect(r.rejectedEdits).toBe(1);
  });

  it('归属到不存在的问题 id → 视为独立替换，不静默丢弃', async () => {
    const { reviser } = reviserOf({
      edits: [{ find: '门开了又合。', replace: '门开了。', reason: '', issueId: 'ri_不存在' }],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });
    expect(r.appliedEdits).toBe(1);
    expect(r.text).toContain('门开了。');
  });
});

// ══════════════════════════════════════════════════════════
describe('⚠ 未解决的阻塞问题做第二轮定向重试', () => {
  it('第一轮没解决 → 第二轮解决', async () => {
    const ws = new ChapterWorkspace({ rootDir: dir, bookId: TEST_BOOK_ID, chapterNumber: 1, logger });
    const reviser = new Reviser({
      structured: callerByPass(
        // 第一轮：匹配不到（模型记错原文）
        { edits: [{ find: '记错的原文片段', replace: 'X', reason: '', issueId: 'ri_1' }] },
        // 第二轮：给对了
        { edits: [{ find: '门开了又合。', replace: '门开了。', reason: '', issueId: 'ri_1' }] },
      ),
      workspace: ws,
      logger,
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });

    expect(r.passes).toHaveLength(2);
    expect(r.text).toContain('门开了。');
    expect(r.outcomes[0]!.applied).toBe(true);
  });

  it('两轮都失败 → 如实报告未解决（不假装成功）', async () => {
    const ws = new ChapterWorkspace({ rootDir: dir, bookId: TEST_BOOK_ID, chapterNumber: 1, logger });
    const reviser = new Reviser({
      structured: callerReturning({
        edits: [{ find: '始终匹配不到', replace: 'X', reason: '', issueId: 'ri_1' }],
      }),
      workspace: ws,
      logger,
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });

    expect(r.text).toBe(DRAFT);
    expect(r.outcomes[0]!.applied).toBe(false);
    // 带 issueId 的替换失败会整组回退，原因如实写明
    expect(r.outcomes[0]!.skippedReason).toContain('整组回退');
    expect(r.appliedEdits).toBe(0);
  });

  it('只重试 BLOCKING，不重试 MAJOR（收益低于风险）', async () => {
    let calls = 0;
    const ws = new ChapterWorkspace({ rootDir: dir, bookId: TEST_BOOK_ID, chapterNumber: 1, logger });
    const reviser = new Reviser({
      structured: async (req) => {
        calls++;
        const parsed = req.schema.safeParse({ edits: [] });
        return { ok: true, data: parsed.success ? parsed.data : { edits: [] }, attempts: 1 };
      },
      workspace: ws,
      logger,
    });
    await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [issue({ id: 'ri_1', severity: 'MAJOR' })],
    });
    expect(calls).toBe(1); // MAJOR 不触发第二轮
  });

  it('retryUnresolved=false 时只跑一轮', async () => {
    let calls = 0;
    const ws = new ChapterWorkspace({ rootDir: dir, bookId: TEST_BOOK_ID, chapterNumber: 1, logger });
    const reviser = new Reviser({
      structured: async (req) => {
        calls++;
        const parsed = req.schema.safeParse({ edits: [] });
        return { ok: true, data: parsed.success ? parsed.data : { edits: [] }, attempts: 1 };
      },
      workspace: ws,
      logger,
      retryUnresolved: false,
    });
    await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });
    expect(calls).toBe(1);
  });

  it('第二轮 prompt 带「这是第二轮」提示', async () => {
    const prompts: string[] = [];
    const ws = new ChapterWorkspace({ rootDir: dir, bookId: TEST_BOOK_ID, chapterNumber: 1, logger });
    const reviser = new Reviser({
      structured: async (req) => {
        prompts.push(req.messages.at(-1)!.content);
        const parsed = req.schema.safeParse({ edits: [] });
        return { ok: true, data: parsed.success ? parsed.data : { edits: [] }, attempts: 1 };
      },
      workspace: ws,
      logger,
    });
    await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('这是第二轮');
    expect(prompts[1]).toContain('这是第二轮');
  });
});

// ══════════════════════════════════════════════════════════
describe('⚠ 拒绝会毁稿的替换', () => {
  it('find 匹配不到 → 拒绝（不模糊匹配，避免改错地方）', async () => {
    const { reviser } = reviserOf({
      edits: [{ find: '这段文字在正文里根本不存在', replace: 'X', reason: '' }],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(r.appliedEdits).toBe(0);
    expect(r.rejectedEdits).toBeGreaterThan(0);
    expect(r.text).toBe(DRAFT);
  });

  it('⚠ 单条替换超过全文 70% → 拒绝（那是重写，不是定向修改）', async () => {
    const { reviser } = reviserOf({
      edits: [
        { find: DRAFT.slice(0, Math.ceil(DRAFT.length * 0.8)), replace: '完全重写的内容', reason: '' },
      ],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(r.appliedEdits).toBe(0);
    expect(r.text).toBe(DRAFT);
  });

  it('删除重复段落（占全文 60%）仍被允许 —— 阈值 0.7 的用意', async () => {
    const { reviser } = reviserOf({
      edits: [
        {
          find: '韩素撕下纸片写下号码。\n韩素撕下纸片写下号码。',
          replace: '韩素撕下纸片写下号码。',
          reason: '',
        },
      ],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });
    expect(r.appliedEdits).toBe(1);
  });

  it('⚠ 挡住"描述性文字被写进正文"（实测：557 字段落被换成「彻底消失」）', async () => {
    // 真实故障：模型把**修改意图**当成替换文本。
    // 用 4 个字的「彻底消失」替换 557 字的段落 —— 所有机械检查都放行了
    // （557/5366 = 10%，远低于 70% 上限），正文里却凭空出现「彻底消失」。
    const longPara = '沈昭把灯往桌角挪了挪，那册盐运旧账摊在膝头，纸页发脆，翻动时发出轻微簌响。' + '旧账大多是他看不懂的数目，盐引、船脚、仓耗，一行行密得发闷。'.repeat(10);
    const text = '开头一段。\n\n' + longPara + '\n\n结尾一段。';
    const { reviser } = reviserOf({
      edits: [{ find: longPara, replace: '彻底消失', reason: '删除该段', issueId: 'ri_1' }],
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: text,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });

    // 必须被拒 —— 正文里绝不能出现「彻底消失」
    expect(r.appliedEdits).toBe(0);
    expect(r.text).not.toContain('彻底消失');
    expect(r.text).toBe(text);
  });

  it('真要删除该用空字符串（合法）', async () => {
    const longPara = '沈昭把灯往桌角挪了挪，那册盐运旧账摊在膝头，纸页发脆。' + '旧账大多是他看不懂的数目。'.repeat(5);
    const filler = '他翻过一页，又停住。灯芯爆了一下，影子在墙上晃。'.repeat(12);
    const text = '开头。\n\n' + filler + '\n\n' + longPara + '\n\n' + filler + '\n\n结尾。';
    const { reviser } = reviserOf({
      edits: [{ find: longPara, replace: '', reason: '删除冗余段落', issueId: 'ri_1' }],
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: text,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });

    expect(r.appliedEdits).toBe(1);
    expect(r.text).not.toContain('旧账大多是他看不懂的数目');
  });

  it('大跨度替换但以句末标点收尾 → 允许（是真正的改写）', async () => {
    const longPara = '沈昭把灯往桌角挪了挪，那册旧账摊在膝头。' + '他翻得很慢。'.repeat(5);
    const filler2 = '他翻过一页，又停住。灯芯爆了一下，影子在墙上晃。'.repeat(12);
    const text = '开头。\n\n' + filler2 + '\n\n' + longPara + '\n\n' + filler2 + '\n\n结尾。';
    const { reviser } = reviserOf({
      edits: [{ find: longPara, replace: '他合上册子，没有再翻。', reason: '压缩', issueId: 'ri_1' }],
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: text,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });
    expect(r.appliedEdits).toBe(1);
    expect(r.text).toContain('他合上册子，没有再翻。');
  });

  it('小改动不受"描述性文字"检查影响（避免误杀）', async () => {
    const text = '门开了又合。\n' + '其余正文照常进行。'.repeat(30);
    const { reviser } = reviserOf({
      edits: [{ find: '门开了又合。', replace: '门开了', reason: '微调' }],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: text, issues: [issue()] });
    expect(r.appliedEdits).toBe(1);
  });

  it('⚠ 多处相同内容 → 拒绝（无法确定改哪一处，不猜）', async () => {
    // 早先的实现是"只替换第一处"，但那是猜测 —— 若模型本意是改第二处，
    // 就会改错地方且无人察觉。改为拒绝并让模型给出更长的定位片段。
    const dup = '重复的一句话。\n中间。\n重复的一句话。';
    const { reviser } = reviserOf({
      edits: [{ find: '重复的一句话。', replace: '改后。', reason: '' }],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: dup, issues: [issue()] });

    expect(r.appliedEdits).toBe(0);
    expect(r.text).toBe(dup);
    expect(r.rejectedEdits).toBeGreaterThan(0);
  });

  it('⚠ 引文不精确（空白差异）也能定位 —— 模型无法逐字复现长段落', async () => {
    // 实测：同一问题产出 3~5 条替换时往往只有 1 条能精确匹配，
    // 其余"找不到" → 整组放弃 → 该问题一处都没改成。
    // 失败原因是**引文不精确**而非位置不存在，因此忽略空白后比对。
    const text = '他取出铜扣，扣面是锻打的痕迹。\n\n灯下再看，铜扣上压着波浪纹。';
    const { reviser } = reviserOf({
      edits: [
        {
          // 模型漏掉了换行（引文与正文有空白差异）
          find: '他取出铜扣，扣面是锻打的痕迹。灯下再看',
          replace: '他取出铜扣，扣面压着波浪纹。灯下再看',
          reason: '统一纹样',
          issueId: 'ri_1',
          canonical: '波浪纹',
        },
      ],
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: text,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });

    expect(r.appliedEdits).toBe(1);
    // 替换必须落在正文的真实区间上（换行被一并覆盖）
    expect(r.text).toContain('扣面压着波浪纹');
    expect(r.text).not.toContain('锻打的痕迹');
  });
});

// ══════════════════════════════════════════════════════════
describe('⚠ 绝不覆盖原稿', () => {
  it('写 revision.md，不动 draft.md', async () => {
    const { reviser, ws } = reviserOf({
      edits: [{ find: '门开了又合。', replace: '门开了。', reason: '' }],
    });
    ws.writeText('draft', DRAFT);

    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(r.revisionPath).toBe(join(dir, 'books', TEST_BOOK_ID, 'workspace', 'chapter-001', 'revision.md'));
    expect(ws.readText('draft')).toBe(DRAFT);
  });

  it('改稿日志记录被拒绝/被回退的替换（人工复核需要）', async () => {
    const { reviser, ws } = reviserOf({
      edits: [{ find: '不存在', replace: 'X', reason: '' }],
    });
    await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    const log = JSON.parse(readFileSync(join(ws.dir, 'review.json'), 'utf8'));
    expect(log.mode).toBe('targeted-replace');
    expect(log.appliedEdits).toBe(0);
    expect(log.rejected.length).toBeGreaterThan(0);
    expect(log.rejected[0].reason).toContain('找不到');
  });

  it('日志记录各轮统计与最终解决情况', async () => {
    const { reviser, ws } = reviserOf({
      edits: [{ find: '门开了又合。', replace: '门开了。', reason: '', issueId: 'ri_1' }],
    });
    await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });

    const log = JSON.parse(readFileSync(join(ws.dir, 'review.json'), 'utf8'));
    expect(log.passes).toHaveLength(1);
    expect(log.passes[0].resolved).toBe(1);
    expect(log.resolved).toContain('ri_1');
    expect(log.unresolved).toEqual([]);
  });

  it('日志记录字符变化量', async () => {
    const { reviser, ws } = reviserOf({
      edits: [{ find: '门开了又合。', replace: '门开了。', reason: '' }],
    });
    await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });
    const log = JSON.parse(readFileSync(join(ws.dir, 'review.json'), 'utf8'));
    expect(log.originalChars).toBe(DRAFT.length);
    expect(log.deltaChars).toBe(-2);
  });

  it('⚠ 日志记录已应用的替换明细（否则无法复盘改了什么）', async () => {
    const { reviser, ws } = reviserOf({
      edits: [
        { find: '门开了又合。', replace: '门开了。', reason: '压缩', issueId: 'ri_1' },
      ],
    });
    await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });

    const log = JSON.parse(readFileSync(join(ws.dir, 'review.json'), 'utf8'));
    expect(log.applied).toHaveLength(1);
    expect(log.applied[0].findHead).toBe('门开了又合。');
    expect(log.applied[0].replaceHead).toBe('门开了。');
    expect(log.applied[0].pass).toBe(1);
    expect(log.applied[0].issueId).toBe('ri_1');
  });

  it('日志记录删减比例（大幅删减需人工复核）', async () => {
    // 目标内容在正文中**重复出现** → 属于冗余，大删除被放行
    const target = '他翻过一页，又停住。灯芯爆了一下。'.repeat(4);
    const other = '别的段落。'.repeat(20);
    const full = target + '\n\n' + other + '\n\n' + target;
    const { reviser, ws } = reviserOf({
      edits: [{ find: target, replace: '', reason: '删除重复段落', issueId: 'ri_1' }],
    });
    await reviser.revise({
      chapterNumber: 1,
      draftText: full,
      issues: [issue({ id: 'ri_1', severity: 'BLOCKING' })],
    });

    const log = JSON.parse(readFileSync(join(ws.dir, 'review.json'), 'utf8'));
    expect(log.shrinkRatio).toBeGreaterThan(0.2);
  });
});

// ══════════════════════════════════════════════════════════
describe('只处理 BLOCKING / MAJOR', () => {
  it('MINOR / NOTE 不触发改稿调用', async () => {
    let called = false;
    const ws = new ChapterWorkspace({ rootDir: dir, bookId: TEST_BOOK_ID, chapterNumber: 1, logger });
    const reviser = new Reviser({
      structured: async () => {
        called = true;
        return { ok: true, data: { edits: [] }, attempts: 1 };
      },
      workspace: ws,
      logger,
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [issue({ severity: 'MINOR' }), issue({ severity: 'NOTE' })],
    });

    expect(called).toBe(false);
    expect(r.outcomes).toHaveLength(0);
    expect(readFileSync(r.revisionPath!, 'utf8')).toBe(DRAFT);
  });

  it('BLOCKING / MAJOR 会被处理，MINOR 被忽略', async () => {
    const { reviser } = reviserOf({
      edits: [{ find: '门开了又合。', replace: '门开了。', reason: '' }],
    });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [
        issue({ id: 'a', severity: 'BLOCKING' }),
        issue({ id: 'b', severity: 'MAJOR' }),
        issue({ id: 'c', severity: 'MINOR' }),
      ],
    });
    expect(r.outcomes).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════
describe('Prompt 与契约', () => {
  it('⚠ system 提示要求只输出替换指令、不要全文', async () => {
    let sys = '';
    const ws = new ChapterWorkspace({ rootDir: dir, bookId: TEST_BOOK_ID, chapterNumber: 1, logger });
    const reviser = new Reviser({
      structured: async (req) => {
        sys = req.messages[0]!.content;
        return { ok: true, data: { edits: [] }, attempts: 1 };
      },
      workspace: ws,
      logger,
    });
    await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(sys).toContain('替换指令');
    expect(sys).toContain('不要输出整章正文');
    expect(sys).toContain('逐字一致');
    expect(sys).toContain('不要改动人物姓名');
  });

  it('⚠ system 提示说明矛盾类问题要「每处都给 edit + canonical」', async () => {
    let sys = '';
    const ws = new ChapterWorkspace({ rootDir: dir, bookId: TEST_BOOK_ID, chapterNumber: 1, logger });
    const reviser = new Reviser({
      structured: async (req) => {
        sys = req.messages[0]!.content;
        return { ok: true, data: { edits: [] }, attempts: 1 };
      },
      workspace: ws,
      logger,
    });
    await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(sys).toContain('canonical');
    expect(sys).toContain('必须是**原文里已经出现的**');
    expect(sys).toContain('每一处');
  });

  it('问题带 id 传给模型（关联替换需要）', async () => {
    let user = '';
    const ws = new ChapterWorkspace({ rootDir: dir, bookId: TEST_BOOK_ID, chapterNumber: 1, logger });
    const reviser = new Reviser({
      structured: async (req) => {
        user = req.messages.at(-1)!.content;
        return { ok: true, data: { edits: [] }, attempts: 1 };
      },
      workspace: ws,
      logger,
    });
    await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [issue({ id: 'ri_7', evidence: ['依据A'], suggestions: ['建议B'] })],
    });

    expect(user).toContain('id=ri_7');
    expect(user).toContain('依据A');
    expect(user).toContain('建议B');
  });

  it('温度固定低温（改稿要保守）', async () => {
    let temp: number | undefined;
    const ws = new ChapterWorkspace({ rootDir: dir, bookId: TEST_BOOK_ID, chapterNumber: 1, logger });
    const reviser = new Reviser({
      structured: async (req) => {
        temp = req.temperature;
        return { ok: true, data: { edits: [] }, attempts: 1 };
      },
      workspace: ws,
      logger,
    });
    await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });
    expect(temp).toBe(0.2);
  });

  it('Schema：issueId / canonical 缺省为空串', () => {
    const r = RevisionOutputSchema.safeParse({ edits: [{ find: 'abc', replace: 'x' }] });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.edits[0]!.issueId).toBe('');
      expect(r.data.edits[0]!.canonical).toBe('');
      expect(r.data.edits[0]!.reason).toBe('');
    }
  });

  it('Schema：find 至少 2 字符，edits 必须是数组', () => {
    expect(RevisionOutputSchema.safeParse({ edits: [] }).success).toBe(true);
    expect(RevisionOutputSchema.safeParse({ edits: [{ find: 'x', replace: '' }] }).success).toBe(false);
    expect(RevisionOutputSchema.safeParse({}).success).toBe(false);
  });

  it('⚠ 模型直接返回数组也能解析（少一层包装是常见行为）', () => {
    // 实测踩到：模型返回 [{...}] 而非 {edits:[...]}，
    // 报 "(root): Required" 导致整轮改稿作废
    const r = RevisionOutputSchema.safeParse([{ find: '门开了又合。', replace: '门开了。' }]);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.edits).toHaveLength(1);
      expect(r.data.edits[0]!.find).toBe('门开了又合。');
    }
  });

  it('数组容错后仍能正常应用替换（端到端）', async () => {
    const ws = new ChapterWorkspace({ rootDir: dir, bookId: TEST_BOOK_ID, chapterNumber: 1, logger });
    const reviser = new Reviser({
      // 故意返回裸数组
      structured: async (req) => {
        const parsed = req.schema.safeParse([{ find: '门开了又合。', replace: '门开了。' }]);
        if (!parsed.success) {
          return {
            ok: false,
            error: { code: 'MODEL_STRUCTURED_EMPTY', message: 'schema 失败' },
            attempts: 1,
          };
        }
        return { ok: true, data: parsed.data, attempts: 1 };
      },
      workspace: ws,
      logger,
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('门开了。');
  });
});

// ══════════════════════════════════════════════════════════
describe('失败处理', () => {
  it('结构化输出失败 → 写原稿并返回错误（不静默）', async () => {
    const ws = new ChapterWorkspace({ rootDir: dir, bookId: TEST_BOOK_ID, chapterNumber: 1, logger });
    const reviser = new Reviser({
      structured: async () => ({
        ok: false,
        error: { code: 'MODEL_STRUCTURED_EMPTY', message: '模型没返回 JSON' },
        attempts: 1,
        rawText: '这是一段散文',
      }),
      workspace: ws,
      logger,
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(r.ok).toBe(false);
    expect(r.error!.message).toContain('没返回 JSON');
    expect(existsSync(r.revisionPath!)).toBe(true);
    expect(readFileSync(r.revisionPath!, 'utf8')).toBe(DRAFT);
  });

  it('⚠ 失败时把模型原始输出落盘（否则无从诊断）', async () => {
    const ws = new ChapterWorkspace({ rootDir: dir, bookId: TEST_BOOK_ID, chapterNumber: 1, logger });
    const reviser = new Reviser({
      structured: async () => ({
        ok: false,
        error: { code: 'MODEL_STRUCTURED_EMPTY', message: '(root): Required' },
        attempts: 1,
        rawText: '[{"find":"x","replace":"y"}]',
      }),
      workspace: ws,
      logger,
    });
    await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    const log = JSON.parse(readFileSync(join(ws.dir, 'review.json'), 'utf8'));
    expect(log.kind).toBe('revision-error');
    expect(log.rawTextHead).toContain('find');
    expect(log.message).toContain('Required');
  });

  it('模型返回空 edits → 正文不变，且如实报告未解决', async () => {
    const { reviser } = reviserOf({ edits: [] });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(r.ok).toBe(true);
    expect(r.appliedEdits).toBe(0);
    expect(r.text).toBe(DRAFT);
    expect(r.outcomes[0]!.applied).toBe(false);
    expect(r.outcomes[0]!.skippedReason).toContain('未产出可应用的替换');
  });
});
