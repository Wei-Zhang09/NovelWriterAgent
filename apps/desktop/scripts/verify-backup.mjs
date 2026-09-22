/**
 * 备份 / 恢复验证（STEP 21 / §58 §59）
 *
 *   pnpm verify:backup
 *
 * ## 这个脚本要验证什么
 *
 * 1. 导出产出 §58 的布局（project.json / project.db / chapters/ /
 *    corpus/ / skills/ / manifest.json）
 * 2. ⚠ manifest 带 sha256，且校验能发现**被篡改的字节**
 * 3. ⚠ **损坏的备份必须在覆盖数据前被拒绝** —— 这是本功能能造成的
 *    最严重损失（用坏备份盖掉好数据）
 * 4. ⚠ 恢复必须**重建 FTS**（§59）—— 否则检索静默返回空
 * 5. ⚠ 目标已存在时**默认拒绝覆盖**，显式 overwrite 才执行且可回滚
 * 6. ⚠ workspace（未验证中间产物）**不**出现在导出物里
 *
 * ⚠ 全程用隔离的临时目录，不碰用户真实项目。
 */
import { app, utilityProcess, safeStorage } from 'electron';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
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
  const sandbox = join(app.getPath('temp'), 'nwa-verify-backup');
  const projDir = join(sandbox, 'proj');
  const badDir = join(sandbox, 'tampered');

  try {
    rmSync(sandbox, { recursive: true, force: true });
    mkdirSync(projDir, { recursive: true });

    await startCore();
    rec('core 进程已启动', true);

    const open = await call('project.open', { rootDir: projDir });
    if (!open.ok) {
      rec('打开项目', false, open.error?.message);
      return finish();
    }
    rec('打开项目', true, projDir);

    // 造一点真实内容：项目 + 书 + 章 + 正文文件
    const info = await call('project.info', {});
    let projectId = (info.data?.projects ?? [])[0]?.id;
    if (!projectId) {
      const created = await call('tool.invoke', {
        name: 'project.create',
        input: { name: '备份验证', genre: '都市' },
        permission: 'ADMIN',
      });
      projectId = created.data?.id ?? created.data?.projectId;
    }
    const book = await call('tool.invoke', {
      name: 'book.create',
      input: { projectId, title: '备份验证·卷一' },
      permission: 'ADMIN',
    });
    const bookId = book.data?.id;
    rec('建书（走 book.create 工具）', Boolean(bookId), bookId);

    await call('tool.invoke', {
      name: 'chapter.create',
      input: { bookId, chapterNumber: 1, title: '第一章' },
      permission: 'ADMIN',
    });

    // 直接放一个正文文件（模拟已提交章节的 Markdown 真源）
    const chaptersDir = join(projDir, 'chapters');
    mkdirSync(chaptersDir, { recursive: true });
    writeFileSync(join(chaptersDir, '001.md'), '第一章正文：他在江边认出了那块铜牌。', 'utf8');

    // workspace 放一个中间产物 —— 它**不该**出现在导出物里
    const wsDir = join(projDir, 'workspace', 'chapter-001');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'draft.md'), '未验证草稿', 'utf8');

    // ── 1. 导出 ──
    console.log('\n──── 导出 ────\n');
    // ⚠ 显式给 outDir：默认导出目录是 PROJECTS_ROOT/exports，
    //   而验证必须在沙盒内完成（不碰用户真实目录）。
    const exp = await call('backup.export', { outDir: join(sandbox, 'export') });
    if (!exp.ok) {
      rec('导出项目', false, `${exp.error?.code}：${exp.error?.message}`);
      return finish();
    }
    const outDir = exp.data.outDir;
    console.log(`  导出到 ${outDir}｜${exp.data.files} 个文件｜${exp.data.bytes} 字节`);
    rec('导出项目', exp.data.files > 0, `${exp.data.files} 个文件`);

    // §58 的布局
    const layout = ['project.db', 'manifest.json', 'chapters'];
    const missing = layout.filter((f) => !existsSync(join(outDir, f)));
    rec('§58 布局完整（project.db / manifest.json / chapters/）', missing.length === 0, missing.join('、') || '齐全');

    // ⚠ workspace 不该被导出
    rec(
      '⚠ 未导出 workspace（未验证的中间产物）',
      !existsSync(join(outDir, 'workspace')),
      existsSync(join(outDir, 'workspace')) ? '❌ 被导出了' : '已排除',
    );
    // 如实声明排除了什么
    const excluded = exp.data.excluded ?? [];
    rec(
      'manifest 如实声明排除了什么',
      excluded.length > 0,
      excluded.join('；').slice(0, 120),
    );

    // ── 2. 校验完整性 ──
    console.log('\n──── 校验完整性 ────\n');
    const ver = await call('backup.verify', { dir: outDir });
    rec('校验通过（sha256 全部匹配）', ver.data?.ok === true, `检查 ${ver.data?.checked} 个文件`);
    if (ver.data?.problems?.length) {
      for (const p of ver.data.problems) console.log(`    ✗ ${p}`);
    }

    // ── 3. ⚠ 篡改一个字节 → 校验必须发现 ──
    console.log('\n──── 篡改检测 ────\n');
    rmSync(badDir, { recursive: true, force: true });
    const { cpSync } = await import('node:fs');
    cpSync(outDir, badDir, { recursive: true });
    // 篡改**真源**文件（chapters 下的正文）—— 它一定在导出物里
    appendFileSync(join(badDir, 'chapters', '001.md'), '（被篡改）', 'utf8');

    const badVer = await call('backup.verify', { dir: badDir });
    rec(
      '⚠ 篡改被检出（校验和不符）',
      badVer.data?.ok === false,
      badVer.data?.problems?.[0]?.slice(0, 80) ?? '未检出（严重问题）',
    );

    // ── 4. ⚠ 损坏的备份必须被拒绝（在覆盖数据之前）──
    console.log('\n──── 拒绝损坏的备份 ────\n');
    const badRestore = await call('backup.restore', {
      backupDir: badDir,
      targetDir: projDir,
      overwrite: true,
    });
    rec(
      '⚠ 损坏备份被拒绝恢复',
      badRestore.data?.ok === false,
      `${badRestore.data?.error?.code}：${badRestore.data?.error?.message?.slice(0, 70)}`,
    );
    // 原数据必须完好
    const origText = readFileSync(join(projDir, 'chapters', '001.md'), 'utf8');
    rec(
      '⚠ 拒绝后原数据完好（没被坏备份覆盖）',
      origText.includes('铜牌') && !origText.includes('被篡改'),
      `${origText.length} 字节`,
    );

    // ── 5. ⚠ 目标已存在时默认拒绝覆盖 ──
    console.log('\n──── 覆盖保护 ────\n');
    const noOverwrite = await call('backup.restore', {
      backupDir: outDir,
      targetDir: projDir,
    });
    rec(
      '⚠ 目标已存在时默认拒绝覆盖',
      noOverwrite.data?.ok === false && noOverwrite.data?.error?.code === 'TARGET_EXISTS',
      noOverwrite.data?.error?.code ?? '（应报 TARGET_EXISTS）',
    );

    // ── 6. 恢复到一个**未打开**的目标目录（真实恢复场景）+ 重建 FTS ──
    //
    // ⚠ 不能恢复到 `projDir` —— 它正被 `project.open` 持有，
    //   Windows 不允许重命名被打开的项目目录（EPERM）。
    //   真实场景里"数据库损坏 → 恢复"也是恢复到**当前没打开**的位置，
    //   所以这里用新的空目录，顺便验证 TARGET_IN_USE 的诊断。
    console.log('\n──── 恢复 + 重建 FTS ────\n');

    // 先验证"恢复到被占用的目录"给出的是明确诊断而非含糊 EPERM
    const inUse = await call('backup.restore', {
      backupDir: outDir,
      targetDir: projDir,
      overwrite: true,
    });
    rec(
      '⚠ 恢复到被占用目录 → 明确报 TARGET_IN_USE（不是含糊的 EPERM）',
      inUse.data?.error?.code === 'TARGET_IN_USE',
      `${inUse.data?.error?.code}：${String(inUse.data?.error?.message ?? '').slice(0, 60)}`,
    );

    const restoreDir = join(sandbox, 'restored');
    const restored = await call('backup.restore', {
      backupDir: outDir,
      targetDir: restoreDir,
      overwrite: true,
    });
    rec('恢复执行', restored.data?.ok === true, restored.data?.error?.message ?? '成功');
    // 目标是新目录（原本不存在）→ 无需移走现状
    rec(
      '恢复到新目录时不需要移走现状',
      restored.data?.previousMovedTo === null,
      String(restored.data?.previousMovedTo),
    );
    const afterText = readFileSync(join(restoreDir, 'chapters', '001.md'), 'utf8');
    rec('⚠ 正文已还原', afterText.includes('铜牌'), `${afterText.length} 字节`);
    rec(
      '⚠ FTS 已重建（§59：索引不是唯一事实源）',
      restored.data?.ftsRebuilt !== null,
      JSON.stringify(restored.data?.ftsRebuilt),
    );
    for (const w of restored.data?.warnings ?? []) console.log(`    ⚠ ${w}`);

    // ── 7. 独立重建入口 ──
    const rebuild = await call('backup.rebuildFts', {});
    rec(
      '独立重建 FTS 入口可用',
      rebuild.ok === true,
      JSON.stringify(rebuild.data ?? rebuild.error),
    );
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
