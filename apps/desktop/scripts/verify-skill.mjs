/**
 * 技能编译验证（STEP 17 / §23 §24）
 *
 *   pnpm verify:skill [--genre=都市]
 *
 * ## 这个脚本要回答的问题
 *
 * 1. 编译管线跑通（模式 → 合并 → 校验 → 落库）
 * 2. ⚠ **触发可达性** —— 编译出的技能真的能被检索到吗？
 *    模型容易写出过窄的触发条件（如只认 CLIMAX 而语料里只有 1 个）。
 *    这种技能占着库、内容看着挺好，但**永远不会被用到**。
 * 3. ⚠ **类型隔离** —— 写都市时不会拿到仙侠技能（§21）
 * 4. ⚠ **STYLE 默认不可见** —— Writer 默认不用作者特有策略
 * 5. ⚠ **证据可回溯** —— 技能的 evidenceRefs 指向真实场景（§46）
 * 6. §24 的八要素是否齐全（不是一大段 prompt）
 *
 * ## ⚠ 会消耗模型额度
 * 按 sceneFunction 分组，每组一次调用。
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

    const ISOLATED = join(app.getPath('temp'), 'nwa-verify-skill');
    const open = await call('project.open', { rootDir: ISOLATED });
    if (!open.ok) {
      rec('打开项目', false, open.error?.message);
      return finish();
    }
    rec('打开项目', true, ISOLATED);

    // ── 1) 编译 ──
    console.log(`\n──── 技能编译（类型：${GENRE}，真实模型）────\n`);
    const comp = await call('skill.compile', { genre: GENRE });
    if (!comp.ok) {
      rec('技能编译', false, `${comp.error?.code}：${comp.error?.message}`);
      return finish();
    }
    const c = comp.data;
    console.log(
      `  用了 ${c.patternsUsed} 条模式（GENRE/UNIVERSAL）+ ${c.scenesUsed} 个场景` +
        `，分 ${c.groups} 组`,
    );
    rec(
      '技能编译跑通',
      c.persisted > 0 || c.groups > 0,
      `${c.groups} 组｜落库 ${c.persisted} 个｜可用 ${c.usable}｜不可用 ${c.unusable}`,
    );
    rec('⚠ 没有整组失败（失败说明契约或端点有问题）', c.failures.length === 0, `${c.failures.length} 组失败`);
    for (const f of c.failures ?? []) console.log(`    ✗ ${f.sceneFunction}：${f.error}`);

    // ── 2) 触发可达性（最关键）──
    if (c.unusable > 0) {
      console.log('\n  ⚠ 未通过校验的技能（已标 DEPRECATED，保留以便诊断）：');
      for (const p of c.problems) {
        console.log(`    ${p.name}（命中 ${p.triggerHits} 个场景）`);
        for (const x of p.problems) console.log(`      - ${x}`);
      }
    }
    rec(
      '⚠ 有可被检索到的技能（触发条件不过窄）',
      c.usable > 0,
      `${c.usable} 个可用`,
    );

    // ── 3) 读回，逐项检查 ──
    const list = await call('skill.list', { genre: GENRE, limit: 100 });
    if (!list.ok) {
      rec('读回技能', false, list.error?.message);
      return finish();
    }
    const skills = list.data.skills ?? [];
    rec('读回技能', skills.length > 0, `${skills.length} 个`);

    // §24 八要素齐全（不是一大段 prompt）
    const incomplete = skills.filter(
      (s) =>
        !s.name ||
        !s.category ||
        !s.summary ||
        !s.trigger ||
        !Array.isArray(s.rules) ||
        s.rules.length === 0 ||
        !Array.isArray(s.antiPatterns) ||
        s.antiPatterns.length === 0 ||
        typeof s.confidence !== 'number' ||
        typeof s.version !== 'number' ||
        !s.status,
    );
    rec(
      '⚠ §24 八要素齐全（不是 prompt 模板）',
      incomplete.length === 0,
      incomplete.length ? `${incomplete.length} 个缺要素` : '全部完整',
    );

    // rules 必须是可执行动作（不是评价）—— 粗筛
    const vague = skills.filter((s) =>
      (s.rules ?? []).some((r) => {
        const text = typeof r === 'string' ? r : (r.rule ?? '');
        return text.length < 4;
      }),
    );
    rec('规则不是空话（每条有实质内容）', vague.length === 0, `${vague.length} 个规则过短`);

    // ── 4) 类型隔离（§21）──
    const wrongGenre = skills.filter((s) => s.scope === 'GENRE' && s.genre && s.genre !== GENRE);
    rec(
      `⚠ 类型隔离生效（查「${GENRE}」不返回其他类型技能）`,
      wrongGenre.length === 0,
      wrongGenre.length ? `${wrongGenre.length} 个串类型` : '已隔离',
    );

    // ── 5) STYLE 默认不可见（§21）──
    const styleLeak = skills.filter((s) => s.scope === 'STYLE');
    rec('⚠ 默认不返回 STYLE 技能（Writer 默认不用作者策略）', styleLeak.length === 0, `${styleLeak.length} 个`);

    // ── 6) 证据可回溯（§46）──
    const noEvidence = skills.filter(
      (s) => !Array.isArray(s.evidenceRefs) || s.evidenceRefs.length === 0,
    );
    rec(
      '⚠ 每个技能都有证据引用（§46 可回溯）',
      noEvidence.length === 0,
      noEvidence.length ? `${noEvidence.length} 个无证据` : '全部有证据',
    );

    // 状态：新编译的一律 CANDIDATE（未经验证）
    const active = skills.filter((s) => s.status === 'ACTIVE');
    rec(
      '⚠ 新技能状态为 CANDIDATE（未经使用验证不该 ACTIVE）',
      active.length === 0,
      active.length ? `${active.length} 个已 ACTIVE` : '全部 CANDIDATE',
    );

    rec(
      '类型隔离的排除原因可诊断',
      true,
      `${list.data.excludedCount} 个被挡｜` +
        (list.data.excludedReasons ?? []).map((r) => `${r.reason}×${r.count}`).join('、'),
    );

    // ── 打印样本供人工判断 ──
    console.log('\n──── 技能样本（人工判断质量）────\n');
    for (const s of skills.slice(0, 3)) {
      console.log(`【${s.name}】${s.category}｜${s.scope}｜置信 ${s.confidence}｜v${s.version}｜${s.status}`);
      console.log(`  说明: ${s.summary}`);
      console.log(`  触发: 场景类型 ${JSON.stringify(s.trigger?.sceneTypes ?? [])}` +
        `${(s.trigger?.genres ?? []).length ? `｜类型 ${JSON.stringify(s.trigger.genres)}` : ''}`);
      console.log('  规则:');
      for (const r of s.rules ?? []) {
        const text = typeof r === 'string' ? r : r.rule;
        const why = typeof r === 'object' && r.rationale ? `（因为：${r.rationale}）` : '';
        console.log(`    - ${text}${why}`);
      }
      console.log('  反模式:');
      for (const a of s.antiPatterns ?? []) console.log(`    - ${a}`);
      console.log(`  证据: ${(s.evidenceRefs ?? []).length} 个 sceneId｜来源 ${(s.sourceDocumentIds ?? []).length} 部作品`);
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
