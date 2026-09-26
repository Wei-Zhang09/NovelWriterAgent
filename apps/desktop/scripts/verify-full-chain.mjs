/**
 * 整链联调：开书向导 → 开写 → 编辑 → 审阅 → 定位 → 提交
 *
 *   pnpm verify:chain
 *
 * ## 为什么需要这个脚本
 *
 * 每个环节都有各自的验证脚本，且都通过。但**串起来跑**是另一件事：
 * 分阶段的测试查不出**阶段之间的接线缺失** —— 这不是推测，本项目已实测踩到两次：
 *
 *   - W7：四个生成器在 apps/ 里零引用 → 向导"能生成但无法落库"，
 *     四步永远 NOT_STARTED → 门禁判 NOT_USED → **永远放行**。
 *   - M9：`stalenessReport` 零生产调用 → 提交前检查面板的判定从没拦过人。
 *
 * 所以本脚本的验收标准不是"每步返回 ok"，而是**下游终点**：
 *   向导产出的内容，Writer 在写第 1 章时**真的读到了吗**？
 *   门禁在"未统一确认"时**真的拦住了**吗？
 *   作者改的正文，提交进正史的是**哪一份**？
 *
 * ## 与 verify:writing 的分工
 *
 * `verify:writing` 关注**多章连写的长程记忆**（第 2 章会不会引用第 1 章）。
 * 本脚本关注**单章的全链贯通**，且**必须从向导起步**（verify:writing 直接建书建章，
 * 完全绕过向导与门禁）。
 *
 * ## 为什么必须是 Electron 脚本
 *
 * 密钥经 safeStorage 加密（Windows 上 DPAPI 绑定 userData 路径），只有
 * Electron main 能解；让用户贴明文密钥是不可接受的。
 *
 * @verify-kind: needs-model — 整链含真实模型调用（向导四步 + 规划 + 写作 + 审稿）
 */
import { app, utilityProcess, safeStorage } from 'electron';
import { existsSync, readFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { FileSecretStore, defaultCredentialsPath } from '@nwa/harness';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const coreEntry = join(appRoot, 'dist', 'main', 'core-process.js');

// ── 结果记录 ───────────────────────────────────────────────
const steps = [];
const rec = (name, ok, detail) => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};
const skip = (name, why) => {
  steps.push({ name, ok: true, skipped: true, detail: why });
  console.log(`○ ${name} — 跳过：${why}`);
};

// ── core 子进程通信 ────────────────────────────────────────
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
    switch (op) {
      case 'get':
        reply(true, await store.get(String(p.ref)));
        break;
      case 'isAvailable':
        reply(true, safeStorage.isEncryptionAvailable());
        break;
      default:
        reply(false, undefined, `verify 脚本不执行 ${op} 操作（只读）`);
    }
  } catch (e) {
    reply(false, undefined, e instanceof Error ? e.message : String(e));
  }
}

function call(method, params = {}, timeoutMs = 300_000) {
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

/**
 * 等待 workflow 进入终态。
 *
 * ⚠⚠ `workflow.start` 是 **fire-and-forget**：它立刻返回 `{workflowId, status:'CREATED'}`，
 *   真正的执行在后台跑，**失败不抛异常**，只写进 workflow 记录。
 *
 *   实测踩到（本脚本第一版）：断言 `ws.ok === true` 就以为"门禁拦住了"，
 *   而它返回的是 `{status:'CREATED'}` —— 门禁**确实**拦了（core 日志里有
 *   BLUEPRINT_NOT_CONFIRMED），但拦在后台的 plan stage 里，IPC 返回的 ok 与
 *   拦截无关。断言查错了层（约定②）。
 *
 *   正确做法：轮询 `workflow.get` 直到 status 属于 TERMINAL_STATUSES。
 */
const TERMINAL_STATUSES = ['DONE', 'FAILED', 'CANCELLED'];
async function waitWorkflow(workflowId, timeoutMs = 900_000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const r = await call('workflow.get', { workflowId });
    last = r.data ?? last;
    if (last && TERMINAL_STATUSES.includes(last.status)) return last;
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  return last ?? { status: 'TIMEOUT' };
}

/** 从 workflow.get 的 stage 列表里挑出失败的那个（诊断用） */
function failedStage(wf) {
  const stages = wf?.stages ?? [];
  const bad = stages.find((s) => s.status === 'FAILED');
  if (!bad) return '';
  // ⚠ 字段名是 `stageId`（不是 `stage`）；`error` 已是字符串（IPC 层做过 .message）。
  const err = bad.error ?? bad.errorMessage ?? '';
  return `${bad.stageId}: ${String(err).slice(0, 140)}`;
}

/**
 * 只读查库（脚本侧诊断用）。
 *
 * ⚠ 仅用于**只读**核对 IPC 是否暴露了某个字段 —— 产品代码的问题不在这里修。
 */
function dbAll(sql, ...args) {
  const db = new DatabaseSync(join(ISOLATED_ROOT, 'project.db'));
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
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
      if (msg?.kind === 'crypto-request') void handleCrypto(msg);
    });
    child.on('spawn', () => setTimeout(resolve, 1500));
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`core 退出码 ${code}`));
    });
  });
}

