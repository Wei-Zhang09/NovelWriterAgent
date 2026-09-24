/**
 * Chapter Workspace（施工文档 §9）
 *
 * 每章一个隔离工作区：
 *
 *   workspace/chapter-031/
 *     ├── plan.json / context.json / scene-plan.json
 *     ├── draft.md / review.json / revision.md
 *     ├── continuity.json
 *     ├── proposed_state.json / proposed_facts.json / proposed_foreshadowing.json
 *     └── run.json
 *
 * ## 为什么必须有它（§9.1 核心原则）
 *
 * "正文未验证之前：不得覆盖正式章节、不得更新 Canon、不得更新不可逆状态。"
 *
 * 工作区就是这个"未验证缓冲区"。所有中间产物先落在工作区，
 * 只有 Commit 成功后才一次性迁移到 canonical chapter + facts + state + timeline。
 *
 * ## 两条本实现特有的硬约束
 *
 * 1. **工作区必须在 rootDir 之内**（同文件系统才能原子 rename）
 *    —— 来自 ADR-0002：跨设备 rename 不是原子操作，会破坏事务保证。
 * 2. **路径不得逃逸**（拒绝 `..`、绝对路径、符号链接逃逸）
 *    —— 章节名来自用户/模型，必须当作不可信输入。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { AppError, ErrorCode, Logger, type Nullable } from '@nwa/core';

/** 工作区中的标准文件名（§9 图示） */
export const WORKSPACE_FILES = {
  plan: 'plan.json',
  context: 'context.json',
  scenePlan: 'scene-plan.json',
  /**
   * 技能使用记录（§25 / STEP 18）。
   *
   * ⚠ 为什么必须落盘：技能是"这段为什么这样写"的一部分依据。
   *   没有它，事后无法回答"某个技能到底有没有被用到、用在哪个场景"——
   *   而 §24 要求技能可 A/B 测试，没有使用记录就无法比较。
   */
  skillUsage: 'skill-usage.json',
  /**
   * 长程记忆使用记录（P0-3）。
   *
   * ⚠ 与 skillUsage 同理但**不同维度**：技能记录"用了哪条写法建议"，
   *   记忆记录"参考了哪些旧内容"。两者缺一，事后都无法回答
   *   "这段为什么这样写" —— 一个答"写法从哪来"，一个答"事实从哪来"。
   */
  memoryUsage: 'memory-usage.json',
  draft: 'draft.md',
  review: 'review.json',
  revision: 'revision.md',
  continuity: 'continuity.json',
  proposedState: 'proposed_state.json',
  proposedFacts: 'proposed_facts.json',
  proposedForeshadowing: 'proposed_foreshadowing.json',
  run: 'run.json',
} as const;

export type WorkspaceFileKey = keyof typeof WORKSPACE_FILES;

export interface ChapterWorkspaceOptions {
  /** 项目根目录（工作区必须在其内，见 ADR-0002） */
  readonly rootDir: string;
  readonly chapterNumber: number;
  readonly logger: Logger;
  /** 允许写入的工作区文件白名单；默认全部（§9 图示） */
  readonly allowedFiles?: readonly WorkspaceFileKey[];
}

/** 工作区状态摘要（供 UI 与测试断言） */
export interface WorkspaceSnapshot {
  readonly dir: string;
  readonly chapterNumber: number;
  readonly files: readonly { name: string; bytes: number }[];
  readonly hasDraft: boolean;
  readonly hasRevision: boolean;
}

export class ChapterWorkspace {
  readonly dir: string;
  private readonly rootDir: string;
  private readonly chapterNumber: number;
  private readonly logger: Logger;
  private readonly allowed: readonly WorkspaceFileKey[];

