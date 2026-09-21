/**
 * Canon 工具（施工文档 §10.8 / STEP 9）
 *
 * 权限分级刻意做了区分：
 *   fact.add        PROPOSE_WRITE —— 只写 PROVISIONAL，不碰 Canon
 *   fact.promote    COMMIT        —— 提升为 CANON 是不可逆的权威操作
 *   fact.search/get READ
 *
 * 为什么 promote 要 COMMIT 级而非 WRITE：
 *   Canon 是长篇的事实基准，一旦写错会污染后面所有章节的对账。
 *   提高权限门槛意味着普通写作流程（Writer / Planner）无法提升 Canon，
 *   必须由显式的提交动作触发。
 */
import { z } from 'zod';
import { AppError, ErrorCode, factId, evidenceId } from '@nwa/core';
import { FactStatus } from '@nwa/shared';
import type { AnyToolDefinition, ToolDefinition } from '@nwa/shared';
import type { Repositories } from '@nwa/storage';

export function createFactTools(
  repos: Repositories,
  opts: { readonly resolveBookId: () => string },
): AnyToolDefinition[] {
  const factAdd: ToolDefinition<
    {
      subjectType: string;
      subjectId: string;
      predicate: string;
      objectValue: string;
      confidence: number;
      evidenceId: string;
    },
    { factId: string; status: string; created: boolean }
  > = {
    name: 'fact.add',
    description:
      '写入一条待验证事实（PROVISIONAL）。**不会**成为 Canon —— 提升需经 fact.promote。',
    inputSchema: z.object({
      subjectType: z.enum(['CHARACTER', 'WORLD', 'ITEM']),
      subjectId: z.string().min(1),
      predicate: z.string().min(1),
      objectValue: z.string().min(1),
      confidence: z.number().min(0).max(1),
      /** ⚠ 必填：没有证据的事实不得入库（研究报告 R4） */
      evidenceId: z.string().min(1),
    }),
    outputSchema: z.object({
      factId: z.string(),
      status: z.string(),
      created: z.boolean(),
    }),
    permission: 'PROPOSE_WRITE',
    errorCodes: [
      ErrorCode.TOOL_VALIDATION_ERROR,
      ErrorCode.EVIDENCE_NOT_FOUND,
      ErrorCode.STORAGE_QUERY_FAILED,
    ],
    execute: (input) => {
      // 证据必须真实存在 —— 否则"可回溯"是空话
      const ev = repos.evidence.find(input.evidenceId);
      if (!ev) {
        throw new AppError(
          ErrorCode.EVIDENCE_NOT_FOUND,
          `证据不存在，拒绝写入事实：${input.evidenceId}`,
          { details: { evidenceId: input.evidenceId } },
        );
      }

      const before = repos.facts.find(
        input.subjectType,
        input.subjectId,
        input.predicate,
        input.objectValue,
      );

      const row = repos.facts.propose({
        id: factIdOf(input),
        bookId: opts.resolveBookId(),
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        predicate: input.predicate,
        objectValue: input.objectValue,
        confidence: input.confidence,
        sourceChapterId: null,
        evidenceId: input.evidenceId,
      });

      return { factId: row.id, status: row.status, created: before === undefined };
    },
  };

  /**
   * 提升为 CANON。
   *
   * ⚠ 权限 COMMIT —— 这是少数不可逆操作之一。
   */
  const factPromote: ToolDefinition<
    { factId: string },
    { factId: string; status: string; promoted: true }
  > = {
    name: 'fact.promote',
    description: '把一条 PROVISIONAL 事实提升为 CANON。要求该事实已有可回溯证据。',
    inputSchema: z.object({ factId: z.string().min(1) }),
    outputSchema: z.object({
      factId: z.string(),
      status: z.string(),
      promoted: z.literal(true),
    }),
    permission: 'COMMIT',
    errorCodes: [
      ErrorCode.EVIDENCE_NOT_FOUND,
      ErrorCode.STORAGE_QUERY_FAILED,
      ErrorCode.COMMIT_FAILED,
    ],
    execute: ({ factId }) => {
      const row = repos.facts.promoteToCanon(factId);
      return { factId: row.id, status: row.status, promoted: true as const };
    },
  };

  const factGet: ToolDefinition<
    { factId: string },
    {
      factId: string;
      status: string;
      predicate: string;
      objectValue: string;
      evidenceId?: string;
      subjectId?: string;
    }
  > = {
    name: 'fact.get',
    description: '按 id 读取一条事实',
    inputSchema: z.object({ factId: z.string().min(1) }),
    outputSchema: z.object({
      factId: z.string(),
      status: z.string(),
      predicate: z.string(),
      objectValue: z.string(),
      evidenceId: z.string().optional(),
      subjectId: z.string().optional(),
    }),
    permission: 'READ',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
    execute: ({ factId }) => {
      const f = repos.facts.get(factId);
      return {
        factId: f.id,
        status: f.status,
        predicate: f.predicate,
        objectValue: f.object_value,
        ...(f.evidence_id ? { evidenceId: f.evidence_id } : {}),
        ...(f.subject_id ? { subjectId: f.subject_id } : {}),
      };
    },
  };

  const factSearch: ToolDefinition<
    { status?: string; subjectId?: string },
    {
      facts: readonly {
        factId: string;
        status: string;
        subjectId: string | null;
        predicate: string;
        objectValue: string;
        hasEvidence: boolean;
      }[];
    }
  > = {
    name: 'fact.search',
    description: '按状态或主体检索事实',
    inputSchema: z.object({
      status: FactStatus.optional(),
      subjectId: z.string().optional(),
    }),
    outputSchema: z.object({
      facts: z.array(
        z.object({
          factId: z.string(),
          status: z.string(),
          subjectId: z.string().nullable(),
          predicate: z.string(),
          objectValue: z.string(),
          hasEvidence: z.boolean(),
        }),
      ),
    }),
    permission: 'READ',
    errorCodes: [ErrorCode.STORAGE_QUERY_FAILED],
    execute: (input) => {
      const bookId = opts.resolveBookId();
      const rows =
        input.subjectId !== undefined
          ? repos.facts.listBySubject(bookId, 'CHARACTER', input.subjectId)
          : repos.facts.listByStatus(bookId, (input.status ?? 'CANON') as never);

      return {
        facts: rows.map((f) => ({
          factId: f.id,
          status: f.status,
          subjectId: f.subject_id,
          predicate: f.predicate,
          objectValue: f.object_value,
          hasEvidence: f.evidence_id !== null,
        })),
      };
    },
  };

  /** 证据写入（供抽取流程调用；同样要求引文可精确匹配） */
  const evidenceAdd: ToolDefinition<
    {
      sourceRef: string;
      quote: string;
      startOffset: number;
      endOffset: number;
      sourceText: string;
      note?: string;
    },
    { evidenceId: string; sourceRef: string }
  > = {
    name: 'evidence.add',
    description: '写入一条证据。quote 必须与 sourceText 的 [start, end) 区间精确匹配。',
    inputSchema: z.object({
      sourceRef: z.string().min(1),
      quote: z.string().min(1),
      startOffset: z.number().int().min(0),
      endOffset: z.number().int().min(0),
      sourceText: z.string(),
      note: z.string().optional(),
    }),
    outputSchema: z.object({ evidenceId: z.string(), sourceRef: z.string() }),
    permission: 'PROPOSE_WRITE',
    errorCodes: [ErrorCode.EVIDENCE_QUOTE_MISMATCH, ErrorCode.STORAGE_QUERY_FAILED],
    execute: (input) => {
      const ev = repos.evidence.create({
        id: evidenceIdOf(input),
        bookId: opts.resolveBookId(),
        sourceType: 'CHAPTER',
        sourceRef: input.sourceRef,
        quote: input.quote,
        startOffset: input.startOffset,
        endOffset: input.endOffset,
        note: input.note ?? null,
        sourceText: input.sourceText,
      });
      return { evidenceId: ev.id, sourceRef: ev.source_ref };
    },
  };

  const evidenceGet: ToolDefinition<
    { evidenceId: string },
    { evidenceId: string; sourceRef: string; quote: string; startOffset: number; endOffset: number }
  > = {
    name: 'evidence.get',
    description: '按 id 读取证据',
    inputSchema: z.object({ evidenceId: z.string().min(1) }),
    outputSchema: z.object({
      evidenceId: z.string(),
      sourceRef: z.string(),
      quote: z.string(),
      startOffset: z.number().int(),
      endOffset: z.number().int(),
    }),
    permission: 'READ',
    errorCodes: [ErrorCode.EVIDENCE_NOT_FOUND, ErrorCode.STORAGE_QUERY_FAILED],
    execute: ({ evidenceId }) => {
      const ev = repos.evidence.find(evidenceId);
      if (!ev) {
        throw new AppError(ErrorCode.EVIDENCE_NOT_FOUND, `证据不存在：${evidenceId}`, {
          details: { evidenceId },
        });
      }
      return {
        evidenceId: ev.id,
        sourceRef: ev.source_ref,
        quote: ev.quote,
        startOffset: ev.start_offset,
        endOffset: ev.end_offset,
      };
    },
  };

  return [factAdd, factPromote, factGet, factSearch, evidenceAdd, evidenceGet];
}

/**
 * ⚠ 必须复用 core 的 factId / evidenceId，**不要**自己写一份 hash。
 *
 * 我第一版内联了 FNV-1a，而 core 用的是 sha1 前 16 位 —— 同一事实会算出
 * **不同的 id**，于是"重复抽取不产生重复行"的幂等保证会静默失效。
 * 内容派生 id 的全部价值就在于"同输入同输出"，两处实现必然漂移。
 */
const factIdOf = factId;
const evidenceIdOf = evidenceId;
