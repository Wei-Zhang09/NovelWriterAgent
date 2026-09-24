/**
 * 世界观设定仓储 + 门禁端到端（P2-3）
 *
 * ⚠ 这一组测试的重点不是"CRUD 能跑"，而是**门禁的判定在真实数据上成立**：
 *   写一条设定 → 未确认 → 判定为拦；确认 → 判定为放行；
 *   再改设定 → 判定又变回拦。
 *
 *   如果只测纯函数的判定表（settings-gate.test.ts），会漏掉
 *   「确认时存的指纹与校验时算的指纹不是同一套算法」这类缺陷 ——
 *   那会让门禁永远拦着自己，而纯函数测试完全看不出来。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateSettingsGate, hashSettings } from '@nwa/core';
import { Database, createRepositories, confirmBookSettings, MIGRATIONS } from '@nwa/storage';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'nwa-settings-'));
  const db = new Database({ path: join(dir, 'p.db'), migrations: MIGRATIONS });
  const repos = createRepositories(db);
  const project = repos.projects.create({ id: 'prj1', name: '测试项目' });
  const book = repos.books.create({ id: 'bk1', projectId: project.id, title: '书一' });
  return { dir, db, repos, book };
}

/** 走与 IPC `settings.status` 完全相同的判定路径 */
function judge(repos: ReturnType<typeof setup>['repos'], bookId: string) {
  const book = repos.books.get(bookId);
  const entries = repos.world.snapshot(bookId);
  return evaluateSettingsGate({
    gateEnabled: book.settings_gate_enabled === 1,
    confirmedHash: book.settings_confirmed_hash,
    currentHash: hashSettings(entries),
    entryCount: entries.length,
  });
}

describe('世界观设定仓储', () => {
  it('新建的设定是 DRAFT（草稿），不是 CONFIRMED', () => {
    const { repos, book } = setup();
    const row = repos.world.create({
      id: 'w1',
      bookId: book.id,
      type: 'WORLD_RULE',
      name: '灵力枯竭',
      description: '施法消耗寿命',
    });
    expect(row.status).toBe('DRAFT');
  });

  it('ord 按添加顺序递增（顺序有意义）', () => {
    const { repos, book } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'LOCATION', name: '甲' });
    repos.world.create({ id: 'w2', bookId: book.id, type: 'LOCATION', name: '乙' });
    const list = repos.world.listByBook(book.id);
    expect(list.map((r) => r.name)).toEqual(['甲', '乙']);
    expect(list[0]!.ord).toBeLessThan(list[1]!.ord);
  });

  it('⚠ 多书隔离：A 书的设定不出现在 B 书', () => {
    const { repos, book } = setup();
    const b2 = repos.books.create({ id: 'bk2', projectId: 'prj1', title: '书二' });
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '甲书设定' });
    repos.world.create({ id: 'w2', bookId: b2.id, type: 'WORLD_RULE', name: '乙书设定' });
    expect(repos.world.listByBook(book.id).map((r) => r.name)).toEqual(['甲书设定']);
    expect(repos.world.listByBook(b2.id).map((r) => r.name)).toEqual(['乙书设定']);
  });

  it('更新内容', () => {
    const { repos, book } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '甲' });
    const row = repos.world.update('w1', { description: '新描述' });
    expect(row.description).toBe('新描述');
  });

  it('⚠ 更新不重置 status（状态回落靠指纹，不靠写入口守规矩）', () => {
    // 若 update 顺手把 status 改回 DRAFT，就变成"靠调用方守规矩"——
    // 新增一个写入口就漏。回落必须由指纹在读时判定。
    const { repos, book } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '甲' });
    repos.world.confirmAll(book.id);
    expect(repos.world.get('w1').status).toBe('CONFIRMED');
    repos.world.update('w1', { description: '改了' });
    expect(repos.world.get('w1').status).toBe('CONFIRMED');
  });

  it('没有要更新的字段 → 抛错', () => {
    const { repos, book } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '甲' });
    expect(() => repos.world.update('w1', {})).toThrow();
  });

  it('删除', () => {
    const { repos, book } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '甲' });
    repos.world.remove('w1');
    expect(repos.world.listByBook(book.id)).toHaveLength(0);
  });

  it('confirmAll 把全部设为 CONFIRMED 并返回条数', () => {
    const { repos, book } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '甲' });
    repos.world.create({ id: 'w2', bookId: book.id, type: 'LOCATION', name: '乙' });
    expect(repos.world.confirmAll(book.id)).toBe(2);
    expect(repos.world.listByBook(book.id).every((r) => r.status === 'CONFIRMED')).toBe(true);
  });

  it('data_json 坏掉时抛错而不是静默返回 null（不把损坏伪装成空）', () => {
    const { repos, db, book } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '甲' });
    db.run("UPDATE world_entities SET data_json = '{broken' WHERE id = 'w1'");
    expect(() => repos.world.dataOf(repos.world.get('w1'))).toThrow();
  });
});

