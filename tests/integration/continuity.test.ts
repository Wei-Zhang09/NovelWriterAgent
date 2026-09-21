/**
 * Continuity Checker 测试（STEP 8，施工文档 §7.6 / §13 / §14）
 *
 * 覆盖施工文档 §「Test C：制造矛盾」的经典案例：
 *   Chapter 10：角色 A 已失明
 *   Chapter 11：让角色 A 正常阅读
 *   → Continuity 必须发现
 *
 * 另验证三条设计约束：
 *   1. 每条 issue 必带 sourceRef（无出处的判断不进结果）
 *   2. 按「章号」取状态，不是最新状态（防假矛盾）
 *   3. 纯只读 —— 检查不写库、不改稿
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ContinuityChecker } from '@nwa/story';
import { Logger } from '@nwa/core';
import { PlanOutputSchema } from '@nwa/shared';
import { createTestProject, type TestProject } from './helpers.js';

let t: TestProject | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const logger = new Logger('test:continuity', { level: 'error' });

/** 造一个带书与角色的测试项目 */
function setup() {
  const proj = createTestProject();
  const projectId = proj.repos.projects.list()[0]!.id;
  const bookId = proj.repos.books.listByProject(projectId)[0]!.id;
  const checker = new ContinuityChecker({ repos: proj.repos, logger, bookId });
  return { proj, bookId, checker };
}

/**
 * 造一条**真实可回溯**的证据。
 *
 * ⚠ evidence.create 强制校验 quote 必须等于 sourceText 的 [start,end) 区间，
 *   所以这里让 sourceText 就是 quote —— 而不是塞一个不存在的 id
 *   （那会触发 FOREIGN KEY 失败，实测踩到）。
 */
function makeEvidence(proj: TestProject, bookId: string, id: string, quote: string) {
  return proj.repos.evidence.create({
    id,
    bookId,
    sourceType: 'CHAPTER',
    sourceRef: `chapters/${id}.md`,
    startOffset: 0,
    endOffset: quote.length,
    quote,
    sourceText: quote,
  });
}

const planWith = (over: Record<string, unknown> = {}) =>
  PlanOutputSchema.parse({
    brief: {
      chapterNumber: 11,
      purpose: 'p',
      previousState: 'a',
      targetState: 'b',
      mainCharacters: ['张三'],
    },
    scenes: [{ sceneId: 's1', purpose: 'p', startState: 'a', endState: 'b' }],
    ...over,
  });

