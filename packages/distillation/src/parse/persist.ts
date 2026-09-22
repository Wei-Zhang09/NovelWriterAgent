/**
 * 场景标注持久化（STEP 15 → STEP 16 的衔接）
 *
 * ## 落盘布局
 *
 * ```
 * <corpusRoot>/documents/<docId>/
 *   chapters/001.md          ← 章节正文（导入时写）
 *   scenes/c001_s0.md        ← 场景正文（本模块写）
 * ```
 *
 * ## ⚠ 为什么场景正文写文件而不是塞 DB 列
 *
 * §46 要求证据可回溯到原文。写文件的好处：
 *   1. 人工可直接打开核对（模式挖掘产出的每条 evidence 都要能对上）
 *   2. 可被 diff 工具比较（重跑标注后看哪些场景边界变了）
 *   3. 避免 DB 膨胀 —— 五部书约 1.5 万个场景，全塞 DB 会让
 *      备份/导出变慢（§58 的导出包含 chapters/ 与 corpus/）
 *
 * DB 只存 `text_path`，路径**相对 corpusRoot**（便于整体迁移）。
 *
 * ## ⚠ 为什么必须记 `annotated` 标志
 *
 * 语义标注可能失败。失败时 `scene_function` 为空，但**"空"不等于
 * "没有该功能"** —— 前者是"没标注"，后者是"标注了但确实没有"。
 * 混为一谈会让模式挖掘把**标注失败率**当成叙事事实。
 * 因此 `annotated` 是显式标志，且聚合查询一律 `WHERE annotated = 1`。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nwa/core';
import type { CorpusRepository } from '@nwa/storage';
import type { AnnotatedScene, AnnotateChapterResult } from './annotator.js';

export interface PersistOptions {
  readonly repo: CorpusRepository;
  /** 语料根目录（与导入时一致） */
  readonly corpusRoot: string;
  readonly logger: Logger;
}

export interface PersistResult {
  readonly documentId: string;
  readonly chapterNumber: number | null;
  readonly persisted: number;
  readonly annotated: number;
  readonly failed: number;
  /** 写入的场景文件目录 */
  readonly sceneDir: string;
}

/** 场景文件名：c<章号>_s<场景号>.md（补零保证排序稳定） */
export function sceneFileName(chapterNumber: number | null, sceneIndex: number): string {
  const c = String(chapterNumber ?? 0).padStart(3, '0');
  const s = String(sceneIndex).padStart(3, '0');
  return `c${c}_s${s}.md`;
}

export class ScenePersister {
  private readonly repo: CorpusRepository;
  private readonly corpusRoot: string;
  private readonly logger: Logger;

  constructor(opts: PersistOptions) {
    this.repo = opts.repo;
    this.corpusRoot = opts.corpusRoot;
    this.logger = opts.logger;
  }

  /**
   * 落库一章的标注结果。
   *
   * ⚠ 幂等：同一 (documentId, chapterNumber, sceneIndex) 重复写入会覆盖。
   *   这样"换个 prompt 重跑标注"不会产生重复行。
   */
  persistChapter(req: {
    readonly documentId: string;
    readonly genre: string | null;
    readonly result: AnnotateChapterResult;
  }): PersistResult {
    const { documentId, genre, result } = req;
    const ch = result.chapterNumber;
    const sceneDir = join(
      this.corpusRoot,
      'documents',
      documentId,
      'scenes',
    );
    mkdirSync(sceneDir, { recursive: true });

    let annotated = 0;
    let failed = 0;

    for (const s of result.scenes) {
      const fileName = sceneFileName(ch, s.sceneIndex);
      const abs = join(sceneDir, fileName);
      writeFileSync(abs, s.text, 'utf8');

      // ⚠ 路径存**相对 corpusRoot**，便于整体迁移
      const relPath = join('documents', documentId, 'scenes', fileName).replace(/\\/g, '/');

      if (s.annotated) annotated++;
      else failed++;

      this.repo.persistScene({
        id: s.sceneId,
        documentId,
        chapterNumber: ch,
        sceneIndex: s.sceneIndex,
        textPath: relPath,
        sceneFunction: s.annotation.sceneFunction ?? null,
        annotationJson: JSON.stringify(s.annotation),
        pacingJson: s.annotation.pacing ? JSON.stringify(s.annotation.pacing) : null,
        proseJson: s.annotation.prose ? JSON.stringify(s.annotation.prose) : null,
        boundaryReason: s.boundaryReason,
        boundaryEvidence: s.boundaryEvidence,
        boundaryUncertain: s.boundaryUncertain,
        oversized: s.oversized,
        chars: s.chars,
        paragraphCount: s.paragraphCount,
        // ⚠ 显式标志：区分"没标注"与"标注了但没有该功能"
        annotated: s.annotated,
        annotationError: s.annotationError ?? null,
        genre,
      });
    }

    const out: PersistResult = {
      documentId,
      chapterNumber: ch,
      persisted: result.scenes.length,
      annotated,
      failed,
      sceneDir,
    };

    this.logger.info('场景标注已落库', {
      documentId,
      chapterNumber: ch,
      persisted: out.persisted,
      annotated,
      failed,
    });

    return out;
  }

  /**
   * 从章节文件重跑并落库（批量入口）。
   *
   * ⚠ 逐章调用 `annotate` 回调 —— 由调用方控制并发与限流，
   *   本模块不管并发（那是调用方的策略问题）。
   */
  async persistMany(req: {
    readonly documentId: string;
    readonly genre: string | null;
    readonly chapters: readonly { readonly chapterNumber: number; readonly text: string }[];
    readonly annotate: (chapter: {
      readonly chapterNumber: number;
      readonly text: string;
    }) => Promise<AnnotateChapterResult>;
    readonly onProgress?: (done: number, total: number) => void;
  }): Promise<{
    readonly chapters: number;
    readonly scenes: number;
    readonly annotated: number;
    readonly failed: number;
  }> {
    let scenes = 0;
    let annotated = 0;
    let failed = 0;

    for (const ch of req.chapters) {
      const result = await req.annotate(ch);
      const r = this.persistChapter({
        documentId: req.documentId,
        genre: req.genre,
        result,
      });
      scenes += r.persisted;
      annotated += r.annotated;
      failed += r.failed;
      req.onProgress?.(ch.chapterNumber, req.chapters.length);
    }

    return { chapters: req.chapters.length, scenes, annotated, failed };
  }
}

/** 场景标注摘要（供 verify 脚本打印） */
export function summarizePersist(r: PersistResult): string {
  return (
    `第 ${r.chapterNumber ?? '?'} 章：落库 ${r.persisted} 个场景` +
    `（已标注 ${r.annotated}，失败 ${r.failed}）`
  );
}

void (null as unknown as AnnotatedScene);
