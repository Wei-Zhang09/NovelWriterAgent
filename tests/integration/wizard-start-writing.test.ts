/**
 * C1 —— 开书向导「能真的走完并开写」（2026-09-26 用户实测反馈）
 *
 * ## 用户原话（三个缺口 + 一个补充）
 * > 「开书向导完成后应该直接创建一本新书籍，并且可以开始生成第一章，
 * >    至少得有个按钮吧」
 * > 「还有关于章节字数的设定也没有」
 * > 「你应该再去参考一下之前给你的那几个项目，看看它们开始前需要做哪些设定」
 *
 * ## 用户拍板的三项决策（clarify 原话）
 *   ① 「向导「统一确认」时一并把世界观设定也确认掉 —— 两道门禁合并成
 *       一次人工确认（向导里已有设定内容，你刚看过）」
 *   ② 「一个主按钮「开始写第 1 章」，点了直接启动整章工作流」
 *   ③ 「没有书时，向导入口先引导「新建书 → 进向导」，确认后这本书
 *       直接可写（不在向导里再建书）」
 *
 * ## 这个测试真正在防什么
 *
 * 实测暴露的失败形态是「能力齐全、链路断裂」：
 *   · 向导把设定写进 `world_entities`（步骤②的物化）→ `settings_gate`
 *     立刻变成 `NEVER_CONFIRMED`
 *   · 向导的「统一确认」**只**确认自己那四步，从不碰设定门禁
 *   · 于是作者走完向导 → 点开写 → plan 被 `SETTINGS_NOT_CONFIRMED` 拦死，
 *     而错误信息指向的「世界观设定」面板**在左栏导航里没有入口**
 *
 * 所以本文件断言的重点不是"某个函数存在"，而是：
 *   ① 一次确认动作**真的**把两道门禁都关掉了（读库实证，不是读代码）
 *   ② 「开始写」按钮真的存在，且**确认前不出现**（否则点一个注定失败的按钮）
 *   ③ 字数设定在向导里可读可写，且与项目主页**共用同一个 IPC**
 *   ④ 没有书时给的是建书入口，不是死胡同
 *
 * ⚠ 只断言"代码里有这行字符串"是假绿重灾区（约定 ⑫）：向导里写了按钮
 *   但没接进 `parts` 渲染列表，界面上就是没有。所以 ② 额外断言**它被
 *   `parts` 数组引用**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  confirmBookSettings,
  confirmBookBlueprint,
  blueprintStateOf,
  evaluateBookBlueprintGate,
} from '@nwa/storage';
import { evaluateSettingsGate, hashSettings } from '@nwa/core';
import { createTestProject, type TestProject } from './helpers.js';

const REPO = process.cwd();
const readSrc = (p: string): string =>
  readFileSync(join(REPO, p), 'utf8').replace(/\r\n/g, '\n');

const WIZARD = readSrc('apps/desktop/src/renderer/blueprint-wizard.js');
const RENDERER = readSrc('apps/desktop/src/renderer/renderer.js');
const CORE = readSrc('apps/desktop/src/main/core-process.ts');
const STYLE = readSrc('apps/desktop/src/renderer/style.css');

let t: TestProject;
/** 本文件里当前操作的书（默认测试书） */
let bookId: string;

beforeEach(() => {
  t = createTestProject();
  bookId = t.bookId;
});

afterEach(() => {
  t.cleanup();
});

/** 设定门禁的当前判定（走唯一实现，不在测试里重写判定） */
function settingsVerdict() {
  const book = t.repos.books.get(bookId);
  return evaluateSettingsGate({
    gateEnabled: book.settings_gate_enabled === 1,
    confirmedHash: book.settings_confirmed_hash,
    currentHash: hashSettings(t.repos.world.snapshot(bookId)),
    entryCount: t.repos.world.snapshot(bookId).length,
  });
}

