/**
 * Commit 前强制 Summary Approval（P1 / §十二）
 *
 * ## 这组测试防的是什么
 *
 * §十二 的硬要求：Commit 需要 `summary != empty AND summary_approved == 1`。
 * 但仓库里有两套 commit 前置检查，而它们**语义不一致**：
 *
 *   - `workflow-services.readyToCommit`（workflow 的 ready_to_commit 阶段）
 *     检查了 summary_approved ✅
 *   - `commit-tools` 的 `workspace.commit` 工具
 *     **只检查 summary 非空** ❌ —— 「摘要存在」被当成了「摘要已批准」
 *
 * 而 `workspace.commit` 才是唯一能把章节变成正式章节的入口
 * （`commit.run` IPC 直接调它，不经过 workflow）。所以绕过路径真实存在。
 *
 * 后果不是报错，而是**静默的**：未批准的摘要不进 FTS / Context
 * （summary-indexer 明确跳过 approved=0），于是这一章在库里、系统显示
 * "提交成功"，但它对后续章节的记忆贡献是零 —— 跨章记忆静默断裂。
 *
 * ## 为什么还要测 FORCE
 *
 * 硬检查总会有必须绕过的现实情形。**没有正规绕过通道 ≠ 不会绕过**，
 * 只会让绕过变成改代码或直接改库，且不留痕。
 * 所以 FORCE 是刻意设计的出口，但必须：显式声明 + 留审计记录 +
 * **只跳过摘要这一项**（内容正确性问题不得被 FORCE 放行）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Logger } from '@nwa/core';
import { createCommitTools } from '@nwa/harness';
import type { AnyToolDefinition } from '@nwa/shared';
import { createTestProject, makeChapter, type TestProject } from './helpers.js';

const logger = new Logger('test:summary-gate', { level: 'error' });

let dir: string;
let t: TestProject | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nwa-sumgate-'));
  t = createTestProject({ rootDir: dir });
});

afterEach(() => {
  try {
    t?.cleanup();
  } catch {
    /* 已清理 */
  }
  t = null;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄竞争，忽略 */
  }
});

/** 造一个可提交的章节：有草稿、无 BLOCKING */
function setup(chapterNumber = 1, opts: { summary?: string | null } = {}) {
  const proj = t!;
  const ch = makeChapter(proj, chapterNumber, 'READY_TO_COMMIT');

  // 工作区草稿
  const wsDir = join(dir, 'workspace', `chapter-${String(chapterNumber).padStart(3, '0')}`);
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, 'draft.md'), '正文正文正文', 'utf8');

  if (opts.summary !== undefined && opts.summary !== null) {
    // ⚠ 用 setSummaryCandidate 而不是"直接写 summary"：这才是生产路径 ——
    //   它刻意把 summary_approved 置 0，正是本轮要防的状态。
    proj.repos.chapters.setSummaryCandidate(ch.id, opts.summary);
  }

  // ⚠ 必须显式给一个非 BLOCKING 的审阅结果：hasBlockingReview 把
  //   "未审阅"（review_status = NULL）也视为阻塞（宁严不宽）。
  //   不写这一笔，所有用例都会因为"没审过"而被拒，测不到摘要逻辑。
  proj.repos.chapters.saveReview(ch.id, { issues: [], overallStatus: 'PASSED' }, 'PASSED');

  const tools = createCommitTools({
    db: proj.db,
    repos: proj.repos,
    rootDir: dir,
    logger,
    readWorkspaceText: (_n, name) => (name === 'draft' ? '正文正文正文' : null),
  });
  const commitTool = tools.find((x) => x.name === 'workspace.commit')!;
  return { ch, commitTool, repos: proj.repos };
}

/** 调用工具并捕获抛出的 AppError（工具失败是抛错，不是返回 ok:false） */
function invoke(
  tool: AnyToolDefinition,
  input: unknown,
): { ok: true } | { ok: false; code: string; message: string; details: Record<string, unknown> } {
  try {
    const r = tool.execute(input as never, {} as never);
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      // 同步工具不应返回 Promise；若返回则说明实现变了，测试要跟着改
      throw new Error('workspace.commit 变成了异步工具 —— 测试需要改成 await');
    }
    return { ok: true };
  } catch (e) {
    const err = e as { code?: string; message?: string; details?: Record<string, unknown> };
    return {
      ok: false,
      code: err.code ?? 'UNKNOWN',
      message: err.message ?? String(e),
      details: err.details ?? {},
    };
  }
}

