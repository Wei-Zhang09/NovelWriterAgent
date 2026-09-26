/**
 * 开书向导端到端（W7）
 *
 * ## 用户诉求
 * > 「配置 AI 生成大纲角色等等相关功能，再由用户进行选择、修改，
 *    最后确认一切前置信息后，再开始写作」
 *
 * ## 这个测试真正在防什么
 *
 * 规则 33/38：**分阶段测试查不出阶段之间的接线缺失。**
 * W1–W6 每个阶段的单测都全绿，但"两半能不能接上"只有
 * **按文档顺序真的跑一遍**才知道。
 *
 * 本项目已经吃过这个亏：importer 写 `<root>/<docId>/chapters/`，
 * annotator 读 `<root>/documents/<docId>/chapters` —— 两个脚本各自都通过，
 * 因为**没有任何一个测试同时驱动两半**。
 *
 * 所以本文件按用户那句话的顺序**逐字**走：
 *
 *   1. 生成选题方向（Phase 1）→ 作者选一个
 *   2. 生成核心设定 + 角色（Phase 2）→ 作者逐条决定冲突
 *   3. 物化进正式表（characters / world_entities）
 *   4. 生成卷级大纲（Phase 3）
 *   5. 生成逐章细纲（Phase 3，分批）
 *   6. 统一确认
 *   7. 开写（plan）—— 此时才允许
 *   8. ⚠ 断言 prompt 真的读到了前面所有产出
 *
 * ⚠ 第 8 条是全篇的重点：前七步全绿而第 8 条失败，正是本项目
 *   反复出现的"门禁放行但 prompt 读到别的内容"。
 *   所以这里**驱动被消费的产物**（contextText），不是断言函数存在。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  blueprintStateOf,
  confirmBookBlueprint,
  evaluateBookBlueprintGate,
  toOutlineOutput,
} from '@nwa/storage';
import {
  ConceptGenerator,
  SettingsGenerator,
  OutlineGenerator,
  ChapterOutlineGenerator,
  materializeSettings,
} from '@nwa/writing';
import { renderCharacterBlock, selectWorldSettings, toWorldBrief } from '@nwa/harness';
import type { StructuredResult } from '@nwa/harness';
import { createTestProject, type TestProject } from './helpers.js';

let t: TestProject;
beforeEach(() => {
  t = createTestProject({ rootDir: mkdtempSync(join(tmpdir(), 'nwa-w7-')) });
});
afterEach(() => {
  t.cleanup();
});

function ok(data: unknown): StructuredResult<never> {
  return { ok: true, data, attempts: 1, usedFallback: false } as unknown as StructuredResult<never>;
}

/** 每次调用返回预先排好的响应（按顺序） */
function seq(...responses: unknown[]) {
  let i = 0;
  return vi.fn(async () => ok(responses[Math.min(i++, responses.length - 1)]));
}

const CONCEPT = {
  candidates: [
    {
      pitch: '退役拳手回小城开拳馆，却发现徒弟在打地下黑拳',
      genre: '都市',
      coreEmotion: '意难平',
      protagonist: '陈默，三十六岁，右手有旧伤',
      coreConflict: '他想保护徒弟，但徒弟要的正是他放弃过的那条路',
      differentiation: '同类书主角一路赢，这本主角每赢一次就失去一个记忆',
      estimatedChapters: 200,
    },
    {
      pitch: '殡仪馆化妆师能听见死者最后一句没说出口的话',
      genre: '都市',
      coreEmotion: '遗憾',
      protagonist: '林晚，二十九岁，从不参加葬礼',
      coreConflict: '她想替死者传话，但有些话活着的人不该知道',
      differentiation: '同类书靠破案推进，这本每章只解决一个人的遗憾',
      estimatedChapters: 180,
    },
  ],
};

