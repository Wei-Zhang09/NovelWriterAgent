/**
 * 仓储层集成测试（STEP 1 验收核心）
 *
 * 重点覆盖三类「如果实现错了，长时间后才会暴露」的问题：
 *   1. 幂等性 —— 投影重放不得产生重复事实（内容派生 ID 的意义）
 *   2. 门禁不可绕过 —— CANON 必须有证据、正式正文只能在 Commit 阶段写
 *   3. 证据可回溯 —— quote 必须真的对得上原文区间，否则拒绝入库
 */
import { describe, it, expect, afterEach } from 'vitest';
import { factId, evidenceId, characterId, chapterId } from '@nwa/core';
import { createTestProject, makeChapter, type TestProject } from './helpers.js';

let t: TestProject | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

describe('项目与章节基础操作', () => {
  it('创建章节后可按章节号查回', () => {
    t = createTestProject();
    makeChapter(t, 1);
    const c = t.repos.chapters.getByNumber(t.bookId, 1);
    expect(c?.chapter_number).toBe(1);
    expect(c?.status).toBe('DRAFT');
    expect(c?.body_path).toBeNull();
  });

  it('同一本书的章节号唯一（UNIQUE 约束）', () => {
    t = createTestProject();
    makeChapter(t, 1);
    expect(() =>
      t!.repos.chapters.create({
        id: 'ch_dup',
        bookId: t!.bookId,
        chapterNumber: 1,
      }),
    ).toThrow(/UNIQUE/i);
  });

  it('⚠ 进度只信物理产物：countCommitted 只数 COMMITTED', () => {
    t = createTestProject();
    makeChapter(t, 1, 'COMMITTED');
    makeChapter(t, 2, 'DRAFT_READY');
    makeChapter(t, 3, 'REVIEWING');
    expect(t.repos.chapters.countCommitted(t.bookId)).toBe(1);
  });

  it('books.advanceTo 只能单调递增，不接受回退', () => {
    t = createTestProject();
    t.repos.books.advanceTo(t.bookId, 5);
    expect(t.repos.books.get(t.bookId).current_chapter).toBe(5);
    // 回退请求被忽略，而不是把进度改小
    t.repos.books.advanceTo(t.bookId, 3);
    expect(t.repos.books.get(t.bookId).current_chapter).toBe(5);
  });
});

describe('⚠ 正式正文写入的门禁（§9.1 代码层强制）', () => {
  it('DRAFT 状态下拒绝写正式正文', () => {
    t = createTestProject();
    const c = makeChapter(t, 1, 'DRAFT');
    expect(() => t!.repos.chapters.setCommittedBody(c.id, 'chapters/001.md', '摘要')).toThrow(
      /拒绝在状态 DRAFT 写入正式正文/,
    );
  });

  it('REVIEWING 状态下同样拒绝', () => {
    t = createTestProject();
    const c = makeChapter(t, 1, 'REVIEWING');
    expect(() => t!.repos.chapters.setCommittedBody(c.id, 'chapters/001.md', '摘要')).toThrow();
  });

  it('COMMITTING 状态允许写入，并置为 COMMITTED', () => {
    t = createTestProject();
    const c = makeChapter(t, 1, 'COMMITTING');
    const after = t.repos.chapters.setCommittedBody(c.id, 'chapters/001.md', '本章摘要');
    expect(after.status).toBe('COMMITTED');
    expect(after.body_path).toBe('chapters/001.md');
    expect(after.summary).toBe('本章摘要');
  });

  it('回滚可清空正文路径并退回 DRAFT_READY', () => {
    t = createTestProject();
    const c = makeChapter(t, 1, 'COMMITTING');
    t.repos.chapters.setCommittedBody(c.id, 'chapters/001.md', 's');
    const rolled = t.repos.chapters.clearCommittedBody(c.id);
    expect(rolled.status).toBe('DRAFT_READY');
    expect(rolled.body_path).toBeNull();
  });
});

