/**
 * 开书向导统一确认门禁（W6）
 *
 * ## 用户诉求
 * > 「最后确认一切前置信息后，再开始写作」
 *
 * ## 这个测试真正在防什么
 *
 * W1 建好了判定函数 `evaluateBlueprintGate`，但**零生产调用点** ——
 * 也就是说门禁写完了，却没人执行它。这正是规则 30 的形状：
 * "一个你从未接线的检测器不存在"。
 *
 * 更隐蔽的是第三种形状：**字段人人写、无人读**。
 * `book_blueprints.confirmed_hash` 有完整的写入路径，
 * 所以"谁填的"每次搜索都成功；但没人拿它做判定。
 *
 * 所以本文件的重点**不是**判定函数本身（`blueprint-gate.test.ts` 已覆盖），
 * 而是**判定是否被执行**：
 *   ① 前置未确认 → plan 被拒
 *   ② 前置未确认 → write 被拒
 *   ③ 前置未确认 → 工具路径的 chapter.plan 也被拒（它绕过服务层）
 *   ④ 确认之后 → 放行
 *   ⑤ 确认后又改前置 → 再次被拒（指纹机制真的生效）
 *   ⑥ 没用过向导 → 放行（用户决策：向导可选）
 *
 * ⚠ 第 ⑤ 条是**指纹机制唯一的实证**：只测"确认后放行"的话，
 *   把 currentHash 写死成 confirmedHash 也能通过 —— 门禁变成
 *   永远放行的摆设，而所有测试照样绿。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories, blueprintStateOf, confirmBookBlueprint, evaluateBookBlueprintGate } from '@nwa/storage';
import { BLUEPRINT_STEPS, evaluateSettingsGate, hashSettings } from '@nwa/core';
import { createTestProject, type TestProject } from './helpers.js';

let t: TestProject;

beforeEach(() => {
  t = createTestProject({ rootDir: mkdtempSync(join(tmpdir(), 'nwa-bpgate-')) });
});
afterEach(() => {
  t.cleanup();
});

/** 走一遍"用向导"：某一步生成内容 */
function generateStep(step: string, content: unknown = { text: '草案' }): void {
  t.repos.blueprint.saveDraft(t.bookId, step as never, content);
}