describe('§十二：Commit 需要摘要存在且已批准', () => {
  it('⚠ 摘要存在但**未批准** → 拒绝提交（此前会放行）', () => {
    // 这是本轮修的核心 bug：setSummary 写入后 summary_approved 仍为 0。
    // 旧代码只检查"非空"，于是这种章节能提交 —— 而它的摘要
    // 不会进检索（summary-indexer 跳过 approved=0），记忆静默为零。
    const { ch, commitTool } = setup(1, { summary: '这是一段已生成但未确认的摘要' });
    expect(t!.repos.chapters.get(ch.id).summary_approved).toBe(0);

    const r = invoke(commitTool, { chapterId: ch.id });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('尚未人工批准');
      // ⚠ 断言**机器可读的 details**，而不是错误文案：
      //   文案会随措辞调整，而 missing 字段是给调用方/UI 定位用的契约。
      //   同时它必须能区分 "没摘要" 与 "有摘要没批准" —— 两种情况的
      //   修复动作不同（前者要生成，后者要确认）。
      expect(r.details['missing']).toBe('summary_approved');
      expect(r.details['chapterId']).toBe(ch.id);
    }
    // ⚠ 关键：章节状态不得被推进 —— 拒绝必须是**真的拒绝**
    expect(t!.repos.chapters.get(ch.id).status).not.toBe('COMMITTED');
  });

  it('摘要为空 → 拒绝提交', () => {
    const { ch, commitTool } = setup(1, { summary: null });
    const r = invoke(commitTool, { chapterId: ch.id });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('还没有摘要');
      expect(r.details['missing']).toBe('summary');
    }
  });

  it('摘要已批准 → 允许提交', () => {
    const { ch, commitTool, repos } = setup(1, { summary: '已确认的摘要' });
    repos.chapters.approveSummary(ch.id);
    expect(repos.chapters.get(ch.id).summary_approved).toBe(1);

    const r = invoke(commitTool, { chapterId: ch.id });
    expect(r.ok).toBe(true);
    expect(repos.chapters.get(ch.id).status).toBe('COMMITTED');
  });

  it('⚠ 批准后又被撤回 → 再次拒绝（状态是活的，不是一次性标记）', () => {
    const { ch, commitTool, repos } = setup(1, { summary: '已确认的摘要' });
    repos.chapters.approveSummary(ch.id);
    repos.chapters.revokeSummaryApproval(ch.id);
    expect(repos.chapters.get(ch.id).summary_approved).toBe(0);

    const r = invoke(commitTool, { chapterId: ch.id });
    expect(r.ok).toBe(false);
  });
});

