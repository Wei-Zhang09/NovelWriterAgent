/**
 * 每章字数目标与偏离检查（P2-1）
 *
 * ## 为什么是"提示"而不是"阻断"
 *
 * 用户决策（2026-09-25）：「章节字数设定，可以在合理范围之内上下浮动」
 * 「允许浮动，但偏离超阈值时提示我（不阻断）」。
 *
 * 这不只是用户的偏好，也是本项目一贯的技术立场：字数是**结果指标**，
 * 不是正确性指标。硬卡字数会直接激励模型为凑数注水 —— 那正是
 * ADR-0007（Naturalness）与 naturalness/detectors.ts 一直在防的东西。
 * 一章 1800 字但紧凑完整，好过 3000 字全是"他深吸一口气"。
 *
 * 因此本模块只**描述**偏离，由调用方决定怎么展示；它不抛错、不阻断。
 * 唯一的例外是**输入校验**（目标值必须是正整数），那是作者手输错误，
 * 越早报越好。
 */
import { AppError, ErrorCode } from './errors.js';

/** 未设定目标时的兜底值（与 Writer 的 wordsPerScene 默认值保持一致） */
export const DEFAULT_TARGET_WORDS_PER_CHAPTER = 2500;

/** 默认偏离容忍度（百分比）：目标 2500 字时，1500~3500 都算正常 */
export const DEFAULT_WORD_TOLERANCE_PCT = 40;

export interface WordCountDeviation {
  /** 实际字数 */
  readonly actual: number;
  /** 目标字数 */
  readonly target: number;
  /** 允许的偏差绝对值（= target × tolerancePct / 100） */
  readonly tolerance: number;
  /** 可接受区间下界（不小于 1） */
  readonly lowerBound: number;
  /** 可接受区间上界 */
  readonly upperBound: number;
  /** 是否在容忍区间内 */
  readonly withinTolerance: boolean;
  /** 'UNDER' | 'OVER' | 'OK' */
  readonly direction: 'UNDER' | 'OVER' | 'OK';
  /** 面向作者的一句话说明（含具体数字，便于判断要不要处理） */
  readonly message: string;
}

/**
 * 校验作者输入的每章目标字数。
 *
 * ⚠ 这是唯一会抛错的路径 —— 校验的是**作者输入**，不是模型产物。
 *   0 / 负数 / 小数都是输入错误，越早报越好；而正文偏离只提示不阻断。
 */
export function assertValidWordTarget(target: number): void {
  if (!Number.isInteger(target) || target <= 0) {
    throw new AppError(
      ErrorCode.TOOL_VALIDATION_ERROR,
      `每章目标字数必须是正整数（收到 ${String(target)}）`,
    );
  }
}

/**
 * 计算正文长度对目标的偏离。
 *
 * ⚠ **永不抛错**：偏离是提示，不是错误。调用方拿到结果自行展示。
 *
 * @param actual        实际字数（通常来自 Writer 的 totalChars）
 * @param target        目标字数（来自 books.target_words_per_chapter）
 * @param tolerancePct  容忍度百分比（来自 books.word_count_tolerance_pct）
 */
export function checkWordCountDeviation(
  actual: number,
  target: number,
  tolerancePct: number = DEFAULT_WORD_TOLERANCE_PCT,
): WordCountDeviation {
  const tolerance = Math.round((target * tolerancePct) / 100);
  // 下界不小于 1：目标极小 + 容忍度极小时，负数下界没有意义
  const lowerBound = Math.max(1, target - tolerance);
  const upperBound = target + tolerance;

  const withinTolerance = actual >= lowerBound && actual <= upperBound;
  const direction: 'UNDER' | 'OVER' | 'OK' =
    actual < lowerBound ? 'UNDER' : actual > upperBound ? 'OVER' : 'OK';

  let message: string;
  if (direction === 'OK') {
    message = `${actual} 字，在目标 ${target} 字的可接受范围（${lowerBound}~${upperBound}）内`;
  } else if (direction === 'UNDER') {
    const diff = lowerBound - actual;
    message =
      `${actual} 字，比目标 ${target} 字少 ${diff} 字（低于下界 ${lowerBound}，` +
      `容忍度 ±${tolerancePct}%）—— 建议补充，但不影响提交`;
  } else {
    const diff = actual - upperBound;
    message =
      `${actual} 字，比目标 ${target} 字多 ${diff} 字（高于上界 ${upperBound}，` +
      `容忍度 ±${tolerancePct}%）—— 建议精简，但不影响提交`;
  }

  return {
    actual,
    target,
    tolerance,
    lowerBound,
    upperBound,
    withinTolerance,
    direction,
    message,
  };
}

/**
 * 把「每章目标字数」换算成 Writer 的每场景目标字数。
 *
 * ⚠ Writer 是**逐场景**生成的（§7.3 约束 3），所以它要的是场景级字数。
 *   换算必须整除向下取整并保证 ≥1，否则会出现"每场景 0 字"这种
 *   让模型无所适从的提示。
 */
export function perSceneWords(chapterTarget: number, sceneCount: number): number {
  if (sceneCount <= 0) return chapterTarget;
  return Math.max(1, Math.floor(chapterTarget / sceneCount));
}