// ════════════════════════════════════════════════════════════
describe('①⚠⚠ 门禁必须真的被执行（判定函数存在不等于被调用）', () => {
  it('⚠⚠ 门禁函数必须被生产代码调用 —— 否则它只是个摆设', () => {
    const ws = readFileSync(
      join(process.cwd(), 'apps/desktop/src/main/workflow-services.ts'),
      'utf8',
    );
    // ① plan 与 write 两处都要拦（只拦一处 → "先规划再绕开"仍能写）
    // ⚠ 只数**调用**：定义是 `function assertBlueprintGate(deps, bookId)`，
    //   用 /assertBlueprintGate\(deps/g 会把定义也算进去（实测数出 3 而非 2）。
    const calls = ws.match(/^\s+assertBlueprintGate\(deps/gm) ?? [];
    expect(
      calls.length,
      '门禁必须在 plan 与 write 两处都调用 —— 只拦一处时"先规划再绕开"仍能写出与前置不符的正文',
    ).toBe(2);

    // ② 判定必须走唯一实现（不在 app 层重算）
    expect(ws).toContain('evaluateBookBlueprintGate(deps.repos, bookId)');

    // ③ 工具路径也必须拦（它直接写库，绕过服务层）
    const pt = readFileSync(
      join(process.cwd(), 'packages/harness/src/tools/plan-tools.ts'),
      'utf8',
    );
    expect(
      pt.includes('opts.assertGateOpen') && pt.includes('assertGateOpen(chapter.book_id)'),
      'chapter.plan 直接写库，绕过服务层门禁 —— 必须在这里也拦',
    ).toBe(true);

    // ④ app 层必须把门禁注入进工具注册（否则 ③ 的钩子是空的）
    const cp = readFileSync(join(process.cwd(), 'apps/desktop/src/main/core-process.ts'), 'utf8');
    const injected = cp.match(/planGate: \{ assertGateOpen/g) ?? [];
    expect(
      injected.length,
      '两个 createAllTools 调用点都要注入 —— 少一个就有路径绕过门禁',
    ).toBe(2);
  });

  it('⚠⚠ IPC 入口必须存在（W1–W5 建了数据层但作者够不着）', () => {
    const cp = readFileSync(join(process.cwd(), 'apps/desktop/src/main/core-process.ts'), 'utf8');
    for (const h of [
      "'blueprint.status'",
      "'blueprint.confirmAll'",
      "'blueprint.revokeConfirm'",
      "'blueprint.setGate'",
    ]) {
      expect(cp.includes(h), `缺少 IPC ${h} —— 界面无法触发统一确认`).toBe(true);
    }
    // ⚠ 确认必须走唯一实现，不在 IPC 里重写序列
    expect(cp).toContain('confirmBookBlueprint(p.repos, params.bookId)');
  });
});

// ════════════════════════════════════════════════════════════
describe('② 端到端：真实 DB 上走一遍门禁的四种情形', () => {
  it('⚠⚠ 用了向导但从未统一确认 → 拦（NEVER_CONFIRMED）', () => {
    generateStep('CONCEPT');
    const v = evaluateBookBlueprintGate(t.repos, t.bookId);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('NEVER_CONFIRMED');
    expect(v.message).toContain('统一确认');
    // 报错要能说清"还差哪几步"，否则作者不知道该去点什么
    expect(v.unfinished.length).toBeGreaterThan(0);
  });

  it('⚠⚠ 统一确认后 → 放行（CONFIRMED）', () => {
    generateStep('CONCEPT');
    confirmBookBlueprint(t.repos, t.bookId);
    const v = evaluateBookBlueprintGate(t.repos, t.bookId);
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('CONFIRMED');
  });

  it('⚠⚠⚠ 确认后又改前置 → 再次拦（CHANGED_SINCE_CONFIRM）', () => {
    generateStep('CONCEPT', { text: '第一版' });
    confirmBookBlueprint(t.repos, t.bookId);
    expect(evaluateBookBlueprintGate(t.repos, t.bookId).allowed).toBe(true);

    // 改内容 —— 此时"已确认"不再代表当前前置
    t.repos.blueprint.saveEdited(t.bookId, 'CONCEPT' as never, { text: '改过的第二版' });
    const v = evaluateBookBlueprintGate(t.repos, t.bookId);
    expect(v.allowed, '确认之后又改了前置，必须重新拦').toBe(false);
    expect(v.reason).toBe('CHANGED_SINCE_CONFIRM');
  });

  it('⚠⚠ 从未用过向导（四步全未开始）→ 放行（用户决策：向导可选）', () => {
    const v = evaluateBookBlueprintGate(t.repos, t.bookId);
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('NOT_USED');
  });

  it('门禁关闭 → 放行（作者明确不想用）', () => {
    generateStep('CONCEPT');
    t.repos.books.setBlueprintGate(t.bookId, false);
    const v = evaluateBookBlueprintGate(t.repos, t.bookId);
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('GATE_DISABLED');
  });

  it('⚠ 撤销确认 → 回到拦（作者主动重走一遍）', () => {
    generateStep('CONCEPT');
    confirmBookBlueprint(t.repos, t.bookId);
    expect(evaluateBookBlueprintGate(t.repos, t.bookId).allowed).toBe(true);
    t.repos.blueprint.revokeConfirm(t.bookId);
    expect(evaluateBookBlueprintGate(t.repos, t.bookId).allowed).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
describe('③⚠⚠ 确认动作本身不得改变指纹（否则门禁永远拦自己）', () => {
  it('⚠⚠ 确认前后 currentHash 必须一致', () => {
    generateStep('CONCEPT', { text: '内容' });
    const before = blueprintStateOf(t.repos, t.bookId).currentHash;
    confirmBookBlueprint(t.repos, t.bookId);
    const after = blueprintStateOf(t.repos, t.bookId).currentHash;
    expect(after, '确认动作改了指纹 → 刚确认完就报"内容被改过"，门禁永远拦自己').toBe(before);
  });

  it('⚠ 重新保存同一内容（status 变化）不得改指纹', () => {
    generateStep('CONCEPT', { text: '同一内容' });
    const h1 = blueprintStateOf(t.repos, t.bookId).currentHash;
    // 走一次"编辑"但内容相同 —— status 从 GENERATED 变 EDITED
    t.repos.blueprint.saveEdited(t.bookId, 'CONCEPT' as never, { text: '同一内容' });
    const h2 = blueprintStateOf(t.repos, t.bookId).currentHash;
    expect(h2, 'status 参与指纹会让"状态变了但内容没变"误判成被改过').toBe(h1);
  });

  it('⚠ 四步齐全（stepsOf 保证），且顺序固定', () => {
    const st = blueprintStateOf(t.repos, t.bookId);
    expect(st.steps.length).toBe(4);
    expect(st.steps.map((x) => x.step)).toEqual([...BLUEPRINT_STEPS]);
  });
});

// ════════════════════════════════════════════════════════════
describe('④⚠⚠ SETTINGS 步的指纹必须来自正式表（不是副本）', () => {
  it('⚠⚠⚠ 直接改 characters 表 → 门禁必须报"被改过"', () => {
    generateStep('CONCEPT');
    confirmBookBlueprint(t.repos, t.bookId);
    expect(evaluateBookBlueprintGate(t.repos, t.bookId).allowed).toBe(true);

    // ⚠ 关键：**直接改正式表**，不碰 blueprint_steps。
    //   若指纹用的是 draft_json 里的副本，这里查不出来 ——
    //   而角色表才是 prompt 真正读的东西（renderCharacterBlock）。
    t.repos.characters.create({
      id: 'char_test_w6',
      bookId: t.bookId,
      name: '沈砚',
      role: '主角',
      profile: { background: '退役拳手' },
    });

    const v = evaluateBookBlueprintGate(t.repos, t.bookId);
    expect(
      v.allowed,
      '改角色表没被检出 → 门禁哈希的是副本，而 prompt 读的是正式表',
    ).toBe(false);
    expect(v.reason).toBe('CHANGED_SINCE_CONFIRM');
  });

  it('⚠ 直接改 world_entities → 门禁必须报"被改过"', () => {
    generateStep('CONCEPT');
    confirmBookBlueprint(t.repos, t.bookId);
    t.repos.world.create({
      id: 'world_test_w6',
      bookId: t.bookId,
      type: 'RULE',
      name: '拳台规矩',
      description: '认输即止',
    });
    const v = evaluateBookBlueprintGate(t.repos, t.bookId);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('CHANGED_SINCE_CONFIRM');
  });

  it('⚠ 重新确认后放行（改完再确认是正常流程）', () => {
    generateStep('CONCEPT');
    confirmBookBlueprint(t.repos, t.bookId);
    t.repos.characters.create({
      id: 'char_test_w6b',
      bookId: t.bookId,
      name: '小满',
      role: '徒弟',
    });
    expect(evaluateBookBlueprintGate(t.repos, t.bookId).allowed).toBe(false);
    confirmBookBlueprint(t.repos, t.bookId);
    expect(evaluateBookBlueprintGate(t.repos, t.bookId).allowed).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
describe('⑤⚠ 门禁开关与设定门禁分开（合成一个会"关一个关两个"）', () => {
  it('⚠⚠ 关掉向导门禁不影响设定门禁', () => {
    generateStep('CONCEPT');
    t.repos.books.setBlueprintGate(t.bookId, false);

    const book = t.repos.books.get(t.bookId);
    expect(book.blueprint_gate_enabled, '向导门禁已关').toBe(0);
    expect(book.settings_gate_enabled, '设定门禁不该被连带关掉').toBe(1);

    // 设定门禁仍按自己的规则判定
    const entries = t.repos.world.snapshot(t.bookId);
    const sv = evaluateSettingsGate({
      gateEnabled: book.settings_gate_enabled === 1,
      confirmedHash: book.settings_confirmed_hash,
      currentHash: hashSettings(entries),
      entryCount: entries.length,
    });
    expect(sv.reason).not.toBe('GATE_DISABLED');
  });

  it('⚠ 迁移默认启用（没走过的书也受保护，但 NOT_USED 仍放行）', () => {
    const book = t.repos.books.get(t.bookId);
    expect(book.blueprint_gate_enabled).toBe(1);
    // 但没用过向导 → 照样放行
    expect(evaluateBookBlueprintGate(t.repos, t.bookId).allowed).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
describe('⑥⚠⚠ 多书隔离：门禁不能串书', () => {
  it('⚠⚠ A 书确认过，B 书未确认 → B 书仍被拦', () => {
    const bookB = t.repos.books.create({
      id: 'book_test_b',
      projectId: t.repos.projects.list()[0]!.id,
      title: 'B 书',
    });
    // A 书走完
    generateStep('CONCEPT');
    confirmBookBlueprint(t.repos, t.bookId);
    // B 书用了向导但没确认
    t.repos.blueprint.saveDraft(bookB.id, 'CONCEPT' as never, { text: 'B 的草案' });

    expect(evaluateBookBlueprintGate(t.repos, t.bookId).allowed, 'A 书应放行').toBe(true);
    const vb = evaluateBookBlueprintGate(t.repos, bookB.id);
    expect(vb.allowed, 'B 书不该被 A 书的确认放行 —— 这就是跨书污染').toBe(false);
    expect(vb.reason).toBe('NEVER_CONFIRMED');
  });

  it('⚠⚠ B 书的指纹不受 A 书影响', () => {
    const bookB = t.repos.books.create({
      id: 'book_test_b2',
      projectId: t.repos.projects.list()[0]!.id,
      title: 'B2',
    });
    const hA1 = blueprintStateOf(t.repos, t.bookId).currentHash;
    const hB1 = blueprintStateOf(t.repos, bookB.id).currentHash;
    expect(hA1).toBe(hB1); // 两本都空，指纹相同是正常的

    t.repos.blueprint.saveDraft(bookB.id, 'CONCEPT' as never, { text: 'B2 的内容' });
    const hA2 = blueprintStateOf(t.repos, t.bookId).currentHash;
    expect(hA2, 'A 书指纹不该因 B 书改动而变化').toBe(hA1);
  });
});

// ════════════════════════════════════════════════════════════
describe('⑦⚠ 仓储层：createRepositories 必须挂上 blueprint/volumes/chapterOutlines', () => {
  it('三个 W1/W4/W5 的仓储都可用', () => {
    expect(typeof t.repos.blueprint.snapshot).toBe('function');
    expect(typeof t.repos.volumes.replaceAll).toBe('function');
    expect(typeof t.repos.chapterOutlines.upsertBatch).toBe('function');
  });

  it('createRepositories 独立可建（测试直接用它，不经过 app 层）', () => {
    // 这条断言防的是"仓储只在 app 里能建" —— 那测试就只能重写一遍装配
    expect(typeof createRepositories).toBe('function');
  });
});
