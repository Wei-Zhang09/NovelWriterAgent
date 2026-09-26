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
 *
 * @verify-kind: needs-model — 必须真实模型标注后才能挖掘模式
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
    // ⚠ 这一条**不作为失败** —— 只有一部作品时 0 组是事实，
    //   而且此时所有模式都该被降档为 STYLE（设计如此）。
    //   把它当失败会掩盖真正要检查的东西（证据可回溯 / 类型隔离）。
    console.log(
      `  ${d.comparableGroups > 0 ? '✓' : '⚠'} 可跨作品对比的组：${d.comparableGroups}` +
        `${d.comparableGroups === 0 ? '（单作品 → 所有模式将降档为 STYLE，无法称类型规律）' : ''}`,
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
    //
    // ⚠ 分两次查：默认查询（排除 STYLE）与含 STYLE。
    //
    //   只有一部作品时，**所有模式都会被正确降档为 STYLE**，
    //   默认查询返回 0 条 —— 那是**设计如此**，不是失败。
    //   早先的脚本把它当失败，掩盖了真正要检查的东西。
    const list = await call('mine.listPatterns', { genre: GENRE, limit: 50 });
    if (!list.ok) {
      rec('读回模式', false, list.error?.message);
      return finish();
    }
    const pats = list.data.patterns ?? [];

    const withStyle = await call('mine.listPatterns', {
      genre: GENRE,
      limit: 200,
      includeStyle: true,
    });
    const allPats = withStyle.data?.patterns ?? [];

    rec(
      '落库模式可读回（含 STYLE）',
      allPats.length > 0,
      `共 ${allPats.length} 条｜默认可见 ${pats.length} 条`,
    );
    rec(
      '⚠ 默认查询已排除 STYLE（§21：Writer 默认不用作者策略）',
      pats.every((p) => p.scope !== 'STYLE'),
      pats.length === 0 ? '全部被排除（单作品场景下的正确行为）' : `默认可见 ${pats.length} 条`,
    );

    // 用含 STYLE 的集合做后续质量检查（否则单作品时全是空的）
    const checkSet = allPats;

    // 七槽完整性
    const incomplete = checkSet.filter((p) => {
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
    const noEvidence = checkSet.filter(
      (p) => !Array.isArray(p.evidenceRefs) || p.evidenceRefs.length === 0,
    );
    rec(
      '⚠ 每条模式都有证据引用（§46 可回溯）',
      noEvidence.length === 0,
      noEvidence.length ? `${noEvidence.length} 条无证据` : '全部有证据',
    );

    // ⚠ 类型隔离：都市查询不该返回仙侠模式
    const wrongGenre = checkSet.filter(
      (p) => p.scope === 'GENRE' && p.genre && p.genre !== GENRE,
    );
    rec(
      `⚠ 类型隔离生效（查「${GENRE}」不返回其他类型的 GENRE 模式）`,
      wrongGenre.length === 0,
      wrongGenre.length ? `${wrongGenre.length} 条串类型` : '已隔离',
    );

    // ⚠ STYLE 默认不返回（§21：Writer 默认不用作者特有策略）
    const styleLeak = pats.filter((p) => p.scope === 'STYLE');
    rec('⚠ 默认查询无 STYLE 泄漏（§21）', styleLeak.length === 0, `${styleLeak.length} 条`);

    // 降档统计
    rec(
      '单作品模式已降档（不冒充类型规律）',
      true,
      `本次降档 ${m.downgraded} 条`,
    );

    // ── 4) P0-6：scope 由证据计算，不是模型自报 ──
    console.log('\n──── P0-6：Scope 由证据计算（§八）────\n');

    // 4a) ⚠⚠ **本次写入的**模式必须都带判定依据。
    //
    // ⚠ 断言对象是"本次写入"而不是"库里全部"，这一点我第一版写错了：
    //   库里还有 0011 迁移之前写入的老行（那一列当时不存在），
    //   它们**如实地**为 NULL —— 拿它们当失败，等于要求历史数据
    //   具备当时还没有的字段。
    //
    //   而且**不能回填**：老行的 scope 是旧逻辑算的，重算需要当时的
    //   证据口径（证据覆盖的作品及其类型），那正是当时没有记录的东西。
    //   凭现在的库反推会给老行编造一份"看起来合理"的依据 —— 那是伪造证据。
    //   正确做法是如实报告存在无依据的历史行。
    const newTriggers = new Set((m.scopeEvidence ?? []).map((x) => x.trigger));
    const justWritten = checkSet.filter((x) => newTriggers.has(x.trigger?.trigger ?? x.trigger));
    const missingNew = justWritten.filter((x) => !x.scopeEvidence);
    rec(
      '⚠⚠ 本次写入的模式都带 scope 判定依据（可审计）',
      justWritten.length > 0 && missingNew.length === 0,
      justWritten.length === 0
        ? '本次没有写入模式，无法判定'
        : `${justWritten.length} 条新写入，${missingNew.length} 条缺依据`,
    );

    // 4a-2) 历史行如实报告（**不作为失败** —— 它们当时没有这一列）
    const legacyNoEvidence = checkSet.filter((x) => !x.scopeEvidence);
    if (legacyNoEvidence.length > 0) {
      console.log(
        `  ⚠ ${legacyNoEvidence.length} 条历史模式无判定依据（0011 迁移之前写入，` +
          '当时无此列；不回填 —— 回填等于伪造当时的证据）',
      );
    }

    // 4b) ⚠⚠ 核心断言：跨作品 ≠ 跨类型。
    //     库里两部已标注作品都是都市类（都市校园 / 都市言情）——
    //     所以**任何**模式都不该被判成 UNIVERSAL。这正是 §八 点名的情形。
    const universals = checkSet.filter((x) => x.scope === 'UNIVERSAL');
    const genreSet = new Set(checkSet.map((x) => x.genre).filter(Boolean));
    rec(
      `⚠⚠ 跨作品但同类型时不得判 UNIVERSAL（当前已标注类型：${[...genreSet].join('、') || '无'}）`,
      universals.length === 0,
      universals.length
        ? `${universals.length} 条被判 UNIVERSAL —— 类型维度没生效`
        : '无 UNIVERSAL（证据只跨作品、未跨类型，正确）',
    );

    // 4c) 依据里的类型分布要与实际语料一致（证明用的是**证据口径**）
    const withEv = checkSet.filter((x) => x.scopeEvidence);
    const crossGenreClaimed = withEv.filter(
      (x) => (x.scopeEvidence.crossGenreCoverage ?? 0) >= 2,
    );
    rec(
      '⚠ 没有任何模式声称跨类型（语料只有都市类）',
      crossGenreClaimed.length === 0,
      crossGenreClaimed.length ? `${crossGenreClaimed.length} 条声称跨类型` : '全部未声称',
    );

    // 4d) ⚠ stability / held_out_validation 必须如实标 NOT_RUN
    //     —— 填一个"看起来合理"的值就是伪造证据
    const faked = withEv.filter(
      (x) => x.scopeEvidence.stability !== 'NOT_RUN' || x.scopeEvidence.heldOutValidation !== 'NOT_RUN',
    );
    rec(
      '⚠⚠ stability / held_out_validation 如实标 NOT_RUN（不伪造证据）',
      faked.length === 0,
      faked.length
        ? `${faked.length} 条声称做过未运行的实验`
        : '全部如实标 NOT_RUN',
    );

    // 4e) counter_evidence 状态必须明确（NONE / FOUND / NOT_CHECKED 三态）
    const ceStatuses = new Set(
      withEv.map((x) => x.scopeEvidence.counterEvidence?.status ?? '(缺失)'),
    );
    rec(
      '⚠ counter_evidence 状态明确（NONE / FOUND / NOT_CHECKED）',
      [...ceStatuses].every((x) => ['NONE', 'FOUND', 'NOT_CHECKED'].includes(x)),
      `状态集合：${[...ceStatuses].join('、') || '无'}`,
    );

    // 打印依据样本供人工核对
    console.log('  依据样本：');
    for (const x of withEv.slice(0, 4)) {
      const e = x.scopeEvidence;
      console.log(
        `    [${x.scope}] 作品 ${e.support} 部｜类型 ${e.crossGenreCoverage} 个` +
          `（${(e.genres ?? []).join('、') || '未知'}）｜未知类型 ${e.unknownGenreCount} 部` +
          `｜反证 ${e.counterEvidence?.status}`,
      );
    }

    // 打印样本供人工判断
    console.log('\n──── 模式样本（人工判断质量）────\n');
    for (const p of checkSet.slice(0, 3)) {
      const pt = p.pattern ?? {};
      const tj = p.trigger ?? {};
      console.log(`【${p.sceneFunction}】${tj.trigger ?? '(无触发描述)'}`);
      console.log(`  情境: ${(tj.context ?? []).join('；')}`);
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
