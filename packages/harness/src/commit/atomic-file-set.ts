/**
 * 原子文件集（ADR-0002 v2 机制 ①②⑤）
 *
 * ## 三个机制
 *
 * **① CAS（compare-and-swap）前置条件**
 *   PREPARE 时记录目标文件当前的 sha256；APPLY 前重新计算并比对。
 *   不一致 → 中止并报 `COMMIT_CONFLICT`，**不得自动覆盖**。
 *   场景：用户在 Agent 运行时用外部编辑器改了 chapters/031.md，
 *   若无 CAS，Commit 会无声地覆盖掉用户的手工修改。
 *
 * **② `.next` + `.previous` 双写**
 *   `.next` → rename 保证读者永不看到半截文件；
 *   `.previous` 提供比 manifest 重放更快的回滚路径（直接恢复）。
 *
 * **⑤ 硬链接别名检测**
 *   同一文件若通过两个路径指向（硬链接 / 符号链接 / Windows 8.3 短名），
 *   回滚可能误判为"两个不同文件"而只回滚其一，留下不一致。
 *   检测到别名则**拒绝事务并报错**，不猜测用户意图。
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { AppError, ErrorCode, type Nullable } from '@nwa/core';

/** 文件的身份（用于别名检测） */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface StageOptions {
  /** 目标文件相对路径，如 chapters/031.md（rootDir 已由 AtomicFileSet 固定） */
  readonly target: string;
  /** 期望的当前内容哈希（null 表示"应当不存在"） */
  readonly expectedSha256: Nullable<string>;
  readonly content: string;
}

export interface StageResult {
  readonly target: string;
  /** 写入的 .next 路径 */
  readonly stagedPath: string;
  /** 备份路径（目标原先不存在时为 null） */
  readonly backupPath: Nullable<string>;
  /** 本次内容哈希 */
  readonly contentHash: string;
  /** 目标原内容的哈希（原先不存在时为 null） */
  readonly previousHash: Nullable<string>;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 读取文件哈希；不存在返回 null */
export function hashOfFile(path: string): Nullable<string> {
  if (!existsSync(path)) return null;
  return sha256(readFileSync(path, 'utf8'));
}

/**
 * 文件身份（dev + ino）。
 *
 * ⚠ 这两个值在 Windows 上是大整数，必须整体比较而**不能截断成 Number** ——
 *   截断后两个不同文件可能算出相同身份，别名检测就失效了。
 */
export function identityOf(path: string): Nullable<FileIdentity> {
  if (!existsSync(path)) return null;
  const st = statSync(path);
  return { dev: Number(st.dev), ino: Number(st.ino) };
}

/**
 * 检测一组路径中是否存在指向同一文件的两个条目。
 *
 * 返回冲突对；空数组表示无别名。
 */
export function findAliases(
  paths: readonly string[],
): { readonly a: string; readonly b: string; readonly identity: FileIdentity }[] {
  const seen = new Map<string, { path: string; identity: FileIdentity }>();
  const out: { a: string; b: string; identity: FileIdentity }[] = [];

  for (const p of paths) {
    const id = identityOf(p);
    if (id === null) continue; // 不存在的文件不参与判重
    const key = `${id.dev}:${id.ino}`;
    const prev = seen.get(key);
    if (prev) {
      out.push({ a: prev.path, b: p, identity: id });
    } else {
      seen.set(key, { path: p, identity: id });
    }
  }
  return out;
}

/** 把相对路径解析为 rootDir 内的绝对路径，并拒绝逃逸 */
export function resolveInside(rootDir: string, rel: string): string {
  const root = resolve(rootDir);
  const abs = resolve(root, rel);
  const r = relative(root, abs);
  if (r === '' || r.startsWith('..') || isAbsolute(r)) {
    throw new AppError(ErrorCode.COMMIT_FAILED, `拒绝项目目录之外的路径：${rel}`, {
      details: { rootDir: root, target: abs },
    });
  }
  return abs;
}

export class AtomicFileSet {
  /** 项目根目录（对外可见：CommitEngine 需要它给锁使用） */
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  /**
   * Stage：写 `.next` 并备份 `.previous`。
   *
   * ⚠ 顺序很重要：**先 CAS 校验，再写文件**。
   *   反过来会先破坏现场，再发现冲突 —— 那时已经无可挽回。
   */
  stage(opts: StageOptions): StageResult {
    const abs = resolveInside(this.rootDir, opts.target);
    const next = `${abs}.next`;
    const prev = `${abs}.previous`;

    // ① CAS 校验（在写任何东西之前）
    const actual = hashOfFile(abs);
    if (actual !== opts.expectedSha256) {
      throw new AppError(
        ErrorCode.COMMIT_FAILED,
        `CAS 冲突：${opts.target} 的内容已变化（期望 ${short(opts.expectedSha256)}，实际 ${short(actual)}）。` +
          '可能被外部修改，拒绝覆盖。请人工确认保留哪一侧。',
        {
          details: {
            code: 'COMMIT_CONFLICT',
            target: opts.target,
            expectedSha256: opts.expectedSha256,
            actualSha256: actual,
          },
        },
      );
    }

    mkdirSync(dirname(abs), { recursive: true });

    // ② 备份（目标已存在时）
    let backupPath: Nullable<string> = null;
    if (actual !== null) {
      copyFileSync(abs, prev);
      backupPath = prev;
    }

    // ③ 写 stage 文件
    writeFileSync(next, opts.content, 'utf8');

    return {
      target: opts.target,
      stagedPath: next,
      backupPath,
      contentHash: sha256(opts.content),
      previousHash: actual,
    };
  }

