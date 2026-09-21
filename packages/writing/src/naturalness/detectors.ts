/**
 * Naturalness 确定性正则检测器（ADR-0007 第二层）
 *
 * 设计约束：
 *   1. **纯正则/纯字符串操作，不得调用 LLM**（零成本、零延迟、不产生幻觉）
 *   2. 每个 code 必须有正例与反例单测，反例须是**合法的文学表达**
 *   3. severity 映射：critical→BLOCKING / high→MAJOR / medium→MINOR
 */
import type { ReviewSeverity } from '@nwa/shared';

export type ProseCode =
  | 'prose_negative_flip'
  | 'prose_dash_or_ellipsis'
  | 'prose_period_stutter'
  | 'prose_long_paragraph'
  | 'prose_verbatim_repeat'
  | 'prose_truncation'
  | 'prose_ai_self_reference'
  | 'prose_placeholder_leak'
  | 'prose_engineering_term_leak'
  // 本项目新增（ADR-0007）
  | 'prose_cjk_punct_mix'
  | 'prose_repeat_opening';

export interface ProseIssue {
  readonly code: ProseCode;
  readonly severity: ReviewSeverity;
  /** 命中的原文片段（供 UI 定位） */
  readonly excerpt: string;
  /** 段落序号（1-based） */
  readonly paragraph: number;
  readonly detail: string;
}

interface DetectorRule {
  readonly code: ProseCode;
  readonly severity: ReviewSeverity;
  readonly detail: string;
  /** 段级检测：返回 true 表示命中 */
  readonly testParagraph: (p: string) => boolean;
  /** 全文级检测：返回命中的段落号 */
  readonly testDocument?: (paragraphs: readonly string[]) => number[];
}

/** 我们项目特有的内部术语 —— 极易被模型直接写进正文（ADR-0007 的核心关切） */
const ENGINEERING_STRONG = [
  '细纲', '情节点', '卷纲', '功能标签', '目标情绪', '字数目标', '章首钩子',
  '任务单', 'scene card', 'prompt', 'schema', '上下文包', '系统提示词', '修复指令',
  // 本项目特有
  'ChapterBrief', 'ScenePlan', 'Canon', 'canon', '事实表', '伏笔回收',
  '章节摘要', '状态机', 'checkpoint', 'Checkpoint', 'Run ID', 'commit',
  'BLOCKING', 'severity', 'workspace', 'Review 通过', 'Continuity',
];

/** 弱工程词：正常叙事中也可能出现，降为 MINOR */
const ENGINEERING_WEAK = [
  '本章', '下一章', '读者', '伏笔', '前文', '后文', '剧情推进', '人物弧光', '爽点', '节奏点', '钩子',
];

const PLACEHOLDER_PATTERNS = [
  /\bTODO\b/, /\bTBD\b/, /待补充/, /此处省略/, /略写/, /占位/, /PLACEHOLDER/i, /\{\{[^}]*\}\}/,
];

const AI_SELF_PATTERNS = [
  /作为\s*AI/i, /我是\s*AI/i, /我无法创作/, /无法满足该请求/, /\bas an AI\b/i, /语言模型/,
];

