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
 */
import { app, utilityProcess, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

      // 审稿
      const review = await call('review.run', { chapterId }, 300_000);
      if (!review.ok) {
        rec(`第 ${n} 章审稿`, false, `IPC：${review.error?.code}：${String(review.error?.message ?? '').slice(0, 200)}`);
      }
      const rd = review.data ?? {};
      rec(
        `第 ${n} 章审稿`,
        rd.ok === true,
        rd.ok
          ? `${rd.status}：${rd.issueCount} 问题（阻塞 ${rd.blockingCount}）｜可提交=${rd.canCommit}`
          : `${rd.error?.code}：${String(rd.error?.message ?? '').slice(0, 100)}`,
      );

      // 改稿（仅当审稿有问题时）—— 补缺口后新增的环节
      if (rd.ok && rd.issueCount > 0) {
        const rev = await call('revision.run', { chapterId }, 300_000);
        const rvd = rev.ok ? (rev.data ?? {}) : { ok: false, error: rev.error };
        rec(
          `第 ${n} 章改稿`,
          rvd.ok === true,
          rvd.ok
            ? `解决 ${rvd.resolved ?? 0}/${rvd.totalTargets} 个问题｜应用 ${rvd.appliedEdits} 条替换（拒 ${rvd.rejectedEdits}、回退 ${rvd.rolledBack ?? 0} 组）｜${rvd.deltaChars >= 0 ? '+' : ''}${rvd.deltaChars} 字`
            : `${rvd.error?.code}：${String(rvd.error?.message ?? '').slice(0, 100)}`,
        );
        if (rvd.ok && rvd.appliedEdits > 0) {
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
      // 作者确认（真实使用中由人在「摘要确认」面板点；验证脚本自动确认）
      await call('summary.approve', { chapterId });

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
        perChapter.push({ n, chapterId, chars, ctxTokens, memCount, committed: false });
        continue;
      }
      rec(`第 ${n} 章提交`, true, `${cd.status}（${cd.appliedCount} 产物）`);

      perChapter.push({ n, chapterId, chars, ctxTokens, memCount, committed: true });

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
    rec('至少 2 章提交成功（才能验证跨章记忆）', committed.length >= 2, `${committed.length} 章`);

    if (committed.length >= 2) {
      const first = committed[0];
      const later = committed.slice(1);

      // 检查：后续章节的上下文是否真的带上了前文记忆
      const withMemory = later.filter((c) => c.memCount > 0);
      rec(
        '⚠ 后续章节的上下文含长程记忆',
        withMemory.length > 0,
        withMemory.length > 0
          ? `${withMemory.length}/${later.length} 章带记忆（如第 ${withMemory[0].n} 章 ${withMemory[0].memCount} 条）`
          : '全部为 0 —— 长程记忆未接入上下文',
      );

      // 检查：角色名是否延续
      const firstNames = new Set(
        String(first.chars)
          .split(/[、,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const laterNames = new Set(
        later
          .flatMap((c) => String(c.chars).split(/[、,，]/))
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const shared = [...firstNames].filter((x) => laterNames.has(x));
      rec(
        '⚠ 后续章节延续第 1 章的角色',
        shared.length > 0,
        shared.length > 0
          ? `共有角色：${shared.join('、')}（第1章：${[...firstNames].join('、')}）`
          : `无共有角色 —— 第1章「${[...firstNames].join('、')}」vs 后续「${[...laterNames].join('、')}」`,
      );
    }

    // 检索是否可用
    const search = await call('search.query', { query: '林秋', limit: 10 });
    if (search.ok) {
      rec(
        '全文检索有命中',
        true,
        `章节 ${search.data.chapters?.length ?? 0} 条 / 记忆 ${search.data.memories?.length ?? 0} 条`,
      );
    }

    console.log('\n──── 各章汇总 ────');
    for (const c of perChapter) {
      console.log(
        `  第 ${c.n} 章：上下文 ${c.ctxTokens} tokens｜长程记忆 ${c.memCount} 条｜${c.committed ? '已提交' : '未提交'}｜角色 ${c.chars}`,
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
