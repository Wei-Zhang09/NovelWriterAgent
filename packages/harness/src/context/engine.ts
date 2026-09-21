/**
 * Context Engine（施工文档 §28 / §12.3 / §11）
 *
 * 装配顺序固定且可断言（§28）：
 *   SYSTEM → PROJECT PROFILE → CHAPTER PLAN → SCENE PLAN
 *   → PROTECTED CANON → CHARACTER STATE → TIMELINE
 *   → FORESHADOWING → TOP MEMORY → TOP SKILLS → EVIDENCE → STYLE PROFILE
 *
 * 三条硬约束见 types.ts 的注释。核心实现要点：
 *
 *   1. **保护式预算**：先装 Protected，任一 Protected 槽位超预算 → 抛
 *      CONTEXT_BUDGET_EXCEEDED，**不裁剪**。之后再在剩余额度里装非 Protected。
 *
 *   2. **无根记忆拦截**：每个条目必须有非空 sourceRef，否则抛
 *      CONTEXT_BUILD_FAILED。这条在代码层强制，不靠 Prompt 提醒。
 *
 *   3. **装配报告**：每个槽位记录 included/dropped/truncated，
 *      且截断时**显式告知模型**上下文不完整。
 */
import { AppError, ErrorCode, Logger } from '@nwa/core';
import type { ContextBudget } from '@nwa/core';
import { conservativeTokenCounter } from './token-counter.js';
import {
  SLOT_NAMES,
  type AssembledContext,
  type AssemblyReport,
  type ContextEntry,
  type ContextRequest,
  type SlotName,
  type SlotReport,
  type SlotSpec,
  type TokenCounter,
} from './types.js';

/**
 * 默认槽位规格（施工文档 §28 的 12 层）。
 *
 * Protected 槽位（不可裁剪）的依据是 §12.2：
 *   主线关键事实、人物死亡、世界核心规则、终局、重要伏笔、关键关系变化
 */
const DEFAULT_SLOTS: readonly SlotSpec[] = [
  {
    name: 'system',
    isProtected: true,
    budgetTokens: 2_000,
    fillPolicy: 'all',
    description: '系统指令与角色定义，不可裁剪',
  },
  {
    name: 'projectProfile',
    isProtected: true,
    budgetTokens: 1_000,
    fillPolicy: 'all',
    description: '项目元信息（题材 / 基调 / 语言），不可裁剪',
  },
  {
    name: 'chapterPlan',
    isProtected: true,
    budgetTokens: 4_000,
    fillPolicy: 'all',
    description: '本章计划（ChapterBrief），不可裁剪 —— 当前任务的定义',
  },
  {
    name: 'scenePlan',
    isProtected: true,
    budgetTokens: 3_000,
    fillPolicy: 'all',
    description: '场景计划（ScenePlan），不可裁剪',
  },
  {
    name: 'protectedCanon',
    isProtected: true,
    budgetTokens: 16_000,
    fillPolicy: 'all',
    description: '受保护的 Canon 事实（死亡 / 世界规则 / 终局），不可裁剪',
  },
  {
    name: 'characterState',
    isProtected: true,
    budgetTokens: 6_000,
    fillPolicy: 'all',
    description: '本章登场角色的当前状态，不可裁剪',
  },
  {
    name: 'relevantTimeline',
    isProtected: false,
    budgetTokens: 4_000,
    fillPolicy: 'topK',
    description: '相关时间线事件，可裁剪',
  },
  {
    name: 'activeForeshadowing',
    isProtected: false,
    budgetTokens: 3_000,
    fillPolicy: 'topK',
    description: '活跃伏笔，可裁剪（但高优先级伏笔应被标为 protected 条目）',
  },
  {
    name: 'topMemory',
    isProtected: false,
    budgetTokens: 6_000,
    fillPolicy: 'topK',
    description: '检索得到的相关记忆，可裁剪',
  },
  {
    name: 'topSkills',
    isProtected: false,
    budgetTokens: 3_000,
    fillPolicy: 'topK',
    description: '命中的写作技能（§25：2~5 个），可裁剪',
  },
  {
    name: 'evidence',
    isProtected: false,
    budgetTokens: 4_000,
    fillPolicy: 'topK',
    description: '少量原文证据，可裁剪',
  },
  {
    name: 'styleProfile',
    isProtected: false,
    budgetTokens: 1_000,
    fillPolicy: 'all',
    description: '文风指纹（Full 阶段启用）',
  },
];

export interface ContextEngineOptions {
  readonly logger?: Logger;
  readonly counter?: TokenCounter;
  /** 覆盖默认槽位规格 */
  readonly slots?: readonly SlotSpec[];
}

