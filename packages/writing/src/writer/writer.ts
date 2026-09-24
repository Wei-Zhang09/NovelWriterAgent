/**
 * Writer（施工文档 §7.3）
 *
 * 职责：按 ScenePlan 生成正文。**Writer 不判断 Canon 是否正确** ——
 * 那是 Continuity Checker 的职责，Writer 只负责把计划写成有质感的文字。
 *
 * ## 三条硬约束（§9.1 + 研究报告）
 *
 * 1. **只写工作区，绝不碰正式章节**
 *    Writer 的输出落在 `workspace/chapter-NNN/draft.md`。
 *    正式章节 `chapters/NNN.md` 只由 Commit 流程写入（STEP 11）。
 *    本类**不持有**任何 repo / DB 引用 —— 在物理上没有改库的能力。
 *
 * 2. **不信任 Planner 的自由文本**
 *    Writer 只接受**已通过 schema 校验**的 PlanOutput 对象。
 *    要写什么由结构化字段驱动（requiredEvents / forbiddenEvents /
 *    continuityConstraints），而不是靠"读一段计划文字然后意会"。
 *
 * 3. **逐场景生成，累积前文**
 *    每个场景能看到之前场景的正文尾部（保持衔接），
 *    而不是一次性要求模型写出整章（长文会崩、且难定位问题）。
 */
import { ErrorCode, Logger, type Nullable } from '@nwa/core';
import type { PlanOutput, ScenePlan, ChapterBrief } from '@nwa/shared';
import type { ChapterWorkspace } from '@nwa/story';
import type { SkillRow } from '@nwa/storage';
import type { SkillEngine, SkillSelection } from '../skills/engine.js';

/**
 * 纯文本补全调用（与 gateway 解耦的接口）。
 *
 * ⚠ 约定：**失败时抛错**，而不是返回 { ok:false }。
 *   这与 ModelGateway.chat() 的实际行为一致 —— 它内部已做三级降级，
 *   降级仍失败才抛出。若这里再包一层 ok 标志，会与 gateway 语义重复
 *   且在调用方产生两种错误风格（实测踩到类型不匹配）。
 */
export type TextCompleter = (req: {
  readonly messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}) => Promise<{
  readonly text: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}>;

export interface WriterOptions {
  readonly complete: TextCompleter;
  readonly workspace: ChapterWorkspace;
  readonly logger: Logger;
  /** 每场景目标字数（默认 1200，中文长篇章节约 2500-3500 字 / 2-3 场景） */
  readonly wordsPerScene?: number;
  /**
   * 传给模型的上下文尾部字符数（默认 600）。
   * 只取尾部是因为衔接主要依赖"刚才发生了什么"，
   * 全文塞回去会挤占本场景的生成空间。
   */
  readonly tailChars?: number;
  /**
   * Skill Engine（§25）。不传则不注入技能 ——
   * ⚠ 与"传了但检索为空"是**不同**的情况，日志里要能区分。
   */
  readonly skillEngine?: SkillEngine;
  /**
   * 技能库（来自 `CorpusRepository.listSkills()`）。
   *
   * ⚠ 每次 draft 时读取而非缓存：技能可被人工下架（DEPRECATED），
   *   缓存会让"刚下架的技能又被用上"。
   */
  readonly skillRows?: readonly SkillRow[];
  /** 写什么类型的小说（技能检索的类型隔离依据，§21） */
  readonly genre?: string | null;
  /**
   * 场景级长程记忆提供者（P0-3）。
   *
   * ⚠ 为什么是**回调**而不是一次性文本：不同场景需要不同的记忆。
   *   用同一个 query 给整章取一份记忆，会让第 5 个场景读到只与
   *   第 1 个场景相关的旧内容 —— 那不是"长程记忆"，是噪声。
   *
   * 返回空字符串表示"本场景没有可用记忆"；抛错则由调用方在
   * 提供者内部处理（检索失败不该让写作失败）。
   */
  readonly sceneMemory?: (scene: ScenePlan, index: number) => string;
}

