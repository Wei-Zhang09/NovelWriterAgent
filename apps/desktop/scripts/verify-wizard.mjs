/**
 * 开书向导「走完就能开写」端到端验证（C1）
 *
 *   pnpm verify:wizard
 *
 * ## 为什么必须是这个脚本（而不是单元测试）
 *
 * 2026-09-26 用户实测的失败**不在单元测试能覆盖的层**：
 *   走完向导 → 点「运行完整工作流」→ plan 被 `SETTINGS_NOT_CONFIRMED` 拦死。
 * 根因是 `blueprint.confirmAll` 这个 **IPC handler** 只管向导那四步，
 * 不管设定门禁 —— 而 `world_entities` 已被向导步骤②写入，
 * 于是设定门禁立刻变成 `NEVER_CONFIRMED`。
 *
 * 单元测试测的是 `confirmBookSettings` / `confirmBookBlueprint` 两个函数
 * 各自正确，**测不到"IPC handler 有没有把它们串起来"**。
 * 这正是本仓反复踩的形态：「能力齐全、链路断裂」。
 *
 * 所以本脚本通过 utilityProcess 起**真实的 core 进程**，走**真实的 IPC**：
 *   ① 建书 → ② 物化设定 → ③ blueprint.confirmAll →
 *   ④ 断言 settings.status 放行 → ⑤ 断言 workflow.start 能真的开起来
 *
 * ## 不需要模型
 *
 * 全流程只碰门禁与工作流启动，不调 LLM —— 所以归 `standalone`，
 * 每次验收都能跑（不必等模型）。「真的能写出正文」由 `verify:chain` 覆盖。
 *
 * @verify-kind: standalone — 只验证门禁/链路，不调模型
 */
import { app, utilityProcess } from 'electron';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const coreEntry = join(appRoot, 'dist', 'main', 'core-process.js');

// ⚠ 隔离目录：绝不能在用户真实项目目录（~/NovelWriterProjects）里跑 ——
//   那会往他正在写的书里塞测试数据。
//   两条防线，缺一不可：
//     ① 环境变量 —— core-process 的 PROJECTS_ROOT 在**模块加载时**读它
//     ② project.open({ rootDir }) —— 显式指定本次要打开的目录
//   只做 ② 时，若 core 已经打开了默认目录，仍会碰到真实库。
const ISOLATED_ROOT = join(app.getPath('temp'), `nwa-verify-wizard-${process.pid}`);
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

function call(method, params = {}) {
  const requestId = `req-${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`IPC 超时：${method}`));
    }, 60_000);
    pending.set(requestId, { resolve, reject, timer });
    child.postMessage({ kind: 'request', requestId, method, params });
  });
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
      // 本验证不调模型 → 礼貌拒绝加解密请求，避免 core 卡住等待
      if (msg?.kind === 'crypto-request') {
        child.postMessage({
          kind: 'crypto-response',
          requestId: msg.requestId,
          ok: false,
          error: 'verify:wizard 不需要密钥（只验证门禁链路，不调模型）',
        });
      }
    });
    child.on('spawn', () => setTimeout(resolve, 1500));
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`core 退出码 ${code}`));
    });
  });
}

function finish() {
  const failed = steps.filter((s) => !s.ok);
  console.log('');
  console.log('─'.repeat(60));
  console.log(`共 ${steps.length} 项，通过 ${steps.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  }
  // ⚠ 先杀 core、**等它真的退出**再删目录。
  //
  //   踩过：直接 `child.kill()` 紧接 `rmSync` —— kill 是异步的，
  //   core 还持有 project.db 的文件锁，rmSync 抛 EPERM 被 catch 吞掉，
  //   于是每次运行都在 %TEMP% 留下一个隔离目录（实测累积 6 个）。
  //   "catch 掉就算了"正是这类泄漏看不见的原因。
  const cleanup = () => {
    try {
      rmSync(ISOLATED_ROOT, { recursive: true, force: true });
    } catch (e) {
      // 删不掉要**说出来** —— 静默吞掉会让泄漏永远无人发现
      console.error(`⚠ 隔离目录未能删除（${e?.code ?? e}）：${ISOLATED_ROOT}`);
    }
    app.exit(failed.length ? 1 : 0);
  };

  if (!child) {
    cleanup();
    return;
  }
  // 已退出就立即清；否则等 exit 事件（带超时兜底，不让脚本挂死）
  if (child.exitCode !== undefined || child.killed) {
    cleanup();
    return;
  }
  const guard = setTimeout(() => {
    console.error('⚠ core 进程未在 5s 内退出，仍尝试清理');
    cleanup();
  }, 5000);
  child.once('exit', () => {
    clearTimeout(guard);
    cleanup();
  });
  try {
    child.kill();
  } catch {
    clearTimeout(guard);
    cleanup();
  }
}

