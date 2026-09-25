/**
 * §41 顶栏四要素 + §41/§42 时间线与伏笔独立入口
 *
 * ## 为什么这些必须钉住
 *
 * 这一批全是**只读展示**，出错方式只有一种：**显示得不对**。
 * 不抛错、不失败、没人收到告警 —— 用户看到"模型：未配置"而实际配了，
 * 或看到"暂无事件"而其实是读取失败，就会做出错误判断。
 *
 * ## 本文件里最重要的一条：CSS 类存在性
 *
 * 之前踩过：`panels.js` 用了 `.btn--danger`，而**这个类从未定义过**
 * —— 危险按钮和普通按钮长得一模一样，作者看不出哪个点了会丢数据。
 * 浏览器对未定义的 class **静默忽略**，所以这类缺陷只能靠扫描抓。
 *
 * 本轮写新视图时又用了 4 个不存在的类（`.callout--warn` / `.tag--info`
 * / `.tag--ok` / `.tag--muted`），靠同一条扫描发现的。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const R = (p: string) => join(REPO, 'apps/desktop/src/renderer', p);

function readSrc(p: string): string {
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

const CORE = readSrc(join(REPO, 'apps/desktop/src/main/core-process.ts'));
const RENDERER = readSrc(R('renderer.js'));
const INDEX = readSrc(R('index.html'));
const STYLE = readSrc(R('style.css'));
const TIMELINE = readSrc(R('timeline-view.js'));
const FORESHADOW = readSrc(R('foreshadow-view.js'));

describe('§41 顶栏四要素', () => {
  it('四个要素都在 DOM 里（项目 / 当前章 / 模型 / Run）', () => {
    for (const id of ['fact-project', 'fact-chapter', 'fact-model', 'fact-run']) {
      expect(INDEX, `顶栏缺少 ${id}`).toContain(`id="${id}"`);
    }
    for (const k of ['项目', '当前章', '模型', 'Run']) {
      expect(INDEX).toContain(`>${k}<`);
    }
  });

  it('⚠ 四项都由真实数据填，不是静态文字', () => {
    const i = RENDERER.indexOf('function renderTopbar()');
    expect(i, '找不到 renderTopbar()').toBeGreaterThan(-1);
    const seg = RENDERER.slice(i, i + 2200);

    // 每一项都必须从 state 取值
    expect(seg, '项目应来自 state.project').toContain('state.project?.name');
    expect(seg, '当前章应来自 state.chapters').toContain('state.chapters.find');
    expect(seg, '模型应来自 state.modelConfig').toContain('state.modelConfig');
    expect(seg, 'Run 状态应来自 state.runStatus').toContain('state.runStatus');
  });

  it('⚠ 模型未配置时明确说"未配置"，不显示空的已配置值', () => {
    const i = RENDERER.indexOf('function renderTopbar()');
    const seg = RENDERER.slice(i, i + 2200);
    expect(seg).toMatch(/cfg\?\.configured\s*\?/);
    expect(seg, '未配置必须有明确文案').toContain("'未配置'");
  });

  it('⚠ Run 状态区分"运行中 / 空闲 / 不可用"三态', () => {
    const i = RENDERER.indexOf('function renderTopbar()');
    const seg = RENDERER.slice(i, i + 2200);
    expect(seg).toContain('运行中');
    expect(seg).toContain('空闲');
    expect(seg, '未配模型时 Run 不可用要说出来，不能显示"空闲"').toContain('不可用');
  });

  it('选章节时会刷新顶栏（否则「当前章」永远停在旧值）', () => {
    const i = RENDERER.indexOf("state.selectedChapterId = c.id;");
    expect(i).toBeGreaterThan(-1);
    expect(RENDERER.slice(i, i + 260), '选章节后没调 renderTopbar()').toContain('renderTopbar()');
  });

  it('boot 会渲染一次顶栏', () => {
    const i = RENDERER.indexOf('async function boot()');
    const seg = RENDERER.slice(i, i + 800);
    expect(seg).toContain('renderTopbar()');
  });

  it('⚠ 样式全部走主题令牌（浅色主题下才不会深底深字）', () => {
    const i = STYLE.indexOf('.topbar__facts {');
    expect(i).toBeGreaterThan(-1);
    const seg = STYLE.slice(i, STYLE.indexOf('.theme-toggle {'));
    const hard = seg.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hard, `顶栏样式里有硬编码颜色：${hard.join('、')}`).toHaveLength(0);
  });
});

describe('§41 / §42 时间线与伏笔：各自独立入口', () => {
  it('⚠ 左栏是两个独立导航项（不是合并成一个「设定」）', () => {
    const i = RENDERER.indexOf("nav.append(el('div', 'nav-section', '设定与账目'));");
    expect(i, '找不到「设定与账目」分组').toBeGreaterThan(-1);
    const seg = RENDERER.slice(i, i + 900);
    expect(seg).toContain("['timeline', '时间线'");
    expect(seg).toContain("['foreshadow', '伏笔'");
  });

  it('两个入口分别渲染各自视图（不是同一个组件）', () => {
    expect(RENDERER).toContain('renderTimelineView');
    expect(RENDERER).toContain('renderForeshadowView');
    expect(RENDERER).toContain("from './timeline-view.js'");
    expect(RENDERER).toContain("from './foreshadow-view.js'");
    // 两者是不同的实现文件
    expect(existsSync(R('timeline-view.js'))).toBe(true);
    expect(existsSync(R('foreshadow-view.js'))).toBe(true);
  });

  it('⚠ 两个视图都显式传 bookId（多书隔离，不靠后端回退）', () => {
    expect(TIMELINE, 'timeline.query 必须显式传 bookId').toMatch(
      /invoke\('timeline\.query',\s*\{\s*bookId:\s*state\.selectedBookId/,
    );
    expect(FORESHADOW, 'foreshadow.list 必须显式传 bookId').toMatch(
      /invoke\('foreshadow\.list',\s*\{\s*bookId:\s*state\.selectedBookId/,
    );
  });

  it('⚠ 进账目视图时清掉「当前章」（否则顶栏与中栏说的不是一件事）', () => {
    const i = RENDERER.indexOf('function renderView(render) {');
    expect(i).toBeGreaterThan(-1);
    const seg = RENDERER.slice(i, i + 700);
    expect(seg, 'renderView 应清空 selectedChapterId').toContain('state.selectedChapterId = null');
    expect(seg).toContain('renderTopbar()');
  });
});

describe('⚠ 伏笔：后端此前完全没有 IPC', () => {
  it('补上了 foreshadow.list 与 foreshadow.advance', () => {
    expect(CORE, '缺少 foreshadow.list').toContain("'foreshadow.list':");
    expect(CORE, '缺少 foreshadow.advance').toContain("'foreshadow.advance':");
  });

  it('⚠ 读列表用 requireBookId（严格版，没书就报错）', () => {
    const i = CORE.indexOf("'foreshadow.list':");
    const next = CORE.indexOf("\n  '", i + 1);
    const seg = CORE.slice(i, next === -1 ? undefined : next);
    expect(seg).toContain('requireBookId(params.bookId)');
    expect(seg, '不该用宽松版静默回退').not.toContain('resolveBookId(');
  });

  it('⚠ 推进不自己实现状态机（合法性由仓储判，避免两套规则）', () => {
    const i = CORE.indexOf("'foreshadow.advance':");
    const next = CORE.indexOf("\n  '", i + 1);
    const seg = CORE.slice(i, next === -1 ? undefined : next);
    expect(seg).toContain('repos.foreshadowing.advance');
    // 前端镜像只用于显示按钮，后端不得重复一份迁移表
    expect(seg, '后端不该自带一份迁移表').not.toMatch(/LEGAL_TRANSITIONS|NEXT\s*=/);
  });
});

describe('⚠ 伏笔视图：只显示合法目标，终态明确', () => {
  it('推进按钮只列当前状态的合法目标', () => {
    expect(FORESHADOW).toContain('const NEXT = {');
    expect(FORESHADOW).toMatch(/const allowed = NEXT\[it\.status\] \?\? \[\]/);
  });

  it('⚠ 终态不显示任何推进按钮，并说明原因', () => {
    expect(FORESHADOW).toMatch(/allowed\.length === 0/);
    expect(FORESHADOW, '终态必须明确写出不可推进').toContain('已是终态');
  });

  it('⚠ 镜像的迁移表与仓储的 LEGAL_TRANSITIONS 一致', () => {
    // 从仓储源码解析真实迁移表，与前端镜像逐条比对。
    // 镜像只用于显示按钮，但**不一致会让用户点了就被拒**（体验缺陷）。
    const repo = readSrc(join(REPO, 'packages/storage/src/repositories/foreshadowing.ts'));
    const i = repo.indexOf('const LEGAL_TRANSITIONS');
    const seg = repo.slice(i, repo.indexOf('};', i));

    const parse = (src: string) => {
      const out: Record<string, string[]> = {};
      for (const m of src.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
        out[m[1]!] = [...m[2]!.matchAll(/'(\w+)'/g)].map((x) => x[1]!);
      }
      return out;
    };
    const real = parse(seg);
    const mirror = parse(FORESHADOW.slice(FORESHADOW.indexOf('const NEXT = {'), FORESHADOW.indexOf('};', FORESHADOW.indexOf('const NEXT = {'))));

    expect(Object.keys(real).sort(), '状态集合不一致').toEqual(Object.keys(mirror).sort());
    for (const k of Object.keys(real)) {
      expect(mirror[k]!.sort(), `${k} 的合法目标不一致`).toEqual([...real[k]!].sort());
    }
  });

  it('⚠ 废弃是不可逆终态，视觉上与普通推进区分', () => {
    const i = FORESHADOW.indexOf("to === 'ABANDONED'");
    expect(i, 'ABANDONED 应有独立样式').toBeGreaterThan(-1);
    expect(FORESHADOW.slice(i, i + 120)).toContain('btn--danger-soft');
  });

  it('⚠ 非法推进的错误原样显示（它带合法目标列表，是用户唯一的解释）', () => {
    const i = FORESHADOW.indexOf('async function advance(');
    const seg = FORESHADOW.slice(i, i + 900);
    expect(seg).toContain('r.error.message');
  });

  it('⚠ 读取失败不显示"还没有伏笔"（那是两件事）', () => {
    // ⚠ 必须取 load() 里那个 if (!r.ok) —— advance() 里也有一个，
    //   用 indexOf 会拿到前者，断言查错了分支（本测试第一版就这么错）。
    const loadIdx = FORESHADOW.indexOf('async function load()');
    expect(loadIdx).toBeGreaterThan(-1);
    const i = FORESHADOW.indexOf('if (!r.ok)', loadIdx);
    expect(i).toBeGreaterThan(loadIdx);
    expect(FORESHADOW.slice(i, i + 200)).toContain('callout--err');
    // "还没有伏笔" 只在确认读取成功后出现
    const emptyIdx = FORESHADOW.indexOf('这本书还没有伏笔记录');
    expect(emptyIdx, '"还没有伏笔"必须在读取成功之后').toBeGreaterThan(i);
  });
});

/**
 * ⚠ 时间线视图的**行为**断言（最小 DOM 替身）。
 *
 * 之前只 grep 源码里有没有 '可比较' 这个词 —— 反向验证时把整行显示删掉，
 * 测试**仍然通过**（那个词在注释与另一处提示里也出现）。
 * 假绿。改成真的渲染一遍、读输出。
 */
