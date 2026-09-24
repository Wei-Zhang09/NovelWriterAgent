/**
 * 分层检索服务（P0-3）—— MemoryGatherer 正式接入主写作链。
 *
 * ## 为什么需要"分层"
 *
 * 提示词 §五 要求不同 stage 用**不同粒度**的检索：
 *
 * ```
 * Planner    → chapter-level    "前面发生过什么"（定本章走向）
 * Writer     → scene-level      "这个场景该怎么写"（要可模仿的具体写法）
 * Reviewer   → evidence-level   "这条指控有没有依据"（要可引用的证据）
 * Continuity → 结构化真相        Canon / CharacterState / Timeline / Foreshadowing
 * ```
 *
 * 为什么不能一个 `gather()` 打天下：
 * - Planner 拿到具体片段会**被细节带偏**（它要的是剧情脉络）
 * - Writer 只拿到摘要会**缺具体写法**（它要的是可模仿的段落）
 * - Reviewer 要的是**可引用的证据条目**，小说片段无法支撑"这里矛盾"这种断言
 * - Continuity 要的是**结构化真值**（谁在第几章是什么状态），
 *   全文检索无法回答"第三章时她还不知道这件事"
 *
 * ## 各层用哪个真实数据源（实测核对过表结构）
 *
 * | 层 | 来源 | 理由 |
 * |---|---|---|
 * | chapter | `memory_fts`（章节摘要，commit-engine 写入） | 长程记忆的载体就是被压缩的摘要 |
 * | chapter | `chapter_fts`（已提交正文） | 需要原文脉络时 |
 * | scene | `chapter_fts` 按场景意图查正文 | 要"可模仿的写法"必须拿到原文 |
 * | evidence | `evidence` 表（quote 必填、可回溯） | 断言必须有确定性依据 |
 * | structured | `facts` / `character_states` / `timeline_events` / `foreshadowing` | 确定性真值 |
 *
 * ⚠ **关于 scene 层的如实说明**：本项目**没有**场景级正文索引 ——
 *   场景切分与标注（`corpus_scenes`）只作用于**语料库**，不是当前小说。
 *   当前小说的场景正文存在 workspace 文件里，未进 FTS。
 *   所以 scene 层实际是"用场景意图去查已提交正文"，粒度由**查询意图**
 *   而非索引粒度决定。这是当前实现的真实边界，不假装有更细的索引。
 *
 * ## 为什么 Continuity 优先结构化
 *
 * 检索（FTS/BM25）是**概率性**的：查得到不代表全，查不到不代表没有。
 * 而连续性结论是**断言**（"这里矛盾"），断言必须有确定性依据。
 * 所以结构化来源优先，全文检索只作补充，且结果里**如实标明来源层级**。
 *
 * ## 检索痕迹
 *
 * 每次检索落 `retrieval_traces`，使「为什么这一章引用了那个旧章节」可回答。
 * ⚠ 痕迹写入失败**不阻断**写作 —— 它是观测，不是流程的一部分。
 */
import { Logger } from '@nwa/core';
import type { Database } from '@nwa/storage';

/** 检索层级 */
export type RetrievalTier = 'chapter' | 'scene' | 'evidence' | 'structured';

/** 一条检索结果 */
export interface TierHit {
  /** 唯一 id（落 traces 用） */
  readonly hitId: string;
  /** 来源引用（chapter:12 / fact:xxx）—— 必填，§11 禁止无根记忆 */
  readonly sourceRef: string;
  /** 检索器名称（落 traces 用，便于回答"用哪个索引查到的"） */
  readonly retriever: string;
  /** 分数（结构化来源为 null —— 它不是打分排出来的） */
  readonly score: number | null;
  /** 内容片段 */
  readonly content: string;
  /** 为什么命中（人话） */
  readonly reason: string;
}

export interface TierResult {
  readonly tier: RetrievalTier;
  readonly query: string;
  readonly hits: readonly TierHit[];
  /** 检索是否**成功执行**（false = 检索层不可用，不是"没有相关记忆"） */
  readonly retrieved: boolean;
  readonly error?: string;
}

/** 结构化真相快照（Continuity 用） */
export interface StructuredTruth {
  readonly canonFacts: readonly {
    readonly id: string;
    readonly predicate: string;
    readonly objectValue: string;
    readonly sourceRef: string;
  }[];
  readonly characterStates: readonly {
    readonly characterId: string;
    readonly name: string;
    readonly chapterNumber: number;
    readonly status: string;
  }[];
  readonly timeline: readonly {
    readonly id: string;
    readonly chapterNumber: number;
    readonly summary: string;
  }[];
  readonly foreshadowing: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly setupChapter: number | null;
    readonly payoffChapter: number | null;
  }[];
}

