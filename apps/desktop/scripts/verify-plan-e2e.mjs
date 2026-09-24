/**
 * 用真实模型验证 Planner 的输出质量（含「占位符」回归）
 *
 *   pnpm verify:plan
 *
 * ## 为什么必须是 Electron 脚本
 *
 * 密钥经 `safeStorage` 加密落盘（Windows 上是 DPAPI 绑定），
 * **只有 Electron main 能解**。纯 node 脚本读不到，而让用户把明文密钥
 * 贴进终端或对话是绝不可接受的。
 * 因此本脚本在 Electron main 里跑，并扮演 main 的角色应答 core 的
 * 加解密请求（与 apps/desktop/src/main/main.ts 完全同一协议）。
 *
 * ## 验证目标
 *
 * 实测 bug：上下文不足（80 tokens）时，模型把「待确认：…」「例如…」
 * 原样写进字段，产出一份结构完备但**没有任何创作决定**的计划。
 * 本脚本真实调用模型，检查产出里是否还有占位符。
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
const OUT = join(appRoot, 'dist', 'plan-verify-result.json');

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
// ⚠ 复用真实的 FileSecretStore（而不是自己解析文件格式）——
//   自实现会与 main.ts 的存储格式漂移，某天静默读不到密钥。
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
        // 验证脚本只读：明确拒绝写操作，避免污染用户的真实凭据
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
      if (msg?.kind === 'crypto-request') {
        void handleCrypto(msg);
      }
    });
    child.on('spawn', () => setTimeout(resolve, 1500));
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`core 退出码 ${code}`));
    });
  });
}

app.on('window-all-closed', () => {});

// ⚠ 必须与真实应用用**同一个 userData 目录**，否则 safeStorage 解不开密钥。
//
// safeStorage 在 Windows 上是 DPAPI，密钥作用域绑定到 userData 路径
// （进而绑定 app name）。实测踩到：
//   真实应用 → 以 `electron .` 起，加载 apps/desktop/package.json，
//              app.getName() = '@nwa/desktop'
//   本脚本   → 以 `electron scripts/xxx.mjs` 起，
//              app.getName() = 'Electron'
// 两者 userData 不同 → 用 `Electron` 的密钥去解 `@nwa/desktop` 加密的
// 密文，必然失败："无法解密密钥 profile:default"。
//
// 解决：显式把 app name 与 userData 路径对齐到真实应用的值。
app.setName('@nwa/desktop');
app.setPath('userData', join(app.getPath('appData'), '@nwa/desktop'));

// ⚠ 隔离目录：验证脚本不得污染用户真实项目（见 core-process 的说明）
const ISOLATED_ROOT = join(app.getPath('temp'), 'nwa-verify-plan');

// ⚠ 同 verify-writing-e2e：残留的 COMMITTED 章节会让 `chapter.plan`
//   拒绝覆盖计划，于是"规划失败"看起来像功能坏了，实际是脚本残留。
rmSync(ISOLATED_ROOT, { recursive: true, force: true });
mkdirSync(ISOLATED_ROOT, { recursive: true });
process.env['NWA_PROJECTS_ROOT'] = ISOLATED_ROOT;

app.whenReady().then(async () => {
  try {
    // 模型配置从用户真实目录读（只读）
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
      // ⚠ 沙盒目录可能被系统清理（%TEMP% 下的验证目录）——
      //   脚本必须能自举，否则"验证脚本因环境缺失而失败"会被
      //   误读成"功能有问题"。
      const np = await call('tool.invoke', {
        name: 'project.create',
        input: { name: '规划验证项目', genre: 'urban_fantasy' },
        permission: 'ADMIN',
      });
      projectId = np.data?.id ?? np.data?.projectId;
    }
    if (!projectId) {
      rec('找到项目', false, '项目目录里没有项目且创建失败');
      return finish(1);
    }
    rec('找到项目', true, projectId);
    let books = await call('book.list', { projectId });
    let bookId = books.data?.books?.[0]?.id ?? books.data?.[0]?.id;
    if (!bookId) {
      const nb = await call('book.create', { projectId, title: '验证用书' });
      bookId = nb.data?.id;
      books = await call('book.list', { projectId });
    }
    if (!bookId) {
      rec('准备书', false, JSON.stringify(books).slice(0, 150));
      return finish(1);
    }
    rec('准备书', true, `${bookId}（隔离目录）`);

    // 取一章（已存在则复用）
    const list = await call('tool.invoke', {
      name: 'chapter.list',
      input: { bookId },
      permission: 'ADMIN',
    });
    let chapterId = list.data?.chapters?.[0]?.id;
    if (!chapterId) {
      const created = await call('tool.invoke', {
        name: 'chapter.create',
        input: { bookId, chapterNumber: 1, title: '第 1 章' },
        permission: 'ADMIN',
      });
      chapterId = created.data?.chapterId ?? created.data?.id;
    }
    if (!chapterId) {
      rec('取得章节', false, JSON.stringify(list).slice(0, 200));
      return finish(1);
    }
    rec('取得章节', true, chapterId);

    // ── 核心：真实规划并检查占位符 ──
    console.log('\n调用真实模型生成计划（可能需要十几秒）…\n');
    const plan = await call('planner.planChapter', { chapterId });

    if (!plan.ok) {
      rec('规划调用', false, JSON.stringify(plan.error).slice(0, 200));
      return finish(1);
    }
    const d = plan.data ?? {};
    rec(
      '规划成功',
      d.ok === true,
      d.ok
        ? `${d.scenes?.length ?? 0} 场景，尝试 ${d.attempts} 次，上下文 ${d.contextTokens} tokens`
        : `${d.error?.code}：${String(d.error?.message ?? '').slice(0, 150)}`,
    );
    if (!d.ok) return finish(1);

    const brief = d.brief ?? {};
    const fields = {
      purpose: brief.purpose,
      previousState: brief.previousState,
      targetState: brief.targetState,
      hook: brief.hook,
      mainCharacters: (brief.mainCharacters ?? []).join('、'),
      emotionalArc: brief.emotionalArc,
      pacingPlan: brief.pacingPlan,
    };
    const bad = [];
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === 'string' && PLACEHOLDER.test(v)) bad.push(`${k}="${v.slice(0, 40)}"`);
    }
    for (const [i, s] of (d.scenes ?? []).entries()) {
      for (const k of ['purpose', 'startState', 'endState', 'goal', 'conflict']) {
        const v = s?.[k];
        if (typeof v === 'string' && PLACEHOLDER.test(v)) bad.push(`scene[${i}].${k}="${v.slice(0, 30)}"`);
      }
    }

    rec(
      '⚠ 计划中无占位符（本次修复目标）',
      bad.length === 0,
      bad.length === 0 ? '全部字段都是具体创作决定' : `仍有 ${bad.length} 处：${bad.slice(0, 3).join('；')}`,
    );

    // ── P1：叙事维度的真实填充率 ─────────────────────────
    //
    // ⚠ 这一段是 P1 第一项的**真机验证**：
    //   新增的字段必须由**真模型**填出来才有意义。
    //   字段加进 schema 但模型不填（或填了被 default 抹掉），
    //   等于维度仍然空转 —— 只是从"代码写死 null"换成了"模型给空"。
    //
    //   所以这里不测"schema 能不能解析"，而是测**填充率**：
    //   模型声明了几成场景的档位/位置/视角。
    const scenes = d.scenes ?? [];
    const filled = (k) => scenes.filter((s) => s?.[k] !== undefined && s?.[k] !== null).length;
    const pct = (n) => (scenes.length === 0 ? '0/0' : `${n}/${scenes.length}`);

    const povDeclared = brief.narrativePov ?? null;
    const posN = filled('narrativePosition');
    const emoN = filled('emotionIntensityBand');
    const tenN = filled('tensionBand');

    rec(
      'P1 本章声明了叙事视角 narrativePov',
      povDeclared !== null,
      povDeclared === null ? '模型未声明 —— Writer 只能自己决定视角（跳视角风险）' : String(povDeclared),
    );
    rec(
      'P1 场景声明了叙事位置 narrativePosition',
      scenes.length > 0 && posN === scenes.length,
      `${pct(posN)}${posN < scenes.length ? '（缺声明 → 该维度不参与检索）' : ''}`,
    );
    rec(
      'P1 场景声明了情绪强度档位 emotionIntensityBand',
      scenes.length > 0 && emoN === scenes.length,
      `${pct(emoN)}${emoN < scenes.length ? '（缺声明 → §25 Emotion 维度仍不生效）' : ''}`,
    );
    rec(
      'P1 场景声明了张力档位 tensionBand',
      scenes.length > 0 && tenN === scenes.length,
      `${pct(tenN)}${tenN < scenes.length ? '（缺声明 → 张力维度不参与检索）' : ''}`,
    );

    // ⚠ 档位必须真的有区分度 —— 全填同一个值等于没填。
    //   这与 P0-5「模型给不出可靠数值」是同一类观察：
    //   要让模型给**判断**，但要检查判断不是敷衍。
    const emoVals = scenes.map((s) => s?.emotionIntensityBand).filter(Boolean);
    const distinct = new Set(emoVals).size;
    if (emoVals.length > 1) {
      rec(
        'P1 强度档位有区分度（不是一律同一个值）',
        distinct > 1,
        distinct > 1 ? `${distinct} 种取值：${[...new Set(emoVals)].join('/')}` : `全部是 ${emoVals[0]} —— 档位失去意义`,
      );
    }

    console.log('\n──── 计划内容 ────');
    console.log(`目的：${fields.purpose}`);
    console.log(`状态：${fields.previousState} → ${fields.targetState}`);
    console.log(`角色：${fields.mainCharacters}`);
    console.log(`钩子：${fields.hook}`);
    for (const [i, s] of (d.scenes ?? []).entries()) {
      console.log(`  ${i + 1}. [${s.sceneId}] ${s.purpose}`);
    }
    console.log('────（结束）────');

    return finish(bad.length === 0 ? 0 : 1);
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
    writeFileSync(OUT, JSON.stringify({ pass: failed.length === 0, steps }, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
  app.exit(code);
}
