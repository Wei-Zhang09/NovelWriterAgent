/**
 * 模型服务诊断（真实端点 + 真实密钥，不暴露密钥内容）
 *
 *   pnpm verify:endpoint
 *
 * ## 为什么需要它
 *
 * `verify:annotate` 报 HTTP 503，但无法判断是：
 *   a) 端点本身故障（如上游限流、模型服务重启中）
 *   b) 我们的请求格式有问题（但那样通常是 400）
 *   c) 密钥失效（那样是 401）
 *
 * 这个脚本用**最小请求**直接打端点，把 HTTP 状态与响应体原文
 * 打印出来 —— 不经过任何业务逻辑，隔离出"服务端问题"还是"我们的问题"。
 *
 * ⚠ 密钥经 safeStorage 解密后直接用于请求头，**不打印**。
 */
import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { FileSecretStore, defaultCredentialsPath } from '@nwa/harness';

app.setName('@nwa/desktop');
app.setPath('userData', join(app.getPath('appData'), '@nwa/desktop'));

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    // 读用户模型配置（只读）
    const modelsPath = join(homedir(), 'NovelWriterProjects', 'models.json');
    if (!existsSync(modelsPath)) {
      console.log('✗ 未找到 models.json');
      app.exit(1);
      return;
    }
    const cfg = JSON.parse(readFileSync(modelsPath, 'utf8'));
    const prof = cfg.profiles?.[0];
    if (!prof) {
      console.log('✗ models.json 里没有 profile');
      app.exit(1);
      return;
    }
    console.log(`端点: ${prof.endpoint}`);
    console.log(`模型: ${prof.model}`);
    console.log(`密钥引用: ${prof.apiKeyRef ?? prof.apiKeyRefName ?? '(未知)'}`);

    // 解密密钥（不打印）
    const store = new FileSecretStore(defaultCredentialsPath(homedir()), {
      name: 'electron-safeStorage',
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (cipher) => safeStorage.decryptString(cipher),
    });
    const ref = prof.apiKeyRef ?? prof.apiKeyRefName;
    let key = null;
    try {
      key = await store.get(String(ref));
    } catch (e) {
      console.log(`✗ 解密密钥失败: ${e instanceof Error ? e.message : String(e)}`);
      app.exit(1);
      return;
    }
    if (!key) {
      console.log('✗ 密钥为空');
      app.exit(1);
      return;
    }
    console.log(`密钥: 已解密（长度 ${key.length}，内容不显示）`);
    console.log('');

    // ── 最小请求 ──
    const url = `${String(prof.endpoint).replace(/\/+$/, '')}/chat/completions`;
    const body = {
      model: prof.model,
      messages: [{ role: 'user', content: '说一个字' }],
      max_tokens: 8,
    };

    for (let i = 1; i <= 3; i++) {
      const started = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        console.log(`第 ${i} 次: HTTP ${res.status}（${Date.now() - started}ms）`);
        console.log(`  响应体: ${text.slice(0, 400)}`);
      } catch (e) {
        console.log(`第 ${i} 次: 异常 ${e instanceof Error ? e.message : String(e)}`);
      }
      if (i < 3) await new Promise((r) => setTimeout(r, 3000));
    }
  } catch (e) {
    console.log(`脚本异常: ${e instanceof Error ? e.message : String(e)}`);
  }
  app.exit(0);
});

