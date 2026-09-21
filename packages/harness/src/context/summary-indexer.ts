/**
 * 摘要索引器（ADR-0006 约束 C，补缺口）
 *
 * ## 唯一的职责：确保**只有作者确认过的摘要**进入检索索引
 *
 * ADR-0006 引用的实战教训：
 *   > 摘要是长程记忆的源头，错一条污染后面几百章
 *
 * 因此这道关口不能只是"UI 上提示一下"，必须落到**索引写入路径**上：
 * 只要 `summary_approved = 0`，就不写进 memory_fts。
 *
 * ## 为什么把"该索引什么"的判断集中在这里
 *
 * 若散落在多处（Commit 时、UI 保存时、手动重建时），只要有**一处**忘了
 * 判断确认状态，污染就进去了 —— 而污染一旦进入后续章节的上下文，
 * 会持续影响几十章的生成，事后无法追溯。
 *
 * 所以：任何写 memory_fts 的路径都必须经过本类。
 */
import { Logger } from '@nwa/core';
import type { Repositories, FtsIndex } from '@nwa/storage';

export interface ReindexResult {
  readonly indexed: number;
  /** 因未确认而**被排除**的数量 —— 必须报告，否则用户不知道记忆缺失 */
  readonly excludedUnapproved: number;
  readonly skippedEmpty: number;
}

export class SummaryIndexer {
  private readonly repos: Repositories;
  private readonly fts: FtsIndex;
  private readonly logger: Logger;

  constructor(opts: {
    readonly repos: Repositories;
    readonly fts: FtsIndex;
    readonly logger: Logger;
  }) {
    this.repos = opts.repos;
    this.fts = opts.fts;
    this.logger = opts.logger;
  }

  /**
   * 把某本书**已确认**的摘要写入记忆索引。
   *
   * ⚠ 已提交但未确认的摘要会被排除，并计入 excludedUnapproved。
   */
  indexBook(bookId: string): ReindexResult {
    const approved = this.repos.chapters.listApprovedSummaries(bookId);
    const pending = this.repos.chapters.listPendingSummaries(bookId);

    let indexed = 0;
    let skippedEmpty = 0;

    for (const c of approved) {
      const summary = c.summary ?? '';
      if (summary.trim().length === 0) {
        skippedEmpty++;
        continue;
      }
      this.fts.indexMemory({
        itemId: `summary_${c.id}`,
        bookId,
        itemType: 'SUMMARY',
        sourceRef: c.body_path ?? `chapters/${String(c.chapter_number).padStart(3, '0')}.md`,
        // 章节号一并写入，便于检索结果排序与展示
        text: `第 ${c.chapter_number} 章 ${summary}`,
      });
      indexed++;
    }

    if (pending.length > 0) {
      // 明确记录被排除的数量 —— 记忆缺失必须是**可见的**
      this.logger.warn('存在未确认的摘要，已排除在检索索引之外', {
        bookId,
        pending: pending.length,
        firstPendingChapter: pending[0]!.chapter_number,
      });
    }

    return { indexed, excludedUnapproved: pending.length, skippedEmpty };
  }

  /**
   * 索引单章摘要（作者确认后调用）。
   *
   * ⚠ 若该章摘要未确认，**不索引并移除已有索引** ——
   *   这覆盖"确认后又撤回"的情形，避免残留污染。
   */
  indexChapter(chapterId: string): { readonly indexed: boolean; readonly reason?: string } {
    const chapter = this.repos.chapters.get(chapterId);
    const itemId = `summary_${chapter.id}`;

    if (chapter.summary === null || chapter.summary.trim().length === 0) {
      return { indexed: false, reason: '该章没有摘要' };
    }

    if (!chapter.summary_approved) {
      // 撤回确认的情形：清掉已有索引，防止旧内容继续被检索到
      this.fts.indexMemory({
        itemId,
        bookId: chapter.book_id,
        itemType: 'SUMMARY',
        sourceRef: 'revoked',
        text: '',
      });
      return { indexed: false, reason: '摘要未确认（ADR-0006 约束 C），已从索引移除' };
    }

    this.fts.indexMemory({
      itemId,
      bookId: chapter.book_id,
      itemType: 'SUMMARY',
      sourceRef: chapter.body_path ?? `chapters/${String(chapter.chapter_number).padStart(3, '0')}.md`,
      text: `第 ${chapter.chapter_number} 章 ${chapter.summary}`,
    });
    return { indexed: true };
  }

  /**
   * 待确认摘要清单（UI 的"验收卡"用）。
   *
   * ⚠ 这个清单存在的意义就是"可见" —— 宁可记忆缺失且可见，
   *   也不要记忆污染且不可见。
   */
  pendingSummaries(bookId: string): readonly {
    readonly chapterId: string;
    readonly chapterNumber: number;
    readonly summary: string;
  }[] {
    return this.repos.chapters.listPendingSummaries(bookId).map((c) => ({
      chapterId: c.id,
      chapterNumber: c.chapter_number,
      summary: c.summary ?? '',
    }));
  }
}