export class ContextEngine {
  private readonly logger: Logger;
  private readonly counter: TokenCounter;
  private readonly slots: readonly SlotSpec[];

  constructor(opts: ContextEngineOptions = {}) {
    this.logger = opts.logger ?? new Logger('harness:context');
    // 默认用保守估算：宁可提前告警，不要超限被截断
    this.counter = opts.counter ?? conservativeTokenCounter;
    this.slots = opts.slots ?? DEFAULT_SLOTS;
  }

  /** 当前槽位规格（UI 展示用） */
  slotSpecs(): readonly SlotSpec[] {
    return this.slots;
  }

  /**
   * 装配上下文。
   *
   * 失败即抛错，不返回"残缺但可用"的结果 ——
   * 因为残缺的上下文会让模型基于错误前提写作（这正是要点）。
   */
  assemble(req: ContextRequest): AssembledContext {
    const budget = this.validateBudget(req.budget);
    const overrides = req.overrides ?? {};

    // ── 第一阶段：Protected（装不下即报错） ──
    const protectedSlots = this.slots.filter((s) => this.effective(s, overrides).isProtected);
    const reports: SlotReport[] = [];
    const entriesBySlot: Record<string, ContextEntry[]> = {};

    let protectedUsed = 0;
    let protectedBudgetTotal = 0;

    for (const spec of protectedSlots) {
      const eff = this.effective(spec, overrides);
      protectedBudgetTotal += eff.budgetTokens;
      const entries = this.validateEntries(eff.name, req.slots[eff.name] ?? []);
      const used = this.sumTokens(entries);

      if (used > eff.budgetTokens) {
        // ⚠ 关键：Protected 超预算 → 报错，绝不静默裁剪
        throw new AppError(
          ErrorCode.CONTEXT_BUDGET_EXCEEDED,
          `受保护槽位「${eff.name}」超出其预算：需要 ${used} tokens，上限 ${eff.budgetTokens}。` +
            `受保护内容不可裁剪 —— 请减少该槽位内容或调高预算。`,
          {
            details: {
              slot: eff.name,
              needed: used,
              budget: eff.budgetTokens,
              entryCount: entries.length,
              /** 列出最大的几条，便于定位是哪条内容撑爆了 */
              largestEntries: [...entries]
                .sort((a, b) => this.tokens(b) - this.tokens(a))
                .slice(0, 5)
                .map((e) => ({ id: e.id, sourceRef: e.sourceRef, tokens: this.tokens(e), priority: e.priority })),
            },
          },
        );
      }

      protectedUsed += used;
      entriesBySlot[eff.name] = [...entries];
      reports.push({
        slot: eff.name,
        isProtected: true,
        budgetTokens: eff.budgetTokens,
        usedTokens: used,
        includedCount: entries.length,
        droppedCount: 0,
        droppedIds: [],
        truncated: false,
      });
    }

    // Protected 总量也不能超过整体预算，否则连输出预留都没有
    const available = budget.inputTokens - budget.outputReserveTokens;
    if (protectedUsed > available) {
      throw new AppError(
        ErrorCode.CONTEXT_BUDGET_EXCEEDED,
        `受保护内容共 ${protectedUsed} tokens，超过可用输入预算 ${available}（输入上限 ${budget.inputTokens} 减去输出预留 ${budget.outputReserveTokens}）`,
        { details: { protectedUsed, available, inputTokens: budget.inputTokens, outputReserve: budget.outputReserveTokens } },
      );
    }

    if (protectedUsed > budget.protectedMaxTokens) {
      throw new AppError(
        ErrorCode.CONTEXT_BUDGET_EXCEEDED,
        `受保护内容共 ${protectedUsed} tokens，超过 protectedMaxTokens 配置上限 ${budget.protectedMaxTokens}`,
        { details: { protectedUsed, protectedMaxTokens: budget.protectedMaxTokens } },
      );
    }

    // ── 第二阶段：非 Protected（在剩余额度里裁剪） ──
    let remaining = available - protectedUsed;
    for (const spec of this.slots) {
      const eff = this.effective(spec, overrides);
      if (eff.isProtected) continue;

      const entries = this.validateEntries(eff.name, req.slots[eff.name] ?? []);
      const slotBudget = Math.min(eff.budgetTokens, remaining);
      const fitted = this.fitToBudget(entries, slotBudget, eff.fillPolicy);

      remaining -= fitted.usedTokens;
      entriesBySlot[eff.name] = fitted.included;
      reports.push({
        slot: eff.name,
        isProtected: false,
        budgetTokens: eff.budgetTokens,
        usedTokens: fitted.usedTokens,
        includedCount: fitted.included.length,
        droppedCount: entries.length - fitted.included.length,
        droppedIds: entries.filter((e) => !fitted.included.includes(e)).map((e) => e.id),
        truncated: fitted.truncated,
        ...(fitted.note === undefined ? {} : { note: fitted.note }),
      });
    }

    // ── 组装文本（按 SLOT_NAMES 的固定顺序） ──
    const orderedReports = [...reports].sort(
      (a, b) => SLOT_NAMES.indexOf(a.slot) - SLOT_NAMES.indexOf(b.slot),
    );
    const text = this.render(entriesBySlot, orderedReports);

    const totalTokens = this.counter.estimate(text);
    const report: AssemblyReport = {
      totalTokens,
      budgetTokens: budget.inputTokens,
      slots: orderedReports,
      protectedTokens: protectedUsed,
      protectedBudgetTokens: protectedBudgetTotal,
      // 走到这里说明所有 Protected 都装下了（否则早已抛错）
      allProtectedSatisfied: true,
    };

    this.logger.debug('上下文装配完成', {
      totalTokens,
      protectedTokens: protectedUsed,
      droppedTotal: orderedReports.reduce((n, r) => n + r.droppedCount, 0),
    });

    return { text, entriesBySlot, report };
  }

