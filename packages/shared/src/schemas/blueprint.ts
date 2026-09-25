/**
 * 开书向导的模型输出契约（Phase 1：选题方向）
 *
 * ## 用户诉求（2026-09-25 原话）
 *
 * > 「应该配置 ai 生成大纲角色等等相关功能，再由用户进行选择、修改，
 * >    最后确认一切前置信息后，再开始写作呀」
 *
 * ## 参考项目 oh-story-claudecode 的 Phase 1（`workflow-setup.md`）
 *
 * 它先问作者三个问题：
 *   「你想让读者什么感觉？有没有喜欢的书想对标？
 *     你的优势是什么（脑洞好/文笔好/节奏感好/生活经验丰富）？」
 *
 * 然后按优势映射题材：
 *   脑洞好 → 系统文/诸天流/无限流
 *   文笔好 → 仙侠/历史/文艺向都市
 *   节奏感好 → 都市爽文/重生文/游戏文
 *   生活经验丰富 → 行业文/都市日常/种田文
 *
 * ## ⚠ 与本项目已有约束的一致性（重要）
 *
 * 本项目的 `AGENT_PLANNER` 提示词里有一条实测踩出来的铁律：
 *   「字段值必须是**具体的创作决定**，不得写「待确认」「TODO」这类占位文本。
 *     若上下文没有给出角色名/地点名，**由你决定**一个合理的名字并直接使用」
 *
 * 选题方向同理 —— **不得输出"待定"**。模型必须给出可判断的具体方案，
 * 作者才能"选择"。一堆占位符没有可选择性，等于没生成。
 *
 * ## ⚠ 为什么输出**多个候选**而不是一个方案
 *
 * 用户明确要求「再由用户进行**选择**、修改」。只给一个方案的话
 * "选择"这个动作不存在，作者只能"接受或重来"，那是二选一不是选择。
 *
 * ⚠ 但候选数**有上限且刻意偏小**（3 个）：
 *   候选一多，每个的质量都会下降，且作者的比较成本上升 ——
 *   3 个是"有得挑"与"挑得动"的平衡点。
 *
 * ## ⚠ 可计算字段不进模型契约
 *
 * 与 `annotation.ts` 同一条原则：`estimatedChapters` 这类**能从别处算出来**
 * 的值不让模型估。模型估的数不可复现（随提示词与采样变化），
 * 而一个"看起来合理"的估计值与真实测量值在下游无法区分。
 * 这里保留它的唯一理由是：**它是创作决定**（这本书打算写多长），
 * 不是从文本推导出来的量。所以它是必填的**意图**，不是"估计值"。
 */
import { z } from 'zod';

/**
 * 单条选题候选。
 *
 * ⚠ 字段的取舍标准：**每个字段都必须是作者能据以做决定的**。
 *   放一个模型自己也说不清的字段（如"创新度 0.73"）只会制造噪音 ——
 *   数字看起来客观，实际不可复现，还会挤占作者的注意力。
 */
export const ConceptCandidateSchema = z.object({
  /** 一句话卖点：作者扫一眼就知道这本书讲什么 */
  pitch: z.string().min(5, '一句话卖点不得为空').max(300),
  /** 题材（会被 normalizeGenre 归一化，如"都市校园"→"都市"） */
  genre: z.string().min(1).max(50),
  /** 想让读者产生的核心情绪（对标 oh-story 的"你想让读者什么感觉"） */
  coreEmotion: z.string().min(2).max(100),
  /**
   * 主角设定摘要。
   *
   * ⚠ 为什么是字符串而不是结构化的角色对象：
   *   这一步产出的是**方向**，角色卡是 Phase 2 的事。
   *   在方向阶段就要求完整角色结构，会让模型把精力放在填字段上，
   *   而不是把方向想清楚。
   */
  protagonist: z.string().min(2).max(300),
  /** 核心冲突：这本书的主要张力来自什么 */
  coreConflict: z.string().min(5).max(400),
  /** 差异化：凭什么与同类书不同（对标 oh-story 的"差异化"） */
  differentiation: z.string().min(5).max(400),
  /** 打算写多少章（创作意图，不是估计值） */
  estimatedChapters: z.number().int().min(10).max(5000),
});

