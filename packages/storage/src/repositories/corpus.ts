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
import { normalizeGenre, sameGenre, listGenres, type SkillScope } from './genre.js';
import type { SkillStatus } from '@nwa/shared';

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
  /** 子类型（如"东方玄幻"）；迁移 0007 引入 */
  readonly subgenre?: string | null;
  /** 简介/文案；迁移 0007 引入 */
  readonly synopsis?: string | null;
}

/** 编译出的技能行（§24 八要素） */
export interface SkillRow {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  /** 一句话说明这个技能解决什么问题（供 Writer 在候选里快速判断） */
  readonly summary: string;
  readonly trigger_json: string;
  readonly rules_json: string;
  readonly examples_json: string;
  readonly anti_patterns_json: string;
  readonly evidence_refs_json: string;
  readonly confidence: number;
  readonly version: number;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly genre: string | null;
  readonly scope: string;
  readonly source_document_ids_json: string;
}

/** 挖掘出的模式行（§20 七槽） */
export interface PatternRow {
  readonly id: string;
  readonly category: string;
  readonly trigger_json: string;
  readonly pattern_json: string;
  readonly strategy_json: string;
  readonly evidence_refs_json: string;
  readonly confidence: number;
  readonly sample_count: number;
  readonly mechanism: string;
  readonly genre: string | null;
  readonly scene_function: string;
  readonly created_at: string;
  /** 作用域：UNIVERSAL / GENRE / STYLE（§21） */
  readonly scope: string;
  /**
   * scope 判定依据（P0-6，JSON）。
   *
   * ⚠ 可空：0011 之前写入的行没有这一列。空表示"当时没有记录依据"，
   *   不等于"依据为空"。读取方必须区分这两种情况，不能当默认值用。
   */
  readonly scope_evidence_json?: string | null;
}

export interface CorpusSceneRow {
  readonly id: string;
  readonly document_id: string;
  /** 类型（冗余自文档，便于按类型统计；迁移 0007 引入） */
  readonly genre?: string | null;
  readonly chapter_number: number | null;
  readonly scene_index: number | null;
  readonly text_path: string | null;
  readonly scene_type: string | null;
  readonly annotation_json: string | null;
  readonly created_at: string;
  /**
   * ⚠ 语义标注是否成功（迁移 0008）。
   *
   * 与"sceneFunction 为空"是**两件事**：
   *   0 = 没标注（模型失败/未跑）
   *   1 = 标注过（此时 scene_function 为空才表示"确实没有该功能"）
   * 混为一谈会让模式挖掘把标注失败率当成叙事事实。
   */
  readonly annotated?: number | null;
  /** 场景功能（冗余自 annotation_json，供聚合查询；迁移 0008） */
  readonly scene_function?: string | null;
  /** 机械指标（代码算，独立于语义标注；迁移 0008） */
  readonly pacing_json?: string | null;
  readonly prose_json?: string | null;
  /** 切分依据（§18 六项；迁移 0008） */
  readonly boundary_reason?: string | null;
  readonly boundary_evidence?: string | null;
  readonly boundary_uncertain?: number | null;
  /** ⚠ 超长且无切分依据（没切）；迁移 0008 */
  readonly oversized?: number | null;
  readonly chars?: number | null;
  readonly paragraph_count?: number | null;
  readonly annotation_error?: string | null;
}

/** 写入场景的输入（STEP 15 的标注结果） */
export interface PersistSceneInput {
  readonly id: string;
  readonly documentId: string;
  readonly chapterNumber: number | null;
  readonly sceneIndex: number;
  /** 场景正文文件路径（相对项目根，便于迁移） */
  readonly textPath: string | null;
  /** 场景功能（未标注时为 null） */
  readonly sceneFunction: string | null;
  /** 完整标注 JSON（§19） */
  readonly annotationJson: string | null;
  readonly pacingJson: string | null;
  readonly proseJson: string | null;
  readonly boundaryReason: string;
  readonly boundaryEvidence: string;
  readonly boundaryUncertain: boolean;
  /** ⚠ 超长且无切分依据（没切，§18 LLM 切分入口） */
  readonly oversized: boolean;
  readonly chars: number;
  readonly paragraphCount: number;
  readonly annotated: boolean;
  readonly annotationError: string | null;
  readonly genre?: string | null;
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
  /** 子类型（可选） */
  readonly subgenre?: string | null;
  /** 简介/文案（清洗阶段提取；不参与场景标注） */
  readonly synopsis?: string | null;
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
          popularity_tags_json, quality_tags_json, allowed_usage, content_hash, created_at,
          subgenre, synopsis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.subgenre ?? null,
      input.synopsis ?? null,
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

