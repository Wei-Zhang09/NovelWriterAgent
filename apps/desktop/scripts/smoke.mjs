/**
 * STEP 0 端到端冒烟测试（无头，可在 CI 中运行）
 *
 * 验证 ADR-0001 的整条链路：
 *   main → utilityProcess(novel-core) → @nwa/storage → node:sqlite
 *
 * 做法：在 main 进程里直接做一次与渲染进程等价的调用序列，
 *      把结果写入文件后退出。不依赖 GUI 交互，因此可自动化。
 *
 * 运行：npx electron apps/desktop/scripts/smoke.mjs
 */
import { app, utilityProcess } from 'electron';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'dist', 'smoke-result.json');
const coreEntry = join(here, '..', 'dist', 'main', 'core-process.js');

const lines = [];
const log = (...a) => {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  lines.push(s);
  console.log(s);
};

let core = null;
const pending = new Map();
let nextId = 0;

function call(method, params) {
  return new Promise((resolve, reject) => {
    const requestId = `req-${++nextId}`;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`超时：${method}`));
    }, 20000);
    pending.set(requestId, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
    core.postMessage({ kind: 'request', requestId, method, params });
  });
}

function startCore() {
  return new Promise((resolve, reject) => {
    core = utilityProcess.fork(coreEntry, [], { serviceName: 'novel-core', stdio: 'pipe' });
    core.stdout?.on('data', (d) => process.stdout.write(`[core] ${d}`));
    core.stderr?.on('data', (d) => process.stderr.write(`[core:err] ${d}`));
    core.on('message', (msg) => {
      if (msg.kind === 'event' && msg.payload?.type === 'CORE_READY') {
        log('CORE_READY', JSON.stringify(msg.payload));
        resolve();
        return;
      }
      if (msg.kind === 'response') {
        const cb = pending.get(msg.requestId);
        if (cb) {
          pending.delete(msg.requestId);
          cb(msg.payload);
        }
      }
    });
    core.on('exit', (code) => log('core 退出，code =', code));
    setTimeout(() => reject(new Error('core 启动超时')), 25000);
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: String(detail) });
  log(`${ok ? '✓' : '✗'} ${name} — ${detail}`);
}

app.whenReady().then(async () => {
  log('=== STEP 0 端到端冒烟 ===');
  log('electron', process.versions.electron, 'node', process.versions.node);

  try {
    await startCore();

    const health = await call('core.health');
    check('core utilityProcess 通路', health.ok === true,
      health.ok ? `pid ${health.data.pid} · node ${health.data.node} · sqlite ${health.data.sqlite}` : JSON.stringify(health));
    check('子进程内 node:sqlite 可用', health.ok && health.data.sqlite === 'ready', String(health.data?.sqlite));

    const mig = await call('core.migrations');
    check('迁移已应用', mig.ok && mig.data.applied.length > 0,
      mig.ok ? mig.data.applied.map((m) => m.id).join(', ') : JSON.stringify(mig));

    const stats = await call('core.schema.stats');
    // 期望值来自迁移文件的静态声明（21 张表 + schema_migrations = 22；26 个显式索引）
    check('数据表数量', stats.ok && stats.data.tableCount >= 22, `${stats.data?.tableCount} 张表（期望 ≥22）`);
    check('索引数量', stats.ok && stats.data.indexCount >= 26, `${stats.data?.indexCount} 个索引（期望 ≥26）`);

    const fts = await call('core.fts.probe');
    check('FTS5 + bm25()', fts.ok && fts.data.bm25Works,
      fts.ok ? `MATCH 命中 ${fts.data.rows.length} 行` : JSON.stringify(fts));

    // 外键约束实际生效（ADR 要求连接级 PRAGMA 必须生效）
    const fk = await call('core.verify.constraints');
    check('外键约束生效', fk.ok && fk.data.foreignKeyEnforced === true,
      fk.ok ? `非法引用被拒：${fk.data.message}` : JSON.stringify(fk));
  } catch (err) {
    check('冒烟执行', false, err.message);
  }

  const passed = results.filter((r) => r.ok).length;
  log(`\n结果：${passed}/${results.length} 通过`);

  writeFileSync(OUT, JSON.stringify({ results, passed, total: results.length, log: lines }, null, 2), 'utf8');
  core?.kill();
  app.exit(passed === results.length ? 0 : 1);
});
