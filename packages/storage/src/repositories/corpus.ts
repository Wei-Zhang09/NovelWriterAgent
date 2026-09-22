/**
 * corpus 仓储（施工文档 §16 / §45 / §61）
 *
 * ## 版权是硬约束，不是提示
 *
 * §61 明确要求：产品**不得默认假设所有网上小说都可自由训练或再分发**。
 * 每个语料文档必须登记来源/作者/License/使用许可。
 *
 * ⚠ `UNKNOWN` 许可**代码层禁止**进入自动处理链 —— 这一条在仓储层强制，
 *   而不是靠调用方自觉。理由：许可判断一旦被绕过，后果是法律风险，
 *   而"调用方记得检查"是不可靠的（参考项目教训：靠 prompt 约束等于没有约束）。
 *
 * ## 去重靠 content hash
 *
 * §45：重复文本通过 content hash 去重。同一份文本重复导入必须被拒，
 * 否则模式挖掘会把同一部作品当多部作品统计，污染 confidence 与 sample_count。
 */
import type { Database } from '../database.js';
import { AppError, ErrorCode } from '@nwa/core';
import { now, requireRow } from './types.js';

/** 来源类型（§16.2） */
export const CORPUS_SOURCE_TYPES = [
  'PUBLIC_DOMAIN',
  'USER_OWNED',
  'USER_LICENSED',
  'REFERENCE_ONLY',
  'UNKNOWN',
] as const;
export type CorpusSourceType = (typeof CORPUS_SOURCE_TYPES)[number];

/** 使用许可（§61） */
export const CORPUS_USAGE = [
  'FULL_ANALYSIS',
  'DISTILLATION_ONLY',
  'RETRIEVAL_ONLY',
  'NO_PROCESSING',
] as const;
export type CorpusUsage = (typeof CORPUS_USAGE)[number];

export interface CorpusDocumentRow {
  readonly id: string;
  readonly title: string;
  readonly author: string | null;
  readonly source_type: string;
  readonly license_type: string;
  readonly local_path: string | null;
  readonly genre: string | null;
  readonly popularity_tags_json: string | null;
  readonly quality_tags_json: string | null;
  readonly allowed_usage: string;
  readonly content_hash: string | null;
  readonly created_at: string;
}

export interface CorpusSceneRow {
  readonly id: string;
  readonly document_id: string;
  readonly chapter_number: number | null;
  readonly scene_index: number | null;
  readonly text_path: string | null;
  readonly scene_type: string | null;
  readonly annotation_json: string | null;
  readonly created_at: string;
}

export interface RegisterDocumentInput {
  readonly id: string;
  readonly title: string;
  readonly author?: string | null;
  readonly sourceType: CorpusSourceType;
  readonly licenseType: CorpusSourceType;
  readonly localPath?: string | null;
  readonly genre?: string | null;
  readonly allowedUsage: CorpusUsage;
  readonly contentHash: string;
  readonly qualityTags?: readonly string[];
  readonly popularityTags?: readonly string[];
}

/**
 * 允许进入自动处理链的许可集合。
 *
 * ⚠ `UNKNOWN` 与 `NO_PROCESSING` **不在其中** —— 这是 §61 的落地：
 *   "可以在本地分析"与"可以放进训练/再分发链"是两件事，
 *   许可不明的内容不得进入自动处理。
 */
export const PROCESSABLE_USAGE: readonly CorpusUsage[] = [
  'FULL_ANALYSIS',
  'DISTILLATION_ONLY',
];

/**
 * 许可的**宽窄层级**（数字越大越宽）。
 *
 * ⚠ 必须用层级比较，不能写成一堆 if 组合 —— 否则容易漏掉
 *   「许可比请求更窄」的方向（实测踩到：DISTILLATION_ONLY 的文档
 *   被误判为允许 FULL_ANALYSIS，因为只检查了"请求是否在许可列表里"，
 *   没有检查"请求是否比许可更宽"）。
 */
const USAGE_RANK: Record<CorpusUsage, number> = {
  FULL_ANALYSIS: 3,
  DISTILLATION_ONLY: 2,
  RETRIEVAL_ONLY: 1,
  NO_PROCESSING: 0,
};

/**
 * 判断某个文档是否允许做某类处理。
 *
 * 语义：**请求的处理必须不比许可更宽**。
 *   - 许可 FULL_ANALYSIS（最宽）→ 任何请求都可以
 *   - 许可 DISTILLATION_ONLY → 可以蒸馏，但**不可以**做 FULL_ANALYSIS
 *   - 许可 RETRIEVAL_ONLY → 只能检索，不能蒸馏
 *   - 许可 NO_PROCESSING → 什么都不能做
 */
export function canProcess(doc: CorpusDocumentRow, usage: CorpusUsage): boolean {
  const allowed = USAGE_RANK[doc.allowed_usage as CorpusUsage];
  const requested = USAGE_RANK[usage];
  if (allowed === undefined || requested === undefined) return false;
  return allowed >= requested;
}

