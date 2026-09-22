/**
 * 语料导入 + 蒸馏链编排（施工文档 §16 / §58 / §61）
 *
 * ## ⚠ 为什么需要这个文件
 *
 * 实测发现：语料导入的能力**只存在于验证脚本**（`scripts/verify-books.mjs`
 * 里硬编码了一份书单）。产品层：
 *   - **无导入 IPC**（corpus 相关只有 listDocuments / progress / stats）
 *   - **界面完全无入口**
 *
 * 于是"导入新小说做蒸馏"这件事，用户只能去改脚本源码。
 *
 * 这与本项目反复出现的同类缺陷一致（`detectProseIssues` 没接线、
 * `skillRefs` 没人填、`book.create` 缺失、技能/备份没界面）——
 * **底层齐备但使用者够不到**。这次是「导入」这一环。
 *
 * ## §61 许可闸门
 *
 * ⚠ 用户选择"允许 UNKNOWN 并弹提示"。这与 §61 并不冲突，前提是把
 *   **登记**与**处理**分开：
 *   - **登记** UNKNOWN 语料：允许（`register` 已强制只能设
 *     `RETRIEVAL_ONLY` / `NO_PROCESSING`）
 *   - **跑蒸馏**（标注/挖掘/编译）：`canProcess` 拒绝 —— 那才是 §61
 *     说的"自动处理链"
 *
 * 这样"允许导入但风险自负"生效，同时 UNKNOWN 语料不会悄悄进蒸馏。
 *
 * ⚠ 本轮还修了一个真漏洞：`canProcess` / `PROCESSABLE_USAGE` 定义在
 *   仓储层却**全仓无调用** —— "UNKNOWN 禁止进自动链"此前只写在文档与
 *   `register` 的入参校验里，**运行时没有强制**。已在标注与挖掘入口补上。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nwa/core';
import type { CorpusRepository } from '@nwa/storage';
import { CorpusImporter } from '@nwa/distillation';

export interface ImportCorpusOptions {
  readonly repo: CorpusRepository;
  /**
   * 语料库根目录（如 `C:/Users/zw/NovelWriterCorpus`）。
   *
   * ⚠ 模块内部会自行拼上 `documents/` 子目录 —— 见 `documentsDir()`。
   *   调用方**不要**自己拼，否则两边会不一致（这正是本轮修的 bug）。
   */
  readonly corpusRoot: string;
  readonly logger: Logger;
}

/**
 * 文档落盘目录：`<corpusRoot>/documents`。
 *
 * ## ⚠ 为什么必须集中在一处
 *
 * 实测踩到的 bug：`CorpusImporter` 的 `rootDir` 就是文档目录本身，
 * 而标注端读的是 `<root>/documents/<docId>/chapters`。两条路径分别由
 * **不同的脚本**使用（导入用 `verify-books`、标注用 `verify-persist`），
 * 各自拼各自的 —— 于是产品层把两者串起来时立刻断裂：
 * 导入成功、标注报"未找到章节目录"。
 *
 * 现在由本模块统一提供这个路径，导入与标注都从这里取，
 * **不可能再各拼一份**。
 */
export function documentsDir(corpusRoot: string): string {
  return join(corpusRoot, 'documents');
}

/** 某个文档的章节目录（标注端读这里） */
export function documentChaptersDir(corpusRoot: string, documentId: string): string {
  return join(documentsDir(corpusRoot), documentId, 'chapters');
}

/** 导入请求（来自界面/调用方） */
export interface ImportCorpusRequest {
  /** 源文件绝对路径（.txt / .md） */
  readonly filePath: string;
  readonly title?: string;
  readonly author?: string | null;
  readonly genre?: string | null;
  readonly subgenre?: string | null;
  readonly sourceType?: string;
  readonly licenseType?: string;
  readonly allowedUsage?: string;
  /** 版权依据说明（§61 要求能说明"为什么可以处理"） */
  readonly licenseBasis?: string;
  /** 是否清洗网络转载噪声（默认开） */
  readonly clean?: boolean;
}

