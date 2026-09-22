/**
 * 场景标注落库验证（STEP 15 → STEP 16 衔接）
 *
 *   pnpm verify:persist [--chapters=N] [--doc=百岁]
 *
 * ## 这个脚本要验证什么
 *
 * 1. 标注结果**真的写进库**（corpus_scenes 有行）
 * 2. `annotated` 标志正确（已标注 / 失败分开计数）
 * 3. 场景正文文件**真的落盘**且路径可回溯（§46）
 * 4. 聚合查询可用（sceneFunction 分布、按类型过滤）
 * 5. ⚠ **未标注场景不被统计**（否则会把标注失败率当叙事事实）
 *
 * ## ⚠ 会消耗模型额度
 *
 * 默认只跑 2 章（约 6 个场景）。要跑全量请显式传 `--chapters=108`。
 */
import { app, utilityProcess, safeStorage } from 'electron';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { FileSecretStore, defaultCredentialsPath } from '@nwa/harness';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const coreEntry = join(appRoot, 'dist', 'main', 'core-process.js');
const CORPUS_ROOT = 'C:/Users/zw/NovelWriterCorpus';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
const CHAPTERS = Number(arg('chapters', '2'));
const DOC_HINT = arg('doc', '百岁');

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
    switch (op) {
      case 'get':
        reply(true, await store.get(String(p.ref)));
        break;
      case 'isAvailable':
        reply(true, safeStorage.isEncryptionAvailable());
        break;
      default:
        reply(false, undefined, `verify 脚本不执行 ${op} 操作`);
    }
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

    const ISOLATED = join(app.getPath('temp'), 'nwa-verify-persist');
    const open = await call('project.open', { rootDir: ISOLATED });
    if (!open.ok) {
      rec('打开项目', false, open.error?.message);
      return finish();
    }
    rec('打开项目', true, ISOLATED);

    // ⚠ 从**当前库**里查文档 id（不能从目录名推断 ——
    //   重建语料库后 id 会变，实测踩到"corpus document 不存在"）
    const docsRes = await call('corpus.listDocuments', {});
    if (!docsRes.ok) {
      rec('列出语料文档', false, docsRes.error?.message);
      return finish();
    }
    const target = (docsRes.data?.documents ?? []).find((d) =>
      String(d.title).includes(DOC_HINT),
    );
    if (!target) {
      rec(`找到语料「${DOC_HINT}」`, false, '库里未找到');
      return finish();
    }
    const docId = target.documentId;
    rec(`找到语料「${target.title}」`, true, `${docId}｜类型 ${target.genre ?? '未标注'}`);

    // 落库前的进度
    const before = await call('annotate.progress', { documentId: docId });
    const b = before.data?.documents?.[0];
    console.log(`  落库前：总 ${b?.total ?? 0}｜已标注 ${b?.annotated ?? 0}｜失败 ${b?.failed ?? 0}`);

    // ⚠ 跑真实模型标注并落库（消耗额度）
    console.log(`\n──── 标注并落库（真实模型，前 ${CHAPTERS} 章）────\n`);
    // ⚠ 分块循环，而不是一次性调用。
    //
    //   实测踩坑：486 章 × ~10 秒 ≈ 81 分钟，而 IPC 超时设 1 小时
    //   → 跑到第 343 章超时，整个调用报失败（数据其实都落库了，
    //   但脚本显示失败，掩盖了真实进度）。
    //
    //   分块后每次调用有界，进度靠**断点续跑**累积 ——
    //   任何一块超时/中断都只损失一块，且下次调用自动接上。
    const CHUNK = Number(arg('chunk', '40'));
    let totalChapters = 0;
    let totalScenes = 0;
    let totalAnnotated = 0;
    let totalFailed = 0;
    let rounds = 0;

    let prevAnnotated = -1;

    for (let round = 1; round <= Math.ceil(CHAPTERS / CHUNK) + 3; round++) {
      rounds = round;
      const r = await call(
        'annotate.persistDocument',
        { documentId: docId, corpusRoot: CORPUS_ROOT, maxChapters: CHAPTERS },
        1_200_000,
      );
      if (!r.ok) {
        rec(`标注落库（第 ${round} 轮）`, false, `${r.error?.code}：${r.error?.message}`);
        break;
      }
      const d = r.data;
      totalChapters += d.chapters;
      totalScenes += d.scenes;
      totalAnnotated += d.annotated;
      totalFailed += d.failed;
      const prog = d.progress ?? {};
      console.log(
        `  第 ${round} 轮：本轮 ${d.chapters} 章 / ${d.scenes} 场景` +
          `｜累计 ${prog.annotated ?? 0}/${prog.total ?? 0}` +
          `（失败 ${prog.failed ?? 0}）`,
      );

      // ⚠ 停止判据必须是"**没有进展**"，不能是"annotated + failed >= total" ——
      //   `annotationProgress` 里 failed 的定义就是 `total - annotated`，
      //   所以那个式子**恒为真**，会让循环第一轮就退出（等于没分块）。
      if ((prog.annotated ?? 0) <= prevAnnotated) break;
      prevAnnotated = prog.annotated ?? 0;

      // 本轮无待办（全标完）→ 收工
      if (d.chapters === 0) break;
    }

    const persisted = { ok: true, data: { chapters: totalChapters, scenes: totalScenes, annotated: totalAnnotated, failed: totalFailed } };
    const pd = persisted.data;
    console.log(`  共 ${rounds} 轮`);
    rec(
      '标注落库',
      pd.scenes > 0,
      `${pd.chapters} 章 / ${pd.scenes} 场景（已标注 ${pd.annotated}，失败 ${pd.failed}）`,
    );

    // ── 校验 1：库里真的有行 ──
    const after = await call('annotate.progress', { documentId: docId });
    const a = after.data?.documents?.[0];
    rec(
      '⚠ 库里有场景行（真的写进去了）',
      (a?.total ?? 0) > 0,
      `总 ${a?.total ?? 0}｜已标注 ${a?.annotated ?? 0}｜失败 ${a?.failed ?? 0}`,
    );
    rec(
      '⚠ annotated 标志正确（已标注数 > 0）',
      (a?.annotated ?? 0) > 0,
      `${a?.annotated ?? 0} 个`,
    );

    // ── 校验 2：场景正文文件落盘且可回溯 ──
    const sceneDir = join(CORPUS_ROOT, 'documents', docId, 'scenes');
    const files = readdirSafe(sceneDir).filter((f) => f.endsWith('.md'));
    rec('⚠ 场景正文文件已落盘', files.length > 0, `${files.length} 个文件`);
    if (files.length > 0) {
      const sample = readFileSync(join(sceneDir, files[0]), 'utf8');
      rec(
        '⚠ 场景文件内容非空（证据可回溯 §46）',
        sample.trim().length > 0,
        `${files[0]}：${sample.length} 字`,
      );
    }

    // ── 校验 3：聚合查询可用 ──
    const stats = await call('annotate.sceneFunctionStats', { documentId: docId });
    const list = stats.data?.stats ?? [];
    rec(
      '⚠ sceneFunction 聚合查询可用',
      list.length > 0,
      list.map((x) => `${x.sceneFunction}×${x.count}`).join('、') || '（空）',
    );

    // ── 校验 4：⚠ 未标注场景不被统计 ──
    //
    // 这是最关键的一条：若未标注场景混入统计，
    // 分布里会出现"null 类"，而它的占比只反映标注失败率。
    const hasNull = list.some((x) => x.sceneFunction === null || x.sceneFunction === '');
    rec(
      '⚠ 统计里不含未标注场景（null 类）',
      !hasNull,
      hasNull ? '统计混入了 null —— 会把标注失败率当叙事事实！' : '已排除',
    );

    const total = stats.data?.total ?? 0;
    rec(
      '⚠ 统计总数 = 已标注数（不是总场景数）',
      total === (a?.annotated ?? 0),
      `统计 ${total} vs 已标注 ${a?.annotated ?? 0}`,
    );
  } catch (e) {
    rec('脚本异常', false, e instanceof Error ? e.message : String(e));
  }
  finish();
});

function readdirSafe(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

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
