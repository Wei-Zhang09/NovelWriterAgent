/**
 * 语料导入（施工文档 §45 / §61）
 *
 * 流程：读取 → 规范化 → 章节识别 → 权限登记 → 落盘
 *
 * ## 两条硬约束
 *
 * 1. **许可先于处理**（§61）：`UNKNOWN` 许可不得进入自动分析链。
 *    仓储层已强制，这里在入口再拦一次并给出可操作的原因。
 * 2. **content hash 去重**（§45）：同内容重复导入被拒 ——
 *    否则同一部作品会被当多部统计，污染 `sample_count` 与 `confidence`。
 *
 * ## 落盘布局
 *
 * ```
 * <rootDir>/corpus/<documentId>/
 *   original.txt        规范化后的全文（证据引用的锚点）
 *   chapters/001.md     每章正文
 *   import.json         导入报告（策略/统计/哈希）
 * ```
 *
 * ⚠ 章节正文写文件而不是只存 DB：NDE 的证据引用要指向**可读的原文位置**
 *   （§46），只存数据库会让"证据"变成不可核对的字符串。
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, ErrorCode, Logger } from '@nwa/core';
import { normalizeWithStrip, contentHash, textStats, type TextStats } from './normalize.js';
import { cleanWebNovel, type CleanOptions } from './clean-web.js';
import type { CleanReport } from './types.js';
import { detectChapters, type DetectStrategy, type DetectedChapter } from './chapter-detect.js';
import type { CorpusRepository, CorpusSourceType, CorpusUsage } from '@nwa/storage';

export interface ImportOptions {
  readonly repo: CorpusRepository;
  readonly rootDir: string;
  readonly logger: Logger;
  /** 生成 documentId（注入以便测试确定化） */
  readonly makeId: () => string;
  /** 写入章节文件（默认写 <rootDir>/corpus/<id>/chapters/NNN.md） */
  readonly writeChapters?: boolean;
}

export interface ImportRequest {
  readonly title: string;
  readonly text: string;
  readonly author?: string | null;
  readonly sourceType: CorpusSourceType;
  readonly licenseType: CorpusSourceType;
  readonly allowedUsage: CorpusUsage;
  readonly genre?: string | null;
  readonly qualityTags?: readonly string[];
  /**
   * 是否清洗网络转载噪声（水印/作者话/番外）。
   *
   * ⚠ 清洗会改变文本 → content hash 也变。因此清洗前先算原始 hash
   *   并记入报告，便于日后用原始版本重新导入时能对应上。
   */
  readonly clean?: boolean;
  /** 清洗选项（clean=true 时生效） */
  readonly cleanOptions?: CleanOptions;
  /**
   * 版权依据说明（人工填写的判断理由）。
   *
   * ⚠ 这不是形式化字段：§61 要求能说明"为什么这份内容可以处理"。
   *   留空则报告里记为未说明。
   */
  readonly licenseBasis?: string;
}

export interface ImportResult {
  readonly ok: boolean;
  readonly documentId?: string;
  readonly title?: string;
  readonly chapterCount?: number;
  readonly strategy?: DetectStrategy;
  readonly patternName?: string | null;
  readonly stats?: TextStats;
  readonly contentHash?: string;
  /** 样板剥离量（0 表示没有样板） */
  readonly strippedChars?: number;
  readonly hitMarkers?: readonly string[];
  /** 源文本的章节号缺口（如缺 100–110 回） */
  readonly declaredGaps?: readonly { readonly after: number; readonly before: number }[];
  /** 清洗报告（clean=true 时存在） */
  readonly clean?: CleanReport;
  /** 清洗前的原始 content hash（便于追溯原始版本） */
  readonly originalContentHash?: string;
  readonly dir?: string;
  readonly error?: { code: string; message: string };
}

/** 章节文件名（3 位补零，保证排序稳定） */
function chapterFile(n: number): string {
  return `${String(n).padStart(3, '0')}.md`;
}

export class CorpusImporter {
  private readonly repo: CorpusRepository;
  private readonly rootDir: string;
  private readonly logger: Logger;
  private readonly makeId: () => string;
  private readonly writeChapters: boolean;

  constructor(opts: ImportOptions) {
    this.repo = opts.repo;
    this.rootDir = opts.rootDir;
    this.logger = opts.logger;
    this.makeId = opts.makeId;
    this.writeChapters = opts.writeChapters ?? true;
  }

