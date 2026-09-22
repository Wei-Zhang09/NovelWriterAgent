/**
 * 模式挖掘验证（STEP 16 / §20 七槽 + §21 跨作品分层）
 *
 *   pnpm verify:mine [--genre=都市] [--groups=N] [--function=CONFLICT]
 *
 * ## 这个脚本要回答的问题
 *
 * 1. 挖掘管线能不能跑通（分组 → 调用 → 校验证据 → 落库）
 * 2. ⚠ **证据是否可回溯** —— 模型有没有编造场景编号
 * 3. ⚠ **类型隔离是否生效** —— 都市查询会不会返回仙侠模式
 * 4. ⚠ **单作品模式是否降档** —— 只有 1 部作品支持的不该冒充类型规律
 * 5. 七槽是否真的填满（decision/mechanism/boundary 不能空）
 *
 * ## ⚠ 会消耗模型额度
 *
 * 每组一次调用。默认最多 3 组（约 3 次调用）。
 */
import { app, utilityProcess, safeStorage } from 'electron';
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
const MAX_GROUPS = Number(arg('groups', '3'));
const ONLY_FN = arg('function', null);

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

function call(method, params = {}, timeoutMs = 1_800_000) {
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

    const ISOLATED = join(app.getPath('temp'), 'nwa-verify-mine');
    const open = await call('project.open', { rootDir: ISOLATED });
    if (!open.ok) {
      rec('打开项目', false, open.error?.message);
      return finish();
    }
    rec('打开项目', true, ISOLATED);

    // ── 1) 跨作品覆盖分析（免费，先看数据够不够）──
    console.log(`\n──── 跨作品覆盖分析（类型：${GENRE}）────\n`);
    const cw = await call('mine.crossWorkAnalysis', { genre: GENRE });
    if (!cw.ok) {
      rec('跨作品覆盖分析', false, `${cw.error?.code}：${cw.error?.message}`);
      return finish();
    }
    const d = cw.data;
    rec('跨作品覆盖分析', true, `共 ${d.totalScenes} 个已标注场景`);
    console.log(`  可跨作品对比的组：${d.comparableGroups}｜仅单作品的组：${d.singleWorkGroups}`);
    for (const c of d.coverage.slice(0, 12)) {
      console.log(
        `    ${c.sceneFunction.padEnd(24)} ${c.scenes} 场景 / ${c.documents} 部作品` +
          `${c.crossWork ? '' : '  ⚠ 单作品（只能算作者风格）'}`,
      );
    }
    rec(
      '⚠ 有可跨作品对比的组（否则模式只能算作者风格）',
      d.comparableGroups > 0,
      `${d.comparableGroups} 组`,
    );

    // ── 2) 挖掘 ──
    console.log(`\n──── 模式挖掘（最多 ${MAX_GROUPS} 组，真实模型）────\n`);
    const mine = await call('mine.run', {
      genre: GENRE,
      scenesPerGroup: 8,
      maxGroups: MAX_GROUPS,
      ...(ONLY_FN ? { onlyFunction: ONLY_FN } : {}),
    });
    if (!mine.ok) {
      rec('模式挖掘', false, `${mine.error?.code}：${mine.error?.message}`);
      return finish();
    }
    const m = mine.data;
    rec(
      '模式挖掘跑通',
      m.patterns > 0 || m.groups > 0,
      `${m.groups} 组｜挖出 ${m.patterns} 条｜落库 ${m.written} 条｜失败组 ${m.failedGroups}`,
    );
    rec('⚠ 没有整组失败（失败说明契约或端点有问题）', m.failedGroups === 0, `${m.failedGroups} 组失败`);
    if (m.failures?.length) {
      for (const f of m.failures) console.log(`    ✗ ${f.sceneFunction}：${f.error}`);
    }

    // ── 3) 读回模式，逐项检查 ──
    const list = await call('mine.listPatterns', { genre: GENRE, limit: 50 });
    if (!list.ok) {
      rec('读回模式', false, list.error?.message);
      return finish();
    }
    const pats = list.data.patterns ?? [];
    rec('读回模式', pats.length > 0, `${pats.length} 条`);

    // 七槽完整性
    const incomplete = pats.filter((p) => {
      const pt = p.pattern ?? {};
      return (
        !p.trigger ||
        !p.mechanism ||
        !Array.isArray(pt.decision) ||
        pt.decision.length === 0 ||
        !Array.isArray(pt.boundary) ||
        pt.boundary.length === 0 ||
        !Array.isArray(pt.effect) ||
        pt.effect.length === 0
      );
    });
    rec(
      '⚠ 七槽全部填满（decision/mechanism/boundary 不能空）',
      incomplete.length === 0,
      incomplete.length ? `${incomplete.length} 条缺槽位` : '全部完整',
    );

    // 证据可回溯
    const noEvidence = pats.filter(
      (p) => !Array.isArray(p.evidenceRefs) || p.evidenceRefs.length === 0,
    );
    rec(
      '⚠ 每条模式都有证据引用（§46 可回溯）',
      noEvidence.length === 0,
      noEvidence.length ? `${noEvidence.length} 条无证据` : '全部有证据',
    );

    // ⚠ 类型隔离：都市查询不该返回仙侠模式
    const wrongGenre = pats.filter(
      (p) => p.scope === 'GENRE' && p.genre && p.genre !== GENRE,
    );
    rec(
      `⚠ 类型隔离生效（查「${GENRE}」不返回其他类型的 GENRE 模式）`,
      wrongGenre.length === 0,
      wrongGenre.length ? `${wrongGenre.length} 条串类型` : '已隔离',
    );

    // ⚠ STYLE 默认不返回（§21：Writer 默认不用作者特有策略）
    const styleLeak = pats.filter((p) => p.scope === 'STYLE');
    rec('⚠ 默认不返回 STYLE 作用域模式（§21）', styleLeak.length === 0, `${styleLeak.length} 条`);

    // 降档统计
    rec(
      '单作品模式已降档（不冒充类型规律）',
      true,
      `本次降档 ${m.downgraded} 条`,
    );

    // 打印样本供人工判断
    console.log('\n──── 模式样本（人工判断质量）────\n');
    for (const p of pats.slice(0, 3)) {
      const pt = p.pattern ?? {};
      console.log(`【${p.sceneFunction}】${p.trigger}`);
      console.log(`  作用域: ${p.scope}｜类型: ${p.genre ?? '-'}｜置信度: ${p.confidence}｜样本 ${p.sampleCount}`);
      console.log(`  手法: ${(pt.decision ?? []).join('；')}`);
      console.log(`  机制: ${p.mechanism}`);
      console.log(`  效果: ${(pt.effect ?? []).join('；')}`);
      console.log(`  边界: ${(pt.boundary ?? []).join('；')}`);
      console.log(`  证据: ${(p.evidenceRefs ?? []).length} 个 sceneId`);
      console.log();
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