interface TEl {
  tag: string; className: string; textContent: string;
  children: TEl[]; attrs: Record<string, string>;
  append(...n: TEl[]): void; replaceChildren(...n: TEl[]): void;
  setAttribute(k: string, v: string): void;
  addEventListener(): void;
}
function tEl(tag: string, cls?: string, text?: string): TEl {
  const n: TEl = {
    tag, className: cls ?? '', textContent: text ?? '', children: [], attrs: {},
    append(...k: TEl[]) { n.children.push(...k); },
    replaceChildren(...k: TEl[]) { n.children = [...k]; },
    setAttribute(k: string, v: string) { n.attrs[k] = v; },
    addEventListener() { /* 本测试不点击 */ },
  };
  return n;
}
function flat(n: TEl): TEl[] { return [n, ...n.children.flatMap(flat)]; }

/** 渲染时间线视图并返回全部可见文本 */
async function renderTimeline(data: unknown, ok = true): Promise<string> {
  const { renderTimelineView } = await import(
    join(REPO, 'apps/desktop/src/renderer/timeline-view.js')
  );
  const box = renderTimelineView({
    el: tEl,
    invoke: async () => (ok ? { ok: true, data } : { ok: false, error: { message: '读取失败' } }),
    state: { selectedBookId: 'book_a' },
  });
  await new Promise((r) => setTimeout(r, 0));
  return flat(box as unknown as TEl).map((n) => n.textContent).join(' ');
}

