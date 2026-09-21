/**
 * Prompt 模块化（施工文档 §31）
 *
 * §31 明确：「不要写一个 10,000 字的大 Prompt」，采用四目录结构：
 *   system/   身份、安全、核心规则
 *   agent/    各 Agent 的角色定义
 *   task/     具体任务指令
 *   context/  上下文模板
 *
 * 本模块把 Prompt 作为**可版本化、可测试的数据**管理，
 * 而不是散落在代码里的模板字符串拼接。
 *
 * ⚠ 一条硬规则（研究报告 §1.2 决策 4）：
 *   所有需要结构化输出的 prompt 必须显式要求「只输出 JSON，不要解释」，
 *   并且宿主**不**尝试从散文里抠 JSON。
 */
import type { ChatMessage } from '@nwa/harness';

/** Prompt 片段：带 id 便于版本化与测试断言 */
export interface PromptBlock {
  readonly id: string;
  readonly text: string;
}

// ── system/ ──────────────────────────────────────────────────

export const SYSTEM_IDENTITY: PromptBlock = {
  id: 'system.identity',
  text: [
    '你是一个长篇小说创作流水线中的一个专职 Agent。',
    '你只负责被分配的那一步，不越界、不擅自扩写其他步骤的工作。',
  ].join('\n'),
};

export const SYSTEM_SAFETY: PromptBlock = {
  id: 'system.safety',
  text: [
    '不得复制任何参考作品的原文。',
    '不得为了「像人写作」而故意制造低质量表达。',
    '不确定的事实时不要自行创造，而应在输出中标记为待确认。',
  ].join('\n'),
};

/**
 * 核心规则（施工文档 §31.1 的 10 条，作用于全部 Agent）
 */
export const SYSTEM_CORE_RULES: PromptBlock = {
  id: 'system.core-rules',
  text: [
    '1. Canon 是事实来源。',
    '2. 不确定事实时不要自行创造。',
    '3. 不得修改 Canon。',
    '4. 当前章节 Plan 优先于临时自由发挥。',
    '5. Skill 是策略建议，不是必须逐条执行。',
    '6. 不复制参考作品原文。',
    '7. 不为了「像人」故意制造低质量语言。',
    '8. 优先通过场景、行动、对白呈现，而不是解释。',
    '9. 保持人物已有动机和声音。',
    '10. 每个 Scene 必须改变至少一个状态：goal / information / relationship / risk / location / resource。',
  ].join('\n'),
};

// ── agent/ ───────────────────────────────────────────────────

export const AGENT_PLANNER: PromptBlock = {
  id: 'agent.planner',
  text: [
    '你是 Planner。职责：把一章的目标拆成可执行的场景计划。',
    '你不写正文。你只产出结构与约束，供 Writer 使用。',
    '',
    '要求：',
    '- 每个场景必须推进至少一个状态（goal / information / relationship / risk / location / resource）。',
    '- 必须明确 requiredEvents（不可缺少）与 forbiddenEvents（不得越界）。',
    '- 章末必须留下钩子（hook），不要用总结句收尾。',
    '- 伏笔动作分三类：plant（登记）/ reinforce（推进）/ payoff（回收）。',
    '',
    '⚠ 关于占位符（实测踩到）：',
    '- 字段值必须是**具体的创作决定**，不得写「待确认」「TODO」「待定」',
    '  「例如…」「（此处填写）」这类占位文本。',
    '- 若上下文没有给出角色名/地点名，**由你决定**一个合理的名字并直接使用，',
    '  而不是把「待确认」写进字段。你是规划者，命名是你的职责。',
    '- 示例：不要写 hook="待确认：章末钩子，例如主角发现关键物品"，',
    '  而要写 hook="他在账本里认出了父亲的字迹"。',
    '',
    '⚠ 关于材料不足：',
    '- 上下文里没有的信息（世界观、前情），用最少的合理设定补齐并保持自洽，',
    '  不要写「待确认」。后续章节会以本章产出为准继续。',
  ].join('\n'),
};

// ── task/ ────────────────────────────────────────────────────

/**
 * 结构化输出指令。
 *
 * 这是「宿主绝不抠 JSON」原则的前半句 —— 明确告诉模型必须只输出 JSON。
 * 后半句在代码里：解析失败就重试/降级，绝不做启发式提取。
 */
export function structuredTaskBlock(schemaName: string, shapeHint: string): PromptBlock {
  return {
    id: `task.structured.${schemaName}`,
    text: [
      `以 JSON 输出一个 ${schemaName} 对象。`,
      '**只输出 JSON 本身**，不要 markdown 代码围栏、不要前后解释、不要多余文字。',
      '',
      '期望结构：',
      shapeHint,
    ].join('\n'),
  };
}

export const TASK_PLAN_CHAPTER: PromptBlock = {
  id: 'task.plan-chapter',
  text: [
    '任务：为下面这一章生成 Chapter Brief 与场景计划。',
    '',
    '注意：',
    '- previousState 描述本章开始时的处境；targetState 描述本章结束时应当达到的处境。',
    '- 二者必须不同，否则这一章没有存在意义。',
    '- mainCharacters 只能包含上下文中已知的角色名。',
    '- 不要引入上下文中不存在的设定。',
  ].join('\n'),
};

/** Plan 的 JSON 形状提示（供模型对齐，也作为文档） */
export const PLAN_SHAPE_HINT = `{
  "brief": {
    "chapterNumber": 1,
    "purpose": "本章为什么存在",
    "previousState": "开始时的处境",
    "targetState": "结束时的处境",
    "mainCharacters": ["角色名"],
    "locations": ["地点"],
    "requiredEvents": ["必须发生的事"],
    "forbiddenEvents": ["不得发生的事"],
    "emotionalArc": "情绪走向",
    "pacingPlan": "节奏安排",
    "foreshadowing": { "plant": [], "reinforce": [], "payoff": [] },
    "hook": "章末钩子",
    "skillRefs": []
  },
  "scenes": [
    {
      "sceneId": "s1",
      "purpose": "本场景目的",
      "pov": "视角",
      "setting": "设定",
      "startState": "开始时状态",
      "endState": "结束时状态（必须与 startState 不同）",
      "goal": "目标",
      "conflict": "冲突",
      "obstacle": "障碍",
      "emotionalCurve": "情绪曲线",
      "pacing": "节奏",
      "activeSkills": [],
      "continuityConstraints": []
    }
  ]
}`;

// ── 组装 ────────────────────────────────────────────────────

/** 拼接多个 PromptBlock，用于组装 system 消息 */
export function joinBlocks(...blocks: readonly PromptBlock[]): string {
  return blocks.map((b) => b.text).join('\n\n');
}

/**
 * 组装聊天消息。
 *
 * 结构固定为：[system 身份+规则] → [agent 角色] → [context 上下文] → [task 任务指令]
 * 这个顺序是有意的：规则在前、上下文在中、指令在后（模型对末尾指令最敏感）。
 */
export function buildMessages(input: {
  agent: PromptBlock;
  contextText?: string;
  task: readonly PromptBlock[];
}): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { role: 'system', content: joinBlocks(SYSTEM_IDENTITY, SYSTEM_SAFETY, SYSTEM_CORE_RULES) },
    { role: 'system', content: input.agent.text },
  ];
  if (input.contextText && input.contextText.trim().length > 0) {
    msgs.push({ role: 'user', content: `以下是本章可用的上下文：\n\n${input.contextText}` });
  }
  msgs.push({ role: 'user', content: joinBlocks(...input.task) });
  return msgs;
}