/** 单场景生成结果 */
export interface SceneDraft {
  readonly sceneId: string;
  readonly purpose: string;
  readonly text: string;
  readonly chars: number;
  /** 模型是否声明自己偏离了计划（自报，供人工复核，不作为判定依据） */
  readonly deviations: readonly string[];
}

/** 整章生成结果 */
export interface ChapterDraft {
  readonly chapterNumber: number;
  readonly scenes: readonly SceneDraft[];
  readonly text: string;
  readonly totalChars: number;
  /** 各场景的 token 用量合计 */
  readonly usage: { inputTokens: number; outputTokens: number };
  /** 写入的工作区文件路径 */
  readonly draftPath: string;
}

export interface DraftResult {
  readonly ok: boolean;
  readonly draft?: ChapterDraft;
  readonly error?: { code: string; message: string; details?: unknown };
  /** 失败的场景序号（从 0 起），便于续写 */
  readonly failedSceneIndex?: number;
}

export class Writer {
  private readonly complete: TextCompleter;
  private readonly workspace: ChapterWorkspace;
  private readonly logger: Logger;
  private readonly wordsPerScene: number;
  private readonly tailChars: number;
  private readonly skillEngine?: SkillEngine;
  private readonly sceneMemory?: (scene: ScenePlan, index: number) => string;
  private readonly skillRows: readonly SkillRow[];
  private readonly genre: string | null;

  constructor(opts: WriterOptions) {
    this.complete = opts.complete;
    this.workspace = opts.workspace;
    this.logger = opts.logger;
    this.wordsPerScene = opts.wordsPerScene ?? 1200;
    this.tailChars = opts.tailChars ?? 600;
    this.skillEngine = opts.skillEngine;
    this.skillRows = opts.skillRows ?? [];
    this.genre = opts.genre ?? null;
    this.sceneMemory = opts.sceneMemory;
  }

