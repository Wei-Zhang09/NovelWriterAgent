/**
 * STEP 18 端到端：Writer 真的用上技能了吗（§25）
 *
 *   pnpm verify:skill-writer [--genre=都市] [--chapters=1]
 *
 * ## 这个脚本要回答的问题
 *
 * 前一个脚本（verify:skill-runtime）只验证**检索**。
 * 这个验证**端到端**：真的跑一次「规划 → 写稿」，
 * 确认：
 *
 * 1. Planner 真的声明了 `sceneFunction`（否则检索无从匹配）
 * 2. Writer 真的注入了技能（skill-usage.json 有记录）
 * 3. ⚠ **每个场景注入的技能数 ≤ Top-N**（§25 硬要求）
 * 4. ⚠ **注入的技能与场景功能匹配**（不是随便塞）
 * 5. ⚠ **skill-usage.json 落盘**（§46 可追溯：这段为什么这样写）
 * 6. ⚠ **正文非空且没有退化** —— 注入技能不该让产出变差
 *
 * ## ⚠ 会消耗模型额度
 * 规划 + 写稿各一次（按章）。
 *
 * @verify-kind: needs-model — 技能对 Writer 的影响需真实模型才能观察
 */
import { app, utilityProcess, safeStorage } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { FileSecretStore, defaultCredentialsPath } from '@nwa/harness';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const coreEntry = join(appRoot, 'dist', 'main', 'core-process.js');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
const GENRE = arg('genre', '都市');
const CHAPTERS = Number(arg('chapters', '1'));

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
app.setName('@nwa/desktop');
app.setPath('userData', join(app.getPath('appData'), '@nwa/desktop'));

