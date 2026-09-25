/**
 * 核心设定与角色生成（开书向导 Phase 2）
 *
 * ## 用户诉求
 * > 「配置 AI 生成大纲角色等等相关功能，再由用户进行**选择**、修改」
 *
 * ## 参考项目 oh-story-claudecode 的 Phase 2（`workflow-setup.md`）
 *
 * 它由两个专职 agent 产出：`story-architect`（世界观 + 核心冲突）
 * 与 `character-designer`（角色设定）。产出「核心设定表」：
 * 基本信息 / 一句话梗概 / 主角设定 / 世界观骨架 / 核心冲突。
 *
 * 本实现把它合成一次调用（两个 agent 串行 spawn 在这个规模下不值得 ——
 * 设定表是一个整体，拆开反而容易出现"世界观说 A、角色动机说 B"的不一致）。
 *
 * ## ⚠ 产出落在哪：两张**已有的正式表**
 *
 * 角色 → `characters`，世界观 → `world_entities`。
 *
 * 这两张表是 `renderCharacterBlock` / `renderWorldBlock` 唯一读取的来源，
 * 也就是 prompt 真正看到的东西。若另存一份（塞进 blueprint 的 draft_json），
 * 就会出现**门禁说"已确认"、prompt 却读不到** —— 作者以为 Agent 按设定写了，
 * 其实没有。这是 W1 已经记录过的教训。
 *
 * 所以本模块只**生成提议**；物化由 `materializeSettings()` 负责，
 * 且必须走正式仓储（`repos.characters.create` / `repos.world.create`）。
 *
 * ## ⚠ 冲突处理：用户决策是"逐条让我选"
 *
 * 作者可能已经手写了角色（界面上的「角色设定」表单）。
 * AI 提议的同名角色不能静默覆盖、也不能静默跳过 ——
 * 前者丢作者的内容，后者让作者以为 AI 采纳了。
 *
 * 所以本模块**只负责检出冲突并如实列出**，决定权交给界面：
 * `detectSettingsConflicts()` 返回每一条冲突的双方内容，
 * 界面据此逐条让作者选「保留旧的 / 用新的 / 两个都留」。
 *
 * ⚠ 物化时**必须重新校验冲突**（不能只信生成时算出的结果）：
 *   作者可能在界面上停留期间手改了角色表 —— 那时旧的冲突列表已经过期，
 *   按它物化会覆盖作者刚写的内容。
 */
import { Logger } from '@nwa/core';
import {
  SettingsOutputSchema,
  SETTINGS_SHAPE_HINT,
  validateSettingsSemantics,
  type SettingsOutput,
  type CharacterProposal,
  type WorldProposal,
} from '@nwa/shared';
import type { StructuredResult } from '@nwa/harness';
import {
  AGENT_SETTINGS,
  TASK_SETTINGS,
  buildMessages,
  structuredTaskBlock,
} from '../prompts/index.js';

/**
 * 生成请求：承接 Phase 1 已确认的选题。
 *
 * ⚠ `concept` 必填：Phase 2 是"从 Phase 1 确定的目标情绪出发"（oh-story 原话），
 *   没有选题就没法做设定 —— 若作者跳过了 Phase 1，界面应先补一个方向，
 *   而不是让本模块凭空生成（那会产出一套与选题无关的设定）。
 */
export interface SettingsRequest {
  /** Phase 1 确认的选题（必填） */
  readonly concept: {
    readonly pitch: string;
    readonly genre: string;
    readonly coreEmotion: string;
    readonly protagonist: string;
    readonly coreConflict: string;
    readonly differentiation: string;
    readonly estimatedChapters: number;
  };
  readonly bookTitle?: string;
  /**
   * 作者已手写的角色名 + 一句摘要。
   *
   * ⚠ 必须传给模型，且要明确告知"这些已存在，不要重复提议"：
   *   否则模型会提议一个同名角色，作者逐条选择时看到两个"沈砚"，
   *   而他自己的那个写得更细 —— 白折腾一轮。
   *   ⚠ 但**不能只靠提示词**：模型仍可能重复，所以冲突检出是必需的机制
   *   （提示词设意图，代码设保证 —— 见 llm-generation-pipelines 规则 4）。
   */
  readonly existingCharacters?: readonly { name: string; summary: string }[];
  /** 作者已手写的世界观设定名 + 一句摘要 */
  readonly existingWorld?: readonly { name: string; summary: string }[];
  /** 作者对设定的额外要求 */
  readonly userInstruction?: string;
}