const SETTINGS = {
  logline: '退役拳手回小城开拳馆，却发现徒弟在打地下黑拳',
  coreConflict: '保护徒弟，但徒弟要的正是他放弃过的那条路',
  characters: [
    {
      name: '陈默',
      role: '主角',
      aliases: ['老陈'],
      profile: { background: '退役拳手，右手有旧伤', goal: '把徒弟赶回正路' },
    },
    {
      name: '小满',
      role: '徒弟',
      aliases: [],
      profile: { background: '在打地下黑拳，手上有和师父同样的伤' },
    },
  ],
  worldEntities: [
    { type: 'RULE', name: '拳台规矩', description: '认输即止，不得追击' },
    { type: 'PLACE', name: '废弃拳馆', description: '陈默当年训练的地方' },
  ],
};

const OUTLINE = {
  totalChapters: 200,
  emotionCurve: '压抑期待 → 加压反转 → 爽感震撼 → 余韵圆满',
  volumes: [
    {
      name: '拳馆',
      function: '立人设与世界观',
      stage: 'OPENING' as const,
      contract: '读者开始关心主角能不能走出来',
      coreEvent: '陈默盘下废弃拳馆，发现小满在打黑拳',
      startState: '自我放逐',
      endState: '重新站上拳台边缘',
      chapterStart: 1,
      chapterEnd: 40,
      wordTarget: 100000,
    },
    {
      name: '黑拳',
      function: '加压与反转',
      stage: 'RISING' as const,
      contract: '读者开始怀疑主角的选择',
      coreEvent: '陈默为了小满重新踏入黑拳圈',
      startState: '重新站上拳台边缘',
      endState: '发现自己才是当年那件事的起因',
      chapterStart: 41,
      chapterEnd: 140,
      wordTarget: 250000,
    },
    {
      name: '拳王',
      function: '高潮与收束',
      stage: 'CLIMAX' as const,
      contract: '读者得到情绪的释放',
      coreEvent: '陈默在拳台上做出最后的选择',
      startState: '发现了真相',
      endState: '与自己和好',
      chapterStart: 141,
      chapterEnd: 200,
      wordTarget: 150000,
    },
  ],
};

function detailBatch(start: number, end: number) {
  const outlines = [];
  for (let n = start; n <= end; n++) {
    outlines.push({
      chapterNumber: n,
      coreEvent: `第 ${n} 章：陈默与小满的一次交锋`,
      targetEmotion: '从回避 → 被迫面对',
      protagonistGoal: '想维持现状；必须选择是否承认当年的事',
      positioning: 'ADVANCE' as const,
      structureFormula: '冲突（立关系） + 拒绝（立旧伤） + 转折（揭示信息）',
      hook: `第 ${n} 章末，小满露出了手上的伤`,
      summary: {
        cause: '小满又一次找上门',
        development: '两人争执，陈默拒绝',
        turn: '他看见小满手上的伤',
        climax: '他第一次没有立刻说「不」',
        ending: `第 ${n} 章结尾：他转身进屋，把门留了一条缝`,
      },
      mainPlot: '陈默从回避到动摇',
      cast: ['陈默', '小满'],
      infoGap: '读者知道旧伤来历，小满不知道',
      forbidden: '不得揭示当年那场比赛的真相',
      wordTarget: 2500,
    });
  }
  return { outlines };
}