app.on('window-all-closed', () => {});
// ⚠ 与真实应用对齐 userData（safeStorage 作用域绑定 app name/userData）
app.setName('@nwa/desktop');
app.setPath('userData', join(app.getPath('appData'), '@nwa/desktop'));

// ⚠ 强制隔离：走真实 IPC 而 IPC 的 PROJECTS_ROOT 默认是用户的
//   ~/NovelWriterProjects。不隔离就会往真实创作目录写数据。
const ISOLATED_ROOT = join(app.getPath('temp'), 'nwa-verify-chain');

// ⚠ 清理失败必须给出**可操作**的提示，不能只抛 EPERM。
//
//   实测踩到：上一次运行被强杀后 SQLite 的 WAL 文件仍被占用，
//   `rmSync` 抛 `EPERM ... nwa-verify-chain`，而错误信息里看不出
//   "有残留进程占着" —— 排查成本很高（还白等了几分钟）。
function freshIsolatedRoot() {
  try {
    rmSync(ISOLATED_ROOT, { recursive: true, force: true });
  } catch (e) {
    console.error(
      `\n✗ 无法清空隔离目录（多半是上一次运行被强杀，仍有 Electron/Node 进程占着它）：\n` +
        `    ${ISOLATED_ROOT}\n` +
        `    原因：${e instanceof Error ? e.message : String(e)}\n` +
        `    处理：先结束残留进程再重跑 ——\n` +
        `      powershell -NoProfile -Command "Get-CimInstance Win32_Process | ` +
        `Where-Object { \$_.Name -in @('electron.exe','node.exe') -and ` +
        `\$_.CommandLine -like '*NovelWriterAgent*' } | Stop-Process -Force"\n` +
        `    说明：只杀本项目的 electron/node —— 本机可能同时跑着其他 Electron 应用，\n` +
        `          不可用 taskkill /IM electron.exe 一把杀（会误伤别人）。\n`,
    );
    app.exit(2);
    return false;
  }
  mkdirSync(ISOLATED_ROOT, { recursive: true });
  return true;
}
if (!freshIsolatedRoot()) {
  // app.exit 是异步的，这里显式停住后续初始化
  throw new Error('隔离目录不可用');
}
process.env['NWA_PROJECTS_ROOT'] = ISOLATED_ROOT;

// ── 都市题材的输入（作者视角的诉求，不是给模型的答案）────────
const GENRE = '都市';
const CREATION_INTENT = {
  desiredEmotion: '意难平 —— 读者看完会想"如果当初他做了另一个选择"',
  strengths: '生活经验丰富：在城中村租过房、跑过外卖、见过深夜的便利店',
  reference: '《我在他乡挺好的》那种都市质感，但更冷一点',
  genre: GENRE,
};

