/**
 * 时间线端到端验证（P0-5）
 *
 *   pnpm verify:timeline
 *
 * ## 这个脚本要证明什么
 *
 * 提示词点名的验收用例：
 *
 * > ch12 21:30 离开医院、ch13 21:20 还在医院 → Commit 前必须能发现
 *
 * 以及：Commit 前的时间线门禁真的会挡住不可能事件。
 *
 * ## ⚠ 为什么必须用真 core 进程 + 真数据库 + 真模型
 *
 * 时间线的价值全在**真实正文**上：模型能不能给出时间原文、
 * 代码能不能把它解析成可比较的值、检查器能不能在真实数据上发现问题。
 * 用手搭的事件测只能证明"表能写"。
 *
 * ## ⚠ 为什么必须真跑两章
 *
 * 验收用例本身就是**跨章**的（ch12 → ch13）。单章测试测不出
 * "故事时间倒退"——那需要两个事件落在不同的章里。
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

function call(method, params = {}, timeoutMs = 900_000) {
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

app.on('window-all-closed', () => {});
app.setName('@nwa/desktop');
app.setPath('userData', join(app.getPath('appData'), '@nwa/desktop'));

app.whenReady().then(async () => {
  const sandbox = join(app.getPath('temp'), 'nwa-verify-timeline');
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

    const info = await call('project.info', {});
    let projectId = info.data?.projects?.[0]?.id;
    if (!projectId) {
      const np = await call('tool.invoke', {
        name: 'project.create',
        input: { name: '时间线验证项目', genre: 'urban_fantasy' },
        permission: 'ADMIN',
      });
      projectId = np.data?.id ?? np.data?.projectId;
    }
    const bk = await call('book.create', { projectId, title: '时间线验证书' });
    const bookId = bk.data?.id;
    if (!bookId) {
      rec('已创建书', false, `${bk.error?.code}：${bk.error?.message}`);
      return finish();
    }
    rec('已创建书', true, `bookId=${bookId}`);

    await call('tool.invoke', {
      name: 'character.create',
      input: { bookId, name: '陆明远', role: '主角' },
      permission: 'ADMIN',
    });

    // ── 1. 表存在但此前全仓无代码使用 ──
    console.log('\n──── 时间线表接线（此前「建了表没接线」）────\n');

    const empty = await call('timeline.query', { bookId });
    rec(
      '⚠ timeline.query IPC 可用（此前 timeline_events 全仓无代码使用）',
      empty.ok === true,
      `现有事件 ${empty.data?.count ?? 0} 条`,
    );

    // ── 2. 真写两章（验收用例的形态）──
    console.log('\n──── 真写两章：验收用例需要跨章事件 ────\n');

    const chapterIds = {};
    for (const n of [12, 13]) {
      const cr = await call('tool.invoke', {
        name: 'chapter.create',
        input: { bookId, chapterNumber: n, title: `第 ${n} 章` },
        permission: 'ADMIN',
      });
      chapterIds[n] = cr.data?.chapterId ?? cr.data?.id;
      const plan = await call('planner.planChapter', { chapterId: chapterIds[n] }, 900_000);
      const draft = await call('writer.draft', { chapterId: chapterIds[n], genre: '都市' }, 900_000);
      const chars = draft.data?.totalChars ?? 0;
      rec(
        `第 ${n} 章已写（计划 ${plan.ok ? 'ok' : 'FAILED'}）`,
        chars > 0,
        `${chars} 字`,
      );
      if (chars === 0) return finish();

      // 状态结算 → 时间线事件
      const wf = await call('workflow.start', { bookId, chapterNumber: n });
      const wfId = wf.data?.workflowId;
      if (wfId) {
        const deadline = Date.now() + 600_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const g = await call('workflow.get', { workflowId: wfId });
          const view = g.data;
          if (!view) continue;
          const ss = view.stages.find((s) => s.stageId === 'state_settlement');
          if (ss?.status === 'DONE' || ss?.status === 'FAILED') {
            rec(
              `第 ${n} 章状态结算`,
              ss.status === 'DONE',
              `timeline=${ss.output?.timelineEventCount ?? 0} verified=${ss.output?.verified}`,
            );
            break;
          }
          if (['FAILED', 'DONE', 'CANCELLED'].includes(view.status)) break;
        }
      }
    }

    // ── 3. 时间线可查询 + 可比较 ──
    console.log('\n──── 时间线：事件与可比时间 ────\n');

    const q = await call('timeline.query', { bookId });
    const events = q.data?.events ?? [];
    rec(
      '⚠ 状态结算产出了时间线事件（不是只写表）',
      events.length > 0,
      `${events.length} 条事件`,
    );

    if (events.length > 0) {
      const withTime = events.filter((e) => e.storyHours !== null);
      rec(
        '⚠⚠ 存在可比较的故事时间（否则顺序检查等于没做）',
        withTime.length > 0,
        `${withTime.length}/${events.length} 条可比较；` +
          `样例：${events.slice(0, 3).map((e) => `${e.chapter}章「${e.title}」=${e.storyDisplay ?? e.storyHours}`).join('；')}`,
      );

      // 事件是否带角色/地点（不可能事件检查的前提）
      const withChars = events.filter((e) => (e.characters ?? []).length > 0);
      rec(
        '⚠ 事件带角色信息（"同一角色两地同时出现"检查的前提）',
        withChars.length > 0,
        `${withChars.length}/${events.length} 条带角色`,
      );
    }

    // ── 4. 检查器在真实数据上可运行 ──
    const chk = await call('timeline.query', { bookId, check: true });
    rec(
      '⚠ 时间线检查可运行并如实报告局限',
      chk.ok === true && Array.isArray(chk.data?.limitations),
      `issues=${chk.data?.issues?.length ?? 0} blocking=${chk.data?.blockingCount ?? 0} ` +
        `limitations=${(chk.data?.limitations ?? []).length} 条`,
    );
    if (chk.ok && (chk.data?.limitations ?? []).length > 0) {
      rec(
        '⚠ 检查的局限被如实说明（不假装"全都检查过了"）',
        true,
        String(chk.data.limitations[0]).slice(0, 120),
      );
    }

    // ── 5. 验收用例：人为造出 ch12 21:30 / ch13 21:20 ──
    //
    // ⚠ 这一步**必须人为造**：真模型写出的两章不一定恰好构成
    //   "21:30 离开、21:20 还在"的矛盾。验收用例要验的是
    //   **检查器能不能发现**，所以用确定的输入构造这个场景。
    console.log('\n──── 验收用例：ch12 21:30 离开医院、ch13 21:20 还在医院 ────\n');

    const mk = await call('tool.invoke', {
      name: 'timeline.addEvent',
      input: {
        bookId,
        chapter: 12,
        title: '陆明远离开医院',
        description: '他离开医院回家。',
        storyTimeValue: 21.5,
        storyTimeUnit: 'hour',
        storyTimeDisplay: '21:30',
        characters: ['陆明远'],
        location: '医院',
      },
      permission: 'ADMIN',
    });
    rec('构造 ch12 事件（21:30 离开医院）', mk.ok === true, String(mk.data?.id ?? mk.error?.message ?? ''));

    const mk2 = await call('tool.invoke', {
      name: 'timeline.addEvent',
      input: {
        bookId,
        chapter: 13,
        title: '陆明远仍在医院',
        description: '他还在医院里。',
        storyTimeValue: 21 + 20 / 60,
        storyTimeUnit: 'hour',
        storyTimeDisplay: '21:20',
        characters: ['陆明远'],
        location: '医院',
      },
      permission: 'ADMIN',
    });
    rec('构造 ch13 事件（21:20 还在医院）', mk2.ok === true, String(mk2.data?.id ?? ''));

    const after = await call('timeline.query', { bookId, check: true });
    const inv = (after.data?.issues ?? []).filter((i) => i.code === 'TIME_INVERSION');
    rec(
      '⚠⚠ 验收用例：Commit 前必须能发现（已发现）',
      inv.length >= 1,
      inv.length > 0
        ? `[${inv[0].severity}] ${String(inv[0].message).slice(0, 140)}`
        : `未发现；issues=${JSON.stringify(after.data?.issues ?? []).slice(0, 200)}`,
    );

    // ── 6. 不可能事件挡 Commit ──
    console.log('\n──── 不可能事件：必须挡住 Commit ────\n');

    const dup = await call('tool.invoke', {
      name: 'timeline.addEvent',
      input: {
        bookId,
        chapter: 13,
        title: '陆明远在学堂',
        description: '同一时刻他却在学堂。',
        storyTimeValue: 21 + 20 / 60,
        storyTimeUnit: 'hour',
        storyTimeDisplay: '21:20',
        characters: ['陆明远'],
        location: '学堂',
      },
      permission: 'ADMIN',
    });
    rec('构造"同一时刻在两地"事件', dup.ok === true, String(dup.data?.id ?? ''));

    const finalChk = await call('timeline.query', { bookId, check: true });
    const blocking = (finalChk.data?.issues ?? []).filter((i) => i.severity === 'BLOCKING');
    rec(
      '⚠⚠ 同一角色两地同时出现 → BLOCKING（会挡住 Commit）',
      blocking.length >= 1,
      blocking.length > 0
        ? `${blocking[0].code}：${String(blocking[0].message).slice(0, 130)}`
        : '未报 BLOCKING',
    );

    // ⚠ 关键：门禁**真的**会挡住提交吗。
    //   不能只看"检查器报了 BLOCKING"—— 那只证明检查器会说话，
    //   证明不了它接在提交路径上。所以真跑一次工作流，
    //   看 ready_to_commit 这个 stage 是否因时间线冲突而 FAILED。
    const wf2 = await call('workflow.start', { bookId, chapterNumber: 13 });
    let gateStage = null;
    if (wf2.data?.workflowId) {
      const deadline = Date.now() + 600_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const g = await call('workflow.get', { workflowId: wf2.data.workflowId });
        const view = g.data;
        if (!view) continue;
        gateStage = view.stages.find((x) => x.stageId === 'ready_to_commit');
        if (gateStage && (gateStage.status === 'DONE' || gateStage.status === 'FAILED')) break;
        if (['FAILED', 'DONE', 'CANCELLED'].includes(view.status)) break;
      }
    }
    const gateText = String(gateStage?.error ?? '') + JSON.stringify(gateStage?.output ?? {});
    rec(
      '⚠⚠ 门禁真的接线：ready_to_commit 因时间线冲突被拦下',
      gateStage?.status === 'FAILED' && gateText.includes('时间线冲突'),
      `status=${gateStage?.status ?? '未到达'}｜${gateText.slice(0, 180)}`,
    );

    // ── 7. 多书隔离 ──
    const bk2 = await call('book.create', { projectId, title: '另一本书' });
    if (bk2.data?.id) {
      const t2 = await call('timeline.query', { bookId: bk2.data.id });
      rec(
        '⚠ 另一本书的时间线为空（多书隔离）',
        t2.ok === true && (t2.data?.count ?? 0) === 0,
        `count=${t2.data?.count}`,
      );
    }
  } catch (e) {
    rec('脚本执行', false, e instanceof Error ? e.message : String(e));
  } finally {
    finish();
  }
});

function finish() {
  const passed = steps.filter((s) => s.ok).length;
  console.log(`\n──── 结果：${passed}/${steps.length} ────\n`);
  for (const s of steps.filter((x) => !x.ok)) {
    console.log(`✗ ${s.name}${s.detail ? ' — ' + s.detail : ''}`);
  }
  try {
    child?.kill();
  } catch {
    /* 已退出 */
  }
  setTimeout(() => app.exit(passed === steps.length ? 0 : 1), 300);
}
