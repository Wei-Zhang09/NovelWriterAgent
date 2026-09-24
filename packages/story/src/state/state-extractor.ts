/**
 * 状态提取器（§六 P0-4 第一步）。
 *
 * ## 职责边界
 *
 * ```
 * 提取（本文件）  → 只产出候选，**绝不写库**
 * 验证（verifier）→ 代码判定每条是否可回溯
 * 应用（settlement）→ 只有 VERIFIED 才写库
 * ```
 *
 * ⚠ 本文件**没有** `Repositories` 依赖 —— "只提议不写库"因此是
 *   **物理保证**而非约定（与 `FactExtractor` 同一手法）。
 *
 * ## 为什么要与 FactExtractor 分开
 *
 * `FactExtractor` 抽的是**静态事实**（"陆明远是主簿"），
 * 本文件抽的是**状态变化**（"陆明远被贬到临江府"）与**事件**
 * （"架阁库失火"）。两者的验证方式相同（引文可回溯），
 * 但用途不同：事实进 Canon 供检索，状态变化进 character_states
 * 供"第三章时他知道什么"这类查询。
 *
 * 合并成一个调用会让 prompt 过长且互相干扰 —— 模型在一次输出里
 * 既要判"这是不是定义性事实"又要判"这是什么事件"，准确率明显下降。
 */

import { Logger } from '@nwa/core';
import type { ExtractStructuredCaller, KnownCharacter } from '../canon/fact-extractor.js';
import { z } from 'zod';
import {
  StateExtractionOutputSchema,
  ProposedCharacterStateSchema,
  ProposedTimelineEventSchema,
  ProposedForeshadowingSchema,
  type StateExtractionOutput,
  type StateExtractionOutputValidated,
} from '@nwa/shared';

export interface StateExtractorOptions {
  readonly structured: ExtractStructuredCaller;
  readonly logger: Logger;
  readonly bookId: string;
  /** 已知角色（名称 → id 解析） */
  readonly characters: readonly KnownCharacter[];
  /** 已有伏笔名（提示模型不要重复埋同一个） */
  readonly existingForeshadowing?: readonly string[];
}

export interface StateExtractionRequest {
  readonly chapterNumber: number;
  readonly draftText: string;
  /** 上一章结束时各角色的状态（帮助模型判断"变了没有"） */
  readonly previousStates?: readonly {
    readonly characterName: string;
    readonly status: string;
  }[];
}

export interface StateExtractionResult {
  readonly ok: boolean;
  /** 候选（**尚未写库**）。角色名已解析为 id（解析不到为 null） */
  readonly proposed: StateExtractionOutputValidated;
  /** 解析不到角色的条目（会被验证阶段拒绝，这里提前暴露原因） */
  readonly unresolvedCharacters: readonly { name: string; reason: string }[];
  readonly error?: { code: string; message: string };
  readonly attempts: number;
}

const SYSTEM_PROMPT = `你是长篇小说的设定管理员。你的唯一任务是从给定章节正文中，提取**故事世界的状态变化**。

## 你必须遵守的规则

1. **每一条都必须附原文引文**（quote），且引文必须是正文中**逐字出现**的片段。
   不要改写、不要拼接、不要凭印象概括。引文不存在的条目会被程序自动丢弃。
   ⚠ **不要填写 startOffset / endOffset** —— 字偏移由程序自己定位。
   你只需保证引文逐字正确；填错的偏移没有帮助。

2. **只提取正文中明确发生的事**，不要推断、不要补充常识。
   例如正文没写"他受伤了"，就不要因为"他打了一架"而提取受伤状态。

3. **角色状态只写"变化后的状态"**，一句话，具体可验证。
   好："左臂骨折，无法用剑"
   差："受了点伤，心情不好"（含糊，无法与后文对账）

4. **时间线事件只写叙事上真实发生的事件**，不写心理活动、不写环境描写。
   好："架阁库失火，卷宗尽毁"
   差："陆明远感到不安"（心理活动不是事件）

5. **伏笔动作用动作而非状态**：
   - PLANT   —— 这里**新埋下**了一个以后要回收的东西
   - ADVANCE —— 这里**推进**了某个已存在的伏笔
   - PAYOFF  —— 这里**回收**了前面埋的东西
   - ABANDON —— 这里明确**放弃**了某个伏笔
   伏笔名要与已有伏笔表里的名字一致（若一致，用完全相同的名字）。

6. **宁缺勿滥**。没把握的条目不要输出。输出空数组是完全可以接受的答案。`;

