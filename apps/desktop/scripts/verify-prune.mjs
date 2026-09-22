/**
 * 技能库清理（下架近重复技能）
 *
 *   pnpm verify:prune [--apply]
 *
 * ## 为什么需要
 *
 * 去重只在**编译时**生效。在去重功能上线之前编译的技能会残留在库里，
 * 它们仍是 CANDIDATE、仍会被 Writer 检索到 ——
 * 实测《都市》29 个技能里有 10 个 CONFLICT 技能实为约 4 个手法。
 *
 * ## ⚠ 默认只预览，`--apply` 才真改
 *
 * 批量改状态是破坏性操作（虽然 DEPRECATED 可逆），
 * 必须显式确认才执行。
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
const APPLY = process.argv.includes('--apply');
const GENRE = arg('genre', '都市');
const THRESHOLD = Number(arg('threshold', '0.45'));

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

    const ISOLATED = join(app.getPath('temp'), 'nwa-verify-prune');
    await call('project.open', { rootDir: ISOLATED });

    // 清理前
    const before = await call('skill.list', { genre: GENRE, limit: 200 });
    const b = before.data;
    console.log(`\n清理前：${b.total} 个技能（类型 ${GENRE}）`);
    const byStatus = {};
    for (const s of b.skills) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    console.log('  状态分布:', JSON.stringify(byStatus));

    // 预览
    console.log(`\n──── 近重复预览（阈值 ${THRESHOLD}）────\n`);
    const dry = await call('skill.pruneDuplicates', { threshold: THRESHOLD, dryRun: true });
    if (!dry.ok) {
      console.log('✗ 预览失败：', dry.error?.message);
      return finish(1);
    }
    const d = dry.data;
    console.log(`  库内技能总数 ${d.total}｜将下架 ${d.wouldDeprecate}｜保留 ${d.kept}`);
    if (d.deprecated?.length) {
      console.log('  将下架的 id：');
      for (const id of d.deprecated) console.log(`    - ${id}`);
    }

    if (!APPLY) {
      console.log('\n⚠ 默认只预览。要真正执行请加 --apply');
      return finish(0);
    }

    // 执行
    console.log('\n──── 执行下架（DEPRECATED，不删除）────\n');
    const applied = await call('skill.pruneDuplicates', { threshold: THRESHOLD, dryRun: false });
    if (!applied.ok) {
      console.log('✗ 执行失败：', applied.error?.message);
      return finish(1);
    }
    console.log(`  已下架 ${applied.data.deprecated} 个｜保留 ${applied.data.kept} 个`);

    // 清理后
    const after = await call('skill.list', { genre: GENRE, limit: 200 });
    const a = after.data;
    console.log(`\n清理后：${a.total} 个可检索技能`);
    const byStatus2 = {};
    for (const s of a.skills) byStatus2[s.status] = (byStatus2[s.status] ?? 0) + 1;
    console.log('  状态分布:', JSON.stringify(byStatus2));

    // ⚠ 复核：清理后不该再有高相似度对
    console.log('\n──── 复核：清理后是否仍有近重复 ────');
    const dup = await call('skill.pruneDuplicates', { threshold: THRESHOLD, dryRun: true });
    console.log(
      dup.data?.wouldDeprecate === 0
        ? '  ✓ 无剩余近重复'
        : `  ✗ 仍有 ${dup.data?.wouldDeprecate} 个待下架`,
    );
  } catch (e) {
    console.log('脚本异常：', e instanceof Error ? e.message : String(e));
    return finish(1);
  }
  finish(0);
});

function finish(code) {
  try {
    child?.kill();
  } catch {
    /* ignore */
  }
  app.exit(code);
}
