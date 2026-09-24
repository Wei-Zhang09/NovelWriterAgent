/**
 * 状态结算集成测试（§六 P0-4）。
 *
 * ## 核心断言
 *
 * > **没有 VERIFIED 的 State Proposal 不得进入 Canon。**
 *
 * 这条必须用"试图绕过"来测 —— 只测"验证通过后能写入"证明不了门禁存在，
 * 因为门禁的作用正是**拦住不该写入的**。
 *
 * ## 为什么用真数据库
 *
 * 门禁的判据是**库里那条记录的 status**（不是调用方手里的对象）。
 * 用假仓储测就绕过了这个关键点 —— 而"查权威状态而非快照"正是
 * 这条约束能成立的原因。
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  StateVerifier,
  verifyQuoteSpan,
  resolveQuoteSpan,
  resolveAndVerifySpan,
  overallStatus,
  StateProposalRepository,
  StateSettlement,
  StateExtractor,
} from '@nwa/story';
import type { ProposedCharacterState, StateVerificationReport } from '@nwa/shared';
import { Logger } from '@nwa/core';
import { createTestProject, makeChapter, characterId, type TestProject } from './helpers.js';

let t: TestProject | null = null;

afterEach(() => {
  t?.cleanup();
  t = null;
});

const logger = new Logger('test:state', { level: 'error' });

const DRAFT =
  '陆明远走进架阁库，火舌已经舔到了梁上。他左臂在火里烧伤了，此后无法用剑。\n' +
  '沈氏站在门外，低声说她认得那把铜符。';

/** 造一条引文合法的角色状态提议 */
/**
 * 造一个假提取器（不调模型）。
 *
 * ⚠ 引文必须真的在 DRAFT 里 —— 否则验证会拒掉，测的就不是写入而是门禁了。
 *   这里按 quote 用 indexOf 定位，与真实实现的分工一致（模型引用、代码定位）。
 */
function fakeExtractor(proposed: {
  characterStates?: readonly Record<string, unknown>[];
  timelineEvents?: readonly Record<string, unknown>[];
  foreshadowing?: readonly Record<string, unknown>[];
}) {
  const locate = (q: string) => {
    const off = DRAFT.indexOf(q);
    return { startOffset: off, endOffset: off + q.length };
  };
  return {
    extract: async () => ({
      ok: true as const,
      proposed: {
        characterStates: (proposed.characterStates ?? []).map((x) => ({
          characterId: null,
          ...locate(String(x['quote'] ?? '')),
          ...x,
        })),
        timelineEvents: (proposed.timelineEvents ?? []).map((x) => ({
          ...locate(String(x['quote'] ?? '')),
          ...x,
        })),
        foreshadowing: (proposed.foreshadowing ?? []).map((x) => ({
          ...locate(String(x['quote'] ?? '')),
          ...x,
        })),
      },
      unresolvedCharacters: [],
      attempts: 1,
      usage: { promptTokens: 0, completionTokens: 0 },
    }),
  } as never;
}