describe('FORCE：显式绕过，但必须留审计', () => {
  it('⚠ 摘要未批准 + commitMode=FORCE → 放行，且写入审计记录', () => {
    const { ch, commitTool, repos } = setup(1, { summary: '未确认的摘要' });

    const r = invoke(commitTool, { chapterId: ch.id, commitMode: 'FORCE', forceReason: '过渡章不要摘要' });
    expect(r.ok).toBe(true);
    expect(repos.chapters.get(ch.id).status).toBe('COMMITTED');

    // ⚠ 审计记录必须存在 —— 这是"允许绕过"的前提条件
    const overrides = repos.commitOverrides.listByChapter(ch.id);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.overridden_check).toBe('SUMMARY_APPROVAL');
    expect(overrides[0]!.reason).toBe('过渡章不要摘要');
  });

  it('⚠ 审计记录保存**原始状态快照**（区分"空的"与"有但没批"）', () => {
    // 只记一个 boolean 无法区分这两种责任完全不同的情况。
    const { ch, commitTool, repos } = setup(1, { summary: '未确认的摘要' });
    invoke(commitTool, { chapterId: ch.id, commitMode: 'FORCE' });

    const ov = repos.commitOverrides.listByChapter(ch.id)[0]!;
    // 有摘要、但没批准
    expect(ov.summary_present_at_override).toBe(1);
    expect(ov.summary_approved_at_override).toBe(0);
  });

  it('⚠ 摘要为空 + FORCE → 快照如实反映"当时是空的"', () => {
    const { ch, commitTool, repos } = setup(1, { summary: null });
    const r = invoke(commitTool, { chapterId: ch.id, commitMode: 'FORCE' });
    expect(r.ok).toBe(true);

    const ov = repos.commitOverrides.listByChapter(ch.id)[0]!;
    expect(ov.summary_present_at_override).toBe(0);
    expect(ov.summary_approved_at_override).toBe(0);
  });

  it('⚠ 已批准的章节用 FORCE 提交 → **不**记绕过（没有绕过任何东西）', () => {
    // 记了会让审计出现假记录："这章绕过过摘要检查"——而实际没有。
    const { ch, commitTool, repos } = setup(1, { summary: '已确认的摘要' });
    repos.chapters.approveSummary(ch.id);

    const r = invoke(commitTool, { chapterId: ch.id, commitMode: 'FORCE' });
    expect(r.ok).toBe(true);
    expect(repos.commitOverrides.listByChapter(ch.id)).toHaveLength(0);
  });

  it('⚠ FORCE 不能绕过审阅 BLOCKING（内容正确性问题不得放行）', () => {
    const { ch, commitTool, repos } = setup(1, { summary: '未确认' });
    // 造一个 BLOCKING 审阅（签名：saveReview(id, review, status)）
    repos.chapters.saveReview(
      ch.id,
      {
        issues: [
          { id: 'i1', severity: 'BLOCKING', category: 'CONTINUITY', description: '时间线矛盾' },
        ],
        overallStatus: 'BLOCKED',
      },
      'BLOCKED',
    );

    const r = invoke(commitTool, { chapterId: ch.id, commitMode: 'FORCE' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('BLOCKING');
    expect(repos.chapters.get(ch.id).status).not.toBe('COMMITTED');
  });

  it('⚠ 未传 commitMode 时默认不允许绕过（缺省必须是安全的那一侧）', () => {
    const { ch, commitTool, repos } = setup(1, { summary: '未确认的摘要' });
    const r = invoke(commitTool, { chapterId: ch.id });
    expect(r.ok).toBe(false);
    expect(repos.commitOverrides.listByChapter(ch.id)).toHaveLength(0);
  });

  it('⚠ 两次绕过各留一条记录（审计要的是次数，不是去重后的存在性）', () => {
    const { ch, commitTool, repos } = setup(1, { summary: '未确认' });
    invoke(commitTool, { chapterId: ch.id, commitMode: 'FORCE' });

    // 把章节拉回可提交状态再绕一次
    repos.chapters.updateStatus(ch.id, 'READY_TO_COMMIT');
    invoke(commitTool, { chapterId: ch.id, commitMode: 'FORCE' });

    expect(repos.commitOverrides.listByChapter(ch.id)).toHaveLength(2);
    expect(repos.commitOverrides.hasSummaryApprovalOverride(ch.id)).toBe(true);
  });
});

describe('commit_overrides 仓储', () => {
  it('无记录时 hasSummaryApprovalOverride 为 false（不是 null/undefined）', () => {
    const { ch, repos } = setup(1, { summary: null });
    expect(repos.commitOverrides.hasSummaryApprovalOverride(ch.id)).toBe(false);
  });

  it('按章节隔离 —— 一章的绕过不影响另一章', () => {
    const { ch: ch1, commitTool, repos } = setup(1, { summary: '未确认' });
    const ch2 = makeChapter(t!, 2, 'READY_TO_COMMIT');

    invoke(commitTool, { chapterId: ch1.id, commitMode: 'FORCE' });

    expect(repos.commitOverrides.listByChapter(ch1.id)).toHaveLength(1);
    expect(repos.commitOverrides.listByChapter(ch2.id)).toHaveLength(0);
    expect(repos.commitOverrides.hasSummaryApprovalOverride(ch2.id)).toBe(false);
  });
});