describe('⚠ 死亡状态（§13 的经典案例）', () => {
  it('已死角色出现在正文中 → BLOCKING_CONTINUITY_ERROR', () => {
    const { proj, checker } = setup();
    const c = proj.repos.characters.create({ id: 'ch_zhangsan', bookId: proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id, name: '张三' });
    proj.repos.characters.appendState({
      id: 'cs_1',
      characterId: c.id,
      chapterNumber: 10,
      state: { status: 'DEAD' },
    });

    const report = checker.check({ chapterNumber: 11, draftText: '张三推开门走了进来。' });

    expect(report.ok).toBe(false);
    expect(report.blockingCount).toBe(1);
    const issue = report.issues[0]!;
    expect(issue.code).toBe('BLOCKING_CONTINUITY_ERROR');
    expect(issue.dimension).toBe('deathStatus');
    expect(issue.message).toContain('张三');
    expect(issue.sourceRef).toContain('character_states:');
  });

  it('⚠ 按章号取状态：第 10 章草稿不因"第 20 章才死"而报错', () => {
    const { proj, checker } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    const c = proj.repos.characters.create({ id: 'ch_a', bookId, name: '李四' });
    // 第 20 章死亡
    proj.repos.characters.appendState({
      id: 'cs_20',
      characterId: c.id,
      chapterNumber: 20,
      state: { status: 'DEAD' },
    });

    // 检查第 10 章 —— 那时他还活着
    const report = checker.check({ chapterNumber: 10, draftText: '李四笑着说。' });
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('死亡章之前的草稿正常，死亡章之后的草稿报错（同一角色）', () => {
    const { proj, checker } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    const c = proj.repos.characters.create({ id: 'ch_b', bookId, name: '王五' });
    proj.repos.characters.appendState({
      id: 'cs_d',
      characterId: c.id,
      chapterNumber: 15,
      state: { status: 'DEAD' },
    });

    expect(checker.check({ chapterNumber: 14, draftText: '王五在场。' }).ok).toBe(true);
    expect(checker.check({ chapterNumber: 15, draftText: '王五在场。' }).ok).toBe(false);
    expect(checker.check({ chapterNumber: 16, draftText: '王五在场。' }).ok).toBe(false);
  });

  it('角色未出场则不报问题（名字不在正文里）', () => {
    const { proj, checker } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    const c = proj.repos.characters.create({ id: 'ch_c', bookId, name: '赵六' });
    proj.repos.characters.appendState({
      id: 'cs_c',
      characterId: c.id,
      chapterNumber: 5,
      state: { status: 'DEAD' },
    });

    const report = checker.check({ chapterNumber: 6, draftText: '天气很好，张三出门了。' });
    expect(report.ok).toBe(true);
  });

  it('兼容中文死亡状态写法', () => {
    const { proj, checker } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    const c = proj.repos.characters.create({ id: 'ch_d', bookId, name: '孙七' });
    proj.repos.characters.appendState({
      id: 'cs_d2',
      characterId: c.id,
      chapterNumber: 3,
      state: { lifeState: '已死' },
    });

    expect(checker.check({ chapterNumber: 4, draftText: '孙七走了过来。' }).ok).toBe(false);
  });

  it('状态 JSON 损坏时跳过该角色而不崩溃', () => {
    const { proj, checker } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    const c = proj.repos.characters.create({ id: 'ch_e', bookId, name: '周八' });
    proj.repos.characters.appendState({
      id: 'cs_e',
      characterId: c.id,
      chapterNumber: 2,
      state: { status: 'DEAD' },
    });

    // 直接篡改为损坏 JSON
    proj.db.run("UPDATE character_states SET state_json = '{ 坏' WHERE id = 'cs_e'");

    const report = checker.check({ chapterNumber: 3, draftText: '周八走了过来。' });
    expect(report.ok).toBe(true); // 跳过而非误报
  });
});

describe('⚠ 失明/失聪类 Canon 事实（Test C 的变体）', () => {
  it('Canon 记载失明，正文却写"看" → BLOCKING', () => {
    const { proj, checker } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    const c = proj.repos.characters.create({ id: 'ch_blind', bookId, name: '阿明' });

    const ev = makeEvidence(proj, bookId, 'ev_blind', '阿明从此再也看不见东西');
    proj.repos.facts.propose({
      id: 'fact_blind',
      bookId,
      subjectType: 'CHARACTER',
      subjectId: c.id,
      predicate: '失明',
      objectValue: '失明',
      confidence: 1,
      evidenceId: ev.id,
      sourceChapterId: null, // 外键指向 chapters(id)；本用例不依赖该链接
    });
    // 提升为 Canon
    proj.repos.facts.promoteToCanon('fact_blind');

    const report = checker.check({ chapterNumber: 11, draftText: '阿明看着窗外的雨。' });

    expect(report.ok).toBe(false);
    expect(report.issues[0]!.code).toBe('BLOCKING_CONTINUITY_ERROR');
    expect(report.issues[0]!.message).toContain('阿明');
    expect(report.issues[0]!.sourceRef).toBe('facts:fact_blind');
  });

  it('PROPOSED 状态的事实不参与判定（未确认不能当依据）', () => {
    const { proj, checker } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    const c = proj.repos.characters.create({ id: 'ch_p', bookId, name: '阿华' });

    const ev2 = makeEvidence(proj, bookId, 'ev_p', '阿华的眼睛受了伤');
    proj.repos.facts.propose({
      id: 'fact_p',
      bookId,
      subjectType: 'CHARACTER',
      subjectId: c.id,
      predicate: '失明',
      objectValue: '失明',
      confidence: 0.6,
      evidenceId: ev2.id,
      sourceChapterId: null, // 外键指向 chapters(id)；本用例不依赖该链接
    });
    // 刻意不 promote

    expect(checker.check({ chapterNumber: 11, draftText: '阿华看着窗外。' }).ok).toBe(true);
  });

  it('非"能力缺失"类事实不参与自动判定（避免噪声）', () => {
    const { proj, checker } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    const c = proj.repos.characters.create({ id: 'ch_t', bookId, name: '阿强' });
    const ev3 = makeEvidence(proj, bookId, 'ev_t', '阿强喜欢钓鱼');
    proj.repos.facts.propose({
      id: 'fact_t',
      bookId,
      subjectType: 'CHARACTER',
      subjectId: c.id,
      predicate: '爱好',
      objectValue: '钓鱼',
      confidence: 1,
      evidenceId: ev3.id,
      sourceChapterId: null,
    });
    proj.repos.facts.promoteToCanon('fact_t');

    // 爱好类事实的正反表述需要语义判断，不做自动判定
    expect(checker.check({ chapterNumber: 6, draftText: '阿强看着窗外。' }).ok).toBe(true);
  });
});

describe('伏笔状态（§14 六态机）', () => {
  it('回收已 PAID_OFF 的伏笔 → WARNING', () => {
    const { proj, checker } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    const f = proj.repos.foreshadowing.create({ id: 'fs_1', bookId, name: '戒指上的裂纹' });
    proj.repos.foreshadowing.advance('fs_1', 'PLANTED');
    proj.repos.foreshadowing.advance('fs_1', 'DEVELOPING');
    proj.repos.foreshadowing.advance('fs_1', 'READY');
    proj.repos.foreshadowing.advance('fs_1', 'PAID_OFF', { chapter: 8 });
    expect(f.id).toBe('fs_1');

    const plan = planWith({
      brief: {
        chapterNumber: 11,
        purpose: 'p',
        previousState: 'a',
        targetState: 'b',
        mainCharacters: ['张三'],
        foreshadowing: { plant: [], reinforce: [], payoff: ['戒指上的裂纹'] },
      },
    });

    const report = checker.check({
      chapterNumber: 11,
      draftText: '戒指上的裂纹又出现了。',
      plan,
    });

    expect(report.issues.some((i) => i.code === 'FORESHADOW_ALREADY_PAID')).toBe(true);
  });

  it('回收已 ABANDONED 的伏笔 → BLOCKING', () => {
    const { proj, checker } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    proj.repos.foreshadowing.create({ id: 'fs_2', bookId, name: '旧日的约定' });
    proj.repos.foreshadowing.advance('fs_2', 'ABANDONED');

    const plan = planWith({
      brief: {
        chapterNumber: 11,
        purpose: 'p',
        previousState: 'a',
        targetState: 'b',
        mainCharacters: ['张三'],
        foreshadowing: { plant: [], reinforce: [], payoff: ['旧日的约定'] },
      },
    });

    const report = checker.check({
      chapterNumber: 11,
      draftText: '旧日的约定终于兑现了。',
      plan,
    });

    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'BLOCKING_CONTINUITY_ERROR')).toBe(true);
  });

  it('要回收但未登记的伏笔 → WARNING（无法追溯埋设点）', () => {
    const { checker } = setup();
    const plan = planWith({
      brief: {
        chapterNumber: 11,
        purpose: 'p',
        previousState: 'a',
        targetState: 'b',
        mainCharacters: ['张三'],
        foreshadowing: { plant: [], reinforce: [], payoff: ['从未登记的伏笔'] },
      },
    });

    const report = checker.check({ chapterNumber: 11, draftText: '无关正文。', plan });
    expect(report.issues.some((i) => i.code === 'FORESHADOW_UNREGISTERED')).toBe(true);
  });

  it('计划要回收但正文没写 → WARNING（可能漏写）', () => {
    const { proj, checker } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    proj.repos.foreshadowing.create({ id: 'fs_3', bookId, name: '玉佩' });
    proj.repos.foreshadowing.advance('fs_3', 'PLANTED');
    proj.repos.foreshadowing.advance('fs_3', 'DEVELOPING');
    proj.repos.foreshadowing.advance('fs_3', 'READY');

    const plan = planWith({
      brief: {
        chapterNumber: 11,
        purpose: 'p',
        previousState: 'a',
        targetState: 'b',
        mainCharacters: ['张三'],
        foreshadowing: { plant: [], reinforce: [], payoff: ['玉佩'] },
      },
    });

    // 正文里不能出现"玉佩"二字，否则会命中 includes 检查（用词需谨慎）
    const report = checker.check({ chapterNumber: 11, draftText: '这一章只写了别的事情。', plan });
    expect(report.issues.some((i) => i.code === 'FORESHADOW_NOT_IN_DRAFT')).toBe(true);
  });
});