  /**
   * Apply：把 `.next` 原子改名为正式路径。
   *
   * ⚠ 只对**已 stage 且已过 CAS** 的文件调用。
   */
  apply(stagedPath: string): void {
    const abs = stagedPath.endsWith('.next') ? stagedPath.slice(0, -'.next'.length) : stagedPath;
    if (!existsSync(stagedPath)) {
      throw new AppError(ErrorCode.COMMIT_FAILED, `stage 文件不存在，无法 apply：${stagedPath}`);
    }
    renameSync(stagedPath, abs);
  }

  /**
   * 回滚一个目标文件到 stage 之前的状态。
   *
   * - 有 `.previous` → 用备份恢复
   * - 无 `.previous` 且正式文件是由本次 rename 产生的 → 删除它
   *
   * ⚠ **只操作传入的 target 及其派生的 .next/.previous**，
   *   绝不扫描目录。ADR-0002 约束 2 的硬要求。
   */
  rollback(target: string): { readonly action: 'restored' | 'removed' | 'noop'; readonly path: string } {
    const abs = resolveInside(this.rootDir, target);
    const next = `${abs}.next`;
    const prev = `${abs}.previous`;

    // 清掉未使用的 stage 文件
    if (existsSync(next)) {
      try {
        unlinkSync(next);
      } catch {
        /* 删除失败不应阻断回滚的其余步骤 */
      }
    }

    if (existsSync(prev)) {
      copyFileSync(prev, abs);
      try {
        unlinkSync(prev);
      } catch {
        /* ignore */
      }
      return { action: 'restored', path: abs };
    }

    // 没有备份：说明本次是新文件，删掉即可
    if (existsSync(abs)) {
      unlinkSync(abs);
      return { action: 'removed', path: abs };
    }
    return { action: 'noop', path: abs };
  }

  /** 清理 stage/backup 残留（Commit 成功后调用） */
  cleanup(target: string): void {
    const abs = resolveInside(this.rootDir, target);
    for (const p of [`${abs}.next`, `${abs}.previous`]) {
      if (existsSync(p)) {
        try {
          unlinkSync(p);
        } catch {
          /* 残留清理失败不影响已提交结果 */
        }
      }
    }
  }

  /**
   * 检测本事务涉及的路径之间是否存在硬链接别名。
   *
   * ⚠ 同时把 `.next` / `.previous` 纳入检测 —— 若它们与目标指向同一 inode，
   *   说明文件系统状态异常（或有人手工做了硬链接）。
   */
  assertNoAliases(targets: readonly string[]): void {
    const all: string[] = [];
    for (const t of targets) {
      const abs = resolveInside(this.rootDir, t);
      all.push(abs, `${abs}.next`, `${abs}.previous`);
    }
    const aliases = findAliases(all);
    if (aliases.length > 0) {
      const a = aliases[0]!;
      throw new AppError(
        ErrorCode.COMMIT_FAILED,
        `检测到硬链接别名，拒绝执行提交（这会破坏回滚的正确性）：` +
          `${relative(this.rootDir, a.a)} 与 ${relative(this.rootDir, a.b)} 指向同一文件。`,
        {
          details: {
            code: 'COMMIT_ALIAS_DETECTED',
            pairs: aliases.map((x) => ({
              a: relative(this.rootDir, x.a),
              b: relative(this.rootDir, x.b),
              dev: x.identity.dev,
              ino: x.identity.ino,
            })),
          },
        },
      );
    }
  }

  /** 完整性校验：读回文件并比对哈希 */
  verify(target: string, expectedHash: string): boolean {
    const abs = resolveInside(this.rootDir, target);
    return hashOfFile(abs) === expectedHash;
  }

  /** 项目内绝对路径（供调用方读取） */
  absolute(rel: string): string {
    return resolveInside(this.rootDir, rel);
  }
}

function short(h: Nullable<string>): string {
  if (h === null) return '(不存在)';
  return h.slice(0, 12);
}

export { join };