function buildUserPrompt(req: StateExtractionRequest): string {
  const parts: string[] = [];
  parts.push(`## 本章是第 ${req.chapterNumber} 章`);
  if (req.previousStates && req.previousStates.length > 0) {
    parts.push(
      '## 上一章结束时的角色状态\n' +
        req.previousStates.map((s) => `- ${s.characterName}：${s.status}`).join('\n') +
        '\n\n⚠ 只提取**发生了变化**的项。上面没变的不要重复输出。',
    );
  }
  parts.push(`## 本章正文\n\n${req.draftText}`);
  parts.push('## 请输出结构化结果（characterStates / timelineEvents / foreshadowing）');
  return parts.join('\n\n');
}

export class StateExtractor {
  private readonly structured: ExtractStructuredCaller;
  private readonly logger: Logger;
  private readonly characters: readonly KnownCharacter[];

  constructor(opts: StateExtractorOptions) {
    this.structured = opts.structured;
    this.logger = opts.logger;
    this.characters = opts.characters;
  }

  /**
   * 从一章正文提取状态变化候选。
   *
   * ⚠ 全程不写库：返回候选列表，由调用方落 state_proposals。
   */
  async extract(req: StateExtractionRequest): Promise<StateExtractionResult> {
    const res = await this.structured<StateExtractionOutput>({
      schema: StateExtractionOutputSchema,
      schemaName: 'StateExtractionOutput',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(req) },
      ],
      maxTokens: 4096,
      // 抽取要稳，不要发挥
      temperature: 0.1,
    });

    if (!res.ok) {
      this.logger.warn('状态提取失败', {
        chapterNumber: req.chapterNumber,
        error: res.error.message,
      });
      return {
        ok: false,
        proposed: { characterStates: [], timelineEvents: [], foreshadowing: [] },
        unresolvedCharacters: [],
        error: { code: res.error.code, message: res.error.message },
        attempts: res.attempts,
      };
    }

    // ── 逐条校验（⚠ 一条越界不该炸整批）──
    //
    // 实测：模型给了 importance: 8（schema 要求 1–5），整个提取结果校验失败，
    // stage FAILED，连同一批里完全合格的时间线/伏笔也一起丢了。
    // 所以这里**逐条** safeParse：不合格的条目单独丢弃。
    //
    // ⚠ 丢弃不是静默：每一条都记日志。"少而真"要能说清少了什么 ——
    //   否则某类条目长期全被丢掉也查不出来。
    const dropped: string[] = [];
    const pick = <T>(raw: readonly unknown[], schema: z.ZodType<T>, field: string): T[] => {
      const kept: T[] = [];
      raw.forEach((item, i) => {
        const r = schema.safeParse(item);
        if (r.success) kept.push(r.data);
        else {
          const first = r.error.issues[0];
          const why = first
            ? `${first.path.join('.') || '(根)'} ${first.message}`
            : '校验失败';
          const msg = `${field}[${i}]：${why}`;
          dropped.push(msg);
          this.logger.warn('提取条目未通过校验，已丢弃该条（不影响其余）', { dropped: msg });
        }
      });
      return kept;
    };

    const rawStates = pick(res.data.characterStates, ProposedCharacterStateSchema, 'characterStates');
    const rawEvents = pick(res.data.timelineEvents, ProposedTimelineEventSchema, 'timelineEvents');
    const rawForeshadowing = pick(
      res.data.foreshadowing,
      ProposedForeshadowingSchema,
      'foreshadowing',
    );

    // 名称 → id 解析（解析不到如实记录，不静默置空）
    const unresolved: { name: string; reason: string }[] = [];
    const characterStates = rawStates.map((cs) => {
      if (cs.characterId) return cs;
      const hit = this.characters.find(
        (c) => c.name === cs.characterName || (c.aliases ?? []).includes(cs.characterName),
      );
      if (!hit) {
        unresolved.push({
          name: cs.characterName,
          reason: `角色「${cs.characterName}」未在角色表中登记，无法解析 id`,
        });
        return cs;
      }
      return { ...cs, characterId: hit.id };
    });

    this.logger.info('状态提取完成', {
      chapterNumber: req.chapterNumber,
      characterStates: characterStates.length,
      timelineEvents: rawEvents.length,
      foreshadowing: rawForeshadowing.length,
      unresolved: unresolved.length,
      dropped: dropped.length,
    });

    return {
      ok: true,
      proposed: {
        characterStates,
        timelineEvents: rawEvents,
        foreshadowing: rawForeshadowing,
      },
      unresolvedCharacters: unresolved,
      attempts: res.attempts,
    };
  }
}