describe('⚠ 每条 issue 必须可复核（sourceRef 必填）', () => {
  it('所有 issue 都带非空 sourceRef', () => {
    const { proj, checker } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    const c = proj.repos.characters.create({ id: 'ch_x', bookId, name: '张三' });
    proj.repos.characters.appendState({
      id: 'cs_x',
      characterId: c.id,
      chapterNumber: 1,
      state: { status: 'DEAD' },
    });
    proj.repos.foreshadowing.create({ id: 'fs_x', bookId, name: '某伏笔' });

    const report = checker.check({
      chapterNumber: 2,
      draftText: '张三走进来。某伏笔出现了。',
      plan: planWith({
        brief: {
          chapterNumber: 2,
          purpose: 'p',
          previousState: 'a',
          targetState: 'b',
          mainCharacters: ['张三'],
          foreshadowing: { plant: [], reinforce: [], payoff: ['某伏笔'] },
        },
      }),
    });

    expect(report.issues.length).toBeGreaterThan(0);
    for (const i of report.issues) {
      expect(i.sourceRef).toBeTruthy();
      expect(i.sourceRef.length).toBeGreaterThan(0);
    }
  });

  it('checked 统计可用于断言"确实对账了"（防空跑通过）', () => {
    const { proj, checker } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    proj.repos.characters.create({ id: 'ch_1', bookId, name: 'A' });
    proj.repos.characters.create({ id: 'ch_2', bookId, name: 'B' });

    const report = checker.check({ chapterNumber: 1, draftText: 'x', plan: planWith() });
    expect(report.checked.characters).toBe(2);
    expect(report.checked.scenes).toBe(1);
  });
});