export class CorpusRepository {
  constructor(private readonly db: Database) {}

  /**
   * 登记语料文档。
   *
   * ⚠ 重复导入（同 content_hash）被拒绝 —— 见文件头「去重靠 content hash」。
   * ⚠ `UNKNOWN` 来源允许登记（用户可能只是先存着），但**不允许**
   *   `allowedUsage = FULL_ANALYSIS`：许可不明的内容不能进自动分析。
   */
  register(input: RegisterDocumentInput): CorpusDocumentRow {
    if (input.title.trim().length === 0) {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '语料标题不得为空');
    }
    if (input.contentHash.trim().length === 0) {
      throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, 'contentHash 不得为空（去重依赖它）');
    }

    // ⚠ §61：许可不明不得进入自动处理链
    if (input.licenseType === 'UNKNOWN' && input.allowedUsage !== 'RETRIEVAL_ONLY' && input.allowedUsage !== 'NO_PROCESSING') {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `许可不明（UNKNOWN）的语料只能设为 RETRIEVAL_ONLY 或 NO_PROCESSING，` +
          `不得设为 ${input.allowedUsage} —— §61 要求许可不明的内容禁止进入自动分析/蒸馏链`,
      );
    }

    // 去重：同 hash 已存在则拒绝
    const dup = this.db.get<CorpusDocumentRow>(
      'SELECT * FROM corpus_documents WHERE content_hash = ?',
      input.contentHash,
    );
    if (dup) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `该文本已导入过（内容哈希相同）：「${dup.title}」—— 重复导入会污染模式挖掘的样本统计`,
      );
    }

    const ts = now();
    this.db.run(
      `INSERT INTO corpus_documents
         (id, title, author, source_type, license_type, local_path, genre,
          popularity_tags_json, quality_tags_json, allowed_usage, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.title.trim(),
      input.author ?? null,
      input.sourceType,
      input.licenseType,
      input.localPath ?? null,
      input.genre ?? null,
      JSON.stringify(input.popularityTags ?? []),
      JSON.stringify(input.qualityTags ?? []),
      input.allowedUsage,
      input.contentHash,
      ts,
    );
    return this.get(input.id);
  }

  get(id: string): CorpusDocumentRow {
    return requireRow(
      this.db.get<CorpusDocumentRow>('SELECT * FROM corpus_documents WHERE id = ?', id),
      'corpus document',
      id,
    );
  }

  findByHash(hash: string): CorpusDocumentRow | null {
    return (
      this.db.get<CorpusDocumentRow>(
        'SELECT * FROM corpus_documents WHERE content_hash = ?',
        hash,
      ) ?? null
    );
  }

  list(): CorpusDocumentRow[] {
    return this.db.all<CorpusDocumentRow>(
      'SELECT * FROM corpus_documents ORDER BY created_at DESC',
    );
  }

  /** 只列出允许进入自动处理链的文档（§61） */
  listProcessable(): CorpusDocumentRow[] {
    return this.list().filter((d) =>
      PROCESSABLE_USAGE.includes(d.allowed_usage as CorpusUsage),
    );
  }

  /** ⚠ 供蒸馏链使用：拿不到可处理的文档就报错，不静默返回空 */
  requireProcessable(id: string): CorpusDocumentRow {
    const doc = this.get(id);
    if (!PROCESSABLE_USAGE.includes(doc.allowed_usage as CorpusUsage)) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `语料「${doc.title}」的许可为 ${doc.allowed_usage}，不允许进入蒸馏链（§61）`,
      );
    }
    return doc;
  }

  // ── 场景（§19 标注结果的落库） ────────────────────────────

  /** 写入一个场景；同 (document, chapter, scene_index) 幂等覆盖 */
  putScene(input: {
    readonly id: string;
    readonly documentId: string;
    readonly chapterNumber: number | null;
    readonly sceneIndex: number | null;
    readonly textPath: string | null;
    readonly sceneType: string | null;
    readonly annotationJson: string | null;
  }): void {
    this.db.run(
      `INSERT INTO corpus_scenes
         (id, document_id, chapter_number, scene_index, text_path, scene_type, annotation_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         text_path = excluded.text_path,
         scene_type = excluded.scene_type,
         annotation_json = excluded.annotation_json`,
      input.id,
      input.documentId,
      input.chapterNumber,
      input.sceneIndex,
      input.textPath,
      input.sceneType,
      input.annotationJson,
      now(),
    );
  }

  listScenes(documentId: string): CorpusSceneRow[] {
    return this.db.all<CorpusSceneRow>(
      'SELECT * FROM corpus_scenes WHERE document_id = ? ORDER BY chapter_number, scene_index',
      documentId,
    );
  }

  countScenes(documentId: string): number {
    return (
      this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM corpus_scenes WHERE document_id = ?',
        documentId,
      )?.n ?? 0
    );
  }
}