describe('⚠ 时间线视图：必须区分"事件数"与"可比较数"', () => {
  const base = {
    bookId: 'book_a', count: 5, comparableCount: 3,
    blockingCount: 0, warningCount: 0, issues: [], limitations: [],
    events: [
      { id: 'e1', chapter: 1, title: 'A', storyDisplay: '第一天', storyHours: 0, dayUnknown: false, characters: [], location: null, narrativeMode: null },
      { id: 'e2', chapter: 2, title: 'B', storyDisplay: null, storyHours: null, dayUnknown: true, characters: [], location: null, narrativeMode: null },
    ],
  };

  it('⚠ 渲染出「事件总数」与「可比较」两个数（真渲染，非 grep）', async () => {
    const text = await renderTimeline(base);
    expect(text, '缺少事件总数').toContain('事件总数');
    expect(text, '缺少可比较数').toContain('可比较');
    expect(text, '可比较的**值**必须真的渲染出来').toContain('3');
  });

  it('⚠ 可比较数缺失时显示"未检查"，不显示 0', async () => {
    const text = await renderTimeline({ ...base, comparableCount: null });
    expect(text).toContain('未检查');
  });

  it('⚠ 有不可比较事件时必须提示"没问题 != 顺序都对"', async () => {
    const text = await renderTimeline(base);
    expect(text, '5 个事件只有 3 个可比较，必须提示').toContain('未参与');
    expect(text, '必须说清"没问题"不等于"顺序都对"').toContain('不等于');
  });

  it('⚠ 全部可比较时不出现该提示（避免无谓噪声）', async () => {
    const text = await renderTimeline({ ...base, comparableCount: 5 });
    expect(text).not.toContain('未参与');
  });

  it('⚠ dayUnknown 的事件在列表里标出"无明确日锚点"', async () => {
    const text = await renderTimeline(base);
    expect(text).toContain('无明确日锚点');
  });

  it('⚠ 渲染失败时明确报错，且不出现"暂无事件"', async () => {
    const text = await renderTimeline(null, false);
    expect(text).toContain('读取失败');
    expect(text, '失败时不能显示"还没有事件"——那是两件事').not.toContain('还没有时间线事件');
  });

  it('⚠ 确认读取成功且真的没有事件时，才显示"还没有"', async () => {
    const text = await renderTimeline({ ...base, count: 0, comparableCount: 0, events: [] });
    expect(text).toContain('还没有时间线事件');
  });

  it('⚠ 有不可比较事件时明确提示"没问题 != 顺序都对"', () => {
    expect(TIMELINE).toMatch(/comparableCount\s*<\s*d\.count/);
    expect(TIMELINE, '必须说清未参与检查的含义').toContain('不等于');
  });

  it('⚠ 无明确日锚点的事件在列表里标出', () => {
    expect(TIMELINE).toContain('dayUnknown');
    expect(TIMELINE).toContain('grid__warn');
  });

  it('⚠ 读取失败不显示"暂无事件"（那是两件事）', () => {
    const loadIdx = TIMELINE.indexOf('async function load()');
    expect(loadIdx).toBeGreaterThan(-1);
    const i = TIMELINE.indexOf('if (!r.ok)', loadIdx);
    expect(i).toBeGreaterThan(loadIdx);
    expect(TIMELINE.slice(i, i + 200)).toContain('callout--err');
    expect(TIMELINE.indexOf('这本书还没有时间线事件')).toBeGreaterThan(i);
  });

  it('显示后端如实报告的能力边界（limitations）', () => {
    expect(TIMELINE).toContain('limitations');
  });
});

