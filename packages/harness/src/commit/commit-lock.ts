/**
 * Commit 排他锁（ADR-0002 v2 机制 ④）
 *
 * 目的：同一项目目录同时只允许一个 Commit（防用户重复点击、防两个 Run 并行提交）。
 *
 * ## 关键教训（来自 InkOS）
 *
 * InkOS 曾用静态 `.write.lock` 文件，要求用户**手动删除**才能继续 ——
 * 一次崩溃就让项目卡死，用户不知道发生了什么。
 *
 * 因此本实现用**心跳租约 + 陈旧锁自动回收**：
 *   - 锁文件里写持有者 id 与心跳时间
 *   - 持有者每 N 秒更新一次心跳
 *   - 他人获取时若发现心跳超时 → 判定为陈旧锁，自动回收
 *
 * ⚠ 收回陈旧锁必须**留下记录**（返回 reclaimed 信息），
 *   否则"同时有两个提交在跑"这种事会无声发生。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, ErrorCode, type Nullable } from '@nwa/core';

/** 锁文件内容 */
interface LockRecord {
  readonly ownerId: string;
  /** 最后一次心跳的 ISO 时间 */
  readonly heartbeatAt: string;
  readonly acquiredAt: string;
  readonly pid: number;
}

export interface CommitLockOptions {
  /** 项目根目录 */
  readonly rootDir: string;
  /** 心跳视为陈旧的阈值（毫秒，默认 30s） */
  readonly staleAfterMs: number;
  readonly ownerId: string;
}

export interface LockHandle {
  readonly ownerId: string;
  /** 主动释放 */
  release(): void;
  /** 续租（长任务中定期调用） */
  renew(): void;
  /** 读取当前锁的年龄（毫秒） */
  ageMs(): number;
}

export interface AcquireResult {
  readonly ok: true;
  readonly handle: LockHandle;
  /** 若因回收陈旧锁而拿到锁，这里说明被回收的原持有者 */
  readonly reclaimed?: { readonly ownerId: string; readonly ageMs: number };
}

export const LOCK_FILE_NAME = '.commit.lock';

export class CommitLock {
  private readonly file: string;
  private readonly rootDir: string;
  private readonly staleAfterMs: number;
  private readonly ownerId: string;

  constructor(opts: CommitLockOptions) {
    this.rootDir = opts.rootDir;
    this.file = join(opts.rootDir, LOCK_FILE_NAME);
    this.staleAfterMs = opts.staleAfterMs;
    this.ownerId = opts.ownerId;
  }

  /**
   * 尝试获取锁。
   *
   * ⚠ 不阻塞等待：拿不到就明确失败，由调用方决定是否重试 ——
   *   静默排队会让用户以为"点了没反应"。
   */
  acquire(): AcquireResult {
    mkdirSync(this.rootDir, { recursive: true });

    const existing = this.read();
    if (existing !== null) {
      const age = this.ageOf(existing);
      if (age < this.staleAfterMs) {
        throw new AppError(
          ErrorCode.COMMIT_FAILED,
          `已有提交正在进行（持有者 ${existing.ownerId}，${Math.round(age / 1000)} 秒前有心跳）。` +
            '请等待其完成，或确认进程已退出后重试。',
          { details: { owner: existing.ownerId, ageMs: age, pid: existing.pid } },
        );
      }
      // 陈旧锁 → 回收
      const reclaimedInfo = { ownerId: existing.ownerId, ageMs: age };
      this.write();
      return { ok: true, handle: this.makeHandle(), reclaimed: reclaimedInfo };
    }

    this.write();
    return { ok: true, handle: this.makeHandle() };
  }

  /** 读取锁记录；文件损坏视为陈旧（返回一个 age 极大的记录） */
  read(): Nullable<LockRecord> {
    if (!existsSync(this.file)) return null;
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as LockRecord;
      if (typeof parsed.ownerId !== 'string' || typeof parsed.heartbeatAt !== 'string') {
        return null;
      }
      return parsed;
    } catch {
      // 损坏的锁文件按"存在但不可读"处理 → 由 ageOf 判定为陈旧
      return null;
    }
  }

  private ageOf(rec: LockRecord): number {
    const t = Date.parse(rec.heartbeatAt);
    if (Number.isNaN(t)) return Number.POSITIVE_INFINITY; // 时间戳坏 → 视为陈旧
    return Date.now() - t;
  }

  private write(): void {
    const rec: LockRecord = {
      ownerId: this.ownerId,
      heartbeatAt: new Date().toISOString(),
      acquiredAt: new Date().toISOString(),
      pid: process.pid,
    };
    writeFileSync(this.file, JSON.stringify(rec, null, 2), 'utf8');
  }

  private makeHandle(): LockHandle {
    const { file, ownerId } = this;
    const readLock = () => this.read();
    const writeLock = () => this.write();
    const startedAt = Date.now();
    let lastRenewAt = startedAt;

    return {
      ownerId,
      release() {
        // 只释放自己的锁 —— 不删别人的
        const cur = readLock();
        if (cur !== null && cur.ownerId !== ownerId) return;
        try {
          if (existsSync(file)) unlinkSync(file);
        } catch {
          // 释放失败不应让主流程失败：陈旧锁会被自动回收
        }
      },
      renew() {
        const cur = readLock();
        if (cur !== null && cur.ownerId !== ownerId) return; // 锁已被他人回收
        writeLock();
        lastRenewAt = Date.now();
      },
      ageMs() {
        return Date.now() - lastRenewAt;
      },
    };
  }

  /** 是否当前无锁（测试与 UI 用） */
  isFree(): boolean {
    const rec = this.read();
    if (rec === null) return !existsSync(this.file);
    return this.ageOf(rec) >= this.staleAfterMs;
  }
}
