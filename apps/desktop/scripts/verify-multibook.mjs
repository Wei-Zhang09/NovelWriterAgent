/**
 * ⚠ 多书隔离端到端验证（真实 Electron + 真实 IPC）
 *
 *   pnpm verify:multibook
 *
 * ## 为什么需要这个脚本
 *
 * 单测（multi-book-isolation.test.ts）验证的是**表结构**与**源码约束**，
 * 但真实事故是**运行时行为**：所有写操作取 `books.listByProject(pid)[0]`，
 * 而它按 `created_at` 排序，`[0]` 是**最老的那本**。
 *
 * 后果（用户项目里出现 24 本同名「测试小说」）：
 *   - 「新建章节」永远加到旧书上 → 用户看不到变化 → 再建一本
 *   - Planner/Writer 装配上下文时取最老那本的 facts/摘要
 *     → **A 书的设定污染 B 书的正文**
 *
 * 用户要求：「允许同时多本书创作，但书与书之间要做好隔离，
 * 不能出现相互污染的情况」。
 *
 * 因此必须端到端验证：**给 B 书写一章，A 书完全不受影响**。
 *
 * @verify-kind: standalone — 多书隔离验收，走真实 IPC，需 NWA_PROJECTS_ROOT 隔离
 */
import { app, utilityProcess } from 'electron';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const coreEntry = join(appRoot, 'dist', 'main', 'core-process.js');

// ⚠ 完全隔离：绝不碰用户的真实项目目录
const ISOLATED_ROOT = join(app.getPath('temp'), 'nwa-verify-multibook');
if (existsSync(ISOLATED_ROOT)) rmSync(ISOLATED_ROOT, { recursive: true, force: true });
mkdirSync(ISOLATED_ROOT, { recursive: true });
process.env['NWA_PROJECTS_ROOT'] = ISOLATED_ROOT;

const steps = [];
const rec = (name, ok, detail) => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

let child = null;
let seq = 0;
const pending = new Map();

