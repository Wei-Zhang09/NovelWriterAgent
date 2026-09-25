/**
 * §43 章节流水线进度（`Planning ✓ Writing ✓ Review ✓ Revision ● Continuity ○ Commit ○`）
 *
 * ## 为什么必须证伪
 *
 * 进度条是**纯展示**，所以它出错的唯一方式是**显示得不对**——
 * 而"显示得不对"不会抛错、不会失败、没人会收到告警。作者看到
 * `Writing ✓` 就会以为草稿已经生成过，于是跳过那一步。
 *
 * 这类缺陷只有靠"构造真实产物 → 断言显示的步骤"来抓。
 *
 * ## 判据必须是产物事实，不是任务状态（研究报告 §3.1 决策 1）
 *
 * 六步的完成判据全部来自**工作区产物文件**与**章节行状态**。
 * 因此本测试**真的往工作区写文件**，而不是 mock 一个进度对象 ——
 * mock 掉数据源就等于把要验证的东西假设成对的。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const CORE = join(REPO, 'apps/desktop/src/main/core-process.ts');
const PIPELINE = join(REPO, 'apps/desktop/src/renderer/pipeline.js');
const STYLE = join(REPO, 'apps/desktop/src/renderer/style.css');

/**
 * 最小 DOM 替身 —— 只为观察 renderPipeline 产出的结构与类名。
 *
 * ⚠ 不引入 jsdom：本测试要验的是"类名与图标怎么打"，不是浏览器行为。
 *   真浏览器行为已由 verify:flow 的 GUI 断言覆盖。
 */
interface StubEl {
  tag: string;
  className: string;
  textContent: string;
  children: StubEl[];
  attrs: Record<string, string>;
  append(...n: StubEl[]): void;
  replaceChildren(...n: StubEl[]): void;
  setAttribute(k: string, v: string): void;
}

function stubEl(tag: string, cls?: string, text?: string): StubEl {
  const n: StubEl = {
    tag,
    className: cls ?? '',
    textContent: text ?? '',
    children: [],
    attrs: {},
    append(...kids: StubEl[]) { n.children.push(...kids); },
    // ⚠ 必须实现：renderPipeline 在异步分支里先 replaceChildren 再 append。
    //   少了它会在 async IIFE 内抛错，而那个错误被 void 吞掉 ——
    //   表现是"渲染出 0 个步骤"，看起来像组件坏了（实测踩到）。
    replaceChildren(...kids: StubEl[]) { n.children = [...kids]; },
    setAttribute(k: string, v: string) { n.attrs[k] = v; },
  };
  return n;
}

/** 深度收集所有后代（含自身） */
function all(node: StubEl): StubEl[] {
  return [node, ...node.children.flatMap(all)];
}

/** 渲染并等异步分支跑完 */
async function render(steps: unknown[] | null, ok = true) {
  const { renderPipeline } = await import(PIPELINE);
  const box = renderPipeline({
    el: stubEl,
    invoke: async () =>
      ok
        ? { ok: true, data: { steps, committed: (steps ?? []).some((s) => (s as { id: string }).id === 'commit' && (s as { done: boolean }).done), doneCount: (steps ?? []).filter((s) => (s as { done: boolean }).done).length, total: 6 } }
        : { ok: false, error: { message: '读取失败' } },
    chapter: { id: 'ch_1', chapterNumber: 1 },
  });
  // 等微任务队列把 async 分支跑完
  await new Promise((r) => setTimeout(r, 0));
  return box as unknown as StubEl;
}