describe('⚠ 幂等性：内容派生 ID（研究报告 R7）', () => {
  it('同一事实重复 propose 不产生新行', () => {
    t = createTestProject();
    const id = factId({
      subjectType: 'character',
      subjectId: 'c1',
      predicate: 'status',
      objectValue: 'DEAD',
    });
    const input = {
      id,
      bookId: t.bookId,
      subjectType: 'character',
      subjectId: 'c1',
      predicate: 'status',
      objectValue: 'DEAD',
      confidence: 0.9,
      sourceChapterId: null,
      evidenceId: null,
    };
    t.repos.facts.propose(input);
    t.repos.facts.propose({ ...input, confidence: 0.95 }); // 重放

    const rows = t.db.all('SELECT * FROM facts WHERE id = ?', id);
    expect(rows).toHaveLength(1);
    // 置信度被更新，但仍是同一条事实
    expect(t.repos.facts.get(id).confidence).toBe(0.95);
  });

  it('不同 object 产生不同事实（不是同一条被覆盖）', () => {
    t = createTestProject();
    const base = { subjectType: 'character', subjectId: 'c1', predicate: 'status' } as const;
    const dead = factId({ ...base, objectValue: 'DEAD' });
    const alive = factId({ ...base, objectValue: 'ALIVE' });
    expect(dead).not.toBe(alive);

    for (const [id, v] of [[dead, 'DEAD'], [alive, 'ALIVE']] as const) {
      t.repos.facts.propose({
        id, bookId: t!.bookId, ...base, objectValue: v,
        confidence: 0.9, sourceChapterId: null, evidenceId: null,
      });
    }
    expect(t.db.all('SELECT * FROM facts WHERE book_id = ?', t.bookId)).toHaveLength(2);
  });
});

describe('⚠ CANON 必须有证据（研究报告 R4 代码层强制）', () => {
  it('无证据的事实拒绝推进为 CANON', () => {
    t = createTestProject();
    const id = factId({ subjectType: 'character', subjectId: 'c1', predicate: 'status', objectValue: 'DEAD' });
    t.repos.facts.propose({
      id, bookId: t.bookId, subjectType: 'character', subjectId: 'c1',
      predicate: 'status', objectValue: 'DEAD', confidence: 0.99,
      sourceChapterId: null, evidenceId: null,
    });
    expect(() => t!.repos.facts.promoteToCanon(id)).toThrow(/缺少证据/);
  });

  it('有证据后可推进，且重复推进幂等', () => {
    t = createTestProject();
    const src = '张三死在城门口。李四随后赶到。';
    const quote = '张三死在城门口。';
    const evId = evidenceId({ sourceRef: 'chapters/001.md', startOffset: 0, endOffset: 8, quote });
    t.repos.evidence.create({
      id: evId, bookId: t.bookId, sourceType: 'chapter', sourceRef: 'chapters/001.md',
      quote, startOffset: 0, endOffset: 8, sourceText: src,
    });
    const id = factId({ subjectType: 'character', subjectId: 'c1', predicate: 'status', objectValue: 'DEAD' });
    t.repos.facts.propose({
      id, bookId: t.bookId, subjectType: 'character', subjectId: 'c1',
      predicate: 'status', objectValue: 'DEAD', confidence: 0.99,
      sourceChapterId: null, evidenceId: evId,
    });
    expect(t.repos.facts.promoteToCanon(id).status).toBe('CANON');
    expect(t.repos.facts.promoteToCanon(id).status).toBe('CANON');
  });

  it('confidence 越界被拒绝', () => {
    t = createTestProject();
    expect(() =>
      t!.repos.facts.propose({
        id: 'f1', bookId: t!.bookId, subjectType: 'character', subjectId: null,
        predicate: 'x', objectValue: 'y', confidence: 1.5,
        sourceChapterId: null, evidenceId: null,
      }),
    ).toThrow(/confidence 必须在 \[0,1\] 内/);
  });
});

describe('⚠ 证据必须能对回原文（研究报告 R4）', () => {
  const src = '第三章 张三走了，李四来了。王五说：你好！';

  it('quote 与区间一致时写入成功', () => {
    t = createTestProject();
    const quote = '张三走了';
    const start = src.indexOf(quote);
    const ev = t.repos.evidence.create({
      id: evidenceId({ sourceRef: 'chapters/003.md', startOffset: start, endOffset: start + quote.length, quote }),
      bookId: t.bookId, sourceType: 'chapter', sourceRef: 'chapters/003.md',
      quote, startOffset: start, endOffset: start + quote.length, sourceText: src,
    });
    expect(ev.quote).toBe(quote);
  });

  it('quote 与区间不一致时拒绝写入（防止伪造证据）', () => {
    t = createTestProject();
    expect(() =>
      t!.repos.evidence.create({
        id: 'evid_bad', bookId: t!.bookId, sourceType: 'chapter', sourceRef: 'chapters/003.md',
        quote: '张三死了', // 原文里没有这句
        startOffset: 0, endOffset: 4, sourceText: src,
      }),
    ).toThrow(/quote 与原文区间不一致/);
  });

  it('区间越界被拒绝', () => {
    t = createTestProject();
    expect(() =>
      t!.repos.evidence.create({
        id: 'evid_oob', bookId: t!.bookId, sourceType: 'chapter', sourceRef: 'x.md',
        quote: 'X', startOffset: 0, endOffset: 99999, sourceText: src,
      }),
    ).toThrow(/证据区间非法/);
  });

  it('非整数偏移被拒绝', () => {
    t = createTestProject();
    expect(() =>
      t!.repos.evidence.create({
        id: 'evid_frac', bookId: t!.bookId, sourceType: 'chapter', sourceRef: 'x.md',
        quote: '张', startOffset: 1.5, endOffset: 3, sourceText: src,
      }),
    ).toThrow(/偏移量必须是整数/);
  });

  it('源文被外部修改后，verifyAll 能发现失锚证据', () => {
    t = createTestProject();
    const quote = '张三走了';
    const start = src.indexOf(quote);
    const evId = evidenceId({ sourceRef: 'chapters/003.md', startOffset: start, endOffset: start + quote.length, quote });
    t.repos.evidence.create({
      id: evId, bookId: t.bookId, sourceType: 'chapter', sourceRef: 'chapters/003.md',
      quote, startOffset: start, endOffset: start + quote.length, sourceText: src,
    });

    // 模拟正文被外部改动，同一区间内容变了
    const modified = src.replace('张三走了', '张三离开了');
    const broken = t.repos.evidence.verifyAll(t.bookId, () => modified);
    expect(broken).toHaveLength(1);
    expect(broken[0]!.id).toBe(evId);

    // 源文件缺失也应被发现
    const missing = t.repos.evidence.verifyAll(t.bookId, () => undefined);
    expect(missing[0]!.reason).toMatch(/源文件缺失/);
  });
});

