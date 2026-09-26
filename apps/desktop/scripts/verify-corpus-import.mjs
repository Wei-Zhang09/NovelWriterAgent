/**
 * 语料导入 + 蒸馏链验证（§16 / §58 / §61）
 *
 *   pnpm verify:corpus-import
 *
 * ## 这个脚本要回答的问题（用户直接问的那个）
 *
 * 「软件应该具备后期导入小说进行蒸馏的入口，这个有吗」
 * → 本脚本证明它现在**有**，且能真的跑通。
 *
 * ## ⚠ 必须验证的边界（§61 许可闸门）
 *
 * 1. 正常许可 → 可导入、可蒸馏
 * 2. ⚠ **UNKNOWN 许可 → 可导入（降级为 RETRIEVAL_ONLY）+ 明确提示，
 *    但蒸馏被拒绝** —— 这是 §61 的落地
 * 3. ⚠ 该闸门此前**运行时没有强制**（`canProcess` 定义了却无调用），
 *    本脚本同时是它的回归测试
 *
 * ⚠ 全程用隔离的临时目录，不碰用户真实语料库与项目。
 *
 * @verify-kind: standalone — 语料三阶段导入失败语义，走真实 IPC，需 NWA_CORPUS_ROOT 隔离
 */
import { app, utilityProcess, safeStorage } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { FileSecretStore, defaultCredentialsPath } from '@nwa/harness';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const coreEntry = join(appRoot, 'dist', 'main', 'core-process.js');

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
  const sandbox = join(app.getPath('temp'), 'nwa-verify-corpus-import');
  const corpusRoot = join(sandbox, 'corpus');

  try {
    rmSync(sandbox, { recursive: true, force: true });
    mkdirSync(corpusRoot, { recursive: true });

    // ⚠ 把语料库指到沙盒 —— 不碰用户的真实语料库
    process.env['NWA_CORPUS_ROOT'] = corpusRoot;

    // 造一份**格式真实**的小说文本（含章节标题，供切分器识别）
    const novelPath = join(sandbox, '测试小说.txt');
    const chapters = [];
    for (let i = 1; i <= 12; i++) {
      chapters.push(
        `第${['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'][i - 1]}章 测试章节${i}\n\n` +
          `这是第 ${i} 章的正文。他走进教室，坐在最后一排。窗外的树影在桌面上晃。\n\n` +
          `“你来了，”她说，“我等了很久。”\n\n` +
          `他没有回答，只是把书包放在桌上，拉开椅子坐下。\n\n` +
          `那天下午的阳光很斜，把两个人的影子拉得很长。\n`,
      );
    }
    writeFileSync(novelPath, chapters.join('\n'), 'utf8');

    await startCore();
    rec('core 进程已启动', true);

    const ISOLATED = join(sandbox, 'proj');
    const open = await call('project.open', { dir: ISOLATED });
    if (!open.ok) {
      rec('打开项目', false, open.error?.message);
      return finish();
    }
    // ⚠ 断言隔离真的生效（此前 project.open 静默忽略 rootDir，
    //   导致 8 个脚本写进了用户真实目录）
    rec(
      '⚠ 项目隔离生效（不写用户真实目录）',
      String(open.data?.dir ?? '').includes('nwa-verify-corpus-import'),
      String(open.data?.dir ?? open.error?.message),
    );

    // ── 1. 导入入口存在且可用 ──
    console.log('\n──── 导入语料（用户问的"入口"）────\n');
    const imp = await call('corpus.import', {
      filePath: novelPath,
      title: '测试小说',
      author: '测试作者',
      genre: '都市',
      licenseType: 'USER_OWNED',
      licenseBasis: '自用测试文本',
      clean: true,
    });
    if (!imp.ok) {
      rec('导入语料', false, `${imp.error?.code}：${imp.error?.message}`);
      return finish();
    }
    const d = imp.data;
    console.log(
      `  《${d.title}》${d.chapterCount} 章 / ${d.chars} 字｜策略 ${d.strategy}`,
    );
    rec('⚠ 导入入口可用（此前只能改 verify-books.mjs 源码）', d.chapterCount > 0, `${d.chapterCount} 章`);
    rec('章节切分正确识别（12 章）', d.chapterCount === 12, `实际 ${d.chapterCount} 章`);

    // ── 2. 概览能反映状态 ──
    const ov = await call('corpus.overview', {});
    const doc = (ov.data?.documents ?? []).find((x) => x.documentId === d.documentId);
    rec('概览列出新导入的语料', Boolean(doc), doc?.title ?? '未找到');
    rec('概览标记该语料可蒸馏', doc?.processable === true, String(doc?.processable));

    // ── 3. ⚠ UNKNOWN 许可：可导入但不可蒸馏（§61）──
    console.log('\n──── ⚠ §61 许可闸门：UNKNOWN 语料 ────\n');
    const unknownPath = join(sandbox, '来源不明.txt');
    writeFileSync(
      unknownPath,
      '第一章 开头\n\n这是来源不明的内容。\n\n第二章 继续\n\n又一段正文。\n',
      'utf8',
    );
    const impU = await call('corpus.import', {
      filePath: unknownPath,
      title: '来源不明的小说',
      licenseType: 'UNKNOWN',
      genre: '都市',
      clean: false,
    });
    rec(
      '⚠ UNKNOWN 许可**可以导入**（用户选择"允许但弹提示"）',
      impU.ok === true,
      impU.ok ? `已导入，降级为 ${impU.data?.documentId ? '成功' : '?'}` : impU.error?.message,
    );
    rec(
      '⚠ UNKNOWN 导入时给出明确许可提示（不静默降级）',
      Boolean(impU.data?.licenseWarning),
      String(impU.data?.licenseWarning ?? '（无提示 —— 用户不会知道后果）').slice(0, 80),
    );

    const ov2 = await call('corpus.overview', {});
    const docU = (ov2.data?.documents ?? []).find((x) => x.title === '来源不明的小说');
    rec(
      '⚠ 概览把 UNKNOWN 语料标为不可蒸馏',
      docU?.processable === false,
      `allowedUsage=${docU?.allowedUsage}`,
    );

    // ⚠ 这是本轮修的真漏洞：canProcess 定义了却无调用
    // ⚠ 注意：corpus.distill 把"业务失败"放在 **data** 里
    //   （`{ok:false, stages, stoppedAt}`），IPC 层仍是成功 ——
    //   因为"许可不允许"是预期内的业务结果，不是异常。
    //   断言必须看 data.ok，看 IPC 的 ok 会得到相反的结论。
    const distillU = await call('corpus.distill', {
      documentId: docU?.documentId,
      genre: '都市',
      maxChapters: 1,
    });
    const du = distillU.data ?? {};
    const uDetail = String(du.stages?.[0]?.detail ?? '');
    rec(
      '⚠ §61 闸门生效：UNKNOWN 语料**蒸馏被拒**（此前运行时无强制）',
      du.ok === false && /许可|UNKNOWN|RETRIEVAL_ONLY|不得进入/.test(uDetail),
      `stoppedAt=${du.stoppedAt}｜${uDetail.slice(0, 100)}`,
    );

    // ── 4. 正常语料的蒸馏链（跑 1 章验证编排，省额度）──
    console.log('\n──── 蒸馏链编排（限 1 章，省模型额度）────\n');
    const distill = await call('corpus.distill', {
      documentId: d.documentId,
      genre: '都市',
      maxChapters: 1,
    });
    // ⚠ 判据看 **data.ok**，不是 IPC 的 `distill.ok`。
    //   `corpus.distill` 把业务失败放在 data 里（IPC 层仍成功），
    //   因为"某阶段失败"是预期内的业务结果。只看 IPC 层会走错分支
    //   —— 实测第一次就踩了，报"蒸馏链跑通"却停在 annotate。
    const dd = distill.data ?? {};
    const stages = dd.stages ?? [];
    const firstFail = stages.find((x) => !x.ok);
    const detail = String(firstFail?.detail ?? '');

    rec(
      '⚠ 失败时如实报告停在哪一阶段（便于续跑，不白跑）',
      stages.length > 0 && Boolean(dd.stoppedAt),
      `stages=${stages.map((x) => `${x.stage}:${x.ok ? 'ok' : 'fail'}`).join(',')}｜stoppedAt=${dd.stoppedAt}`,
    );

    if (dd.ok === true) {
      rec(
        '蒸馏链跑通（标注 → 挖掘 → 编译）',
        stages.length === 3 && stages.every((x) => x.ok),
        stages.map((x) => x.stage).join(' → '),
      );
    } else {
      // ⚠ 区分三种"失败"，它们的性质完全不同：
      //   a) 模型未配置 → **环境问题**，非功能缺陷
      //   b) 跨作品样本不足 → **正确行为**（§21 要求至少两部同类型作品），
      //      沙盒里只有一部，编译本就该拒绝
      //   c) 其他 → 真失败
      const isModelIssue = /MODEL_AUTH|尚未配置模型|未配置模型/.test(detail);
      const isSampleIssue = /跨作品|至少两部|可用于编译/.test(detail);
      // 关键：标注与挖掘**都成功**了 —— 这才是本脚本要证明的链路连通
      const chainOk =
        stages.find((x) => x.stage === 'annotate')?.ok === true &&
        stages.find((x) => x.stage === 'mine')?.ok === true;

      rec(
        '⚠ 导入 → 标注 → 挖掘 链路连通（本脚本的核心断言）',
        chainOk,
        stages.map((x) => `${x.stage}:${x.ok ? 'ok' : 'fail'}`).join(', '),
      );

      if (isModelIssue) {
        rec(
          '蒸馏链可调用（模型未配置，属环境问题）',
          true,
          `⚠ ${detail.slice(0, 80)}`,
        );
      } else if (isSampleIssue) {
        rec(
          '⚠ 编译因"跨作品样本不足"被拒（§21 的正确行为，非缺陷）',
          true,
          `沙盒只有 1 部语料，编译本就需要 ≥2 部同类型作品：${detail.slice(0, 80)}`,
        );
      } else {
        rec('蒸馏链可调用', false, `失败于「${dd.stoppedAt}」：${detail.slice(0, 140)}`);
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

void readdirSync;
void readFileSync;
void existsSync;
