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

  constructor(opts: WriterOptions) {
    this.complete = opts.complete;
    this.workspace = opts.workspace;
    this.logger = opts.logger;
    this.wordsPerScene = opts.wordsPerScene ?? 1200;
    this.tailChars = opts.tailChars ?? 600;
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

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]!;
      // 只取已生成正文的尾部 —— 保持衔接，又不挤占本场景配额
      const previousTail = done.length > 0 ? tail(done[done.length - 1]!.text, this.tailChars) : null;

      let res: { text: string; usage?: { inputTokens: number; outputTokens: number } };
      try {
        res = await this.complete({
          messages: [
            { role: 'system', content: buildSystemPrompt(plan.brief) },
            // 把结构化约束逐条列出，而不是让模型去"读计划"
            { role: 'system', content: buildConstraintBlock(plan.brief, scene, i, scenes.length) },
            { role: 'user', content: buildSceneTask(scene, previousTail, this.wordsPerScene) },
          ],
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
