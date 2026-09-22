/**
 * 项目导出（施工文档 §58 / §59）
 *
 * ## §58 的导出布局
 * ```
 * export/
 *   project.json      ← DB 的可读副本（元信息）
 *   project.db        ← 结构化记录（真源之一）
 *   chapters/         ← 正文 Markdown（真源之一）
 *   corpus/           ← 语料
 *   skills/           ← 技能
 *   manifest.json     ← 清单 + 校验和
 * ```
 *
 * ## ⚠ §59 真源 / 派生的划分决定了导出什么
 *
 * ```
 * 真源   Canonical Markdown（chapters/, summaries/）
 *        Structured SQLite records（project.db）
 * 派生   FTS index / Embeddings / Summaries / Dashboard 统计
 * ```
 *
 * 因此：
 * - **必须导出**：正文、DB、语料、技能（真源 + 用户资产）
 * - **不导出**：FTS 索引、workspace/（中间产物，未验证）
 *
 * ⚠ 不导出 workspace 的理由：它是"未验证的中间产物"，不属于真源。
 *   导出它会让恢复出来的项目带着一堆过期的草稿，而用户以为
 *   那些是已提交内容。
 *
 * ⚠ 不导出 FTS 的理由（§59 明文）："FTS 索引必须可重建，
 *   因此索引不是唯一事实源"。恢复后重建即可（见 restore.ts）。
 *
 * ## ⚠ manifest 必须带校验和
 *
 * 备份的价值在于"能确认恢复出来的东西是完整的"。没有校验和的备份
 * 只能证明"文件存在"，不能证明"文件没坏" —— 而数据库损坏正是
 * §58 要处理的场景（backup → restore → rebuild FTS）。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { Logger } from '@nwa/core';
import { PROJECT_DB_FILE, PROJECT_DIRS, PROJECT_META_FILE, projectPaths } from '@nwa/storage';

/** 导出清单 */
export interface ExportManifest {
  /** 格式版本 —— 恢复时校验，避免用新代码读老备份 */
  readonly formatVersion: number;
  readonly projectId: string;
  readonly projectName: string;
  readonly exportedAt: string;
  /** 每个文件的相对路径 + 字节数 + sha256 */
  readonly files: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly totals: {
    readonly files: number;
    readonly bytes: number;
  };
  /**
   * ⚠ 导出时**明确不包含**的内容（如实声明）。
   *
   * 不写这一项的话，使用者会以为"导出了整个项目"，
   * 而恢复后发现草稿没了、检索索引没了 —— 那是误解而非缺陷。
   */
  readonly excluded: readonly string[];
}

/** 当前导出格式版本 */
export const EXPORT_FORMAT_VERSION = 1;

/**
 * ⚠ 导出时跳过的目录（派生数据 / 中间产物）。
 *
 * 见文件头说明：这些都是 §59 定义的"派生"或"未验证中间产物"。
 */
const SKIP_DIRS: readonly string[] = [
  PROJECT_DIRS.workspace, // 中间产物，未验证
  PROJECT_DIRS.exports, // 导出目录本身（防递归）
  PROJECT_DIRS.backups, // 备份目录本身（防递归）
];

export interface ExportOptions {
  readonly rootDir: string;
  readonly logger: Logger;
  /** 导出到哪个目录（默认 <rootDir>/exports/export-<时间戳>） */
  readonly outDir?: string;
  /** 是否包含语料（corpus 可能很大，默认包含） */
  readonly includeCorpus?: boolean;
}

