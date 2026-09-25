/**
 * 偏好持久化（主题 / 上次在写的书）—— 源码级 + 行为级双重约束
 *
 * ## 为什么需要这个测试
 *
 * "记住当前书"这件事**没有报错路径**：记住失败时，作者只会觉得
 * "每次开软件都要重新切一次书"，而不会认为这是个 bug。
 * 同理主题不落盘也只是"每次都要重切"。
 *
 * 这类**静默失效**的偏好逻辑必须钉住，否则改 renderer 时很容易
 * 顺手把它删掉（看起来像无用代码）。
 *
 * ## 为什么不只写 GUI 断言
 *
 * `verify:flow` 的 GUI 断言能证明"写进了 prefs.json"（端到端真实），
 * 但它在**同一次会话内**建书 → `books[0]` 与 remembered 恰好相同，
 * 覆盖不到"重启后按记忆恢复"这条分支。
 *
 * 所以这里补两条：
 *   1. **行为级**：真实读写 prefs 文件（不依赖 Electron）
 *   2. **源码级**：锁住 boot 的读取顺序与选书优先级（防回退）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const RENDERER = join(REPO, 'apps/desktop/src/renderer/renderer.js');
const CORE = join(REPO, 'apps/desktop/src/main/core-process.ts');

/** 读源码并去掉 CRLF —— 本仓混用行尾，正则匹配前必须归一 */
function readSrc(p: string): string {
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

describe('偏好文件：读写与合并', () => {
  let dir: string;
  let prefsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nwa-prefs-'));
    prefsPath = join(dir, 'prefs.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('写入后能读回（模拟主进程的 savePrefs/loadPrefs 语义）', () => {
    // 与 core-process.ts 的 savePrefs 同一语义：合并 + 剔除 undefined
    const load = (): Record<string, unknown> => {
      if (!existsSync(prefsPath)) return {};
      return JSON.parse(readFileSync(prefsPath, 'utf8')) as Record<string, unknown>;
    };
    const save = (patch: Record<string, unknown>) => {
      // 与 core-process.ts 的 savePrefs 同一语义：
      // ⚠ 逐键合并，undefined = "不改动"，**不是**"删除"
      const merged = { ...load() };
      for (const k of Object.keys(patch)) {
        if (patch[k] !== undefined) merged[k] = patch[k];
      }
      writeFileSync(prefsPath, JSON.stringify(merged, null, 2), 'utf8');
      return merged;
    };

    save({ theme: 'light' });
    expect(load().theme).toBe('light');

    // ⚠ 关键：写 lastBookId 不能把 theme 冲掉
    save({ lastBookId: 'book_b' });
    expect(load().theme).toBe('light');
    expect(load().lastBookId).toBe('book_b');

    // ⚠ undefined 必须被剔除，而不是写成 "key": null 覆盖旧值
    save({ lastBookId: undefined });
    expect(load().lastBookId).toBe('book_b');
  });
});

describe('⚠ 源码级约束：偏好的读取顺序与选书优先级', () => {
  const src = readSrc(RENDERER);

  it('boot 在打开项目之前就读偏好（主题不该等数据加载完才生效）', () => {
    const bootIdx = src.indexOf('async function boot()');
    expect(bootIdx, 'renderer.js 里找不到 boot()').toBeGreaterThan(-1);
    const bootBody = src.slice(bootIdx, bootIdx + 700);

    const prefsIdx = bootBody.indexOf('await loadPrefs()');
    const openIdx = bootBody.indexOf("call('project.open'");

    expect(prefsIdx, 'boot 里没有调用 loadPrefs()').toBeGreaterThan(-1);
    expect(openIdx, 'boot 里没有调用 project.open').toBeGreaterThan(-1);
    expect(
      prefsIdx,
      '⚠ loadPrefs() 必须在 project.open **之前** —— 否则启动瞬间会闪一下默认主题',
    ).toBeLessThan(openIdx);
  });

  it('选书优先用"上次在写的那本"，再退回第一本', () => {
    const i = src.indexOf('const remembered = state.prefs?.lastBookId;');
    expect(i, '找不到"优先恢复上次在写的书"的逻辑（可能被删掉了）').toBeGreaterThan(-1);

    const seg = src.slice(i, i + 400);
    // ⚠ 顺序必须是 rememberedOk 优先 —— 反了就退化成"永远选最老那本"
    expect(seg).toMatch(/rememberedOk\s*\?\s*remembered\s*:\s*state\.books\[0\]/);
  });

  it('切换书目时会记住（否则记忆永远是旧的）', () => {
    const i = src.indexOf("item.addEventListener('click', async () => {");
    expect(i).toBeGreaterThan(-1);
    const seg = src.slice(i, i + 400);
    expect(seg, '点选书目时没有调用 rememberBook()').toContain('rememberBook(b.id)');
  });

  it('主题切换会落盘（只改 DOM 不落盘 = 重开就丢）', () => {
    const i = src.indexOf('async function setTheme(');
    expect(i, '找不到 setTheme()').toBeGreaterThan(-1);
    const seg = src.slice(i, i + 300);
    expect(seg, 'setTheme() 没有写 prefs').toMatch(/call\('prefs\.set'/);
  });

  it('主进程提供 prefs.get / prefs.set 两个通道', () => {
    const core = readSrc(CORE);
    expect(core).toContain("'prefs.get':");
    expect(core).toContain("'prefs.set':");
    // ⚠ 偏好必须能在项目打开前读取 —— 否则主题要等项目加载完才生效
    const getIdx = core.indexOf("'prefs.get':");
    const getSeg = core.slice(getIdx, getIdx + 120);
    expect(getSeg, 'prefs.get 不该依赖已打开的项目').not.toContain('requireProject()');
  });

  it('⚠ 偏好不存密钥（只存主题与书 id）', () => {
    const core = readSrc(CORE);
    const i = core.indexOf('interface AppPrefs');
    const seg = core.slice(i, i + 400);
    expect(seg).not.toMatch(/apiKey|secret|password|token/i);
  });
});