describe('角色状态快照与 as-of 查询', () => {
  it('stateAt 取指定章节（含）之前的最近快照', () => {
    t = createTestProject();
    const cid = characterId();
    t.repos.characters.create({ id: cid, bookId: t.bookId, name: '张三', aliases: ['三哥'] });
    for (const [n, loc] of [[1, '城外'], [5, '城中'], [9, '地牢']] as const) {
      t.repos.characters.appendState({
        id: `cs_${n}`, characterId: cid, chapterNumber: n, state: { location: loc, hp: 100 - n },
      });
    }
    expect(t.repos.characters.readState<{ location: string }>(t.repos.characters.stateAt(cid, 6)!).location).toBe('城中');
    expect(t.repos.characters.readState<{ location: string }>(t.repos.characters.stateAt(cid, 100)!).location).toBe('地牢');
    expect(t.repos.characters.stateAt(cid, 0)).toBeUndefined();
  });

  it('别名可被 findByName 命中', () => {
    t = createTestProject();
    t.repos.characters.create({ id: characterId(), bookId: t.bookId, name: '张三', aliases: ['三哥', '三儿'] });
    expect(t.repos.characters.findByName(t.bookId, '三哥')?.name).toBe('张三');
    expect(t.repos.characters.findByName(t.bookId, '不存在')).toBeUndefined();
  });

  it('同角色同章节的状态唯一（UNIQUE 约束防止重复投影）', () => {
    t = createTestProject();
    const cid = characterId();
    t.repos.characters.create({ id: cid, bookId: t.bookId, name: '张三' });
    t.repos.characters.appendState({ id: 's1', characterId: cid, chapterNumber: 1, state: {} });
    expect(() =>
      t!.repos.characters.appendState({ id: 's2', characterId: cid, chapterNumber: 1, state: {} }),
    ).toThrow(/UNIQUE/i);
  });

  it('按章节删除状态（Commit 回滚路径）', () => {
    t = createTestProject();
    const cid = characterId();
    t.repos.characters.create({ id: cid, bookId: t.bookId, name: '张三' });
    t.repos.characters.appendState({ id: 's1', characterId: cid, chapterNumber: 7, state: {} });
    expect(t.repos.characters.deleteByChapter(cid, 7)).toBe(1);
    expect(t.repos.characters.latestState(cid)).toBeUndefined();
  });
});

describe('矛盾检测（Continuity 的基础查询）', () => {
  it('同一主体同一谓词的两个 CANON 值被识别为冲突', () => {
    t = createTestProject();
    const base = { subjectType: 'character', subjectId: 'c1', predicate: 'status' } as const;
    for (const v of ['DEAD', 'ALIVE'] as const) {
      const src = `他${v}了`;
      const evId = evidenceId({ sourceRef: 'c.md', startOffset: 0, endOffset: src.length, quote: src });
      t.repos.evidence.create({
        id: evId, bookId: t.bookId, sourceType: 'chapter', sourceRef: 'c.md',
        quote: src, startOffset: 0, endOffset: src.length, sourceText: src,
      });
      const fid = factId({ ...base, objectValue: v });
      t.repos.facts.propose({
        id: fid, bookId: t.bookId, ...base, objectValue: v,
        confidence: 0.9, sourceChapterId: null, evidenceId: evId,
      });
      t.repos.facts.promoteToCanon(fid);
    }
    const conflicts = t.repos.facts.findCanonConflicts(t.bookId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.values.sort()).toEqual(['ALIVE', 'DEAD']);
  });

  it('无冲突时返回空数组', () => {
    t = createTestProject();
    expect(t.repos.facts.findCanonConflicts(t.bookId)).toEqual([]);
  });
});