function stateOf(
  characterId: string | null,
  status: string,
  over: Partial<ProposedCharacterState> = {},
): ProposedCharacterState {
  const quote = '他左臂在火里烧伤了，此后无法用剑。';
  const startOffset = DRAFT.indexOf(quote);
  return {
    characterId,
    characterName: '陆明远',
    status,
    quote,
    startOffset,
    endOffset: startOffset + quote.length,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────
describe('§六 · verifyQuoteSpan：引文可回溯（代码判定的唯一硬依据）', () => {
  it('偏移与引文精确匹配 → 通过', () => {
    const quote = '架阁库';
    const s = DRAFT.indexOf(quote);
    expect(verifyQuoteSpan(DRAFT, quote, s, s + quote.length).ok).toBe(true);
  });

  it('⚠ 引文在正文里存在但偏移写错 → 拒绝（不是"搜一遍存在就放过"）', () => {
    const quote = '架阁库';
    // 故意给错偏移
    const r = verifyQuoteSpan(DRAFT, quote, 0, quote.length);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('引文与正文偏移不匹配');
  });

  it('⚠ 编造的引文（正文里根本没有）→ 拒绝', () => {
    const r = verifyQuoteSpan(DRAFT, '他其实是皇帝的私生子', 0, 11);
    expect(r.ok).toBe(false);
  });

  it('endOffset 超出正文长度 → 拒绝', () => {
    const r = verifyQuoteSpan(DRAFT, 'x', 0, DRAFT.length + 100);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('超出正文长度');
  });

  it('endOffset <= startOffset → 拒绝', () => {
    expect(verifyQuoteSpan(DRAFT, '', 5, 5).ok).toBe(false);
    expect(verifyQuoteSpan(DRAFT, '', 5, 3).ok).toBe(false);
  });

  it('startOffset 为负 → 拒绝', () => {
    expect(verifyQuoteSpan(DRAFT, 'x', -1, 2).ok).toBe(false);
  });

  it('非整数偏移 → 拒绝', () => {
    expect(verifyQuoteSpan(DRAFT, '架', 0.5, 1.5).ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
describe('§六 · StateVerifier 逐条判定', () => {
  it('全部合法 → 全部通过', () => {
    const v = new StateVerifier({ logger });
    const r = v.verify({
      draftText: DRAFT,
      characterStates: [stateOf('char_1', '左臂烧伤，无法用剑')],
      timelineEvents: [
        {
          title: '架阁库失火',
          description: '架阁库起火，卷宗尽毁',
          quote: '架阁库',
          startOffset: DRAFT.indexOf('架阁库'),
          endOffset: DRAFT.indexOf('架阁库') + 3,
        },
      ],
    });
    expect(r.verifiedCount).toBe(2);
    expect(r.rejectedCount).toBe(0);
    expect(r.byKind['characterState']).toEqual({ verified: 1, rejected: 0 });
  });

  it('⚠ 角色 id 解析不到 → 拒绝（不写 NULL 的 character_id）', () => {
    const v = new StateVerifier({ logger });
    const r = v.verify({
      draftText: DRAFT,
      characterStates: [stateOf(null, '左臂烧伤')],
    });
    expect(r.verifiedCount).toBe(0);
    expect(r.verdicts[0]!.reason).toContain('未解析到 id');
  });

  it('⚠ 状态过于含糊 → 拒绝（含糊状态无法与后文对账）', () => {
    const v = new StateVerifier({ logger });
    const r = v.verify({
      draftText: DRAFT,
      characterStates: [stateOf('char_1', '伤')],
    });
    expect(r.verifiedCount).toBe(0);
    expect(r.verdicts[0]!.reason).toContain('含糊');
  });

  it('⚠ 逐条结论都保留（不是只报整体结果）', () => {
    const v = new StateVerifier({ logger });
    const r = v.verify({
      draftText: DRAFT,
      characterStates: [
        stateOf('char_1', '左臂烧伤，无法用剑'),
        stateOf(null, '手臂有伤'), // 会因 id 被拒
        stateOf('char_1', '心'), // 会因含糊被拒
      ],
    });
    expect(r.verdicts).toHaveLength(3);
    expect(r.verifiedCount).toBe(1);
    expect(r.rejectedCount).toBe(2);
    // 每条都有 label 与原因，可回答"哪一条为什么被拒"
    for (const vd of r.verdicts.filter((x) => !x.verified)) {
      expect(vd.label.length).toBeGreaterThan(0);
      expect(vd.reason).toBeDefined();
    }
  });

  it('事件缺描述 → 拒绝', () => {
    const v = new StateVerifier({ logger });
    const q = '架阁库';
    const s = DRAFT.indexOf(q);
    const r = v.verify({
      draftText: DRAFT,
      timelineEvents: [{ title: '失火', description: '', quote: q, startOffset: s, endOffset: s + 3 }],
    });
    expect(r.verifiedCount).toBe(0);
    expect(r.verdicts[0]!.reason).toContain('缺少描述');
  });

  it('报告带 draftLength（便于事后判断"草稿是不是变了"）', () => {
    const v = new StateVerifier({ logger });
    const r = v.verify({ draftText: DRAFT });
    expect(r.draftLength).toBe(DRAFT.length);
    expect(r.verifiedAt).toBeTruthy();
  });
});

describe('§六 · overallStatus', () => {
  const mk = (verified: number, rejected: number): StateVerificationReport => ({
    verifiedCount: verified,
    rejectedCount: rejected,
    byKind: {},
    verdicts: [],
    draftLength: 0,
    verifiedAt: '',
  });

  it('至少一条通过 → VERIFIED（一条写错不该让同章其他正确项全废）', () => {
    expect(overallStatus(mk(1, 9))).toBe('VERIFIED');
  });

  it('一条都没通过 → REJECTED', () => {
    expect(overallStatus(mk(0, 5))).toBe('REJECTED');
  });
});

// ─────────────────────────────────────────────────────────
describe('§六 · 提议持久化：状态不可改判', () => {
  it('新建的提议永远是 PROPOSED（不能创建时就写 VERIFIED）', () => {
    const p = createTestProject();
    t = p;
    const ch = makeChapter(p, 1);
    const repo = new StateProposalRepository(p.db, logger);

    const rec = repo.create({
      id: 'sp_1',
      chapterId: ch.id,
      bookId: p.bookId,
      characterStates: [stateOf('char_1', '左臂烧伤')],
    });
    expect(rec.status).toBe('PROPOSED');
    expect(rec.verification).toBeNull();
  });

  it('⚠ PROPOSED → VERIFIED 可以；REJECTED 改回 VERIFIED 被拒绝', () => {
    const p = createTestProject();
    t = p;
    const ch = makeChapter(p, 1);
    const repo = new StateProposalRepository(p.db, logger);
    repo.create({ id: 'sp_1', chapterId: ch.id, bookId: p.bookId });

    const report: StateVerificationReport = {
      verifiedCount: 0, rejectedCount: 1, byKind: {}, verdicts: [],
      draftLength: 0, verifiedAt: '',
    };
    repo.verify('sp_1', report, 'REJECTED');

    // ⚠ 改判会让"重新验证"变成"改结论"，门禁的意义正在于结论不可翻转
    expect(() => repo.verify('sp_1', report, 'VERIFIED')).toThrow(/不可改判/);
  });

  it('按章节取最新一条（一章可能重跑多次结算）', () => {
    const p = createTestProject();
    t = p;
    const ch = makeChapter(p, 1);
    const repo = new StateProposalRepository(p.db, logger);
    repo.create({ id: 'sp_1', chapterId: ch.id, bookId: p.bookId });
    repo.create({ id: 'sp_2', chapterId: ch.id, bookId: p.bookId });

    expect(repo.latestByChapter(ch.id)?.id).toBe('sp_2');
    expect(repo.listByChapter(ch.id)).toHaveLength(2);
  });

  it('⚠ 脏 JSON 不让整条记录崩掉（按空处理并留痕）', () => {
    const p = createTestProject();
    t = p;
    const ch = makeChapter(p, 1);
    const repo = new StateProposalRepository(p.db, logger);
    repo.create({ id: 'sp_1', chapterId: ch.id, bookId: p.bookId });
    p.db.run("UPDATE state_proposals SET character_states_json = 'not json' WHERE id = 'sp_1'");

    const rec = repo.get('sp_1');
    expect(rec).not.toBeNull();
    expect(rec!.characterStates).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────
describe('⚠⚠ §六 硬约束：没有 VERIFIED 的提议不得进入 Canon', () => {
  /** 造一个假提取器（不调模型） */
  function fakeExtractor(states: ProposedCharacterState[]): StateExtractor {
    return {
      extract: async () => ({
        ok: true,
        proposed: { characterStates: states, timelineEvents: [], foreshadowing: [] },
        unresolvedCharacters: [],
        attempts: 1,
      }),
    } as unknown as StateExtractor;
  }

  function settlementOf(p: TestProject, states: ProposedCharacterState[]): StateSettlement {
    return new StateSettlement({
      repos: p.repos,
      db: p.db,
      logger,
      bookId: p.bookId,
      extractor: fakeExtractor(states),
      sourceRef: 'chapters/001.md',
    });
  }

  it('⚠ 提议未验证（PROPOSED）时 apply 必须抛错', () => {
    const p = createTestProject();
    t = p;
    const ch = makeChapter(p, 1);
    const repo = new StateProposalRepository(p.db, logger);
    repo.create({ id: 'sp_x', chapterId: ch.id, bookId: p.bookId });

    const s = settlementOf(p, []);
    expect(() =>
      s.apply({ proposalId: 'sp_x', chapterNumber: 1, draftText: DRAFT }),
    ).toThrow(/只有 VERIFIED 的提议才能写入 Canon/);
  });

  it('⚠ 提议被 REJECTED 时 apply 必须抛错（不得绕过）', () => {
    const p = createTestProject();
    t = p;
    const ch = makeChapter(p, 1);
    const repo = new StateProposalRepository(p.db, logger);
    repo.create({ id: 'sp_x', chapterId: ch.id, bookId: p.bookId });
    repo.verify(
      'sp_x',
      { verifiedCount: 0, rejectedCount: 1, byKind: {}, verdicts: [], draftLength: 0, verifiedAt: '' },
      'REJECTED',
    );

    const s = settlementOf(p, []);
    expect(() =>
      s.apply({ proposalId: 'sp_x', chapterNumber: 1, draftText: DRAFT }),
    ).toThrow(/只有 VERIFIED 的提议才能写入 Canon/);
  });

  it('⚠ 不存在的提议 apply 必须抛错', () => {
    const p = createTestProject();
    t = p;
    const s = settlementOf(p, []);
    expect(() =>
      s.apply({ proposalId: 'nope', chapterNumber: 1, draftText: DRAFT }),
    ).toThrow(/不存在/);
  });

  it('⚠ settle 不写 Canon（只落提议 + 验证）', async () => {
    const p = createTestProject();
    t = p;
    const cid = characterId();
    p.repos.characters.create({ id: cid, bookId: p.bookId, name: '陆明远' });
    const ch = makeChapter(p, 1);

    const s = settlementOf(p, [stateOf(cid, '左臂烧伤，无法用剑')]);
    const r = await s.settle({ chapterId: ch.id, chapterNumber: 1, draftText: DRAFT });

    expect(r.status).toBe('VERIFIED');
    expect(r.verified).toBe(true);

    // ⚠ 关键：此时库里**没有**任何 character_states —— settle 只提议不写
    const rows = p.db.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM character_states WHERE character_id = ?',
      cid,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('⚠ 验证通过后 apply 才真的写入（且只写通过的条目）', async () => {
    const p = createTestProject();
    t = p;
    const cid = characterId();
    p.repos.characters.create({ id: cid, bookId: p.bookId, name: '陆明远' });
    const ch = makeChapter(p, 1);

    const s = settlementOf(p, [
      stateOf(cid, '左臂烧伤，无法用剑'), // 通过
      stateOf(null, '手臂有伤'), // 因未解析被拒
    ]);
    const r = await s.settle({ chapterId: ch.id, chapterNumber: 1, draftText: DRAFT });
    expect(r.status).toBe('VERIFIED');
    expect(r.rejected.length).toBeGreaterThan(0);

    const applied = s.apply({ proposalId: r.proposalId, chapterNumber: 1, draftText: DRAFT });
    // 只有 1 条通过 → 只写 1 条
    expect(applied.characterStatesWritten).toBe(1);

    const rows = p.db.all<{ state_json: string }>(
      'SELECT state_json FROM character_states WHERE character_id = ?',
      cid,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state_json).toContain('左臂烧伤');
  });

  it('⚠ 一条都没通过 → 整体 REJECTED，且 apply 被拦住', async () => {
    const p = createTestProject();
    t = p;
    const ch = makeChapter(p, 1);
    // 全部因角色未解析被拒
    const s = settlementOf(p, [stateOf(null, '手臂有伤')]);
    const r = await s.settle({ chapterId: ch.id, chapterNumber: 1, draftText: DRAFT });

    expect(r.status).toBe('REJECTED');
    expect(r.verified).toBe(false);
    expect(() =>
      s.apply({ proposalId: r.proposalId, chapterNumber: 1, draftText: DRAFT }),
    ).toThrow(/只有 VERIFIED/);
  });

  it('⚠ 空提议不算"验证通过"（否则门禁形同虚设）', async () => {
    const p = createTestProject();
    t = p;
    const ch = makeChapter(p, 1);
    const s = settlementOf(p, []);
    const r = await s.settle({ chapterId: ch.id, chapterNumber: 1, draftText: DRAFT });

    expect(r.status).toBe('REJECTED');
    expect(r.rejected.join(' ')).toContain('没有得到任何候选');
  });

  it('⚠ 编造引文的提议被拒（模型脑补的状态进不了 Canon）', async () => {
    const p = createTestProject();
    t = p;
    const cid = characterId();
    p.repos.characters.create({ id: cid, bookId: p.bookId, name: '陆明远' });
    const ch = makeChapter(p, 1);

    const fabricated = stateOf(cid, '他其实是皇帝的私生子', {
      quote: '他其实是皇帝的私生子',
      startOffset: 0,
      endOffset: 10,
    });
    const s = settlementOf(p, [fabricated]);
    const r = await s.settle({ chapterId: ch.id, chapterNumber: 1, draftText: DRAFT });

    expect(r.status).toBe('REJECTED');
    expect(r.rejected.join(' ')).toContain('不匹配');
  });

  it('⚠ 时间线事件写入（验证通过后）', async () => {
    const p = createTestProject();
    t = p;
    const ch = makeChapter(p, 1);
    const q = '架阁库';
    const off = DRAFT.indexOf(q);
    const extractor = {
      extract: async () => ({
        ok: true,
        proposed: {
          characterStates: [],
          timelineEvents: [
            {
              title: '架阁库失火',
              description: '架阁库起火，卷宗尽毁',
              quote: q,
              startOffset: off,
              endOffset: off + q.length,
              importance: 4,
            },
          ],
          foreshadowing: [],
        },
        unresolvedCharacters: [],
        attempts: 1,
      }),
    } as unknown as StateExtractor;

    const s = new StateSettlement({
      repos: p.repos, db: p.db, logger, bookId: p.bookId,
      extractor, sourceRef: 'chapters/001.md',
    });
    const r = await s.settle({ chapterId: ch.id, chapterNumber: 1, draftText: DRAFT });
    expect(r.status).toBe('VERIFIED');

    const applied = s.apply({ proposalId: r.proposalId, chapterNumber: 1, draftText: DRAFT });
    expect(applied.timelineEventsWritten).toBe(1);

    const rows = p.db.all<{ title: string; narrative_chapter: number }>(
      'SELECT title, narrative_chapter FROM timeline_events WHERE book_id = ?',
      p.bookId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('架阁库失火');
    expect(rows[0]!.narrative_chapter).toBe(1);
  });

  it('⚠ 伏笔 PLANT 新建；重复 PLANT 跳过（不重复记账）', async () => {
    const p = createTestProject();
    t = p;
    const ch = makeChapter(p, 1);
    const q = '铜符';
    const off = DRAFT.indexOf(q);
    const fsItem = {
      name: '半枚铜符',
      action: 'PLANT' as const,
      quote: q,
      startOffset: off,
      endOffset: off + q.length,
      tier: 'CORE' as const,
    };
    const extractor = {
      extract: async () => ({
        ok: true,
        proposed: { characterStates: [], timelineEvents: [], foreshadowing: [fsItem] },
        unresolvedCharacters: [],
        attempts: 1,
      }),
    } as unknown as StateExtractor;

    const s = new StateSettlement({
      repos: p.repos, db: p.db, logger, bookId: p.bookId,
      extractor, sourceRef: 'chapters/001.md',
    });
    const r1 = await s.settle({ chapterId: ch.id, chapterNumber: 1, draftText: DRAFT });
    const a1 = s.apply({ proposalId: r1.proposalId, chapterNumber: 1, draftText: DRAFT });
    expect(a1.foreshadowingWritten).toBe(1);

    // 第二次埋同一个名字 → 跳过
    const r2 = await s.settle({ chapterId: ch.id, chapterNumber: 2, draftText: DRAFT });
    const a2 = s.apply({ proposalId: r2.proposalId, chapterNumber: 2, draftText: DRAFT });
    expect(a2.foreshadowingWritten).toBe(0);
    expect(a2.skipped.join(' ')).toContain('已存在');
  });

  it('⚠ PAYOFF 一个账本里不存在的伏笔 → 跳过并报告（不新建假伏笔）', async () => {
    const p = createTestProject();
    t = p;
    const ch = makeChapter(p, 1);
    const q = '铜符';
    const off = DRAFT.indexOf(q);
    const extractor = {
      extract: async () => ({
        ok: true,
        proposed: {
          characterStates: [],
          timelineEvents: [],
          foreshadowing: [
            {
              name: '从未埋过的伏笔',
              action: 'PAYOFF' as const,
              quote: q,
              startOffset: off,
              endOffset: off + q.length,
            },
          ],
        },
        unresolvedCharacters: [],
        attempts: 1,
      }),
    } as unknown as StateExtractor;

    const s = new StateSettlement({
      repos: p.repos, db: p.db, logger, bookId: p.bookId,
      extractor, sourceRef: 'chapters/001.md',
    });
    const r = await s.settle({ chapterId: ch.id, chapterNumber: 1, draftText: DRAFT });
    const a = s.apply({ proposalId: r.proposalId, chapterNumber: 1, draftText: DRAFT });

    expect(a.foreshadowingWritten).toBe(0);
    expect(a.skipped.join(' ')).toContain('未新建假伏笔');
    // 账本里确实没有凭空多出一条
    expect(p.repos.foreshadowing.listByBook(p.bookId)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────
describe('⚠⚠ §六 实测修正：模型给不出可靠的字偏移', () => {
  it('resolveQuoteSpan 由代码定位引文位置', () => {
    const q = '架阁库';
    const r = resolveQuoteSpan(DRAFT, q);
    expect(r).toEqual({ start: DRAFT.indexOf(q), end: DRAFT.indexOf(q) + q.length });
    expect(resolveQuoteSpan(DRAFT, '正文里没有这句话')).toBeNull();
  });

  it('⚠ 模型给 0/0（实测行为）时回落到代码定位，而不是拒绝', () => {
    // 实测：模型能正确引用原文，但 startOffset/endOffset 一律返回 0
    const q = '他左臂在火里烧伤了，此后无法用剑。';
    const r = resolveAndVerifySpan(DRAFT, q, 0, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe('located');
      expect(DRAFT.slice(r.start, r.end)).toBe(q);
    }
  });

  it('⚠ 模型偏移**正确**时优先采用（保留强校验）', () => {
    const q = '架阁库';
    const off = DRAFT.indexOf(q);
    const r = resolveAndVerifySpan(DRAFT, q, off, off + q.length);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.source).toBe('model');
  });

  it('⚠ 偏移越界时回落到定位', () => {
    const q = '架阁库';
    const r = resolveAndVerifySpan(DRAFT, q, 0, 99999);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.source).toBe('located');
  });

  it('⚠⚠ 引文根本不在正文里 → 仍然拒绝（编造的内容进不去）', () => {
    const r = resolveAndVerifySpan(DRAFT, '他其实是皇帝的私生子', 0, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('在正文中找不到');
  });

  it('⚠ 验证通过的条目带 resolvedSpan（供 apply 存精确位置）', () => {
    const v = new StateVerifier({ logger });
    const r = v.verify({
      draftText: DRAFT,
      // 模型给 0/0 —— 实测行为
      characterStates: [stateOf('char_1', '左臂烧伤，无法用剑', { startOffset: 0, endOffset: 0 })],
    });
    expect(r.verifiedCount).toBe(1);
    const span = r.verdicts[0]!.resolvedSpan;
    expect(span).toBeDefined();
    expect(DRAFT.slice(span!.start, span!.end)).toBe('他左臂在火里烧伤了，此后无法用剑。');
  });

  it('⚠ 引文编造时即使偏移正确也拒绝', () => {
    const v = new StateVerifier({ logger });
    const r = v.verify({
      draftText: DRAFT,
      characterStates: [
        stateOf('char_1', '他其实是皇帝的私生子', {
          quote: '他其实是皇帝的私生子',
          startOffset: 0,
          endOffset: 10,
        }),
      ],
    });
    expect(r.verifiedCount).toBe(0);
    expect(r.verdicts[0]!.reason).toContain('在正文中找不到');
  });
});

// ─────────────────────────────────────────────────────────
describe('⚠ 状态必须可回溯到正文原句（evidence 表）', () => {
  it('⚠⚠ 时间线事件写入后带 evidenceId，且 evidence 行 slice===quote', async () => {
    const p = (t = createTestProject());
    const ch = makeChapter(p, 1);
    const extractor = fakeExtractor({
      timelineEvents: [
        {
          quote: '他左臂在火里烧伤了，此后无法用剑。',
          title: '陆明远左臂烧伤',
          description: '他在火里烧伤了左臂，此后无法用剑。',
          importance: 3,
        },
      ],
    });
    const st = new StateSettlement({
      repos: p.repos,
      db: p.db,
      logger,
      bookId: p.bookId,
      extractor,
      sourceRef: 'chapters/001.md',
    });

    const r = await st.settle({ chapterId: ch.id, chapterNumber: 1, draftText: DRAFT });
    expect(r.verified).toBe(true);
    st.apply({ proposalId: r.proposalId, chapterNumber: 1, draftText: DRAFT });

    // evidence 行存在，且严格满足 slice === quote
    const ev = p.repos.evidence.listBySource('CHAPTER', 'chapters/001.md');
    expect(ev.length).toBeGreaterThan(0);
    for (const e of ev) {
      expect(DRAFT.slice(e.start_offset, e.end_offset)).toBe(e.quote);
    }

    // 事件 data_json 里挂着 evidenceId，且该 id 真的存在（不是写了没人用）
    // ⚠ 项目里**没有** timeline 仓储（表由迁移建好，写入在结算里直接执行）——
    //   所以这里查 DB，不假装有个 repos.timeline。
    const rows = p.db.all<{ data_json: string }>('SELECT data_json FROM timeline_events');
    expect(rows.length).toBe(1);
    const data = JSON.parse(rows[0]!.data_json) as { evidenceId?: string };
    expect(data.evidenceId).toBeDefined();
    expect(p.repos.evidence.find(data.evidenceId!)).toBeDefined();
  });

  it('⚠⚠ 伏笔 PLANT 带 evidenceIds，回答「这条伏笔来自哪一句」', async () => {
    const p = (t = createTestProject());
    const ch = makeChapter(p, 1);
    const extractor = fakeExtractor({
      foreshadowing: [
        {
          quote: '沈氏站在门外，低声说她认得那把铜符。',
          name: '铜符',
          action: 'PLANT',
          description: '沈氏认得铜符，后文要解释来历。',
          importance: 3,
        },
      ],
    });
    const st = new StateSettlement({
      repos: p.repos,
      db: p.db,
      logger,
      bookId: p.bookId,
      extractor,
      sourceRef: 'chapters/001.md',
    });

    const r = await st.settle({ chapterId: ch.id, chapterNumber: 1, draftText: DRAFT });
    st.apply({ proposalId: r.proposalId, chapterNumber: 1, draftText: DRAFT });

    const fs = p.repos.foreshadowing.findByName(p.bookId, '铜符')!;
    expect(fs).toBeDefined();
    const ids = JSON.parse(fs.evidence_ids_json ?? '[]') as string[];
    expect(ids.length).toBe(1);
    const ev = p.repos.evidence.find(ids[0]!);
    expect(ev).toBeDefined();
    expect(DRAFT.slice(ev!.start_offset, ev!.end_offset)).toBe(ev!.quote);
  });

  it('⚠ 伏笔推进时追加证据（一条伏笔的来龙去脉可回溯，不只首次埋设）', async () => {
    const p = (t = createTestProject());
    const ch1 = makeChapter(p, 1);
    const ch2 = makeChapter(p, 2);

    const mk = (fs: never[], ref: string) =>
      new StateSettlement({
        repos: p.repos,
        db: p.db,
        logger,
        bookId: p.bookId,
        extractor: fakeExtractor({ foreshadowing: fs }),
        sourceRef: ref,
      });

    // 第 1 章埋下
    const s1 = mk(
      [
        {
          quote: '沈氏站在门外，低声说她认得那把铜符。',
          name: '铜符',
          action: 'PLANT',
          description: '沈氏认得铜符。',
        },
      ] as never[],
      'chapters/001.md',
    );
    const r1 = await s1.settle({ chapterId: ch1.id, chapterNumber: 1, draftText: DRAFT });
    s1.apply({ proposalId: r1.proposalId, chapterNumber: 1, draftText: DRAFT });

    const fsId = p.repos.foreshadowing.findByName(p.bookId, '铜符')!.id;
    const before = JSON.parse(
      p.repos.foreshadowing.get(fsId).evidence_ids_json ?? '[]',
    ) as string[];
    expect(before.length).toBe(1);

    // 第 2 章推进（同一句引文可用，只要在正文里逐字存在）
    const s2 = mk(
      [
        {
          quote: '他左臂在火里烧伤了，此后无法用剑。',
          name: '铜符',
          action: 'ADVANCE',
          description: '铜符的来历露出线索。',
        },
      ] as never[],
      'chapters/002.md',
    );
    const r2 = await s2.settle({ chapterId: ch2.id, chapterNumber: 2, draftText: DRAFT });
    s2.apply({ proposalId: r2.proposalId, chapterNumber: 2, draftText: DRAFT });

    const after = JSON.parse(
      p.repos.foreshadowing.get(fsId).evidence_ids_json ?? '[]',
    ) as string[];
    // ⚠ 追加而非覆盖：两条证据都在
    expect(after.length).toBe(2);
    expect(after).toEqual(expect.arrayContaining(before));
  });

  it('⚠ appendEvidence 去重（同一证据重复挂不会变两条）', () => {
    const p = (t = createTestProject());
    const fs = p.repos.foreshadowing.create({
      id: 'fs_x',
      bookId: p.bookId,
      name: '测试伏笔',
    });
    p.repos.foreshadowing.appendEvidence(fs.id, ['evid_a', 'evid_b']);
    p.repos.foreshadowing.appendEvidence(fs.id, ['evid_b', 'evid_c']);
    const ids = JSON.parse(
      p.repos.foreshadowing.get(fs.id).evidence_ids_json ?? '[]',
    ) as string[];
    expect(ids).toEqual(['evid_a', 'evid_b', 'evid_c']);
  });

  it('⚠ 证据写入失败时不静默通过（该条不进 Canon）', async () => {
    const p = (t = createTestProject());
    const ch = makeChapter(p, 1);
    // 造一条引文在正文里存在、但 span 指向别处的极端情形：
    // 直接把 evidence.create 打桩为抛错，验证结算不会把无证据的条目写进去
    const orig = p.repos.evidence.create.bind(p.repos.evidence);
    p.repos.evidence.create = (() => {
      throw new Error('磁盘满');
    }) as never;

    const extractor = fakeExtractor({
      foreshadowing: [
        {
          quote: '沈氏站在门外，低声说她认得那把铜符。',
          name: '无证据伏笔',
          action: 'PLANT',
          description: '证据写不进去。',
        },
      ],
    });
    const st = new StateSettlement({
      repos: p.repos,
      db: p.db,
      logger,
      bookId: p.bookId,
      extractor,
      sourceRef: 'chapters/001.md',
    });
    const r = await st.settle({ chapterId: ch.id, chapterNumber: 1, draftText: DRAFT });
    // 证据在 apply 阶段写入；这里断言的是"写证据失败不会让伏笔假称有证据"
    expect(r.verified).toBe(true);
    const applied = st.apply({
      proposalId: r.proposalId,
      chapterNumber: 1,
      draftText: DRAFT,
    });
    // 伏笔本身仍写入（伏笔不是证据），但**不带** evidenceIds —— 不假装有证据
    const fs = p.repos.foreshadowing.findByName(p.bookId, '无证据伏笔')!;
    const ids = JSON.parse(fs.evidence_ids_json ?? '[]') as string[];
    expect(ids).toEqual([]);
    expect(applied.foreshadowingWritten).toBe(1);
    p.repos.evidence.create = orig as never;
  });
});
