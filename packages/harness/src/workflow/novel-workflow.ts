/**
 * Novel Workflow —— 12 个 stage 的组装（P0-1）
 *
 * ## 为什么 stage 用「注入服务」而不是直接 import 各模块
 *
 * 提示词 §三 要求：
 *
 *   UI → NovelWorkflow → WorkflowEngine → Harness → Planner/Writer/...
 *
 * 如果本文件直接 `import { Writer } from '@nwa/writing'`，会立刻出现两个问题：
 *
 *   1. **依赖方向反了**：harness 是被依赖的底座，让它去依赖 writing/story
 *      会把包依赖图变成环（writing 已经依赖 harness 的 ContextEngine）。
 *   2. **业务细节渗进编排层**：stage 里一旦出现"技能库不存在就跳过"这类
 *      业务判断，编排层就开始长业务逻辑，最后变成第二个 core-process。
 *
 * 所以 stage 只声明"我需要一个 planChapter 能力"，由**应用层**注入实现。
 * 这样：
 *   - 依赖方向正确（应用层知道所有模块，harness 不知道）
 *   - 每个 stage 都是薄适配器，业务逻辑仍在原模块里
 *   - 测试可以注入假实现，不碰模型
 *
 * ## 每个 stage 的输入输出契约
 *
 * stage 之间通过 `ctx.outputs[上游stage]` 传递**结构化结果**（§二十一），
 * 不传长字符串、不传内存对象引用 —— 后者在进程重启后无法重建。
 */
import { AppError, ErrorCode, Logger } from '@nwa/core';
import type {
  StageContext,
  StageId,
  StageInput,
  WorkflowStageResult,
  WorkflowStage,
} from './workflow-types.js';

/**
 * 应用层注入的服务集合。
 *
 * 每个方法对应原 IPC handler 的核心逻辑（不含 IPC 参数解析）。
 * 返回值必须是**结构化**的（§二十一），便于下游读取与 UI 展示。
 */
export interface NovelWorkflowServices {
  /** 确保章节存在（不存在则创建），返回 chapterId 与章号 */
  readonly ensureChapter: (input: {
    chapterId: string | null;
    chapterNumber: number | null;
    params: Record<string, unknown>;
  }) => Promise<{ chapterId: string; chapterNumber: number }>;

  /**
   * 装配上下文（§二十八 Context Engine 的调用点）。
   *
   * ⚠ 检索策略由 **stage** 决定，不由 ContextEngine 自己猜（§二十三）。
   *   本 stage 负责声明"要什么"，engine 只负责装配与压缩。
   */
  readonly buildContext: (input: {
    chapterId: string;
    chapterNumber: number;
    params: Record<string, unknown>;
    /**
     * ⚠ 必须传：检索痕迹要落 `workflow_id`，否则痕迹的 workflow_id 是 NULL，
     *   按 workflowId 查就查不到 —— 实测现象是"痕迹表里有数据但查出来 0 条"，
     *   看起来像没写，其实写了只是挂错了归属。
     */
    workflowId: string;
  }) => Promise<{
    /** 上下文包摘要（供 UI 与追溯） */
    contextSummary: Record<string, unknown>;
    /** ⚠ 检索轨迹（§五）：让"为什么引用这个旧章节"可回答 */
    retrievalTrace: readonly {
      query: string;
      retriever: string;
      hitId: string;
      score: number | null;
      sourceRef: string | null;
      reason: string | null;
    }[];
    /**
     * 各检索层的执行状态（P0-3）。
     *
     * ⚠ `retrieved: false` 表示**检索层不可用**，不是"没有相关记忆" ——
     *   两者混淆会让模型以为"史上没发生过相关的事"从而自行编造。
     *   所以必须如实带出来，让 UI/日志能区分。
     */
    retrievalTiers: readonly {
      tier: string;
      stage: string;
      retrieved: boolean;
      hitCount: number;
      error: string | null;
    }[];
  }>;

