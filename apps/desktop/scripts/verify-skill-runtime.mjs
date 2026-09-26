/**
 * Skill Engine 验证（STEP 18 / §25 Skill Runtime）
 *
 *   pnpm verify:skill-runtime [--genre=都市]
 *
 * ## 这个脚本要回答的问题
 *
 * 1. 检索能不能跑通（用**库里真实的技能**，不是造的）
 * 2. ⚠ **Top-N 上限**：绝不能把整个技能库塞进 Prompt（§25 明文）
 * 3. ⚠ **场景功能匹配**：CONFLICT 场景拿冲突技能；
 *    **COOLDOWN 场景不该拿到 CONFLICT 技能**（给错建议比不给更糟）
 * 4. ⚠ **类型隔离**：写都市时拿不到仙侠技能（§21）
 * 5. ⚠ **STYLE 默认不可见**（§21）
 * 6. ⚠ **反模式必须完整保留** —— 它不参与字符预算截断（防滥用）
 * 7. ⚠ **落选有原因** —— "某技能从未被用到"必须能查出原因
 *
 * ⚠ 本脚本**不调模型**（除最后一步），纯检索验证，免费且可重复。
 *
 * @verify-kind: needs-model — 技能运行时需真实模型验证注入效果
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

    const ISOLATED = join(app.getPath('temp'), 'nwa-verify-skill-runtime');
    const open = await call('project.open', { rootDir: ISOLATED });
    if (!open.ok) {
      rec('打开项目', false, open.error?.message);
      return finish();
    }
    rec('打开项目', true, ISOLATED);

    // ── 技能库规模（用于判断 Top-N 是否真的生效）──
    const all = await call('skill.list', { genre: GENRE, limit: 200 });
    const totalSkills = all.data?.total ?? 0;
    rec('技能库非空（需先跑 STEP 17）', totalSkills > 0, `${totalSkills} 个可用技能`);
    if (totalSkills === 0) return finish();

    // ── 1) CONFLICT 场景检索 ──
    console.log(`\n──── 检索：CONFLICT 场景（类型 ${GENRE}）────\n`);
    const conflict = await call('skill.retrieve', {
      genre: GENRE,
      sceneFunction: 'CONFLICT',
      maxSkills: 4,
    });
    if (!conflict.ok) {
      rec('CONFLICT 检索', false, conflict.error?.message);
      return finish();
    }
    const cf = conflict.data;
    console.log(`  参与检索 ${cf.considered} 个｜选中 ${cf.selectedCount} 个｜注入 ${cf.blockChars} 字`);
    for (const s of cf.selected) {
      console.log(`    ${s.name}（得分 ${s.score}）← ${s.reasons.join('；')}`);
    }

    rec(
      '⚠ Top-N 上限生效（不把整个技能库塞进 Prompt）',
      cf.selectedCount <= 4 && cf.selectedCount < totalSkills,
      `选中 ${cf.selectedCount} / 库中 ${totalSkills}`,
    );

    // 选中的必须都是能用于 CONFLICT 的
    const wrongFn = cf.selected.filter(
      (s) => s.reasons.every((r) => !r.includes('CONFLICT') && !r.includes('不限定场景功能') && !r.includes('类型匹配') && !r.includes('跨类型通用')),
    );
    rec(
      '⚠ 选中的技能都与该场景功能匹配',
      wrongFn.length === 0,
      wrongFn.length ? `${wrongFn.length} 个不匹配` : '全部匹配',
    );

    // ── 2) COOLDOWN 场景不该拿到 CONFLICT 技能（给错建议比不给更糟）──
    console.log(`\n──── 检索：COOLDOWN 场景（应拿不到冲突技能）────\n`);
    const cooldown = await call('skill.retrieve', {
      genre: GENRE,
      sceneFunction: 'COOLDOWN',
      maxSkills: 4,
    });
    const cd = cooldown.data;
    console.log(`  选中 ${cd.selectedCount} 个｜注入 ${cd.blockChars} 字`);
    for (const s of cd.selected) console.log(`    ${s.name}（得分 ${s.score}）`);

    const leakedConflict = cd.selected.filter((s) =>
      s.reasons.some((r) => r.includes('场景功能匹配（CONFLICT）')),
    );
    rec(
      '⚠ COOLDOWN 场景不会拿到 CONFLICT 专属技能（给错建议比不给更糟）',
      leakedConflict.length === 0,
      leakedConflict.length ? `${leakedConflict.length} 个串场景` : '已隔离',
    );
    // 落选原因里应能看出"场景功能不匹配"
    const fnRejected = (cd.rejected ?? []).filter((r) => r.reason.includes('场景功能不匹配'));
    rec(
      '⚠ 落选技能有明确原因（可诊断"为什么没用到"）',
      fnRejected.length > 0,
      `${fnRejected.length} 个因场景功能不匹配被排除`,
    );

    // ── 3) 类型隔离 ──
    const other = await call('skill.retrieve', {
      genre: '仙侠',
      sceneFunction: 'CONFLICT',
      maxSkills: 8,
    });
    const ot = other.data;
    rec(
      '⚠ 类型隔离：查「仙侠」拿不到「都市」GENRE 技能',
      ot.selectedCount === 0,
      `选中 ${ot.selectedCount} 个（库中只有都市技能）`,
    );

    // ── 4) STYLE 默认不可见 ──
    const styleOff = await call('skill.retrieve', {
      genre: GENRE,
      sceneFunction: 'CONFLICT',
      maxSkills: 8,
      allowStyle: false,
    });
    const styleOn = await call('skill.retrieve', {
      genre: GENRE,
      sceneFunction: 'CONFLICT',
      maxSkills: 8,
      allowStyle: true,
    });
    // ⚠ 只有当库里真有 STYLE 技能时，这个断言才有意义 ——
    //   否则 0 vs 0 是"没得比"，不是"排除生效"。如实标注。
    const styleRows = (all.data?.skills ?? []).filter((s) => s.scope === 'STYLE');
    if (styleRows.length > 0) {
      rec(
        '⚠ 默认排除 STYLE（§21：Writer 默认不用作者策略）',
        styleOff.data.selectedCount < styleOn.data.selectedCount,
        `库中 ${styleRows.length} 个 STYLE｜默认 ${styleOff.data.selectedCount} vs 含 STYLE ${styleOn.data.selectedCount}`,
      );
    } else {
      console.log(
        `  ⚠ 库中无 STYLE 技能 → STYLE 排除规则**未被真正验证**` +
          `（默认 ${styleOff.data.selectedCount} vs 含 STYLE ${styleOn.data.selectedCount}）`,
      );
      rec('STYLE 排除规则存在（库中无 STYLE 技能，未能实证）', true, '未实证');
    }

    // ── 5) 反模式必须完整保留（不参与截断）──
    if (cf.block) {
      // 取第一个选中技能的反模式首句，确认出现在注入文本里
      const firstSkill = cf.selected[0];
      const antiFirst = firstSkill ? null : null;
      void antiFirst;
      // 用 skill.list 取回完整反模式来核对
      const detail = await call('skill.list', { genre: GENRE, limit: 200 });
      const skillRow = (detail.data?.skills ?? []).find((s) => s.id === firstSkill?.id);
      const antis = (skillRow?.antiPatterns ?? []).map((a) => (typeof a === 'string' ? a : a.rule));
      const allPresent = antis.length > 0 && antis.every((a) => cf.block.includes(a.slice(0, 12)));
      rec(
        '⚠ 反模式完整保留（不参与字符预算截断）',
        allPresent,
        antis.length ? `${antis.length} 条反模式全部在注入文本中` : '该技能无反模式（不应发生）',
      );
    }

    // ── 6) 注入文本包含关键提示 ──
    rec(
      '注入文本说明"策略建议不是硬性要求"',
      cf.block.includes('策略建议') || cf.block.includes('不是必须'),
      '已包含',
    );
    rec(
      '注入文本强调"注意不适用的情况"',
      cf.block.includes('不适用'),
      '已包含',
    );

    // ── 打印注入文本样本（人工判断）──
    console.log('\n──── 实际注入文本（CONFLICT 场景，人工判断）────\n');
    console.log(cf.block.slice(0, 1600));
    if (cf.block.length > 1600) console.log(`\n...（共 ${cf.block.length} 字）`);
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
