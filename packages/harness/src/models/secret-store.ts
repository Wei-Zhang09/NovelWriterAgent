/**
 * 密钥存储的文件实现（施工文档 §38）
 *
 * §38：**API Key 不放数据库明文**，优先使用 OS 凭据存储。
 *
 * 实现策略：
 *   - 宿主注入 encrypt / decrypt（Electron 里是 safeStorage，走 DPAPI/Keychain/libsecret）
 *   - 本模块只负责文件读写与格式，不自己造加密算法
 *   - 加密不可用时**拒绝写入**，而不是退化为明文 —— 静默降级会让用户以为已加密
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError, ErrorCode } from '@nwa/core';
import type { SecretStore } from './types.js';

interface CredentialsFile {
  readonly version: 1;
  readonly backend: string;
  /** ref → base64 密文 */
  readonly entries: Record<string, string>;
}

export interface CryptoBackend {
  readonly name: string;
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

export class FileSecretStore implements SecretStore {
  private readonly file: string;
  private readonly crypto: CryptoBackend;
  private cache: CredentialsFile | null = null;

  constructor(file: string, crypto: CryptoBackend) {
    this.file = file;
    this.crypto = crypto;
  }

  get backend(): string {
    return this.crypto.name;
  }

  private load(): CredentialsFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) {
      this.cache = { version: 1, backend: this.crypto.name, entries: {} };
      return this.cache;
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as CredentialsFile;
      if (raw.version !== 1 || typeof raw.entries !== 'object' || raw.entries === null) {
        throw new Error('格式不符合预期');
      }
      this.cache = raw;
      return raw;
    } catch (cause) {
      throw new AppError(
        ErrorCode.WORKSPACE_CORRUPTED,
        `凭据文件损坏，拒绝静默重建（避免覆盖用户已保存的密钥）：${this.file}`,
        { cause },
      );
    }
  }

  /** 原子写：先写 .tmp 再 rename，避免中途崩溃留下半截文件（同 ADR-0002 精神） */
  private persist(next: CredentialsFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(tmp, this.file);
    this.cache = next;
  }

  async get(ref: string): Promise<string | undefined> {
    const data = this.load();
    const enc = data.entries[ref];
    if (!enc) return undefined;
    try {
      return this.crypto.decrypt(Buffer.from(enc, 'base64'));
    } catch (cause) {
      throw new AppError(
        ErrorCode.MODEL_AUTH_FAILED,
        `无法解密密钥 ${ref}（可能是在别的用户/机器上加密的）`,
        { cause },
      );
    }
  }

  async set(ref: string, value: string): Promise<void> {
    if (!this.crypto.available()) {
      // 明确拒绝而不是明文落盘
      throw new AppError(
        ErrorCode.MODEL_AUTH_FAILED,
        `加密后端 ${this.crypto.name} 不可用，拒绝以明文保存密钥`,
      );
    }
    const data = this.load();
    const cipher = this.crypto.encrypt(value).toString('base64');
    this.persist({ ...data, entries: { ...data.entries, [ref]: cipher } });
  }

  async delete(ref: string): Promise<void> {
    const data = this.load();
    const entries = { ...data.entries };
    delete entries[ref];
    this.persist({ ...data, entries });
  }

  /** 仅列出引用名，绝不返回密钥值 */
  async listRefs(): Promise<string[]> {
    return Object.keys(this.load().entries).sort();
  }
}

/** 测试/降级用：明文内存实现。**禁止在生产路径使用**。 */
export class InMemorySecretStore implements SecretStore {
  readonly backend = 'in-memory (memory only)';
  private readonly map = new Map<string, string>();
  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.map.set(k, v);
  }
  async get(ref: string): Promise<string | undefined> {
    return this.map.get(ref);
  }
  async set(ref: string, value: string): Promise<void> {
    this.map.set(ref, value);
  }
  async delete(ref: string): Promise<void> {
    this.map.delete(ref);
  }
  async listRefs(): Promise<string[]> {
    return [...this.map.keys()].sort();
  }
}

export function defaultCredentialsPath(homeDir: string): string {
  return join(homeDir, '.config', 'novelwriter-agent', 'credentials.json');
}
