/**
 * 分层检索集成测试（P0-3）。
 *
 * ## 覆盖提示词 §五 的点名要求
 *
 * ```
 * Planner    → chapter-level
 * Writer     → scene-level
 * Reviewer   → evidence-level
 * Continuity → Canon / CharacterState / Timeline / Foreshadowing 优先
 * ```
 *
 * ## 为什么必须用**真数据库**
 *
 * 这一项的全部价值在于"检索真的接上了主链"。
 * 用假仓储测就只证明了"我把参数传对了"，而真实的坑在 SQL 与表结构上 ——
 * 本次实现时**每一条 SQL 初稿的列名都是错的**（凭印象写的），
 * 只有对着真 schema 跑才暴露出来。
 *
 * ## 检索痕迹
 *
 * 提示词要求能回答「为什么这一章会引用那个旧章节」。
 * 这里验证：痕迹真的落库、能按 stage / hitId 反查。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { RetrievalService, WorkflowRepository } from '@nwa/harness';
import { createTestProject, makeChapter, chapterId, characterId, type TestProject } from './helpers.js';
import { evidenceId, factId, eventId } from '@nwa/core';
import { now } from '@nwa/storage';

let t: TestProject | null = null;

afterEach(() => {
  t?.cleanup();
  t = null;
});

/** 用真分词口径构造 MATCH（与索引侧一致） */
const buildMatch = (q: string): string => {
  // 测试里不引入 jieba：把查询按字切分并用 AND 连接，
  // 足以验证 SQL 通路（真实实现由 app 层注入 bigramTokenizer）
  const chars = q.replace(/\s+/g, '').split('');
  if (chars.length === 0) return '';
  return chars.map((c) => `"${c}"`).join(' AND ');
};

function svc(project: TestProject, withTraces = true): RetrievalService {
  return new RetrievalService({
    db: project.db,
    logger: { debug() {}, info() {}, warn() {}, error() {}, child: () => ({}) } as never,
    buildMatch,
    ...(withTraces
      ? {
          recordTraces: (rows) =>
            new WorkflowRepository(project.db).addRetrievalTraces(rows),
        }
      : {}),
  });
}

/** 往 FTS 里塞一个已提交章节（模拟 commit-engine 的索引写入） */
function indexCommittedChapter(
  project: TestProject,
  n: number,
  text: string,
  status = 'COMMITTED',
): string {
  const id = chapterId(project.bookId, n);
  makeChapter(project, n, status);
  project.db.run(
    `INSERT INTO chapter_fts (tokens, chapter_id, book_id, chapter_number, source_ref)
     VALUES (?,?,?,?,?)`,
    text,
    id,
    project.bookId,
    n,
    `chapters/${String(n).padStart(3, '0')}.md`,
  );
  return id;
}

