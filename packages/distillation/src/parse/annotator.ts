/**
 * 叙事标注器（施工文档 §19）
 *
 * ## 分层：机械指标必算，语义标注可选
 *
 * | 层 | 内容 | 失败时 |
 * |---|---|---|
 * | 机械 | `pacing` / `prose` | 不可能失败（纯计算） |
 * | 语义 | `sceneFunction` / `goals` / `conflicts` / `hook` … | **如实标 null** |
 *
 * ## ⚠ 为什么语义标注失败时必须标 null 而不是填默认值
 *
 * 若 LLM 不可用时给 `sceneFunction` 填个默认值（如一律 `SETUP`），
 * 模式挖掘会把"所有场景都是 SETUP"当成统计事实 ——
 * 那是**伪造数据**，且无法与真实标注区分。
 *
 * 因此 `annotationJson` 里语义字段为 null/空，并在
 * `annotated: false` 上明确标记。下游可据此决定"这场戏不参与
 * 模式挖掘"，而不是被假数据误导。
 */
import { Logger } from '@nwa/core';
import { SceneSemanticSchema, type SceneAnnotation, type SceneSemantic } from '@nwa/shared';
import { z } from 'zod';
import { segmentScenes, type SegmentedScene, type SegmentOptions } from './scene-segmenter.js';
import { computePacing, computeProse, paragraphsToText } from './metrics.js';

