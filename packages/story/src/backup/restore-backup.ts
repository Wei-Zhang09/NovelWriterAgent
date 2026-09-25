/**
 * 项目恢复 / 导入（施工文档 §58 / §59）
 *
 * ## §58 的恢复流程
 * ```
 * backup → restore → rebuild FTS
 * ```
 * 「FTS 索引必须可重建，因此索引不是唯一事实源」（§59）。
 *
 * ## ⚠ 恢复是**破坏性**操作，必须先备份现状
 *
 * 恢复会覆盖目标项目目录。如果目标已有数据，而恢复过程中失败，
 * 用户会同时失去"旧数据"和"新数据"。
 *
 * 因此本模块的恢复流程固定为：
 * ```
 * 1. 校验备份完整性（sha256）
 * 2. 若目标已存在 → 先把它移到 <目标>.pre-restore-<时间戳>
 * 3. 复制备份到目标
 * 4. 重建 FTS
 * 5. 失败时回滚（把 pre-restore 移回来）
 * ```
 *
 * ⚠ 第 1 步**不可跳过**：用一个损坏的备份去覆盖好数据，
 *   是这类功能能造成的最严重损失。校验失败必须在**任何写入之前**中止。
 *
 * ## ⚠⚠ 恢复**不碰**目标项目的 `workspace/`（未提交正文的保命线）
 *
 * 导出**不含** `workspace/`（见 export-project.ts：它是"未验证中间产物"）。
 * 但 M3 之后 `workspace/chapter-NNN/manuscript.md` 是**用户亲手写的正文**，
 * 不是中间产物 —— 这个分类在 M3 之前成立，之后不成立。
 *
 * 因此恢复时必须把 `workspace/` 从"移走"里**排除**，否则：
 * 用户的未提交正文、自动保存副本、全部版本节点会在恢复后**静默消失**
 * （恢复成功、不报错、用户以为只是导入了备份）。
 *
 * 实现见 `preserveWorkspace()` —— 在 rename 之前先把它挪到一旁，
 * 复制备份之后再挪回来。
 *
 * ## ⚠ 为什么不自动重建 FTS 到备份里
 *
 * 备份**不含** FTS 索引（§59 说它是派生数据）。恢复后必须重建，
 * 否则检索会静默返回空 —— 而"检索不到"看起来像"没有匹配内容"，
 * 不会报错。所以重建是恢复流程的**必要一步**，不是可选优化。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { Logger, summaryRel } from '@nwa/core';
import {
  Database,
  FtsIndex,
  MIGRATIONS,
  PROJECT_DB_FILE,
  PROJECT_DIRS,
  projectLevelPaths,
  type IndexChapterInput,
  type IndexMemoryInput,
  type Tokenizer,
} from '@nwa/storage';
import { verifyExport } from './export-project.js';

export interface RestoreOptions {
  readonly backupDir: string;
  readonly targetDir: string;
  readonly logger: Logger;
  /** FTS 分词器（重建索引用；不传则跳过重建并如实报告） */
  readonly tokenizer?: Tokenizer;
  /**
   * ⚠ 是否允许覆盖已存在的目标。
   *
   * 默认 false —— 覆盖用户现有项目必须是**显式**决定。
   * 置 true 时仍会先把现状移到 `.pre-restore-*`（可回滚）。
   */
  readonly overwrite?: boolean;
}

export interface RestoreResult {
  readonly ok: boolean;
  readonly targetDir: string;
  /** 校验通过的备份文件数 */
  readonly verified: number;
  /** 现状被移到了哪里（未覆盖时为 null） */
  readonly previousMovedTo: string | null;
  /** FTS 重建结果（未重建时为 null） */
  readonly ftsRebuilt: { readonly chapters: number; readonly memories: number } | null;
  /** ⚠ 需要人工处理的事项（如实报告，不掩盖） */
  readonly warnings: readonly string[];
  readonly error?: { readonly code: string; readonly message: string };
}

/** 恢复流程中「现状」被移到的目录名后缀 */
const PRE_RESTORE_PREFIX = '.pre-restore-';

/** 恢复过程中暂存目标项目 `workspace/` 的目录名后缀 */
const WORKSPACE_STASH_PREFIX = '.pre-restore-workspace-';

interface WorkspaceStash {
  /**
   * 需要保护的工作区目录列表（`from` 是恢复前的真实位置）。
   *
   * ⚠ 是**列表**而不是单个路径：P0-1 起工作区按书隔离，
   *   一个项目可能有多本书、每本各有一个 `workspace/`。
   *   只保护一个会让其余书的未提交正文在恢复时消失。
   */
  readonly items: readonly { readonly from: string; readonly to: string }[];
  /** 暂存根目录（挪到一旁时用；未挪动过为 null） */
  readonly stashedRoot: string | null;
}