// ════════════════════════════════════════════════════════════
describe('①⚠⚠ 一次人工确认必须同时关掉两道门禁（用户决策 ①）', () => {
  it('⚠⚠⚠ 向导物化设定后，只做向导确认 → 设定门禁仍拦（复现原始缺陷）', () => {
    // 步骤②的物化效果：设定进了正式表
    t.repos.world.create({ id: 'w1', bookId, type: 'WORLD_RULE', name: '灵力枯竭' });
    // 向导「统一确认」（**旧行为**：不管设定）
    confirmBookBlueprint(t.repos, bookId);

    // ⚠ 这条是缺陷的**复现**：向导确认了，设定门禁照样拦。
    //   若哪天有人把两道门禁的判定合成一个，这条会红 —— 那时该改的是
    //   测试意图而不是删掉它（两道门禁管不同的事，见 0022 迁移注释）。
    const v = settingsVerdict();
    expect(v.allowed, '向导确认**不该**顺带关掉设定门禁 —— 那是这次修复要加的').toBe(false);
    expect(v.reason).toBe('NEVER_CONFIRMED');
  });

  it('⚠⚠⚠ 修复后：confirmAll 一次把两道门禁都放行（读库实证）', () => {
    t.repos.world.create({ id: 'w1', bookId, type: 'WORLD_RULE', name: '灵力枯竭' });
    t.repos.world.create({ id: 'w2', bookId, type: 'CHARACTER', name: '陈默' });
    t.repos.blueprint.saveDraft(bookId, 'CONCEPT' as never, { text: '草案' });

    // 生产路径：core-process 的 blueprint.confirmAll 调用序列
    const settings = confirmBookSettings(t.repos, bookId);
    confirmBookBlueprint(t.repos, bookId);

    // ① 设定门禁放行（读库，不是读返回值）
    const book = t.repos.books.get(bookId);
    expect(book.settings_confirmed_hash, '设定指纹必须真的写进 books 表').not.toBeNull();
    const sv = settingsVerdict();
    expect(sv.allowed, `设定门禁必须放行，实际：${sv.reason}`).toBe(true);
    expect(settings.count, '返回的设定条数必须是真的（UI 要显示它）').toBe(2);

    // ② 向导门禁也放行
    expect(evaluateBookBlueprintGate(t.repos, bookId).allowed).toBe(true);
  });

  it('⚠⚠ confirmAll 必须真的调用 confirmBookSettings（不只是注释里说）', () => {
    const start = CORE.indexOf("'blueprint.confirmAll'");
    expect(start, '找不到 blueprint.confirmAll').toBeGreaterThan(-1);
    // 取该 handler 到下一个 IPC 键之间的片段
    const seg = CORE.slice(start, CORE.indexOf("'blueprint.revokeConfirm'", start));
    expect(
      seg.includes('confirmBookSettings(p.repos, params.bookId)'),
      'confirmAll 必须调用 confirmBookSettings —— 否则作者走完向导仍被设定门禁拦死',
    ).toBe(true);
    // ⚠ 顺序：先设定后向导。反过来的话设定确认失败会留下
    //   「向导已确认但设定没确认」的中间态，作者再撞一次同样的门禁。
    expect(
      seg.indexOf('confirmBookSettings') < seg.indexOf('confirmBookBlueprint'),
      '必须先确认设定、再确认向导（否则失败时留下半确认状态）',
    ).toBe(true);
  });

  it('⚠ 重复确认幂等（作者点两次不该出错）', () => {
    t.repos.world.create({ id: 'w1', bookId, type: 'WORLD_RULE', name: '规则' });
    confirmBookSettings(t.repos, bookId);
    const h1 = t.repos.books.get(bookId).settings_confirmed_hash;
    confirmBookSettings(t.repos, bookId);
    expect(t.repos.books.get(bookId).settings_confirmed_hash, '重复确认不该改变指纹').toBe(h1);
  });
});