app.on('window-all-closed', () => {});
app.setName('@nwa/desktop');

app.whenReady().then(async () => {
  try {
    await startCore();
    rec('core 进程已启动', true);

    const open = await call('project.open', { rootDir: ISOLATED_ROOT });
    if (!open.ok) {
      rec('打开隔离项目', false, `${open.error?.code}：${open.error?.message}`);
      return finish();
    }
    rec('打开隔离项目', true, ISOLATED_ROOT);

    // 全新目录 → 先建项目
    let pl = await call('project.info', {});
    let projectId = pl.data?.projects?.[0]?.id;
    if (!projectId) {
      const created = await call('tool.invoke', {
        name: 'project.create',
        input: { name: '向导验证项目', genre: '都市' },
        permission: 'WRITE',
      });
      if (!created.ok) {
        rec('创建项目', false, String(created.error?.message ?? '').slice(0, 120));
        return finish();
      }
      pl = await call('project.info', {});
      projectId = pl.data?.projects?.[0]?.id;
    }
    if (!projectId) {
      rec('取得 projectId', false, JSON.stringify(pl).slice(0, 200));
      return finish();
    }
    rec('取得 projectId', true, String(projectId).slice(0, 24));

    // ── 建一本书 ─────────────────────────────────────────────
    const a = await call('book.create', { projectId, title: '向导验证-书A' });
    if (!a.ok) {
      rec('创建书目', false, `${a.error?.code}：${a.error?.message}`);
      return finish();
    }
    const bookId = a.data.id;
    rec('创建书目', true, String(bookId).slice(0, 24));

    // ⚠ 建书后必须能读回字数目标字段（UI 面板靠它回显）。
    //   不返回时面板永远显示空值，作者以为没保存成功。
    const list = await call('book.list', { projectId });
    const row = (list.data?.books ?? []).find((b) => b.id === bookId);
    rec(
      'book.list 返回字数目标字段（UI 回显依赖它）',
      row !== undefined && 'targetWordsPerChapter' in row && 'wordCountTolerancePct' in row,
      row ? `target=${row.targetWordsPerChapter} tol=${row.wordCountTolerancePct}` : '找不到刚建的书',
    );

    // ── 字数设定：写进去 → 读回来 ────────────────────────────
    const setWt = await call('book.setWordTarget', {
      bookId,
      targetWords: 2500,
      tolerancePct: 30,
    });
    rec(
      '设置每章字数（book.setWordTarget）',
      setWt.ok && setWt.data?.targetWords === 2500 && setWt.data?.tolerancePct === 30,
      setWt.ok ? `targetWords=${setWt.data.targetWords} tol=${setWt.data.tolerancePct}` : String(setWt.error?.message),
    );

    const list2 = await call('book.list', { projectId });
    const row2 = (list2.data?.books ?? []).find((b) => b.id === bookId);
    rec(
      '⚠ 字数设定真的落库（重新 list 读回，不是读返回值）',
      row2?.targetWordsPerChapter === 2500 && row2?.wordCountTolerancePct === 30,
      `读回 target=${row2?.targetWordsPerChapter} tol=${row2?.wordCountTolerancePct}`,
    );

    // ── 物化设定：模拟向导步骤②把设定写进正式表 ──────────────
    // 走真实的 tool（与向导同一条写入路径）
    const mk = await call('tool.invoke', {
      name: 'world.create',
      input: { bookId, type: 'WORLD_RULE', name: '灵力枯竭', description: '灵气逐年稀薄' },
      permission: 'WRITE',
    });
    const mk2 = await call('tool.invoke', {
      name: 'world.create',
      // ⚠ type 必须是 WORLD_TYPES 之一（CHARACTER **不是**世界设定类型，
      //   角色在 characters 表里，不参与设定门禁的指纹）。
      input: { bookId, type: 'LOCATION', name: '青石镇', description: '主角出生地' },
      permission: 'WRITE',
    });
    rec(
      '向导步骤②物化设定（world.create ×2）',
      mk.ok && mk2.ok,
      `WORLD_RULE=${mk.ok ? 'ok' : JSON.stringify(mk.error)} | LOCATION=${mk2.ok ? 'ok' : JSON.stringify(mk2.error)}`,
    );

    // ── ⚠⚠ 核心断言 ①：只做向导确认时，设定门禁**仍拦** ──────
    //   这是缺陷的复现面：确认前 settings.status 必须是拦住的。
    const before = await call('settings.status', { bookId });
    rec(
      '⚠ 确认前：settings.status 报告拦住（门禁在工作）',
      before.ok && before.data?.allowed === false && before.data?.reason === 'NEVER_CONFIRMED',
      before.ok ? `allowed=${before.data.allowed} reason=${before.data.reason}` : String(before.error?.message),
    );

    // ── ⚠⚠ 核心断言 ②：blueprint.confirmAll **一次**关掉两道门禁 ──
    //   这正是用户决策①的落点，也是本次修复的主体。
    const confirm = await call('blueprint.confirmAll', { bookId });
    rec(
      '⚠⚠ blueprint.confirmAll 执行成功',
      confirm.ok && confirm.data?.confirmed === true,
      confirm.ok ? `steps=${confirm.data.steps}` : String(confirm.error?.message ?? '').slice(0, 140),
    );
    rec(
      '⚠⚠⚠ confirmAll 的返回值里带**设定**确认结果（UI 要显示它）',
      confirm.ok && confirm.data?.settings?.confirmed === true && confirm.data.settings.count === 2,
      confirm.ok ? JSON.stringify(confirm.data.settings) : '—',
    );

    // ── ⚠⚠ 核心断言 ③：读库确认设定门禁真的放行了 ────────────
    //   读的是 settings.status（真实 IPC），不是 confirmAll 的返回值 ——
    //   否则 handler 返回 true 而库没写也会绿。
    const after = await call('settings.status', { bookId });
    rec(
      '⚠⚠⚠ 确认后：settings.status 放行（读 IPC，不是读返回值）',
      after.ok && after.data?.allowed === true,
      after.ok ? `allowed=${after.data.allowed} reason=${after.data.reason} entries=${after.data.entryCount}` : String(after.error?.message),
    );
    rec(
      '⚠ 设定指纹真的写进库（confirmedHash 非空）',
      after.ok && after.data?.confirmedAt !== null && after.data?.confirmedAt !== undefined,
      after.ok ? `confirmedAt=${after.data.confirmedAt}` : '—',
    );

    // ── ⚠⚠ 核心断言 ④：向导门禁也放行 ───────────────────────
    const bp = await call('blueprint.status', { bookId });
    rec(
      '⚠ 向导门禁也放行（两道门禁一次确认）',
      bp.ok && bp.data?.allowed === true,
      bp.ok ? `allowed=${bp.data.allowed} confirmedAt=${bp.data.confirmedAt}` : String(bp.error?.message),
    );

    // ── ⚠⚠ 核心断言 ⑤：「开始写」按钮点下去能真的开起来 ──────
    //   按钮调的正是这个 IPC。这里不跑完整工作流（要模型），
    //   只断言 workflow.start 返回 CREATED —— 即链路通了。
    const wf = await call('workflow.start', { bookId });
    rec(
      '⚠⚠ workflow.start 被接受（「开始写第 1 章」按钮的落点）',
      wf.ok && wf.data?.status === 'CREATED' && typeof wf.data?.workflowId === 'string',
      wf.ok ? `workflowId=${wf.data.workflowId} status=${wf.data.status}` : `${wf.error?.code}：${wf.error?.message ?? ''}`.slice(0, 160),
    );

    // ⚠ 门禁若没通过，上面这条会拿到 SETTINGS_NOT_CONFIRMED 或
    //   BLUEPRINT_NOT_CONFIRMED —— 正是用户实测遇到的形态。
    if (wf.ok) {
      rec('⚠ 开写未被任何门禁拦下（用户实测卡点已消除）', true, '');
    } else {
      rec(
        '⚠⚠⚠ 开写未被门禁拦下（用户实测卡点）',
        false,
        `仍被拦：${wf.error?.code} — ${wf.error?.message ?? ''}`.slice(0, 200),
      );
    }

    // ── 多书隔离：B 书不该被 A 书的确认带上 ──────────────────
    const b = await call('book.create', { projectId, title: '向导验证-书B' });
    if (b.ok) {
      const bStatus = await call('settings.status', { bookId: b.data.id });
      const bBp = await call('blueprint.status', { bookId: b.data.id });
      rec(
        '⚠⚠ 多书隔离：B 书的门禁未被 A 书的确认影响',
        bStatus.ok && bStatus.data?.allowed === true && bStatus.data?.entryCount === 0 &&
          bBp.ok && bBp.data?.confirmedAt === null,
        `B: settingsEntries=${bStatus.data?.entryCount} blueprintConfirmedAt=${bBp.data?.confirmedAt}`,
      );
    } else {
      rec('多书隔离：建 B 书', false, String(b.error?.message ?? '').slice(0, 120));
    }

    finish();
  } catch (e) {
    // ⚠ 印 stack 而非只印 message：异常来自深层共享库时，
    //   message 只说明症状，调用点在 stack 里（约定：验证脚本要能自证）
    console.error('验证脚本抛错：', e?.stack ?? e);
    rec('脚本未抛错', false, String(e?.message ?? e).slice(0, 200));
    finish();
  }
});
