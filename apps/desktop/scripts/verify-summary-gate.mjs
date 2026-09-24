/**
 * Commit 前强制 Summary Approval —— 端到端验证（P1 / §十二）
 *
 *   pnpm verify:summary-gate
 *
 * ## 这个脚本要证明什么
 *
 * 施工文档 §十二：Commit 需要 `summary != empty AND summary_approved == 1`。
 *
 * 单元测试（tests/integration/summary-approval-gate.test.ts）已经覆盖了
 * 工具层的逻辑，但那是在**测试进程内直接 new 出来的工具**上跑的。
 * 本脚本要证明的是**真 core 进程 + 真数据库 + 真 IPC** 这条链上：
 *
 *   1. 摘要生成后（approved=0）→ commit.run 被拒，章节**没有**变成 COMMITTED
 *   2. 人工批准后 → commit.run 通过，章节变成 COMMITTED
 *   3. commitMode='FORCE' → 通过，且 commit_overrides 表里有审计记录
 *
 * ## ⚠ 为什么不写正文、不调模型
 *
 * 本脚本要验的是**门禁逻辑**，不是模型能力。调模型会让"失败"的归因
 * 变得含糊（是门禁没拦住，还是模型没写好？）。所以这里直接造
 * 最小可提交状态：章节行 + 工作区 draft.md + PASSED 审阅。
 *
 * 这样每一次运行都是确定性的 —— 模型方差不会让它时红时绿。
 */
import { app, utilityProcess, safeStorage } from 'electron';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { FileSecretStore, defaultCredentialsPath } from '@nwa/harness';

const here = dirname(fileURLToPath(import.meta.url));
const coreEntry = join(here, '..', 'dist', 'main', 'core-process.js');
// ⚠ 写进 dist/（已 gitignore）而不是脚本目录：结果文件是**产物**不是源码，
//   放在源码目录会被误提交，且每次运行都产生 diff 噪音。
const OUT = join(here, '..', 'dist', 'summary-gate-result.json');

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

function call(method, params = {}, timeoutMs = 120_000) {
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
    child.stdout?.on('data', (d) => {
      const t = String(d);
      if (/ERROR|WARN/.test(t)) process.stdout.write(`[core] ${t}`);
    });
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
    child.on('spawn', () => setTimeout(resolve, 1200));
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) reject(new Error(`core 退出码 ${code}`));
    });
  });
}

app.on('window-all-closed', () => {});
app.setName('@nwa/desktop');
app.setPath('userData', join(app.getPath('appData'), '@nwa/desktop'));