  private effective(spec: SlotSpec, overrides: Partial<Record<SlotName, Partial<SlotSpec>>>): SlotSpec {
    const o = overrides[spec.name];
    return o ? { ...spec, ...o } : spec;
  }

  private validateBudget(b: ContextBudget): ContextBudget {
    if (!b || typeof b.inputTokens !== 'number' || b.inputTokens <= 0) {
      throw new AppError(ErrorCode.CONTEXT_BUDGET_EXCEEDED, 'contextBudget.inputTokens 必填且为正数');
    }
    if (b.protectedMaxTokens > b.inputTokens) {
      throw new AppError(
        ErrorCode.CONTEXT_BUDGET_EXCEEDED,
        'protectedMaxTokens 不得大于 inputTokens（配置矛盾）',
      );
    }
    const available = b.inputTokens - b.outputReserveTokens;
    if (available <= 0) {
      throw new AppError(
        ErrorCode.CONTEXT_BUDGET_EXCEEDED,
        `输出预留（${b.outputReserveTokens}）不小于输入上限（${b.inputTokens}），没有任何可用输入空间`,
      );
    }
    return b;
  }

  /**
   * ⚠ 无根记忆拦截（§11）。
   *
   * 每个条目必须有非空的 id / sourceRef / content。
   * 缺 sourceRef 的内容**不允许**进入上下文 —— 这是「禁止返回没有来源的
   * 无根记忆」的代码层强制点。
   */
  private validateEntries(slot: SlotName, entries: readonly ContextEntry[]): ContextEntry[] {
    return entries.map((e, i) => {
      if (!e.id) {
        throw new AppError(ErrorCode.CONTEXT_BUILD_FAILED, `槽位「${slot}」第 ${i + 1} 条缺少 id`, {
          details: { slot, index: i },
        });
      }
      if (!e.sourceRef || e.sourceRef.trim().length === 0) {
        throw new AppError(
          ErrorCode.CONTEXT_BUILD_FAILED,
          `槽位「${slot}」的条目 ${e.id} 缺少 sourceRef —— 禁止无根记忆进入上下文（§11）`,
          { details: { slot, entryId: e.id, sourceType: e.sourceType } },
        );
      }
      if (typeof e.content !== 'string') {
        throw new AppError(ErrorCode.CONTEXT_BUILD_FAILED, `槽位「${slot}」的条目 ${e.id} 内容不是字符串`, {
          details: { slot, entryId: e.id },
        });
      }
      return e;
    });
  }

  private tokens(e: ContextEntry): number {
    return this.counter.estimate(e.content);
  }

  private sumTokens(entries: readonly ContextEntry[]): number {
    return entries.reduce((n, e) => n + this.tokens(e), 0);
  }