describe('⚠ 门禁在真实数据上的完整生命周期', () => {
  it('无设定 → 放行（允许"直接生成再改"的流程）', () => {
    const { repos, book } = setup();
    const v = judge(repos, book.id);
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('NO_SETTINGS');
  });

  it('⚠ 写一条设定 → 未确认 → 拦', () => {
    const { repos, book } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '灵力枯竭' });
    const v = judge(repos, book.id);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('NEVER_CONFIRMED');
  });

  it('⚠ 确认 → 放行（这一条钉住"确认动作不会让指纹自相矛盾"）', () => {
    const { repos, book } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '灵力枯竭' });
    // 与 IPC `settings.confirm` 完全相同的两步
    confirmBookSettings(repos, book.id);
    const v = judge(repos, book.id);
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('CONFIRMED');
  });

  it('⚠ 确认后改设定 → 又变回拦（门禁才有意义）', () => {
    const { repos, book } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '灵力枯竭' });
    confirmBookSettings(repos, book.id);
    expect(judge(repos, book.id).allowed).toBe(true);

    repos.world.update('w1', { description: '改成：施法不消耗寿命' });
    const v = judge(repos, book.id);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('CHANGED_SINCE_CONFIRM');
  });

  it('确认后**新增**设定 → 也变回拦', () => {
    const { repos, book } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '甲' });
    confirmBookSettings(repos, book.id);
    repos.world.create({ id: 'w2', bookId: book.id, type: 'LOCATION', name: '乙' });
    expect(judge(repos, book.id).reason).toBe('CHANGED_SINCE_CONFIRM');
  });

  it('确认后**删除**设定 → 也变回拦', () => {
    const { repos, book } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '甲' });
    repos.world.create({ id: 'w2', bookId: book.id, type: 'LOCATION', name: '乙' });
    confirmBookSettings(repos, book.id);
    repos.world.remove('w2');
    expect(judge(repos, book.id).reason).toBe('CHANGED_SINCE_CONFIRM');
  });

  it('改回原内容 → 重新放行（指纹按内容，不是按"改过没有"）', () => {
    const { repos, book } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '甲', description: '原文' });
    confirmBookSettings(repos, book.id);
    repos.world.update('w1', { description: '改了一下' });
    expect(judge(repos, book.id).allowed).toBe(false);
    repos.world.update('w1', { description: '原文' });
    expect(judge(repos, book.id).allowed).toBe(true);
  });

  it('⚠ 门禁开关可关闭（老项目升级后不能突然写不动）', () => {
    const { repos, book } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '甲' });
    expect(judge(repos, book.id).allowed).toBe(false);
    repos.books.setSettingsGate(book.id, false);
    expect(judge(repos, book.id).allowed).toBe(true);
    expect(judge(repos, book.id).reason).toBe('GATE_DISABLED');
  });

  it('撤回确认 → 回到 NEVER_CONFIRMED', () => {
    const { repos, book } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '甲' });
    confirmBookSettings(repos, book.id);
    expect(judge(repos, book.id).allowed).toBe(true);
    repos.books.revokeSettingsConfirmation(book.id);
    expect(judge(repos, book.id).reason).toBe('NEVER_CONFIRMED');
  });

  it('⚠ 多书隔离：确认 A 书不影响 B 书', () => {
    const { repos, book } = setup();
    const b2 = repos.books.create({ id: 'bk2', projectId: 'prj1', title: '书二' });
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '甲书设定' });
    repos.world.create({ id: 'w2', bookId: b2.id, type: 'WORLD_RULE', name: '乙书设定' });
    confirmBookSettings(repos, book.id);
    expect(judge(repos, book.id).allowed).toBe(true);
    // B 书仍有未确认设定 → 必须拦
    expect(judge(repos, b2.id).allowed).toBe(false);
  });

  it('新书的门禁默认开启', () => {
    const { repos, book } = setup();
    expect(repos.books.get(book.id).settings_gate_enabled).toBe(1);
    expect(repos.books.get(book.id).settings_confirmed_hash).toBeNull();
  });
});
