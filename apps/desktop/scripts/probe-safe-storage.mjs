/**
 * safeStorage 可用性探针
 *
 * §38 要求「API Key 不放数据库明文」，选定的方案是用 Electron safeStorage
 * 加密后写入 ~/.config/novelwriter-agent/credentials.json。
 *
 * 但 safeStorage 的可用性依赖平台后端（Windows 上是 DPAPI，且需要 app ready）。
 * **必须先实测**，不能假设 —— 若不可用，加密会退化为明文，那就违背了 §38。
 */
import { app, safeStorage } from 'electron';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'dist', 'safe-storage-probe.json');

app.whenReady().then(() => {
  const result = {
    platform: process.platform,
    electron: process.versions.electron,
    isEncryptionAvailable: safeStorage.isEncryptionAvailable(),
    backend: 'unknown',
    roundTripOk: false,
    cipherLooksEncrypted: false,
    error: null,
  };

  try {
    // Windows 上可查询实际后端
    if (typeof safeStorage.getSelectedStorageBackend === 'function') {
      result.backend = safeStorage.getSelectedStorageBackend();
    } else {
      result.backend = process.platform === 'win32' ? 'dpapi (windows)' : 'n/a';
    }

    const secret = 'sk-test-roundtrip-1234567890-中文';
    const encrypted = safeStorage.encryptString(secret);
    const buf = Buffer.from(encrypted);
    result.cipherLooksEncrypted = !buf.toString('utf8').includes('sk-test-roundtrip');

    const decrypted = safeStorage.decryptString(buf);
    result.roundTripOk = decrypted === secret;
    result.cipherLength = buf.length;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
  app.exit(result.isEncryptionAvailable && result.roundTripOk ? 0 : 1);
});