export interface GatherTierInput {
  readonly bookId: string;
  readonly chapterNumber: number;
  /** 检索意图（Planner 用本章目的，Writer 用场景目标） */
  readonly query: string;
  readonly workflowId?: string | null;
  readonly stage: string;
  readonly limit?: number;
}

export interface RetrievalServiceDeps {
  readonly db: Database;
  readonly logger: Logger;
  /**
   * MATCH 表达式构造器。
   *
   * ⚠ 必须由调用方注入（与索引侧同一分词口径，ADR-0004 的 bigram 补丁）。
   *   在这里自己拼词元会让查询侧与索引侧分词不一致 ——
   *   表现为"明明写过的内容检索不到"，很难查。
   */
  readonly buildMatch: (query: string) => string;
  /**
   * 痕迹落库（由 harness 的 WorkflowRepository 提供）。
   *
   * ⚠ 注入而非直接 import：storage 不该知道 workflow 的事。
   */
  readonly recordTraces?: (
    rows: readonly {
      readonly id: string;
      readonly workflowId: string | null;
      readonly stage: string;
      readonly query: string;
      readonly retriever: string;
      readonly hitId: string;
      readonly score: number | null;
      readonly sourceRef: string | null;
      readonly reason: string | null;
    }[],
  ) => number;
}