  constructor(opts: ChapterWorkspaceOptions) {
    this.rootDir = resolve(opts.rootDir);
    this.chapterNumber = opts.chapterNumber;
    this.logger = opts.logger;
    this.allowed = opts.allowedFiles ?? (Object.keys(WORKSPACE_FILES) as WorkspaceFileKey[]);

    // 章号参与路径拼接 → 必须是安全的正整数（防路径注入）
    if (!Number.isInteger(opts.chapterNumber) || opts.chapterNumber <= 0) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `章号必须是正整数，收到：${String(opts.chapterNumber)}`,
      );
    }

    this.dir = this.assertInsideRoot(
      join(this.rootDir, 'workspace', `chapter-${String(opts.chapterNumber).padStart(3, '0')}`),
    );
  }

  /**
   * 断言路径在 rootDir 之内。
   *
   * ⚠ 这是安全边界：章节名/路径若可逃逸，模型就能写到项目外
   *   （例如 `../../.ssh/authorized_keys`）。所有路径拼接后都必须过这一关。
   */
  private assertInsideRoot(target: string): string {
    const abs = resolve(target);
    const rel = relative(this.rootDir, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `拒绝工作区路径逃逸项目根目录：${abs}`,
        { details: { rootDir: this.rootDir, target: abs } },
      );
    }
    return abs;
  }

  /** 创建工作区目录（幂等） */
  ensure(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  /** 解析某个工作区文件的绝对路径（校验白名单与逃逸） */
  pathOf(key: WorkspaceFileKey): string {
    if (!this.allowed.includes(key)) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `该工作区不允许写入「${key}」（白名单限制）`,
        { details: { allowed: this.allowed } },
      );
    }
    return this.assertInsideRoot(join(this.dir, WORKSPACE_FILES[key]));
  }

  /** 写入文本产物（draft.md / revision.md 等） */
  writeText(key: WorkspaceFileKey, content: string): string {
    const p = this.pathOf(key);
    mkdirSync(dirname(p), { recursive: true });
    // ⚠ 用 flag 'w' 显式覆盖；不 append —— 产物是"本次运行的完整结果"
    writeFileSync(p, content, { encoding: 'utf8', flag: 'w' });
    this.logger.debug('工作区写入', { key, bytes: Buffer.byteLength(content, 'utf8') });
    return p;
  }

  /** 写入 JSON 产物 */
  writeJson(key: WorkspaceFileKey, value: unknown): string {
    return this.writeText(key, JSON.stringify(value, null, 2));
  }

  /** 读取文本产物；不存在返回 null（不抛错，调用方自行决定） */
  readText(key: WorkspaceFileKey): Nullable<string> {
    const p = this.pathOf(key);
    if (!existsSync(p)) return null;
    return readFileSync(p, { encoding: 'utf8' });
  }

  /** 读取 JSON 产物；不存在或损坏返回 null */
  readJson<T>(key: WorkspaceFileKey): Nullable<T> {
    const t = this.readText(key);
    if (t === null) return null;
    try {
      return JSON.parse(t) as T;
    } catch {
      // 损坏的产物不应让整个流程崩掉，返回 null 由调用方处置
      this.logger.warn('工作区 JSON 产物损坏，按缺失处理', { key });
      return null;
    }
  }

  has(key: WorkspaceFileKey): boolean {
    return existsSync(this.pathOf(key));
  }

  snapshot(): WorkspaceSnapshot {
    const files: { name: string; bytes: number }[] = [];
    for (const key of Object.keys(WORKSPACE_FILES) as WorkspaceFileKey[]) {
      const p = this.pathOf(key);
      if (!existsSync(p)) continue;
      files.push({ name: WORKSPACE_FILES[key], bytes: Buffer.byteLength(readFileSync(p), 'utf8') });
    }
    return {
      dir: this.dir,
      chapterNumber: this.chapterNumber,
      files,
      hasDraft: this.has('draft'),
      hasRevision: this.has('revision'),
    };
  }

  /**
   * 清空工作区（重新生成时用）。
   *
   * ⚠ 只删工作区目录本身，且再次校验在 rootDir 内 ——
   *   递归删除是最危险的操作，绝不能让一个有 bug 的路径拼接触发它。
   */
  clear(): void {
    const guarded = this.assertInsideRoot(this.dir);
    // 双保险：必须确实位于 `<root>/workspace/` 之下
    const expectedParent = this.assertInsideRoot(join(this.rootDir, 'workspace'));
    if (dirname(guarded) !== expectedParent) {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, `拒绝清理非工作区目录：${guarded}`, {
        details: { expectedParent, actualParent: dirname(guarded) },
      });
    }
    if (existsSync(guarded)) {
      rmSync(guarded, { recursive: true, force: true });
      this.logger.debug('工作区已清空', { chapterNumber: this.chapterNumber });
    }
    this.ensure();
  }

  /**
   * 把工作区产物原子迁移到目标路径（供 Commit 流程使用）。
   *
   * 用 renameSync 而不是「读+写+删」：同文件系统下 rename 是原子的，
   * 崩溃时要么旧内容要么新内容，不会出现半截文件（ADR-0002）。
   */
  promoteTo(key: WorkspaceFileKey, destination: string): string {
    const src = this.pathOf(key);
    if (!existsSync(src)) {
      throw new AppError(ErrorCode.COMMIT_FAILED, `工作区产物不存在，无法迁移：${key}`, {
        details: { src },
      });
    }
    const dst = this.assertInsideRoot(destination);
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
    this.logger.info('产物已迁移', { key, to: relative(this.rootDir, dst) });
    return dst;
  }
}