  /**
   * 导入一份文本。
   *
   * ⚠ 不抛异常给调用方处理"许可问题" —— 返回 `ok: false` 且带**可操作的原因**，
   *   因为许可判断失败是预期内的业务结果，不是异常。
   */
  import(req: ImportRequest): ImportResult {
    if (req.text.trim().length === 0) {
      return {
        ok: false,
        error: { code: ErrorCode.TOOL_VALIDATION_ERROR, message: '文本为空，无法导入' },
      };
    }

    // 0) 网络噪声清洗（可选，先于规范化）
    //
    // ⚠ 清洗会改文本 → hash 也变。因此先算**原始** hash 记入报告，
    //   便于日后用原始版本重新导入时能对应上（否则会以为是两份不同文档）。
    const originalHash = contentHash(req.text);
    let cleanReport: CleanReport | undefined;
    let source = req.text;
    if (req.clean) {
      const cleaned = cleanWebNovel(req.text, req.cleanOptions ?? {});
      source = cleaned.text;
      cleanReport = cleaned.report;
      this.logger.info('网络噪声清洗完成', {
        title: req.title,
        removedChars: cleanReport.removedChars,
        removedRatio: cleanReport.removedRatio,
        rules: cleanReport.rules.map((r) => `${r.name}×${r.count}`),
      });
    }

    // 1) 规范化 + 剥离样板
    const { text: normalized, stripped } = normalizeWithStrip(source);
    const hash = contentHash(normalized);
    const stats = textStats(normalized);

    // 2) 去重（§45）—— 提前查一次，给出比仓储层更友好的原因
    const dup = this.repo.findByHash(hash);
    if (dup) {
      return {
        ok: false,
        error: {
          code: ErrorCode.TOOL_VALIDATION_ERROR,
          message:
            `该文本已导入过（内容哈希相同）：「${dup.title}」。` +
            '重复导入会让同一部作品被当作多部统计，污染模式挖掘的样本数与置信度。',
        },
      };
    }

    // 3) 章节识别
    const detected = detectChapters(normalized);
    this.logger.info('章节识别完成', {
      title: req.title,
      strategy: detected.strategy,
      chapters: detected.chapters.length,
      strippedChars: stripped.removedChars,
    });

    // 4) 权限登记（仓储层会再校验一次 §61）
    let docId: string;
    try {
      docId = this.makeId();
      this.repo.register({
        id: docId,
        title: req.title,
        author: req.author ?? null,
        sourceType: req.sourceType,
        licenseType: req.licenseType,
        allowedUsage: req.allowedUsage,
        contentHash: hash,
        genre: req.genre ?? null,
        // ⚠ 简介由清洗阶段提取（含题材标签，对类型判定有价值）——
        //   它不参与场景标注，但记入文档元信息供类型判断参考
        ...(cleanReport?.synopsis ? { synopsis: cleanReport.synopsis } : {}),
        ...(req.qualityTags ? { qualityTags: req.qualityTags } : {}),
      });
    } catch (e) {
      const err = e instanceof AppError ? e : null;
      return {
        ok: false,
        error: {
          code: err?.code ?? ErrorCode.TOOL_VALIDATION_ERROR,
          message: err?.message ?? String(e),
        },
      };
    }

    // 5) 落盘
    const dir = join(this.rootDir, docId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'original.txt'), normalized, 'utf8');

    if (this.writeChapters) {
      const chDir = join(dir, 'chapters');
      mkdirSync(chDir, { recursive: true });
      for (const c of detected.chapters) {
        writeFileSync(join(chDir, chapterFile(c.number)), c.body, 'utf8');
      }
    }

    writeFileSync(
      join(dir, 'import.json'),
      JSON.stringify(
        {
          documentId: docId,
          title: req.title,
          author: req.author ?? null,
          sourceType: req.sourceType,
          licenseType: req.licenseType,
          allowedUsage: req.allowedUsage,
          contentHash: hash,
          strategy: detected.strategy,
          patternName: detected.patternName,
          chapterCount: detected.chapters.length,
          // ⚠ 源文本的回目缺口如实记录（语料不完整会影响样本覆盖度判断）
          declaredGaps: detected.gaps,
          stats,
          // ⚠ 样板剥离量必须记录：剥离是改动原文，人工需要能核对
          boilerplate: {
            removedChars: stripped.removedChars,
            hitMarkers: stripped.hitMarkers,
          },
          // ⚠ 版权依据：§61 要求能说明"为什么这份内容可以处理"
          license: {
            sourceType: req.sourceType,
            licenseType: req.licenseType,
            allowedUsage: req.allowedUsage,
            basis: req.licenseBasis ?? '（未说明）',
          },
          // ⚠ 清洗是破坏性操作，报告 + 原始 hash 一并留存以便追溯
          cleaning: cleanReport ?? null,
          originalContentHash: req.clean ? originalHash : null,
          chapters: detected.chapters.map((c: DetectedChapter) => ({
            number: c.number,
            title: c.title,
            startLine: c.startLine,
            chars: c.body.length,
          })),
        },
        null,
        2,
      ),
      'utf8',
    );

    this.logger.info('语料导入完成', {
      documentId: docId,
      title: req.title,
      chapters: detected.chapters.length,
      chars: stats.chars,
    });

    return {
      ok: true,
      documentId: docId,
      title: req.title,
      chapterCount: detected.chapters.length,
      strategy: detected.strategy,
      patternName: detected.patternName,
      stats,
      contentHash: hash,
      strippedChars: stripped.removedChars,
      hitMarkers: stripped.hitMarkers,
      declaredGaps: detected.gaps,
      ...(cleanReport ? { clean: cleanReport, originalContentHash: originalHash } : {}),
      dir,
    };
  }

  /**
   * 从文件导入（.txt / .md，§45）。
   *
   * ⚠ 只支持纯文本格式：v1.0 明确把 .epub/.docx 列为可选（§45），
   *   不在此实现 —— 缺依赖却"看起来支持"会导致导入出乱码文本。
   */
  importFile(path: string, req: Omit<ImportRequest, 'text'>): ImportResult {
    if (!existsSync(path)) {
      return {
        ok: false,
        error: { code: ErrorCode.TOOL_VALIDATION_ERROR, message: `文件不存在：${path}` },
      };
    }
    const ext = path.toLowerCase().slice(path.lastIndexOf('.'));
    if (ext !== '.txt' && ext !== '.md') {
      return {
        ok: false,
        error: {
          code: ErrorCode.TOOL_VALIDATION_ERROR,
          message: `v1.0 只支持 .txt / .md，收到 ${ext}。` +
            '（.epub/.docx 在施工文档里属可选，尚未实现 —— 不支持就别假装支持）',
        },
      };
    }

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      return {
        ok: false,
        error: {
          code: ErrorCode.STORAGE_QUERY_FAILED,
          message: `读取文件失败：${e instanceof Error ? e.message : String(e)}`,
        },
      };
    }
    return this.import({ ...req, text });
  }
}