  /**
   * 按**类型**列出可处理文档（用户要求的类型隔离）。
   *
   * ⚠ 类型过滤必须下沉到仓储层：让每个调用方自己 filter 会导致
   *   "某条路径忘了过滤"的漏洞，而那种漏洞只在跨类型时暴露。
   *
   * 归一化由 genre.ts 的 normalizeGenre 负责（仙侠/修仙/修真 视为同类）。
   */
  listProcessableByGenre(genre: string | null): CorpusDocumentRow[] {
    const target = normalizeGenre(genre);
    if (target === null) return [];
    return this.listProcessable().filter((d) => sameGenre(d.genre, target));
  }

  /** 列出所有可用类型及文档数（供 UI 选择"写什么类型"） */
  listGenres(): { genre: string; count: number }[] {
    return listGenres(this.listProcessable());
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

  /**
   * 写入场景标注结果（STEP 15 → STEP 16 的落库入口）。
   *
   * ⚠ 幂等：同 id 重复写入会覆盖。这样**重跑标注**不会产生重复行，
   *   也便于"标注质量不满意 → 换个 prompt 重跑"。
   */
  persistScene(input: PersistSceneInput): void {
    this.db.run(
      `INSERT INTO corpus_scenes
         (id, document_id, chapter_number, scene_index, text_path, scene_type,
          annotation_json, created_at, genre, annotated, scene_function,
          pacing_json, prose_json, boundary_reason, boundary_evidence,
          boundary_uncertain, chars, paragraph_count, annotation_error, oversized)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         text_path = excluded.text_path,
         scene_function = excluded.scene_function,
         annotation_json = excluded.annotation_json,
         pacing_json = excluded.pacing_json,
         prose_json = excluded.prose_json,
         boundary_reason = excluded.boundary_reason,
         boundary_evidence = excluded.boundary_evidence,
         boundary_uncertain = excluded.boundary_uncertain,
         oversized = excluded.oversized,
         chars = excluded.chars,
         paragraph_count = excluded.paragraph_count,
         annotated = excluded.annotated,
         annotation_error = excluded.annotation_error,
         genre = excluded.genre`,
      input.id,
      input.documentId,
      input.chapterNumber,
      input.sceneIndex,
      input.textPath,
      input.sceneFunction, // scene_type 与 scene_function 同义，写同一值
      input.annotationJson,
      now(),
      input.genre ?? null,
      input.annotated ? 1 : 0,
      input.sceneFunction,
      input.pacingJson,
      input.proseJson,
      input.boundaryReason,
      input.boundaryEvidence,
      input.boundaryUncertain ? 1 : 0,
      input.chars,
      input.paragraphCount,
      input.annotationError,
      input.oversized ? 1 : 0,
    );
  }

  /**
   * 写入挖掘出的模式（幂等：同 id 覆盖）。
   *
   * ⚠ `scope` 由调用方按**来源作品数**决定，不采信模型自报 ——
   *   模型看不到全局作品分布，它说 "UNIVERSAL" 时无从判断。
   */
  putPattern(input: {
    readonly id: string;
    readonly category: string;
    readonly triggerJson: string;
    readonly patternJson: string;
    readonly strategyJson: string;
    readonly evidenceRefsJson: string;
    readonly confidence: number;
    readonly sampleCount: number;
    readonly mechanism: string;
    readonly genre: string | null;
    readonly sceneFunction: string;
    readonly scope: SkillScope;
    /**
     * scope 判定依据（P0-6）。JSON，可空 ——
     * 老行（0011 之前写入的）没有这一列，如实为 NULL，
     * 不补造一个"看起来合理"的依据。
     */
    readonly scopeEvidenceJson?: string | null;
  }): void {
    this.db.run(
      `INSERT INTO distillation_patterns
         (id, category, trigger_json, pattern_json, strategy_json, evidence_refs_json,
          confidence, sample_count, mechanism, genre, scene_function, created_at, scope,
          scope_evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         trigger_json = excluded.trigger_json,
         pattern_json = excluded.pattern_json,
         strategy_json = excluded.strategy_json,
         evidence_refs_json = excluded.evidence_refs_json,
         confidence = excluded.confidence,
         sample_count = excluded.sample_count,
         mechanism = excluded.mechanism,
         genre = excluded.genre,
         scene_function = excluded.scene_function,
         scope = excluded.scope,
         scope_evidence_json = excluded.scope_evidence_json`,
      input.id,
      input.category,
      input.triggerJson,
      input.patternJson,
      input.strategyJson,
      input.evidenceRefsJson,
      input.confidence,
      input.sampleCount,
      input.mechanism,
      input.genre,
      input.sceneFunction,
      now(),
      input.scope,
      input.scopeEvidenceJson ?? null,
    );
  }

  /**
   * 按类型 + 作用域取模式（Writer 消费的入口）。
   *
   * ⚠ 类型隔离：`genre` 归一化后比较，并**包含 UNIVERSAL**
   *   （跨类型通用策略对所有类型都适用）。
   *   STYLE 作用域需显式 `includeStyle` 才返回 —— §21 要求
   *   Writer 默认不用作者特有策略。
   */
  listPatterns(opts: {
    readonly genre?: string | null;
    readonly sceneFunction?: string;
    readonly includeStyle?: boolean;
    readonly minConfidence?: number;
  } = {}): PatternRow[] {
    const rows = this.db.all<PatternRow>(
      `SELECT * FROM distillation_patterns ORDER BY confidence DESC, sample_count DESC`,
    );
    const target = normalizeGenre(opts.genre ?? null);
    return rows.filter((r) => {
      // 作用域过滤：STYLE 默认排除
      if (r.scope === 'STYLE' && !opts.includeStyle) return false;
      // UNIVERSAL 对所有类型适用；GENRE 要求同类型
      if (r.scope === 'GENRE' && target !== null && normalizeGenre(r.genre) !== target) {
        return false;
      }
      if (opts.sceneFunction && r.scene_function !== opts.sceneFunction) return false;
      if (opts.minConfidence !== undefined && r.confidence < opts.minConfidence) return false;
      return true;
    });
  }

  /** 模式统计（供 verify 与 UI 展示） */
  patternStats(): { scope: string; genre: string | null; count: number }[] {
    return this.db.all<{ scope: string; genre: string | null; count: number }>(
      `SELECT scope, genre, COUNT(*) AS count FROM distillation_patterns
       GROUP BY scope, genre ORDER BY count DESC`,
    );
  }

  /** 按场景功能统计模式数 */
  patternStatsByFunction(): { scene_function: string; count: number; avgConfidence: number }[] {
    return this.db.all<{ scene_function: string; count: number; avgConfidence: number }>(
      `SELECT scene_function, COUNT(*) AS count, AVG(confidence) AS avgConfidence
       FROM distillation_patterns GROUP BY scene_function ORDER BY count DESC`,
    );
  }

  /**
   * 写入技能（幂等：同 id 覆盖）。
   *
   * ⚠ 版本管理：同 `id` 重复编译时 `version` 由调用方递增 ——
   *   仓储不自己加（它不知道这次是"重编译"还是"修正"）。
   *   传进来的 version 就是权威值。
   */
  putSkill(input: {
    readonly id: string;
    readonly name: string;
    readonly category: string;
    readonly summary: string;
    readonly triggerJson: string;
    readonly rulesJson: string;
    readonly examplesJson: string;
    readonly antiPatternsJson: string;
    readonly evidenceRefsJson: string;
    readonly confidence: number;
    readonly version: number;
    readonly status: SkillStatus;
    readonly genre: string | null;
    readonly scope: SkillScope;
    readonly sourceDocumentIdsJson: string;
  }): void {
    this.db.run(
      `INSERT INTO distilled_skills
         (id, name, category, summary, trigger_json, rules_json, examples_json,
          anti_patterns_json, evidence_refs_json, confidence, version, status,
          created_at, updated_at, genre, scope, source_document_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         category = excluded.category,
         summary = excluded.summary,
         trigger_json = excluded.trigger_json,
         rules_json = excluded.rules_json,
         examples_json = excluded.examples_json,
         anti_patterns_json = excluded.anti_patterns_json,
         evidence_refs_json = excluded.evidence_refs_json,
         confidence = excluded.confidence,
         version = excluded.version,
         status = excluded.status,
         updated_at = excluded.updated_at,
         genre = excluded.genre,
         scope = excluded.scope,
         source_document_ids_json = excluded.source_document_ids_json`,
      input.id,
      input.name,
      input.category,
      input.summary,
      input.triggerJson,
      input.rulesJson,
      input.examplesJson,
      input.antiPatternsJson,
      input.evidenceRefsJson,
      input.confidence,
      input.version,
      input.status,
      now(),
      now(),
      input.genre,
      input.scope,
      input.sourceDocumentIdsJson,
    );
  }

  /** 取一个技能当前版本号（不存在返回 0，供版本递增） */
  skillVersion(id: string): number {
    return (
      this.db.get<{ version: number }>(
        'SELECT version FROM distilled_skills WHERE id = ?',
        id,
      )?.version ?? 0
    );
  }

  /** 按 id 取技能 */
  getSkill(id: string): SkillRow | null {
    return this.db.get<SkillRow>('SELECT * FROM distilled_skills WHERE id = ?', id) ?? null;
  }

  /** 列出全部技能（调用方用 filterSkillsByGenre 做类型隔离） */
  listSkills(): SkillRow[] {
    return this.db.all<SkillRow>(
      'SELECT * FROM distilled_skills ORDER BY confidence DESC, id',
    );
  }

  /** 技能统计 */
  skillStats(): { status: string; scope: string; genre: string | null; count: number }[] {
    return this.db.all<{ status: string; scope: string; genre: string | null; count: number }>(
      `SELECT status, scope, genre, COUNT(*) AS count FROM distilled_skills
       GROUP BY status, scope, genre ORDER BY count DESC`,
    );
  }

  /** 更新技能状态（启用/废弃） */
  setSkillStatus(id: string, status: SkillStatus): boolean {
    const before = this.getSkill(id);
    if (!before) return false;
    this.db.run(
      'UPDATE distilled_skills SET status = ?, updated_at = ? WHERE id = ?',
      status,
      now(),
      id,
    );
    return true;
  }

  /** 列出某文档的全部场景（含未标注）—— 断点续跑用 */
  listScenesByDocument(documentId: string): CorpusSceneRow[] {
    return this.db.all<CorpusSceneRow>(
      `SELECT * FROM corpus_scenes WHERE document_id = ?
       ORDER BY chapter_number, scene_index`,
      documentId,
    );
  }

  /**
   * ⚠ 只取**已标注**的场景（模式挖掘的输入）。
   *
   * 未标注场景的语义字段为空，但那是"没标注"而非"没有"。
   * 混入会让统计失真 —— 因此过滤下沉到仓储层，
   * 不依赖调用方记得加 `WHERE annotated = 1`。
   */
  listAnnotatedScenes(documentId: string): CorpusSceneRow[] {
    return this.db.all<CorpusSceneRow>(
      `SELECT * FROM corpus_scenes
       WHERE document_id = ? AND annotated = 1
       ORDER BY chapter_number, scene_index`,
      documentId,
    );
  }

  /** 按类型列出已标注场景（跨作品对比的输入） */
  listAnnotatedScenesByGenre(genre: string | null): CorpusSceneRow[] {
    const target = normalizeGenre(genre);
    if (target === null) return [];
    // ⚠ 类型归一化：库里的 genre 可能是"修仙"，查询用"仙侠"——
    //   等值比较会漏掉。因此取回后按 sameGenre 过滤。
    return this.db
      .all<CorpusSceneRow>(
        `SELECT * FROM corpus_scenes WHERE annotated = 1 ORDER BY document_id, chapter_number, scene_index`,
      )
      .filter((r) => sameGenre(r.genre, target));
  }

  /** 按场景功能聚合统计（§20 模式挖掘的基础） */
  sceneFunctionStats(documentId?: string): { sceneFunction: string; count: number }[] {
    const rows = documentId
      ? this.db.all<{ f: string; n: number }>(
          `SELECT scene_function AS f, COUNT(*) AS n FROM corpus_scenes
           WHERE annotated = 1 AND document_id = ? AND scene_function IS NOT NULL
           GROUP BY scene_function ORDER BY n DESC`,
          documentId,
        )
      : this.db.all<{ f: string; n: number }>(
          `SELECT scene_function AS f, COUNT(*) AS n FROM corpus_scenes
           WHERE annotated = 1 AND scene_function IS NOT NULL
           GROUP BY scene_function ORDER BY n DESC`,
        );
    return rows.map((r) => ({ sceneFunction: r.f, count: r.n }));
  }

  /** 标注进度（如实报告未标注数，便于判断样本是否够用） */
  annotationProgress(documentId: string): {
    readonly total: number;
    readonly annotated: number;
    readonly failed: number;
  } {
    const total =
      this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM corpus_scenes WHERE document_id = ?',
        documentId,
      )?.n ?? 0;
    const annotated =
      this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM corpus_scenes WHERE document_id = ? AND annotated = 1',
        documentId,
      )?.n ?? 0;
    return { total, annotated, failed: total - annotated };
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