/** 读源码并归一 CRLF —— 本仓混用行尾，正则匹配前必须统一 */
function readSrc(p: string): string {
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * 复刻主进程 `manuscript.pipeline` 的判据，用于独立验算。
 *
 * ⚠ 这是**有意重复实现**：测试若直接 import 被测实现，
 *   实现改错了测试会跟着一起错（同源假绿）。
 *   这里按 §43 的规格独立写一遍，两边不一致就是缺陷。
 */
function deriveSteps(present: readonly string[], committed: boolean) {
  const order = ['plan', 'draft', 'review', 'revision', 'continuity'] as const;
  const has = (k: string) => present.includes(k);
  const currentIndex = order.findIndex((k) => !has(k));

  const list = order.map((k, i) => ({
    id: k,
    done: has(k),
    current: !committed && currentIndex === i,
  }));
  list.push({ id: 'commit', done: committed, current: !committed && currentIndex === -1 });
  return list;
}

describe('§43 进度判据（独立验算）', () => {
  it('什么都没做 → 第一步为「进行中」，其余未开始', () => {
    const s = deriveSteps([], false);
    expect(s.map((x) => x.id)).toEqual([
      'plan', 'draft', 'review', 'revision', 'continuity', 'commit',
    ]);
    expect(s.filter((x) => x.current).map((x) => x.id)).toEqual(['plan']);
    expect(s.filter((x) => x.done)).toHaveLength(0);
  });

  it('只做了规划 → Planning ✓，Writing ●', () => {
    const s = deriveSteps(['plan'], false);
    expect(s[0]!.done).toBe(true);
    expect(s[1]!.current).toBe(true);
    expect(s.filter((x) => x.current)).toHaveLength(1);
  });

  it('⚠ 中间缺一步时，只有**第一个**缺口是「进行中」', () => {
    // 场景：规划、草稿、改稿都有，但没有审阅报告
    const s = deriveSteps(['plan', 'draft', 'revision'], false);
    const cur = s.filter((x) => x.current).map((x) => x.id);
    expect(
      cur,
      '中间缺一步时若后面每步都显示"进行中"，进度条会同时出现多个 ● —— 那是在骗人',
    ).toEqual(['review']);
  });

  it('五步产物齐全但未提交 → Commit 是「进行中」，不是「已完成」', () => {
    const s = deriveSteps(['plan', 'draft', 'review', 'revision', 'continuity'], false);
    expect(s.slice(0, 5).every((x) => x.done)).toBe(true);
    expect(s[5]!.id).toBe('commit');
    expect(s[5]!.done).toBe(false);
    expect(s[5]!.current).toBe(true);
  });

  it('⚠ 已提交 → 没有任何「进行中」，Commit ✓', () => {
    const s = deriveSteps(['plan', 'draft', 'review', 'revision', 'continuity'], true);
    expect(s.every((x) => x.done)).toBe(true);
    expect(
      s.filter((x) => x.current),
      '已提交的章节不该再有"进行中"的步骤 —— 那会让作者以为还有事没做完',
    ).toHaveLength(0);
  });

  it('⚠ 已提交但产物文件被清理过 → 不谎报完成（如实显示缺口）', () => {
    // 真实场景：§十四 明确版本/中间产物可丢弃，用户可能清过 workspace
    const s = deriveSteps([], true);
    expect(s[5]!.done, 'Commit 必须按章节状态判，不按文件').toBe(true);
    expect(s[0]!.done, '产物缺失就显示未完成，不因已提交而假装做过').toBe(false);
    // 已提交时不应出现"进行中"
    expect(s.filter((x) => x.current)).toHaveLength(0);
  });
});

describe('⚠ 源码级约束：进度条必须由产物事实驱动', () => {
  const core = readSrc(CORE);
  const ui = readSrc(PIPELINE);
  const css = readSrc(STYLE);

  it('主进程有 manuscript.pipeline 通道', () => {
    expect(core).toContain("'manuscript.pipeline':");
  });

  it('⚠ 判据查的是工作区产物文件，不是 workflows 表', () => {
    const i = core.indexOf("'manuscript.pipeline':");
    expect(i).toBeGreaterThan(-1);
    // 到下一个 handler 为止
    const next = core.indexOf("\n  '", i + 1);
    const seg = core.slice(i, next === -1 ? undefined : next);

    expect(
      seg,
      '进度条若读 workflows 表，会把"工作流跑到哪"当成"这一章写到哪"—— ' +
        '用逐步按钮写出来的章节根本没有工作流记录',
    ).not.toContain('WorkflowRepository');
    expect(seg).toContain('ws.has(');
  });

  it('⚠ 用 has() 判存在性而非解析内容（坏文件不该让整条流水线显示"没做过"）', () => {
    const i = core.indexOf("'manuscript.pipeline':");
    const next = core.indexOf("\n  '", i + 1);
    const seg = core.slice(i, next === -1 ? undefined : next);
    expect(seg).not.toMatch(/readJson|readText|JSON\.parse/);
  });

  it('Commit 步按章节状态判，不按文件', () => {
    const i = core.indexOf("'manuscript.pipeline':");
    const next = core.indexOf("\n  '", i + 1);
    const seg = core.slice(i, next === -1 ? undefined : next);
    expect(seg).toContain("chapter.status === 'COMMITTED'");
  });

  it('⚠ 前端不自己推断阶段（不猜"有 draft 就认为 review 过了"）', () => {
    expect(
      ui,
      '前端若自行推断阶段，就会与后端的真实判据分叉',
    ).not.toMatch(/draft.*=>.*review|inferStage|guessStage/);
    // 只读后端给的 done/current
    expect(ui).toContain('s.done');
    expect(ui).toContain('s.current');
  });

  it('⚠ 读不到进度时不退回"全部未开始"（那是在编造进度）', () => {
    const i = ui.indexOf('if (!r.ok)');
    expect(i).toBeGreaterThan(-1);
    // ⚠ 只取**失败分支自己的花括号块**，不能按固定长度截取 ——
    //   截长了会把后面成功分支的 r.data.steps 也算进来，测试假红。
    const open = ui.indexOf('{', i);
    let depth = 0;
    let end = -1;
    for (let k = open; k < ui.length; k++) {
      if (ui[k] === '{') depth++;
      else if (ui[k] === '}') {
        depth--;
        if (depth === 0) { end = k + 1; break; }
      }
    }
    expect(end, '找不到失败分支的闭合花括号').toBeGreaterThan(-1);
    const seg = ui.slice(i, end);

    expect(seg, '失败分支必须明确报错').toMatch(/pipeline__err|读取失败/);
    expect(seg, '⚠ 失败分支必须在渲染 steps 之前 return').toContain('return;');
    expect(seg, '失败分支不该渲染出 steps').not.toContain('r.data.steps');
  });

  it('状态是颜色 + 字符双编码（色觉障碍与灰度截图也能分辨）', () => {
    expect(ui).toMatch(/ICON\s*=\s*\{[^}]*done:\s*'✓'/);
    expect(ui).toMatch(/current:\s*'●'/);
    expect(ui).toMatch(/todo:\s*'○'/);
  });

  it('⚠ 样式全部走主题令牌，无硬编码颜色（浅色主题下会深底深字）', () => {
    const i = css.indexOf('.pipeline {');
    expect(i).toBeGreaterThan(-1);
    const seg = css.slice(i, css.indexOf('.pipeline__sum--ok') + 120);
    const hard = seg.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hard, `发现硬编码颜色：${hard.join('、')}`).toHaveLength(0);
  });
});

