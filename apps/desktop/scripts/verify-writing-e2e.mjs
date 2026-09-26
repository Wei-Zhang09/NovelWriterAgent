/**
 * 端到端真实写作验证：多章连写，检验**长程记忆是否生效**
 *
 *   pnpm verify:writing -- --chapters=3
 *
 * ## 这个脚本要回答的唯一问题
 *
 * 单章跑通只能证明"链路不崩"。真正要验证的是：
 *   **第 2 章会不会引用第 1 章确立的设定？**
 *
 * 实测背景：单章时 `上下文 80 tokens` —— 模型几乎无材料可用，凭 prompt
 * 自行创作。这种状态下第 1 章看不出问题，但第 2 章若又造一批新人物，
 * 就说明上下文装配链路有实质缺陷（长程记忆没接上）。
 *
 * 因此本脚本会：
 *   1. 逐章跑完整链路（装配 → 规划 → 写作 → 审稿 → 提交 → 摘要确认）
 *   2. 记录每章上下文 token 数与**长程记忆条数**
 *   3. 第 2 章起，把产出与第 1 章的角色名做交叉检查
 *
 * ## 为什么必须是 Electron 脚本
 *
 * 密钥经 safeStorage 加密（Windows 上 DPAPI 绑定 userData 路径），
 * 只有 Electron main 能解；让用户贴明文密钥是不可接受的。
 *
 * @verify-kind: needs-model — 必须真实模型写多章，才能验证上下文预算与长程记忆
 */