function call(method, params = {}, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const requestId = `r${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ ok: false, error: { code: 'TIMEOUT', message: `${method} 超时` } });
    }, timeoutMs);
    pending.set(requestId, { resolve, timer });
    child.postMessage({ kind: 'request', requestId, method, params });
  });
}

/** 工具调用（章节 CRUD 走 tool.invoke，没有 chapter.* IPC） */
function tool(name, input, permission = 'READ') {
  return call('tool.invoke', { name, input, permission });
}

function startCore() {
  return new Promise((resolve, reject) => {
    child = utilityProcess.fork(coreEntry, [], { stdio: 'pipe' });
    child.stdout?.on('data', (d) => process.stdout.write(`[core] ${d}`));
    child.stderr?.on('data', (d) => process.stderr.write(`[core] ${d}`));
    child.on('message', (msg) => {
      if (msg?.kind === 'response') {
        const p = pending.get(msg.requestId);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(msg.requestId);
          p.resolve(msg.payload ?? msg);
        }
        return;
      }
      // 本验证不涉及模型调用，故不需要加解密；礼貌拒绝以免 core 卡住
      if (msg?.kind === 'crypto-request') {
        child.postMessage({
          kind: 'crypto-response',
          requestId: msg.requestId,
          ok: false,
          error: 'verify:multibook 不需要密钥（只验证隔离，不调模型）',
        });
      }
    });
    child.on('spawn', () => setTimeout(resolve, 1500));
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`core 退出码 ${code}`));
    });
  });
}

app.on('window-all-closed', () => {});
app.setName('@nwa/desktop');

app.whenReady().then(async () => {
  try {
    await startCore();
    rec('core 进程已启动', true);

    // 打开项目（在隔离目录里建库）
    const open = await call('project.open', { rootDir: ISOLATED_ROOT });
    if (!open.ok) {
      rec('打开项目', false, `${open.error?.code}：${open.error?.message}`);
      return finish();
    }
    rec('打开项目', true, ISOLATED_ROOT);

    // 隔离目录是全新的 → 先建项目（真实使用时由 UI 的「新建项目」触发）
    let pl = await call('project.info', {});
    let projectId = pl.data?.projects?.[0]?.id;
    if (!projectId) {
      const created = await tool(
        'project.create',
        { name: '隔离验证项目', genre: '悬疑' },
        'WRITE',
      );
      if (!created.ok) {
        rec('创建项目', false, String(created.error?.message ?? '').slice(0, 100));
        return finish();
      }
      pl = await call('project.info', {});
      projectId = pl.data?.projects?.[0]?.id;
    }
    if (!projectId) {
      rec('取得 projectId', false, JSON.stringify(pl).slice(0, 200));
      return finish();
    }
    rec('取得 projectId', true, String(projectId).slice(0, 20));

    // ── 建两本书：A 先建（更老），B 后建 ──
    const a = await call('book.create', { projectId, title: '隔离测试-A书' });
    const b = await call('book.create', { projectId, title: '隔离测试-B书' });
    if (!a.ok || !b.ok) {
      rec('创建两本书', false, `${a.error?.message ?? ''} ${b.error?.message ?? ''}`);
      return finish();
    }
    const bookA = a.data.id;
    const bookB = b.data.id;
    rec('创建两本书', true, `A=${String(bookA).slice(0, 16)} B=${String(bookB).slice(0, 16)}`);

    // ⚠ 关键前提：A 比 B 老，"取第一本"会落到 A 上（正是事故形态）
    const list = await call('book.list', { projectId });
    const ordered = list.data?.books ?? [];
    rec(
      '⚠ A 比 B 老（"取第一本"会落到 A 上，正是事故形态）',
      ordered[0]?.id === bookA,
      ordered.map((x) => x.title).join(' → '),
    );

    // ── 给 A 书建 3 章，给 B 书建 1 章 ──
    for (let n = 1; n <= 3; n++) {
      await tool('chapter.create', { bookId: bookA, chapterNumber: n }, 'WRITE');
    }
    const bCh = await tool('chapter.create', { bookId: bookB, chapterNumber: 1 }, 'WRITE');
    rec(
      '给 B 书建章节',
      bCh.ok === true,
      bCh.ok ? `第 ${bCh.data?.chapterNumber} 章` : String(bCh.error?.message ?? '').slice(0, 80),
    );

    // ── 断言 1：各自章节数正确 ──
    const aCount = ((await tool('chapter.list', { bookId: bookA })).data?.chapters ?? []).length;
    const bCount = ((await tool('chapter.list', { bookId: bookB })).data?.chapters ?? []).length;
    rec('A 书章节数正确', aCount === 3, `A=${aCount}（应为 3）`);
    rec('B 书章节数正确', bCount === 1, `B=${bCount}（应为 1）`);

    // ── 断言 2：⚠ 写 B 书时绝不落到 A 书 ──
    const before = ((await tool('chapter.list', { bookId: bookA })).data?.chapters ?? []).length;
    await tool('chapter.create', { bookId: bookB, chapterNumber: 2 }, 'WRITE');
    const after = ((await tool('chapter.list', { bookId: bookA })).data?.chapters ?? []).length;
    rec('⚠ 给 B 书建章后 A 书章节数不变（无跨书写入）', before === after, `A 书 ${before} → ${after}`);
    const bNow = ((await tool('chapter.list', { bookId: bookB })).data?.chapters ?? []).length;
    rec('新章节确实进了 B 书', bNow === 2, `B=${bNow}（应为 2）`);

    // ── 断言 3：⚠ 传不存在的 bookId 必须报错，不得静默回退到别的书 ──
    const bogus = await call('canon.list', { bookId: 'book_不存在的' });
    rec(
      '⚠ 传入不存在的 bookId 时报错（不静默落到别的书上）',
      bogus.ok === false,
      bogus.ok ? '未报错 —— 会把操作指向别的书！' : String(bogus.error?.message ?? '').slice(0, 70),
    );

    // ── 断言 4：⚠ canon.list 按书返回 ──
    const canonA = await call('canon.list', { bookId: bookA });
    const canonB = await call('canon.list', { bookId: bookB });
    rec(
      '⚠ canon.list 按书返回（各自独立）',
      canonA.ok && canonB.ok,
      `A=${(canonA.data?.canon ?? []).length} 条 B=${(canonB.data?.canon ?? []).length} 条`,
    );

    // ── 断言 5：⚠ summary.pending 按书返回 ──
    const pendA = await call('summary.pending', { bookId: bookA });
    const pendB = await call('summary.pending', { bookId: bookB });
    rec(
      '⚠ summary.pending 按书返回',
      pendA.ok && pendB.ok,
      `A=${(pendA.data?.pending ?? []).length} B=${(pendB.data?.pending ?? []).length}`,
    );

    // ── 断言 6：⚠ 检索按书隔离 ──
    const sB = await call('search.query', { query: '隔离测试', limit: 10, bookId: bookB });
    const leak = (sB.data?.chapters ?? []).some((x) =>
      String(x.sourceRef ?? '').includes('A书'),
    );
    rec('⚠ 检索 B 书不返回 A 书内容（无跨书串味）', sB.ok === true && !leak, '');
  } catch (e) {
    rec('验证脚本异常', false, e instanceof Error ? e.message : String(e));
  }
  finish();
});

function finish() {
  const passed = steps.filter((s) => s.ok).length;
  const failed = steps.filter((s) => !s.ok);
  console.log(`\n──── 结果 ────`);
  console.log(`${passed}/${steps.length} 通过`);
  if (failed.length > 0) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`);
  }
  try {
    child?.kill();
  } catch {
    /* ignore */
  }
  // ⚠ 子进程持有 SQLite 文件句柄，立刻删会失败（Windows 文件锁）——
  //   等它真正退出再清理；删不掉也不影响结果（Temp 目录会被系统清理）
  setTimeout(() => {
    try {
      rmSync(ISOLATED_ROOT, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    app.exit(failed.length === 0 ? 0 : 1);
  }, 800);
}