describe('run / event / checkpoint', () => {
  it('事件 category 由事件类型自动派生（ADR-0006 约束 B）', () => {
    t = createTestProject();
    const run = t.repos.runs.create({ id: 'run_1', projectId: t.projectId, workflowType: 'chapter' });
    const commitEv = t.repos.runs.appendEvent({
      id: 'e1', runId: run.id, eventType: 'COMMIT_COMPLETED', payload: { chapter: 1 },
    });
    const modelEv = t.repos.runs.appendEvent({
      id: 'e2', runId: run.id, eventType: 'MODEL_CALL_COMPLETED', payload: { tokens: 100 },
    });
    expect(commitEv.category).toBe('STATE');
    expect(modelEv.category).toBe('OBSERVABILITY');
    expect(t.repos.runs.countEvents(run.id, 'STATE')).toBe(1);
    expect(t.repos.runs.countEvents(run.id, 'OBSERVABILITY')).toBe(1);
  });

  it('可按 category 过滤事件（为保留策略做准备）', () => {
    t = createTestProject();
    const run = t.repos.runs.create({ id: 'run_2', projectId: t.projectId, workflowType: 'chapter' });
    t.repos.runs.appendEvent({ id: 'a', runId: run.id, eventType: 'RUN_STARTED' });
    t.repos.runs.appendEvent({ id: 'b', runId: run.id, eventType: 'CONTEXT_BUILT' });
    expect(t.repos.runs.listEvents(run.id, 'STATE')).toHaveLength(1);
    expect(t.repos.runs.listEvents(run.id)).toHaveLength(2);
  });

  it('checkpoint 可取最近一条（恢复入口）', async () => {
    t = createTestProject();
    const run = t.repos.runs.create({ id: 'run_3', projectId: t.projectId, workflowType: 'chapter' });
    t.repos.runs.saveCheckpoint({
      id: 'ck1', runId: run.id, stage: 'PLANNING',
      state: { step: 'plan' }, artifactManifest: { files: ['plan.json'] }, schemaVersion: '0001_init',
    });
    await new Promise((r) => setTimeout(r, 5));
    t.repos.runs.saveCheckpoint({
      id: 'ck2', runId: run.id, stage: 'WRITING',
      state: { step: 'write' }, artifactManifest: { files: ['draft.md'] }, schemaVersion: '0001_init',
    });
    const latest = t.repos.runs.latestCheckpoint(run.id);
    expect(latest?.stage).toBe('WRITING');
    expect(t.repos.runs.readCheckpoint<{ step: string }>(latest!).state.step).toBe('write');
  });

  it('run 结束后状态与时间戳被记录', () => {
    t = createTestProject();
    const run = t.repos.runs.create({ id: 'run_4', projectId: t.projectId, workflowType: 'chapter' });
    expect(run.ended_at).toBeNull();
    const done = t.repos.runs.finish(run.id, 'SUCCEEDED', { chapters: 1 });
    expect(done.status).toBe('SUCCEEDED');
    expect(done.ended_at).not.toBeNull();
    expect(t.repos.runs.listActive(t.projectId)).toHaveLength(0);
  });
});

describe('JSON 列容错', () => {
  it('损坏的 plan_json 抛 WORKSPACE_CORRUPTED，而不是静默返回 null', () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    // 直接写入非法 JSON 模拟数据损坏
    t.db.run('UPDATE chapters SET plan_json = ? WHERE id = ?', '{不是合法 json', c.id);
    expect(() => t!.repos.chapters.readPlan(c.id)).toThrow(/不是合法 JSON/);
  });

  it('正常 JSON 可往返', () => {
    t = createTestProject();
    const c = makeChapter(t, 1);
    const plan = { purpose: '引入主角', scenes: [{ id: 's1' }] };
    t.repos.chapters.savePlan(c.id, plan);
    expect(t.repos.chapters.readPlan<typeof plan>(c.id)).toEqual(plan);
  });
});

describe('章节 ID 契约', () => {
  it('chapterId 与 workspaceDirName 的零填充一致', () => {
    t = createTestProject();
    const c = makeChapter(t, 7);
    expect(c.id).toBe(chapterId(t.bookId, 7));
    expect(c.id.endsWith('_007')).toBe(true);
  });
});