  /**
   * 按计划生成整章草稿。
   *
   * ⚠ 注意「草稿」二字：产物只进工作区，不进 canonical 章节。
   */
  async draft(plan: PlanOutput): Promise<DraftResult> {
    const scenes = plan.scenes;
    if (scenes.length === 0) {
      return {
        ok: false,
        error: { code: ErrorCode.TOOL_VALIDATION_ERROR, message: '计划中没有场景，无法生成正文' },
      };
    }

    this.logger.info('开始生成草稿', {
      chapterNumber: plan.brief.chapterNumber,
      sceneCount: scenes.length,
    });

    const done: SceneDraft[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    // ⚠ 技能检索的统计：把"用了哪些技能"落进工作区，
    //   否则事后无法回答"这段为什么这样写"（§46 可追溯）
    // ⚠ 记忆使用记录：与技能一样，事后要能回答"这段为什么这样写"
    const memoryUsed: { sceneIndex: number; sceneId: string; chars: number }[] = [];
    const memoryFailed: { sceneIndex: number; reason: string }[] = [];

    const skillUsage: {
      sceneIndex: number;
      sceneId: string;
      sceneFunction: string | null;
      selected: { id: string; name: string; score: number; truncated: boolean }[];
      rejectedCount: number;
      blockChars: number;
    }[] = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]!;
      // 只取已生成正文的尾部 —— 保持衔接，又不挤占本场景配额
      const previousTail = done.length > 0 ? tail(done[done.length - 1]!.text, this.tailChars) : null;

      // ── §25 Skill Engine 检索：为**这个场景**选 Top-N 技能 ──
      const sel = this.selectSkills(scene, i);
      skillUsage.push({
        sceneIndex: i,
        sceneId: scene.sceneId,
        sceneFunction: scene.sceneFunction ?? null,
        selected: sel.selected.map((x) => ({
          id: x.skill.id,
          name: x.skill.name,
          score: Math.round(x.score * 100) / 100,
          truncated: x.truncated,
        })),
        rejectedCount: sel.rejected.length,
        blockChars: sel.block.length,
      });

      const messages: { role: 'system' | 'user'; content: string }[] = [
        { role: 'system', content: buildSystemPrompt(plan.brief) },
        // 把结构化约束逐条列出，而不是让模型去"读计划"
        { role: 'system', content: buildConstraintBlock(plan.brief, scene, i, scenes.length) },
      ];
      // ⚠ 技能块放在约束之后、任务之前：它是"怎么写"的建议，
      //   排在"写什么"的约束之后才不会被当成硬性要求
      if (sel.block) messages.push({ role: 'system', content: sel.block });

      // ── 场景级长程记忆（P0-3）──────────────────────────
      //
      // ⚠ 按**本场景**取，不是整章共用一份：不同场景需要不同的旧内容，
      //   整章共用会让第 5 个场景读到只与第 1 个场景相关的东西。
      //
      // ⚠ 提供者抛错不能中断写作 —— 长程记忆是增强不是前置依赖。
      //   失败时如实记录并**继续**（缺记忆写出来的章仍是可用的草稿）。
      if (this.sceneMemory) {
        try {
          const mem = this.sceneMemory(scene, i);
          if (mem.trim().length > 0) {
            messages.push({
              role: 'system',
              content: `以下是与本场景相关的旧内容（可参考其写法与既有事实，不要直接照抄）：\n\n${mem}`,
            });
            memoryUsed.push({ sceneIndex: i, sceneId: scene.sceneId, chars: mem.length });
          }
        } catch (e) {
          this.logger.warn('场景级记忆获取失败（继续写作，不中断）', {
            sceneIndex: i,
            error: e instanceof Error ? e.message : String(e),
          });
          memoryFailed.push({ sceneIndex: i, reason: e instanceof Error ? e.message : String(e) });
        }
      }

      messages.push({ role: 'user', content: buildSceneTask(scene, previousTail, this.wordsPerScene) });

      let res: { text: string; usage?: { inputTokens: number; outputTokens: number } };
      try {
        res = await this.complete({
          messages,
          maxTokens: Math.ceil(this.wordsPerScene * 2.2), // 中文 1 字 ≈ 1.5-2 token，留余量
          temperature: 0.85,
        });
      } catch (e) {
        // 失败时把已完成的部分也保留进工作区 —— 不让用户白等
        this.persistPartial(plan, done);
        const err = e as { code?: string; message?: string };
        return {
          ok: false,
          failedSceneIndex: i,
          error: {
            code: err.code ?? ErrorCode.MODEL_TIMEOUT,
            message: err.message ?? `第 ${i + 1} 个场景生成失败`,
            details: { completedScenes: done.length, sceneId: scene.sceneId },
          },
        };
      }

      const text = res.text.trim();
      inputTokens += res.usage?.inputTokens ?? 0;
      outputTokens += res.usage?.outputTokens ?? 0;

      done.push({
        sceneId: scene.sceneId,
        purpose: scene.purpose,
        text,
        chars: text.length,
        deviations: extractDeviations(text),
      });
    }

    const fullText = assembleChapter(done);
    const draftPath = this.workspace.writeText('draft', fullText);

    // 同时把计划与场景划分落进工作区，便于回溯"这段为什么这样写"
    this.workspace.writeJson('plan', plan);
    // ⚠ 技能使用记录：把"哪个场景用了哪些技能、为什么"落盘（§46 可追溯）
    this.workspace.writeJson('skillUsage', {
      chapterNumber: plan.brief.chapterNumber,
      genre: this.genre,
      availableSkills: this.skillRows.length,
      scenes: skillUsage,
      totalBlockChars: skillUsage.reduce((n, x) => n + x.blockChars, 0),
    });
    // ⚠ 记忆使用落盘："这个场景参考了哪些旧内容"必须可回答（§五）
    this.workspace.writeJson('memoryUsage', {
      chapterNumber: plan.brief.chapterNumber,
      scenes: memoryUsed,
      failed: memoryFailed,
      totalChars: memoryUsed.reduce((n, x) => n + x.chars, 0),
    });
    this.workspace.writeJson('scenePlan', {
      chapterNumber: plan.brief.chapterNumber,
      scenes: done.map((d, i) => ({
        index: i,
        sceneId: d.sceneId,
        purpose: d.purpose,
        chars: d.chars,
        deviations: d.deviations,
      })),
      totalChars: fullText.length,
    });