import { app, utilityProcess, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { FileSecretStore, defaultCredentialsPath } from '@nwa/harness';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const coreEntry = join(appRoot, 'dist', 'main', 'core-process.js');
const OUT = join(appRoot, 'dist', 'writing-verify-result.json');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
const chapters = Number(arg('chapters', '3'));

const PLACEHOLDER = /待确认|待定|TODO|TBD|待填写|此处填|占位/;

const steps = [];
const rec = (name, ok, detail) => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

let child = null;
let seq = 0;
const pending = new Map();

// ── 扮演 main：应答 core 的加解密请求 ───────────────────────
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

function call(method, params = {}, timeoutMs = 240_000) {
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

// ⚠ 验证脚本必须写入**隔离目录**，不能污染用户的真实项目。
//
// 实测踩到：verify-gui / verify-writing 走真实 IPC，而 IPC 用固定的
// PROJECTS_ROOT，于是每次验证都往用户的 NovelWriterProjects 里写数据 ——
// 结果是 24 本重名「测试小说」和 23 个重复的「第1章」。
// 现在 core-process 支持 NWA_PROJECTS_ROOT 覆盖，这里强制指向临时目录。
const ISOLATED_ROOT = join(app.getPath('temp'), 'nwa-verify-writing');

// ⚠⚠ 每次验证前必须**清空**隔离目录。
//
// 实测踩到：脚本只 mkdir，从不清理。于是第二次运行时，上一次留下的
// 章节还是 COMMITTED 状态，而 `chapter.plan` 明确拒绝为已提交章节
// 覆盖计划 —— 规划步骤直接失败。
//
// 这个失败**看起来像功能坏了**（"规划失败：未分类："），实际是
// 验证脚本自己的残留。排查成本极高，而且每次重跑都要先手动删目录。
//
// 清理是安全的：目录名是本脚本专用的 `nwa-verify-writing`，
// 且路径来自 app.getPath('temp')，不会碰到用户真实项目。
rmSync(ISOLATED_ROOT, { recursive: true, force: true });
mkdirSync(ISOLATED_ROOT, { recursive: true });
process.env['NWA_PROJECTS_ROOT'] = ISOLATED_ROOT;

app.whenReady().then(async () => {
  try {
    // 模型配置仍从用户真实目录读（只读，不写入）
    const modelsJson = join(homedir(), 'NovelWriterProjects', 'models.json');
    if (!existsSync(modelsJson)) {
      rec('找到模型配置', false, '请先在桌面端「模型设置」保存');
      return finish(2);
    }
    const cfg = JSON.parse(readFileSync(modelsJson, 'utf8'));
    const prof = cfg.profiles?.[0];
    rec('找到模型配置', !!prof, prof ? `${prof.model} @ ${prof.endpoint}` : '无 profile');
    if (!prof) return finish(2);

    await startCore();
    const opened = await call('project.open', {});
    rec('项目已打开', opened.ok === true, `tools=${opened.data?.toolCount}`);
    rec('模型已就绪', opened.data?.agentReady === true, `agentReady=${String(opened.data?.agentReady)}`);

    const info = await call('project.info', {});
    let projectId = info.data?.projects?.[0]?.id;
    if (!projectId) {
      // ⚠ 全新项目目录没有 project 行 —— 必须自己建。
      //   项目只在 UI 点「新建项目」时创建，验证脚本在隔离目录里拿到的是
      //   空库（实测踩到：projectId 为 undefined → book.create 的
      //   SQLite 参数绑定失败 "cannot be bound to parameter 1"）。
      const np = await call('tool.invoke', {
        name: 'project.create',
        input: { name: '验证项目', genre: 'urban_fantasy' },
        permission: 'ADMIN',
      });
      projectId = np.data?.id ?? np.data?.projectId;
      if (!projectId) {
        const again = await call('project.info', {});
        projectId = again.data?.projects?.[0]?.id;
      }
    }
    if (!projectId) {
      rec('准备项目', false, '无法创建项目');
      return finish(1);
    }
    rec('准备项目', true, projectId);

    let books = await call('book.list', { projectId });
    let bookId = books.data?.books?.[0]?.id ?? books.data?.[0]?.id;
    if (!bookId) {
      // 隔离目录是全新的 → 自动建书（不影响用户真实项目）
      const nb = await call('book.create', { projectId, title: '验证用书' });
      bookId = nb.data?.id;
      books = await call('book.list', { projectId });
    }
    if (!bookId) {
      rec('准备书', false, JSON.stringify(books).slice(0, 150));
      return finish(1);
    }
    rec('准备书', true, `${bookId}（隔离目录 ${ISOLATED_ROOT}）`);

    console.log(`\n模型：${prof.model}｜章数：${chapters}\n`);

    const perChapter = [];

    for (let n = 1; n <= chapters; n++) {
      console.log(`\n════════ 第 ${n} 章 ════════`);

      // 建章（已存在则复用）
      const list = await call('tool.invoke', {
        name: 'chapter.list',
        input: { bookId },
        permission: 'ADMIN',
      });
      let chapterId = (list.data?.chapters ?? []).find((c) => c.chapterNumber === n)?.id;
      if (!chapterId) {
        const cr = await call('tool.invoke', {
          name: 'chapter.create',
          input: { bookId, chapterNumber: n, title: `第 ${n} 章` },
          permission: 'ADMIN',
        });
        chapterId = cr.data?.chapterId ?? cr.data?.id;
      }
      if (!chapterId) {
        rec(`第 ${n} 章建章`, false, JSON.stringify(list).slice(0, 150));
        break;
      }

      // ⚠ 不调 context.assemble —— 它不接受 chapterId，且是全局 demo，
      //   与 Planner 实际收到的装配结果不是一回事（实测踩到会误判）。
      //   改为直接用 Planner 回报的 contextTokens，并自行统计"可供引用的
      //   前章摘要条数"，这才是长程记忆的真实指标。
      const chForMem = await call('tool.invoke', {
        name: 'chapter.list',
        input: { bookId },
        permission: 'ADMIN',
      });
      const priorSummaries = (chForMem.data?.chapters ?? []).filter(
        (c) => c.status === 'COMMITTED' && c.chapterNumber < n && c.summary,
      );
      const memCount = priorSummaries.length;

      // 规划
      const plan = await call('planner.planChapter', { chapterId });
      if (!plan.ok) {
        rec(`第 ${n} 章规划`, false, `IPC：${plan.error?.code}：${String(plan.error?.message ?? '').slice(0, 200)}`);
        break;
      }
      const pd = plan.data ?? {};
      if (!pd.ok) {
        rec(
          `第 ${n} 章规划`,
          false,
          `${pd.error?.code ?? '未分类'}：${String(pd.error?.message ?? '').slice(0, 200)}`,
        );
        break;
      }
      const brief = pd.brief ?? {};
      const chars = (brief.mainCharacters ?? []).join('、');
      const ctxTokens = pd.contextTokens ?? 0;
      // 预算值：不同实现可能叫 contextBudget / budget / tokenBudget
      const ctxBudget = pd.contextBudget ?? pd.budget ?? pd.tokenBudget ?? 0;
      rec(
        `第 ${n} 章规划`,
        true,
        `${pd.scenes?.length ?? 0} 场景｜角色：${chars}｜上下文 ${ctxTokens} tokens｜可引用前章摘要 ${memCount} 条`,
      );
      const planPlaceholder = PLACEHOLDER.test(JSON.stringify(brief));
      if (planPlaceholder) rec(`第 ${n} 章计划无占位符`, false, '仍含占位符');

      // 写作
      const draft = await call('writer.draft', { chapterId }, 300_000);
      if (!draft.ok) {
        // ⚠ IPC 层失败时错误在 draft.error，不在 draft.data
        rec(
          `第 ${n} 章写作`,
          false,
          `${draft.error?.code}：${String(draft.error?.message ?? '').slice(0, 200)}`,
        );
        break;
      }
      const dd = draft.data ?? {};
      if (!dd.ok) {
        rec(
          `第 ${n} 章写作`,
          false,
          `${dd.error?.code ?? '未分类'}：${String(dd.error?.message ?? JSON.stringify(dd).slice(0, 200)).slice(0, 200)}`,
        );
        break;
      }
      rec(`第 ${n} 章写作`, true, `${dd.totalChars} 字｜${dd.sceneCount} 场景`);

      // ── ⚠⚠ P1：draft.md 必须干净（模型的【说明】不得混进正文）──
      //
      // 这是真机端到端检查：让真模型写完，然后**读磁盘上的 draft.md**，
      // 确认没有残留说明段。
      //
      // ⚠ 为什么不靠 dd.deviations 的长度断言：那是**自证**（"系统说它
      //   剥离了"），而 bug 的形态恰恰是"系统以为自己剥离了，其实没有"。
      //   只有读文件本身才是独立证据。
      //
      // ⚠ 判定规则必须与 stripDeviationNotes 一致：标记在**后半段**才算
      //   说明（前半段里的「(说明)」可能是正文）。这里用同样的 50% 规则，
      //   否则会误报"正文不干净"。
      const MARKERS = ['【偏离说明】', '【说明】', '【备注】', '(说明)'];
      if (dd.draftPath && existsSync(dd.draftPath)) {
        const draftText = readFileSync(dd.draftPath, 'utf8');
        const residual = MARKERS.filter((m) => {
          const i = draftText.lastIndexOf(m);
          return i >= 0 && i > draftText.length * 0.5;
        });
        rec(
          `第 ${n} 章 draft.md 无残留说明段（真读文件）`,
          residual.length === 0,
          residual.length === 0
            ? `${draftText.length} 字，干净`
            : `残留标记 ${residual.join('/')} —— 模型自述会进正式章节`,
        );
        // ⚠ 顺带证明剥离没把正文切没了（剥离过头也是一种坏）
        rec(
          `第 ${n} 章剥离后正文仍完整`,
          draftText.length >= Math.floor((dd.totalChars ?? 0) * 0.5),
          `${draftText.length} 字（Writer 报告 ${dd.totalChars} 字）`,
        );
      } else {
        rec(`第 ${n} 章 draft.md 无残留说明段（真读文件）`, false, `读不到 ${dd.draftPath}`);
      }

      // 审稿
      const review = await call('review.run', { chapterId }, 300_000);
      if (!review.ok) {
        // ⚠ 这里必须 `continue` 或记录后跳过下面那条 —— 此前两条 rec
        //   都会执行，于是 IPC 失败时会额外打出一条
        //   「第 N 章审稿 — undefined：」（rd 是空对象，rd.error 不存在）。
        //   实测就是这么冒出来的：真正的原因在第 1 条，第 2 条是噪音，
        //   而它看起来更像"审稿没返回任何信息"。
        rec(`第 ${n} 章审稿`, false, `IPC：${review.error?.code}：${String(review.error?.message ?? '').slice(0, 200)}`);
        perChapter.push({ n, chapterId, chars, ctxTokens, ctxBudget, memCount, summaryLen: 0, committed: false });
        continue;
      }
      const rd = review.data ?? {};
      rec(
        `第 ${n} 章审稿`,
        rd.ok === true,
        rd.ok
          ? `${rd.status}：${rd.issueCount} 问题（阻塞 ${rd.blockingCount}）｜可提交=${rd.canCommit}`
          : // ⚠ 失败原因优先取 rd.error（core-process 现已透出）。
            //   只有模型那半失败时才有值；此时 issueCount 是确定性检查的结果，
            //   一并显示，避免让人以为"什么都没查"。
            `${rd.error?.code ?? 'MODEL_REVIEW_FAILED'}：${String(rd.error?.message ?? '模型审阅失败，仅确定性检查').slice(0, 120)}`
              + `｜确定性检查 ${rd.deterministicChecked ?? 0} 项，问题 ${rd.issueCount ?? 0}`,
      );

      // 改稿（仅当**存在阻塞问题**时才做）
      //
      // ⚠ 触发条件必须看 blockingCount，不能看 issueCount。
      //   实测 6 次运行的数据：
      //     改稿前阻塞 0 → 改稿后阻塞 0：2 次（有益无害）
      //     改稿前阻塞 0 → 改稿后阻塞 1：4 次（**把好稿改坏了**）
      //   也就是说"本来就能提交"时改稿是负收益 ——
      //   模型会顺手改掉没被指出的地方，引入新的矛盾，
      //   而复审只看新稿，发现不了"这是改稿引入的"。
      //   有阻塞问题时才值得冒这个风险（否则稿子根本提交不了）。
      const needsRevision = rd.ok && (rd.blockingCount ?? 0) > 0;
      if (needsRevision) {
        const rev = await call('revision.run', { chapterId }, 300_000);
        const rvd = rev.ok ? (rev.data ?? {}) : { ok: false, error: rev.error };
        rec(
          `第 ${n} 章改稿`,
          rvd.ok === true,
          rvd.ok
            ? rvd.skipped
              ? `跳过（无阻塞问题，改稿是负收益）`
              : `解决 ${rvd.resolved ?? 0}/${rvd.totalTargets} 个问题｜应用 ${rvd.appliedEdits} 条替换（拒 ${rvd.rejectedEdits}、回退 ${rvd.rolledBack ?? 0} 组）｜${rvd.deltaChars >= 0 ? '+' : ''}${rvd.deltaChars} 字`
            : `${rvd.error?.code}：${String(rvd.error?.message ?? '').slice(0, 100)}`,
        );
        if (rvd.ok && rvd.appliedEdits > 0 && !rvd.skipped) {
          // ⚠ 改完必须重新审稿 —— 改稿可能引入新问题
          const redo = await call('review.run', { chapterId }, 300_000);
          const rdd = redo.ok ? (redo.data ?? {}) : {};
          rec(
            `第 ${n} 章复审`,
            rdd.ok === true,
            rdd.ok ? `${rdd.status}：${rdd.issueCount} 问题（阻塞 ${rdd.blockingCount}）` : '复审失败',
          );
        }
      }

      // 摘要生成（长程记忆的唯一入口）—— 提交前必须完成
      const sgen = await call('summary.generate', { chapterId }, 300_000);
      const sd = sgen.ok ? (sgen.data ?? {}) : { ok: false, error: sgen.error };
      rec(
        `第 ${n} 章摘要生成`,
        sd.ok === true,
        sd.ok ? `${String(sd.summary ?? '').slice(0, 60)}…` : `${sd.error?.code}：${String(sd.error?.message ?? '').slice(0, 100)}`,
      );
      if (!sd.ok) break;
      const summaryLen = String(sd.summary ?? '').length;
      // 作者确认（真实使用中由人在「摘要确认」面板点；验证脚本自动确认）
      //
      // ⚠ 必须**核对确认真的生效**，不能发完就往下走。
      //   现在提交前有两道门（§十二 摘要批准、§33 无 BLOCKING），
      //   若 approve 静默失败，提交会被摘要门拦下，而报告会把它
      //   显示成 §33 拦截 —— 归因错误比失败本身更难查。
      const sappr = await call('summary.approve', { chapterId });
      if (!sappr.ok || sappr.data?.ok === false) {
        rec(
          `第 ${n} 章摘要确认`,
          false,
          `确认失败：${sappr.error?.code ?? sappr.data?.error?.code}：${String(sappr.error?.message ?? sappr.data?.error?.message ?? '').slice(0, 100)}`,
        );
        break;
      }
      rec(`第 ${n} 章摘要确认`, true, `已批准（${summaryLen} 字）`);

      // 提交
      const commit = await call('commit.run', { chapterId }, 300_000);
      const cd = commit.ok ? (commit.data ?? {}) : { ok: false, error: commit.error };
      if (!cd.ok) {
        rec(
          `第 ${n} 章提交`,
          false,
          `被拦：${cd.error?.code}：${String(cd.error?.message ?? '').slice(0, 120)}`,
        );
        // 提交被拦是门禁在起作用，不一定是 bug —— 记录下来继续看下一章
        perChapter.push({ n, chapterId, chars, ctxTokens, ctxBudget, memCount, summaryLen, committed: false });
        continue;
      }
      rec(`第 ${n} 章提交`, true, `${cd.status}（${cd.appliedCount} 产物）`);

      perChapter.push({ n, chapterId, chars, ctxTokens, ctxBudget, memCount, summaryLen, committed: true });

      // 取本章摘要用于人工评估
      const ch = await call('tool.invoke', {
        name: 'chapter.list',
        input: { bookId },
        permission: 'ADMIN',
      });
      const row = (ch.data?.chapters ?? []).find((c) => c.chapterNumber === n);
      if (row?.summary) console.log(`  摘要：${String(row.summary).slice(0, 100)}`);
    }

    // ── 长程记忆的关键检查 ──
    console.log('\n──────── 长程记忆验证 ────────');

    const committed = perChapter.filter((c) => c.committed);
    // 章数越多越能暴露累积性问题；但 1 章成功也算链路通
    const minCommitted = Math.min(2, chapters);
    rec(
      `至少 ${minCommitted} 章提交成功（才能验证跨章记忆）`,
      committed.length >= minCommitted,
      `${committed.length} 章`,
    );

    if (committed.length >= 2) {
      const first = committed[0];
      const later = committed.slice(1);

      const splitNames = (v) =>
        new Set(
          String(v)
            .split(/[、,，]/)
            .map((s) => s.trim())
            .filter(Boolean),
        );

      // ── 检查 1：后续章节的上下文是否真的带上了前文记忆 ──
      const withMemory = later.filter((c) => c.memCount > 0);
      rec(
        '⚠ 后续章节的上下文含长程记忆',
        withMemory.length > 0,
        withMemory.length > 0
          ? `${withMemory.length}/${later.length} 章带记忆（如第 ${withMemory[0].n} 章 ${withMemory[0].memCount} 条）`
          : '全部为 0 —— 长程记忆未接入上下文',
      );

      // ── 检查 2：⚠ 每一章都应带上前章记忆（不只是"有一章带了"）──
      // 累积性问题往往表现为"前几章接上了、后面断了"，
      // 只断言 withMemory.length > 0 会漏掉这种退化。
      const missingMemory = later.filter((c) => c.memCount === 0).map((c) => c.n);
      rec(
        '⚠ 每一章都接上了前文记忆（无中途断裂）',
        missingMemory.length === 0,
        missingMemory.length === 0
          ? `${later.length}/${later.length} 章均有记忆`
          : `第 ${missingMemory.join('、')} 章记忆为 0 —— 长程记忆中途断裂`,
      );

      // ── 检查 3：角色延续 ──
      const firstNames = splitNames(first.chars);
      const laterNames = new Set(later.flatMap((c) => [...splitNames(c.chars)]));
      const shared = [...firstNames].filter((x) => laterNames.has(x));
      rec(
        '⚠ 后续章节延续第 1 章的角色',
        shared.length > 0,
        shared.length > 0
          ? `共有角色：${shared.join('、')}（第1章：${[...firstNames].join('、')}）`
          : `无共有角色 —— 第1章「${[...firstNames].join('、')}」vs 后续「${[...laterNames].join('、')}」`,
      );

      // ── 检查 4：⚠ 主角贯穿全书（累积性漂移的核心指标）──
      // 之前实测踩到：第 1 章主角「林渊」→ 第 2 章变「林秋」，
      // 长程记忆整条断裂。只看"有共有角色"不够 ——
      // 配角偶然重名也算共有，必须盯住主角。
      const nameCount = new Map();
      for (const n of splitNames(first.chars)) nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
      for (const c of later) for (const n of splitNames(c.chars)) nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
      // 出场章数最多的角色即主角（第 1 章角色优先）
      const protagonist =
        [...firstNames].find((n) => nameCount.get(n) === committed.length) ??
        [...firstNames].sort((a, b) => (nameCount.get(b) ?? 0) - (nameCount.get(a) ?? 0))[0];
      const appearedIn = committed.filter((c) => splitNames(c.chars).has(protagonist)).length;
      rec(
        '⚠ 主角贯穿所有已提交章节（无角色漂移）',
        appearedIn === committed.length,
        appearedIn === committed.length
          ? `「${protagonist}」出现在全部 ${committed.length} 章`
          : `「${protagonist}」只出现在 ${appearedIn}/${committed.length} 章 —— 疑似角色漂移`,
      );

      // ── 检查 5：⚠ 上下文 token 不应随章数暴涨（预算是否被撑爆）──
      const tokenSeries = committed.map((c) => Number(c.ctxTokens) || 0);
      const maxTokens = Math.max(...tokenSeries);
      const budget = Number(committed[0].ctxBudget) || 0;
      rec(
        '⚠ 上下文未逼近预算上限（长程记忆不会挤爆上下文）',
        budget === 0 || maxTokens < budget * 0.9,
        budget === 0
          ? `最大 ${maxTokens} tokens（未取到预算值）`
          : `最大 ${maxTokens} / 预算 ${budget}（${((maxTokens / budget) * 100).toFixed(1)}%）`,
      );

      // ── 检查 6：⚠ 摘要长度稳定（防止后期摘要越写越长）──
      const lens = committed.map((c) => Number(c.summaryLen) || 0).filter((x) => x > 0);
      if (lens.length > 1) {
        const minL = Math.min(...lens);
        const maxL = Math.max(...lens);
        rec(
          '⚠ 各章摘要长度稳定（无逐章膨胀）',
          maxL <= 500,
          `摘要字数 ${minL}~${maxL}`,
        );
      }
    }

    // 检索是否可用（用主角名查，比写死的名字更有意义）
    const probe = committed.length > 0 ? String(committed[0].chars).split(/[、,，]/)[0]?.trim() : '林秋';
    const search = await call('search.query', { query: probe || '林秋', limit: 10 });
    if (search.ok) {
      const chHits = search.data.chapters?.length ?? 0;
      const memHits = search.data.memories?.length ?? 0;
      rec('全文检索有命中', chHits + memHits > 0, `查「${probe}」→ 章节 ${chHits} 条 / 记忆 ${memHits} 条`);
    }

    console.log('\n──── 各章汇总 ────');
    for (const c of perChapter) {
      console.log(
        `  第 ${c.n} 章：上下文 ${c.ctxTokens} tokens｜长程记忆 ${c.memCount} 条｜摘要 ${c.summaryLen || 0} 字｜${c.committed ? '已提交' : '未提交'}｜角色 ${c.chars}`,
      );
    }
    console.log('────（结束）────');

    return finish(steps.some((s) => !s.ok) ? 1 : 0);
  } catch (e) {
    rec('未捕获异常', false, e instanceof Error ? e.message : String(e));
    return finish(1);
  } finally {
    try {
      child?.kill();
    } catch {
      /* ignore */
    }
  }
});

function finish(code) {
  const failed = steps.filter((s) => !s.ok);
  console.log(`\n结果：${steps.length - failed.length}/${steps.length} 通过`);
  for (const f of failed) console.log(`  - ${f.name}：${f.detail}`);
  try {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify({ pass: failed.length === 0, steps }, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
  app.exit(code);
}