describe('P0-3 · 分层检索：各 stage 拿不同粒度', () => {
  it('⚠ Planner 用章节级：能查到摘要与已提交正文', () => {
    const project = createTestProject();
    t = project;
    indexCommittedChapter(project, 1, '临 江 府 架 阁 库 失 火');
    project.db.run(
      `INSERT INTO memory_items (id, book_id, type, title, content, source_ref, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      'mem_1', project.bookId, 'PLOT', '第一章摘要', '架阁库失火，陆明远被贬',
      'chapters/001.md', now(), now(),
    );
    project.db.run(
      `INSERT INTO memory_fts (tokens, item_id, book_id, item_type, source_ref)
       VALUES (?,?,?,?,?)`,
      '架 阁 库 失 火', 'mem_1', project.bookId, 'PLOT', 'chapters/001.md',
    );

    const r = svc(project).gatherChapterLevel({
      bookId: project.bookId,
      chapterNumber: 3,
      query: '架阁库失火',
      stage: 'planner',
    });

    expect(r.tier).toBe('chapter');
    expect(r.retrieved).toBe(true);
    expect(r.hits.length).toBeGreaterThan(0);
    const retrievers = r.hits.map((h) => h.retriever);
    expect(retrievers).toContain('memory_fts');
    expect(retrievers).toContain('chapter_fts');
    // ⚠ 每条都必须带 sourceRef（§11 禁止无根记忆）
    for (const h of r.hits) expect(h.sourceRef.length).toBeGreaterThan(0);
  });

  it('⚠ Planner 不引用未提交章节（草稿会被推翻，不能当"已发生的事"）', () => {
    const project = createTestProject();
    t = project;
    indexCommittedChapter(project, 1, '架 阁 库 失 火', 'DRAFT');

    const r = svc(project).gatherChapterLevel({
      bookId: project.bookId,
      chapterNumber: 3,
      query: '架阁库失火',
      stage: 'planner',
    });
    expect(r.hits).toHaveLength(0);
  });

  it('⚠ Writer 用场景级：查已提交正文，且**排除当前章**（不能抄自己）', () => {
    const project = createTestProject();
    t = project;
    indexCommittedChapter(project, 1, '雨 夜 对 峙 张 力');
    indexCommittedChapter(project, 2, '雨 夜 对 峙 再 起');

    const r = svc(project).gatherSceneLevel({
      bookId: project.bookId,
      chapterNumber: 2, // 当前章是 2
      query: '雨夜对峙',
      stage: 'writer',
    });

    expect(r.tier).toBe('scene');
    // 只应有第 1 章，不含第 2 章自己
    const ids = r.hits.map((h) => h.hitId);
    expect(ids).toContain(chapterId(project.bookId, 1));
    expect(ids).not.toContain(chapterId(project.bookId, 2));
  });

  it('⚠ Reviewer 用证据级：读 evidence 表，且 score 为 null（证据不是打分排的）', () => {
    const project = createTestProject();
    t = project;
    const cid = makeChapter(project, 1, 'COMMITTED').id;
    const eid = evidenceId({
      sourceRef: 'chapters/001.md',
      startOffset: 0,
      endOffset: 12,
      quote: '陆明远说他不认识沈氏',
    });
    project.db.run(
      `INSERT INTO evidence (id, book_id, source_type, source_ref, quote, start_offset, end_offset, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      eid, project.bookId, 'CHAPTER', 'chapters/001.md', '陆明远说他不认识沈氏', 0, 12, now(),
    );
    void cid;

    const r = svc(project).gatherEvidenceLevel({
      bookId: project.bookId,
      chapterNumber: 2,
      query: '沈氏',
      stage: 'reviewer',
    });

    expect(r.tier).toBe('evidence');
    expect(r.retrieved).toBe(true);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.content).toContain('陆明远说他不认识沈氏');
    // ⚠ 证据不是 BM25 排出来的 —— 编个分数会让人误以为有相关度排序
    expect(r.hits[0]!.score).toBeNull();
    expect(r.hits[0]!.retriever).toBe('evidence_table');
  });

  it('⚠ Continuity 优先结构化：四类真值都能读到', () => {
    const project = createTestProject();
    t = project;
    const cid = makeChapter(project, 1, 'COMMITTED').id;

    // Canon 事实
    const fid = factId({
      subjectType: 'CHARACTER',
      subjectId: 'char_x',
      predicate: '身份',
      objectValue: '陆明远是主簿',
    });
    project.db.run(
      `INSERT INTO facts (id, book_id, subject_type, predicate, object_value, status, confidence, source_chapter_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      fid, project.bookId, 'CHARACTER', '身份', '陆明远是主簿', 'CANON', 0.9, cid, now(), now(),
    );

    // 角色状态
    const charId = characterId();
    project.repos.characters.create({ id: charId, bookId: project.bookId, name: '陆明远' });
    project.db.run(
      `INSERT INTO character_states (id, character_id, chapter_number, state_json, created_at)
       VALUES (?,?,?,?,?)`,
      'cs_1', charId, 1, JSON.stringify({ status: '被贬临江府' }), now(),
    );

    // 时间线
    const eid = eventId({ chapter: 1, index: 0, payload: { title: '架阁库失火' } });
    project.db.run(
      `INSERT INTO timeline_events (id, book_id, narrative_chapter, narrative_offset, title, description, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      eid, project.bookId, 1, 0, '架阁库失火', '架阁库起火', now(),
    );

    // 伏笔
    project.repos.foreshadowing.create({
      id: 'fs_1', bookId: project.bookId, name: '半枚铜符',
      setupChapter: 1, tier: 'CORE',
    });

    const r = svc(project).gatherForContinuity({
      bookId: project.bookId,
      chapterNumber: 3,
      query: '连续性检查',
      stage: 'continuity',
    });

    const byRetriever = new Set(r.hits.map((h) => h.retriever));
    expect(byRetriever.has('canon_facts')).toBe(true);
    expect(byRetriever.has('character_states')).toBe(true);
    expect(byRetriever.has('timeline_events')).toBe(true);
    expect(byRetriever.has('foreshadowing')).toBe(true);
    const fs = r.hits.find((h) => h.retriever === 'foreshadowing')!;
    expect(fs.content).toContain('半枚铜符');
    expect(r.retrieved).toBe(true);

    // 内容可读（不是只给了个 id）
    const fact = r.hits.find((h) => h.retriever === 'canon_facts')!;
    expect(fact.content).toContain('陆明远是主簿');
    const cs = r.hits.find((h) => h.retriever === 'character_states')!;
    expect(cs.content).toContain('被贬临江府');
  });

  it('⚠ 结构化真值读取失败时**如实降级**，不是静默返回空', () => {
    const project = createTestProject();
    t = project;
    // 把 facts 表改名 → 读取必然失败
    project.db.run('ALTER TABLE facts RENAME TO facts_backup');

    const truth = svc(project).readStructuredTruth({
      bookId: project.bookId,
      chapterNumber: 1,
    });

    expect(truth.warnings.length).toBeGreaterThan(0);
    expect(truth.warnings.join(' ')).toContain('facts');
    // 其他表仍应正常读到（分别降级，不是一失败全失败）
    expect(truth.characterStates).toBeDefined();
    expect(truth.foreshadowing).toBeDefined();
  });

  it('⚠ 检索层不可用时 retrieved=false —— 不是"没有相关记忆"', () => {
    const project = createTestProject();
    t = project;
    // 空查询 → 无法构造 MATCH → 如实报告失败
    const r = svc(project).gatherSceneLevel({
      bookId: project.bookId,
      chapterNumber: 2,
      query: '   ',
      stage: 'writer',
    });
    expect(r.retrieved).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.hits).toHaveLength(0);
  });
});