    this.logger.info('草稿生成完成', {
      chapterNumber: plan.brief.chapterNumber,
      totalChars: fullText.length,
      scenes: done.length,
    });

    return {
      ok: true,
      draft: {
        chapterNumber: plan.brief.chapterNumber,
        scenes: done,
        text: fullText,
        totalChars: fullText.length,
        usage: { inputTokens, outputTokens },
        draftPath,
      },
    };
  }

  /**
   * §25：为一个场景检索 Top-N 技能。
   *
   * ⚠ 没配 Skill Engine 或技能库为空时返回空块 ——
   *   Writer 必须能在"没有技能"的情况下正常工作（离线/未蒸馏）。
   *   技能是**增强**不是前置依赖。
   */
  private selectSkills(scene: ScenePlan, index: number): SkillSelection {
    const empty: SkillSelection = {
      selected: [], rejected: [], block: '', considered: 0,
      resolutions: [], sameScopeConflicts: [],
    };
    if (!this.skillEngine || this.skillRows.length === 0) return empty;

    try {
      const sel = this.skillEngine.retrieve(this.skillRows, {
        sceneFunction: scene.sceneFunction ?? null,
        genre: this.genre,
        // 情感强度目前从 emotionalCurve 无法可靠推断 —— 传 null 让引擎
        // 跳过该维度，而不是猜一个值（猜出来的分数不可复现）
        emotionIntensity: null,
        pov: scene.pov || null,
      });

      // ⚠ 逐场景记录检索结果（含**落选**原因）——
      //   "某技能从未被用到"必须能查出原因，不能靠猜。
      this.logger.info('技能检索', {
        sceneIndex: index,
        sceneId: scene.sceneId,
        sceneFunction: scene.sceneFunction ?? null,
        considered: sel.considered,
        selected: sel.selected.map((x) => `${x.skill.name}(${x.score.toFixed(2)})`),
        rejected: sel.rejected.length,
      });

      return sel;
    } catch (e) {
      // ⚠ 检索失败不阻断写作 —— 技能是增强，不该让整章生成失败。
      //   但要如实记录（否则"技能没生效"会变成查不出的现象）。
      this.logger.warn('技能检索失败（本场景不注入技能）', {
        sceneIndex: index,
        error: e instanceof Error ? e.message : String(e),
      });
      return empty;
    }
  }

  /** 失败时保留已完成场景，便于续写与排查 */
  private persistPartial(plan: PlanOutput, done: readonly SceneDraft[]): void {
    if (done.length === 0) return;
    try {
      this.workspace.writeText('draft', assembleChapter(done));
      this.workspace.writeJson('plan', plan);
      this.workspace.writeJson('run', {
        status: 'PARTIAL',
        completedScenes: done.map((d) => d.sceneId),
        completedChars: done.reduce((s, d) => s + d.chars, 0),
      });
      this.logger.warn('草稿部分完成，已保留', { completedScenes: done.length });
    } catch (e) {
      // 保留失败不应覆盖原始错误 —— 原始错误更有诊断价值
      this.logger.error('保留部分草稿失败', { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

// ── Prompt 构造（§31：模块化，不写大 Prompt） ──────────────

function buildSystemPrompt(brief: ChapterBrief): string {
  return [
    '你是中文长篇小说写作者。你的任务是把给定的场景计划写成直接可用的正文。',
    '',
    '写作要求：',
    `- 人称与视角：${brief.mainCharacters.join('、')} 视角，不要跳视角。`,
    '- 用具体的动作、对话与细节推进，不要用概述句代替场面。',
    '- 转折与停顿用省略号"……"，少用破折号。',
    '- 不要复述双方都已知的信息，不要写客套腔。',
    '- 不要写章节标题、不要写"第X章"、不要加解释性括号。',
    '- 不要总结本场景，写到该停的地方就停。',
  ].join('\n');
}

function buildConstraintBlock(
  brief: ChapterBrief,
  scene: ScenePlan,
  index: number,
  total: number,
): string {
  const lines: string[] = [
    `【本章目的】${brief.purpose}`,
    `【状态迁移】${brief.previousState} → ${brief.targetState}`,
    `【情感弧】${brief.emotionalArc}`,
    `【节奏】${brief.pacingPlan}`,
    '',
    `【当前场景 ${index + 1}/${total}：${scene.sceneId}】`,
    `目的：${scene.purpose}`,
  ];
  if (scene.setting) lines.push(`地点：${scene.setting}`);
  if (scene.pov) lines.push(`视角：${scene.pov}`);
  if (scene.startState) lines.push(`起始状态：${scene.startState}`);
  if (scene.endState) lines.push(`必须到达：${scene.endState}`);
  if (scene.goal) lines.push(`角色目标：${scene.goal}`);
  if (scene.conflict) lines.push(`冲突：${scene.conflict}`);
  if (scene.obstacle) lines.push(`障碍：${scene.obstacle}`);
  if (scene.emotionalCurve) lines.push(`情感曲线：${scene.emotionalCurve}`);
  if (scene.pacing) lines.push(`场景节奏：${scene.pacing}`);

  if (brief.requiredEvents.length > 0) {
    lines.push('', '【本章必须发生】', ...brief.requiredEvents.map((e) => `- ${e}`));
  }
  if (brief.forbiddenEvents.length > 0) {
    lines.push('', '【本章绝不发生】', ...brief.forbiddenEvents.map((e) => `- ${e}`));
  }
  if (scene.continuityConstraints.length > 0) {
    lines.push('', '【连续性约束】', ...scene.continuityConstraints.map((c) => `- ${c}`));
  }
  if (brief.foreshadowing.plant.length > 0) {
    lines.push('', '【本章需要埋下】', ...brief.foreshadowing.plant.map((f) => `- ${f}`));
  }
  if (brief.foreshadowing.reinforce.length > 0) {
    lines.push('', '【本章需要强化】', ...brief.foreshadowing.reinforce.map((f) => `- ${f}`));
  }
  if (brief.foreshadowing.payoff.length > 0) {
    lines.push('', '【本章需要回收】', ...brief.foreshadowing.payoff.map((f) => `- ${f}`));
  }
  return lines.join('\n');
}

function buildSceneTask(scene: ScenePlan, previousTail: Nullable<string>, words: number): string {
  const parts: string[] = [];
  if (previousTail !== null && previousTail.length > 0) {
    parts.push('【前文结尾（请与之自然衔接）】', previousTail, '');
  }
  parts.push(
    `请写出场景「${scene.purpose}」的正文，约 ${words} 字。`,
    '只输出正文本身。',
  );
  return parts.join('\n');
}

// ── 正文组装 ────────────────────────────────────────────────

/**
 * 把各场景正文拼成一章。
 *
 * 场景之间用空行分隔，**不插入任何标记**（如"场景1"）——
 * 产物是给读者看的正文，标记会污染成稿。
 */
export function assembleChapter(scenes: readonly SceneDraft[]): string {
  return scenes
    .map((s) => s.text.trim())
    .filter((t) => t.length > 0)
    .join('\n\n');
}

function tail(text: string, n: number): string {
  return text.length <= n ? text : text.slice(-n);
}

/**
 * 提取模型自报的偏离说明。
 *
 * 模型有时会在正文末尾加一段"说明"——我们不信任它，但要**保留**它：
 * 这是给人工复核的信号，不是判定依据。正文本身会剔除该段。
 */
const DEVIATION_MARKERS = ['【偏离说明】', '【说明】', '【备注】', '(说明)'];

export function extractDeviations(text: string): string[] {
  for (const m of DEVIATION_MARKERS) {
    const i = text.lastIndexOf(m);
    if (i >= 0 && i > text.length * 0.5) {
      const note = text.slice(i + m.length).trim();
      if (note.length > 0 && note.length < 500) return [note];
    }
  }
  return [];
}

/** 去掉模型可能附加的说明段（正文只保留故事本身） */
export function stripDeviationNotes(text: string): string {
  for (const m of DEVIATION_MARKERS) {
    const i = text.lastIndexOf(m);
    if (i >= 0 && i > text.length * 0.5) return text.slice(0, i).trim();
  }
  return text;
}