app.whenReady().then(async () => {
  const sandbox = join(app.getPath('temp'), 'nwa-verify-sumgate');
  const projDir = join(sandbox, 'proj');

  try {
    // ⚠ 每次清空沙盒：残留的 COMMITTED 章节会让 chapter.plan 与 commit
    //   在第二次运行时以完全不同的原因失败（上次实测踩过这个坑）。
    rmSync(sandbox, { recursive: true, force: true });
    mkdirSync(projDir, { recursive: true });

    await startCore();
    const open = await call('project.open', { dir: projDir });
    if (!open.ok) {
      rec('打开项目', false, open.error?.message);
      return finish();
    }
    rec('项目已打开（隔离沙盒，每次清空）', true, String(open.data?.dir ?? ''));

    const info = await call('project.info', {});
    let projectId = info.data?.projects?.[0]?.id;
    if (!projectId) {
      const np = await call('tool.invoke', {
        name: 'project.create',
        input: { name: '摘要门禁验证项目', genre: 'urban_fantasy' },
        permission: 'ADMIN',
      });
      projectId = np.data?.id ?? np.data?.projectId;
    }
    const bk = await call('book.create', { projectId, title: '摘要门禁验证书' });
    const bookId = bk.data?.id;
    if (!bookId) {
      rec('已创建书', false, `${bk.error?.code}：${bk.error?.message}`);
      return finish();
    }
    rec('已创建书', true, `bookId=${bookId}`);

    /**
     * 造一段**真能过摘要校验**的正文。
     *
     * ⚠ 不能用"这是一段占位正文"之类的样板文字：摘要生成器会做
     *   占位符校验并拒绝（MODEL_STRUCTURED_EMPTY：摘要含占位符）。
     *   那是防止把模板文字当成作品入库的护栏，不该为了测试绕过它。
     *   所以这里给真实的叙事段落。
     */
    function DRAFT_TEXT(n) {
      return [
        `第 ${n} 章`,
        '',
        '夜里九点半，沈砚把最后一块上海牌手表放回绒布上，拧紧后盖。铺子里只剩一盏灯，',
        '光落在工作台的划痕上。他按惯例把镊子、油壶、螺丝刀依次归位，最后才去碰那只铁皮盒。',
        '',
        '盒子是父亲留下的，锁扣早就坏了，一直用一截铜丝别着。今晚铜丝是松的。',
        '沈砚停了两秒，掀开盖子。里面本该躺着十二枚旧机芯，现在只剩十一枚，',
        '最上面那一枚的位置空着，绒布上留着圆形的压痕。',
        '',
        '他没有立刻翻找。他先去看了门。门闩是从里面插着的，木窗的插销也没有动过。',
        '这间铺子只有他一个人有钥匙。',
        '',
        '老周住在隔壁，隔着一堵墙。沈砚敲了三下，里面很快有了动静。老周披着外套开门，',
        '看见他的脸色，什么也没问，只把灯拨亮了些。',
        '',
        '「少了一枚。」沈砚说。',
        '',
        '老周沉默了一会儿，说：「你父亲那辈人，机芯是有编号的。」',
        '他让沈砚把剩下十一枚的编号抄下来，明天去旧货市场问问。',
        '',
        '沈砚回铺子的时候，阿柒正蹲在门口的台阶上，手里捏着一枚铜丝。',
        '她说她在巷口捡到的，看着像谁家别门用的，就顺路拿过来问问是不是他的。',
        '',
        '沈砚接过铜丝，没有出声。他认得出，这就是盒子上那一截。',
      ].join('\n');
    }

    /** 造一个"除摘要外都满足提交条件"的章节 */
    async function makeCommitReadyChapter(n) {
      const cr = await call('tool.invoke', {
        name: 'chapter.create',
        input: { bookId, chapterNumber: n, title: `第 ${n} 章` },
        permission: 'ADMIN',
      });
      const chapterId = cr.data?.chapterId ?? cr.data?.id;
      if (!chapterId) return null;

      // 工作区草稿（commit 要求有正文）
      const wsDir = join(projDir, 'workspace', `chapter-${String(n).padStart(3, '0')}`);
      mkdirSync(wsDir, { recursive: true });
      writeFileSync(join(wsDir, 'draft.md'), DRAFT_TEXT(n), 'utf8');

      // PASSED 审阅 —— 否则会被 §33 BLOCKING 门拦下，测不到摘要门。
      //
      // ⚠ 直接写库，不走 review.run：那个 IPC 会**真调模型**，
      //   而模型方差会让本脚本时红时绿。这里要验的是门禁逻辑，
      //   不是模型能力，所以把审阅结果当成给定输入直接落盘。
      setReviewStatus(chapterId, 'PASSED');
      return chapterId;
    }

    /**
     * 直接写审阅结果（绕过会调模型的 review.run）。
     *
     * ⚠ 用独立连接写：core 进程持有自己的连接（WAL 模式），
     *   提交后的写入对 core 可见。
     */
    function setReviewStatus(chapterId, status) {
      const db = new DatabaseSync(join(projDir, 'project.db'));
      try {
        db.prepare(
          'UPDATE chapters SET review_json = ?, review_status = ?, updated_at = ? WHERE id = ?',
        ).run(
          JSON.stringify({ issues: [], overallStatus: status }),
          status,
          new Date().toISOString(),
          chapterId,
        );
      } finally {
        db.close();
      }
    }

    /** 读 commit_overrides 表（直接读盘，验证真落盘而不是 IPC 自证） */
    function readOverrides(chapterId) {
      const db = new DatabaseSync(join(projDir, 'project.db'));
      try {
        return db
          .prepare(
            'SELECT * FROM commit_overrides WHERE chapter_id = ? ORDER BY created_at ASC',
          )
          .all(chapterId);
      } finally {
        db.close();
      }
    }

    /** 读章节状态（直接读盘） */
    function readStatus(chapterId) {
      const db = new DatabaseSync(join(projDir, 'project.db'));
      try {
        const row = db.prepare('SELECT status FROM chapters WHERE id = ?').get(chapterId);
        return row ? String(row.status) : '(缺行)';
      } finally {
        db.close();
      }
    }

    console.log('\n──── 1. 摘要生成后未批准 → 必须被拒 ────\n');

    const ch1 = await makeCommitReadyChapter(1);
    if (!ch1) {
      rec('创建第 1 章', false, '失败');
      return finish();
    }
    rec('第 1 章已创建（draft.md + PASSED 审阅）', true, ch1);

    // 生成摘要（真模型）。这一步会真的调 LLM。
    const gen = await call('summary.generate', { chapterId: ch1 }, 300_000);
    const genOk = gen.ok === true && gen.data?.ok !== false;
    rec(
      '第 1 章摘要已生成',
      genOk,
      genOk
        ? `${String(gen.data?.summary ?? '').length} 字（**未批准**）`
        : `${gen.error?.code ?? gen.data?.error?.code}：${String(gen.error?.message ?? gen.data?.error?.message ?? '').slice(0, 120)}`,
    );
    if (!genOk) return finish();

    // 核心断言：未批准 → 拒绝
    const c1 = await call('commit.run', { chapterId: ch1 });
    const blocked = c1.ok === false || c1.data?.ok === false;
    const msg = String(c1.error?.message ?? c1.data?.error?.message ?? '');
    rec(
      '⚠ 未批准的摘要 → commit.run 被拒（这是本轮修的核心 bug）',
      blocked && msg.includes('尚未人工批准'),
      blocked ? msg.slice(0, 120) : '⚠ 竟然提交成功了 —— 门禁没生效',
    );

    // ⚠ 关键：不能只看 IPC 返回，要**直接读库**确认状态没被推进。
    //   IPC 说"失败了"而库里已经 COMMITTED，是最坏的情况 ——
    //   报告显示被拦、实际已落库。
    const status1 = readStatus(ch1);
    rec(
      '⚠ 被拒后章节状态**未**推进到 COMMITTED（直读库）',
      status1 !== 'COMMITTED',
      `实际状态：${status1}`,
    );

    console.log('\n──── 2. 人工批准后 → 必须放行 ────\n');

    const appr = await call('summary.approve', { chapterId: ch1 });
    const apprOk = appr.ok === true && appr.data?.ok !== false;
    rec(
      '第 1 章摘要已人工批准',
      apprOk,
      apprOk ? 'summary_approved = 1' : `${appr.error?.code}：${appr.error?.message}`,
    );
    if (!apprOk) return finish();

    const c2 = await call('commit.run', { chapterId: ch1 });
    const ok2 = c2.ok === true && c2.data?.ok !== false;
    rec(
      '⚠ 已批准的摘要 → commit.run 通过',
      ok2,
      ok2 ? `${c2.data?.status}（${c2.data?.appliedCount} 产物）` : `${c2.error?.code}：${String(c2.error?.message ?? '').slice(0, 120)}`,
    );

    console.log('\n──── 3. FORCE 绕过 → 通过且留审计 ────\n');

    const ch2 = await makeCommitReadyChapter(2);
    if (!ch2) {
      rec('创建第 2 章', false, '失败');
      return finish();
    }
    // 生成摘要但**不批准** —— 这正是 FORCE 要处理的场景
    const gen2 = await call('summary.generate', { chapterId: ch2 }, 300_000);
    if (gen2.ok !== true || gen2.data?.ok === false) {
      rec('第 2 章摘要已生成', false, '生成失败，跳过 FORCE 用例');
      return finish();
    }
    rec('第 2 章摘要已生成（未批准）', true, `${String(gen2.data?.summary ?? '').length} 字`);

    const c3 = await call('commit.run', {
      chapterId: ch2,
      commitMode: 'FORCE',
      forceReason: '端到端验证：确认 FORCE 通道可用且留痕',
    });
    const ok3 = c3.ok === true && c3.data?.ok !== false;
    rec(
      '⚠ commitMode=FORCE → 放行（未批准的摘要被显式绕过）',
      ok3,
      ok3 ? `${c3.data?.status}` : `${c3.error?.code}：${String(c3.error?.message ?? '').slice(0, 120)}`,
    );

    // ⚠ 审计必须落盘 —— 这是"允许绕过"的前提。只放行不记录
    //   等于把绕过变成静默行为，事后无法回答"这章为什么没摘要"。
    //
    // ⚠ 直接读表，不用 IPC 查询自证：用同一套代码既写又读，
    //   写错了也会"读对"。
    const rows = readOverrides(ch2);
    const hit = rows.find((r) => String(r.overridden_check) === 'SUMMARY_APPROVAL');
    rec(
      '⚠ FORCE 绕过已写入 commit_overrides 审计记录（直读表）',
      Boolean(hit),
      hit
        ? `${rows.length} 条；check=${hit.overridden_check}；summary_present=${hit.summary_present_at_override}；summary_approved=${hit.summary_approved_at_override}；reason=${String(hit.reason ?? '').slice(0, 40)}`
        : `表中无记录（共 ${rows.length} 行）`,
    );
    rec(
      '⚠ 审计快照如实记录"有摘要但未批准"',
      Boolean(hit) && Number(hit.summary_present_at_override) === 1 && Number(hit.summary_approved_at_override) === 0,
      hit ? `present=${hit.summary_present_at_override} approved=${hit.summary_approved_at_override}` : '无记录',
    );

    console.log('\n──── 4. FORCE 不得绕过内容正确性检查 ────\n');

    const ch3 = await makeCommitReadyChapter(3);
    if (ch3) {
      // 造 BLOCKING 审阅（直写库，理由同 setReviewStatus）
      setReviewStatus(ch3, 'BLOCKED');
      const c4 = await call('commit.run', {
        chapterId: ch3,
        commitMode: 'FORCE',
        forceReason: '不该成功：FORCE 不得绕过 BLOCKING',
      });
      const blocked4 = c4.ok === false || c4.data?.ok === false;
      const msg4 = String(c4.error?.message ?? c4.data?.error?.message ?? '');
      rec(
        '⚠ FORCE 仍被 §33 BLOCKING 拦住（内容问题不得放行）',
        blocked4 && msg4.includes('BLOCKING'),
        blocked4 ? msg4.slice(0, 110) : '⚠ FORCE 绕过了 BLOCKING —— 这是严重缺陷',
      );
    } else {
      rec('创建第 3 章', false, '失败');
    }

    return finish(steps.some((s) => !s.ok) ? 1 : 0);
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
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify({ pass: failed.length === 0, steps }, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
  app.exit(code);
}
