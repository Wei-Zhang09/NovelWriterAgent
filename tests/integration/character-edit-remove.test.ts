/**
 * 角色编辑 / 删除（P2-4c）
 *
 * ## 这个缺陷长什么样
 *
 * 与设定（P2-4b）是同一类死胡同，但**更深一层**：
 *
 *   - UI 上角色只能加，没有改和删的入口；
 *   - 即使调工具也改不了名字 —— `character.update` 的 schema 只有
 *     `role`/`currentStatus`/`profile`，**没有 name / aliases**；
 *   - 仓储层连 `remove()` 都不存在。
 *
 * 而作者最常需要改的恰恰是**打错的名字**：角色名是正文里识别"谁是谁"
 * 的键，错一个字会让连续性检查认不出同一个角色 ——
 * 表现为"凭空冒出一个人"或"角色从未出场"。
 *
 * ## 测试重点
 *
 * 不是"字段写没写进去"，而是几个**判断**：
 *   1. 改名必须真的改掉，且能被 `findByName` 认出来
 *   2. 改名撞其他角色 → 必须拒绝（否则角色解析不可复现）
 *   3. 有 CANON 事实的角色不能删（否则"已发生的事"失去主体）
 *   4. 删除要清掉悬空 facts 与 character_states（软引用不会自动清）
 *   5. 改别名不能把自己判成撞名（同名不同 id 才叫撞）
 */
import { describe, expect, it, afterEach } from 'vitest';
import { createTestProject, type TestProject } from './helpers.js';

let t: TestProject | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function setup() {
  const proj = createTestProject();
  const projectId = proj.repos.projects.list()[0]!.id;
  const bookId = proj.repos.books.listByProject(projectId)[0]!.id;
  return { proj, bookId };
}

/**
 * 造一条指向角色的真实事实。
 *
 * ⚠ 两个约束都不能绕：
 *   - `propose` 的 sourceChapterId / evidenceId 是**必填**（可 null），
 *     漏传会让 node:sqlite 报"parameter 8 cannot be bound"。
 *   - `promoteToCanon` 强制要有 evidence（`facts.ts:96`），
 *     无证据的事实不得成为 CANON —— 这条在代码层强制。
 * 所以这里连证据一起造：让 quote 就是 sourceText，
 * 以满足 evidence.create 对 [start,end) 区间的校验。
 */
function makeFact(
  proj: TestProject,
  bookId: string,
  id: string,
  subjectId: string,
  opts: { canon?: boolean } = {},
) {
  const quote = '沈砚双目失明';
  proj.repos.evidence.create({
    id: `ev_${id}`,
    bookId,
    sourceType: 'CHAPTER',
    sourceRef: `chapters/${id}.md`,
    startOffset: 0,
    endOffset: quote.length,
    quote,
    sourceText: quote,
  });
  const f = proj.repos.facts.propose({
    id,
    bookId,
    subjectType: 'CHARACTER',
    subjectId,
    predicate: 'IS_BLIND',
    objectValue: 'true',
    confidence: 0.9,
    sourceChapterId: null,
    evidenceId: `ev_${id}`,
  });
  if (opts.canon) proj.repos.facts.promoteToCanon(f.id);
  return f;
}

describe('⚠ 角色改名（P2-4c）', () => {
  it('⚠ 能改掉打错的名字（此前 update 根本不接受 name）', () => {
    const { proj, bookId } = setup();
    const c = proj.repos.characters.create({ id: 'c1', bookId, name: '沈砚' });
    const after = proj.repos.characters.update(c.id, { name: '沈砚之' });
    expect(after.name).toBe('沈砚之');
    // 落库了，不只是返回值好看
    expect(proj.repos.characters.get('c1').name).toBe('沈砚之');
  });

  it('⚠ 改名后 findByName 认新名、不认旧名（这是连续性能认出角色的键）', () => {
    const { proj, bookId } = setup();
    const c = proj.repos.characters.create({ id: 'c1', bookId, name: '沈砚' });
    proj.repos.characters.update(c.id, { name: '沈砚之' });
    expect(proj.repos.characters.findByName(bookId, '沈砚之')?.id).toBe('c1');
    expect(proj.repos.characters.findByName(bookId, '沈砚')).toBeUndefined();
  });

  it('⚠ 改名撞其他角色 → 拒绝（否则解析结果取决于查询顺序，不可复现）', () => {
    const { proj, bookId } = setup();
    proj.repos.characters.create({ id: 'c1', bookId, name: '沈砚' });
    proj.repos.characters.create({ id: 'c2', bookId, name: '李四' });
    expect(() => proj.repos.characters.update('c2', { name: '沈砚' })).toThrow(/已被占用/);
    // 拒绝后不得留下半截状态
    expect(proj.repos.characters.get('c2').name).toBe('李四');
  });

  it('⚠ 撞到的是别名也算撞（findByName 会走别名）', () => {
    const { proj, bookId } = setup();
    proj.repos.characters.create({ id: 'c1', bookId, name: '沈砚', aliases: ['阿砚'] });
    proj.repos.characters.create({ id: 'c2', bookId, name: '李四' });
    expect(() => proj.repos.characters.update('c2', { name: '阿砚' })).toThrow(/已被占用/);
  });

  it('改自己的别名不算撞名（同名不同 id 才叫撞）', () => {
    const { proj, bookId } = setup();
    const c = proj.repos.characters.create({ id: 'c1', bookId, name: '沈砚' });
    // 名字没变，只是加别名 —— 不能因为"找到了自己"而拒绝
    const after = proj.repos.characters.update(c.id, { name: '沈砚', aliases: ['阿砚'] });
    expect(after.aliases_json).toContain('阿砚');
  });

  it('可以单独改别名', () => {
    const { proj, bookId } = setup();
    const c = proj.repos.characters.create({ id: 'c1', bookId, name: '沈砚', aliases: ['阿砚'] });
    proj.repos.characters.update(c.id, { aliases: ['小砚', '砚哥'] });
    expect(proj.repos.characters.findByName(bookId, '砚哥')?.id).toBe('c1');
  });

  it('未提供的字段保持不变（不是清空）', () => {
    const { proj, bookId } = setup();
    const c = proj.repos.characters.create({
      id: 'c1', bookId, name: '沈砚', role: '主角', aliases: ['阿砚'],
    });
    proj.repos.characters.update(c.id, { currentStatus: '重伤' });
    const after = proj.repos.characters.get('c1');
    expect(after.name).toBe('沈砚');
    expect(after.role).toBe('主角');
    expect(after.aliases_json).toContain('阿砚');
    expect(after.current_status).toBe('重伤');
  });
});

