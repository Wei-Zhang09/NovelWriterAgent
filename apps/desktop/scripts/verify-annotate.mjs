/**
 * STEP 15 语义标注验证（真实模型）
 *
 *   pnpm verify:annotate [--chapter=N] [--scenes=M]
 *
 * ## 这个脚本要回答的问题
 *
 * STEP 15 的规则层（场景切分）已用真实语料验证。但**语义标注
 * （sceneFunction / conflicts / hook 等）才是模式挖掘的输入** ——
 * 它们准不准，必须真跑一次才知道。
 *
 * 若标注质量不行，STEP 16 挖出来的模式就是垃圾。因此**越早发现越好**。
 *
 * ## 为什么用 Electron 脚本
 *
 * 密钥经 safeStorage 加密（Windows 上 DPAPI 绑定 userData 路径），
 * 只有 Electron main 能解。让用户贴明文密钥是不可接受的。
 *
 * ## 输出什么
 *
 * 逐场景打印标注结果 + 机械指标，便于**人工判断**：
 *   - sceneFunction 是否合理（对照场景首段内容）
 *   - 对话占比 / 节奏 是否符合直觉
 *   - 是否有明显的编造（标注了文本没写的内容）
 *
 * @verify-kind: needs-model — 必须真实模型做叙事标注
 */
import { app, utilityProcess, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
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
const CHAPTER = Number(arg('chapter', '20'));
const MAX_SCENES = Number(arg('scenes', '5'));

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
    rec('core 进程已启动', true);

    // 打开隔离项目（不碰用户的创作项目）
    const ISOLATED = join(app.getPath('temp'), 'nwa-verify-annotate');
    const open = await call('project.open', { rootDir: ISOLATED });
    if (!open.ok) {
      rec('打开项目', false, open.error?.message);
      return finish();
    }
    rec('打开项目', true, ISOLATED);

    // 读语料章节文件
    const CORPUS = 'C:/Users/zw/NovelWriterCorpus/documents';
    let targetDir = null;
    for (const d of readdirSync(CORPUS)) {
      const rep = join(CORPUS, d, 'import.json');
      if (!existsSync(rep)) continue;
      const j = JSON.parse(readFileSync(rep, 'utf8'));
      if (String(j.title).includes('百岁')) {
        targetDir = join(CORPUS, d);
        break;
      }
    }
    if (!targetDir) {
      rec('找到《百岁之好》语料', false, '未找到');
      return finish();
    }
    const chFile = join(targetDir, 'chapters', `${String(CHAPTER).padStart(3, '0')}.md`);
    if (!existsSync(chFile)) {
      rec(`读取第 ${CHAPTER} 章`, false, chFile);
      return finish();
    }
    const chapterText = readFileSync(chFile, 'utf8');
    rec(`读取第 ${CHAPTER} 章`, true, `${chapterText.length} 字`);

    // 先看规则层切分
    const seg = await call('annotate.segment', { text: chapterText });
    if (!seg.ok) {
      rec('规则层切分', false, seg.error?.message);
      return finish();
    }
    rec(
      '规则层切分',
      true,
      `${seg.data.scenes.length} 个场景｜依据 ${seg.data.scenes.map((s) => s.reason).join('/')}`,
    );

    // 逐场景语义标注（真实模型）
    console.log(`\n──── 语义标注（真实模型，最多 ${MAX_SCENES} 个场景）────\n`);
    const ann = await call('annotate.scenes', {
      text: chapterText,
      documentId: 'verify_doc',
      genre: '都市校园',
      maxScenes: MAX_SCENES,
    });

    if (!ann.ok) {
      rec('语义标注', false, `${ann.error?.code}：${ann.error?.message}`);
      return finish();
    }

    const data = ann.data;
    rec(
      '语义标注',
      data.annotatedCount > 0,
      `${data.annotatedCount}/${data.sceneCount} 个场景标注成功`,
    );

    for (const s of data.scenes) {
      const a = s.annotation;
      console.log(`${'─'.repeat(64)}`);
      console.log(`场景 ${s.sceneIndex + 1}｜${s.paragraphCount} 段｜${s.chars} 字｜边界依据 ${s.boundaryReason}`);
      console.log(`  首段: ${s.text.slice(0, 80).replace(/\n/g, ' ')}`);
      console.log('');
      if (!s.annotated) {
        console.log(`  ⚠ 语义标注失败：${s.annotationError}`);
      } else {
        console.log(`  sceneFunction: ${a.sceneFunction}`);
        console.log(`  人物: ${(a.characters ?? []).join('、') || '（空）'}`);
        console.log(`  地点/时间: ${a.setting ?? '—'} / ${a.time ?? '—'}`);
        if ((a.goals ?? []).length) {
          for (const g of a.goals) console.log(`  目标: ${g.character} → ${g.goal}（${g.achieved ? '达成' : '未达成'}）`);
        }
        if ((a.conflicts ?? []).length) {
          for (const c of a.conflicts) {
            console.log(`  冲突[${c.kind}/${c.intensity}]: ${c.parties.join(' vs ')} — ${c.description}`);
          }
        }
        if ((a.emotions ?? []).length) {
          for (const e of a.emotions) {
            console.log(`  情绪: ${e.character} ${e.emotion}(${e.intensity}) [${e.expression}]`);
          }
        }
        if ((a.information ?? []).length) {
          for (const i of a.information) {
            console.log(`  信息: ${i.content}｜获知: ${i.learnedBy.join('、') || '（仅读者）'}`);
          }
        }
        if (a.hook) console.log(`  钩子: ${a.hook.type}（强度 ${a.hook.intensity}）`);
        if ((a.foreshadowing ?? []).length) console.log(`  伏笔: ${a.foreshadowing.join('；')}`);
      }
      console.log(`  机械指标: 对话占比 ${a.pacing?.dialogueRatio}｜段落密度 ${a.pacing?.paragraphDensity}｜节奏 ${a.pacing?.speed}`);
      console.log(`            句长均值 ${a.prose?.sentenceLengthMean}｜描写占比 ${a.prose?.descriptionRatio}｜内心独白 ${a.prose?.internalMonologueRatio}`);
    }

    // 统计 sceneFunction 分布
    const dist = {};
    for (const s of data.scenes) {
      if (s.annotation.sceneFunction) {
        dist[s.annotation.sceneFunction] = (dist[s.annotation.sceneFunction] ?? 0) + 1;
      }
    }
    console.log(`\n──── sceneFunction 分布 ────`);
    console.log(`  ${JSON.stringify(dist)}`);
    const total = data.annotatedCount;
    if (total > 0) {
      const kinds = Object.keys(dist).length;
      rec(
        '⚠ 标注有多样性（不是所有场景同一类型）',
        kinds > 1,
        `${kinds} 种类型 / ${total} 个场景`,
      );
    }

    writeFileSync(
      join(appRoot, 'dist', 'annotate-verify-result.json'),
      JSON.stringify(data, null, 2),
      'utf8',
    );
    rec('结果已落盘', true, 'dist/annotate-verify-result.json');
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

void homedir;
