/**
 * 状态结算端到端验证（§六 P0-4）
 *
 *   pnpm verify:state
 *
 * ## 这个脚本要证明什么
 *
 * 提示词 §六 的硬约束：
 *
 * > **没有 VERIFIED 的 State Proposal 不得进入 Canon。**
 *
 * 以及完整链路：正文 → 提取 → 提议 → 验证 → 应用 → Commit。
 *
 * ## ⚠ 为什么必须用真 core 进程 + 真数据库
 *
 * 门禁的判据是**库里那条记录的 status**（不是调用方手里的对象）。
 * 用假仓储测就绕过了这个关键点 —— 而"查权威状态而非快照"
 * 正是这条约束能成立的原因。
 *
 * ## ⚠ 为什么要真写一章正文
 *
 * 状态提取要真的读正文、引文要真的能在正文里定位。
 * 不真写就只能测"表能建"，证明不了"从正文提取的状态真的进了 Canon"。
 *
 * @verify-kind: needs-model — 状态结算需真实正文才能抽取
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
  const sandbox = join(app.getPath('temp'), 'nwa-verify-state');
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

    let info = await call('project.info', {});
    let projectId = info.data?.projects?.[0]?.id;
    if (!projectId) {
      const np = await call('tool.invoke', {
        name: 'project.create',
        input: { name: '状态结算验证项目', genre: 'urban_fantasy' },
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
    const bk = await call('book.create', { projectId, title: '状态结算测试书' });
    const bookId = bk.data?.id;
    if (!bookId) {
      rec('已创建书', false, `${bk.error?.code}：${bk.error?.message}`);
      return finish();
    }
    rec('已创建书', true, `bookId=${bookId}`);

    // ── 0. 先登记一个角色（否则角色状态解析不到 id，必然被拒）──
    const cc = await call('tool.invoke', {
      name: 'character.create',
      input: { bookId, name: '陆明远', role: '主角' },
      permission: 'ADMIN',
    });
    rec(
      '已登记角色（状态解析 id 的前提）',
      cc.ok === true,
      String(cc.data?.characterId ?? cc.data?.id ?? cc.error?.message ?? '').slice(0, 60),
    );

    // ── 1. 门禁：不存在/未验证的提议不能应用 ──
    console.log('\n──── §六 硬约束：没有 VERIFIED 的提议不得进 Canon ────\n');

    const proposals0 = await call('state.proposals', {});
    rec(
      '⚠ state.proposals IPC 可用（此前 state_proposals 表全仓无代码使用）',
      proposals0.ok === true,
      `现有提议 ${proposals0.data?.count ?? 0} 条`,
    );

    // ── 2. 造章节 + 计划 + 正文（真模型）──
    console.log('\n──── 准备：真写第 1 章正文（状态提取的输入）────\n');

    const cr = await call('tool.invoke', {
      name: 'chapter.create',
      input: { bookId, chapterNumber: 1, title: '第一章 架阁库' },
      permission: 'ADMIN',
    });
    const ch1 = cr.data?.chapterId ?? cr.data?.id;
    rec('第 1 章已创建', Boolean(ch1), String(ch1));
    if (!ch1) return finish();

    const plan = await call('planner.planChapter', { chapterId: ch1 }, 900_000);
    rec(
      '第 1 章计划已生成',
      plan.ok === true,
      plan.ok ? '' : String(plan.error?.message ?? '').slice(0, 90),
    );

    const draft = await call('writer.draft', { chapterId: ch1, genre: '都市' }, 900_000);
    const wroteOk = draft.ok && (draft.data?.totalChars ?? 0) > 0;
    rec(
      '第 1 章正文已生成（状态提取的输入）',
      wroteOk,
      wroteOk ? `${draft.data?.totalChars} 字` : `未写出：${String(draft.error?.message ?? '').slice(0, 90)}`,
    );

    // ── 3. 状态结算（真实链路）──
    console.log('\n──── 状态结算：提取 → 提议 → 验证 → 应用 ────\n');

    const start = await call('workflow.start', { bookId, chapterNumber: 1 });
    const wfId = start.data?.workflowId;
    rec('workflow.start 可用', Boolean(wfId), String(wfId));

    let view = null;
    if (wfId) {
      const deadline = Date.now() + 600_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const g = await call('workflow.get', { workflowId: wfId });
        view = g.data;
        if (!view) continue;
        const ss = view.stages.find((s) => s.stageId === 'state_settlement');
        if (ss?.status === 'DONE' || ss?.status === 'FAILED') break;
        if (['FAILED', 'DONE', 'CANCELLED'].includes(view.status)) break;
      }
    }

    const ssStage = view?.stages.find((s) => s.stageId === 'state_settlement');
    const ssOut = ssStage?.output ?? {};
    rec(
      '⚠ state_settlement stage 执行（不再是"如实返回未实现"）',
      ssStage?.status === 'DONE',
      `status=${ssStage?.status ?? '未知'}${
        ssStage?.error ? '｜' + String(ssStage.error).slice(0, 140) : ''
      }`,
    );

    if (ssStage?.status === 'DONE') {
      rec(
        '⚠ 结算产出提议（proposalId 非空）',
        Boolean(ssOut.proposalId),
        `proposalId=${ssOut.proposalId ?? '（无）'}`,
      );
      rec(
        '⚠ 结算回报 verified 与各类计数（结构化，不是一句话）',
        typeof ssOut.verified === 'boolean' && typeof ssOut.factCount === 'number',
        `verified=${ssOut.verified} facts=${ssOut.factCount} states=${ssOut.characterStateCount} timeline=${ssOut.timelineEventCount} foreshadow=${ssOut.foreshadowingCount}`,
      );

      // ⚠ 核心断言：verified=false 时各类写入计数必须都是 0
      const nothingWritten =
        (ssOut.factCount ?? 0) === 0 &&
        (ssOut.characterStateCount ?? 0) === 0 &&
        (ssOut.timelineEventCount ?? 0) === 0 &&
        (ssOut.foreshadowingCount ?? 0) === 0;
      rec(
        '⚠⚠ 未通过验证 → 一条都没写入 Canon（§六硬约束真的在拦）',
        ssOut.verified === true || nothingWritten,
        ssOut.verified === true
          ? '验证通过并已应用（计数如上）'
          : `verified=false 且写入计数全为 0：${JSON.stringify(ssOut.rejected ?? []).slice(0, 120)}`,
      );

      // 提议可查（门禁判据可追溯）
      const props = await call('state.proposals', { chapterId: ch1 });
      const rec1 = (props.data?.proposals ?? [])[0];
      rec(
        '⚠ 提议已落库且状态可查（门禁判据是库里的 status）',
        Boolean(rec1),
        rec1
          ? `status=${rec1.status} verified=${rec1.verifiedCount} rejected=${rec1.rejectedCount}`
          : '（无提议）',
      );

      if (rec1) {
        // ⚠ 与写入计数交叉核对：status=REJECTED 时 Canon 里不能有新增
        const truth = await call('retrieval.truth', { bookId, chapterNumber: 99 });
        const canonAfter = truth.data?.canonFacts ?? 0;
        const statesAfter = truth.data?.characterStates ?? 0;
        const timelineAfter = truth.data?.timeline ?? 0;
        rec(
          '⚠⚠ 交叉核对：REJECTED 的提议对应 Canon 零新增',
          rec1.status === 'VERIFIED' || (canonAfter === 0 && statesAfter === 0 && timelineAfter === 0),
          `提议 status=${rec1.status}｜Canon 实际：facts=${canonAfter} states=${statesAfter} timeline=${timelineAfter}`,
        );

        // 被拒原因必须可读（不是只报"失败"）
        if (rec1.status === 'REJECTED') {
          rec(
            '⚠ 被拒原因可读（回答"为什么没进 Canon"）',
            Array.isArray(rec1.rejectedReasons) && rec1.rejectedReasons.length > 0,
            (rec1.rejectedReasons ?? []).slice(0, 2).join('；').slice(0, 160),
          );
        } else {
          rec(
            '⚠ 验证通过的提议可查到逐条结论',
            rec1.verifiedCount > 0,
            `verified=${rec1.verifiedCount} rejected=${rec1.rejectedCount}`,
          );
        }
      }
    }

    // ── 4. 证据可回溯（回答「这条状态来自正文哪一句」）──
    console.log('\n──── 可回溯性：状态必须能指回正文原句 ────\n');

    const evCheck = await call('state.proposals', { chapterId: ch1 });
    const p0 = (evCheck.data?.proposals ?? [])[0];
    if (p0 && p0.status === 'VERIFIED') {
      const ev = await call('state.evidence', { bookId });
      rec(
        '⚠⚠ 写入 Canon 的状态都挂着证据（可回溯到正文哪一句）',
        ev.ok === true && (ev.data?.count ?? 0) > 0,
        ev.ok
          ? `${ev.data.count} 条证据，来源：${JSON.stringify(ev.data.bySource)}`
          : String(ev.error?.message ?? '').slice(0, 90),
      );
      if (ev.ok) {
        // ⚠ 写了却没人引用 = 写了白写。这条断言防的就是"证据表被当成摆设"
        rec(
          '⚠⚠ 证据不是摆设：全部被实际引用（孤儿证据 = 0）',
          ev.data.count > 0 && ev.data.orphanCount === 0,
          `被引用 ${ev.data.referencedCount}/${ev.data.count} 条，孤儿 ${ev.data.orphanCount} 条`,
        );
      }
      if (ev.ok && ev.data?.samples?.length) {
        const s0 = ev.data.samples[0];
        rec(
          '⚠ 证据样本可读（quote + 正文区间）',
          Boolean(s0.quote && s0.span),
          `${s0.sourceRef} [${s0.span[0]}-${s0.span[1]}]「${String(s0.quote).slice(0, 30)}」`,
        );
      }
    }

    // ── 5. 多书隔离 ──
    const bk2 = await call('book.create', { projectId, title: '另一本书' });
    if (bk2.data?.id) {
      const t2 = await call('retrieval.truth', { bookId: bk2.data.id, chapterNumber: 1 });
      rec(
        '⚠ 另一本书的 Canon 为空（多书隔离：状态不串书）',
        t2.ok === true && (t2.data?.canonFacts ?? 0) === 0,
        `canon=${t2.data?.canonFacts} states=${t2.data?.characterStates}`,
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