  readonly plan: (input: {
    chapterId: string;
    chapterNumber: number;
    params: Record<string, unknown>;
  }) => Promise<{ planPath: string; sceneCount: number; contentHash: string }>;

  /** 校验计划是否可执行（§三 PLAN_VERIFY） */
  readonly planVerify: (input: {
    chapterId: string;
    chapterNumber: number;
  }) => Promise<{ ok: boolean; problems: readonly string[] }>;

  readonly write: (input: {
    chapterId: string;
    chapterNumber: number;
    params: Record<string, unknown>;
  }) => Promise<{
    draftPath: string;
    contentHash: string;
    wordCount: number;
    sceneCount: number;
    /** ⚠ 模型的自述偏离，必须与正文分开（P1 修复项） */
    deviations: readonly string[];
  }>;

  readonly review: (input: {
    chapterId: string;
    chapterNumber: number;
    params: Record<string, unknown>;
  }) => Promise<{
    reportPath: string;
    contentHash: string;
    /** BLOCKING 问题数 —— 决定能否进入 Continuity（§33） */
    blockingCount: number;
    issueCount: number;
  }>;

  readonly revision: (input: {
    chapterId: string;
    chapterNumber: number;
    params: Record<string, unknown>;
  }) => Promise<{
    revisionPath: string;
    contentHash: string;
    applied: number;
    needsRegeneration: boolean;
  }>;

  readonly continuity: (input: {
    chapterId: string;
    chapterNumber: number;
  }) => Promise<{
    reportPath: string;
    contentHash: string;
    blockingCount: number;
    /**
     * ⚠ 检查依据的**来源清单**（P0-3）—— 每条标明来自哪一层
     *   （canon_facts / character_states / timeline_events / foreshadowing /
     *   chapter_fts）。空数组会让人以为"什么都没对照"，
     *   所以必须如实填。
     */
    checkedAgainst: readonly string[];
    /** 结构化真值读取失败的项（如实降级，不静默） */
    structuredWarnings: readonly string[];
  }>;

  /** 状态结算（P0-4）：正文 → 状态提议 → 验证 */
  readonly settleState: (input: {
    chapterId: string;
    chapterNumber: number;
    /** ⚠ 提议要挂到工作流上，便于"这次结算属于哪次运行"可回答 */
    workflowId: string;
  }) => Promise<{
    proposalId: string | null;
    verified: boolean;
    factCount: number;
    characterStateCount: number;
    timelineEventCount: number;
    foreshadowingCount: number;
    rejected: readonly string[];
  }>;

  /** Commit 前置门禁汇总（§十二 summary approval、§33 无 BLOCKING） */
  readonly readyToCommit: (input: {
    chapterId: string;
    chapterNumber: number;
  }) => Promise<{ ok: boolean; missing: readonly string[] }>;

  readonly commit: (input: {
    chapterId: string;
    chapterNumber: number;
    params: Record<string, unknown>;
  }) => Promise<{
    manifestPath: string;
    contentHash: string;
    committed: boolean;
  }>;

  readonly verifyCommit: (input: {
    chapterId: string;
    chapterNumber: number;
  }) => Promise<{ ok: boolean; problems: readonly string[] }>;
}

/** 便捷：从 ctx.outputs 取上游结构化输出（缺失即报错，不静默用默认值） */
function upstream<T>(ctx: StageContext, stage: StageId, field: string): T {
  const rec = ctx.outputs[stage] as Record<string, unknown> | undefined;
  if (!rec || !(field in rec)) {
    throw new AppError(
      ErrorCode.TOOL_VALIDATION_ERROR,
      `上游 stage「${stage}」缺少输出字段「${field}」—— 工作流顺序被破坏`,
    );
  }
  return rec[field] as T;
}

function needChapterId(ctx: StageContext): string {
  if (!ctx.chapterId) {
    throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '工作流缺少 chapterId');
  }
  return ctx.chapterId;
}

function needChapterNumber(ctx: StageContext): number {
  if (ctx.chapterNumber === null || ctx.chapterNumber === undefined) {
    throw new AppError(ErrorCode.TOOL_VALIDATION_ERROR, '工作流缺少 chapterNumber');
  }
  return ctx.chapterNumber;
}

