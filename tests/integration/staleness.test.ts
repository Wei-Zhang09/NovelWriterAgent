/**
 * Stale 判定（M1，第二阶段施工单 §19–§22）
 *
 * ## 这个缺陷长什么样
 *
 * 施工单要求 Review / Continuity / State 各自记住"我是对哪一版正文
 * 得出的结论"。没有锚点时，实际发生的是：
 *
 *     1. 作者写完第 31 章 → 审阅通过（针对正文 hash A）
 *     2. 作者在编辑器里改了三段（正文变成 hash B）
 *     3. 作者点「提交到正史」→ 系统拿 **hash A 的审阅结论**放行
 *
 * 于是"审阅通过"这句话描述的是**另一份稿子**。这比没有审阅更危险：
 * 它给了虚假的保证，而作者以为检查过了。
 *
 * ## 测试重点
 *
 * 不是"函数返回了预期的枚举值"（那是同义反复），而是：
 *
 * ① **判定表的四种情形**（FRESH / STALE / MISSING / NO_ANCHOR）
 *    各自的语义与消息 —— 特别是 NO_ANCHOR 不能被谎报成 FRESH。
 *
 * ② **跨包算法一致性**：`@nwa/core` 的 `sha256Text` 与 `@nwa/harness`
 *    的 `sha256` / `hashOfFile` 必须给出**同一个值**。
 *    不一致的表现是"刚跑完检查就判 STALE"（看起来像时序 bug），
 *    实际是拿两套算法互比。这条断言能钉死它。
 *
 * ③ **锚点与被检查文本同源**：`ContinuityChecker.check()` 的
 *    `sourceHash` 必须等于它收到的 `draftText` 的哈希。
 *    若哪天改成"调用方传入"，这条会失败 —— 那正是要防的
 *    （传错锚点 = 永远 FRESH = 检查形同虚设）。
 *
 * ④ **端到端**：真跑 `review.run` 落库 → 读回来 → 改正文 → 判 STALE。
 *    只测纯函数会漏掉"锚点根本没被写进库"这类接线缺陷。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  Logger,
  stalenessOf,
  assertFresh,
  stalenessReport,
  sha256Text,
  STALE_TRACKED_ARTIFACTS,
  ARTIFACT_LABELS,
} from '@nwa/core';
import { sha256, hashOfFile, createReviewTools, pickCommitSource } from '@nwa/harness';
import { StateProposalRepository, ContinuityChecker } from '@nwa/story';
import { createTestProject, makeChapter, type TestProject } from './helpers.js';

const logger = new Logger('test:staleness', { level: 'error' });

let dir: string;
let t: TestProject | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nwa-stale-'));
});

afterEach(() => {
  t?.cleanup();
  t = null;
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────
describe('① 判定表：四种情形各自的语义', () => {
  const HASH_A = sha256Text('第一版正文');
  const HASH_B = sha256Text('改过之后的正文');

  it('锚点与当前正文一致 → FRESH，且可用于提交', () => {
    const v = stalenessOf({
      artifact: 'review',
      anchoredHash: HASH_A,
      currentHash: HASH_A,
    });
    expect(v.status).toBe('FRESH');
    expect(v.usableForCommit).toBe(true);
    expect(v.message).toContain('对应当前正文');
  });

  it('⚠ 正文改过 → STALE，且明确说"正文被改动过"', () => {
    const v = stalenessOf({
      artifact: 'review',
      anchoredHash: HASH_A,
      currentHash: HASH_B,
    });
    expect(v.status).toBe('STALE');
    expect(v.usableForCommit).toBe(false);
    // ⚠ 消息必须指向**真实原因**：作者要做的动作是"重跑"，
    //   不是"去查提交事务"。
    expect(v.message).toContain('正文在它之后被改动过');
    expect(v.message).toContain('请重跑');
  });

  it('⚠ 没有锚点 → NO_ANCHOR，绝不谎报 FRESH', () => {
    const v = stalenessOf({
      artifact: 'continuity',
      anchoredHash: null,
      currentHash: HASH_A,
    });
    expect(v.status).toBe('NO_ANCHOR');
    expect(v.usableForCommit).toBe(false);
    // 与 STALE 的消息必须不同 —— 两者的处置不同：
    // STALE 是"正文改了"，NO_ANCHOR 是"这份结果没记版本"。
    expect(v.message).toContain('没有记录版本锚点');
    expect(v.message).not.toContain('正文在它之后被改动过');
  });

  it('当前正文不存在 → MISSING（与"结论过期"是两回事）', () => {
    const v = stalenessOf({
      artifact: 'proposed_state',
      anchoredHash: HASH_A,
      currentHash: null,
    });
    expect(v.status).toBe('MISSING');
    expect(v.usableForCommit).toBe(false);
    expect(v.message).toContain('正文还不存在');
  });

  it('⚠ 判定顺序：正文缺失优先于锚点缺失（消息不能指错方向）', () => {
    const v = stalenessOf({
      artifact: 'review',
      anchoredHash: null,
      currentHash: null,
    });
    // 两者都缺时报 MISSING：作者要做的是"先写正文"，
    // 而不是"重跑一次检查"。
    expect(v.status).toBe('MISSING');
  });

  it('三种产物的标签都在（UI 与错误消息共用同一份中文）', () => {
    for (const a of STALE_TRACKED_ARTIFACTS) {
      const v = stalenessOf({ artifact: a, anchoredHash: HASH_A, currentHash: HASH_B });
      expect(v.label).toBe(ARTIFACT_LABELS[a]);
      expect(v.label.length).toBeGreaterThan(0);
    }
  });

  it('⚠ 产物名用下划线 proposed_state（与 artifact_type / 文件名一致）', () => {
    // 引入第二种拼法（proposedState / proposed-state）会让
    // "查哪份产物"在两处给出不同答案。
    expect([...STALE_TRACKED_ARTIFACTS]).toContain('proposed_state');
    expect([...STALE_TRACKED_ARTIFACTS]).not.toContain('proposedState');
  });
});

// ────────────────────────────────────────────────────────────
describe('② assertFresh：唯一门禁入口', () => {
  const H = sha256Text('正文');

  it('FRESH 时不抛错并返回判定', () => {
    const v = assertFresh({ artifact: 'review', anchoredHash: H, currentHash: H });
    expect(v.status).toBe('FRESH');
  });

  it('⚠ STALE 时抛 ARTIFACT_STALE，且 details 带两个哈希（可定位）', () => {
    let caught: { code?: string; details?: Record<string, unknown> } | null = null;
    try {
      assertFresh({
        artifact: 'review',
        anchoredHash: sha256Text('旧'),
        currentHash: H,
      });
    } catch (e) {
      caught = e as { code?: string; details?: Record<string, unknown> };
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe('ARTIFACT_STALE');
    // 两个哈希都要在 details 里：排查时要能看出"到底差在哪一版"
    expect(caught?.details?.['anchoredHash']).toBeTruthy();
    expect(caught?.details?.['currentHash']).toBe(H);
    expect(caught?.details?.['status']).toBe('STALE');
  });

  it('⚠ NO_ANCHOR 同样拒绝提交（宁严不宽）', () => {
    expect(() =>
      assertFresh({ artifact: 'continuity', anchoredHash: null, currentHash: H }),
    ).toThrow(/没有记录版本锚点/);
  });

  it('stalenessReport：全部 FRESH 才 ok，且**返回全部项**（不只失败项）', () => {
    const ok = stalenessReport([
      { artifact: 'review', anchoredHash: H, currentHash: H },
      { artifact: 'continuity', anchoredHash: H, currentHash: H },
    ]);
    expect(ok.ok).toBe(true);
    // §31 要求逐条显示"✓ Review 对应当前版本" —— 成功项也要在列表里
    expect(ok.all).toHaveLength(2);
    expect(ok.notFresh).toHaveLength(0);

    const bad = stalenessReport([
      { artifact: 'review', anchoredHash: H, currentHash: H },
      { artifact: 'continuity', anchoredHash: sha256Text('旧'), currentHash: H },
      { artifact: 'proposed_state', anchoredHash: null, currentHash: H },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.all).toHaveLength(3);
    expect(bad.notFresh.map((v) => v.artifact)).toEqual(['continuity', 'proposed_state']);
  });
});

// ────────────────────────────────────────────────────────────
describe('③ 跨包哈希算法必须一致（否则"刚跑完就 STALE"）', () => {
  it('⚠ core.sha256Text === harness.sha256（同算法同编码）', () => {
    const samples = ['', 'a', '中文正文', '混合 mixed 内容\n第二段', '……'];
    for (const s of samples) {
      expect(sha256Text(s)).toBe(sha256(s));
    }
  });

  it('⚠ hashOfFile(文件) === sha256Text(文件内容)', () => {
    const p = join(dir, 'sample.md');
    const text = '第一章\n\n他推开门。';
    writeFileSync(p, text, 'utf8');
    expect(hashOfFile(p)).toBe(sha256Text(text));
  });

  it('不同内容必须得到不同哈希（防"恒等函数"）', () => {
    expect(sha256Text('甲')).not.toBe(sha256Text('乙'));
  });
});

// ────────────────────────────────────────────────────────────
describe('④ 连续性检查的锚点与被检查文本同源', () => {
  it('⚠ ContinuityReport.sourceHash === sha256Text(传入的 draftText)', async () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;

    const checker = new ContinuityChecker({
      repos: proj.repos,
      logger,
      bookId: proj.bookId,
    });
    const draftText = '第 1 章\n\n他走进屋子，把门关上。';
    const report = checker.check({ chapterNumber: 1, draftText });

    // 锚点必须来自**实际被检查的文本**，而不是调用方另传一个值
    expect(report.sourceHash).toBe(sha256Text(draftText));

    // 换一份正文 → 锚点必须跟着变（防"锚点是常量"）
    const other = checker.check({ chapterNumber: 1, draftText: '完全不同的正文' });
    expect(other.sourceHash).not.toBe(report.sourceHash);
  });
});

// ────────────────────────────────────────────────────────────
describe('⑤ 端到端：锚点真的落库，且改正文后判 STALE', () => {
  function makeReviewTools(proj: TestProject) {
    return createReviewTools(proj.repos);
  }

  it('⚠ review.run 落库的锚点 = 宿主给的锚点（不是模型编的）', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);

    const tools = makeReviewTools(proj);
    const run = tools.find((x) => x.name === 'review.run')!;

    const hostHash = sha256Text('作者当前的正文');
    const MODEL_LIE = 'deadbeef-model-invented-hash';

    run.execute(
      {
        chapterId: chapter.id,
        review: {
          overallStatus: 'PASSED',
          issues: [],
          // ⚠ 模型（或任何调用方）自己塞一个锚点 —— 必须被忽略
          sourceHash: MODEL_LIE,
        },
        sourceHash: hostHash,
      } as never,
      {} as never,
    );

    const stored = proj.repos.chapters.readReview<{ sourceHash?: string }>(chapter.id);
    expect(stored?.sourceHash).toBe(hostHash);
    expect(stored?.sourceHash).not.toBe(MODEL_LIE);
  });

  it('⚠ 宿主没给锚点 → 落 null（判 NO_ANCHOR），而不是留下模型编的值', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);

    const run = makeReviewTools(proj).find((x) => x.name === 'review.run')!;
    run.execute(
      {
        chapterId: chapter.id,
        review: {
          overallStatus: 'PASSED',
          issues: [],
          sourceHash: 'model-invented',
        },
      } as never,
      {} as never,
    );

    const stored = proj.repos.chapters.readReview<{ sourceHash?: string | null }>(chapter.id);
    expect(stored?.sourceHash).toBeNull();
    // 并且判定为 NO_ANCHOR（拒绝提交但如实说明），不是 FRESH
    const verdict = stalenessOf({
      artifact: 'review',
      anchoredHash: stored?.sourceHash ?? null,
      currentHash: sha256Text('随便什么正文'),
    });
    expect(verdict.status).toBe('NO_ANCHOR');
  });

  it('⚠⚠ 核心判据：审阅 → 改正文 → 该审阅必须判 STALE', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);

    const run = makeReviewTools(proj).find((x) => x.name === 'review.run')!;

    // 作者此刻的正文
    const bodyAtReview = '第一章\n\n他把信塞进靴筒。';
    run.execute(
      {
        chapterId: chapter.id,
        review: { overallStatus: 'PASSED', issues: [] },
        sourceHash: sha256Text(bodyAtReview),
      } as never,
      {} as never,
    );

    const stored = proj.repos.chapters.readReview<{ sourceHash?: string | null }>(chapter.id);
    const anchored = stored?.sourceHash ?? null;

    // ① 没改 → FRESH（刚写入就判过期是最典型的接线错误）
    expect(
      stalenessOf({
        artifact: 'review',
        anchoredHash: anchored,
        currentHash: sha256Text(bodyAtReview),
      }).status,
    ).toBe('FRESH');

    // ② 作者改了一个字 → 必须 STALE
    const edited = '第一章\n\n他把信塞进靴筒里。';
    const v = stalenessOf({
      artifact: 'review',
      anchoredHash: anchored,
      currentHash: sha256Text(edited),
    });
    expect(v.status).toBe('STALE');
    expect(() =>
      assertFresh({
        artifact: 'review',
        anchoredHash: anchored,
        currentHash: sha256Text(edited),
      }),
    ).toThrow(/审阅结果已过期/);
  });

  it('⚠ 改一个字就足够判 STALE（不做"相似度容忍"）', () => {
    // 若哪天有人加了"差异小于 N% 算没变"的容错，这条会失败。
    // 理由是：正文改动哪怕一个标点，之前那次审阅结论也不再描述这份稿子。
    const a = sha256Text('他把信塞进靴筒。');
    const b = sha256Text('他把信塞进靴筒，');
    expect(a).not.toBe(b);
    expect(stalenessOf({ artifact: 'review', anchoredHash: a, currentHash: b }).status).toBe(
      'STALE',
    );
  });
});

// ────────────────────────────────────────────────────────────
describe('⑥ 状态提议锚点：落库 + 读回', () => {
  it('⚠ create() 不传 sourceHash → 落 null（可发现），不是静默当新鲜', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);
    const repo = new StateProposalRepository(proj.db, logger);
    const rec = repo.create({
      id: 'sp_test_no_anchor',
      chapterId: chapter.id,
      bookId: proj.bookId,
      facts: [],
    });
    expect(rec.sourceHash).toBeNull();
  });

  it('⚠ create() 传了锚点 → 原样落库并可读回', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);
    const h = sha256Text('被结算的正文');
    const repo = new StateProposalRepository(proj.db, logger);
    repo.create({
      id: 'sp_test_anchored',
      chapterId: chapter.id,
      bookId: proj.bookId,
      facts: [],
      sourceHash: h,
    });
    expect(repo.get('sp_test_anchored')?.sourceHash).toBe(h);
  });

  it('⚠ 老数据（迁移前落库）的 source_hash 为 NULL → NO_ANCHOR 而非 FRESH', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    const chapter = makeChapter(proj, 1);

    // 模拟 0016 之前的行：直接把 source_hash 置 NULL
    proj.db.run(
      `INSERT INTO state_proposals
         (id, workflow_id, chapter_id, book_id, facts_json, character_states_json,
          timeline_events_json, foreshadowing_json, relationships_json,
          status, verification_json, source_hash, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      'sp_legacy',
      null,
      chapter.id,
      proj.bookId,
      '[]',
      '[]',
      '[]',
      '[]',
      '[]',
      'VERIFIED',
      null,
      null,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );

    const rec = new StateProposalRepository(proj.db, logger).get('sp_legacy');
    expect(rec?.sourceHash).toBeNull();
    expect(
      stalenessOf({
        artifact: 'proposed_state',
        anchoredHash: rec?.sourceHash ?? null,
        currentHash: sha256Text('当前正文'),
      }).status,
    ).toBe('NO_ANCHOR');
  });
});

// ────────────────────────────────────────────────────────────
describe('⑦ 多书隔离：A 书的锚点不影响 B 书', () => {
  it('⚠ 同一份正文哈希在不同书里各自判定（不共享状态）', () => {
    // 这个模块本身无状态，但断言一下"判定只依赖入参"——
    // 防止将来有人在这里加缓存（缓存键漏了 bookId 就会跨书污染）。
    const h = sha256Text('两本书里恰好一样的正文');
    const a = stalenessOf({ artifact: 'review', anchoredHash: h, currentHash: h });
    const b = stalenessOf({
      artifact: 'review',
      anchoredHash: sha256Text('B 书的旧版'),
      currentHash: h,
    });
    expect(a.status).toBe('FRESH');
    expect(b.status).toBe('STALE');
  });
});

// ────────────────────────────────────────────────────────────
describe('⑧ ⚠ 检查对象必须等于提交对象（共用同一解析器）', () => {
  it('pickCommitSource 优先级链：manuscript ?? revision ?? draft', () => {
    const files: Record<string, string | null> = {};
    const deps = {
      readWorkspaceText: (_n: number, name: string) => files[name] ?? null,
    };

    // 三份都在 → 用户正文优先
    files['manuscript'] = '用户改的';
    files['revision'] = 'AI 修订';
    files['draft'] = 'AI 初稿';
    expect(pickCommitSource(deps as never, 1).body).toBe('用户改的');

    // 没有 manuscript → 退回 revision（不破坏引入用户稿前的行为）
    files['manuscript'] = null;
    expect(pickCommitSource(deps as never, 1).body).toBe('AI 修订');

    // 只有 draft → draft
    files['revision'] = null;
    expect(pickCommitSource(deps as never, 1).body).toBe('AI 初稿');

    // 都没有 → null（调用方决定怎么报错）
    files['draft'] = null;
    expect(pickCommitSource(deps as never, 1).body).toBeNull();
  });

  it('⚠ 解析器由 @nwa/harness 导出（app 层三处检查与提交必须共用它）', () => {
    // 若哪天它变回文件内部函数，app 层就只能各写一份取正文的逻辑 ——
    // 那正是"审阅的是 AI 初稿、提交的是用户手改稿"的成因。
    expect(typeof pickCommitSource).toBe('function');
  });

  it('⚠ 空的 manuscript 文件也算"存在"（不因空内容退回 AI 稿）', () => {
    // 作者可能把一章清空重写。此时若把空串当"不存在"而退回 revision，
    // 提交的会是 AI 稿 —— 而作者以为提交的是自己清空后的正文。
    const files: Record<string, string | null> = {
      manuscript: '',
      revision: 'AI 修订',
      draft: 'AI 初稿',
    };
    const deps = { readWorkspaceText: (_n: number, name: string) => files[name] ?? null };
    const picked = pickCommitSource(deps as never, 1);
    expect(picked.body).toBe('');
    expect(picked.source).toBe('manuscript.md');
  });
});