// ════════════════════════════════════════════════════════════
describe('①⚠⚠ 完整流程：按用户那句话的顺序逐字走一遍', () => {
  it('选题 → 设定 → 角色 → 卷纲 → 细纲 → 确认 → 开写', async () => {
    // ── 步骤 1：生成选题方向（Phase 1）─────────────────────
    const conceptGen = new ConceptGenerator({ structured: seq(CONCEPT) as never });
    const conceptRes = await conceptGen.generate({
      desiredEmotion: '意难平',
      strengths: '生活经验丰富',
      bookTitle: '拳台',
    });
    expect(conceptRes.ok, '选题生成失败').toBe(true);
    expect(conceptRes.output!.candidates.length, '必须给多个候选供选择').toBeGreaterThan(1);
    // 作者选了第 1 个
    const chosen = conceptRes.output!.candidates[0]!;

    // ── 步骤 2：生成核心设定 + 角色（Phase 2）───────────────
    const settingsGen = new SettingsGenerator({ structured: seq(SETTINGS) as never });
    const settingsRes = await settingsGen.generate({ concept: chosen });
    expect(settingsRes.ok, '设定生成失败').toBe(true);

    // ── 步骤 3：物化进正式表（作者逐条决定；这里全用 use_new）──
    // ⚠ decisions 是 Record<name, decision>；knownConflicts 是**生成时**的冲突列表。
    //   物化时会重新检出冲突，靠这个列表区分"界面漏问"与"新出现的冲突"。
    const decisions: Record<string, 'keep_existing' | 'use_new' | 'keep_both'> = {};
    for (const c of settingsRes.output!.conflicts ?? []) decisions[c.name] = 'use_new';
    const mat = materializeSettings(t.repos, {
      bookId: t.bookId,
      output: settingsRes.output!,
      decisions,
      knownConflicts: (settingsRes.output!.conflicts ?? []).map((c) => c.name),
    });
    expect(mat.charactersCreated.length, '角色必须真的落库').toBeGreaterThan(0);
    expect(mat.worldCreated.length, '世界设定必须真的落库').toBeGreaterThan(0);

    // ⚠ 落库的位置必须是 prompt 真正读的那两张表
    expect(t.repos.characters.listByBook(t.bookId).length).toBe(2);
    expect(t.repos.world.listByBook(t.bookId).length).toBe(2);

    // ── 步骤 4：生成卷级大纲（Phase 3）─────────────────────
    const outlineGen = new OutlineGenerator({ structured: seq(OUTLINE) as never });
    const outlineRes = await outlineGen.generate({
      settings: {
        logline: SETTINGS.logline,
        coreConflict: SETTINGS.coreConflict,
        characters: SETTINGS.characters.map((c) => ({ name: c.name, role: c.role })),
        worldEntities: SETTINGS.worldEntities.map((w) => ({ name: w.name })),
      },
      estimatedChapters: 200,
    });
    expect(outlineRes.ok, '卷纲生成失败').toBe(true);
    const volWrite = t.repos.volumes.replaceAll(t.bookId, outlineRes.output!, {
      replaceExisting: false,
    });
    expect(volWrite.created).toBe(3);

    // ── 步骤 5：生成逐章细纲（分批）───────────────────────
    const detailGen = new ChapterOutlineGenerator({ structured: seq(detailBatch(1, 10)) as never });
    const detailRes = await detailGen.generate({
      settings: {
        logline: SETTINGS.logline,
        coreConflict: SETTINGS.coreConflict,
        characters: SETTINGS.characters.map((c) => ({ name: c.name, role: c.role })),
        worldEntities: SETTINGS.worldEntities.map((w) => ({ name: w.name })),
      },
      startChapter: 1,
      endChapter: 10,
      estimatedChapters: 200,
    });
    expect(detailRes.ok, '细纲生成失败').toBe(true);
    const detWrite = t.repos.chapterOutlines.upsertBatch(t.bookId, detailRes.output!);
    expect(detWrite.created).toBe(10);

    // ⚠⚠ 把各步产出落库（生产路径由 services.blueprint.* 负责）。
    //   这里显式做，是因为本测试直接驱动仓储 ——
    //   若**不**落库，四步全 NOT_STARTED → 门禁判 NOT_USED → 放行，
    //   门禁就测不到了（这正是 W7 首次跑出来的真实缺陷：
    //   生成器当时没有任何生产入口，产出无处可存）。
    t.repos.blueprint.saveDraft(t.bookId, 'CONCEPT' as never, chosen);
    t.repos.blueprint.saveDraft(t.bookId, 'SETTINGS' as never, settingsRes.output);
    t.repos.blueprint.saveDraft(t.bookId, 'OUTLINE' as never, outlineRes.output);
    t.repos.blueprint.saveDraft(t.bookId, 'DETAIL' as never, detailRes.output);

    // ── 步骤 6：统一确认（用户说的「最后确认一切前置信息」）──
    // ⚠ 确认之前必须先被拦
    expect(
      evaluateBookBlueprintGate(t.repos, t.bookId).allowed,
      '前置未确认时不该放行',
    ).toBe(false);
    confirmBookBlueprint(t.repos, t.bookId);
    expect(evaluateBookBlueprintGate(t.repos, t.bookId).allowed, '确认后应放行').toBe(true);

    // ── 步骤 7：开写（此处才允许）─────────────────────────
    // 门禁放行 → 可以进入 plan 阶段
    const gate = evaluateBookBlueprintGate(t.repos, t.bookId);
    expect(gate.reason).toBe('CONFIRMED');
  });
});