export interface ExportResult {
  readonly ok: boolean;
  readonly outDir: string;
  readonly manifest: ExportManifest;
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * 导出项目。
 *
 * ⚠ 用 `cpSync` 逐项复制而非打包成 tar：
 *   导出物的**可读性**本身有价值（用户能直接翻 chapters/ 确认内容），
 *   而打包会牺牲这一点换取体积。§58 的布局是目录结构，不是归档文件。
 */
export function exportProject(opts: ExportOptions): ExportResult {
  const { rootDir, logger } = opts;
  const paths = projectPaths(rootDir);

  if (!existsSync(rootDir)) {
    throw new Error(`项目目录不存在：${rootDir}`);
  }
  if (!existsSync(paths.db)) {
    throw new Error(`项目数据库不存在：${paths.db}（无法导出未初始化的项目）`);
  }

  const outDir = opts.outDir ?? join(rootDir, PROJECT_DIRS.exports, `export-${stamp()}`);
  // ⚠ 清空目标目录：残留的旧文件会让"导出了什么"变得不确定
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const excluded: string[] = [];

  // ── 真源：DB + 元信息 ──
  cpSync(paths.db, join(outDir, PROJECT_DB_FILE));
  if (existsSync(paths.meta)) {
    cpSync(paths.meta, join(outDir, PROJECT_META_FILE));
  } else {
    excluded.push(`${PROJECT_META_FILE}（不存在，跳过）`);
  }

  // ⚠ projectPaths 只给 db/meta/workspace 等具名路径；chapters 等目录
  //   用 PROJECT_DIRS 拼 —— 不要把目录名硬编码成字符串（契约变更会漏改）。
  const dirOf = (d: string) => join(rootDir, d);

  // ── 真源：正文与摘要（Markdown）──
  copyIfExists(dirOf(PROJECT_DIRS.chapters), join(outDir, PROJECT_DIRS.chapters), excluded);
  copyIfExists(dirOf(PROJECT_DIRS.summaries), join(outDir, PROJECT_DIRS.summaries), excluded);

  // ── 用户资产：技能 ──
  copyIfExists(dirOf(PROJECT_DIRS.skills), join(outDir, PROJECT_DIRS.skills), excluded);

  // ── 语料（可选，可能很大）──
  if (opts.includeCorpus !== false) {
    copyIfExists(dirOf(PROJECT_DIRS.corpus), join(outDir, PROJECT_DIRS.corpus), excluded);
  } else {
    excluded.push(`${PROJECT_DIRS.corpus}/（调用方要求跳过）`);
  }

  // ── 派生数据：明确不导出，并如实声明 ──
  excluded.push(
    `${PROJECT_DIRS.workspace}/（未验证的中间产物，不属真源）`,
    'FTS 索引（§59：派生数据，恢复后重建）',
  );

  // ── manifest + 校验和 ──
  const files = collectFiles(outDir).filter((f) => f !== 'manifest.json');
  const manifest: ExportManifest = {
    formatVersion: EXPORT_FORMAT_VERSION,
    projectId: readProjectId(rootDir),
    projectName: readProjectName(rootDir),
    exportedAt: new Date().toISOString(),
    files: files.map((rel) => {
      const abs = join(outDir, rel);
      const buf = readFileSync(abs);
      return {
        path: rel,
        bytes: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
      };
    }),
    totals: {
      files: files.length,
      bytes: files.reduce((n, rel) => n + statSync(join(outDir, rel)).size, 0),
    },
    excluded,
  };

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  logger.info('项目已导出', {
    outDir,
    files: manifest.totals.files,
    bytes: manifest.totals.bytes,
  });

  return { ok: true, outDir, manifest };
}

/**
 * 校验导出物完整性（对照 manifest 的 sha256）。
 *
 * ⚠ 这是备份功能的**核心价值**：能证明"恢复出来的东西没坏"。
 *   只检查"文件存在"是不够的 —— 数据库损坏正是 §58 要处理的场景。
 */
export function verifyExport(dir: string): {
  readonly ok: boolean;
  readonly checked: number;
  readonly problems: readonly string[];
} {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, checked: 0, problems: ['manifest.json 不存在（不是有效的导出物）'] };
  }

  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExportManifest;
  } catch (e) {
    return {
      ok: false,
      checked: 0,
      problems: [`manifest.json 解析失败：${e instanceof Error ? e.message : String(e)}`],
    };
  }

  const problems: string[] = [];

  if (manifest.formatVersion !== EXPORT_FORMAT_VERSION) {
    problems.push(
      `格式版本不匹配：导出物为 ${manifest.formatVersion}，当前支持 ${EXPORT_FORMAT_VERSION}`,
    );
  }

  let checked = 0;
  for (const f of manifest.files) {
    const abs = join(dir, f.path);
    if (!existsSync(abs)) {
      problems.push(`文件缺失：${f.path}`);
      continue;
    }
    const buf = readFileSync(abs);
    if (buf.length !== f.bytes) {
      problems.push(`字节数不符：${f.path}（期望 ${f.bytes}，实际 ${buf.length}）`);
      continue;
    }
    const digest = createHash('sha256').update(buf).digest('hex');
    if (digest !== f.sha256) {
      problems.push(`校验和不符：${f.path}（文件已损坏或被修改）`);
      continue;
    }
    checked++;
  }

  return { ok: problems.length === 0, checked, problems };
}

// ── 内部辅助 ──

function copyIfExists(src: string, dest: string, excluded: string[]): void {
  if (!existsSync(src)) {
    excluded.push(`${relative(process.cwd(), src)}（不存在，跳过）`);
    return;
  }
  cpSync(src, dest, {
    recursive: true,
    filter: (s) => !SKIP_DIRS.some((d) => s.includes(`${sep}${d}${sep}`) || s.endsWith(`${sep}${d}`)),
  });
}

/** 递归收集目录下的全部文件（相对路径，用 / 分隔保证跨平台一致） */
function collectFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      collectFiles(abs, base, out);
    } else {
      out.push(relative(base, abs).split(sep).join('/'));
    }
  }
  return out.sort();
}

function readProjectId(rootDir: string): string {
  const meta = join(rootDir, PROJECT_META_FILE);
  if (!existsSync(meta)) return 'unknown';
  try {
    return (JSON.parse(readFileSync(meta, 'utf8')) as { id?: string }).id ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function readProjectName(rootDir: string): string {
  const meta = join(rootDir, PROJECT_META_FILE);
  if (!existsSync(meta)) return 'unknown';
  try {
    return (JSON.parse(readFileSync(meta, 'utf8')) as { name?: string }).name ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function stamp(): string {
  // 文件名安全的时间戳（不含冒号，Windows 不允许）
  return new Date().toISOString().replace(/[:.]/g, '-');
}