// ════════════════════════════════════════════════════════════
describe('②⚠⚠「开始写第 1 章」主按钮（用户决策 ②）', () => {
  it('⚠⚠ 按钮存在，且**接进了 parts 渲染列表**（写了不接 = 界面上没有）', () => {
    expect(WIZARD.includes('renderStartWriting'), '找不到 renderStartWriting').toBe(true);
    expect(
      /['"]开始写第/.test(WIZARD) || WIZARD.includes('开始写第 ${nextNo} 章'),
      '按钮文案必须真的存在',
    ).toBe(true);

    // ⚠ 关键：函数定义了但没被调用 = 界面上根本看不见。
    //   本仓已踩过这个坑（W7/W8 的"能力齐全、没有入口"）。
    expect(
      WIZARD.includes('renderStartWriting()'),
      'renderStartWriting 必须被 renderConfirmPanel 调用 —— 只定义不调用时界面上没有这个按钮',
    ).toBe(true);
  });

  it('⚠⚠ 确认前**不显示**按钮（点一个注定失败的按钮比没有更糟）', () => {
    const start = WIZARD.indexOf('function renderConfirmPanel');
    const end = WIZARD.indexOf('function renderStartWriting');
    const seg = WIZARD.slice(start, end);

    // ⚠ 不能用 /if \(d\.confirmedAt\)[\s\S]*renderStartWriting\(\)/ ——
    //   贪婪的 `[\s\S]*` 会从**前一个** `if (d.confirmedAt)`（守卫"撤回确认"
    //   按钮的那个）一路匹配到这里，于是把守卫整个删掉测试照样绿。
    //   实测过：去掉守卫后该正则仍为 true。这就是弱断言 = 假绿。
    //
    // 改成：从调用点**往回**找最近的守卫，并要求两者之间没有闭合大括号。
    const callIdx = seg.indexOf('renderStartWriting()');
    expect(callIdx, 'renderConfirmPanel 里必须调用 renderStartWriting()').toBeGreaterThan(-1);
    const guardIdx = seg.lastIndexOf('if (d.confirmedAt)', callIdx);
    expect(guardIdx, '调用点前面必须有 `if (d.confirmedAt)` 守卫').toBeGreaterThan(-1);
    const between = seg.slice(guardIdx, callIdx);
    expect(
      /\n {4}\}/.test(between),
      '守卫与调用之间出现了闭合大括号 —— 说明调用点其实在守卫**外面**（未确认也会显示按钮）',
    ).toBe(false);
  });

  it('⚠⚠ 点击后真的启动整章工作流（不是只弹个提示）', () => {
    const seg = WIZARD.slice(WIZARD.indexOf('function renderStartWriting'));
    expect(seg.includes("invoke('workflow.start'"), '必须真的调 workflow.start').toBe(true);
    // ⚠ 不传 chapterNumber：章号由工作流自己算，UI 再算一套会不一致
    //   （与 workflow-panel.js 同一约定）。
    expect(
      /invoke\('workflow\.start',\s*\{\s*bookId:\s*bookId\(\)\s*\}\)/.test(seg),
      '章号必须交给工作流决定，UI 不传 chapterNumber',
    ).toBe(true);
  });

  it('⚠⚠⚠ 开写前必须先查设定门禁，并**说明哪一道没过**', () => {
    const seg = WIZARD.slice(WIZARD.indexOf('function renderStartWriting'));
    expect(
      seg.includes("invoke('settings.status'"),
      '必须查 settings.status —— 向导确认后设定仍可能被改动',
    ).toBe(true);
    // ⚠ 查之前按钮必须**禁用**：状态不明时开写会绕过这道检查，
    //   作者看到的将是"工作流 FAILED"而不是可操作的原因。
    expect(
      /btn\.disabled\s*=\s*true/.test(seg),
      '门禁查询返回前按钮必须禁用',
    ).toBe(true);
    // 查询失败时**保持**禁用（不能 fallthrough 到启用）
    expect(
      /if\s*\(!r\.ok\)\s*\{[\s\S]{0,200}return;/.test(seg),
      '门禁状态读不到时必须保持禁用并 return',
    ).toBe(true);
  });

  it('⚠ 新样式类必须真的定义过（未定义 class 被浏览器静默忽略）', () => {
    // 本仓约定：新加的 class 必须能在 style.css 里找到。
    //
    // ⚠ 不能用 `STYLE.includes('.start-writing')` —— 那是**子串**匹配，
    //   把类改名成 `.start-writing-UNDEFINED` 照样为真（实测漏过）。
    //   必须要求类名后跟一个"标识符不可能出现的字符"（`{`/空白/`,`/`:`）。
    for (const cls of ['start-writing', 'btn--lg']) {
      const defined = new RegExp(`\\.${cls}(?![\\w-])`).test(STYLE);
      expect(defined, `style.css 缺少 .${cls} —— 未定义的类会被浏览器静默忽略`).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════
describe('③⚠⚠ 章节字数设定在向导里也有（用户反馈「字数设定也没有」）', () => {
  it('⚠⚠ 向导里有字数面板，且接进了 parts 渲染列表', () => {
    expect(WIZARD.includes('renderWordTargetPanel'), '向导缺少字数面板').toBe(true);
    expect(
      /renderWordTargetPanel\(\)/.test(WIZARD.slice(WIZARD.indexOf('const parts = ['))),
      '字数面板必须被 parts 引用 —— 只定义不渲染时界面上看不见',
    ).toBe(true);
  });

  it('⚠⚠ 与项目主页**共用同一个 IPC**（两处各写一套迟早分叉）', () => {
    const seg = WIZARD.slice(WIZARD.indexOf('function renderWordTargetPanel'));
    expect(seg.includes("invoke('book.setWordTarget'"), '必须走既有的 book.setWordTarget').toBe(
      true,
    );
    // 项目主页那份也在用同一个通道
    expect(RENDERER.includes("call('book.setWordTarget'")).toBe(true);
  });

  it('⚠⚠ 字数设定真的落库，且按书隔离', () => {
    t.repos.books.setWordTarget(bookId, 2500, 30);
    const b = t.repos.books.get(bookId);
    expect(b.target_words_per_chapter, '目标字数必须真的写进 books 表').toBe(2500);
    expect(b.word_count_tolerance_pct).toBe(30);

    // ⚠ 多书隔离硬要求：B 书的设定不受 A 书影响
    const projectId = t.repos.projects.list()[0]!.id;
    const bookB = t.repos.books.create({ id: 'bk2', projectId, title: 'B' });
    expect(t.repos.books.get(bookB.id).target_words_per_chapter, 'B 书不该继承 A 书的字数').toBeNull();
    expect(t.repos.books.get(bookB.id).word_count_tolerance_pct, 'B 书该是默认 40').toBe(40);
  });

  it('⚠ 清除字数设定后回到 null（回落默认值）', () => {
    t.repos.books.setWordTarget(bookId, 2500, 30);
    t.repos.books.setWordTarget(bookId, null);
    expect(t.repos.books.get(bookId).target_words_per_chapter).toBeNull();
  });

  it('⚠⚠ book.list 必须返回字数目标（否则面板永远显示空值）', () => {
    const start = CORE.indexOf("'book.list'");
    const seg = CORE.slice(start, CORE.indexOf("'book.create'", start));
    expect(
      seg.includes('targetWordsPerChapter') && seg.includes('wordCountTolerancePct'),
      'book.list 不返回字数目标时，向导面板回显为空 —— 作者会以为没保存成功',
    ).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
describe('④⚠⚠ 没有书时先引导建书（用户决策 ③）', () => {
  it('⚠⚠ 无书时给的是建书入口，不是死胡同文案', () => {
    expect(WIZARD.includes('renderCreateBookPrompt'), '缺少建书引导').toBe(true);
    // ⚠ 原文案「先在左栏选一本书」在**一本书都没有**时是死胡同：
    //   左栏书目区只显示「还没有书」，没有可点的地方。
    const start = WIZARD.indexOf('async function loadStatus');
    const seg = WIZARD.slice(start, WIZARD.indexOf('function renderGate', start));
    expect(seg.includes('renderCreateBookPrompt()'), '无书时必须渲染建书引导').toBe(true);
  });

  it('⚠⚠ 建书走既有 IPC，且建完立刻切到新书', () => {
    const seg = WIZARD.slice(
      WIZARD.indexOf('function renderCreateBookPrompt'),
      WIZARD.indexOf('function renderGate'),
    );
    expect(seg.includes("invoke('book.create'"), '必须走既有的 book.create').toBe(true);
    expect(
      /state\.selectedBookId\s*=\s*r\.data\.id/.test(seg),
      '建完必须切到新书 —— 否则向导仍绑在旧书上，作者以为"创建了但向导还是空的"',
    ).toBe(true);
  });

  it('⚠⚠ 刷新左栏必须**不重建中栏**（否则作者被踢出向导）', () => {
    // renderer.js 必须注入一个只刷左栏的函数
    expect(RENDERER.includes('refreshBooks'), 'renderer.js 必须提供 refreshBooks').toBe(true);
    const start = RENDERER.indexOf('async function refreshBooks');
    expect(start, '找不到 refreshBooks 定义').toBeGreaterThan(-1);
    const seg = RENDERER.slice(start, start + 500);
    // ⚠ 关键：不能调 renderCenter() —— 那会把作者从向导里踢回项目主页
    expect(seg.includes('renderCenter'), 'refreshBooks 不该重建中栏').toBe(false);
    expect(seg.includes('renderNav'), 'refreshBooks 必须刷左栏').toBe(true);

    // 向导必须真的用它
    expect(WIZARD.includes('refreshBooks?.()'), '向导必须调用注入的 refreshBooks').toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
describe('⑤ 多书隔离：向导动作不得跨书污染（硬要求）', () => {
  it('⚠⚠ 确认 A 书不改变 B 书的门禁状态', () => {
    const projectId = t.repos.projects.list()[0]!.id;
    const bookB = t.repos.books.create({ id: 'bk2', projectId, title: 'B' });

    t.repos.world.create({ id: 'wa', bookId, type: 'WORLD_RULE', name: 'A 的规则' });
    t.repos.world.create({ id: 'wb', bookId: bookB.id, type: 'WORLD_RULE', name: 'B 的规则' });

    confirmBookSettings(t.repos, bookId);
    confirmBookBlueprint(t.repos, bookId);

    expect(t.repos.books.get(bookB.id).settings_confirmed_hash, 'B 书不该被 A 书的确认带上').toBeNull();
    expect(blueprintStateOf(t.repos, bookB.id).currentHash).not.toBe(
      blueprintStateOf(t.repos, bookId).currentHash,
    );
  });
});