/**
 * ⚠⚠ 最重要的一组：新视图用到的 CSS 类必须真的存在。
 *
 * 浏览器对未定义的 class **静默忽略** —— 元素照常渲染，只是没有样式。
 * 之前 `.btn--danger`（危险按钮与普通按钮长得一样）就是这么漏掉的。
 */
describe('⚠ 新视图引用的 CSS 类必须存在', () => {
  /** 从 JS 里抽字面量 class 字符串（模板拼接的动态部分无法静态检查） */
  function literalClasses(src: string): string[] {
    const out = new Set<string>();
    for (const m of src.matchAll(/el\(\s*'[a-z]+'\s*,\s*'([^']+)'/g)) {
      for (const c of m[1]!.split(/\s+/)) if (c && !c.includes('$')) out.add(c);
    }
    // 'tag tag--' + x 这类：取固定的前缀部分
    for (const m of src.matchAll(/'([a-z][a-z0-9_-]*\s+[a-z][a-z0-9_-]*--)'\s*\+/g)) {
      for (const c of m[1]!.split(/\s+/)) if (c && !c.endsWith('--')) out.add(c);
    }
    return [...out];
  }

  const files: [string, string][] = [
    ['timeline-view.js', TIMELINE],
    ['foreshadow-view.js', FORESHADOW],
  ];

  for (const [name, src] of files) {
    it(`${name} 引用的类都有定义`, () => {
      const used = literalClasses(src);
      const missing = used.filter((c) => !STYLE.includes('.' + c));
      expect(missing, `${name} 用了未定义的 CSS 类：${missing.join('、')}`).toHaveLength(0);
    });
  }

  it('⚠ 本轮新增的四个类已补上（此前缺失）', () => {
    for (const c of ['callout--warn', 'tag--info', 'tag--ok', 'tag--muted', 'issue-list']) {
      expect(STYLE, `缺少 .${c}`).toContain('.' + c);
    }
  });

  it('⚠ 新样式无硬编码颜色（浅色主题下会深底深字）', () => {
    const i = STYLE.indexOf('.view {');
    expect(i).toBeGreaterThan(-1);
    const seg = STYLE.slice(i, STYLE.indexOf('.topbar__facts {'));
    const hard = seg.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hard, `硬编码颜色：${hard.join('、')}`).toHaveLength(0);
  });
});