/** 结构化调用（与 gateway 解耦，便于测试替身） */
export type AnnotationStructuredCaller = <T>(req: {
  readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  readonly schemaName: string;
  readonly messages: readonly { role: 'system' | 'user'; content: string }[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}) => Promise<
  | { ok: true; data: T; attempts: number }
  | { ok: false; error: { code: string; message: string }; attempts: number; rawText?: string }
>;

export interface AnnotateOptions {
  readonly logger: Logger;
  /** 语义标注调用器；不传则只做机械指标（离线可用） */
  readonly structured?: AnnotationStructuredCaller;
  readonly segment?: SegmentOptions;
  /** 每个场景的最大标注字符数（超长截断，避免超出 token 预算） */
  readonly maxSceneChars?: number;
}

/** 单场景标注结果 */
export interface AnnotatedScene {
  readonly sceneId: string;
  readonly sceneIndex: number;
  readonly chapterNumber: number | null;
  readonly text: string;
  readonly chars: number;
  readonly paragraphCount: number;
  /** 切分依据（§18） */
  readonly boundaryReason: string;
  readonly boundaryEvidence: string;
  /** 规则对该边界是否不确定（LLM 层介入的入口） */
  readonly boundaryUncertain: boolean;
  /**
   * ⚠ 场景超长且无切分依据（§18 的 LLM 切分入口）。
   *
   * 与 boundaryUncertain 不同：那个是"切了但依据不硬"，
   * 这个是"**没切**，因为找不到依据"。下游统计时应当知道
   * 这类场景内部可能还含多个叙事单元。
   */
  readonly oversized: boolean;
  /** 完整标注（§19） */
  readonly annotation: SceneAnnotation;
  /** ⚠ 语义标注是否成功 —— false 表示语义字段为空，下游不应参与模式挖掘 */
  readonly annotated: boolean;
  /** 语义标注失败原因（annotated=false 时有值） */
  readonly annotationError?: string;
}

export interface AnnotateChapterResult {
  readonly chapterNumber: number | null;
  readonly sceneCount: number;
  readonly annotatedCount: number;
  /** 未成功语义标注的场景数 */
  readonly unannotatedCount: number;
  readonly uncertainBoundaries: number;
  /**
   * ⚠ 超长且无切分依据的场景数。
   *
   * 这类场景**不是错误**，但下游该知道"其内部可能还有边界" ——
   * 若占比高，说明规则层对这份文本的切分能力不足，
   * 该上 LLM 层（§18）。
   */
  readonly oversizedScenes: number;
  readonly scenes: readonly AnnotatedScene[];
}

export class SceneAnnotator {
  private readonly logger: Logger;
  private readonly structured?: AnnotationStructuredCaller;
  private readonly segmentOpts: SegmentOptions;
  private readonly maxSceneChars: number;

  constructor(opts: AnnotateOptions) {
    this.logger = opts.logger;
    this.structured = opts.structured;
    this.segmentOpts = opts.segment ?? {};
    this.maxSceneChars = opts.maxSceneChars ?? 6000;
  }

  /**
   * 标注一章。
   *
   * ⚠ 机械指标**总是**计算；语义标注仅在提供了 structured 时尝试，
   *   失败则该场景 `annotated=false` 且语义字段为空。
   */
  async annotateChapter(req: {
    readonly chapterNumber: number | null;
    readonly text: string;
    readonly documentId: string;
    readonly genre?: string | null;
  }): Promise<AnnotateChapterResult> {
    const scenes = segmentScenes(req.text, this.segmentOpts);
    const out: AnnotatedScene[] = [];
    let annotatedCount = 0;

    for (const sc of scenes) {
      const sceneId = `${req.documentId}_c${req.chapterNumber ?? 0}_s${sc.index}`;
      const text = paragraphsToText(sc.paragraphs);
      const chars = text.length;

      // ── 机械指标（必算，不依赖模型）──
      const pacing = computePacing(sc.paragraphs);
      const prose = computeProse(sc.paragraphs);

      // ── 语义标注（可选）──
      let semantic: SceneSemantic | null = null;
      let annotationError: string | undefined;

      if (this.structured) {
        const res = await this.structured<SceneSemantic>({
          schema: SceneSemanticSchema,
          schemaName: 'SceneSemantic',
          messages: buildMessages(req.chapterNumber, sc, text.slice(0, this.maxSceneChars), req.genre ?? null),
          maxTokens: 2000,
          temperature: 0.1, // 标注要稳、要忠实
        });
        if (res.ok) {
          semantic = res.data;
          annotatedCount++;
        } else {
          // ⚠ 带上模型**原始输出**：只报 "hook.type: Required" 无法判断
          //   模型到底返回了什么（可能它给的是字符串而非对象）。
          //   实测《清纯校花》7 个失败场景就是靠这个才发现根因。
          const head = res.rawText ? `｜原始输出：${res.rawText.slice(0, 400)}` : '';
          annotationError = `${res.error.message}${head}`;
          this.logger.warn('场景语义标注失败（该场景不参与模式挖掘）', {
            sceneId,
            error: res.error.message,
            rawTextHead: res.rawText?.slice(0, 300),
          });
        }
      } else {
        annotationError = '未提供语义标注调用器（仅机械指标模式）';
      }

      const annotation: SceneAnnotation = {
        sceneId,
        characters: semantic?.characters ?? [],
        ...(semantic?.pov ? { pov: semantic.pov } : {}),
        ...(semantic?.setting ? { setting: semantic.setting } : {}),
        ...(semantic?.time ? { time: semantic.time } : {}),
        goals: semantic?.goals ?? [],
        conflicts: semantic?.conflicts ?? [],
        actions: semantic?.actions ?? [],
        emotions: semantic?.emotions ?? [],
        information: semantic?.information ?? [],
        ...(semantic?.eventType ? { eventType: semantic.eventType } : {}),
        // ⚠ 语义标注失败时**不填默认值** —— 那会让下游把伪造数据当统计事实
        ...(semantic?.sceneFunction ? { sceneFunction: semantic.sceneFunction } : {}),
        ...(semantic?.hook ? { hook: semantic.hook } : {}),
        foreshadowing: semantic?.foreshadowing ?? [],
        payoff: semantic?.payoff ?? [],
        // 机械指标恒有值
        pacing,
        prose,
      };

      out.push({
        sceneId,
        sceneIndex: sc.index,
        chapterNumber: req.chapterNumber,
        text,
        chars,
        paragraphCount: sc.paragraphs.length,
        boundaryReason: sc.reason,
        boundaryEvidence: sc.evidence,
        boundaryUncertain: sc.uncertain,
        oversized: sc.oversized,
        annotation,
        annotated: semantic !== null,
        ...(annotationError ? { annotationError } : {}),
      });
    }

    const result: AnnotateChapterResult = {
      chapterNumber: req.chapterNumber,
      sceneCount: out.length,
      annotatedCount,
      unannotatedCount: out.length - annotatedCount,
      uncertainBoundaries: out.filter((s) => s.boundaryUncertain).length,
      // ⚠ 如实报告：这些场景内部可能还含未识别的叙事单元
      oversizedScenes: out.filter((s) => s.oversized).length,
      scenes: out,
    };

    this.logger.info('章节场景标注完成', {
      chapterNumber: req.chapterNumber,
      scenes: result.sceneCount,
      annotated: annotatedCount,
      unannotated: result.unannotatedCount,
    });

    return result;
  }
}

// ── Prompt（§31：模块化） ───────────────────────────────────

function buildSystemPrompt(genre: string | null): string {
  return [
    '你是小说叙事结构分析器。对给定的**单个场景**做结构化标注。',
    '',
    genre ? `本作品类型：${genre}。请按该类型的叙事惯例判断。` : '',
    '',
    '硬性要求：',
    '- **只依据给定文本**，不得推断文本没写的内容。',
    '- 不确定的字段留空（空数组或空字符串），**不要编造**。',
    '- `sceneFunction` 必须从给定的 15 类中选**最贴近的一个**。',
    '',
    '字段说明：',
    '- `goals`：角色想要什么（谁 + 要什么 + 是否达成）。',
    '- `conflicts`：冲突双方 + 内容 + 强度(0~1) + 类型。',
    '- `actions`：发生的关键动作/事件（谁 + 做了什么 + 结果）。',
    '- `emotions`：情绪（谁 + 情绪 + 强度 + 呈现方式）。',
    '  ⚠ `expression` 填 `IMPLIED_BY_BEHAVIOR` 表示"通过行为暗示"，',
    '    填 `STATED` 表示"直接写明情绪词"。请如实区分。',
    '- `information`：信息流（什么信息 + 谁获知 + 谁仍不知道）。',
    '  这是悬念的基础，请特别留意信息不对称。',
    '- `hook`：场景末尾的抓力（类型 + 强度）。仅当确有钩子时填。',
    '- `foreshadowing` / `payoff`：埋下的伏笔 / 回收的伏笔。',
    '',
    '不要输出 `pacing` 或 `prose` —— 那些由系统统计，不由你估计。',
  ]
    .filter((x) => x.length > 0)
    .join('\n');
}

function buildMessages(
  chapterNumber: number | null,
  scene: SegmentedScene,
  text: string,
  genre: string | null,
): { role: 'system' | 'user'; content: string }[] {
  const parts = [
    `【场景信息】`,
    `第 ${chapterNumber ?? '?'} 章｜场景序号 ${scene.index + 1}｜切分依据：${scene.reason}`,
    `段落数：${scene.paragraphs.length}`,
    '',
    '【场景正文】',
    text,
    '',
    '请对该场景做结构化标注。',
  ];
  return [
    { role: 'system', content: buildSystemPrompt(genre) },
    { role: 'user', content: parts.join('\n') },
  ];
}