  /**
   * 在预算内装入条目。
   *
   * 排序规则：**priority 降序，其次 protected 条目优先**。
   * 注意：这里的 protected 是条目级标记（如一条核心伏笔在可裁剪槽位里），
   * 与槽位级的 isProtected 不同 —— 它让"槽位可裁剪"与"条目不可丢"能共存。
   */
  private fitToBudget(
    entries: readonly ContextEntry[],
    budget: number,
    policy: SlotSpec['fillPolicy'],
  ): {
    included: ContextEntry[];
    usedTokens: number;
    truncated: boolean;
    note?: string;
  } {
    if (entries.length === 0) return { included: [], usedTokens: 0, truncated: false };
    if (budget <= 0) {
      return {
        included: [],
        usedTokens: 0,
        truncated: false,
        note: `预算为 0，本槽位 ${entries.length} 条全部未装入`,
      };
    }

    // 排序：protected 优先 → priority 降序 → id 稳定排序（保证可复现）
    const sorted = [...entries].sort((a, b) => {
      const pa = a.isProtected ? 1 : 0;
      const pb = b.isProtected ? 1 : 0;
      if (pa !== pb) return pb - pa;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.id.localeCompare(b.id);
    });

    if (policy === 'all') {
      const used = this.sumTokens(sorted);
      if (used <= budget) return { included: sorted, usedTokens: used, truncated: false };
      // 非 protected 槽位配了 all 但装不下：按预算装入，并如实报告
      return this.greedyFill(sorted, budget, true);
    }

    // topK / truncate 都按预算贪心装入（truncate 额外对超长单条做段落截断）
    return this.greedyFill(sorted, budget, policy === 'truncate');
  }

  private greedyFill(
    sorted: readonly ContextEntry[],
    budget: number,
    allowTruncate: boolean,
  ): { included: ContextEntry[]; usedTokens: number; truncated: boolean; note?: string } {
    const included: ContextEntry[] = [];
    let used = 0;
    let truncated = false;

    for (const e of sorted) {
      const cost = this.tokens(e);
      if (used + cost <= budget) {
        included.push(e);
        used += cost;
        continue;
      }
      // 装不下：仅在允许截断且剩余空间足够时，截断这一条装入
      const room = budget - used;
      if (allowTruncate && room >= 64) {
        const cut = this.truncateToTokens(e.content, room);
        if (cut.text.length > 0) {
          included.push({
            ...e,
            content: cut.text + `\\n[已截断：本条原 ${cost} tokens，因预算限制保留首尾约 ${this.counter.estimate(cut.text)} tokens]`,
          });
          used += this.counter.estimate(cut.text);
          truncated = true;
        }
      }
      break; // 后续条目预算只会更不够
    }

    const dropped = sorted.length - included.length;
    const note =
      dropped > 0 || truncated
        ? `本槽位共 ${sorted.length} 条，装入 ${included.length} 条` +
          (dropped > 0 ? `，丢弃 ${dropped} 条` : '') +
          (truncated ? '，其中 1 条被截断' : '')
        : undefined;

    return { included, usedTokens: used, truncated, ...(note === undefined ? {} : { note }) };
  }

  /**
   * 保留首尾的截断。
   *
   * 为什么保留尾部：叙事文本的关键信息常在段末（钩子、转折），
   * 只保留开头会丢掉最重要的部分。
   */
  private truncateToTokens(text: string, maxTokens: number): { text: string } {
    const lines = text.split('\\n');
    if (lines.length <= 1) {
      const keep = Math.max(1, Math.floor(text.length * (maxTokens / Math.max(1, this.counter.estimate(text)))));
      const head = text.slice(0, Math.floor(keep * 0.6));
      const tail = text.slice(-Math.floor(keep * 0.4));
      return { text: `${head}……${tail}` };
    }
    // 段落级：先取前一半段，再从后往前补
    const headLines = lines.slice(0, Math.ceil(lines.length / 2));
    const tailLines = lines.slice(-Math.floor(lines.length / 2));
    let out = headLines.join('\\n') + '\\n……\\n' + tailLines.join('\\n');
    // 若仍超，按字符再截
    if (this.counter.estimate(out) > maxTokens) {
      const ratio = maxTokens / this.counter.estimate(out);
      const keep = Math.max(64, Math.floor(out.length * ratio));
      out = out.slice(0, Math.floor(keep * 0.7)) + '\\n……\\n' + out.slice(-Math.floor(keep * 0.3));
    }
    return { text: out };
  }

  /** 按固定槽位顺序渲染文本 */
  private render(
    bySlot: Readonly<Record<string, readonly ContextEntry[]>>,
    reports: readonly SlotReport[],
  ): string {
    const parts: string[] = [];
    for (const name of SLOT_NAMES) {
      const entries = bySlot[name];
      if (!entries || entries.length === 0) continue;
      const rep = reports.find((r) => r.slot === name);
      parts.push(`## ${name}`);
      if (rep?.note) {
        // 显式告知模型上下文不完整 —— 避免它把残缺上下文当完整
        parts.push(`[上下文说明：${rep.note}]`);
      }
      for (const e of entries) {
        // sourceRef 一并给出，让模型知道每条信息的来源（§11）
        parts.push(`- [${e.sourceType}:${e.sourceRef}] ${e.content}`);
      }
      parts.push('');
    }
    return parts.join('\\n');
  }
}
