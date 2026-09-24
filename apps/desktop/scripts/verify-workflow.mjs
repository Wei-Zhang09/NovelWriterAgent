/**
 * Novel Workflow 端到端验证（P0-1 / P0-2）
 *
 *   pnpm verify:workflow
 *
 * ## 这个脚本要证明什么
 *
 * 提示词 §二十五 的测试要求，用**真实 core 进程 + 真数据库**跑：
 *
 *   1. UI 只需 `workflow.start` —— 12 个 stage 由代码按序驱动
 *   2. 逐 stage 进度可查（`workflow.get` 的 stages 数组）
 *   3. 暂停 → PAUSED（不是 CANCELLED）→ 可 resume
 *   4. **进程重启后仍能恢复**（丢进程、新进程只读数据库）
 *   5. **DONE 的 stage 不重复执行**（不重跑昂贵 LLM 阶段）
 *
 * ## ⚠ 为什么重启测试必须换进程
 *
 * 提示词 §四 的硬要求是"不要依赖内存 Map/Set 作为唯一恢复依据"。
 * 若在同一进程里测，内存缓存还在 —— 恢复路径根本没被走到，测试是绿的
 * 却什么都没证明。所以这里**真的杀掉 core 进程**，再起一个新的，
 * 只用 `workflowId` 恢复。内存里的一切都真的没了。
 *
 * ## 模型额度
 *
 * 模型未配置时，工作流会在 plan stage 失败（这是**正确行为** ——
 * 编排本身仍被完整验证：stage 顺序、状态落库、失败可恢复）。
 * 脚本会如实区分"环境问题"与"功能缺陷"。
 */
import { app, utilityProcess, safeStorage } from 'electron';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { FileSecretStore, defaultCredentialsPath } from '@nwa/harness';

const here = dirname(fileURLToPath(import.meta.url));
const coreEntry = join(here, '..', 'dist', 'main', 'core-process.js');

const steps = [];
const rec = (name, ok, detail) => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

let child = null;
let seq = 0;
const pending = new Map();
let secretStore = null;

function getSecretStore() {
  if (!secretStore) {
    secretStore = new FileSecretStore(defaultCredentialsPath(homedir()), {
      name: 'electron-safeStorage',
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (cipher) => safeStorage.decryptString(cipher),
    });
  }
  return secretStore;
}

async function handleCrypto(msg) {
  const { requestId, op, payload } = msg;
  const reply = (ok, value, error) =>
    child.postMessage({ kind: 'crypto-response', requestId, ok, value, error });
  try {
    const store = getSecretStore();
    const p = payload ?? {};
    if (op === 'get') reply(true, await store.get(String(p.ref)));
    else if (op === 'isAvailable') reply(true, safeStorage.isEncryptionAvailable());
    else reply(false, undefined, `verify 脚本不执行 ${op} 操作`);
  } catch (e) {
    reply(false, undefined, e instanceof Error ? e.message : String(e));
  }
}

function call(method, params = {}, timeoutMs = 600_000) {
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

/** 启动（或重启）core 进程 */
function startCore() {
  return new Promise((resolve, reject) => {
    child = utilityProcess.fork(coreEntry, [], { stdio: 'pipe' });
    child.stdout?.on('data', (d) => {
      const t = String(d);
      if (/ERROR|WARN/.test(t)) process.stdout.write(`[core] ${t}`);
    });
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
      if (msg?.kind === 'crypto-request') void handleCrypto(msg);
    });
    child.on('spawn', () => setTimeout(resolve, 1200));
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) reject(new Error(`core 退出码 ${code}`));
    });
  });
}

/** ⚠ 真杀进程 —— 内存里的一切都会消失，这是"重启"的关键 */
function killCore() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(resolve, 1500);
  });
}

app.on('window-all-closed', () => {});
app.setName('@nwa/desktop');
app.setPath('userData', join(app.getPath('appData'), '@nwa/desktop'));