const TERMINAL_PUNCT = /[。！？…"」』）\)\]】》.?!]$/;

export const DETECTOR_RULES: readonly DetectorRule[] = [
  {
    code: 'prose_negative_flip',
    severity: 'MAJOR',
    detail: '否定翻转句式（不是……而是……）',
    testParagraph: (p) => /不是[^，。]{1,20}[，,]?\s*(?:而是|却是|反而是|更像是|只是)/.test(p)
      || /并非[^，。]{1,20}[，,]?\s*(?:而是|却是)/.test(p),
  },
  {
    code: 'prose_dash_or_ellipsis',
    severity: 'MAJOR',
    detail: '破折号/省略号滥用',
    // 对话行豁免（合法的停顿）
    testParagraph: (p) => {
      if (/^\s*["'"「"『]/.test(p)) return false;
      const dashes = (p.match(/——|—|--/g) ?? []).length;
      const ell = (p.match(/……|…{2,}|\.{3,}/g) ?? []).length;
      return dashes >= 2 || ell >= 2;
    },
  },
  {
    code: 'prose_period_stutter',
    severity: 'MINOR',
    detail: '连续短句碎句（≥6 个 ≤8 字短句）',
    testParagraph: (p) => {
      if (/^\s*["'"「"『]/.test(p)) return false;
      const sentences = p.split(/[。！？]/).filter((s) => s.trim().length > 0);
      let run = 0;
      for (const s of sentences) {
        if (s.trim().length <= 8) { run++; if (run >= 6) return true; } else run = 0;
      }
      return false;
    },
  },
  {
    code: 'prose_long_paragraph',
    severity: 'MINOR',
    detail: '段落超过 220 字',
    testParagraph: (p) => p.replace(/\s/g, '').length > 220,
  },
  {
    code: 'prose_truncation',
    severity: 'BLOCKING',
    detail: '正文疑被截断（结尾无终结标点）',
    testParagraph: () => false,
    testDocument: (ps) => {
      const last = ps.filter((p) => p.trim().length > 0).at(-1);
      if (!last) return [];
      const visible = last.replace(/\s/g, '');
      return visible.length >= 80 && !TERMINAL_PUNCT.test(visible) ? [ps.length] : [];
    },
  },
  {
    code: 'prose_ai_self_reference',
    severity: 'BLOCKING',
    detail: 'AI 自述/拒绝话术泄漏',
    testParagraph: (p) => AI_SELF_PATTERNS.some((r) => r.test(p)),
  },
  {
    code: 'prose_placeholder_leak',
    severity: 'BLOCKING',
    detail: '占位符泄漏',
    testParagraph: (p) => PLACEHOLDER_PATTERNS.some((r) => r.test(p)),
  },
  {
    code: 'prose_engineering_term_leak',
    severity: 'MAJOR',
    detail: '工程术语泄漏（强）',
    testParagraph: (p) => ENGINEERING_STRONG.some((t) => p.includes(t)),
  },
  {
    code: 'prose_cjk_punct_mix',
    severity: 'MINOR',
    detail: '中英标点混用',
    // 中文语境里出现半角 , . ! ?（数字与英文缩写除外）
    testParagraph: (p) => /[\u4e00-\u9fff][,;!?]/.test(p) || /[,;!?][\u4e00-\u9fff]/.test(p)
      || /[\u4e00-\u9fff]\.(?![0-9a-zA-Z])/.test(p),
  },
  {
    code: 'prose_repeat_opening',
    severity: 'MINOR',
    detail: '连续段落以相同开头（≥3 段同 2-4 字开头）',
    testParagraph: () => false,
    testDocument: (ps) => {
      const hits: number[] = [];
      let prev = '';
      let run = 1;
      ps.forEach((p, i) => {
        const head = p.trim().slice(0, 3);
        if (head.length >= 2 && head === prev) {
          run++;
          if (run >= 3) hits.push(i + 1);
        } else {
          run = 1;
        }
        // ⚠ 必须无条件更新 prev：若只在 else 分支更新，
        //   一旦出现"命中→未命中→命中"的模式，比较链就断裂（本处曾有此 bug）。
        prev = head.length >= 2 ? head : prev;
      });
      return hits;
    },
  },
];

/** 全文级规则：跨段落检测（复读、截断、段首雷同） */
const DOCUMENT_RULES = [
  ...DETECTOR_RULES.filter((r) => r.testDocument),
  {
    code: 'prose_verbatim_repeat' as ProseCode,
    severity: 'BLOCKING' as ReviewSeverity,
    detail: '相邻段落复读或同句反复出现',
    testDocument: (ps: readonly string[]): number[] => {
      const hits: number[] = [];
      for (let i = 1; i < ps.length; i++) {
        const a = ps[i - 1]!.replace(/\s/g, '');
        const b = ps[i]!.replace(/\s/g, '');
        if (a.length >= 8 && a === b) hits.push(i + 1);
      }
      const sentences = new Map<string, number>();
      for (const p of ps) {
        for (const s of p.split(/[。！？]/)) {
          const t = s.trim();
          if (t.length < 12) continue;
          sentences.set(t, (sentences.get(t) ?? 0) + 1);
        }
      }
      for (const [, count] of sentences) if (count >= 3) hits.push(1);
      return [...new Set(hits)];
    },
  },
];

/** 段落切分：以空行分隔，过滤纯空白 */
export function splitParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * 运行全部确定性检测器。
 *
 * ⚠ 本函数不得调用任何模型。ADR-0007 明确要求它是零成本、零延迟、无幻觉的最后一道闸门。
 */
export function detectProseIssues(text: string): ProseIssue[] {
  const paragraphs = splitParagraphs(text);
  const issues: ProseIssue[] = [];

  paragraphs.forEach((p, idx) => {
    for (const rule of DETECTOR_RULES) {
      if (rule.testParagraph(p)) {
        issues.push({
          code: rule.code,
          severity: rule.severity,
          excerpt: p.slice(0, 60),
          paragraph: idx + 1,
          detail: rule.detail,
        });
      }
    }
  });

  for (const rule of DOCUMENT_RULES) {
    if (!rule.testDocument) continue;
    for (const pIdx of rule.testDocument(paragraphs)) {
      issues.push({
        code: rule.code,
        severity: rule.severity,
        excerpt: (paragraphs[pIdx - 1] ?? '').slice(0, 60),
        paragraph: pIdx,
        detail: rule.detail,
      });
    }
  }

  // 弱工程词单独检查，降为 MINOR
  paragraphs.forEach((p, idx) => {
    const hit = ENGINEERING_WEAK.find((t) => p.includes(t));
    if (hit) {
      issues.push({
        code: 'prose_engineering_term_leak',
        severity: 'MINOR',
        excerpt: p.slice(0, 60),
        paragraph: idx + 1,
        detail: `弱工程词泄漏：${hit}`,
      });
    }
  });

  return issues;
}

/** 是否应阻断 Commit（ADR-0007 的 severity 映射） */
export function hasBlockingProseIssue(issues: readonly ProseIssue[]): boolean {
  return issues.some((i) => i.severity === 'BLOCKING');
}
