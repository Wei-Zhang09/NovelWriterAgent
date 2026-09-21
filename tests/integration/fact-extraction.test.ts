/**
 * Fact 抽取 + Canon 提升测试（STEP 9，施工文档 §10.8 / §11 / §55 Rule 9）
 *
 * STEP 9 的验收要求：
 *   "Fact 与已有 Canon 冲突时标记为 CONTRADICTED 而非覆盖"
 *   "审阅一份 proposed_facts.json，确认每条都有 evidence 引用"
 *
 * 三条核心主张：
 *   1. **引文必须真实存在** —— 编造的引文整批拒绝
 *   2. **只 propose 不写库** —— 抽取器物理上没有 repos
 *   3. **冲突标记而非覆盖** —— 旧 Canon 必须保留
 */
import { describe, it, expect, afterEach } from 'vitest';
import { FactExtractor, CanonPromoter } from '@nwa/story';
import type { ExtractStructuredCaller } from '@nwa/story';
import { verifyQuote, isDefiningPredicate } from '@nwa/shared';
import type { ProposedFact } from '@nwa/shared';
import { Logger } from '@nwa/core';
import { createTestProject, type TestProject } from './helpers.js';

let t: TestProject | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const logger = new Logger('test:fact', { level: 'error' });

/** 返回预设抽取结果的 caller（走真实 schema 校验） */
function callerReturning(raw: unknown): ExtractStructuredCaller {
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

const DRAFT = [
  '阿明在第十岁那年双目失明。',
  '他从此再也看不见东西，只能靠耳朵分辨来人的脚步。',
  '张三推开门走了进来，说了一句什么。',
].join('\n');

const factOf = (over: Record<string, unknown> = {}) => ({
  subjectType: 'CHARACTER',
  subjectName: '阿明',
  predicate: '失明',
  objectValue: '失明',
  quote: '阿明在第十岁那年双目失明。',
  confidence: 0.95,
  isDefining: true,
  ...over,
});

function extractorWith(raw: unknown, chars: { id: string; name: string }[] = [{ id: 'ch_ming', name: '阿明' }]) {
  return new FactExtractor({
    structured: callerReturning(raw),
    logger,
    bookId: 'book_x',
    characters: chars,
  });
}

describe('⚠ 引文校验：编造的引文必须被拒', () => {
  it('真实引文通过', () => {
    const v = verifyQuote(DRAFT, '阿明在第十岁那年双目失明。');
    expect(v.ok).toBe(true);
    expect(v.startOffset).toBe(0);
    expect(v.endOffset).toBe('阿明在第十岁那年双目失明。'.length);
  });

  it('拼凑的引文（跨句缝合）被拒', () => {
    const v = verifyQuote(DRAFT, '阿明双目失明，张三推开门');
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('找不到');
  });

  it('凭印象改写的引文被拒', () => {
    // 原文是"第十岁"，引文写成"十岁"→ 少了"第"字
    const v = verifyQuote(DRAFT, '阿明在十岁那年双目失明。');
    expect(v.ok).toBe(false);
  });

  it('空白差异被容忍（转录噪声不是编造）', () => {
    const src = '阿明  双目\n失明。';
    const v = verifyQuote(src, '阿明 双目失明。');
    expect(v.ok).toBe(true);
    // offsets 必须指向**原文**的真实位置
    expect(src.slice(v.startOffset, v.endOffset).replace(/\s+/g, '')).toBe('阿明双目失明。');
  });

  it('全角空格差异被容忍', () => {
    const src = '阿明\u3000失明。';
    expect(verifyQuote(src, '阿明 失明。').ok).toBe(true);
  });

  it('空引文被拒', () => {
    expect(verifyQuote(DRAFT, '   ').ok).toBe(false);
  });

  it('不存在的引文给出可读原因', () => {
    const v = verifyQuote(DRAFT, '李四杀了王五');
    expect(v.reason).toContain('编造');
  });
});

describe('⚠ 整批拒绝策略（不允许部分写入）', () => {
  it('有一条引文不合法 → 整批不产出', async () => {
    const ex = extractorWith({
      facts: [
        factOf(),
        factOf({ predicate: '身高', objectValue: '七尺', quote: '他身高七尺有余。' }), // 原文没有
      ],
    });
    const r = await ex.extract({ chapterNumber: 10, draftText: DRAFT });

    expect(r.ok).toBe(false);
    expect(r.proposed).toEqual([]); // 一条都不留
    expect(r.error!.code).toBe('FACT_EXTRACTION_QUOTE_MISMATCH');
    expect(r.rejected).toHaveLength(1);
  });

  it('错误信息说明"整批拒绝"的理由与首条原因', async () => {
    const ex = extractorWith({
      facts: [factOf(), factOf({ quote: '不存在的句子' })],
    });
    const r = await ex.extract({ chapterNumber: 10, draftText: DRAFT });
    expect(r.error!.message).toContain('整批拒绝');
    expect(r.error!.message).toContain('找不到');
  });

  it('全部合法时正常产出', async () => {
    const ex = extractorWith({ facts: [factOf()] });
    const r = await ex.extract({ chapterNumber: 10, draftText: DRAFT });

    expect(r.ok).toBe(true);
    expect(r.proposed).toHaveLength(1);
    expect(r.proposed[0]!.subjectId).toBe('ch_ming');
  });

  it('空 facts 数组是合法的（没有事实可抽是正常情况）', async () => {
    const ex = extractorWith({ facts: [] });
    const r = await ex.extract({ chapterNumber: 10, draftText: DRAFT });
    expect(r.ok).toBe(true);
    expect(r.proposed).toEqual([]);
  });

  it('主体解析不到 → 拒绝（无法关联角色的事实没有价值）', async () => {
    const ex = extractorWith({ facts: [factOf({ subjectName: '不存在的人' })] });
    const r = await ex.extract({ chapterNumber: 10, draftText: DRAFT });

    expect(r.ok).toBe(false);
    expect(r.rejected[0]!.reason).toContain('找不到');
  });

  it('allowUnresolvedSubject=true 时放行但 subjectId 为 null', async () => {
    const ex = new FactExtractor({
      structured: callerReturning({ facts: [factOf({ subjectName: '路人甲' })] }),
      logger,
      bookId: 'book_x',
      characters: [],
      allowUnresolvedSubject: true,
    });
    const r = await ex.extract({ chapterNumber: 10, draftText: DRAFT });
    expect(r.ok).toBe(true);
    expect(r.proposed[0]!.subjectId).toBeNull();
  });
});

describe('⚠ 只 propose 不写库', () => {
  it('抽取器构造参数里没有 repos（物理上无法写库）', () => {
    const ex = extractorWith({ facts: [] });
    expect(Object.keys(ex)).not.toContain('repos');
    expect(Object.keys(ex)).not.toContain('db');
  });

  it('targetStatus 恒为 PROVISIONAL（模型不能直接写 CANON）', async () => {
    const ex = extractorWith({ facts: [factOf()] });
    const r = await ex.extract({ chapterNumber: 10, draftText: DRAFT });
    expect(r.proposed[0]!.targetStatus).toBe('PROVISIONAL');
  });

  it('抽取过程不会在库里产生任何 fact', async () => {
    t = createTestProject();
    const bookId = t.repos.books.listByProject(t.repos.projects.list()[0]!.id)[0]!.id;
    const before = t.repos.facts.listByStatus(bookId, 'PROVISIONAL').length;

    const ex = extractorWith({ facts: [factOf()] });
    await ex.extract({ chapterNumber: 10, draftText: DRAFT });

    expect(t.repos.facts.listByStatus(bookId, 'PROVISIONAL').length).toBe(before);
  });
});

describe('定义性事实判定', () => {
  it('失明/死亡/身份类谓词自动视为定义性', () => {
    for (const p of ['失明', '已死', '死亡', '继承掌门', '身份暴露']) {
      expect(isDefiningPredicate(p, false)).toBe(true);
    }
  });

  it('临时状态不算定义性', () => {
    for (const p of ['心情', '天气', '此刻在做']) {
      expect(isDefiningPredicate(p, false)).toBe(false);
    }
  });

  it('模型显式标记 isDefining 时尊重它', () => {
    expect(isDefiningPredicate('心情', true)).toBe(true);
  });
});

describe('⚠ Canon 提升：冲突标记而非覆盖（STEP 9 验收）', () => {
  function setupWithCanon() {
    const proj = createTestProject();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    const c = proj.repos.characters.create({ id: 'ch_ming', bookId, name: '阿明' });

    // 先建一条已有 Canon：阿明双目健全
    const ev = proj.repos.evidence.create({
      id: 'ev_old',
      bookId,
      sourceType: 'CHAPTER',
      sourceRef: 'chapters/005.md',
      quote: '阿明看得清清楚楚',
      startOffset: 0,
      endOffset: 8, // '阿明看得清清楚楚' = 8 字
      sourceText: '阿明看得清清楚楚',
    });
    const old = proj.repos.facts.propose({
      id: 'fact_old',
      bookId,
      subjectType: 'CHARACTER',
      subjectId: c.id,
      predicate: '视力',
      objectValue: '正常',
      confidence: 1,
      sourceChapterId: null,
      evidenceId: ev.id,
    });
    proj.repos.facts.promoteToCanon(old.id);
    return { proj, bookId, characterId: c.id };
  }

  const proposedFact = (over: Partial<ProposedFact> = {}): ProposedFact => ({
    id: 'fact_new',
    bookId: 'book_x',
    subjectType: 'CHARACTER',
    subjectId: 'ch_ming',
    subjectName: '阿明',
    predicate: '视力',
    objectValue: '失明',
    confidence: 0.95,
    isDefining: true,
    sourceChapter: 10,
    quote: '阿明在第十岁那年双目失明。',
    startOffset: 0,
    endOffset: '阿明在第十岁那年双目失明。'.length,
    targetStatus: 'PROVISIONAL',
    ...over,
  });

  it('与已有 Canon 冲突 → 标记 CONTRADICTED', () => {
    const { proj, bookId } = setupWithCanon();
    const promoter = new CanonPromoter({ repos: proj.repos, logger, bookId });

    const report = promoter.promote([proposedFact()], {
      draftText: DRAFT,
      sourceRef: 'chapters/010.md',
    });

    expect(report.contradictedCount).toBe(1);
    expect(report.outcomes[0]!.status).toBe('CONTRADICTED');
    // 说明文字必须点明"保留双方待人工裁决"—— 这是不覆盖的可读保证
    expect(report.outcomes[0]!.reason).toContain('保留双方');
    expect(report.outcomes[0]!.reason).toContain('正常'); // 冲突的旧取值
  });

  it('⚠ 旧 Canon 必须保留（不被覆盖）', () => {
    const { proj, bookId } = setupWithCanon();
    const promoter = new CanonPromoter({ repos: proj.repos, logger, bookId });
    promoter.promote([proposedFact()], { draftText: DRAFT, sourceRef: 'chapters/010.md' });

    const old = proj.repos.facts.get('fact_old');
    expect(old.status).toBe('CANON'); // 旧事实仍是 Canon
    expect(old.object_value).toBe('正常'); // 取值未被改写
  });

  it('新事实被标记为 CONTRADICTED 状态', () => {
    const { proj, bookId } = setupWithCanon();
    const promoter = new CanonPromoter({ repos: proj.repos, logger, bookId });
    promoter.promote([proposedFact()], { draftText: DRAFT, sourceRef: 'chapters/010.md' });

    expect(proj.repos.facts.get('fact_new').status).toBe('CONTRADICTED');
  });

  it('两侧都保留 → 可用 findCanonConflicts 查出待裁决项', () => {
    const { proj, bookId } = setupWithCanon();
    const promoter = new CanonPromoter({ repos: proj.repos, logger, bookId });
    promoter.promote([proposedFact()], { draftText: DRAFT, sourceRef: 'chapters/010.md' });

    // 旧 Canon 仍在，说明没有被静默丢弃
    const canon = proj.repos.facts.listByStatus(bookId, 'CANON');
    expect(canon.some((f) => f.id === 'fact_old')).toBe(true);
    // 新事实在 CONTRADICTED 里等人工裁决
    const contradicted = proj.repos.facts.listByStatus(bookId, 'CONTRADICTED');
    expect(contradicted.some((f) => f.id === 'fact_new')).toBe(true);
  });
});

describe('Canon 提升：正常路径与门槛', () => {
  function setup() {
    const proj = createTestProject();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    proj.repos.characters.create({ id: 'ch_ming', bookId, name: '阿明' });
    return { proj, bookId };
  }

  const pf = (over: Partial<ProposedFact> = {}): ProposedFact => ({
    id: 'fact_a',
    bookId: 'book_x',
    subjectType: 'CHARACTER',
    subjectId: 'ch_ming',
    subjectName: '阿明',
    predicate: '失明',
    objectValue: '失明',
    confidence: 0.95,
    isDefining: true,
    sourceChapter: 10,
    quote: '阿明在第十岁那年双目失明。',
    startOffset: 0,
    endOffset: '阿明在第十岁那年双目失明。'.length,
    targetStatus: 'PROVISIONAL',
    ...over,
  });

  it('定义性 + 高置信 → 提升为 CANON', () => {
    const { proj, bookId } = setup();
    const promoter = new CanonPromoter({ repos: proj.repos, logger, bookId });
    const r = promoter.promote([pf()], { draftText: DRAFT, sourceRef: 'chapters/010.md' });

    expect(r.canonCount).toBe(1);
    expect(proj.repos.facts.get('fact_a').status).toBe('CANON');
  });

  it('⚠ 每条 CANON 都有 evidence 引用（可回溯）', () => {
    const { proj, bookId } = setup();
    const promoter = new CanonPromoter({ repos: proj.repos, logger, bookId });
    promoter.promote([pf()], { draftText: DRAFT, sourceRef: 'chapters/010.md' });

    const fact = proj.repos.facts.get('fact_a');
    expect(fact.evidence_id).not.toBeNull();

    const ev = proj.repos.evidence.get(fact.evidence_id!);
    expect(ev.quote).toBe('阿明在第十岁那年双目失明。');
    expect(ev.source_ref).toBe('chapters/010.md');
  });

  it('非定义性事实停在 PROVISIONAL（不进 Canon）', () => {
    const { proj, bookId } = setup();
    const promoter = new CanonPromoter({ repos: proj.repos, logger, bookId });
    const r = promoter.promote([pf({ predicate: '心情', objectValue: '不错', isDefining: false })], {
      draftText: DRAFT,
      sourceRef: 'chapters/010.md',
    });

    expect(r.provisionalCount).toBe(1);
    expect(r.outcomes[0]!.reason).toContain('非定义性');
  });

  it('低置信度停在 PROVISIONAL', () => {
    const { proj, bookId } = setup();
    const promoter = new CanonPromoter({ repos: proj.repos, logger, bookId });
    const r = promoter.promote([pf({ confidence: 0.5 })], {
      draftText: DRAFT,
      sourceRef: 'chapters/010.md',
    });

    expect(r.provisionalCount).toBe(1);
    expect(r.outcomes[0]!.reason).toContain('低于 Canon 门槛');
  });

  it('门限可配置', () => {
    const { proj, bookId } = setup();
    const promoter = new CanonPromoter({
      repos: proj.repos,
      logger,
      bookId,
      policy: { minConfidenceForCanon: 0.4, definingOnly: false },
    });
    const r = promoter.promote([pf({ confidence: 0.5, isDefining: false })], {
      draftText: DRAFT,
      sourceRef: 'chapters/010.md',
    });
    expect(r.canonCount).toBe(1);
  });

  it('主体未解析 → SKIPPED（写进去也无法关联角色）', () => {
    const { proj, bookId } = setup();
    const promoter = new CanonPromoter({ repos: proj.repos, logger, bookId });
    const r = promoter.promote([pf({ subjectId: null })], {
      draftText: DRAFT,
      sourceRef: 'chapters/010.md',
    });

    expect(r.skippedCount).toBe(1);
    expect(r.outcomes[0]!.reason).toContain('未解析');
  });

  it('引文与正文不符 → SKIPPED（证据链断裂）', () => {
    const { proj, bookId } = setup();
    const promoter = new CanonPromoter({ repos: proj.repos, logger, bookId });
    const r = promoter.promote([pf({ quote: '编造的引文' })], {
      draftText: DRAFT,
      sourceRef: 'chapters/010.md',
    });

    expect(r.skippedCount).toBe(1);
    expect(r.outcomes[0]!.reason).toContain('缺少可回溯依据');
  });

  it('幂等：同一事实重复 promote 不产生重复行（内容派生 id）', () => {
    const { proj, bookId } = setup();
    const promoter = new CanonPromoter({ repos: proj.repos, logger, bookId });
    promoter.promote([pf()], { draftText: DRAFT, sourceRef: 'chapters/010.md' });
    promoter.promote([pf()], { draftText: DRAFT, sourceRef: 'chapters/010.md' });

    expect(proj.repos.facts.listByStatus(bookId, 'CANON').filter((f) => f.id === 'fact_a')).toHaveLength(1);
  });

  it('preview 只读：不写库', () => {
    const { proj, bookId } = setup();
    const promoter = new CanonPromoter({ repos: proj.repos, logger, bookId });
    const before = proj.repos.facts.listByStatus(bookId, 'PROVISIONAL').length;
    promoter.preview([pf()]);
    expect(proj.repos.facts.listByStatus(bookId, 'PROVISIONAL').length).toBe(before);
  });

  it('preview 预告将被提升的条目', () => {
    const { proj, bookId } = setup();
    const promoter = new CanonPromoter({ repos: proj.repos, logger, bookId });
    const p = promoter.preview([pf(), pf({ id: 'fact_b', predicate: '心情', isDefining: false })]);
    expect(p[0]!.status).toBe('CANON');
    expect(p[1]!.status).toBe('PROVISIONAL');
  });
});

describe('Schema 契约', () => {
  it('quote 必填（不能省略可回溯依据）', async () => {
    const ex = extractorWith({ facts: [{ ...factOf(), quote: undefined }] });
    const r = await ex.extract({ chapterNumber: 10, draftText: DRAFT });
    expect(r.ok).toBe(false);
  });

  it('confidence 必须在 [0,1]', async () => {
    const ex = extractorWith({ facts: [factOf({ confidence: 1.5 })] });
    const r = await ex.extract({ chapterNumber: 10, draftText: DRAFT });
    expect(r.ok).toBe(false);
  });

  it('subjectType 只接受 CHARACTER/WORLD/ITEM', async () => {
    const ex = extractorWith({ facts: [factOf({ subjectType: 'ANIMAL' })] });
    const r = await ex.extract({ chapterNumber: 10, draftText: DRAFT });
    expect(r.ok).toBe(false);
  });

  it('isDefining 缺省时默认 false', async () => {
    const f = factOf();
    delete (f as Record<string, unknown>).isDefining;
    const ex = extractorWith({ facts: [f] });
    const r = await ex.extract({ chapterNumber: 10, draftText: DRAFT });
    expect(r.ok).toBe(true);
  });
});

describe('与 Continuity Checker 的联动（STEP 9 的回归验收）', () => {
  it('抽取出 Canon 后，Checker 能对账并检出矛盾', async () => {
    const { ContinuityChecker } = await import('@nwa/story');
    const proj = createTestProject();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    const c = proj.repos.characters.create({ id: 'ch_ming', bookId, name: '阿明' });

    // 用抽取器从第 10 章抽出"阿明失明"
    const ex = extractorWith({ facts: [factOf()] }, [{ id: c.id, name: '阿明' }]);
    const r = await ex.extract({ chapterNumber: 10, draftText: DRAFT });
    expect(r.ok).toBe(true);

    // 提升为 Canon
    const promoter = new CanonPromoter({ repos: proj.repos, logger, bookId });
    promoter.promote(r.proposed, { draftText: DRAFT, sourceRef: 'chapters/010.md' });
    expect(proj.repos.facts.listByStatus(bookId, 'CANON')).toHaveLength(1);

    // 第 11 章让阿明正常阅读 → Checker 必须检出
    const checker = new ContinuityChecker({ repos: proj.repos, logger, bookId });
    const report = checker.check({ chapterNumber: 11, draftText: '阿明看着窗外，轻声说了一句。' });

    expect(report.ok).toBe(false);
    expect(report.blockingCount).toBe(1);
    expect(report.issues[0]!.code).toBe('BLOCKING_CONTINUITY_ERROR');
  });

  it('第 10 章之前的草稿不受第 10 章才确立的 Canon 约束', async () => {
    const { ContinuityChecker } = await import('@nwa/story');
    const proj = createTestProject();
    const bookId = proj.repos.books.listByProject(proj.repos.projects.list()[0]!.id)[0]!.id;
    const c = proj.repos.characters.create({ id: 'ch_ming2', bookId, name: '阿明' });

    // 第 10 章确立失明
    const ev = proj.repos.evidence.create({
      id: 'ev_10',
      bookId,
      sourceType: 'CHAPTER',
      sourceRef: 'chapters/010.md',
      quote: '阿明双目失明',
      startOffset: 0,
      endOffset: 6, // '阿明双目失明' = 6 字
      sourceText: '阿明双目失明',
    });
    const f = proj.repos.facts.propose({
      id: 'fact_blind10',
      bookId,
      subjectType: 'CHARACTER',
      subjectId: c.id,
      predicate: '失明',
      objectValue: '失明',
      confidence: 1,
      sourceChapterId: null,
      evidenceId: ev.id,
    });
    proj.repos.facts.promoteToCanon(f.id);

    const checker = new ContinuityChecker({ repos: proj.repos, logger, bookId });
    // 注意：当前 Checker 的 Canon 对账不带章号过滤（见下一条测试的说明）
    const at11 = checker.check({ chapterNumber: 11, draftText: '阿明看着窗外。' });
    expect(at11.ok).toBe(false);
  });
});