/**
 * 用注入的服务构造 12 个 stage。
 *
 * ⚠ 顺序不在这里定义 —— 权威顺序是 `STAGE_ORDER`（workflow-types.ts）。
 *   这里只提供实现，顺序由引擎按 `STAGE_ORDER` 驱动。
 */
export function createNovelWorkflowStages(
  services: NovelWorkflowServices,
  logger?: Logger,
): WorkflowStage[] {
  const log = logger ?? new Logger('harness:novel-stages');

  return [
    // ── 1. 创建/确认章节 ──
    {
      id: 'create_chapter',
      async run(input: StageInput, ctx: StageContext): Promise<WorkflowStageResult> {
        const r = await services.ensureChapter({
          chapterId: input.chapterId,
          chapterNumber: input.chapterNumber,
          params: input.params,
        });
        // ⚠ 必须把章节写回工作流，否则下游 stage 读到的还是 NULL
        ctx.setChapter(r.chapterId, r.chapterNumber);
        ctx.emit('STAGE_STARTED', { stage: 'create_chapter', chapterId: r.chapterId });
        return { ok: true, output: { chapterId: r.chapterId, chapterNumber: r.chapterNumber } };
      },
    },

    // ── 2. 装配上下文（§二十三：检索策略由 stage 决定）──
    {
      id: 'build_context',
      async run(input: StageInput, ctx: StageContext): Promise<WorkflowStageResult> {
        const chapterId = needChapterId(ctx);
        const chapterNumber = needChapterNumber(ctx);
        const r = await services.buildContext({
          chapterId,
          chapterNumber,
          params: input.params,
          workflowId: ctx.workflowId,
        });
        ctx.emit('CONTEXT_BUILT', {
          stage: 'build_context',
          hits: r.retrievalTrace.length,
        });
        log.info('上下文已装配', { chapterNumber, hits: r.retrievalTrace.length });
        // ⚠ 检索层不可用必须**如实暴露**（不是"没有相关记忆"）——
        //   两者混淆会让模型以为"史上没发生过相关的事"从而自行编造。
        const degraded = r.retrievalTiers.filter((t) => !t.retrieved);
        if (degraded.length > 0) {
          log.warn('部分检索层不可用（上下文将缺少对应来源）', {
            chapterNumber,
            degraded: degraded.map((t) => `${t.stage}:${t.error ?? '未知原因'}`),
          });
        }
        return {
          ok: true,
          output: {
            contextSummary: r.contextSummary,
            retrievalTrace: r.retrievalTrace,
            retrievalTiers: r.retrievalTiers,
            retrievalDegraded: degraded.length,
          },
        };
      },
    },

    // ── 3. 规划 ──
    {
      id: 'plan',
      async run(input: StageInput, ctx: StageContext): Promise<WorkflowStageResult> {
        const chapterId = needChapterId(ctx);
        const chapterNumber = needChapterNumber(ctx);
        const r = await services.plan({ chapterId, chapterNumber, params: input.params });
        ctx.emit('PLAN_CREATED', { stage: 'plan', sceneCount: r.sceneCount });
        ctx.recordArtifact({ type: 'plan', path: r.planPath, contentHash: r.contentHash });
        return {
          ok: true,
          output: { planPath: r.planPath, sceneCount: r.sceneCount },
          artifacts: [{ type: 'plan', path: r.planPath, contentHash: r.contentHash }],
        };
      },
    },

    // ── 4. 校验计划 ──
    //
    // ⚠ 计划不合格必须**停在这里**，不能让 Writer 去写一个自相矛盾的计划 ——
    //   那会烧掉最贵的一段额度去产出注定要重写的东西。
    {
      id: 'plan_verify',
      async run(_input: StageInput, ctx: StageContext): Promise<WorkflowStageResult> {
        const chapterId = needChapterId(ctx);
        const chapterNumber = needChapterNumber(ctx);
        const r = await services.planVerify({ chapterId, chapterNumber });
        if (!r.ok) {
          return {
            ok: false,
            error: `计划校验未通过：${r.problems.join('；')}`,
            output: { problems: r.problems },
          };
        }
        return { ok: true, output: { problems: [] } };
      },
    },

    // ── 5. 写正文 ──
    {
      id: 'write',
      async run(input: StageInput, ctx: StageContext): Promise<WorkflowStageResult> {
        const chapterId = needChapterId(ctx);
        const chapterNumber = needChapterNumber(ctx);
        const r = await services.write({ chapterId, chapterNumber, params: input.params });
        ctx.emit('DRAFT_CREATED', {
          stage: 'write',
          wordCount: r.wordCount,
          sceneCount: r.sceneCount,
        });
        ctx.recordArtifact({ type: 'draft', path: r.draftPath, contentHash: r.contentHash });

        // ⚠ deviation 单独记，**不进正文**（提示词 §十一）
        if (r.deviations.length > 0) {
          log.warn('模型自述了偏离，已与正文分离', {
            chapterNumber,
            count: r.deviations.length,
          });
        }

        return {
          ok: true,
          output: {
            draftPath: r.draftPath,
            wordCount: r.wordCount,
            sceneCount: r.sceneCount,
            deviations: r.deviations,
          },
          artifacts: [{ type: 'draft', path: r.draftPath, contentHash: r.contentHash }],
        };
      },
    },

    // ── 6. 审查 ──
    {
      id: 'review',
      async run(input: StageInput, ctx: StageContext): Promise<WorkflowStageResult> {
        const chapterId = needChapterId(ctx);
        const chapterNumber = needChapterNumber(ctx);
        const r = await services.review({ chapterId, chapterNumber, params: input.params });
        ctx.emit('REVIEW_COMPLETED', {
          stage: 'review',
          blocking: r.blockingCount,
          issues: r.issueCount,
        });
        ctx.recordArtifact({ type: 'review', path: r.reportPath, contentHash: r.contentHash });
        return {
          ok: true,
          output: {
            reportPath: r.reportPath,
            blockingCount: r.blockingCount,
            issueCount: r.issueCount,
          },
          artifacts: [{ type: 'review', path: r.reportPath, contentHash: r.contentHash }],
        };
      },
    },

    // ── 7. 改稿 ──
    {
      id: 'revision',
      async run(input: StageInput, ctx: StageContext): Promise<WorkflowStageResult> {
        const chapterId = needChapterId(ctx);
        const chapterNumber = needChapterNumber(ctx);
        const blocking = upstream<number>(ctx, 'review', 'blockingCount');

        // ⚠ 没有 BLOCKING 问题就不改稿 —— 省一次昂贵的 LLM 调用。
        //   标 SKIPPED 而不是 DONE：语义上"这一步没做事"，
        //   恢复时仍会被当作已完成而跳过（这正是我们要的）。
        if (blocking === 0) {
          return { ok: true, skipped: true, output: { reason: '无 BLOCKING 问题，跳过改稿' } };
        }

        const r = await services.revision({ chapterId, chapterNumber, params: input.params });
        ctx.emit('REVISION_CREATED', { stage: 'revision', applied: r.applied });
        ctx.recordArtifact({
          type: 'revision',
          path: r.revisionPath,
          contentHash: r.contentHash,
        });
        return {
          ok: true,
          output: {
            revisionPath: r.revisionPath,
            applied: r.applied,
            needsRegeneration: r.needsRegeneration,
          },
          artifacts: [{ type: 'revision', path: r.revisionPath, contentHash: r.contentHash }],
        };
      },
    },

    // ── 8. 连续性检查 ──
    {
      id: 'continuity',
      async run(_input: StageInput, ctx: StageContext): Promise<WorkflowStageResult> {
        const chapterId = needChapterId(ctx);
        const chapterNumber = needChapterNumber(ctx);
        const r = await services.continuity({ chapterId, chapterNumber });
        ctx.emit('CONTINUITY_COMPLETED', {
          stage: 'continuity',
          blocking: r.blockingCount,
        });
        ctx.recordArtifact({
          type: 'continuity',
          path: r.reportPath,
          contentHash: r.contentHash,
        });
        // ⚠ checkedAgainst 为空会让人以为"什么都没对照" —— 结构化真值读取
        //   失败必须显式暴露（如实降级，不静默）。
        if (r.structuredWarnings.length > 0) {
          log.warn('结构化真值部分读取失败（连续性检查依据不完整）', {
            chapterNumber,
            warnings: r.structuredWarnings,
          });
        }
        return {
          ok: true,
          output: {
            reportPath: r.reportPath,
            blockingCount: r.blockingCount,
            checkedAgainst: r.checkedAgainst,
            structuredWarnings: r.structuredWarnings,
          },
          artifacts: [{ type: 'continuity', path: r.reportPath, contentHash: r.contentHash }],
        };
      },
    },

    // ── 9. 状态结算（P0-4）──
    //
    // ⚠ 硬约束：未 VERIFIED 的提议不得进入 Canon。这里把 verified 落进
    //   输出，让 ready_to_commit 能据此拦截。
    {
      id: 'state_settlement',
      async run(_input: StageInput, ctx: StageContext): Promise<WorkflowStageResult> {
        const chapterId = needChapterId(ctx);
        const chapterNumber = needChapterNumber(ctx);
        const r = await services.settleState({
          chapterId,
          chapterNumber,
          workflowId: ctx.workflowId,
        });
        if (r.proposalId) {
          ctx.emit('STATE_PROPOSED', { stage: 'state_settlement', proposalId: r.proposalId });
        }
        return {
          ok: true,
          output: {
            proposalId: r.proposalId,
            verified: r.verified,
            factCount: r.factCount,
            characterStateCount: r.characterStateCount,
            timelineEventCount: r.timelineEventCount,
            foreshadowingCount: r.foreshadowingCount,
            rejected: r.rejected,
          },
        };
      },
    },

    // ── 10. Commit 前置门禁 ──
    {
      id: 'ready_to_commit',
      async run(_input: StageInput, ctx: StageContext): Promise<WorkflowStageResult> {
        const chapterId = needChapterId(ctx);
        const chapterNumber = needChapterNumber(ctx);
        const r = await services.readyToCommit({ chapterId, chapterNumber });
        if (!r.ok) {
          // 这里是**门禁**：不满足就不允许 Commit（§十二 / §33）
          return {
            ok: false,
            error: `Commit 前置条件未满足：${r.missing.join('；')}`,
            output: { missing: r.missing },
          };
        }
        return { ok: true, output: { missing: [] } };
      },
    },

    // ── 11. 原子提交 ──
    {
      id: 'commit',
      async run(input: StageInput, ctx: StageContext): Promise<WorkflowStageResult> {
        const chapterId = needChapterId(ctx);
        const chapterNumber = needChapterNumber(ctx);
        const r = await services.commit({ chapterId, chapterNumber, params: input.params });
        ctx.emit('COMMIT_COMPLETED', { stage: 'commit', committed: r.committed });
        ctx.recordArtifact({
          type: 'commit_manifest',
          path: r.manifestPath,
          contentHash: r.contentHash,
        });
        return {
          ok: true,
          output: { manifestPath: r.manifestPath, committed: r.committed },
          artifacts: [
            { type: 'commit_manifest', path: r.manifestPath, contentHash: r.contentHash },
          ],
        };
      },
    },

    // ── 12. 提交后校验 ──
    {
      id: 'verify',
      async run(_input: StageInput, ctx: StageContext): Promise<WorkflowStageResult> {
        const chapterId = needChapterId(ctx);
        const chapterNumber = needChapterNumber(ctx);
        const r = await services.verifyCommit({ chapterId, chapterNumber });
        if (!r.ok) {
          return {
            ok: false,
            error: `提交校验未通过：${r.problems.join('；')}`,
            output: { problems: r.problems },
          };
        }
        return { ok: true, output: { problems: [] } };
      },
    },
  ];
}
