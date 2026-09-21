/**
 * Naturalness 确定性检测器测试（ADR-0007）
 *
 * 硬要求：每个 code 至少一正一反；**反例必须是合法的文学表达**
 *        （否则检测器会在真实写作中持续误报）。
 * 铁律：本模块不得调用 LLM。
 */
import { describe, it, expect } from 'vitest';
import { detectProseIssues, hasBlockingProseIssue, splitParagraphs } from '@nwa/writing';

const codes = (text: string) => detectProseIssues(text).map((i) => i.code);

describe('段落切分', () => {
  it('按空行切分并丢弃空白段', () => {
    expect(splitParagraphs('甲\n\n乙\n\n\n丙')).toEqual(['甲', '乙', '丙']);
  });
});

describe('prose_truncation（BLOCKING）', () => {
  it('正例：结尾无终结标点', () => {
    const text = '这是一段足够长的正文内容，用来测试截断检测是否生效，长度需要超过八十个字符才可以被判定为可疑截断' + '补充内容'.repeat(10);
    expect(codes(text)).toContain('prose_truncation');
  });
  it('反例：正常收尾不报', () => {
    expect(codes('他走了。')).not.toContain('prose_truncation');
  });
});

describe('prose_ai_self_reference（BLOCKING）', () => {
  it('正例：AI 自述泄漏', () => {
    expect(codes('作为AI，我无法创作这部分内容。')).toContain('prose_ai_self_reference');
  });
  it('反例：角色自称「我」不报', () => {
    expect(codes('我不是这样想的。')).not.toContain('prose_ai_self_reference');
  });
});

describe('prose_placeholder_leak（BLOCKING）', () => {
  it('正例：占位符', () => {
    expect(codes('此处省略战斗过程。')).toContain('prose_placeholder_leak');
    expect(codes('后天补充细节。')).not.toContain('prose_placeholder_leak');
    expect(codes('待补充')).toContain('prose_placeholder_leak');
  });
});

describe('prose_engineering_term_leak（本项目核心关切）', () => {
  it('正例：强工程词泄漏（我们的内部术语极易被写进正文）', () => {
    expect(codes('本章的目标情绪是压抑。')).toContain('prose_engineering_term_leak');
    expect(codes('按 ChapterBrief 的要求推进剧情。')).toContain('prose_engineering_term_leak');
    expect(codes('这条伏笔回收得恰到好处。')).toContain('prose_engineering_term_leak');
  });
  it('弱工程词降为 MINOR', () => {
    const issues = detectProseIssues('本章风很大。');
    const weak = issues.find((i) => i.code === 'prose_engineering_term_leak');
    expect(weak?.severity).toBe('MINOR');
  });
});

describe('prose_dash_or_ellipsis', () => {
  it('正例：叙述行破折号滥用（≥2）', () => {
    expect(codes('他来了——又走了——没留下话。')).toContain('prose_dash_or_ellipsis');
  });
  it('反例：对话行中的停顿属合法文学表达，必须豁免', () => {
    expect(codes('"我……我不知道。"')).not.toContain('prose_dash_or_ellipsis');
  });
});

describe('prose_negative_flip', () => {
  it('正例：不是……而是……', () => {
    expect(codes('他不是走了，而是逃了。')).toContain('prose_negative_flip');
  });
  it('反例：单纯否定句不报', () => {
    expect(codes('他没有回头。')).not.toContain('prose_negative_flip');
  });
});

describe('prose_verbatim_repeat（BLOCKING）', () => {
  it('正例：相邻段落完全相同', () => {
    const p = '夜色沉沉，江面上没有一丝风，远处传来断续的钟声。';
    expect(codes(`${p}\n\n${p}`)).toContain('prose_verbatim_repeat');
  });
  it('反例：不同段落不报', () => {
    expect(codes('夜色沉沉。\n\n天亮了。')).not.toContain('prose_verbatim_repeat');
  });
});

describe('prose_long_paragraph / period_stutter', () => {
  it('正例：超长段落', () => {
    expect(codes('字'.repeat(230))).toContain('prose_long_paragraph');
  });
  it('反例：正常长度段落不报', () => {
    expect(codes('字'.repeat(100))).not.toContain('prose_long_paragraph');
  });
  it('正例：连续短句碎句', () => {
    expect(codes('他走。她看。风停。云散。花落。人去。')).toContain('prose_period_stutter');
  });
});

describe('prose_cjk_punct_mix（本项目新增）', () => {
  it('正例：中文句中出现半角逗号', () => {
    expect(codes('他来了,又走了。')).toContain('prose_cjk_punct_mix');
  });
  it('反例：纯中文标点不报', () => {
    expect(codes('他来了，又走了。')).not.toContain('prose_cjk_punct_mix');
  });
  it('反例：小数与版本号不报', () => {
    expect(codes('耗时 1.5 秒。')).not.toContain('prose_cjk_punct_mix');
  });
});

describe('prose_repeat_opening（本项目新增）', () => {
  it('正例：连续三段以相同 3 字开头', () => {
    // 注意：比较的是段落前 3 个字，因此测试输入必须让前 3 字真正相同
    expect(codes('他没有说话。\n\n他没有回头。\n\n他没有停下。')).toContain('prose_repeat_opening');
  });
  it('反例：开头各不相同不报', () => {
    expect(codes('他看着她。\n\n天已经黑了。\n\n风从窗缝钻进来。')).not.toContain('prose_repeat_opening');
  });
});

describe('severity → Commit 门禁映射（ADR-0007）', () => {
  it('critical 级问题应阻断 Commit', () => {
    expect(hasBlockingProseIssue(detectProseIssues('作为AI，我无法创作。'))).toBe(true);
  });
  it('仅 MINOR 问题不应阻断 Commit', () => {
    // 用「以句号收尾的超长段落」隔离出唯一 MINOR（prose_long_paragraph），
    // 避免掺入 prose_truncation（BLOCKING）造成断言歧义。
    const text = '字'.repeat(230) + '。';
    const issues = detectProseIssues(text);
    expect(issues.every((i) => i.severity !== 'BLOCKING')).toBe(true);
    expect(hasBlockingProseIssue(issues)).toBe(false);
  });
  it('超长且无终结标点会同时触发截断（BLOCKING）', () => {
    expect(hasBlockingProseIssue(detectProseIssues('字'.repeat(230)))).toBe(true);
  });
  it('干净文本零问题', () => {
    expect(detectProseIssues('张三推开门，走了进去。屋里没人。')).toEqual([]);
  });
});
