/**
 * Reviser（改稿）测试
 *
 * ## 触发这组测试的真实故障
 *
 * 真实 2 章运行中第 2 章的审稿抓到两个真问题：
 *   1. 同一场景被完整写了两遍（韩素离开的段落重复）
 *   2. 刻痕日期前后不一致（十月十七 vs 九月十七）
 * 门禁正确拦截，但**没有改稿环节**，稿子只能人工改。
 *
 * ## 改稿的核心风险：它比写稿更容易毁稿
 *
 * 让模型"重写整章"会顺手改掉不该改的（人名、已确立细节），
 * 而那些改动**审稿发现不了**（审稿只看新稿，不知道原稿是什么）。
 * 因此本类必须守住三条：
 *   1. 只改被指出的地方
 *   2. 写 revision.md，绝不覆盖 draft.md（改坏能退回去）
 *   3. 只处理 BLOCKING/MAJOR（为 MINOR 动整章不划算）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Reviser } from '@nwa/writing';
import type { RevisionCompleter } from '@nwa/writing';
import { ChapterWorkspace } from '@nwa/story';
import { Logger, ErrorCode, AppError } from '@nwa/core';
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
  evidence: ['第一次：她走向门口', '第二次：她又走向门口'],
  suggestions: ['删除重复的那一段'],
  ...over,
});

const DRAFT = '沈砚走进仓库。\n韩素撕下纸片写下号码。\n韩素撕下纸片写下号码。\n门开了又合。';

function reviserOf(
  texts: string[],
  n = 1,
): { reviser: Reviser; calls: { messages: readonly { role: string; content: string }[]; temperature?: number }[] } {
  const calls: { messages: readonly { role: string; content: string }[]; temperature?: number }[] = [];
  let i = 0;
  const complete: RevisionCompleter = async (req) => {
    calls.push({ messages: req.messages, ...(req.temperature ? { temperature: req.temperature } : {}) });
    const t = texts[Math.min(i, texts.length - 1)]!;
    i++;
    if (t === '__FAIL__') {
      throw new AppError(ErrorCode.MODEL_TIMEOUT, '模型超时');
    }
    return { text: t };
  };
  const ws = new ChapterWorkspace({ rootDir: dir, chapterNumber: n, logger });
  ws.ensure();
  return { reviser: new Reviser({ complete, workspace: ws, logger }), calls };
}

describe('⚠ 绝不覆盖原稿（改坏了要能退回去）', () => {
  it('产物写入 revision.md，不动 draft.md', async () => {
    const ws = new ChapterWorkspace({ rootDir: dir, chapterNumber: 1, logger });
    ws.ensure();
    ws.writeText('draft', DRAFT);

    const { reviser } = reviserOf(['沈砚走进仓库。\n韩素写下号码。\n门开了又合。']);
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(r.ok).toBe(true);
    expect(r.revisionPath).toBe(join(dir, 'workspace', 'chapter-001', 'revision.md'));
    // ⚠ 原稿必须原封不动
    expect(ws.readText('draft')).toBe(DRAFT);
  });

  it('revision.md 内容 = 模型改后的正文', async () => {
    const { reviser } = reviserOf(['改好的正文']);
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });
    expect(readFileSync(r.revisionPath!, 'utf8')).toBe('改好的正文');
  });
});

describe('⚠ 只处理 BLOCKING / MAJOR（为 MINOR 动整章不划算）', () => {
  it('MINOR / NOTE 不触发改稿调用', async () => {
    const { reviser, calls } = reviserOf(['不应被调用']);
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [
        issue({ id: 'a', severity: 'MINOR' }),
        issue({ id: 'b', severity: 'NOTE' }),
      ],
    });

    expect(calls).toHaveLength(0);
    expect(r.outcomes).toHaveLength(0);
    // 仍写出 revision.md（与原稿一致），保持流程统一
    expect(existsSync(r.revisionPath!)).toBe(true);
    expect(readFileSync(r.revisionPath!, 'utf8')).toBe(DRAFT);
  });

  it('BLOCKING 与 MAJOR 都会被处理', async () => {
    const { reviser, calls } = reviserOf(['改后1', '改后2']);
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [
        issue({ id: 'a', severity: 'BLOCKING' }),
        issue({ id: 'b', severity: 'MAJOR' }),
        issue({ id: 'c', severity: 'MINOR' }),
      ],
    });

    expect(calls).toHaveLength(2);
    expect(r.outcomes).toHaveLength(2);
  });

  it('每次修改在上一次产物上继续（可归因到具体问题）', async () => {
    const { reviser, calls } = reviserOf(['第一次改后', '第二次改后']);
    await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [issue({ id: 'a' }), issue({ id: 'b' })],
    });

    // 第二次调用的 user 消息里应包含"第一次改后"
    const secondUser = calls[1]!.messages.at(-1)!.content;
    expect(secondUser).toContain('第一次改后');
  });

  it('maxIssuesPerPass 限制一次处理的数量', async () => {
    const calls: number[] = [];
    const complete: RevisionCompleter = async () => {
      calls.push(1);
      return { text: 'x' };
    };
    const ws = new ChapterWorkspace({ rootDir: dir, chapterNumber: 1, logger });
    const reviser = new Reviser({ complete, workspace: ws, logger, maxIssuesPerPass: 2 });
    await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [issue({ id: 'a' }), issue({ id: 'b' }), issue({ id: 'c' })],
    });
    expect(calls).toHaveLength(2);
  });
});

describe('⚠ Prompt 必须防"改稿毁稿"', () => {
  it('system 提示禁止改人名/加情节/换视角', async () => {
    const { reviser, calls } = reviserOf(['x']);
    await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    const sys = calls[0]!.messages[0]!.content;
    expect(sys).toContain('只修改被指出的问题');
    expect(sys).toContain('不得改动人物姓名');
    expect(sys).toContain('不得添加原文没有的新情节');
    expect(sys).toContain('不得改变叙事视角');
  });

  it('问题详情（类别/依据/建议）被传给模型', async () => {
    const { reviser, calls } = reviserOf(['x']);
    await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    const task = calls[0]!.messages.at(-1)!.content;
    expect(task).toContain('CONTINUITY');
    expect(task).toContain('同一场景被重复描写');
    expect(task).toContain('第一次：她走向门口'); // evidence
    expect(task).toContain('删除重复的那一段'); // suggestions
  });

  it('温度固定低温（改稿要保守）', async () => {
    const { reviser, calls } = reviserOf(['x']);
    await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });
    expect(calls[0]!.temperature).toBe(0.3);
  });

  it('要求输出完整正文而非片段', async () => {
    const { reviser, calls } = reviserOf(['x']);
    await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });
    expect(calls[0]!.messages[0]!.content).toContain('完整正文');
  });
});

describe('模型的"无需修改"判定被尊重', () => {
  it('模型回「无需修改：理由」时不改动正文', async () => {
    const { reviser } = reviserOf(['无需修改：审稿把伏笔误判成矛盾']);
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(r.ok).toBe(true);
    expect(r.outcomes[0]!.revised).toBe(false);
    expect(r.outcomes[0]!.skippedReason).toContain('误判');
    // 正文保持原样
    expect(readFileSync(r.revisionPath!, 'utf8')).toBe(DRAFT);
  });

  it('NO_CHANGE 英文写法也识别', async () => {
    const { reviser } = reviserOf(['NO_CHANGE: false positive']);
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });
    expect(r.outcomes[0]!.revised).toBe(false);
  });
});

describe('失败处理', () => {
  it('单个 issue 失败不中断整轮（已改的部分保留价值）', async () => {
    const { reviser } = reviserOf(['改后1', '__FAIL__', '改后3']);
    const r = await reviser.revise({
      chapterNumber: 1,
      draftText: DRAFT,
      issues: [issue({ id: 'a' }), issue({ id: 'b' }), issue({ id: 'c' })],
    });

    expect(r.ok).toBe(true);
    expect(r.outcomes.filter((o) => o.revised)).toHaveLength(2);
    expect(r.outcomes.find((o) => o.issueId === 'b')!.skippedReason).toContain('改稿调用失败');
  });

  it('模型返回空文本 → 记录为未修改而不是写入空正文', async () => {
    const { reviser } = reviserOf(['   ']);
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    expect(r.outcomes[0]!.revised).toBe(false);
    // ⚠ 关键：不能把空文本写成 revision.md（那等于毁稿）
    expect(readFileSync(r.revisionPath!, 'utf8')).toBe(DRAFT);
  });

  it('全部失败时仍产出 revision.md（= 原稿）', async () => {
    const { reviser } = reviserOf(['__FAIL__']);
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });
    expect(r.ok).toBe(true);
    expect(readFileSync(r.revisionPath!, 'utf8')).toBe(DRAFT);
  });
});

describe('改稿记录可复核', () => {
  it('写出 review.json 记录每个问题的处理结果', async () => {
    const ws = new ChapterWorkspace({ rootDir: dir, chapterNumber: 1, logger });
    const { reviser } = reviserOf(['改后']);
    await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });

    const log = JSON.parse(readFileSync(join(ws.dir, 'review.json'), 'utf8'));
    expect(log.kind).toBe('revision-log');
    expect(log.outcomes).toHaveLength(1);
    expect(log.originalChars).toBe(DRAFT.length);
  });

  it('报告字符数变化量（便于发现异常增删）', async () => {
    const { reviser } = reviserOf(['短']);
    const r = await reviser.revise({ chapterNumber: 1, draftText: DRAFT, issues: [issue()] });
    expect(r.deltaChars).toBe(1 - DRAFT.length);
    expect(r.totalChars).toBe(1);
  });
});