/**
 * ⚠⚠ 右栏面板的**可见性**回归防护
 *
 * 真实反馈：模型配置 UI 不见了。
 * 根因：STEP 22 把右栏按使用频率分成 4 组后，模型设置被放进了
 * 「系统诊断」组，而该组**默认折叠** —— 面板在 DOM 里，但用户看不见。
 * 而当时的 GUI 断言只查 `!!modelForm`（元素存在），折叠组里的元素
 * 照样存在，所以断言一直通过、缺陷一直存在。
 *
 * 教训：**"在 DOM 里" != "用户看得见"**。
 * 这类缺陷浏览器不报错、断言不失败，只能靠显式查可见性。
 */
describe('⚠⚠ 右栏面板必须对用户可见（折叠组里的不算）', () => {
  /** 解析 panelGroup 调用与紧随其后的 append，得出"哪个面板在哪个组" */
  function groupsOf(src: string) {
    const defs: Record<string, boolean> = {};
    for (const m of src.matchAll(/const (g\d+) = panelGroup\('([^']+)',\s*(true|false)\)/g)) {
      defs[m[1]!] = m[3] === 'true';
      defs['name:' + m[1]!] = false as unknown as boolean;
    }
    const names: Record<string, string> = {};
    for (const m of src.matchAll(/const (g\d+) = panelGroup\('([^']+)'/g)) names[m[1]!] = m[2]!;
    return { defs, names };
  }

  const i = RENDERER.indexOf('function renderAgent()');
  const seg = RENDERER.slice(i, RENDERER.indexOf('async function boot()'));

  it('模型设置面板必须放在**默认展开**的组里', () => {
    const { defs, names } = groupsOf(seg);
    // 找到 g0.append(renderModelSettings()) 里的组变量
    const m = seg.match(/(g\d+)\.append\(renderModelSettings\(\)\)/);
    expect(m, '找不到 renderModelSettings 被 append 到哪个组').not.toBeNull();
    const g = m![1]!;
    expect(
      defs[g],
      `模型设置被放进「${names[g]}」组，而该组默认折叠 —— 用户看不见（真实事故）`,
    ).toBe(true);
  });

  it('⚠ 默认展开的组恰好是「模型」与「写作流程」', () => {
    const open: string[] = [];
    for (const m of seg.matchAll(/const g\d+ = panelGroup\('([^']+)',\s*(true|false)\)/g)) {
      if (m[2] === 'true') open.push(m[1]!);
    }
    expect(open.sort()).toEqual(['写作流程', '模型'].sort());
  });

  it('⚠ 诊断类组保持默认折叠（减少视觉噪声）', () => {
    for (const name of ['系统诊断', '检索与上下文', '质量与记忆']) {
      const m = seg.match(new RegExp(`panelGroup\\('${name}',\\s*(true|false)\\)`));
      expect(m, `找不到「${name}」组`).not.toBeNull();
      expect(m![1], `「${name}」应默认折叠`).toBe('false');
    }
  });

  it('⚠ GUI 断言必须查可见性，不能只查 DOM 存在', () => {
    const main = readSrc(join(REPO, 'apps/desktop/src/main/main.ts'));
    expect(
      main,
      '缺少"模型设置面板对用户可见"的断言 —— 只查 DOM 存在会让折叠缺陷漏过',
    ).toContain('closest(\'details:not([open])\')');
  });
});