export type ConceptCandidate = z.infer<typeof ConceptCandidateSchema>;

/**
 * Phase 1 的完整输出：若干候选。
 *
 * ⚠ 下限 2、上限 3：
 *   下限 2 保证"选择"这个动作有意义；
 *   上限 3 保证每个候选的质量（候选越多，单个越敷衍）。
 *   zod 的 min/max 会拒绝不合规的输出，而不是默默接受 ——
 *   这是"宿主绝不抠 JSON、也不容错到失真"原则的延续。
 */
export const ConceptOutputSchema = z.object({
  candidates: z.array(ConceptCandidateSchema).min(2).max(3),
});

export type ConceptOutput = z.infer<typeof ConceptOutputSchema>;

/**
 * 用户确认/编辑后的选题（进入 Phase 2 的输入）。
 *
 * ⚠ 与候选的区别：候选是**备选方案**，这个是**定下来的那一个**。
 *   分开两个 schema 而不是复用，是因为它们的必填项不同 ——
 *   定稿必须明确"为什么选它"，而候选不需要解释自己为什么存在。
 */
export const BlueprintConceptSchema = ConceptCandidateSchema.extend({
  /** 作者选择它的理由（可空：作者可能只是觉得顺眼） */
  selectedReason: z.string().max(500).nullable(),
});

export type BlueprintConcept = z.infer<typeof BlueprintConceptSchema>;

/**
 * 给模型看的 JSON 形状提示。
 *
 * ⚠ 与 `PLAN_SHAPE_HINT` 同一条设计：形状提示是**契约的一部分**，
 *   放在 schema 旁边而不是散在提示词里 —— 否则改了 schema 忘了改提示词，
 *   模型就会按旧形状输出，然后被 schema 拒绝。
 */
export const CONCEPT_SHAPE_HINT = `{
  "candidates": [
    {
      "pitch": "一句话卖点，如：退役拳手回到小城开拳馆，却发现徒弟在打地下黑拳",
      "genre": "都市",
      "coreEmotion": "意难平",
      "protagonist": "主角是谁、他有什么旧伤或执念",
      "coreConflict": "核心冲突是什么，张力从哪来",
      "differentiation": "与同类书的差异在哪",
      "estimatedChapters": 200
    }
  ]
}`;

/**
 * 校验选题的**业务约束**（超出 zod 能表达的范围）。
 *
 * 返回问题列表（空数组表示通过）。设计成返回列表而不是抛错，
 * 与 `validatePlanSemantics` 一致 —— 调用方可以据此做一次自我修复重试。
 */
export function validateConceptSemantics(output: ConceptOutput): string[] {
  const issues: string[] = [];

  // 1. 占位符检测 —— 与 AGENT_PLANNER 的同一条实测教训
  const PLACEHOLDERS = ['待确认', '待定', 'TODO', 'todo', '例如…', '（此处填写）', 'xxx'];
  for (const [i, c] of output.candidates.entries()) {
    for (const [field, value] of Object.entries(c)) {
      if (typeof value !== 'string') continue;
      for (const p of PLACEHOLDERS) {
        if (value.includes(p)) {
          issues.push(`candidates[${i}].${field} 含占位文本「${p}」—— 必须给出具体决定`);
        }
      }
    }
  }

  // 2. 候选之间必须真的不同。
  //
  // ⚠ 这不是形式要求：模型在"给多个候选"的任务上容易给出
  //   **同一个方向的三种说法**（换了措辞但卖点相同）。
  //   那样作者没有可选择性，而界面看起来"生成了 3 个候选"——
  //   比只给 1 个更糟，因为它假装给了选择。
  const pitches = output.candidates.map((c) => c.pitch.trim());
  const uniquePitches = new Set(pitches);
  if (uniquePitches.size !== pitches.length) {
    issues.push('候选之间存在完全相同的 pitch —— 请给出真正不同的方向');
  }

  // 3. 题材不得全部相同：三个候选都是同一题材，等于没得选
  const genres = new Set(output.candidates.map((c) => c.genre.trim()));
  if (genres.size === 1 && output.candidates.length > 1) {
    issues.push(
      `全部候选都是「${[...genres][0]}」题材 —— 作者无从选择，请给出不同题材方向`,
    );
  }

  return issues;
}