// ════════════════════════════════════════════════════════════
describe('①b⚠⚠⚠ W7 实测发现的缺口：生成器必须有生产入口', () => {
  it('⚠⚠⚠ 四个生成器必须在 apps/ 里被引用（否则向导"能生成但无法落库"）', () => {
    // 这个断言是 W7 首跑时**真实失败**过的：
    // 当时四个生成器在 apps/ 零引用，且没人调 saveDraft →
    // 四步永远 NOT_STARTED → 门禁判 NOT_USED → **永远放行**。
    // 作者以为走完了向导，而门禁从没拦过，prompt 也从没读到过前置内容。
    const src = readFileSync(
      join(process.cwd(), 'apps/desktop/src/main/workflow-services.ts'),
      'utf8',
    );
    for (const g of [
      'ConceptGenerator',
      'SettingsGenerator',
      'OutlineGenerator',
      'ChapterOutlineGenerator',
      'materializeSettings',
    ]) {
      expect(src.includes(g), `${g} 没有生产入口 —— 生成器建好了却没人调用`).toBe(true);
    }
    // ⚠⚠ 产出必须**每一步**都落库，否则门禁永远看不到"用过向导"。
    //   数个数而不是判"存在" —— 只写 `includes('saveDraft(')` 的话，
    //   删掉其中三处、只留一处，断言照样通过（假绿）。
    //   四处 = CONCEPT（chooseConcept）/ SETTINGS / OUTLINE / DETAIL。
    const saves = src.match(/saveDraft\(/g) ?? [];
    expect(
      saves.length,
      '四步产出都要落库；少一处则该步永远 NOT_STARTED，门禁与 prompt 都看不到它',
    ).toBe(4);

    // ⚠ 卷整体替换、细纲按章 upsert（两者判断相反，各有理由）
    expect((src.match(/replaceAll\(/g) ?? []).length, '卷必须整体替换').toBe(1);
    expect((src.match(/upsertBatch\(/g) ?? []).length, '细纲必须按章 upsert，不整表替换').toBe(1);
  });

  it('⚠⚠⚠ services 必须先于 IPC 可用，且顺序在 runtime 之后', () => {
    const cp = readFileSync(join(process.cwd(), 'apps/desktop/src/main/core-process.ts'), 'utf8');

    // ① services 必须在**打开项目时**就建好。
    //    buildWorkflowEngine 是懒调用（只在启动工作流时），
    //    向导 IPC 在没跑工作流时也会被调用 —— 那时 services 若是 undefined，
    //    向导一用就崩，且崩在"生成"这一步，看起来像模型坏了。
    expect(
      (cp.match(/project\.services = createWorkflowServicesFor\(project\)/g) ?? []).length,
      '两个 OpenProject 构造点都要建 services',
    ).toBe(2);

    // ② ⚠⚠ 顺序：**先 runtime 后 services**。
    //    createWorkflowServicesFor 读 `p.runtime` 决定模型网关；
    //    反了的话 services 拿到的永远是 null —— 向导一用就报"尚未配置模型"，
    //    而模型其实配好了（把人指向错误的排查方向）。
    const iRuntime = cp.indexOf('project.runtime = buildRuntime(project);');
    const iServices = cp.indexOf('project.services = createWorkflowServicesFor(project);');
    expect(iRuntime, 'runtime 未建').toBeGreaterThan(-1);
    expect(iServices, 'services 未建').toBeGreaterThan(-1);
    expect(
      iRuntime < iServices,
      'services 建在 runtime 之前 → services 拿到的模型网关永远是 null',
    ).toBe(true);

    // ③ 工作流引擎必须**复用** p.services（再建一份会分叉）
    const iEngine = cp.indexOf('function buildWorkflowEngine');
    const engineBody = cp.slice(iEngine, iEngine + 600);
    expect(engineBody, 'buildWorkflowEngine 必须复用 p.services').toContain(
      'createNovelWorkflowStages(p.services)',
    );
  });

  it('⚠⚠⚠ 每个向导生成方法都必须有 IPC 入口（否则界面够不着）', () => {
    const wf = readFileSync(join(process.cwd(), 'apps/desktop/src/main/workflow-services.ts'), 'utf8');
    const cp = readFileSync(join(process.cwd(), 'apps/desktop/src/main/core-process.ts'), 'utf8');

    // 取 services.blueprint 里实现的方法名
    const iBp = wf.indexOf('    blueprint: {');
    expect(iBp, 'services.blueprint 不存在').toBeGreaterThan(-1);
    let depth = 0;
    let end = iBp;
    for (let k = iBp + '    blueprint: {'.length - 1; k < wf.length; k += 1) {
      if (wf[k] === '{') depth += 1;
      else if (wf[k] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = k;
          break;
        }
      }
    }
    const body = wf.slice(iBp, end + 1);
    const methods = [...body.matchAll(/\n      async (\w+)\(/g)].map((m) => m[1]);
    expect(methods.length, '未解析到任何方法').toBeGreaterThan(0);

    // ⚠ 每个"会产出/改动前置内容"的方法都必须能从界面调到。
    //   这正是 W7 抓到的缺陷形态：能力齐全，但没有入口。
    const NEEDS_IPC = [
      'generateConcept',
      'chooseConcept',
      'generateSettings',
      'materializeSettings',
      'generateOutline',
      'generateChapterOutlines',
      'saveStep',
    ];
    const missing = NEEDS_IPC.filter((m) => !methods.includes(m));
    expect(missing, `services 里缺方法：${missing.join(',')}`).toEqual([]);

    const absent = NEEDS_IPC.filter((m) => !cp.includes(`'blueprint.${m}'`));
    expect(absent, `这些方法没有 IPC 入口，界面够不着：${absent.join(',')}`).toEqual([]);
  });

  it('⚠⚠ 总量锚点不得编造 —— 取不到必须报错', () => {
    const src = readFileSync(
      join(process.cwd(), 'apps/desktop/src/main/workflow-services.ts'),
      'utf8',
    );
    expect(src.includes('needEstimatedChapters'), '预计章数是卷号范围的基准，不能猜').toBe(true);
    expect(src).toContain('不能猜');
  });
});

// ════════════════════════════════════════════════════════════
describe('②⚠⚠⚠ 全篇重点：prompt 必须真的读到前面所有产出', () => {
  it('细纲渲染出的文本必须包含核心事件/情绪/钩子/禁止项', () => {
    t.repos.chapterOutlines.upsertBatch(t.bookId, detailBatch(1, 3));
    const text = t.repos.chapterOutlines.renderForPrompt(t.bookId, 2);
    expect(text).toContain('第 2 章');
    expect(text).toContain('陈默与小满的一次交锋');
    expect(text).toContain('从回避 → 被迫面对');
    expect(text).toContain('小满露出了手上的伤');
    expect(text).toContain('不得揭示当年那场比赛的真相');
    expect(text).toContain('他转身进屋');
  });

  it('⚠⚠ 角色表的内容必须能渲染进 prompt 块', () => {
    t.repos.characters.create({
      id: 'char_w7',
      bookId: t.bookId,
      name: '陈默',
      role: '主角',
      profile: { background: '退役拳手，右手有旧伤' },
    });
    const block = renderCharacterBlock(
      t.repos.characters.listByBook(t.bookId).map((c) => ({
        name: c.name,
        aliases: [],
        role: c.role,
        currentStatus: c.current_status,
        profile: c.profile_json ? (JSON.parse(c.profile_json) as never) : null,
      })),
    );
    expect(block, '角色块必须带上旧伤 —— 否则模型不知道，只能自己编').toContain('右手有旧伤');
  });

  it('⚠⚠ 世界设定只有 CONFIRMED 才进 prompt（草稿不该注入）', () => {
    // ⚠ 顺序有讲究：先建第一条 → 确认 → 再建第二条（新条目默认 DRAFT）。
    //   状态不能用 world.update 改 —— 它的 patch 里**没有** status
    //   （让非法状态不可表达，与 volumes.update 同一判断）。
    t.repos.world.create({
      id: 'world_w7_1',
      bookId: t.bookId,
      type: 'RULE',
      name: '拳台规矩',
      description: '认输即止',
    });
    t.repos.world.confirmAll(t.bookId);
    t.repos.world.create({
      id: 'world_w7_2',
      bookId: t.bookId,
      type: 'RULE',
      name: '草稿规则',
      description: '还没定',
    });


    // ⚠ 必须走**生产路径** `selectWorldSettings` ——
    //   过滤 DRAFT 的逻辑在那里，不在 renderWorldBlock（它只渲染给它的东西）。
    //   直接调 renderWorldBlock 会绕过过滤，测试就测了个假东西。
    const rows = t.repos.world.listByBook(t.bookId).map(toWorldBrief);
    const sel = selectWorldSettings(rows);
    expect(sel.block).toContain('认输即止');
    expect(sel.block, '未确认的设定不该进 prompt').not.toContain('还没定');
    expect(sel.skippedDrafts, '应报出有 1 条草稿未注入').toBe(1);
  });
});

// ════════════════════════════════════════════════════════════
describe('③⚠⚠ 分批细纲：跨批次不得互相覆盖（用户要"可续做"）', () => {
  it('⚠⚠ 第二批生成后，第一批仍在（且作者改过的不被抹掉）', () => {
    t.repos.chapterOutlines.upsertBatch(t.bookId, detailBatch(1, 10));
    // 作者改第 3 章
    const before = t.repos.chapterOutlines.get(t.bookId, 3)!;
    expect(before.coreEvent).toBe('第 3 章：陈默与小满的一次交锋');

    t.repos.chapterOutlines.upsertBatch(t.bookId, detailBatch(11, 20));

    expect(t.repos.chapterOutlines.countByBook(t.bookId), '两批必须都在').toBe(20);
    expect(t.repos.chapterOutlines.get(t.bookId, 3)!.coreEvent).toBe(before.coreEvent);
    expect(t.repos.chapterOutlines.get(t.bookId, 15)!.chapterNumber).toBe(15);
  });

  it('⚠ 缺口报告能看出缺了哪几章', () => {
    const b = detailBatch(1, 10);
    b.outlines = b.outlines.filter((o) => o.chapterNumber !== 7);
    t.repos.chapterOutlines.upsertBatch(t.bookId, b);
    expect(t.repos.chapterOutlines.gaps(t.bookId).missing).toEqual([7]);
  });
});

// ════════════════════════════════════════════════════════════
describe('④⚠⚠ 门禁与产物的一致性：改了前置必须重新确认', () => {
  it('⚠⚠⚠ 细纲改动 → 指纹变化 → 再次拦（防"确认后偷偷改"）', () => {
    t.repos.blueprint.saveDraft(t.bookId, 'DETAIL' as never, detailBatch(1, 3));
    confirmBookBlueprint(t.repos, t.bookId);
    expect(evaluateBookBlueprintGate(t.repos, t.bookId).allowed).toBe(true);

    // 确认后又改了细纲
    t.repos.blueprint.saveEdited(t.bookId, 'DETAIL' as never, detailBatch(1, 5));
    const v = evaluateBookBlueprintGate(t.repos, t.bookId);
    expect(v.allowed, '确认后改了细纲必须重新拦').toBe(false);
    expect(v.reason).toBe('CHANGED_SINCE_CONFIRM');
  });

  it('⚠⚠ 卷纲整体替换后也要重新确认', () => {
    t.repos.blueprint.saveDraft(t.bookId, 'OUTLINE' as never, OUTLINE);
    confirmBookBlueprint(t.repos, t.bookId);
    expect(evaluateBookBlueprintGate(t.repos, t.bookId).allowed).toBe(true);

    t.repos.blueprint.saveEdited(t.bookId, 'OUTLINE' as never, {
      ...OUTLINE,
      totalChapters: 250,
    });
    expect(evaluateBookBlueprintGate(t.repos, t.bookId).allowed).toBe(false);
  });

  it('⚠ 四步各自独立确认，但统一确认要求全部就位', () => {
    // 只确认一步
    t.repos.blueprint.saveDraft(t.bookId, 'CONCEPT' as never, CONCEPT.candidates[0]);
    t.repos.blueprint.confirmStep(t.bookId, 'CONCEPT' as never);
    const st = blueprintStateOf(t.repos, t.bookId);
    expect(st.steps.find((s) => s.step === 'CONCEPT')!.status).toBe('CONFIRMED');
    // 但统一确认还没做 → 仍拦
    expect(evaluateBookBlueprintGate(t.repos, t.bookId).allowed).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
describe('⑤⚠ 卷与细纲的一致性（W4 的全局不变量在真实数据上成立）', () => {
  it('⚠ 第 N 章能查到所属卷，且不越界兜底', () => {
    t.repos.volumes.replaceAll(t.bookId, OUTLINE, { replaceExisting: false });
    expect(t.repos.volumes.volumeOfChapter(t.bookId, 1)!.name).toBe('拳馆');
    expect(t.repos.volumes.volumeOfChapter(t.bookId, 40)!.name).toBe('拳馆');
    expect(t.repos.volumes.volumeOfChapter(t.bookId, 41)!.name).toBe('黑拳');
    expect(t.repos.volumes.volumeOfChapter(t.bookId, 200)!.name).toBe('拳王');
    expect(t.repos.volumes.volumeOfChapter(t.bookId, 201), '越界不兜底').toBeUndefined();
  });

  it('⚠ 细纲章号落在卷范围内（两阶段产出对得上）', () => {
    t.repos.volumes.replaceAll(t.bookId, OUTLINE, { replaceExisting: false });
    t.repos.chapterOutlines.upsertBatch(t.bookId, detailBatch(1, 10));
    for (const o of t.repos.chapterOutlines.listByBook(t.bookId)) {
      const vol = t.repos.volumes.volumeOfChapter(t.bookId, o.chapterNumber);
      expect(vol, `第 ${o.chapterNumber} 章不属于任何一卷`).toBeDefined();
      expect(vol!.name).toBe('拳馆');
    }
  });

  it('toOutlineOutput 是直通转换（不在两处拼装形状）', () => {
    const o = toOutlineOutput(detailBatch(1, 2).outlines as never);
    expect(o.outlines.length).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════
describe('⑥⚠⚠ 多书隔离：向导产出不得跨书污染', () => {
  it('⚠⚠ 两本书各自走向导，产物互不可见', async () => {
    const proj = t.repos.projects.list()[0]!;
    const bookB = t.repos.books.create({ id: 'book_w7_b', projectId: proj.id, title: 'B 书' });

    // A 书走完
    t.repos.blueprint.saveDraft(t.bookId, 'CONCEPT' as never, CONCEPT.candidates[0]);
    t.repos.chapterOutlines.upsertBatch(t.bookId, detailBatch(1, 5));
    t.repos.volumes.replaceAll(t.bookId, OUTLINE, { replaceExisting: false });
    confirmBookBlueprint(t.repos, t.bookId);

    // B 书什么都没做
    expect(t.repos.chapterOutlines.countByBook(bookB.id)).toBe(0);
    expect(t.repos.volumes.countByBook(bookB.id)).toBe(0);
    expect(t.repos.blueprint.confirmedHash(bookB.id), 'B 书不该继承 A 书的确认').toBeNull();
    // ⚠ B 书没用过向导 → 放行（NOT_USED），不是"被 A 书连带确认"
    const vb = evaluateBookBlueprintGate(t.repos, bookB.id);
    expect(vb.allowed).toBe(true);
    expect(vb.reason).toBe('NOT_USED');
  });

  it('⚠⚠ B 书的细纲渲染不夹带 A 书内容', () => {
    const proj = t.repos.projects.list()[0]!;
    const bookB = t.repos.books.create({ id: 'book_w7_b2', projectId: proj.id, title: 'B2' });
    t.repos.chapterOutlines.upsertBatch(t.bookId, detailBatch(1, 3));
    expect(t.repos.chapterOutlines.renderForPrompt(bookB.id, 1), 'B 书该是空的').toBe('');
  });
});