describe('P0-3 · 检索痕迹：让"为什么引用那个旧章节"可回答', () => {
  it('⚠ 痕迹落库，可按 stage 查', () => {
    const project = createTestProject();
    t = project;
    indexCommittedChapter(project, 1, '架 阁 库 失 火');

    svc(project).gatherChapterLevel({
      bookId: project.bookId,
      chapterNumber: 3,
      query: '架阁库失火',
      stage: 'planner',
    });

    const repo = new WorkflowRepository(project.db);
    const rows = repo.listRetrievalTraces({ stage: 'planner' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.stage).toBe('planner');
    expect(rows[0]!.query).toBe('架阁库失火');
    expect(rows[0]!.sourceRef).toBeTruthy();
    expect(rows[0]!.reason).toBeTruthy();
    expect(rows[0]!.createdAt).toBeTruthy();
  });

  it('⚠ 痕迹可按 hitId 反查 —— "这个旧章节被谁引用过"', () => {
    const project = createTestProject();
    t = project;
    const cid = indexCommittedChapter(project, 1, '架 阁 库 失 火');

    svc(project).gatherChapterLevel({
      bookId: project.bookId,
      chapterNumber: 3,
      query: '架阁库失火',
      stage: 'planner',
    });

    const rows = new WorkflowRepository(project.db).listRetrievalTraces({ hitId: cid });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.hitId).toBe(cid);
  });

  it('⚠ 不同 stage 的痕迹可分别回答（Planner 与 Writer 是不同问题）', () => {
    const project = createTestProject();
    t = project;
    indexCommittedChapter(project, 1, '架 阁 库 失 火');

    const s = svc(project);
    s.gatherChapterLevel({
      bookId: project.bookId, chapterNumber: 3, query: '架阁库失火', stage: 'planner',
    });
    s.gatherSceneLevel({
      bookId: project.bookId, chapterNumber: 3, query: '架阁库失火', stage: 'writer',
    });

    const repo = new WorkflowRepository(project.db);
    expect(repo.listRetrievalTraces({ stage: 'planner' }).length).toBeGreaterThan(0);
    expect(repo.listRetrievalTraces({ stage: 'writer' }).length).toBeGreaterThan(0);
    // 两者的 trace id 不重叠
    const p1 = repo.listRetrievalTraces({ stage: 'planner' }).map((r) => r.id);
    const w1 = repo.listRetrievalTraces({ stage: 'writer' }).map((r) => r.id);
    expect(p1.some((x) => w1.includes(x))).toBe(false);
  });

  it('⚠ 痕迹写入失败不阻断检索（观测不该决定流程）', () => {
    const project = createTestProject();
    t = project;
    indexCommittedChapter(project, 1, '架 阁 库 失 火');

    const s = new RetrievalService({
      db: project.db,
      logger: { debug() {}, info() {}, warn() {}, error() {}, child: () => ({}) } as never,
      buildMatch,
      // 落库抛错 —— 检索结果仍必须返回
      recordTraces: () => {
        throw new Error('模拟痕迹表不可用');
      },
    });

    const r = s.gatherChapterLevel({
      bookId: project.bookId, chapterNumber: 3, query: '架阁库失火', stage: 'planner',
    });
    expect(r.retrieved).toBe(true);
    expect(r.hits.length).toBeGreaterThan(0);
  });

  it('⚠ 没有相关命中时不写痕迹（不留空记录）', () => {
    const project = createTestProject();
    t = project;
    indexCommittedChapter(project, 1, '完 全 无 关 的 内 容');

    svc(project).gatherChapterLevel({
      bookId: project.bookId, chapterNumber: 3, query: '架阁库失火', stage: 'planner',
    });

    expect(new WorkflowRepository(project.db).listRetrievalTraces({}).length).toBe(0);
  });
});