describe('⚠ 纯只读（不改稿、不写库）', () => {
  it('检查后章节状态与正文路径均未变', () => {
    const { proj, checker } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    const chapter = proj.repos.chapters.create({ id: 'chap_1', bookId, chapterNumber: 1 });

    const before = proj.repos.chapters.get(chapter.id);
    checker.check({ chapterNumber: 1, draftText: '任意正文' });
    const after = proj.repos.chapters.get(chapter.id);

    expect(after.status).toBe(before.status);
    expect(after.body_path).toBe(before.body_path);
    expect(after.body_path).toBeNull();
  });

  it('检查不新增任何 Canon 事实', () => {
    const { proj, checker } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    const before = proj.repos.facts.listByStatus(bookId, 'CANON').length;
    checker.check({ chapterNumber: 1, draftText: '任意正文' });
    expect(proj.repos.facts.listByStatus(bookId, 'CANON').length).toBe(before);
  });

  it('语义提示是"材料"而非"结论"（交给模型/人工复核）', () => {
    const { checker } = setup();
    const hints = checker.semanticHints(11, '正文内容');
    expect(hints.length).toBeGreaterThan(0);
    for (const h of hints) {
      expect(h.question).toBeTruthy();
      expect(h.material).toBeTruthy();
    }
    expect(hints.map((h) => h.dimension)).toContain('time');
    expect(hints.map((h) => h.dimension)).toContain('worldRule');
  });
});

describe('伏笔六态机的推进规则（§14）', () => {
  it('合法路径可推进', () => {
    const { proj } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    proj.repos.foreshadowing.create({ id: 'fs_ok', bookId, name: 'X' });
    expect(proj.repos.foreshadowing.advance('fs_ok', 'PLANTED').status).toBe('PLANTED');
    expect(proj.repos.foreshadowing.advance('fs_ok', 'DEVELOPING').status).toBe('DEVELOPING');
    expect(proj.repos.foreshadowing.advance('fs_ok', 'READY').status).toBe('READY');
    expect(proj.repos.foreshadowing.advance('fs_ok', 'PAID_OFF', { chapter: 9 }).status).toBe('PAID_OFF');
  });

  it('⚠ 拒绝跳级（PLANNED → PAID_OFF）', () => {
    const { proj } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    proj.repos.foreshadowing.create({ id: 'fs_jump', bookId, name: 'Y' });
    expect(() => proj.repos.foreshadowing.advance('fs_jump', 'PAID_OFF', { chapter: 1 })).toThrow(
      /不允许从 PLANNED 推进到 PAID_OFF/,
    );
  });

  it('⚠ 拒绝从终态再推进', () => {
    const { proj } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    proj.repos.foreshadowing.create({ id: 'fs_end', bookId, name: 'Z' });
    proj.repos.foreshadowing.advance('fs_end', 'ABANDONED');
    expect(() => proj.repos.foreshadowing.advance('fs_end', 'PLANTED')).toThrow(/已是终态/);
  });

  it('推进到 PAID_OFF 必须给回收章号', () => {
    const { proj } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    proj.repos.foreshadowing.create({ id: 'fs_ch', bookId, name: 'W' });
    proj.repos.foreshadowing.advance('fs_ch', 'PLANTED');
    proj.repos.foreshadowing.advance('fs_ch', 'DEVELOPING');
    expect(() => proj.repos.foreshadowing.advance('fs_ch', 'PAID_OFF')).toThrow(/必须提供回收章号/);
  });

  it('回收后记录 payoff_chapter（可追溯第几章收的）', () => {
    const { proj } = setup();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    proj.repos.foreshadowing.create({ id: 'fs_pc', bookId, name: 'V' });
    proj.repos.foreshadowing.advance('fs_pc', 'PLANTED');
    proj.repos.foreshadowing.advance('fs_pc', 'DEVELOPING');
    proj.repos.foreshadowing.advance('fs_pc', 'READY');
    const r = proj.repos.foreshadowing.advance('fs_pc', 'PAID_OFF', { chapter: 42 });
    expect(r.payoff_chapter).toBe(42);
  });
});
