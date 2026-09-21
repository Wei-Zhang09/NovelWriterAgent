/**
 * 章节状态机（施工文档 §8.1 / §8.2）
 *
 * §8.2 的核心约束：**状态迁移必须由代码执行**。
 *   模型只能提交 `{ action: 'request_transition', target, reason }`，
 *   由本模块校验后才真正迁移。
 *
 * 为什么这条重要（研究报告 §1.3 差异 4 / ACK-0006）：
 *   若允许模型直接改状态，那"验证"就退化成"模型自己说通过了"，
 *   而施工文档 §55 Rule 10 明确要求成功必须由
 *   tool result + artifact exists + schema valid + state valid 共同证明。
 */
import { AppError, ErrorCode } from '@nwa/core';
import type { ChapterStatus } from '@nwa/shared';

/**
 * 合法迁移表。
 *
 * 只列**正常路径**；异常态（PAUSED / FAILED / RETRYING / ROLLING_BACK）
 * 由单独的规则处理（见 ABNORMAL_TRANSITIONS）。
 */
const NORMAL_TRANSITIONS: Record<string, readonly ChapterStatus[]> = {
  DRAFT: ['PLANNING'],
  PLANNING: ['CONTEXT_READY'],
  CONTEXT_READY: ['WRITING'],
  WRITING: ['DRAFT_READY'],
  DRAFT_READY: ['REVIEWING'],
  REVIEWING: ['REVIEW_READY'],
  // 审稿完成 → 有待修订项则进 REVISING，否则直接进一致性检查
  REVIEW_READY: ['REVISING', 'CONTINUITY_CHECKING'],
  REVISING: ['REVISION_READY'],
  REVISION_READY: ['CONTINUITY_CHECKING'],
  CONTINUITY_CHECKING: ['READY_TO_COMMIT', 'REVISING'],
  READY_TO_COMMIT: ['COMMITTING'],
  COMMITTING: ['COMMITTED'],
  // 终态：允许回退到 PLANNING 表示"重开这一章"（人工操作）
  COMMITTED: ['PLANNING'],
};

/**
 * 异常态规则：
 *   任何状态 → PAUSED（暂停）
 *   任何非终态 → FAILED（失败）
 *   PAUSED → RESUMING → 回原状态（由 resume() 带 target 处理）
 *   FAILED / RETRYING / ROLLING_BACK → 由恢复流程驱动
 */
const ALWAYS_ALLOWED_TARGETS: readonly ChapterStatus[] = ['PAUSED', 'FAILED'];

/** 处于这些状态时禁止再接受新的迁移请求（需要人工介入） */
const TERMINAL_ABNORMAL: readonly ChapterStatus[] = ['FAILED', 'ROLLING_BACK'];

export interface TransitionRequest {
  readonly from: ChapterStatus;
  readonly to: ChapterStatus;
  /** 人类可读的迁移原因，会写入 run_events */
  readonly reason: string;
  /**
   * 前置条件是否已满足（产物存在 / schema 通过 / 无 blocking issue）。
   * 由调用方（WorkflowEngine）计算并传入 —— 状态机本身不查库。
   */
  readonly preconditionsMet?: boolean;
  /** 未满足的前置条件说明，用于报错信息 */
  readonly missingPreconditions?: readonly string[];
}

export interface TransitionDecision {
  readonly allowed: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly details?: unknown;
}

/**
 * 判断一次迁移是否被允许。**纯函数**，不产生副作用 —— 便于单测穷举。
 */
export function canTransition(req: TransitionRequest): TransitionDecision {
  const { from, to } = req;

  if (from === to) {
    return { allowed: false, code: 'NO_OP', message: `当前已是 ${from}` };
  }

  // 异常态优先：任何状态都可暂停/失败
  if (ALWAYS_ALLOWED_TARGETS.includes(to)) {
    if (TERMINAL_ABNORMAL.includes(from) && to === 'PAUSED') {
      return {
        allowed: false,
        code: ErrorCode.WORKSPACE_CORRUPTED,
        message: `状态 ${from} 需人工介入，不接受暂停`,
      };
    }
    return { allowed: true };
  }

  // 从异常态恢复：PAUSED → RESUMING 是唯一出口
  if (from === 'PAUSED') {
    if (to === 'RESUMING') return { allowed: true };
    return {
      allowed: false,
      code: ErrorCode.CONTINUITY_BLOCKED,
      message: `PAUSED 只能迁移到 RESUMING（收到 ${to}）`,
    };
  }
  if (from === 'RESUMING') {
    // RESUMING 由 resume() 决定回到哪个状态，这里放行"回到任何正常态"
    if (isNormalStatus(to)) return { allowed: true };
    return {
      allowed: false,
      code: ErrorCode.CONTINUITY_BLOCKED,
      message: `RESUMING 只能回到正常状态（收到 ${to}）`,
    };
  }
  if (from === 'RETRYING') {
    if (isNormalStatus(to) || to === 'FAILED') return { allowed: true };
    return { allowed: false, code: ErrorCode.CONTINUITY_BLOCKED, message: `RETRYING 的目标非法：${to}` };
  }
  if (TERMINAL_ABNORMAL.includes(from)) {
    return {
      allowed: false,
      code: ErrorCode.WORKSPACE_CORRUPTED,
      message: `状态 ${from} 是人工介入态，不接受自动迁移`,
    };
  }

  // 正常路径
  const allowed = NORMAL_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return {
      allowed: false,
      code: ErrorCode.CONTINUITY_BLOCKED,
      message: `非法状态迁移：${from} → ${to}`,
      details: { from, to, allowedFromHere: allowed },
    };
  }

  // 前置条件（只在明确传入 false 时拦截；未传表示调用方不关心）
  if (req.preconditionsMet === false) {
    return {
      allowed: false,
      code: ErrorCode.CONTINUITY_BLOCKED,
      message: `前置条件未满足，拒绝迁移 ${from} → ${to}`,
      details: { missing: req.missingPreconditions ?? [] },
    };
  }

  return { allowed: true };
}

/** 断言式接口：不允许时抛 AppError（带完整上下文） */
export function assertTransition(req: TransitionRequest): void {
  const d = canTransition(req);
  if (!d.allowed) {
    throw new AppError((d.code ?? ErrorCode.CONTINUITY_BLOCKED) as never, d.message ?? '状态迁移被拒', {
      details: { ...(d.details as object | undefined), from: req.from, to: req.to, reason: req.reason },
    });
  }
}

function isNormalStatus(s: ChapterStatus): boolean {
  return Object.prototype.hasOwnProperty.call(NORMAL_TRANSITIONS, s);
}

/** 列出某状态下所有合法目标（UI 用：只显示能点的按钮） */
export function allowedTargets(from: ChapterStatus): readonly ChapterStatus[] {
  if (from === 'PAUSED') return ['RESUMING'];
  if (from === 'RESUMING' || from === 'RETRYING') return ['FAILED'];
  if (TERMINAL_ABNORMAL.includes(from)) return [];
  return [...(NORMAL_TRANSITIONS[from] ?? []), ...ALWAYS_ALLOWED_TARGETS];
}

/** 终态判定：COMMITTED 是正常终态 */
export function isTerminal(from: ChapterStatus): boolean {
  return from === 'COMMITTED';
}

/** 异常态判定：需要人工介入 */
export function isAbnormal(from: ChapterStatus): boolean {
  return from === 'PAUSED' || from === 'FAILED' || from === 'RETRYING' || from === 'ROLLING_BACK';
}