export interface ImportCorpusResult {
  readonly ok: boolean;
  readonly documentId?: string;
  readonly title?: string;
  readonly chapterCount?: number;
  readonly chars?: number;
  readonly strategy?: string;
  readonly contentHash?: string;
  /** 清洗报告（删了什么，逐条） */
  readonly cleanRules?: readonly { readonly name: string; readonly count: number }[];
  readonly removedChars?: number;
  /** ⚠ 章节号缺口（源文本自身的问题，如实报告） */
  readonly declaredGaps?: readonly { readonly after: number; readonly before: number }[];
  /** ⚠ 许可提示（UNKNOWN 时给出，风险自负） */
  readonly licenseWarning?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

/** 从文件名推标题（去掉扩展名与常见后缀） */
function titleFromPath(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? '未命名';
  return base.replace(/\.(txt|md)$/i, '').trim() || '未命名';
}

/**
 * 导入一份语料。
 *
 * ⚠ 流程与 `verify-books.mjs` 一致（清洗 → 规范化 → 章节切分 → 登记），
 *   但**参数来自调用方**而不是硬编码书单。
 */
export function importCorpusFile(
  opts: ImportCorpusOptions,
  req: ImportCorpusRequest,
): ImportCorpusResult {
  if (!existsSync(req.filePath)) {
    return { ok: false, error: { code: 'FILE_NOT_FOUND', message: `文件不存在：${req.filePath}` } };
  }

  const raw = readFileSync(req.filePath, 'utf8');
  if (raw.trim().length === 0) {
    return { ok: false, error: { code: 'EMPTY_FILE', message: '文件内容为空' } };
  }

  const title = req.title?.trim() || titleFromPath(req.filePath);
  const licenseType = req.licenseType ?? 'USER_OWNED';
  const sourceType = req.sourceType ?? 'USER_OWNED';
  // ⚠ 许可不明时**强制降级为 RETRIEVAL_ONLY**（而不是报错拒绝）——
  //   用户选了"允许导入但弹提示"，那就允许登记，但不许进蒸馏链。
  //   降级而不是拒绝：拒绝会让用户以为文件有问题；降级 + 明确提示
  //   才是"你可以留着，但不能拿它蒸馏"。
  const allowedUsage =
    licenseType === 'UNKNOWN'
      ? 'RETRIEVAL_ONLY'
      : (req.allowedUsage ?? 'FULL_ANALYSIS');

  const importer = new CorpusImporter({
    repo: opts.repo,
    // ⚠ 传 documents 子目录（CorpusImporter 的 rootDir 就是文档目录本身）
    rootDir: documentsDir(opts.corpusRoot),
    logger: opts.logger,
    makeId: () => `doc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
  });

  const res = importer.import({
    title,
    text: raw,
    author: req.author ?? null,
    sourceType: sourceType as never,
    licenseType: licenseType as never,
    allowedUsage: allowedUsage as never,
    genre: req.genre ?? null,
    ...(req.licenseBasis ? { licenseBasis: req.licenseBasis } : {}),
    clean: req.clean !== false,
  });

  if (!res.ok) {
    return { ok: false, error: res.error };
  }

  const out: ImportCorpusResult = {
    ok: true,
    ...(res.documentId ? { documentId: res.documentId } : {}),
    title: res.title ?? title,
    ...(res.chapterCount !== undefined ? { chapterCount: res.chapterCount } : {}),
    ...(res.stats ? { chars: res.stats.chars } : {}),
    ...(res.strategy ? { strategy: res.strategy } : {}),
    ...(res.contentHash ? { contentHash: res.contentHash } : {}),
    ...(res.clean
      ? {
          cleanRules: res.clean.rules.map((r) => ({ name: r.name, count: r.count })),
          removedChars: res.clean.removedChars,
        }
      : {}),
    ...(res.declaredGaps ? { declaredGaps: res.declaredGaps } : {}),
  };

  // ⚠ UNKNOWN 许可要**明确提示**，而不是静默降级 ——
  //   用户需要知道"这份语料不能用于蒸馏"，否则后面标注失败会莫名其妙。
  if (licenseType === 'UNKNOWN') {
    return {
      ...out,
      licenseWarning:
        `许可为 UNKNOWN，已自动降级为 RETRIEVAL_ONLY（仅可检索）。` +
        '§61 要求许可不明的内容不得进入自动蒸馏链 —— 标注/挖掘/编译都会拒绝该语料。' +
        '若你确认有权分析它，请重新导入并登记正确的许可。',
    };
  }

  return out;
}

/** 语料库概览（供界面显示"现在有哪些语料、各自什么状态"） */
export function corpusOverview(repo: CorpusRepository): {
  readonly documents: readonly {
    readonly documentId: string;
    readonly title: string;
    readonly author: string | null;
    readonly genre: string | null;
    readonly subgenre: string | null;
    readonly licenseType: string;
    readonly allowedUsage: string;
    /** ⚠ 是否允许进蒸馏链（§61）—— 界面要能一眼看出 */
    readonly processable: boolean;
    readonly scenes: number;
    readonly annotated: number;
    readonly failed: number;
  }[];
  readonly totals: {
    readonly documents: number;
    readonly processable: number;
    readonly scenes: number;
    readonly annotated: number;
  };
} {
  const docs = repo.list();
  const documents = docs.map((d) => {
    const p = repo.annotationProgress(d.id);
    return {
      documentId: d.id,
      title: d.title,
      author: d.author,
      genre: d.genre,
      subgenre: d.subgenre ?? null,
      licenseType: d.license_type,
      allowedUsage: d.allowed_usage,
      processable: d.allowed_usage === 'FULL_ANALYSIS' || d.allowed_usage === 'DISTILLATION_ONLY',
      scenes: p.total,
      annotated: p.annotated,
      failed: p.failed,
    };
  });

  return {
    documents,
    totals: {
      documents: documents.length,
      processable: documents.filter((d) => d.processable).length,
      scenes: documents.reduce((n, d) => n + d.scenes, 0),
      annotated: documents.reduce((n, d) => n + d.annotated, 0),
    },
  };
}