export type SettingsStructuredCaller = <T>(req: {
  schema: import('zod').ZodType<T, import('zod').ZodTypeDef, unknown>;
  schemaName: string;
  messages: readonly import('@nwa/harness').ChatMessage[];
}) => Promise<StructuredResult<T>>;

export interface SettingsGeneratorOptions {
  readonly structured: SettingsStructuredCaller;
  readonly logger?: Logger;
  readonly maxSemanticRepair?: number;
}

export interface SettingsResult {
  readonly ok: boolean;
  readonly output?: SettingsOutput;
  /** 语义问题（重试后仍存在的）；ok 为 true 时也可能非空 */
  readonly issues?: readonly string[];
  readonly attempts: number;
  readonly error?: { code: string; message: string; details?: unknown };
}

export class SettingsGenerator {
  private readonly structured: SettingsStructuredCaller;
  private readonly logger: Logger;
  private readonly maxSemanticRepair: number;

  constructor(opts: SettingsGeneratorOptions) {
    this.structured = opts.structured;
    this.logger = opts.logger ?? new Logger('writing:settings');
    this.maxSemanticRepair = opts.maxSemanticRepair ?? 1;
  }

  async generate(req: SettingsRequest): Promise<SettingsResult> {
    const messages = buildMessages({
      agent: AGENT_SETTINGS,
      contextText: renderSettingsRequest(req),
      task: [TASK_SETTINGS, structuredTaskBlock('SettingsOutput', SETTINGS_SHAPE_HINT)],
    });

    let lastIssues: readonly string[] = [];
    let lastOutput: SettingsOutput | undefined;
    let attempts = 0;

    for (let i = 0; i <= this.maxSemanticRepair; i++) {
      attempts++;
      const res = await this.structured<SettingsOutput>({
        schema: SettingsOutputSchema,
        schemaName: 'SettingsOutput',
        messages,
      });

      if (!res.ok) {
        // 结构化输出失败不重试（重发同样提示词无用，重试已由 gateway 负责）
        this.logger.warn('核心设定结构化输出失败', {
          code: res.error.code,
          attempts: res.attempts,
        });
        return {
          ok: false,
          attempts,
          error: {
            code: res.error.code,
            message: res.error.message,
            details: {
              schemaAttempts: res.attempts,
              usedFallback: res.usedFallback,
              rawTextHead: res.rawText.slice(0, 300),
            },
          },
        };
      }

      lastOutput = res.data;
      const issues = validateSettingsSemantics(res.data);
      if (issues.length === 0) {
        return { ok: true, output: res.data, attempts };
      }

      lastIssues = issues;
      this.logger.warn('核心设定语义问题，尝试修复', { attempt: attempts, issues });

      if (i < this.maxSemanticRepair) {
        messages.push({
          role: 'user',
          content: [
            '上一轮的输出有以下问题，请修正后重新输出完整 JSON：',
            ...issues.map((x) => `- ${x}`),
            '',
            '注意：修正的是内容，不是格式。',
          ].join('\n'),
        });
      }
    }

    // 重试耗尽：返回结果 + issues，不抛错（判断权交给界面）
    return { ok: true, output: lastOutput!, issues: lastIssues, attempts };
  }
}

/**
 * 把请求渲染成上下文文本。
 *
 * ⚠ 已存在的角色/设定**必须显式告知"不要重复提议"**，
 *   并给出它们的摘要 —— 否则模型不知道作者已经写了什么，
 *   会提议一个语义重叠但名字不同的角色（如"陈默"与作者的"沈砚"
 *   都是退役拳手），作者逐条选择时才发现撞了。
 */