describe('⚠ 角色删除（P2-4c）', () => {
  it('⚠ 没有 CANON 事实的角色可以删（打错名字建错了要能清掉）', () => {
    const { proj, bookId } = setup();
    proj.repos.characters.create({ id: 'c1', bookId, name: '沈砚' });
    const r = proj.repos.characters.remove('c1');
    expect(r.removed).toBe(true);
    expect(proj.repos.characters.listByBook(bookId)).toHaveLength(0);
  });

  it('⚠ 有 CANON 事实的角色 → 拒绝删除（已发生的事不能失去主体）', () => {
    const { proj, bookId } = setup();
    proj.repos.characters.create({ id: 'c1', bookId, name: '沈砚' });
    makeFact(proj, bookId, 'f1', 'c1', { canon: true });

    expect(() => proj.repos.characters.remove('c1')).toThrow(/不能删除/);
    // 拒绝后角色与事实都必须在
    expect(proj.repos.characters.get('c1').name).toBe('沈砚');
    expect(proj.repos.facts.get('f1').status).toBe('CANON');
  });

  it('⚠ 只算 CANON：PROVISIONAL 事实不阻断删除', () => {
    const { proj, bookId } = setup();
    proj.repos.characters.create({ id: 'c1', bookId, name: '沈砚' });
    makeFact(proj, bookId, 'f1', 'c1');
    expect(proj.repos.characters.remove('c1').removed).toBe(true);
  });

  it('⚠ 删除要清掉悬空的 facts（subject_id 是软引用，不会自动清）', () => {
    const { proj, bookId } = setup();
    proj.repos.characters.create({ id: 'c1', bookId, name: '沈砚' });
    makeFact(proj, bookId, 'f1', 'c1');
    const r = proj.repos.characters.remove('c1');
    // 必须如实报告清掉了多少条，不能悄悄清
    expect(r.detachedFacts).toBe(1);
    // ⚠ 用 listBySubject 而不是 facts.get：前者是连续性检查实际走的查询路径，
    //   后者（requireRow）查不到会抛错，"抛错"不等于"确实清干净了"。
    expect(proj.repos.facts.listBySubject(bookId, 'CHARACTER', 'c1')).toHaveLength(0);
  });

  it('⚠ 别的角色的事实不受影响（只清指向被删角色的）', () => {
    const { proj, bookId } = setup();
    proj.repos.characters.create({ id: 'c1', bookId, name: '沈砚' });
    proj.repos.characters.create({ id: 'c2', bookId, name: '李四' });
    makeFact(proj, bookId, 'f_keep', 'c2');
    proj.repos.characters.remove('c1');
    expect(proj.repos.facts.get('f_keep')).toBeDefined();
  });

  it('⚠ 删除连带清掉 character_states（ON DELETE CASCADE 需 foreign_keys 生效）', () => {
    const { proj, bookId } = setup();
    proj.repos.characters.create({ id: 'c1', bookId, name: '沈砚' });
    proj.repos.characters.appendState({
      id: 's1', characterId: 'c1', chapterNumber: 1, state: { hp: 10 },
    });
    expect(proj.repos.characters.latestState('c1')).toBeDefined();
    proj.repos.characters.remove('c1');
    // 悬空状态会让后续按角色查历史时读到"已删除角色的状态"
    expect(proj.repos.characters.latestState('c1')).toBeUndefined();
  });

  it('⚠ 多书隔离：删 A 书角色不动 B 书同名角色', () => {
    const { proj, bookId } = setup();
    const projectId = proj.repos.projects.list()[0]!.id;
    const other = proj.repos.books.create({ id: 'bk2', projectId, title: '另一本' });
    proj.repos.characters.create({ id: 'c_a', bookId, name: '沈砚' });
    proj.repos.characters.create({ id: 'c_b', bookId: other.id, name: '沈砚' });
    proj.repos.characters.remove('c_a');
    expect(proj.repos.characters.listByBook(bookId)).toHaveLength(0);
    expect(proj.repos.characters.listByBook(other.id)).toHaveLength(1);
  });
});
