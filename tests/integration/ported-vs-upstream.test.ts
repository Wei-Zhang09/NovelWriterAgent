/**
 * ⚠⚠ 移植保真度交叉验证 —— 与**上游脚本实测结果**逐条比对。
 *
 * ## 为什么需要这个文件（而不只是手写用例）
 *
 * 移植的验收标准是「与上游一致」，不是「我觉得应该命中」。
 * 手写用例反映的是我的理解，而我的理解会错 —— 本轮实测就错了两次：
 *   ① 我以为「没有灯光，没有声音。」（两处否定）该命中，
 *      上游实际返回空（其正则要求三处否定）；
 *   ② 我以为 40 段填充能把开头推出章末窗口，上游实际仍命中
 *      （窗口按**字数**回看 600 字，不是按段数）。
 * 两次都是**断言写错**而非移植写错。若只靠手写用例，
 * 我就会把正确实现改坏去迎合错误预期 —— 这是移植任务最危险的失败模式。
 *
 * ## 期望值来源
 *
 * 直接跑 oh-story-claudecode 的 check-ai-patterns.js 在每条样本上的输出，
 * 再映射其 type → 本项目 code。生成脚本为一次性工具，不入库。
 *
 * ⚠ 上游改了正则/阈值后，这里要么同步更新，要么明确记录「本项目有意偏离」。
 */
import { describe, expect, it } from 'vitest';
import { detectAiPatterns } from '@nwa/writing';

/** 本项目移植覆盖的 7 类 */
const PORTED = new Set([
  'not_is_comparison', 'reverse_not_is', 'voice_contrast',
  'negation_parade', 'trailer_ending', 'trailer_summary', 'em_dash',
]);

interface Case { readonly text: string; readonly upstream: readonly string[] }

/** 样本 → 上游实测命中的 code 集合 */
const CASES: readonly Case[] = [
  { text: "这不是结束，而是开始。", upstream: ["not_is_comparison"] },
  { text: "那不是退缩是策略。", upstream: ["not_is_comparison"] },
  { text: "这不是失败，是提醒。", upstream: ["not_is_comparison"] },
  { text: "「这不是我的错，是他先动手的。」", upstream: [] },
  { text: "他是不是走了，而是留下？", upstream: [] },
  { text: "不是他不想去，也不是他不敢去。", upstream: [] },
  { text: "不是钱的问题，就是时间不够。", upstream: [] },
  { text: "他不是本地人。", upstream: [] },
  { text: "这是策略，不是退缩。", upstream: ["reverse_not_is"] },
  { text: "他就是那样，不是装的。", upstream: [] },
  { text: "他还是老样子，不是改了。", upstream: [] },
  { text: "这是真的，不是吗。", upstream: [] },
  { text: "是不是真的，不是重点。", upstream: [] },
  { text: "他声音不大，却让全场安静下来。", upstream: ["voice_contrast"] },
  { text: "声音不高，但每个字都砸在地上。", upstream: ["voice_contrast"] },
  { text: "「我声音不大，却听得见。」", upstream: [] },
  { text: "他声音不大。", upstream: [] },
  { text: "没有灯光，没有声音。", upstream: [] },
  { text: "没有灯光，没有声音，没有温度。", upstream: ["negation_parade"] },
  { text: "没人在意，没有人在看，只是他还在站着。", upstream: ["negation_parade"] },
  { text: "没有灯光。", upstream: [] },
  { text: "他站起身，走出门去。\n\n没人知道接下来会发生什么。", upstream: ["trailer_ending"] },
  { text: "这一夜注定无眠。", upstream: ["trailer_summary"] },
  { text: "他停住了——不是因为害怕。", upstream: ["em_dash"] },
  { text: "他停住了—不是因为害怕。", upstream: ["em_dash"] },
  { text: "他停住了……不是因为害怕。", upstream: [] },
  { text: "雨落在青石板上。\n\n他把伞收起来，靠在门边。\n\n屋里没有人。", upstream: [] },
  { text: "这一夜注定无眠。\n\n就这样，一切都结束了。", upstream: ["trailer_summary"] },
  { text: "正朝着他压了过来。", upstream: ["trailer_ending"] },
  { text: "新的篇章就此展开。", upstream: ["trailer_summary"] },
  { text: "命运的齿轮开始转动。", upstream: ["trailer_summary"] },
];

describe('移植保真度：与上游脚本实测结果逐条比对', () => {
  for (const [i, c] of CASES.entries()) {
    it('样本 ' + String(i).padStart(2, '0') + '：' + JSON.stringify(c.text).slice(0, 30), () => {
      const paras = c.text.split(/\n\s*\n/).filter((x) => x.trim().length > 0);
      const mine = [
        ...new Set(
          detectAiPatterns(paras)
            .filter((h) => PORTED.has(h.code))
            .map((h) => h.code),
        ),
      ].sort();
      expect(mine).toEqual([...c.upstream]);
    });
  }
});