/**
 * 找出目标项目里全部"装着未提交正文的工作区目录"。
 *
 * ⚠ 扫磁盘而不是查 DB：此刻马上就要把整个 targetDir 改名，
 *   开一个数据库连接去读它只会增加失败面（且 Windows 上
 *   被占用的目录 rename 会 EPERM）。我们需要的只是"哪些目录存在"。
 *
 * 覆盖两种布局：
 *   - 新：`books/<bookId>/workspace/`（P0-1 之后）
 *   - 旧：`workspace/`（项目根，尚未迁移的老项目）
 */
function findWorkspaceDirs(targetDir: string): string[] {
  const out: string[] = [];

  // 新布局：逐书
  const booksDir = join(targetDir, PROJECT_DIRS.books);
  if (existsSync(booksDir)) {
    for (const entry of readdirSync(booksDir)) {
      const ws = join(booksDir, entry, PROJECT_DIRS.workspace);
      if (existsSync(ws)) out.push(ws);
    }
  }

  // 旧布局：项目根
  const legacy = join(targetDir, PROJECT_DIRS.workspace);
  if (existsSync(legacy)) out.push(legacy);

  return out;
}

/**
 * 把目标项目里各个 `workspace/`（用户未提交正文的保命线）从"整体移走"里排除。
 *
 * 返回句柄，复制完备份后用 `restoreWorkspace()` 挪回原位。
 *
 * ⚠ 任何一步失败都必须**如实返回 warnings**，不能静默继续 ——
 *   静默继续的后果是用户正文消失且无人知晓。
 */
function preserveWorkspace(targetDir: string, logger: Logger, warnings: string[]): WorkspaceStash {
  const dirs = findWorkspaceDirs(targetDir);
  if (dirs.length === 0) return { items: [], stashedRoot: null };

  const stashedRoot = `${targetDir}${WORKSPACE_STASH_PREFIX}${stamp()}`;
  const items: { from: string; to: string }[] = [];

  for (const from of dirs) {
    // 在暂存区里保留原来的相对位置，挪回时才能精确还原
    const rel = relative(targetDir, from);
    const to = join(stashedRoot, rel);
    try {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      items.push({ from, to });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(
        `无法暂存 ${rel}（${msg}）：` +
          '它里面有**未提交的正文**，而备份不含这部分。' +
          '请先关闭该项目后重试，否则恢复会让这些内容消失。',
      );
    }
  }

  if (items.length > 0) {
    logger.info('已暂存未提交正文的工作区（恢复后挪回）', {
      count: items.length,
      stashedRoot,
    });
  }
  return { items, stashedRoot };
}

/** 把 `preserveWorkspace()` 挪走的各个 workspace/ 放回原位 */
function restoreWorkspace(stash: WorkspaceStash, logger: Logger, warnings: string[]): void {
  if (stash.stashedRoot === null) return;

  for (const { from, to } of stash.items) {
    // 备份里理论不含 workspace/，但若真的含了，挪回会覆盖 —— 如实报告。
    if (existsSync(from)) {
      warnings.push(
        `${relative(stash.stashedRoot, to)} 在恢复过程中被创建，暂存的未提交正文**未**挪回。` +
          `内容保留在：${to}`,
      );
      continue;
    }
    try {
      mkdirSync(dirname(from), { recursive: true });
      renameSync(to, from);
      logger.info('已把未提交正文挪回', { to: from });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(
        `未提交正文**未能**挪回原位（${msg}）。内容保留在：${to}，请手动移回。`,
      );
    }
  }

  // 全部挪回后清掉空的暂存目录（残留会让用户以为还有东西没恢复）
  if (stash.items.length > 0 && existsSync(stash.stashedRoot)) {
    try {
      const leftovers = collectFilesUnder(stash.stashedRoot);
      if (leftovers === 0) rmSync(stash.stashedRoot, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响正确性 */
    }
  }
}

/** 统计目录下的文件数（用于判断暂存区是否已空） */
function collectFilesUnder(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) n += collectFilesUnder(abs);
    else n++;
  }
  return n;
}

