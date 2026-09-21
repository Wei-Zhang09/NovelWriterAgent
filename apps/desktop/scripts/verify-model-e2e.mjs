/**
 * 模型接入的真实端到端验证（STEP 3 验收）
 *
 * 验证三件事，且都不依赖外部服务：
 *   1. 密钥经 main 进程 safeStorage 加密后落盘 —— 磁盘上找不到明文
 *   2. Gateway 用加密存储里的密钥发出真实 HTTP 请求（打到一个本地替身服务）
 *   3. 结构化输出与错误码在真实进程边界下表现正确
 *
 * 做法：启动一个本地 OpenAI-compatible 替身服务，然后在 main 进程里
 *      走与 UI 完全相同的 IPC 路径（model.config.save → model.test）。
 */
import { app, utilityProcess, safeStorage } from 'electron';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'dist', 'model-e2e-result.json');
const coreEntry = join(here, '..', 'dist', 'main', 'core-process.js');

const steps = [];
const rec = (name, ok, detail) => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ── 本地 OpenAI-compatible 替身 ──────────────────────────────
let receivedAuth = null;
let receivedBody = null;
let server;
let stubUrl = '';

function startStub() {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        receivedAuth = req.headers.authorization ?? null;
        try {
          receivedBody = JSON.parse(raw);
        } catch {
          receivedBody = raw;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'stub-model-v1',
            choices: [{ message: { content: '连通' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      stubUrl = `http://127.0.0.1:${port}/v1`;
      resolve();
    });
  });
}

// ── core 进程通信 ────────────────────────────────────────────
let core = null;
const pending = new Map();
let seq = 0;