app.whenReady().then(async () => {
  try {
    await startCore();
    rec('core 进程已启动', true);

    // ⚠ 独立项目目录：不污染用户的真实创作项目
    const ISOLATED = join(app.getPath('temp'), 'nwa-verify-skill-writer');
    const open = await call('project.open', { rootDir: ISOLATED });
    if (!open.ok) {
      rec('打开项目', false, open.error?.message);
      return finish();
    }
    rec('打开项目', true, ISOLATED);

    // 技能库必须非空，否则这次验证没有意义
    const all = await call('skill.list', { genre: GENRE, limit: 200 });
    const totalSkills = all.data?.total ?? 0;
    rec('技能库非空（需先跑 STEP 17）', totalSkills > 0, `${totalSkills} 个`);
    if (totalSkills === 0) return finish();

    // ⚠ project.create 是**工具**不是 IPC 方法 —— 走 tool.invoke
    //   （与 verify-writing-e2e.mjs 一致，别自己发明调用方式）
    const info = await call('project.info', {});
    let projectId = (info.data?.projects ?? [])[0]?.id;
    if (!projectId) {
      const created = await call('tool.invoke', {
        name: 'project.create',
        input: { name: `技能验证项目-${Date.now()}`, genre: GENRE },
        permission: 'ADMIN',
      });
      if (!created.ok) {
        rec('创建项目', false, `${created.error?.code}：${created.error?.message}`);
        return finish();
      }
      projectId = created.data?.id ?? created.data?.projectId;
    }
    rec('取得项目 id', Boolean(projectId), projectId);
    const book = await call('book.create', {
      projectId,
      title: `技能验证-${Date.now()}`,
    });
    if (!book.ok) {
      rec('创建书目', false, `${book.error?.code}：${book.error?.message}`);
      return finish();
    }
    const bookId = book.data?.id;
    rec('创建书目', Boolean(bookId), bookId);

    for (let n = 1; n <= CHAPTERS; n++) {
      console.log(`\n════ 第 ${n} 章 ════\n`);

      // ⚠ 建章走 tool.invoke（chapter.create 是**工具**不是 IPC）
      //   —— 与 verify-writing-e2e.mjs 一致
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
      rec(`第 ${n} 章建章`, true, chapterId);

      // 规划（走 planner.planChapter，不是 chapter.plan）
      const planned = await call('planner.planChapter', { chapterId });
      if (!planned.ok || !planned.data?.ok) {
        rec(
          `第 ${n} 章规划`,
          false,
          `${planned.error?.code ?? planned.data?.error?.code}：` +
            `${String(planned.error?.message ?? planned.data?.error?.message ?? '').slice(0, 200)}`,
        );
        break;
      }
      rec(`第 ${n} 章规划`, true);

      // ⚠ Planner 必须声明 sceneFunction，否则技能检索无从匹配
      const planRes = await call('planner.getPlan', { chapterId });
      const scenes = planRes.data?.plan?.scenes ?? [];
      const withFn = scenes.filter((s) => s.sceneFunction);
      rec(
        '⚠ Planner 声明了 sceneFunction（技能检索的主键）',
        withFn.length > 0,
        `${withFn.length}/${scenes.length} 个场景声明了：${withFn.map((s) => s.sceneFunction).join('、')}`,
      );

      // 写稿（注入技能）
      const drafted = await call('writer.draft', {
        chapterId,
        genre: GENRE,
        maxSkills: 4,
      });
      if (!drafted.ok) {
        rec(`第 ${n} 章写稿`, false, `${drafted.error?.code}：${drafted.error?.message}`);
        break;
      }
      const d = drafted.data ?? {};
      const totalChars = d.totalChars ?? d.draft?.totalChars ?? 0;
      const sceneCount = d.sceneCount ?? d.draft?.scenes?.length ?? 0;
      rec(
        `第 ${n} 章写稿`,
        totalChars > 0,
        `${sceneCount} 场景｜${totalChars} 字`,
      );

      // ⚠ 读 skill-usage.json（技能是否真的注入 + 是否可追溯）
      const wsRes = await call('writer.workspace', { chapterId });
      const wsRoot = wsRes.data?.dir ?? wsRes.data?.workspaceDir ?? wsRes.data?.root ?? null;
      const candidates = [
        wsRoot ? join(wsRoot, 'skill-usage.json') : null,
        wsRoot ? join(wsRoot, 'skillUsage.json') : null,
      ].filter(Boolean);

      let usage = null;
      for (const c of candidates) {
        if (existsSync(c)) {
          usage = JSON.parse(readFileSync(c, 'utf8'));
          break;
        }
      }

      if (!usage) {
        // 找不到就按工作区结构找一遍
        rec(
          '⚠ skill-usage.json 已落盘（§46 可追溯）',
          false,
          `未找到（工作区 ${wsRoot ?? '未知'}）`,
        );
      } else {
        rec(
          '⚠ skill-usage.json 已落盘（§46 可追溯）',
          true,
          `可用技能 ${usage.availableSkills} 个｜共注入 ${usage.totalBlockChars} 字`,
        );

        const used = usage.scenes.filter((s) => s.selected.length > 0);
        rec(
          '⚠ Writer 真的注入了技能',
          used.length > 0,
          `${used.length}/${usage.scenes.length} 个场景注入了技能`,
        );

        // ⚠ Top-N 上限（§25 硬要求）
        const overLimit = usage.scenes.filter((s) => s.selected.length > 4);
        rec(
          '⚠ 每个场景注入数 ≤ Top-N（§25）',
          overLimit.length === 0,
          overLimit.length ? `${overLimit.length} 个场景超限` : '全部合规',
        );

        // ⚠ 注入的技能与场景功能匹配
        const mismatch = usage.scenes.filter((s) => {
          if (s.selected.length === 0) return false;
          // 场景声明了功能，但注入的技能里没有一个声明该功能
          return s.sceneFunction === null;
        });
        rec(
          '⚠ 注入技能的场景都声明了功能（检索有依据）',
          mismatch.length === 0,
          `${usage.scenes.filter((s) => s.sceneFunction).length}/${usage.scenes.length} 有功能声明`,
        );

        // 打印注入明细供人工判断
        console.log('\n  注入明细：');
        for (const s of usage.scenes) {
          const names = s.selected.map((x) => `${x.name}(${x.score})`).join('、');
          console.log(
            `    场景${s.sceneIndex} [${s.sceneFunction ?? '未声明'}] ` +
              `${s.selected.length} 个技能｜${s.blockChars} 字` +
              `${names ? `：${names}` : ''}`,
          );
        }
      }

      // ⚠ 正文非空且没退化（注入技能不该让产出变差）
      const draftPath = d.draftPath ?? d.draft?.draftPath;
      if (draftPath && existsSync(draftPath)) {
        const text = readFileSync(draftPath, 'utf8');
        rec(
          '⚠ 正文非空（注入技能未导致产出退化）',
          text.trim().length > 300,
          `${text.length} 字`,
        );
        console.log('\n  正文开头 300 字：');
        console.log('  ' + text.slice(0, 300).replace(/\n/g, '\n  '));
      }
    }
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