export function restoreBackup(opts: RestoreOptions): RestoreResult {
  const { backupDir, targetDir, logger } = opts;
  const warnings: string[] = [];

  // ── 1. 校验备份完整性（**任何写入之前**）──
  if (!existsSync(backupDir)) {
    return fail(targetDir, 'BACKUP_NOT_FOUND', `备份目录不存在：${backupDir}`);
  }
  const verify = verifyExport(backupDir);
  if (!verify.ok) {
    // ⚠ 用损坏的备份覆盖好数据是这类功能能造成的最严重损失 ——
    //   必须在写入前中止，且如实列出问题。
    return {
      ok: false,
      targetDir,
      verified: verify.checked,
      previousMovedTo: null,
      ftsRebuilt: null,
      warnings: verify.problems,
      error: {
        code: 'BACKUP_CORRUPTED',
        message: `备份校验失败（${verify.problems.length} 项问题），已中止恢复以避免覆盖现有数据`,
      },
    };
  }

  const backupDb = join(backupDir, PROJECT_DB_FILE);
  if (!existsSync(backupDb)) {
    return fail(targetDir, 'BACKUP_INCOMPLETE', `备份里没有 ${PROJECT_DB_FILE}，无法恢复`);
  }

  // ── 2. 目标已存在 → 检查是否允许覆盖，并先把现状移走 ──
  let previousMovedTo: string | null = null;
  let stash: WorkspaceStash = { items: [], stashedRoot: null };
  const targetExists = existsSync(targetDir) && readdirSync(targetDir).length > 0;
  if (targetExists) {
    if (opts.overwrite !== true) {
      return fail(
        targetDir,
        'TARGET_EXISTS',
        `目标目录已存在且非空：${targetDir}。` +
          '覆盖现有项目必须显式传 overwrite=true（避免误操作丢失数据）',
      );
    }
    // ⚠ 先把 workspace/ 挪出目标目录，再整体移走 ——
    //   否则用户的未提交正文会跟着 pre-restore 目录一起"消失"
    //   （恢复成功、不报错，用户以为只是导入了备份）。
    stash = preserveWorkspace(targetDir, logger, warnings);

    previousMovedTo = `${targetDir}${PRE_RESTORE_PREFIX}${stamp()}`;
    try {
      renameSync(targetDir, previousMovedTo);
    } catch (e) {
      // 整体移走失败 → 把刚挪开的 workspace/ 放回去，保持现状原样
      restoreWorkspace(stash, logger, warnings);
      // ⚠ Windows 上**不能重命名正在打开的项目目录**：数据库文件
      //   （project.db / -wal / -shm）被持有句柄时 rename 会报 EPERM。
      //
      //   实测踩到：verify 脚本里 `project.open` 已打开目标项目，
      //   紧接着调 restore → EPERM，而错误信息只说"operation not
      //   permitted"，看不出是"文件被占用"。
      //
      //   这个限制无法在文件层绕过（Windows 不允许移动被打开的文件），
      //   因此**如实报出原因与解法**，而不是给一个含糊的 EPERM。
      const code = (e as { code?: string }).code;
      if (code === 'EPERM' || code === 'EBUSY') {
        return fail(
          targetDir,
          'TARGET_IN_USE',
          `无法重命名目标目录（${code}）：它正被占用。` +
            'Windows 不允许移动已打开的项目目录。' +
            '请**先关闭该项目**（或换一个未打开的目标目录）后再恢复。',
        );
      }
      throw e;
    }
    logger.info('恢复前已把现状移走（可回滚）', { previousMovedTo });
  }

  try {
    // ── 3. 复制备份到目标 ──
    mkdirSync(targetDir, { recursive: true });
    cpSync(backupDir, targetDir, {
      recursive: true,
      // manifest 是导出物的元数据，不属于项目内容
      filter: (s) => !s.endsWith(`${sep}manifest.json`),
    });

    // ── 3b. 把未提交正文挪回原位 ──
    restoreWorkspace(stash, logger, warnings);

    // ── 4. 重建 FTS（§58 的必要一步）──
    let ftsRebuilt: { chapters: number; memories: number } | null = null;
    if (opts.tokenizer) {
      ftsRebuilt = rebuildFts(targetDir, opts.tokenizer, logger);
    } else {
      warnings.push(
        '未提供分词器 → **FTS 索引未重建**。' +
          '检索会静默返回空（看起来像"没有匹配内容"，不会报错）。' +
          '请用 tokenizer 重新调用，或手动触发重建。',
      );
    }

    logger.info('项目已从备份恢复', {
      targetDir,
      verified: verify.checked,
      ftsRebuilt,
    });

    return {
      ok: true,
      targetDir,
      verified: verify.checked,
      previousMovedTo,
      ftsRebuilt,
      warnings,
    };
  } catch (e) {
    // ── 5. 失败回滚：把现状移回来 ──
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('恢复失败，尝试回滚', e, { targetDir, previousMovedTo });

    // ⚠ 顺序要紧：先把 targetDir 还原成"恢复前那棵树"，**再**把正文挪回。
    //   反过来（先挪回、后 rename）会被 rename 把正文一起带走 ——
    //   挪回的位置正好在要被替换掉的 targetDir 里面。
    if (previousMovedTo) {
      try {
        rmSync(targetDir, { recursive: true, force: true });
        renameSync(previousMovedTo, targetDir);
        logger.info('已回滚到恢复前的状态', { targetDir });
      } catch (rollbackErr) {
        // ⚠ 回滚也失败 → 必须**大声**报告现状位置，让用户能手工抢救
        return {
          ok: false,
          targetDir,
          verified: verify.checked,
          previousMovedTo,
          ftsRebuilt: null,
          warnings: [
            ...warnings,
            `⚠ 回滚失败：${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
            `你的原有数据仍在：${previousMovedTo}（请手工移回）`,
          ],
          error: { code: 'RESTORE_FAILED_ROLLBACK_FAILED', message: msg },
        };
      }
    }

    // 现状已还原（或本就无需还原）→ 把未提交正文挪回原位
    restoreWorkspace(stash, logger, warnings);

    return {
      ok: false,
      targetDir,
      verified: verify.checked,
      previousMovedTo,
      ftsRebuilt: null,
      warnings,
      error: { code: 'RESTORE_FAILED', message: msg },
    };
  }
}

/**
 * 重建 FTS 索引（§59：派生数据可重建）。
 *
 * ⚠ 数据源从**业务表**读取后交给 FtsIndex —— 索引层不读业务表
 *   （避免依赖倒挂，见 FtsIndex.rebuild 的说明）。
 */
export function rebuildFts(
  rootDir: string,
  tokenizer: Tokenizer,
  logger: Logger,
): { readonly chapters: number; readonly memories: number } {
  const paths = projectLevelPaths(rootDir);
  const db = new Database({ path: paths.db, migrations: MIGRATIONS });

  try {
    // ⚠ IndexChapterInput / IndexMemoryInput 都要求 bookId 与 sourceRef ——
    //   它们不是可选装饰：sourceRef 是"这条索引指向哪个真源"的可追溯凭据
    //   （§46），bookId 是检索时按书隔离的依据。索引缺了它们，
    //   检索要么跨书串内容，要么无法回溯到原文。
    const chapterRows = db.all<{
      id: string;
      book_id: string;
      chapter_number: number;
      body_path: string | null;
    }>(
      "SELECT id, book_id, chapter_number, body_path FROM chapters WHERE status = 'COMMITTED'",
    );

    const chapters: IndexChapterInput[] = [];
    for (const row of chapterRows) {
      if (!row.body_path) continue;
      const abs = join(rootDir, row.body_path);
      if (!existsSync(abs)) continue;
      chapters.push({
        chapterId: row.id,
        bookId: row.book_id,
        chapterNumber: row.chapter_number,
        sourceRef: row.body_path,
        text: readText(abs),
      });
    }

    // 记忆条目：章节摘要（§28 的 topMemory 来源之一）
    const memoryRows = db.all<{
      id: string;
      book_id: string;
      chapter_number: number;
      summary: string | null;
    }>('SELECT id, book_id, chapter_number, summary FROM chapters WHERE summary IS NOT NULL');

    const memories: IndexMemoryInput[] = memoryRows
      .filter((r) => (r.summary ?? '').trim().length > 0)
      .map((r) => ({
        itemId: `summary_${r.id}`,
        bookId: r.book_id,
        itemType: 'SUMMARY',
        sourceRef: summaryRel(r.book_id, r.chapter_number),
        text: r.summary ?? '',
      }));

    const fts = new FtsIndex({ db, tokenizer, logger });
    const r = fts.rebuild({ chapters, memories });
    logger.info('FTS 已重建', r);
    return { chapters: r.chaptersIndexed, memories: r.memoriesIndexed };
  } finally {
    db.close();
  }
}

function readText(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    // 正文文件读不到不该让整次重建失败 —— 跳过该章并继续
    // （调用方可通过 chapters 索引数与实际章节数对比发现缺口）
    return '';
  }
}

function fail(
  targetDir: string,
  code: string,
  message: string,
): RestoreResult {
  return {
    ok: false,
    targetDir,
    verified: 0,
    previousMovedTo: null,
    ftsRebuilt: null,
    warnings: [],
    error: { code, message },
  };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 项目目录名常量（供调用方构造默认路径） */
export const BACKUP_DIRS = PROJECT_DIRS;
