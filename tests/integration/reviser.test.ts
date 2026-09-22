/**
 * Reviser（改稿）测试 —— 替换式设计
 *
 * ## 触发这组测试的真实故障
 *
 * 第一版让模型"输出修改后的完整正文"，真实 2 章运行结果：
 *
 *   第 1 章：审稿 10 问题、**阻塞 0**（可提交）
 *          → 改稿（+875 字，19912→22535 字节）
 *          → 复审 **阻塞 1**（不可提交）← 改稿引入了新问题
 *
 * 模型没有"只改被指出的地方"，而是顺手扩写了别处。
 * prompt 里的"只修改被指出的部分"**没有机制保证**。
 *
 * 因此改为替换式：模型输出 { find, replace } 指令，由代码精确应用。
 * 这组测试锁死"不毁稿"这件事。
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

function reviserOf(raw: unknown, n = 1) {
  const ws = new ChapterWorkspace({ rootDir: dir, chapterNumber: n, logger });
  ws.ensure();
  return { reviser: new Reviser({ structured: callerReturning(raw), workspace: ws, logger }), ws };
}

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
    // 首尾两行必须原样保留
    expect(r.text).toContain('沈砚走进仓库。');
    expect(r.text).toContain('门开了又合。');
    // 重复段只剩一处
    expect(r.text!.match(/韩素撕下纸片写下号码。/g)).toHaveLength(1);
  });

  it('⚠ 未被引用的文字不可能被改动（机制保证，非 prompt 承诺）', async () => {
    const { reviser } = reviserOf({
      edits: [{ find: '门开了又合。', replace: '门开了，又合上。', reason: '细化' }],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    // 除被替换的那一处外，逐字符相同
    const expected = DRAFT.replace('门开了又合。', '门开了，又合上。');
    expect(r.text).toBe(expected);
  });

  it('replace 为空字符串 = 删除该片段', async () => {
    const { reviser } = reviserOf({
      edits: [{ find: '\n韩素撕下纸片写下号码。', replace: '', reason: '删重复' }],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });
    expect(r.text!.match(/韩素撕下纸片写下号码。/g)).toHaveLength(1);
  });

  it('替换后字符变化量如实报告', async () => {
    const { reviser } = reviserOf({
      edits: [{ find: '门开了又合。', replace: '门开了。', reason: '简化' }],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });
    expect(r.deltaChars).toBe(-2); // 门开了又合。(6字) → 门开了。(4字)
  });
});

describe('⚠ 拒绝会毁稿的替换', () => {
  it('find 匹配不到 → 拒绝（不模糊匹配，避免改错地方）', async () => {
    const { reviser } = reviserOf({
      edits: [{ find: '这段文字在正文里根本不存在', replace: 'X', reason: '' }],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(r.appliedEdits).toBe(0);
    expect(r.rejectedEdits).toBe(1);
    // 正文必须完全不变
    expect(r.text).toBe(DRAFT);
  });

  it('⚠ 单条替换超过全文 70% → 拒绝（那是重写，不是定向修改）', async () => {
    const { reviser } = reviserOf({
      // find 几乎是全文
      edits: [
        { find: DRAFT.slice(0, Math.ceil(DRAFT.length * 0.8)), replace: '完全重写的内容', reason: '' },
      ],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(r.appliedEdits).toBe(0);
    expect(r.rejectedEdits).toBe(1);
    expect(r.text).toBe(DRAFT); // 原样
  });

  it('部分替换合法、部分被拒时，合法的仍生效', async () => {
    const { reviser } = reviserOf({
      edits: [
        { find: '门开了又合。', replace: '门开了。', reason: '' },
        { find: '不存在的片段', replace: 'X', reason: '' },
      ],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(r.appliedEdits).toBe(1);
    expect(r.rejectedEdits).toBe(1);
    expect(r.text).toContain('门开了。');
  });

  it('多处相同内容时只替换第一处（保守处理）', async () => {
    const dup = '重复的一句话。\n中间。\n重复的一句话。';
    const { reviser } = reviserOf({
      edits: [{ find: '重复的一句话。', replace: '改后。', reason: '' }],
    });
    const r = await reviser.revise({ chapterNumber: 1, draftText: dup, issues: [issue()] });
    expect(r.text!.match(/重复的一句话。/g)).toHaveLength(1);
    expect(r.text!.match(/改后。/g)).toHaveLength(1);
  });
});

describe('⚠ 绝不覆盖原稿', () => {
  it('写 revision.md，不动 draft.md', async () => {
    const { reviser, ws } = reviserOf({
      edits: [{ find: '门开了又合。', replace: '门开了。', reason: '' }],
    });
    ws.writeText('draft', DRAFT);

    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(r.revisionPath).toBe(join(dir, 'workspace', 'chapter-001', 'revision.md'));
    expect(ws.readText('draft')).toBe(DRAFT);
  });

  it('改稿日志记录被拒绝的替换（人工复核需要看到"想改但没改成"）', async () => {
    const { reviser, ws } = reviserOf({
      edits: [{ find: '不存在', replace: 'X', reason: '' }],
    });
    await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    const log = JSON.parse(readFileSync(join(ws.dir, 'review.json'), 'utf8'));
    expect(log.mode).toBe('targeted-replace');
    expect(log.appliedEdits).toBe(0);
    expect(log.rejected).toHaveLength(1);
    expect(log.rejected[0].reason).toContain('找不到');
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
});

describe('只处理 BLOCKING / MAJOR', () => {
  it('MINOR / NOTE 不触发改稿调用', async () => {
    let called = false;
    const ws = new ChapterWorkspace({ rootDir: dir, chapterNumber: 1, logger });
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
    // 仍写出 revision.md（= 原稿），保持流程统一
    expect(readFileSync(r.revisionPath!, 'utf8')).toBe(DRAFT);
  });

  it('BLOCKING / MAJOR 会被处理', async () => {
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
    expect(r.outcomes).toHaveLength(2); // 只 BLOCKING + MAJOR
  });

  it('outcomes 覆盖被处理的问题', async () => {
    const { reviser } = reviserOf({ edits: [] });
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [issue({ id: 'a' }), issue({ id: 'b' }), issue({ id: 'c' })],
    });
    expect(r.outcomes).toHaveLength(3);
  });
});

describe('Prompt 与契约', () => {
  it('⚠ system 提示明确要求只输出替换指令、不要全文', async () => {
    let sys = '';
    const ws = new ChapterWorkspace({ rootDir: dir, chapterNumber: 1, logger });
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

  it('问题详情（类别/依据/建议）传给模型', async () => {
    let user = '';
    const ws = new ChapterWorkspace({ rootDir: dir, chapterNumber: 1, logger });
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
      issues: [issue({ evidence: ['依据A'], suggestions: ['建议B'] })],
    });

    expect(user).toContain('CONTINUITY');
    expect(user).toContain('同一场景被重复描写');
    expect(user).toContain('依据A');
    expect(user).toContain('建议B');
  });

  it('温度固定低温（改稿要保守）', async () => {
    let temp: number | undefined;
    const ws = new ChapterWorkspace({ rootDir: dir, chapterNumber: 1, logger });
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

  it('Schema 要求 edits 数组，find 至少 2 字符', () => {
    expect(RevisionOutputSchema.safeParse({ edits: [] }).success).toBe(true);
    expect(RevisionOutputSchema.safeParse({ edits: [{ find: 'x', replace: '' }] }).success).toBe(false);
    expect(RevisionOutputSchema.safeParse({}).success).toBe(false);
  });

  it('reason 缺省时填充为空字符串', () => {
    const r = RevisionOutputSchema.safeParse({ edits: [{ find: 'abc', replace: 'x' }] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.edits[0]!.reason).toBe('');
  });
});

describe('失败处理', () => {
  it('结构化输出失败 → 写原稿并返回错误（不静默）', async () => {
    const ws = new ChapterWorkspace({ rootDir: dir, chapterNumber: 1, logger });
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
    // ⚠ 失败时 revision.md = 原稿（不能让后续步骤读到半成品）
    expect(existsSync(r.revisionPath!)).toBe(true);
    expect(readFileSync(r.revisionPath!, 'utf8')).toBe(DRAFT);
  });

  it('模型返回空 edits 数组 → 正文不变，且如实报告 0 条应用', async () => {
    const { reviser } = reviserOf({ edits: [] });
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(r.ok).toBe(true);
    expect(r.appliedEdits).toBe(0);
    expect(r.text).toBe(DRAFT);
    expect(r.outcomes[0]!.skippedReason).toContain('没有可应用的替换');
  });
});