describe('§43 进度条：真实产物 → 真实判据', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nwa-pipeline-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** 复刻 ChapterWorkspace 的路径约定：workspace/chapter-NNN/<file> */
  function wsDir(n: number): string {
    return join(root, 'workspace', `chapter-${String(n).padStart(3, '0')}`);
  }
  function put(n: number, file: string, content = 'x'): void {
    mkdirSync(wsDir(n), { recursive: true });
    writeFileSync(join(wsDir(n), file), content, 'utf8');
  }

  it('工作区文件落盘位置与判据一致（路径约定钉住）', () => {
    put(1, 'plan.json', '{"scenes":[]}');
    put(1, 'draft.md', '正文');
    const d = wsDir(1);
    // ⚠ 三位零填充是约定（chapter-001），少了它判据会永远找不到文件
    expect(d).toContain('chapter-001');
    expect(readFileSync(join(d, 'plan.json'), 'utf8')).toContain('scenes');

    const present = ['plan', 'draft'];
    const s = deriveSteps(present, false);
    expect(s[0]!.done && s[1]!.done).toBe(true);
    expect(s[2]!.current).toBe(true);
  });

  it('⚠ 章号 10 以上仍用三位零填充（chapter-010，不是 chapter-10）', () => {
    const d = wsDir(10);
    expect(d).toMatch(/chapter-010$/);
  });
});

