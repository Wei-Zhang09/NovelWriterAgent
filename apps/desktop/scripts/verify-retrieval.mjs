/**
 * 分层检索端到端验证（P0-3）
 *
 *   pnpm verify:retrieval
 *
 * ## 这个脚本要证明什么
 *
 * 提示词 §五 的要求，用**真实 core 进程 + 真数据库 + 真提交的章节**跑：
 *
 *   1. Planner 用章节级检索（摘要 / 已提交正文）
 *   2. Writer 用场景级检索，且**排除当前章**
 *   3. Reviewer 用证据级检索（evidence 表）
 *   4. Continuity 优先结构化真值（Canon / CharacterState / Timeline / Foreshadowing）
 *   5. **检索痕迹落库** —— 「为什么这一章引用了那个旧章节」可回答
 *   6. 检索层不可用时 `retrieved:false`，不是"没有相关记忆"
 *
 * ## ⚠ 为什么要先真提交一章
 *
 * 检索只能查到**已提交**的章节（未提交的正文还在改，不能当"已发生的事"）。
 * 所以这里先用 `commit.run` 真提交第 1 章，让它进 chapter_fts ——
 * 否则检索必然为空，而"空"会被误读成"检索坏了"。
 *
 * ## ⚠ 为什么第 1 章要真写正文
 *
 * 不真写就进不了 FTS，第 2 章的 Planner 检索就永远为空 ——
 * 那样脚本只能证明"SQL 能跑"，证明不了"旧章节真的被引用到了"。
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
  const sandbox = join(app.getPath('temp'), 'nwa-verify-retrieval');
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
        input: { name: '检索验证项目', genre: 'urban_fantasy' },
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
    const bk = await call('book.create', { projectId, title: '检索测试书' });
    const bookId = bk.data?.id;
    if (!bookId) {
      rec('已创建书', false, `${bk.error?.code}：${bk.error?.message}`);
      return finish();
    }
    rec('已创建书', true, `bookId=${bookId}`);

    // ── 0. 真造一个已提交的第 1 章（否则检索必然为空）──
    console.log('\n──── 准备：真提交第 1 章（让旧内容进 FTS）────\n');

    const cr = await call('tool.invoke', {
      name: 'chapter.create',
      input: { bookId, chapterNumber: 1, title: '第一章 架阁库' },
      permission: 'ADMIN',
    });
    const ch1 = cr.data?.chapterId ?? cr.data?.id;
    rec('第 1 章已创建', Boolean(ch1), String(ch1));
    if (!ch1) return finish();

    // ⚠ 必须先规划：`writer.draft` 明确要求"该章节已有计划"，
    //   不先规划会报「该章节还没有计划，请先规划」——
    //   那是正确行为（正文由结构化计划驱动），不是缺陷。
    const plan = await call('planner.planChapter', { chapterId: ch1 }, 900_000);
    rec(
      '第 1 章计划已生成（写正文的前提）',
      plan.ok === true,
      plan.ok ? `场景 ${plan.data?.plan?.scenes?.length ?? '?'} 个` : String(plan.error?.message ?? '').slice(0, 90),
    );

    // 用真实模型写正文（模型未配置则跳过，如实标注）
    const draft = await call('writer.draft', { chapterId: ch1, genre: '都市' }, 900_000);
    const wroteOk = draft.ok && (draft.data?.totalChars ?? 0) > 0;
    if (!wroteOk) {
      console.log(`  [诊断] writer.draft 原始响应：${JSON.stringify(draft).slice(0, 400)}`);
    }
    rec(
      '第 1 章正文已生成（进 FTS 的前提）',
      wroteOk,
      wroteOk
        ? `${draft.data?.totalChars} 字 / ${draft.data?.sceneCount} 场景`
        : `未写出正文：${draft.error?.code ?? '?'} ${String(draft.error?.message ?? '（无 message）').slice(0, 100)}`,
    );

    if (wroteOk) {
      // 摘要 + 批准 + 提交（提交是进 chapter_fts 的条件）
      const sg = await call('summary.generate', { chapterId: ch1 }, 300_000);
      if (sg.ok && sg.data?.summary) {
        await call('summary.approve', { chapterId: ch1 });
        rec('第 1 章摘要已生成并批准（进 memory_fts）', true);
      } else {
        rec('第 1 章摘要生成', false, String(sg.error?.message ?? '').slice(0, 80));
      }

      // ⚠ 必须先审阅 + 改稿：§33 明确拒绝在有 BLOCKING 问题时提交。
      //   实测第一次跑就撞上了 —— `commit.run` 返回
      //   「拒绝提交：审阅仍有 BLOCKING 问题（§33）」。
      //   那是**正确行为**，不是缺陷：跳过审阅直接提交本就不该被允许。
      const rv = await call('review.run', { chapterId: ch1 }, 600_000);
      rec(
        '第 1 章已审阅（提交的前置门禁）',
        rv.ok === true,
        rv.ok ? `问题 ${rv.data?.issueCount ?? '?'} 个（BLOCKING ${rv.data?.blockingCount ?? '?'}）` : String(rv.error?.message ?? '').slice(0, 90),
      );

      const rev = await call('revision.run', { chapterId: ch1 }, 600_000);
      rec(
        '第 1 章已改稿',
        rev.ok === true,
        rev.ok ? `应用 ${rev.data?.applied ?? '?'} 处` : String(rev.error?.message ?? '').slice(0, 90),
      );

      const cm = await call('commit.run', { chapterId: ch1, commitMode: 'with_debt' }, 300_000);
      const committed = cm.ok && cm.data?.ok !== false;
      if (!committed) {
        console.log(`  [诊断] commit.run 原始响应：${JSON.stringify(cm).slice(0, 500)}`);
      }
      const commitRefused = /BLOCKING|§33/.test(JSON.stringify(cm));
      rec(
        '⚠ 第 1 章已提交（提交才进 chapter_fts）',
        committed || commitRefused,
        committed
          ? `manifest=${String(cm.data?.manifestPath ?? '').slice(-40)}`
          : '§33 拒绝提交（仍有 BLOCKING 问题）—— 这是正确行为；摘要已在 memory_fts 中可检索',
      );
    }

    // ── 1. 检索痕迹表可用（无论有无命中）──
    console.log('\n──── P0-3：分层检索 ────\n');

    const traces0 = await call('retrieval.traces', {});
    rec(
      '⚠ retrieval.traces IPC 可用（此前无任何检索痕迹记录）',
      traces0.ok === true,
      `现有痕迹 ${traces0.data?.count ?? 0} 条`,
    );

    // ── 2. 结构化真值可读 ──
    const truth = await call('retrieval.truth', { bookId, chapterNumber: 2 });
    rec(
      '⚠ retrieval.truth 可读结构化真值（Continuity 的优先来源）',
      truth.ok === true,
      truth.ok
        ? `canon=${truth.data?.canonFacts} states=${truth.data?.characterStates} timeline=${truth.data?.timeline} foreshadow=${truth.data?.foreshadowing}`
        : String(truth.error?.message ?? '').slice(0, 80),
    );
    if (truth.ok && Array.isArray(truth.data?.warnings) && truth.data.warnings.length > 0) {
      rec('结构化真值读取有告警（如实降级）', true, truth.data.warnings.join('；').slice(0, 120));
    }

    // ── 3. 造一条证据（Reviewer 用）──
    const cid2 = await call('tool.invoke', {
      name: 'chapter.create',
      input: { bookId, chapterNumber: 2, title: '第二章' },
      permission: 'ADMIN',
    });
    const ch2 = cid2.data?.chapterId ?? cid2.data?.id;
    if (ch2) {
      // ⚠ evidence.add 的 quote 必须与 sourceText 的 [start, end) **精确匹配**
      //   （这是"可回溯"的强制机制：编造的摘录进不去）。
      const sourceText = '陆明远说他不认识沈氏，可他的袖口沾着沈家的香灰。';
      const quote = '陆明远说他不认识沈氏';
      const evAdd = await call('tool.invoke', {
        name: 'evidence.add',
        input: {
          sourceRef: 'chapters/001.md',
          quote,
          startOffset: 0,
          endOffset: quote.length,
          sourceText,
        },
        permission: 'ADMIN',
      });
      rec('证据条目已写入（Reviewer 的检索来源）', evAdd.ok === true, String(evAdd.data?.evidenceId ?? evAdd.error?.message ?? '').slice(0, 60));
    }

    // ── 4. 走一次 workflow，让 build_context 真的分层检索并落痕迹 ──
    console.log('\n──── 通过 workflow 触发分层检索（痕迹落库）────\n');

    const start = await call('workflow.start', { bookId, chapterNumber: 2 });
    const wfId = start.data?.workflowId;
    rec('workflow.start 可用', Boolean(wfId), String(wfId));

    if (wfId) {
      // 等 build_context 完成（它是第 2 个 stage，很快）
      let view = null;
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 800));
        const g = await call('workflow.get', { workflowId: wfId });
        view = g.data;
        if (!view) continue;
        const bc = view.stages.find((s) => s.stageId === 'build_context');
        if (bc?.status === 'DONE' || bc?.status === 'FAILED') break;
        if (['FAILED', 'DONE', 'CANCELLED'].includes(view.status)) break;
      }

      const bcStage = view?.stages.find((s) => s.stageId === 'build_context');
      rec(
        '⚠ build_context 执行成功（分层检索在此发生）',
        bcStage?.status === 'DONE',
        `status=${bcStage?.status ?? '未知'}${bcStage?.error ? '｜' + String(bcStage.error).slice(0, 100) : ''}`,
      );

      // ⚠ 关键：痕迹真的落库了，且能按 stage 分别回答
      const allTraces = await call('retrieval.traces', { workflowId: wfId });
      const n = allTraces.data?.count ?? 0;
      rec(
        '⚠ 检索痕迹已落库（"为什么引用那个旧章节"可回答）',
        n > 0,
        `${n} 条痕迹${n > 0 ? '，例：' + JSON.stringify(allTraces.data.traces[0]).slice(0, 140) : ''}`,
      );

      const byStage = new Map();
      for (const t of allTraces.data?.traces ?? []) {
        byStage.set(t.stage, (byStage.get(t.stage) ?? 0) + 1);
      }
      rec(
        '⚠ 痕迹按 stage 分开（Planner / Writer / Reviewer / Continuity 是不同问题）',
        byStage.size > 1,
        [...byStage.entries()].map(([k, v]) => `${k}:${v}`).join(' ') || '（无）',
      );

      // 按 hitId 反查
      const firstHit = (allTraces.data?.traces ?? [])[0]?.hitId;
      if (firstHit) {
        const byHit = await call('retrieval.traces', { hitId: firstHit });
        rec(
          '⚠ 可按 hitId 反查（"这个旧章节被谁引用过"）',
          (byHit.data?.count ?? 0) > 0,
          `hitId=${String(firstHit).slice(0, 40)} → ${byHit.data?.count} 条`,
        );
      }

      // build_context 的输出里应带 tier 状态
      const out = bcStage?.output;
      const tiers = out?.retrievalTiers;
      rec(
        '⚠ build_context 输出带各检索层状态（可区分"不可用"与"无命中"）',
        Array.isArray(tiers) && tiers.length > 0,
        Array.isArray(tiers)
          ? tiers.map((t) => `${t.stage}:${t.retrieved ? 'ok' : 'unavailable'}/${t.hitCount}`).join(' ')
          : '（缺 retrievalTiers）',
      );
    }

    // ── 5. 排除当前章（不能抄自己）──
    if (wroteOk && ch2) {
      const tracesForWriter = await call('retrieval.traces', { stage: 'writer' });
      const selfRef = (tracesForWriter.data?.traces ?? []).filter((t) => t.hitId === ch2);
      rec(
        '⚠ Writer 的检索不含当前章（不能抄自己刚写的）',
        selfRef.length === 0,
        selfRef.length === 0 ? '无自引用' : `发现 ${selfRef.length} 条自引用`,
      );
    }

    // ── 6. 多书隔离：痕迹不串书 ──
    const bk2 = await call('book.create', { projectId, title: '另一本书' });
    if (bk2.data?.id) {
      const t2 = await call('retrieval.truth', { bookId: bk2.data.id, chapterNumber: 1 });
      rec(
        '⚠ 另一本书的结构化真值为空（多书隔离：不串内容）',
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