function finish() {
  const failed = steps.filter((s) => !s.ok);
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`结果：${steps.length - failed.length}/${steps.length} 通过`);
  if (failed.length > 0) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  - ${f.name}：${f.detail}`);
  }
  console.log(`隔离目录：${ISOLATED_ROOT}`);
  try {
    child?.kill();
  } catch {
    /* ignore */
  }
  setTimeout(() => app.exit(failed.length > 0 ? 1 : 0), 300);
}

app.whenReady().then(async () => {
  try {
    // 模型配置从用户真实目录**只读**读取
    const modelsJson = join(homedir(), 'NovelWriterProjects', 'models.json');
    if (!existsSync(modelsJson)) {
      rec('找到模型配置', false, '请先在桌面端「模型设置」保存');
      return finish();
    }
    const cfg = JSON.parse(readFileSync(modelsJson, 'utf8'));
    const prof = cfg.profiles?.[0];
    if (!prof) {
      rec('找到模型配置', false, '无 profile');
      return finish();
    }
    rec('找到模型配置', true, `${prof.model} @ ${prof.endpoint}`);

    await startCore();
    const opened = await call('project.open', {});
    rec('core 启动且模型就绪', opened.data?.agentReady === true, `agentReady=${opened.data?.agentReady}`);

    // ── 准备项目与书 ──────────────────────────────────────
    const info = await call('project.info', {});
    let projectId = info.data?.projects?.[0]?.id;
    if (!projectId) {
      const np = await call('tool.invoke', {
        name: 'project.create',
        input: { name: '整链联调', genre: GENRE },
        permission: 'ADMIN',
      });
      projectId = np.data?.id ?? np.data?.projectId;
      if (!projectId) projectId = (await call('project.info', {})).data?.projects?.[0]?.id;
    }
    if (!projectId) {
      rec('准备项目', false, '无法创建项目');
      return finish();
    }
    rec('准备项目', true, projectId);

    const nb = await call('book.create', { projectId, title: '深夜配送' });
    const bookId = nb.data?.id ?? nb.data?.bookId;
    if (!bookId) {
      rec('建书', false, JSON.stringify(nb).slice(0, 200));
      return finish();
    }
    rec('建书（都市题材）', true, `${bookId} · 《深夜配送》`);

    // ── 门禁初始态：应是启用的（迁移默认 1）──────────────────
    let st = (await call('blueprint.status', { bookId })).data ?? {};
    rec(
      '向导门禁初始为启用（迁移默认 1）',
      st.gateEnabled === true,
      `gateEnabled=${st.gateEnabled}`,
    );
    rec(
      '四步初始全为 NOT_STARTED',
      (st.steps ?? []).every((s) => s.status === 'NOT_STARTED'),
      (st.steps ?? []).map((s) => `${s.step}:${s.status}`).join(' '),
    );
    rec(
      '未用向导时门禁放行（NOT_USED —— 用户决策：向导可选）',
      st.allowed === true && st.reason === 'NOT_USED',
      `allowed=${st.allowed} reason=${st.reason}`,
    );

    // ═══ 步骤 1：Phase 1 选题方向 ═══════════════════════════
    console.log('\n════════ Phase 1：生成选题方向 ════════');
    const cg = await call('blueprint.generateConcept', { bookId, params: CREATION_INTENT });
    const candidates = cg.data?.candidates ?? [];
    rec(
      '生成选题候选（真实模型）',
      cg.ok && candidates.length >= 1,
      cg.ok ? `${candidates.length} 个候选` : `IPC：${cg.error?.code}：${cg.error?.message}`,
    );
    if (candidates.length === 0) return finish();

    // 语义约束：候选必须题材不同（否则作者无从选择）
    const genres = new Set(candidates.map((c) => c.genre));
    rec(
      '候选题材有差异（不是同一个题材换说法）',
      candidates.length === 1 || genres.size > 1,
      [...genres].join(' / '),
    );
    const c0 = candidates[0];
    rec('候选 0 字段完整（pitch/genre/主角/冲突/差异化）', 
      Boolean(c0.pitch && c0.genre && c0.protagonist && c0.coreConflict && c0.differentiation),
      `题材=${c0.genre}｜${String(c0.pitch).slice(0, 40)}…`);
    console.log(`\n【作者选定的方向】\n  卖点：${c0.pitch}\n  情绪：${c0.coreEmotion}\n  主角：${c0.protagonist}\n  冲突：${c0.coreConflict}\n`);

    const chosen = await call('blueprint.chooseConcept', { bookId, candidate: c0 });
    rec('选定候选 → 落库为 CONCEPT 草稿', chosen.ok && chosen.data?.status === 'GENERATED',
      `status=${chosen.data?.status}`);

    // ═══ 门禁必须开始拦人（关键断言）═══════════════════════
    st = (await call('blueprint.status', { bookId })).data ?? {};
    rec(
      '⚠⚠ 用了向导但未统一确认 → 门禁必须拦（NEVER_CONFIRMED）',
      st.allowed === false && st.reason === 'NEVER_CONFIRMED',
      `allowed=${st.allowed} reason=${st.reason}｜未完成=${(st.unfinished ?? []).join(',')}`,
    );

    // 负向：此时开写必须**真的跑不起来**（门禁接线）。
    // ⚠ 必须轮询终态 —— start 立刻返回 CREATED，拦截发生在后台的 plan stage。
    const blockedStart = await call('workflow.start', { bookId, chapterNumber: 1 });
    const blockedWfId = blockedStart.data?.workflowId;
    const blockedWf = blockedWfId ? await waitWorkflow(blockedWfId, 180_000) : null;
    const bStage = failedStage(blockedWf);
    rec(
      '⚠⚠ 门禁真的拦住开写（workflow 终态为 FAILED，拦在 plan stage）',
      blockedWf?.status === 'FAILED',
      `status=${blockedWf?.status}｜失败 stage=${bStage || '（无）'}`,
    );
    rec(
      '拦截原因是「未统一确认」（不是别的错）',
      bStage.includes('尚未统一确认') || bStage.includes('开书向导'),
      `失败 stage=${bStage || '（无）'}`,
    );

    // ═══ 步骤 2：Phase 2 核心设定 + 角色 ════════════════════
    console.log('\n════════ Phase 2：生成核心设定与角色 ════════');
    const sg = await call('blueprint.generateSettings', { bookId });
    // ⚠ 服务层返回的是**平铺**的 {characters, worldEntities, conflicts}，
    //   不是 {output:{...}}（与 generateConcept 的 {candidates} 一致）。
    //   第一版按 output 读 → 恒为 undefined，看起来像"生成失败"。
    const characters = sg.data?.characters ?? [];
    const worldEntities = sg.data?.worldEntities ?? [];
    rec(
      '生成核心设定（真实模型）',
      sg.ok && characters.length > 0,
      sg.ok ? `角色 ${characters.length} 个 / 世界条目 ${worldEntities.length} 个` : `IPC：${sg.error?.code}：${sg.error?.message}`,
    );
    if (characters.length === 0) return finish();

    const charNames = characters.map((c) => c.name);
    rec('角色有名字（后续写作要用）', charNames.length > 0, charNames.join('、'));
    console.log(`\n【AI 提议的角色】`);
    for (const c of characters) {
      console.log(`  ${c.name}（${c.role ?? '未定角色'}）：${String(c.profile?.性格 ?? c.profile?.背景 ?? '').slice(0, 50)}`);
    }
    const conflicts = sg.data?.conflicts ?? [];
    rec('冲突检出结果返回给作者（用户决策：逐条让作者选）', Array.isArray(conflicts),
      `${conflicts.length} 条冲突`);
    if (sg.data?.issues?.length) {
      console.log(`  （模型自报的语义问题：${sg.data.issues.join('；')}）`);
    }

    // 冲突决策：用户决策是"先弹窗逐条让我选"；联调里按"保留 AI 的"走。
    // ⚠ 决定键的形状必须与 materializeSettings 的期望一致 ——
    //   键写错不会报错，只会"保守跳过"，表现为"生成成功但没落库"。
    const decisions = {};
    for (const c of characters) decisions[`character:${c.name}`] = 'use_new';
    for (const w of worldEntities) decisions[`world:${w.name}`] = 'use_new';
    for (const cf of conflicts) decisions[String(cf.key ?? cf.id ?? '')] = 'use_new';
    const mat = await call('blueprint.materializeSettings', {
      bookId,
      // ⚠ 传**完整的 SETTINGS 输出**（含 logline/coreConflict）——
      //   只传 characters/worldEntities 会缺 logline，物化时被 schema 拒。
      output: { logline: sg.data?.logline ?? '', coreConflict: sg.data?.coreConflict ?? '', characters, worldEntities },
      decisions,
      knownConflicts: conflicts.map((c) => String(c.key ?? c.id ?? c.name ?? '')),
    });
    rec(
      '⚠⚠ 设定落进正式表（characters/world_entities —— 后续 prompt 读的是这张表）',
      mat.ok,
      mat.ok
        ? `角色 ${mat.data?.characters ?? '?'} / 世界 ${mat.data?.worldEntities ?? '?'}`
        : `IPC：${mat.error?.message}`,
    );

    // 关键：落库的设定必须能被后续读到（不是只返回个 ok）
    const listed = await call('tool.invoke', {
      name: 'character.list',
      input: { bookId },
      permission: 'ADMIN',
    });
    const persisted = listed.data?.characters ?? listed.data?.items ?? [];
    const persistedNames = persisted.map((c) => c.name);
    rec(
      '⚠⚠ 角色真的进了库（下游终点，不是只看返回值）',
      persisted.length > 0,
      `库里 ${persisted.length} 个：${persistedNames.join('、')}`,
    );

    // ═══ 步骤 3：Phase 3 卷级大纲 + 逐章细纲 ════════════════
    console.log('\n════════ Phase 3：卷级大纲 + 逐章细纲 ════════');
    const og = await call('blueprint.generateOutline', { bookId });
    const vols = og.data?.volumes ?? [];
    rec('生成卷级大纲（真实模型）', og.ok && vols.length > 0,
      og.ok ? `卷数=${vols.length}｜${vols.map((v) => String(v.title ?? v.name ?? '?')).join('、')}` : `IPC：${og.error?.code}：${og.error?.message}`);

    const dg = await call('blueprint.generateChapterOutlines', {
      bookId,
      startChapter: 1,
      endChapter: 2,
    });
    const dgOut = dg.data ?? {};
    const dgCount = Number(
      dgOut.count ?? (Array.isArray(dgOut.chapters) ? dgOut.chapters.length : NaN) ??
        (Array.isArray(dgOut.volumes) ? dgOut.volumes.reduce((a, v) => a + (v.chapters ?? []).length, 0) : NaN),
    );
    rec(
      '生成逐章细纲（第 1–2 章）',
      dg.ok && (Number.isFinite(dgCount) ? dgCount > 0 : true),
      dg.ok ? `章数=${Number.isFinite(dgCount) ? dgCount : '?'}｜返回键=${Object.keys(dgOut).join(',')}` : `IPC：${dg.error?.code}：${dg.error?.message}`,
    );

    const outlineStep = (await call('blueprint.getStep', { bookId, step: 'DETAIL' })).data;
    rec(
      '⚠⚠ 细纲落库且可读回（下游终点）',
      Boolean(outlineStep?.content),
      outlineStep ? `status=${outlineStep.status}｜内容长度=${JSON.stringify(outlineStep.content ?? '').length}` : '读不到',
    );

    // ═══ 步骤 3.5：世界观设定确认（**第二道门禁**）══════════════
    //
    // ⚠⚠ 实测发现：`materializeSettings` 落进正式表后，还有一道
    //   `SETTINGS_NOT_CONFIRMED` 门禁 —— 与开书向导门禁**是两道独立的门**。
    //   第一版脚本漏了这一步，整章工作流直接 FAILED 在 plan stage：
    //   「已登记 6 条设定但尚未确认。请先在「世界观设定」面板确认」。
    //
    //   这正是整链联调的价值：两个功能各自都验证过，但没人跑过
    //   「向导确认 → 设定确认 → 开写」这个**真实顺序**。
    console.log('\n════════ 世界观设定确认（第二道门禁）════════');
    const sconf = await call('settings.confirm', { bookId });
    rec('确认世界观设定', sconf.ok && sconf.data?.confirmed === true,
      sconf.ok ? `已确认 ${sconf.data?.count} 条` : `IPC：${sconf.error?.code}：${sconf.error?.message}`);

    // ═══ 步骤 4：统一确认 → 门禁放行 ════════════════════════
    console.log('\n════════ 统一确认前置信息 ════════');
    const conf = await call('blueprint.confirmAll', { bookId });
    // ⚠ confirmAll 的 `steps` 是**确认的步骤数**（number），不是步骤名数组。
    rec('统一确认全部前置信息', conf.ok && conf.data?.confirmed === true,
      conf.ok ? `确认 ${conf.data?.steps} 步｜hash=${String(conf.data?.hash).slice(0, 12)}` : `IPC：${conf.error?.code}：${conf.error?.message}`);

    st = (await call('blueprint.status', { bookId })).data ?? {};
    rec(
      '⚠⚠ 统一确认后门禁放行（CONFIRMED）',
      st.allowed === true && st.reason === 'CONFIRMED',
      `allowed=${st.allowed} reason=${st.reason}`,
    );

    // ═══ 步骤 5：开写（整章工作流）══════════════════════════
    console.log('\n════════ 开写第 1 章（12 个 stage）════════');

    // 先拿到 chapterId（工作流的 create_chapter 会建它；这里预解析便于后续步骤引用）
    const chPre = await call('tool.invoke', { name: 'chapter.list', input: { bookId }, permission: 'ADMIN' });
    const ch1IdEarly = (chPre.data?.chapters ?? []).find((c) => c.chapterNumber === 1)?.id;
    const ws = await call('workflow.start', { bookId, chapterNumber: 1 });
    rec('workflow.start 已受理（立即返回 workflowId）', Boolean(ws.data?.workflowId),
      `workflowId=${ws.data?.workflowId}`);
    let wd = await waitWorkflow(ws.data?.workflowId, 900_000);

    // ⚠⚠ 若卡在 ready_to_commit 且原因是「章节摘要为空」，必须**补摘要后 resume**。
    //
    //   实测发现：12 个 stage 里**没有生成摘要的 stage**，但 ready_to_commit
    //   把「摘要为空」当阻塞 → 工作流必然 FAILED。作者只能手动补摘要再恢复。
    //   这是真实使用路径，脚本必须走一遍（否则测不到 resume 是否可用）。
    const firstFail = failedStage(wd);
    if (wd?.status === 'FAILED' && firstFail.includes('摘要')) {
      console.log('\n【工作流卡在摘要门禁 —— 按真实路径补摘要后恢复】');
      const gen = await call('summary.generate', { chapterId: ch1IdEarly }, 300_000);
      rec('生成章节摘要（工作流外手动补）', gen.ok,
        gen.ok ? `摘要 ${String(gen.data?.summary ?? '').length} 字` : `IPC：${gen.error?.code}：${gen.error?.message}`);

      const apr = await call('summary.approve', { chapterId: ch1IdEarly });
      rec('批准摘要', apr.ok, apr.ok ? `indexed=${apr.data?.indexed}` : `IPC：${apr.error?.code}：${apr.error?.message}`);

      const rz = await call('workflow.resume', { workflowId: ws.data?.workflowId });
      rec('恢复工作流（workflow.resume）', rz.ok, `status=${rz.data?.status}`);
      wd = await waitWorkflow(ws.data?.workflowId, 900_000);
    }

    rec(
      '⚠⚠ 整章工作流跑到终态 DONE（12 个 stage 全过）',
      wd?.status === 'DONE',
      `status=${wd?.status}${wd?.status !== 'DONE' ? '｜失败 stage=' + failedStage(wd) : ''}`,
    );
    const stageList = wd?.stages ?? [];
    if (stageList.length > 0) {
      console.log(`  stage 进度：${stageList.map((x) => `${x.stageId}:${x.status}`).join(' ')}`);
      rec(
        '12 个 stage 全部 COMPLETED（没有停在中间）',
        stageList.length === 12 && stageList.every((x) => x.status === 'COMPLETED'),
        `${stageList.filter((x) => x.status === 'COMPLETED').length}/${stageList.length} COMPLETED`,
      );
    } else {
      rec('12 个 stage 全部 COMPLETED（没有停在中间）', false, '拿不到 stage 列表');
    }

    // 找第 1 章
    const chList = await call('tool.invoke', { name: 'chapter.list', input: { bookId }, permission: 'ADMIN' });
    const ch1 = (chList.data?.chapters ?? []).find((c) => c.chapterNumber === 1);
    if (!ch1) {
      rec('第 1 章已建', false, JSON.stringify(chList.data).slice(0, 200));
      return finish();
    }
    rec('第 1 章已建', true, `${ch1.id}｜status=${ch1.status}`);

    // ⚠⚠⚠ 核心断言：工作流写出的 AI 正文，**编辑器能不能看到**。
    //
    //   实测发现（本轮最重要的一条）：工作流的 write/revision stage 把正文写进
    //   `draft.md` / `revision.md`，而 `manuscript.open`（编辑器正文来源）
    //   只读 `manuscript.md` —— 该文件在跑完工作流后**根本不存在**。
    //   于是：AI 写了 10,024 字节，作者打开编辑器看到的是**空的**，
    //   点「保存」还会用空正文覆盖/新建 manuscript.md。
    //
    //   这里同时读两条路径，把差异摆出来（不是猜，是实测）。
    const mo = await call('manuscript.open', { chapterId: ch1.id });
    const body = mo.data?.text ?? '';
    const wsDir = join(ISOLATED_ROOT, 'books', bookId, 'workspace', 'chapter-001');
    const sizeOf = (f) => (existsSync(join(wsDir, f)) ? statSync(join(wsDir, f)).size : -1);
    const draftSize = sizeOf('draft.md');
    const revisionSize = sizeOf('revision.md');
    const manSize = sizeOf('manuscript.md');

    rec(
      '工作流写出了 AI 正文（draft/revision 落盘）',
      draftSize > 0,
      `draft.md=${draftSize}B revision.md=${revisionSize}B manuscript.md=${manSize}B`,
    );

    rec(
      '⚠⚠⚠ 编辑器读到的正文 == 工作流写出的正文（下游终点）',
      body.length > 0 && draftSize > 0,
      body.length > 0
        ? `编辑器 ${body.length} 字`
        : `编辑器 0 字，但 draft.md 有 ${draftSize} 字节 —— ` +
          `工作流写 draft/revision，manuscript.open 只读 manuscript.md（该文件未生成）`,
    );

    // ⚠⚠ 向导产出被 Writer 真的读到了吗（下游终点）
    //   做法：正文里是否出现设定里的角色名。这不是完美证据（模型可能不用），
    //   但"一个都没出现"就是强信号：前置内容没进 prompt。
    // ⚠ 正文为空时这条断言**无法成立**，但它失败的原因是上游缺陷（A），
    //   不是"前置内容没进 prompt"。分开报告，避免把根因指错方向。
    if (body.length === 0) {
      skip(
        '正文用到了设定里的角色（下游终点：前置内容进了 prompt）',
        '正文为空（被缺陷 A 阻塞）—— 待缺陷修复后此断言才有意义',
      );
    } else {
      const hitChars = persistedNames.filter((n) => body.includes(n));
      rec(
        '⚠⚠ 正文用到了设定里的角色（下游终点：前置内容进了 prompt）',
        hitChars.length > 0,
        `命中 ${hitChars.length}/${persistedNames.length}：${hitChars.join('、') || '（一个都没出现）'}`,
      );
    }

    rec('第 1 章状态为 COMMITTED', ch1.status === 'COMMITTED', `status=${ch1.status}`);

    // ═══ 步骤 6：编辑（作者改正文）══════════════════════════
    console.log('\n════════ 编辑：作者改正文 ════════');
    const edited = body + '\n\n（作者补写：他把保温箱的扣子重新扣了一遍。）';
    const sv = await call('manuscript.save', { chapterId: ch1.id, text: edited });
    rec('保存作者修改', sv.ok, sv.ok ? `changed=${sv.data?.changed} bytes=${sv.data?.bytes}` : `IPC：${sv.error?.message}`);

    const mo2 = await call('manuscript.open', { chapterId: ch1.id });
    rec(
      '⚠⚠ 重新打开读到的就是作者改后的正文（下游终点）',
      (mo2.data?.text ?? '').includes('保温箱的扣子'),
      `长度 ${(mo2.data?.text ?? '').length}`,
    );

    const vers = await call('manuscript.listVersions', { chapterId: ch1.id });
    const vlist = vers.data?.versions ?? [];
    rec('保存产生了版本节点', vlist.length > 0,
      vlist.map((v) => v.sourceType).join(' / '));

    // ═══ 步骤 7：审阅 ═══════════════════════════════════════
    console.log('\n════════ 审阅 ════════');
    const rv = await call('review.run', { chapterId: ch1.id }, 600_000);
    rec('审阅跑完（真实模型）', rv.ok,
      rv.ok ? `overall=${rv.data?.overall ?? rv.data?.status ?? '?'}｜issues=${rv.data?.issueCount ?? '?'}` : `IPC：${rv.error?.message}`);

    const rg = await call('review.get', { chapterId: ch1.id });
    const issues = rg.data?.review?.issues ?? rg.data?.issues ?? [];
    rec('审阅结论可读回', rg.ok && issues.length >= 0, `${issues.length} 条 issue`);

    // ⚠⚠ M8 定位联动：issue 的 location 必须能对上**编辑器里的正文**
    const withLoc = issues.filter((i) => i.location && (i.location.excerpt || i.location.offset !== null));
    if (withLoc.length === 0) {
      skip('Issue 定位能对上正文（M8）', `本次审阅没有带 location 的 issue（共 ${issues.length} 条）`);
    } else {
      const cur = mo2.data?.text ?? '';
      const exact = withLoc.filter((i) => cur.includes(String(i.location.excerpt ?? '')));
      rec(
        '⚠⚠ Issue 的 excerpt 能在当前正文里找到（M8 定位的下游终点）',
        exact.length > 0,
        `${exact.length}/${withLoc.length} 条能对上｜例：「${String(withLoc[0].location.excerpt).slice(0, 24)}」`,
      );
    }

    // ═══ 步骤 8：提交前检查（M9）════════════════════════════
    console.log('\n════════ 提交前检查 ════════');
    const pc = await call('commit.precheck', { chapterId: ch1.id });
    const items = pc.data?.checks ?? pc.data?.items ?? [];
    rec('commit.precheck 可用（M9）', pc.ok && items.length > 0,
      pc.ok ? `${items.length} 项检查｜${items.map((i) => `${i.key ?? i.id}:${i.ok ? '✓' : '✗'}`).join(' ')}` : `IPC：${pc.error?.message}`);

    const blocking = items.filter((i) => !i.ok);
    rec(
      '⚠⚠ 改过正文后，检查项如实反映「需重新审阅」（stale 判定真的在起作用）',
      blocking.length > 0,
      blocking.length > 0
        ? `未通过 ${blocking.length} 项：${blocking.map((i) => i.key ?? i.id).join('、')}`
        : '全部通过 —— 但作者刚改过正文，审阅结论应该已失效',
    );

    // ═══ 步骤 9：提交 ═══════════════════════════════════════
    console.log('\n════════ 提交到正史 ════════');
    const cm = await call('commit.run', { chapterId: ch1.id }, 600_000);
    rec('提交跑完', cm.ok, cm.ok ? `ok=${cm.data?.ok} artifacts=${(cm.data?.artifacts ?? []).length}` : `IPC：${cm.error?.code}：${cm.error?.message}`);

    // ⚠⚠⚠ 提交后：**正史里**的正文是哪一份。
    //
    //   实测踩到（本脚本自己的假绿，与 proc_e099bfe8f6c5 那次日志对照才发现）：
    //   第一版读的是 `manuscript.open` 的文本 —— 那是**编辑器**的内容，
    //   而作者刚才的保存已经把 manuscript.md 覆盖成含「保温箱的扣子」的文本。
    //   于是这条断言**恒真**，连「提交被拒（ok=false）」时都照样通过。
    //
    //   必须读**正史文件本身**（chapters/NNN.md）+ 清单里记录的来源。
    const canonPath = join(ISOLATED_ROOT, 'books', bookId, 'chapters', '001.md');
    const canonText = existsSync(canonPath) ? readFileSync(canonPath, 'utf8') : '';
    const chAfterCommit = await call('tool.invoke', { name: 'chapter.list', input: { bookId }, permission: 'ADMIN' });
    const ch1Row = (chAfterCommit.data?.chapters ?? []).find((c) => c.chapterNumber === 1);
    const committedNow = ch1Row?.status === 'COMMITTED';

    // ⚠ 这条必须**按提交结果分叉**，否则会在"提交被正确拦住"时报假红：
    //   提交失败时正史为空是**正确行为**，不是缺陷。
    if (committedNow) {
      rec(
        '⚠⚠⚠ 正史文件里的正文 == 作者改后的那一份（下游终点：读 chapters/001.md）',
        canonText.includes('保温箱的扣子'),
        `chapters/001.md = ${canonText.length} 字符｜含作者补写=${canonText.includes('保温箱的扣子')}｜status=${ch1Row?.status}`,
      );
    } else {
      rec(
        '⚠⚠ 提交未成功（被门禁拦住）→ 正史必须为空，且磁盘正文仍在工作区',
        canonText.length === 0,
        `status=${ch1Row?.status}｜chapters/001.md ${canonText.length} 字符｜` +
          `工作区正文未丢=${finalText.length > 0}`,
      );
    }

    const chAfter = await call('tool.invoke', { name: 'chapter.list', input: { bookId }, permission: 'ADMIN' });
    const ch1After = (chAfter.data?.chapters ?? []).find((c) => c.chapterNumber === 1);
    rec('第 1 章最终为 COMMITTED', ch1After?.status === 'COMMITTED', `status=${ch1After?.status}`);

    // ⚠⚠ 提交清单必须如实记录「这次提交的是哪份稿」（ADR-0008 决策 1）。
    //   实测：它记录得**正确**（source='manuscript.md'）——
    //   缺陷在于工作流从不写 manuscript.md，不是清单记错。
    //   所以这条断言查的是"可追溯性"，同时把 source 摆出来作为缺陷 A 的证据。
    // ⚠ `commit.list`（workspace.listCommits）的 outputSchema **不投影 source 列** ——
    //   它的 SELECT 只取 id/chapter_id/status/phase/commit_mode。
    //   `source` 是 ADR-0008 决策 1 专门加的可追溯字段，却拿不到 ——
    //   这里直接读库（只读），并在脚本里如实标注该缺口。
    const cmRec = await call('commit.list', { chapterId: ch1.id });
    const manifests = cmRec.data?.manifests ?? [];
    const last = manifests[0];
    let sourceVia = 'commit.list';
    let lastSource = last?.source;
    if (lastSource === undefined) {
      // 回退：直接查库（只读）
      try {
        const rows = dbAll(
          'SELECT source FROM commit_manifests WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1',
          ch1.id,
        );
        lastSource = rows[0]?.source;
        sourceVia = '直接读库（commit.list 未投影 source）';
      } catch {
        /* ignore */
      }
    }
    if (committedNow) {
      rec(
        '提交清单记录了实际来源（可追溯「这次提交的是哪份稿」）',
        Boolean(lastSource),
        `source=${lastSource}｜status=${last?.status}｜取法=${sourceVia}`,
      );
    } else {
      // 提交未成功 → 不该有 COMMITTED 清单（有才说明门禁没拦住）
      rec(
        '⚠⚠ 提交未成功时不应产生 COMMITTED 清单（门禁真的拦住了）',
        !last || last.status !== 'COMMITTED',
        `manifests=${manifests.length}｜last.status=${last?.status ?? '(无)'}`,
      );
    }
    if (lastSource === undefined && last) {
      console.log('  ⚠ commit.list 未返回 source 字段 —— ADR-0008 加的可追溯字段在 IPC 层不可见');
    }
    if (last?.source === 'manuscript.md' && canonText.length > 0 && draftSize > 0 && canonText.length * 3 < draftSize) {
      console.log(
        `  ⚠ 注意：来源是 manuscript.md（${canonText.length} 字符），` +
          `而 draft.md 有 ${draftSize} 字节 —— 工作流写 draft 但从不写 manuscript，` +
          `正史因此只收到作者那一段。`,
      );
    }

    // ═══ 步骤 10：多书隔离（用户硬要求）═════════════════════
    console.log('\n════════ 多书隔离核对 ════════');
    const nb2 = await call('book.create', { projectId, title: '第二本书' });
    const bookId2 = nb2.data?.id ?? nb2.data?.bookId;
    if (!bookId2) {
      rec('建第二本书', false, JSON.stringify(nb2).slice(0, 150));
    } else {
      const st2 = (await call('blueprint.status', { bookId: bookId2 })).data ?? {};
      rec(
        '⚠⚠ 新书的向导状态与第一本互不污染（NOT_STARTED）',
        (st2.steps ?? []).every((s) => s.status === 'NOT_STARTED') && st2.gateEnabled === true,
        (st2.steps ?? []).map((s) => `${s.step}:${s.status}`).join(' '),
      );
      const chList2 = await call('tool.invoke', { name: 'chapter.list', input: { bookId: bookId2 }, permission: 'ADMIN' });
      rec(
        '⚠⚠ 新书看不到第一本的章节（按书隔离）',
        (chList2.data?.chapters ?? []).length === 0,
        `章节数=${(chList2.data?.chapters ?? []).length}`,
      );
      // 落盘路径必须按书分开
      const booksDir = join(ISOLATED_ROOT, 'books');
      const dirs = existsSync(booksDir) ? readdirSync(booksDir) : [];
      rec(
        '⚠⚠ 磁盘上按书分目录（books/<bookId>/）',
        dirs.includes(bookId) && dirs.includes(bookId2),
        `books/ 下 ${dirs.length} 个目录`,
      );
    }

    finish();
  } catch (e) {
    rec('未捕获异常', false, e instanceof Error ? (e.stack ?? e.message) : String(e));
    finish();
  }
});