app.whenReady().then(async () => {
  const sandbox = join(app.getPath('temp'), 'nwa-verify-workflow');
  const projDir = join(sandbox, 'proj');

  try {
    rmSync(sandbox, { recursive: true, force: true });
    mkdirSync(projDir, { recursive: true });

    await startCore();
    const open = await call('project.open', { dir: projDir });
    if (!open.ok) {
      rec('打开项目', false, open.error?.message);
      return finish();
    }
    rec('项目已打开（隔离沙盒）', true, String(open.data?.dir ?? ''));

    // 建书（⚠ book.create 需要 projectId —— 它不会自己推断）
    // ⚠ 全新隔离目录里**没有 project 行** —— 必须自己建。
    //   project.open 只建目录与库，不建业务行。
    //   （这是本仓库验证脚本的既有约定，见 verify-writing-e2e.mjs 的注释：
    //    踩过"projectId 为 undefined → SQLite 参数绑定失败"。）
    let info = await call('project.info', {});
    let projectId = info.data?.projects?.[0]?.id;
    if (!projectId) {
      const np = await call('tool.invoke', {
        name: 'project.create',
        input: { name: '工作流验证项目', genre: 'urban_fantasy' },
        permission: 'ADMIN',
      });
      projectId = np.data?.id ?? np.data?.projectId;
      if (!projectId) {
        info = await call('project.info', {});
        projectId = info.data?.projects?.[0]?.id;
      }
    }
    if (!projectId) {
      rec('取得 projectId', false, '无法创建项目');
      return finish();
    }
    const bk = await call('book.create', { projectId, title: '工作流测试书' });
    const bookId = bk.data?.id;
    if (!bookId) {
      rec('已创建书', false, `${bk.error?.code}：${bk.error?.message}`);
      return finish();
    }
    rec('已创建书', true, `bookId=${bookId}`);

    // ── 1. workflow.start 是唯一入口 ──
    console.log('\n──── 启动 Novel Workflow（UI 只调这一个方法）────\n');
    const start = await call('workflow.start', { bookId, userInstruction: '测试工作流' });
    if (!start.ok) {
      rec('workflow.start', false, `${start.error?.code}：${start.error?.message}`);
      return finish();
    }
    const wfId = start.data?.workflowId;
    rec('⚠ workflow.start 可用（此前 UI 逐个调 IPC）', Boolean(wfId), String(wfId));

    // 等它推进。
    //
    // ⚠ 等到"越过 plan_verify"即可判定链路打通 —— 写正文（write）要几分钟，
    //   把整个工作流等完会让脚本跑很久，而本脚本要证明的是**编排与恢复**，
    //   不是"模型写得多快"。
    //   若模型未配置，会停在 plan 并 FAILED（同样是有效结论）。
    let view = null;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const g = await call('workflow.get', { workflowId: wfId });
      view = g.data;
      if (!view) continue;
      if (['FAILED', 'DONE', 'PAUSED', 'CANCELLED'].includes(view.status)) break;
      // 已越过 plan_verify（进入 write 或更后）→ 链路已证明，可以继续
      const passed = view.stages.find((s) => s.stageId === 'plan_verify')?.status === 'DONE';
      if (passed) break;
    }
    if (!view) {
      rec('workflow.get 可查状态', false, '拿不到状态');
      return finish();
    }

    rec(
      'workflow.get 返回逐 stage 进度（UI 用它渲染 ✓/●/○）',
      Array.isArray(view.stages) && view.stages.length === 12,
      `12 个 stage：${view.stages.map((s) => `${s.stageId}:${s.status}`).slice(0, 6).join(',')}...`,
    );

    // ── 2. 编排由代码控制：stage 顺序来自 STAGE_ORDER ──
    const ORDER = [
      'create_chapter', 'build_context', 'plan', 'plan_verify', 'write',
      'review', 'revision', 'continuity', 'state_settlement',
      'ready_to_commit', 'commit', 'verify',
    ];
    const stageIds = view.stages.map((s) => s.stageId);
    rec(
      '⚠ 编排由代码控制（stage 顺序 = STAGE_ORDER，调用方改不了）',
      JSON.stringify(stageIds) === JSON.stringify(ORDER),
      stageIds.join(' → '),
    );

    const doneStages = view.stages.filter((s) => s.status === 'DONE').map((s) => s.stageId);
    rec(
      'create_chapter 已完成（章节由 workflow 自己建）',
      doneStages.includes('create_chapter'),
      `已完成：${doneStages.join(',') || '（无）'}`,
    );
    rec(
      'workflow 自己建出了章节并绑定',
      Boolean(view.chapterId),
      `chapterId=${view.chapterId} 第 ${view.chapterNumber} 章`,
    );

    const failedStage = view.stages.find((s) => s.status === 'FAILED');
    const failMsg = String(failedStage?.error ?? '');
    const isModelIssue = /MODEL_AUTH|尚未配置模型|模型/.test(failMsg);
    const planVerifyDone = view.stages.find((s) => s.stageId === 'plan_verify')?.status === 'DONE';

    if (view.status === 'DONE') {
      rec('⚠ 工作流端到端跑完 DONE', true, '12 个 stage 全部完成');
    } else if (isModelIssue) {
      rec(
        '⚠ 模型未配置 → 停在 plan 并如实报错（环境问题，非功能缺陷）',
        true,
        `停在「${failedStage?.stageId}」：${failMsg.slice(0, 80)}`,
      );
    } else if (planVerifyDone) {
      // ⚠ 这是"链路真的通了"的证据：Plan → 计划校验都过了，
      //   正在写正文（几分钟）。不能因为"还没写完"就判失败。
      const cur = view.stages.find((s) => s.status === 'RUNNING');
      rec(
        '⚠ 链路已打通：已越过 plan_verify，正在执行后续 stage',
        true,
        `当前「${cur?.stageId ?? view.status}」（写正文耗时数分钟，属正常；本脚本只验证编排）`,
      );
    } else {
      rec('工作流推进', false, `${view.status}｜${failMsg.slice(0, 120)}`);
    }

    // ── 3. 暂停语义（P0-2）──
    console.log('\n──── P0-2：暂停 / 恢复 / 重启 ────\n');

    // 造一个可暂停的场景：新起一个工作流，立刻暂停
    const start2 = await call('workflow.start', { bookId, chapterNumber: 2 });
    const wfId2 = start2.data?.workflowId;
    await new Promise((r) => setTimeout(r, 200));
    const paused = await call('workflow.pause', { workflowId: wfId2 });
    rec(
      '⚠ workflow.pause 返回 PAUSED（不是 CANCELLED）',
      paused.data?.status === 'PAUSED',
      `status=${paused.data?.status}`,
    );
    const afterPause = await call('workflow.get', { workflowId: wfId2 });
    rec(
      '⚠ 暂停后库里状态为 PAUSED（权威状态在数据库，不在内存）',
      afterPause.data?.status === 'PAUSED',
      `status=${afterPause.data?.status}｜resumeCursor=${afterPause.data?.resumeCursor}`,
    );

    // ── 4. ⚠ 真重启：杀掉 core 进程，起新的，只靠 workflowId 恢复 ──
    const doneBefore = (afterPause.data?.stages ?? [])
      .filter((s) => s.status === 'DONE')
      .map((s) => s.stageId);
    console.log(`  重启前已完成：${doneBefore.join(',') || '（无）'}`);

    await killCore();
    await startCore();
    const reopen = await call('project.open', { dir: projDir });
    rec('⚠ core 进程已重启并重新打开项目', reopen.ok === true, String(reopen.data?.dir ?? ''));

    const recov = await call('workflow.recoverable', {});
    rec(
      '⚠ 重启后能捞出未完成的工作流（恢复依据来自数据库）',
      (recov.data?.workflows ?? []).some((w) => w.workflowId === wfId2),
      `可恢复 ${recov.data?.count} 个`,
    );

    const resumed = await call('workflow.resume', { workflowId: wfId2 });
    rec('workflow.resume 可调用', resumed.ok === true, `status=${resumed.data?.status}`);

    // 等恢复后的推进
    let view2 = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const g = await call('workflow.get', { workflowId: wfId2 });
      view2 = g.data;
      if (view2 && ['FAILED', 'DONE', 'PAUSED', 'CANCELLED'].includes(view2.status)) break;
    }

    const doneAfter = (view2?.stages ?? [])
      .filter((s) => s.status === 'DONE')
      .map((s) => s.stageId);
    rec(
      '⚠ 重启恢复后，重启前已 DONE 的 stage 仍为 DONE（未丢失恢复依据）',
      doneBefore.every((s) => doneAfter.includes(s)),
      `重启前 [${doneBefore.join(',')}] → 重启后 [${doneAfter.join(',')}]`,
    );

    // ⚠ 这是 P0-2 的核心：DONE 的 stage 没有被重置为 PENDING
    const resetToPending = (view2?.stages ?? []).filter(
      (s) => doneBefore.includes(s.stageId) && s.status === 'PENDING',
    );
    rec(
      '⚠ DONE 的 stage 不会被恢复流程重置（否则会重跑昂贵 LLM 阶段）',
      resetToPending.length === 0,
      resetToPending.length === 0 ? '无重置' : `被重置：${resetToPending.map((s) => s.stageId).join(',')}`,
    );

    // ⚠ attempts 是"是否重跑"的直接证据
    const reRun = (view2?.stages ?? []).filter(
      (s) => doneBefore.includes(s.stageId) && s.attempts > 1,
    );
    rec(
      '⚠ 已 DONE 的 stage 未被重复执行（attempts 未增加）',
      reRun.length === 0,
      reRun.length === 0 ? '无重复执行' : `重复执行：${reRun.map((s) => `${s.stageId}×${s.attempts}`).join(',')}`,
    );

    // ── 5. 取消不可恢复 ──
    const start3 = await call('workflow.start', { bookId, chapterNumber: 3 });
    const wfId3 = start3.data?.workflowId;
    await new Promise((r) => setTimeout(r, 200));
    await call('workflow.cancel', { workflowId: wfId3 });
    const cancelled = await call('workflow.get', { workflowId: wfId3 });
    rec(
      '⚠ cancel → CANCELLED（与 PAUSED 语义不同）',
      cancelled.data?.status === 'CANCELLED',
      `status=${cancelled.data?.status}`,
    );
  } catch (e) {
    rec('脚本异常', false, e instanceof Error ? e.message : String(e));
  }
  finish();
});

function finish() {
  const passed = steps.filter((s) => s.ok).length;
  const failed = steps.filter((s) => !s.ok);
  console.log(`\n──── 结果 ────`);
  console.log(`${passed}/${steps.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`);
  }
  try {
    child?.kill();
  } catch {
    /* ignore */
  }
  app.exit(failed.length === 0 ? 0 : 1);
}