function call(method, params) {
  return new Promise((resolve, reject) => {
    const requestId = `e2e-${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`超时：${method}`));
    }, 30000);
    pending.set(requestId, (p) => {
      clearTimeout(timer);
      resolve(p);
    });
    core.postMessage({ kind: 'request', requestId, method, params });
  });
}

async function startCore() {
  return new Promise((resolve, reject) => {
    core = utilityProcess.fork(coreEntry, [], { serviceName: 'novel-core', stdio: 'pipe' });
    core.stdout?.on('data', (d) => process.stdout.write(`[core] ${d}`));
    core.stderr?.on('data', (d) => process.stderr.write(`[core:err] ${d}`));
    core.on('message', async (msg) => {
      if (msg.kind === 'crypto-request') {
        // main 侧代理解密请求（与 main.ts 中的逻辑一致）
        try {
          const p = msg.payload ?? {};
          let value;
          if (msg.op === 'get') value = await store.get(String(p.ref));
          else if (msg.op === 'set') await store.set(String(p.ref), String(p.value));
          else if (msg.op === 'delete') await store.delete(String(p.ref));
          else if (msg.op === 'listRefs') value = await store.listRefs();
          core.postMessage({ kind: 'crypto-response', requestId: msg.requestId, ok: true, value });
        } catch (err) {
          core.postMessage({
            kind: 'crypto-response',
            requestId: msg.requestId,
            ok: false,
            error: String(err?.message ?? err),
          });
        }
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
    core.on('exit', (code) => console.log('core exited', code));
    setTimeout(resolve, 1500);
    setTimeout(() => reject(new Error('core 启动超时')), 20000);
  });
}

// 与 main.ts 相同的 FileSecretStore 装配（在 app.whenReady 中初始化）
let store = null;

app.whenReady().then(async () => {
  console.log('=== 模型接入端到端验证 ===\n');
  await startStub();
  console.log(`替身服务：${stubUrl}\n`);

  // 直接引 harness 的 FileSecretStore（与 main.ts 同一实现）
  const harness = await import(
    `file://${join(here, '..', '..', '..', 'packages', 'harness', 'dist', 'index.js').replace(/\\/g, '/')}`
  );
  const credPath = join(homedir(), '.config', 'novelwriter-agent', 'credentials.json');
  store = new harness.FileSecretStore(credPath, {
    name: 'electron-safeStorage',
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (cipher) => safeStorage.decryptString(cipher),
  });

  try {
    if (existsSync(credPath)) rmSync(credPath);

    await startCore();

    // 1) 保存配置（含密钥）
    const SECRET = 'sk-e2e-test-key-DO-NOT-LOG-abcdef123456';
    const save = await call('model.config.save', {
      profile: { id: 'e2e', endpoint: stubUrl, model: 'stub-model', temperature: 0, maxTokens: 64 },
      apiKey: SECRET,
      useForAllSlots: true,
    });
    rec('保存模型配置', save.ok === true, save.ok ? `profile=${save.data.profileId}` : JSON.stringify(save.error));

    // 1b) ⚠ 保存后必须立即 agentReady（回归测试）
    //
    // 实测 bug：runtime 只在 project.open 时构建。用户在界面配好模型后
    // p.runtime 仍为 null，点「规划当前章节」报"尚未配置模型"，
    // 看起来像配置没生效。
    const saveData = save.ok ? save.data : {};
    rec(
      '⚠ 保存后模型即刻就绪（agentReady）',
      saveData.agentReady === true,
      saveData.agentReady === true
        ? 'agentReady=true'
        : `agentReady=${String(saveData.agentReady)}${saveData.rebuildError ? `，错误：${saveData.rebuildError}` : ''}`,
    );

    // 2) 密钥加密落盘检查
    const onDisk = existsSync(credPath) ? readFileSync(credPath, 'utf8') : '';
    rec('凭据文件已生成', onDisk.length > 0, credPath);
    rec('⚠ 磁盘上不含明文密钥', !onDisk.includes(SECRET), onDisk.includes(SECRET) ? '发现明文！' : '未发现');
    rec('凭据文件声明了加密后端', onDisk.includes('electron-safeStorage'), '');
    let cipherOk = false;
    try {
      const parsed = JSON.parse(onDisk);
      const raw = Buffer.from(parsed.entries['profile:e2e'] ?? '', 'base64');
      cipherOk = raw.length > 0 && !raw.toString('utf8').includes(SECRET);
    } catch {
      cipherOk = false;
    }
    rec('密文可解析且非明文', cipherOk, '');

    // 3) models.json 里不含密钥，只有引用名
    const modelsJson = join(homedir(), 'NovelWriterProjects', 'models.json');
    const mj = existsSync(modelsJson) ? readFileSync(modelsJson, 'utf8') : '';
    rec('models.json 已生成', mj.length > 0, modelsJson);
    rec('⚠ models.json 不含明文密钥', !mj.includes(SECRET), '');
    rec('models.json 只存引用名', mj.includes('profile:e2e'), '');

    // 4) 真实 HTTP 调用（经 encrypted keystore 取密钥）
    const test = await call('model.test', { slot: 'utility', prompt: 'ping' });
    rec('模型连通测试成功', test.ok === true, test.ok ? `model=${test.data.model} ${test.data.latencyMs}ms` : JSON.stringify(test.error));
    if (test.ok) {
      rec('响应文本正确', test.data.text.trim() === '连通', test.data.text.trim());
      rec('token 统计被记录（不被脱敏）',
        test.data.usage.inputTokens === 9 && test.data.usage.outputTokens === 2,
        `in=${test.data.usage.inputTokens} out=${test.data.usage.outputTokens}`);
    }

    // 5) 替身服务确实收到了来自加密存储的密钥
    rec('⚠ 服务端收到 Bearer 鉴权头', receivedAuth === `Bearer ${SECRET}`,
      receivedAuth ? `${String(receivedAuth).slice(0, 12)}…` : '(无)');
    rec('⚠ 鉴权头无重复 Bearer 前缀',
      !/Bearer\s+Bearer/i.test(String(receivedAuth ?? '')),
      String(receivedAuth ?? '').slice(0, 20));
    rec('请求体含正确模型名', receivedBody?.model === 'stub-model', String(receivedBody?.model));

    // 6) 未配置 profile 时的错误可读
    const ghost = await call('model.test', { slot: 'architect' });
    rec('槽位有效（四槽位都指向 e2e）', ghost.ok === true || ghost.data?.ok === true, '');
  } catch (err) {
    rec('执行过程', false, String(err?.message ?? err));
  }

  const passed = steps.filter((s) => s.ok).length;
  writeFileSync(OUT, JSON.stringify({ steps, passed, total: steps.length }, null, 2), 'utf8');
  console.log(`\n结果：${passed}/${steps.length}`);

  server?.close();
  core?.kill();
  // 清理测试产物，避免污染真实项目目录
  try {
    if (existsSync(credPath)) rmSync(credPath);
    const modelsJson = join(homedir(), 'NovelWriterProjects', 'models.json');
    if (existsSync(modelsJson)) rmSync(modelsJson);
  } catch {
    /* 清理失败不影响判定 */
  }
  app.exit(passed === steps.length ? 0 : 1);
});