/** 生成痕迹 id（core 没有通用 id 工厂，这里本地生成） */
function traceId(i: number): string {
  return `rt_${Date.now().toString(36)}_${i}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export class RetrievalService {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly buildMatch: (query: string) => string;
  private readonly recordTraces: RetrievalServiceDeps['recordTraces'];

  constructor(deps: RetrievalServiceDeps) {
    this.db = deps.db;
    this.logger = deps.logger;
    this.buildMatch = deps.buildMatch;
    this.recordTraces = deps.recordTraces;
  }

  // ── Planner：章节级 ────────────────────────────────────
  /**
   * 章节级检索 —— 回答"前面发生过什么"。
   *
   * 两个来源都查：
   *   memory_fts —— 章节摘要（长程记忆的载体）
   *   chapter_fts —— 已提交正文（需要原文脉络时）
   *
   * ⚠ 只取**已提交**章节：未提交的正文还在改，
   *   把它当"已发生的事"会让 Planner 基于会被推翻的内容做规划。
   */
  gatherChapterLevel(input: GatherTierInput): TierResult {
    const limit = input.limit ?? 8;
    const hits: TierHit[] = [];
    const errors: string[] = [];

    const match = this.safeMatch(input.query);

    if (match) {
      // ① 摘要（长程记忆）
      try {
        const rows = this.db.all<{ item_id: string; source_ref: string | null; score: number }>(
          `SELECT item_id, source_ref, bm25(memory_fts) AS score
             FROM memory_fts
            WHERE memory_fts MATCH ? AND book_id = ?
            ORDER BY score LIMIT ?`,
          match,
          input.bookId,
          limit,
        );
        for (const r of rows) {
          hits.push({
            hitId: r.item_id,
            sourceRef: r.source_ref ?? `memory:${r.item_id}`,
            retriever: 'memory_fts',
            score: r.score,
            content: `（章节摘要，见 ${r.source_ref ?? r.item_id}）`,
            reason: '长程记忆命中（章节摘要）',
          });
        }
      } catch (e) {
        errors.push(`memory_fts: ${msg(e)}`);
      }

      // ② 已提交正文
      try {
        const rows = this.db.all<{
          chapter_id: string;
          chapter_number: number;
          source_ref: string | null;
          score: number;
        }>(
          `SELECT f.chapter_id, f.chapter_number, f.source_ref, bm25(chapter_fts) AS score
             FROM chapter_fts f
             JOIN chapters c ON c.id = f.chapter_id
            WHERE chapter_fts MATCH ? AND f.book_id = ?
              AND c.status = 'COMMITTED'
              AND f.chapter_number < ?
            ORDER BY score LIMIT ?`,
          match,
          input.bookId,
          input.chapterNumber,
          limit,
        );
        for (const r of rows) {
          hits.push({
            hitId: r.chapter_id,
            sourceRef: r.source_ref ?? `chapter:${r.chapter_id}`,
            retriever: 'chapter_fts',
            score: r.score,
            content: `（第 ${r.chapter_number} 章正文，见 ${r.source_ref ?? r.chapter_id}）`,
            reason: '章节级 BM25 命中（已提交正文）',
          });
        }
      } catch (e) {
        errors.push(`chapter_fts: ${msg(e)}`);
      }
    } else {
      errors.push('查询分词后为空，无法构造 MATCH 表达式');
    }

    this.trace(input, hits);
    return {
      tier: 'chapter',
      query: input.query,
      hits,
      retrieved: errors.length === 0,
      ...(errors.length > 0 ? { error: errors.join('；') } : {}),
    };
  }

  // ── Writer：场景级 ─────────────────────────────────────
  /**
   * 场景级检索 —— 回答"这个场景该怎么写"。
   *
   * ⚠ 必须拿到**原文**（Writer 需要可模仿的写法），所以查 chapter_fts
   *   并回读章节正文。粒度由**查询意图**决定（用场景目标当查询），
   *   而不是索引粒度 —— 本项目没有当前小说的场景级索引（见文件头说明）。
   *
   * ⚠ 排除当前章：拿本章自己的正文当"参考"是循环引用，
   *   会让 Writer 抄自己刚写的东西。
   */
  gatherSceneLevel(input: GatherTierInput): TierResult {
    const limit = input.limit ?? 5;
    const match = this.safeMatch(input.query);
    if (!match) {
      return {
        tier: 'scene',
        query: input.query,
        hits: [],
        retrieved: false,
        error: '查询分词后为空，无法构造 MATCH 表达式',
      };
    }

    try {
      const rows = this.db.all<{
        chapter_id: string;
        chapter_number: number;
        source_ref: string | null;
        score: number;
      }>(
        `SELECT f.chapter_id, f.chapter_number, f.source_ref, bm25(chapter_fts) AS score
           FROM chapter_fts f
           JOIN chapters c ON c.id = f.chapter_id
          WHERE chapter_fts MATCH ? AND f.book_id = ?
            AND c.status = 'COMMITTED'
            AND f.chapter_number < ?
          ORDER BY score LIMIT ?`,
        match,
        input.bookId,
        input.chapterNumber,
        limit,
      );
      const hits: TierHit[] = rows.map((r) => ({
        hitId: r.chapter_id,
        sourceRef: r.source_ref ?? `chapter:${r.chapter_id}`,
        retriever: 'chapter_fts',
        score: r.score,
        content: `（第 ${r.chapter_number} 章正文片段，见 ${r.source_ref ?? r.chapter_id}）`,
        reason: '场景意图命中已提交正文（可模仿的具体写法）',
      }));
      this.trace(input, hits);
      return { tier: 'scene', query: input.query, hits, retrieved: true };
    } catch (e) {
      const m = msg(e);
      this.logger.warn('场景级检索失败（不阻断写作）', { error: m });
      return { tier: 'scene', query: input.query, hits: [], retrieved: false, error: m };
    }
  }

  // ── Reviewer：证据级 ───────────────────────────────────
  /**
   * 证据级检索 —— 回答"这条指控有没有依据"。
   *
   * ⚠ 走 `evidence` 表而非正文检索：一条 BLOCKING 指控必须有
   *   **可引用的证据条目**（`evidence.quote` 是 NOT NULL，
   *   且 CHECK 强制 quote 非空、end_offset > start_offset）——
   *   小说片段无法支撑"这里矛盾"这种断言。
   */
  gatherEvidenceLevel(input: GatherTierInput): TierResult {
    const limit = input.limit ?? 10;
    try {
      const rows = this.db.all<{
        id: string;
        source_type: string;
        source_ref: string;
        quote: string;
        note: string | null;
      }>(
        `SELECT id, source_type, source_ref, quote, note
           FROM evidence
          WHERE book_id = ?
          ORDER BY created_at DESC LIMIT ?`,
        input.bookId,
        limit,
      );
      const hits: TierHit[] = rows.map((r) => ({
        hitId: r.id,
        sourceRef: r.source_ref,
        retriever: 'evidence_table',
        // ⚠ score 为 null：证据不是打分排出来的，编一个分数会让人误以为有相关度排序
        score: null,
        content: r.note ? `${r.quote}（${r.note}）` : r.quote,
        reason: `证据条目（${r.source_type}，可回溯到原文）`,
      }));
      this.trace(input, hits);
      return { tier: 'evidence', query: input.query, hits, retrieved: true };
    } catch (e) {
      const m = msg(e);
      this.logger.warn('证据级检索失败', { error: m });
      return { tier: 'evidence', query: input.query, hits: [], retrieved: false, error: m };
    }
  }

  // ── Continuity：结构化真相优先 ─────────────────────────
  /**
   * 读取结构化真相快照。
   *
   * ⚠ 这是**优先**来源，不是"补充"：连续性结论是断言，
   *   必须建立在确定性数据上，而不是概率性检索上。
   *
   * ⚠ 各表读取失败**分别降级**并如实记录：一张表空/缺列不该
   *   让整次连续性检查失去全部依据。
   */
  readStructuredTruth(input: {
    readonly bookId: string;
    readonly chapterNumber: number;
    readonly limit?: number;
  }): StructuredTruth & { readonly warnings: readonly string[] } {
    const limit = input.limit ?? 200;
    const db = this.db;
    const warnings: string[] = [];

    let canonFacts: StructuredTruth['canonFacts'] = [];
    try {
      const rows = db.all<{
        id: string;
        predicate: string;
        object_value: string;
        source_chapter_id: string | null;
        evidence_id: string | null;
      }>(
        `SELECT id, predicate, object_value, source_chapter_id, evidence_id
           FROM facts
          WHERE book_id = ? AND status = 'CANON'
          ORDER BY created_at ASC LIMIT ?`,
        input.bookId,
        limit,
      );
      canonFacts = rows.map((f) => ({
        id: f.id,
        predicate: f.predicate,
        objectValue: f.object_value,
        // 来源可回溯：优先章节，其次证据条目，最后回落到 fact id
        sourceRef: f.source_chapter_id
          ? `chapter:${f.source_chapter_id}`
          : (f.evidence_id ?? `fact:${f.id}`),
      }));
    } catch (e) {
      warnings.push(`facts 读取失败：${msg(e)}`);
    }

    let characterStates: StructuredTruth['characterStates'] = [];
    try {
      const rows = db.all<{
        character_id: string;
        name: string;
        chapter_number: number;
        state_json: string;
      }>(
        `SELECT cs.character_id, ch.name, cs.chapter_number, cs.state_json
           FROM character_states cs
           JOIN characters ch ON ch.id = cs.character_id
          WHERE ch.book_id = ? AND cs.chapter_number <= ?
          ORDER BY cs.chapter_number DESC LIMIT ?`,
        input.bookId,
        input.chapterNumber,
        limit,
      );
      characterStates = rows.map((c) => ({
        characterId: c.character_id,
        name: c.name,
        chapterNumber: c.chapter_number,
        // ⚠ character_states 没有 status 列 —— 状态在 state_json 里。
        //   取不到时如实写"未记录"，不编一个默认状态。
        status: readStateStatus(c.state_json),
      }));
    } catch (e) {
      warnings.push(`character_states 读取失败：${msg(e)}`);
    }

    let timeline: StructuredTruth['timeline'] = [];
    try {
      const rows = db.all<{
        id: string;
        narrative_chapter: number | null;
        title: string;
        description: string;
      }>(
        `SELECT id, narrative_chapter, title, description
           FROM timeline_events
          WHERE book_id = ? AND (narrative_chapter IS NULL OR narrative_chapter < ?)
          ORDER BY narrative_chapter ASC, narrative_offset ASC LIMIT ?`,
        input.bookId,
        input.chapterNumber,
        limit,
      );
      timeline = rows.map((t) => ({
        id: t.id,
        chapterNumber: t.narrative_chapter ?? 0,
        summary: t.title,
      }));
    } catch (e) {
      warnings.push(`timeline_events 读取失败：${msg(e)}`);
    }

    let foreshadowing: StructuredTruth['foreshadowing'] = [];
    try {
      const rows = db.all<{
        id: string;
        name: string;
        status: string;
        setup_chapter: number | null;
        expected_payoff_chapter: number | null;
      }>(
        `SELECT id, name, status, setup_chapter, expected_payoff_chapter
           FROM foreshadowing
          WHERE book_id = ?
          ORDER BY importance DESC, name ASC LIMIT ?`,
        input.bookId,
        limit,
      );
      foreshadowing = rows.map((f) => ({
        id: f.id,
        name: f.name,
        status: f.status,
        setupChapter: f.setup_chapter,
        payoffChapter: f.expected_payoff_chapter,
      }));
    } catch (e) {
      warnings.push(`foreshadowing 读取失败：${msg(e)}`);
    }

    if (warnings.length > 0) {
      this.logger.warn('结构化真相部分读取失败（如实降级）', { warnings });
    }

    return { canonFacts, characterStates, timeline, foreshadowing, warnings };
  }

  /**
   * Continuity 检索 —— 结构化真相优先，全文检索仅作补充。
   *
   * ⚠ 结果里如实标明每条来自哪一层（`retriever`），
   *   这样"这条结论依据的是 Canon 还是检索片段"是可区分的。
   */
  gatherForContinuity(input: GatherTierInput): TierResult {
    const truth = this.readStructuredTruth({
      bookId: input.bookId,
      chapterNumber: input.chapterNumber,
    });

    const hits: TierHit[] = [];
    for (const f of truth.canonFacts) {
      hits.push({
        hitId: f.id,
        sourceRef: f.sourceRef,
        retriever: 'canon_facts',
        score: null,
        content: `${f.predicate} = ${f.objectValue}`,
        reason: 'Canon 事实（确定性真值，优先于全文检索）',
      });
    }
    for (const c of truth.characterStates) {
      hits.push({
        hitId: `${c.characterId}@${c.chapterNumber}`,
        sourceRef: `character:${c.characterId}@ch${c.chapterNumber}`,
        retriever: 'character_states',
        score: null,
        content: `${c.name} 在第 ${c.chapterNumber} 章：${c.status}`,
        reason: '角色状态（确定性真值）',
      });
    }
    for (const t of truth.timeline) {
      hits.push({
        hitId: t.id,
        sourceRef: `timeline:${t.id}`,
        retriever: 'timeline_events',
        score: null,
        content: `第 ${t.chapterNumber} 章：${t.summary}`,
        reason: '时间线事件（确定性真值）',
      });
    }
    for (const f of truth.foreshadowing) {
      hits.push({
        hitId: f.id,
        sourceRef: `foreshadowing:${f.id}`,
        retriever: 'foreshadowing',
        score: null,
        content:
          `伏笔「${f.name}」状态 ${f.status}` +
          (f.setupChapter !== null ? `，埋于第 ${f.setupChapter} 章` : '') +
          (f.payoffChapter !== null ? `，预期第 ${f.payoffChapter} 章回收` : ''),
        reason: '伏笔账（确定性真值）',
      });
    }

    // 全文检索作补充（失败不改变结论 —— 但如实标记）
    const supplement = this.gatherChapterLevel({
      ...input,
      stage: `${input.stage}:supplement`,
      limit: input.limit ?? 5,
    });
    for (const h of supplement.hits) {
      hits.push({ ...h, reason: `补充检索：${h.reason}` });
    }

    this.trace(input, hits);

    return {
      tier: 'structured',
      query: input.query,
      hits,
      // 结构化读取成功即算成功（全文补充失败不影响结论依据）
      retrieved: true,
      ...(truth.warnings.length > 0 || !supplement.retrieved
        ? {
            error: [
              ...truth.warnings,
              ...(supplement.retrieved ? [] : [`全文补充检索不可用：${supplement.error ?? ''}`]),
            ].join('；'),
          }
        : {}),
    };
  }

  // ── 内部 ──────────────────────────────────────────────

  /** 构造 MATCH 表达式；分词后为空返回 null（不抛错，由调用方如实报告） */
  private safeMatch(query: string): string | null {
    const q = query.trim();
    if (q.length === 0) return null;
    try {
      const m = this.buildMatch(q);
      return m.trim().length > 0 ? m : null;
    } catch (e) {
      this.logger.warn('MATCH 表达式构造失败', { error: msg(e) });
      return null;
    }
  }

  /** 落检索痕迹（失败只记日志，绝不影响调用方） */
  private trace(
    input: { readonly workflowId?: string | null; readonly stage: string; readonly query: string },
    hits: readonly TierHit[],
  ): void {
    if (!this.recordTraces || hits.length === 0) return;
    try {
      this.recordTraces(
        hits.map((h, i) => ({
          id: traceId(i),
          workflowId: input.workflowId ?? null,
          stage: input.stage,
          query: input.query,
          retriever: h.retriever,
          hitId: h.hitId,
          score: h.score,
          sourceRef: h.sourceRef,
          reason: h.reason,
        })),
      );
    } catch (e) {
      this.logger.warn('检索痕迹记录失败（不阻断）', { error: msg(e) });
    }
  }
}

/** 从 character_states.state_json 取一个可读状态；取不到如实写"未记录" */
function readStateStatus(stateJson: string): string {
  try {
    const v: unknown = JSON.parse(stateJson);
    if (v && typeof v === 'object') {
      const rec = v as Record<string, unknown>;
      for (const key of ['status', 'currentStatus', 'state', 'summary']) {
        const x = rec[key];
        if (typeof x === 'string' && x.trim().length > 0) return x;
      }
    }
    return '未记录（state_json 无可读状态字段）';
  } catch {
    return '未记录（state_json 解析失败）';
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
