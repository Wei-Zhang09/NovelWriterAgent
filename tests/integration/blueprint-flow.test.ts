/**
 * 开书向导端到端：AI 生成 → 用户编辑 → 统一确认 → 才开写
 *
 * ## 为什么必须有这一层
 *
 * `blueprint-gate.test.ts` 覆盖了纯函数的判定语义，但**纯函数测试看不到
 * 接线**。本项目已经踩过这个坑两次：
 *   - `staleness.ts`（222 行、四状态、完整单测）生产调用点 = 0 ——
 *     "检测器存在"不等于"检测器生效"
 *   - `world_entities` 表建了但全仓零引用
 *
 * 所以这里**走真实 DB + 真实仓储**，断言的是：
 *   ① 四步齐全（缺的补 NOT_STARTED，界面不必处理"没有行"）
 *   ② AI 原稿与用户编辑**分别可取**（用户点重新生成不得丢失自己的修改）
 *   ③ 指纹对"同内容"稳定 —— 门禁不误判
 *   ④ **门禁对象 == 被消费对象**：确认时哈希的内容与读出来的是同一份
 *
 * ## ④ 是本次最关键的一条
 *
 * 本项目已有一条教训（见 `book_blueprint.sql` 的注释）：若把角色/设定的
 * 副本存进 `draft_json` 并参与哈希，就会出现
 * **门禁放行、prompt 读到的却是别的内容** 这种假绿。
 * 所以 SETTINGS 步的内容必须从正式表（characters / world_entities）现取。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateBlueprintGate, hashBlueprint } from '@nwa/core';
import { stableStringify, BLUEPRINT_STEP_ORDER } from '@nwa/storage';
import { createTestProject, type TestProject } from './helpers.js';

let t: TestProject;

beforeEach(() => {
  t = createTestProject({ rootDir: mkdtempSync(join(tmpdir(), 'nwa-blueprint-')) });
});

afterEach(() => {
  t.cleanup();
});

describe('① 四步齐全', () => {
  it('新书未走向导 → 四步都是 NOT_STARTED（不落库，读时补齐）', () => {
    const steps = t.repos.blueprint.stepsOf(t.bookId);
    expect(steps.map((s) => s.step)).toEqual([...BLUEPRINT_STEP_ORDER]);
    expect(steps.every((s) => s.status === 'NOT_STARTED')).toBe(true);
    // ⚠ 补的是内存行，不该写进库 —— 状态 NOT_STARTED 与"没有行"等价
    const raw = t.db.all('SELECT * FROM blueprint_steps WHERE book_id = ?', t.bookId);
    expect(raw.length).toBe(0);
  });

  it('未走向导 → 门禁放行（用户决策：向导可选，不强制）', () => {
    const snap = t.repos.blueprint.snapshot(t.bookId);
    const r = evaluateBlueprintGate({
      gateEnabled: true,
      confirmedHash: t.repos.blueprint.confirmedHash(t.bookId),
      currentHash: hashBlueprint(snap),
      steps: snap,
    });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('NOT_USED');
  });
});

describe('② AI 原稿与用户编辑分别可取', () => {
  it('生成后 → status GENERATED，有效内容 = AI 原稿', () => {
    t.repos.blueprint.saveDraft(t.bookId, 'CONCEPT', { direction: '都市青春', tags: ['校园'] });
    const row = t.repos.blueprint.findStep(t.bookId, 'CONCEPT');
    expect(row.status).toBe('GENERATED');
    expect(t.repos.blueprint.effectiveContent(row)).toEqual({
      direction: '都市青春',
      tags: ['校园'],
    });
  });

  it('用户编辑后 → 有效内容 = 用户的版本，但 AI 原稿仍可读回', () => {
    t.repos.blueprint.saveDraft(t.bookId, 'CONCEPT', { direction: '都市青春' });
    t.repos.blueprint.saveEdited(t.bookId, 'CONCEPT', { direction: '都市青春+异能' });

    const row = t.repos.blueprint.findStep(t.bookId, 'CONCEPT');
    expect(row.status).toBe('EDITED');
    // 生效的是用户改过的
    expect(t.repos.blueprint.effectiveContent(row)).toEqual({ direction: '都市青春+异能' });
    // ⚠ AI 原稿**必须还在** —— 用户要求"选择、修改"，
    //   得能对照原稿；只存一份的话点"重新生成"就永久丢失用户的修改
    expect(row.draft_json).not.toBeNull();
    expect(JSON.parse(row.draft_json!)).toEqual({ direction: '都市青春' });
  });

  it('⚠ 重新生成不丢用户编辑（edited_json 保留）', () => {
    t.repos.blueprint.saveDraft(t.bookId, 'CONCEPT', { v: 1 });
    t.repos.blueprint.saveEdited(t.bookId, 'CONCEPT', { v: '用户改的' });
    // 用户点「重新生成」
    t.repos.blueprint.saveDraft(t.bookId, 'CONCEPT', { v: 2 });

    const row = t.repos.blueprint.findStep(t.bookId, 'CONCEPT');
    expect(row.status).toBe('GENERATED'); // 生效的是新草案
    expect(JSON.parse(row.draft_json!)).toEqual({ v: 2 });
    // ⚠ 用户的编辑仍在库里 —— 可以恢复，不是被静默丢弃
    expect(JSON.parse(row.edited_json!)).toEqual({ v: '用户改的' });
  });
});

describe('③ 指纹对同内容稳定（门禁不误判）', () => {
  it('⚠ 存 → 读 → 再存，内容不变则指纹不变', () => {
    t.repos.blueprint.saveEdited(t.bookId, 'OUTLINE', { volumes: [{ name: '第一卷', chapters: 10 }] });
    const h1 = hashBlueprint(t.repos.blueprint.snapshot(t.bookId));

    // 什么都不改，只重新读一遍
    const h2 = hashBlueprint(t.repos.blueprint.snapshot(t.bookId));
    expect(h2).toBe(h1);

    // ⚠ 若这里不等，说明"读出来"经过了不稳定变换 ——
    //   门禁会在用户什么都没做的情况下报"内容被改过"
  });

  it('⚠ 对象键序不同但语义相同 → stableStringify 后指纹一致', () => {
    // 这是"重新生成一次，模型键序变了"的真实场景。
    // 若不做键排序，门禁会误报"内容被改过"。
    const a = stableStringify({ a: 1, b: { c: 3, d: 4 } });
    const b = stableStringify({ b: { d: 4, c: 3 }, a: 1 });
    expect(a).toBe(b);
  });
});

describe('④ 门禁对象 == 被消费对象', () => {
  it('⚠ 统一确认后，内容不变 → 门禁放行', () => {
    t.repos.blueprint.saveEdited(t.bookId, 'CONCEPT', { direction: '都市' });
    t.repos.blueprint.saveEdited(t.bookId, 'OUTLINE', { volumes: 3 });

    const r = t.repos.blueprint.confirmAll(t.bookId);
    expect(r.steps).toBe(4);

    const snap = t.repos.blueprint.snapshot(t.bookId);
    const gate = evaluateBlueprintGate({
      gateEnabled: true,
      confirmedHash: t.repos.blueprint.confirmedHash(t.bookId),
      currentHash: hashBlueprint(snap),
      steps: snap,
    });
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBe('CONFIRMED');
  });

  it('⚠ 统一确认后又改内容 → 门禁拦（且 reason 是 CHANGED_SINCE_CONFIRM）', () => {
    t.repos.blueprint.saveEdited(t.bookId, 'OUTLINE', { volumes: 3 });
    t.repos.blueprint.confirmAll(t.bookId);

    // 作者改了卷纲
    t.repos.blueprint.saveEdited(t.bookId, 'OUTLINE', { volumes: 5 });

    const snap = t.repos.blueprint.snapshot(t.bookId);
    const gate = evaluateBlueprintGate({
      gateEnabled: true,
      confirmedHash: t.repos.blueprint.confirmedHash(t.bookId),
      currentHash: hashBlueprint(snap),
      steps: snap,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('CHANGED_SINCE_CONFIRM');
  });

  it('⚠⚠ SETTINGS 步的内容取自**正式表**，不是 draft_json 的副本', () => {
    // 这条防的是本项目已有的教训：哈希的对象不是被消费的对象。
    //
    // 场景：AI 提议了 2 个角色写进 draft_json，用户确认时物化进了
    // characters 表。之后用户**直接改了 characters 表**（界面上的角色编辑），
    // 但没有走 blueprint 的 saveEdited。若指纹算的是 draft_json，
    // 门禁会认为"没变"而放行 —— 而 prompt 读到的是改过的角色。
    t.repos.blueprint.saveDraft(t.bookId, 'SETTINGS', { proposed: ['沈砚', '林晚'] });

    // 物化进正式表（模拟工具层做的事）
    t.repos.characters.create({
      id: 'char_1',
      bookId: t.bookId,
      name: '沈砚',
      role: '主角',
      profile: '左手有旧伤',
    });
    const settingsContent = () =>
      t.repos.characters
        .listByBook(t.bookId)
        .map((c) => `${c.name}|${c.profile_json ?? ''}`)
        .join('\n');

    // 统一确认时，SETTINGS 的内容由调用方从正式表现取后传入
    t.repos.blueprint.confirmAll(t.bookId, { SETTINGS: settingsContent() });

    // 作者改了正式表里的角色（不走 blueprint）
    t.repos.characters.update('char_1', { profile: '左手有旧伤，右手有疤' });

    const snap = t.repos.blueprint.snapshot(t.bookId, { SETTINGS: settingsContent() });
    const gate = evaluateBlueprintGate({
      gateEnabled: true,
      confirmedHash: t.repos.blueprint.confirmedHash(t.bookId),
      currentHash: hashBlueprint(snap),
      steps: snap,
    });
    expect(
      gate.allowed,
      '改了正式表里的角色却没被拦 —— 说明指纹算的是 draft 副本，不是被消费的内容',
    ).toBe(false);
    expect(gate.reason).toBe('CHANGED_SINCE_CONFIRM');
  });
});