export function renderSettingsRequest(req: SettingsRequest): string {
  const lines: string[] = [];

  if (req.bookTitle) lines.push(`书名：${req.bookTitle}`);
  lines.push('');
  lines.push('【已确认的选题方向】');
  lines.push(`- 一句话卖点：${req.concept.pitch}`);
  lines.push(`- 题材：${req.concept.genre}`);
  lines.push(`- 核心情绪：${req.concept.coreEmotion}`);
  lines.push(`- 主角设想：${req.concept.protagonist}`);
  lines.push(`- 核心冲突：${req.concept.coreConflict}`);
  lines.push(`- 差异化：${req.concept.differentiation}`);
  lines.push(`- 预计章数：${req.concept.estimatedChapters}`);

  if (req.existingCharacters && req.existingCharacters.length > 0) {
    lines.push('');
    lines.push('【作者已手写的角色 —— ⚠ 不要重复提议这些名字】');
    for (const c of req.existingCharacters) {
      lines.push(`- ${c.name}：${c.summary}`);
    }
  }

  if (req.existingWorld && req.existingWorld.length > 0) {
    lines.push('');
    lines.push('【作者已手写的世界观设定 —— ⚠ 不要重复提议这些名字】');
    for (const w of req.existingWorld) {
      lines.push(`- ${w.name}：${w.summary}`);
    }
  }

  if (req.userInstruction && req.userInstruction.trim().length > 0) {
    lines.push('');
    lines.push(`【作者对设定的额外要求】\n${req.userInstruction.trim()}`);
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// 冲突检出（用户决策：逐条让作者选）
// ═══════════════════════════════════════════════════════════════════

/** 一条角色冲突 */
export interface CharacterConflict {
  readonly kind: 'character';
  readonly name: string;
  /** 作者已手写的版本摘要 */
  readonly existingSummary: string;
  /** AI 提议的完整内容 */
  readonly proposal: CharacterProposal;
}

/** 一条世界观冲突 */
export interface WorldConflict {
  readonly kind: 'world';
  readonly name: string;
  readonly existingSummary: string;
  readonly proposal: WorldProposal;
}

export type SettingsConflict = CharacterConflict | WorldConflict;

/**
 * 检出 AI 提议与作者已有内容的重名冲突。
 *
 * ## ⚠ 为什么按**归一化后的名字**比，而不是严格相等
 *
 * 作者写「沈砚」，模型可能写「沈砚 」（尾随空格）或「沈 砚」。
 * 严格相等会漏掉这些，于是物化时撞上 characters 的语义冲突 ——
 * 而那时作者已经确认过了，问题在更晚、更难查的地方暴露。
 *
 * 归一化：去首尾空白 + 去掉中间空白。不做大小写/繁简转换 ——
 * 中文场景下那属于猜测，会把"沈砚"和"沈研"这种真实不同的人合并。
 *
 * ## ⚠ 只检出，不解决
 *
 * 本函数**不决定**保留哪个 —— 那是用户决策（逐条选择）。
 * 返回值必须带双方内容，界面才能让作者做判断。
 */
export function detectSettingsConflicts(
  output: SettingsOutput,
  existing: {
    readonly characters: readonly { name: string; summary: string }[];
    readonly world: readonly { name: string; summary: string }[];
  },
): SettingsConflict[] {
  const norm = (s: string): string => s.replace(/\s+/g, '').trim();

  const conflicts: SettingsConflict[] = [];

  const charIndex = new Map(existing.characters.map((c) => [norm(c.name), c]));
  for (const p of output.characters) {
    const hit = charIndex.get(norm(p.name));
    if (hit) {
      conflicts.push({
        kind: 'character',
        name: p.name,
        existingSummary: hit.summary,
        proposal: p,
      });
    }
  }

  const worldIndex = new Map(existing.world.map((w) => [norm(w.name), w]));
  for (const p of output.worldEntities) {
    const hit = worldIndex.get(norm(p.name));
    if (hit) {
      conflicts.push({
        kind: 'world',
        name: p.name,
        existingSummary: hit.summary,
        proposal: p,
      });
    }
  }

  return conflicts;
}