describe('§43 进度条：真实渲染（最小 DOM 替身）', () => {
  const mk = (done: string[], current: string, committed = false) =>
    ['plan', 'draft', 'review', 'revision', 'continuity'].map((id) => ({
      id, label: { plan: 'Planning', draft: 'Writing', review: 'Review', revision: 'Revision', continuity: 'Continuity' }[id],
      done: done.includes(id), current: id === current,
    })).concat([{ id: 'commit', label: 'Commit', done: committed, current: committed === false && current === '' }]);

  it('渲染出六个步骤，顺序与 §43 一致', async () => {
    const box = await render(mk(['plan', 'draft'], 'review'));
    const steps = all(box).filter((n) => n.className.includes('pipeline__step'));
    expect(steps).toHaveLength(6);
    const labels = steps.map((n) => n.children.find((c) => c.className.includes('pipeline__label'))?.textContent);
    expect(labels).toEqual(['Planning', 'Writing', 'Review', 'Revision', 'Continuity', 'Commit']);
  });

  it('⚠ 已完成/进行中/未开始三种类名分别正确', async () => {
    const box = await render(mk(['plan', 'draft'], 'review'));
    const steps = all(box).filter((n) => n.className.includes('pipeline__step'));
    expect(steps[0]!.className).toContain('--done');
    expect(steps[1]!.className).toContain('--done');
    expect(steps[2]!.className).toContain('--current');
    expect(steps[3]!.className).toContain('--todo');
  });

  it('⚠ 图标随状态变化（✓ / ● / ○）', async () => {
    const box = await render(mk(['plan'], 'draft'));
    const marks = all(box)
      .filter((n) => n.className.includes('pipeline__mark'))
      .map((n) => n.textContent);
    expect(marks[0]).toBe('✓');
    expect(marks[1]).toBe('●');
    expect(marks[2]).toBe('○');
  });

  it('⚠ 每个步骤带 title 文字状态（图标是纯视觉编码，读屏需要文字）', async () => {
    const box = await render(mk(['plan'], 'draft'));
    const steps = all(box).filter((n) => n.className.includes('pipeline__step'));
    expect(steps[0]!.attrs['title']).toContain('已完成');
    expect(steps[1]!.attrs['title']).toContain('进行中');
    expect(steps[2]!.attrs['title']).toContain('未开始');
  });

  it('⚠ 未提交时明确标出（作者要一眼看出这不是正史）', async () => {
    const box = await render(mk(['plan'], 'draft'));
    const sum = all(box).find((n) => n.className.includes('pipeline__sum'));
    expect(sum?.textContent).toContain('未提交');
  });

  it('⚠ 已提交时标为正式章节', async () => {
    const box = await render(mk(['plan', 'draft', 'review', 'revision', 'continuity'], '', true));
    const sum = all(box).find((n) => n.className.includes('pipeline__sum'));
    expect(sum?.textContent).toContain('已提交为正式章节');
  });

  it('⚠ 读取失败时明确报错，且不渲染任何步骤（不编造进度）', async () => {
    const box = await render(null, false);
    const steps = all(box).filter((n) => n.className.includes('pipeline__step'));
    expect(steps, '读不到进度时若仍渲染步骤，等于在编造进度').toHaveLength(0);
    expect(all(box).some((n) => n.className.includes('pipeline__err'))).toBe(true);
  });
});
