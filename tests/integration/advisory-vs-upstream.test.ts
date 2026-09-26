/**
 * ⚠⚠ 移植保真度交叉验证 —— advisory 14 类，与**上游脚本实测结果**逐条比对。
 *
 * ## 为什么必须跑上游而不是手写期望
 *
 * 移植的验收标准是「与上游一致」，不是「我觉得应该命中」。
 * 手写用例反映的是我的理解，而我的理解会错 —— 一旦把正确实现改坏去
 * 迎合错误预期，就是移植任务最危险的失败模式。
 *
 * ## ⚠ 两组样本缺一不可（这是本文件的核心设计）
 *
 * 单靠任一组都会得到**假绿**：
 *
 *   ① **真人语料**（上游 demo 正文）—— 反向对照。
 *      这 14 类在上游都是按「真人语料命中 ≈0」校准的 advisory，
 *      所以**两边都空**是**正确**结果。但"两边都空"本身不构成证据 ——
 *      一个把函数体写成 `return []` 的空壳实现也能全绿。
 *
 *   ② **构造正例** —— 每类一个 fixture，证明检测器**真的能命中**。
 *      期望值同样来自跑上游（见下方 FIXTURES 的 upstream 字段）。
 *
 *   只有 ①+② 同时通过，才排除「空壳」和「过报」两个方向。
 *
 * ## ⚠ 上游 `--json` 有 finding 时 exit 1
 *
 * 第一版用 `execFileSync`，它在非零退出时抛异常 → 我 `catch { continue }`
 * 把**每一个有命中的样本都跳过了**，于是比对只在"空 chunk"上跑，
 * 得出"0 处不一致"的假绿。必须用 `spawnSync` 读 stdout，不看退出码。
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findAbstractSummaryTic,
  findActionListTic,
  findClicheDensityTic,
  findFormulaicParallelism,
  findLongParagraphs,
  findLowConnectiveDensityTic,
  findMetaphorDensityTic,
  findMicroActionTic,
  findNoticeFormalityTic,
  findOvercompressedProseTic,
  findPeriodStutter,
  findQuoteEmphasisTic,
  findReasoningChainTic,
  findStockReactionTic,
  type AdvisoryHit,
} from '@nwa/writing';

const UPSTREAM_SCRIPT =
  'D:/HermesWorkSpace/oh-story-claudecode/skills/story-deslop/scripts/check-ai-patterns.js';
const CORPUS_DIR = 'D:/HermesWorkSpace/oh-story-claudecode/demo';

/** 上游 type → 本项目 code（只含本文件覆盖的 14 类 advisory） */
const TYPE_TO_CODE: Record<string, string> = {
  'long-paragraph': 'long_paragraph',
  'formulaic-parallelism': 'formulaic_parallelism',
  'action-list-tic': 'action_list_tic',
  'period-stutter': 'period_stutter',
  'micro-action-tic': 'micro_action_tic',
  'stock-reaction-tic': 'stock_reaction_tic',
  'cliche-density-tic': 'cliche_density_tic',
  'metaphor-density-tic': 'metaphor_density_tic',
  'reasoning-chain-tic': 'reasoning_chain_tic',
  'system-notice-formality-tic': 'system_notice_formality_tic',
  'overcompressed-prose-tic': 'overcompressed_prose_tic',
  'low-connective-density-tic': 'low_connective_density_tic',
  'abstract-summary-tic': 'abstract_summary_tic',
  'quote-emphasis-tic': 'quote_emphasis_tic',
};

/** 本项目的 14 个检测器 */
const DETECTORS: readonly (readonly [string, (p: readonly string[]) => AdvisoryHit[]])[] = [
  ['long_paragraph', findLongParagraphs],
  ['formulaic_parallelism', findFormulaicParallelism],
  ['action_list_tic', findActionListTic],
  ['period_stutter', findPeriodStutter],
  ['micro_action_tic', findMicroActionTic],
  ['stock_reaction_tic', findStockReactionTic],
  ['cliche_density_tic', findClicheDensityTic],
  ['metaphor_density_tic', findMetaphorDensityTic],
  ['reasoning_chain_tic', findReasoningChainTic],
  ['system_notice_formality_tic', findNoticeFormalityTic],
  ['overcompressed_prose_tic', findOvercompressedProseTic],
  ['low_connective_density_tic', findLowConnectiveDensityTic],
  ['abstract_summary_tic', findAbstractSummaryTic],
  ['quote_emphasis_tic', findQuoteEmphasisTic],
];

/**
 * 跑上游并取 advisory code 集合。
 *
 * ⚠ 不看退出码：上游 `--json` 在**有 finding 时 exit 1**，
 *   用 execFileSync 会把有命中的样本全跳过（见文件头注释）。
 */
function upstreamCodes(file: string): Set<string> {
  const r = spawnSync('node', [UPSTREAM_SCRIPT, '--json', file], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = r.stdout ?? '';
  if (!out.trim()) {
    throw new Error(`上游无输出 exit=${r.status} stderr=${(r.stderr ?? '').slice(0, 200)}`);
  }
  const parsed = JSON.parse(out) as { findings: { type: string }[] };
  const set = new Set<string>();
  for (const f of parsed.findings) {
    const code = TYPE_TO_CODE[f.type];
    if (code) set.add(code);
  }
  return set;
}

/** 本项目取命中 code 集合 */
function ourCodes(paragraphs: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const [code, fn] of DETECTORS) {
    if (fn(paragraphs).length > 0) set.add(code);
  }
  return set;
}

// ── ① 真人语料（反向对照）────────────────────────────────────────

const HUMAN_FILES = ['短篇-曾将爱意私藏.txt', '长篇-让你管账号，你高燃混剪炸全网.txt'];

interface Sample {
  readonly name: string;
  readonly paragraphs: readonly string[];
}

function loadHumanSamples(): Sample[] {
  const samples: Sample[] = [];
  for (const name of HUMAN_FILES) {
    const full = join(CORPUS_DIR, name);
    if (!existsSync(full)) continue;
    const paragraphs = readFileSync(full, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const CHUNK = 200;
    for (let i = 0; i < paragraphs.length; i += CHUNK) {
      samples.push({ name: `${name}#${i / CHUNK}`, paragraphs: paragraphs.slice(i, i + CHUNK) });
    }
  }
  return samples;
}

// ── ② 构造正例（每类一个）────────────────────────────────────────

const LONG_PARA =
  '他站在门口，看着院子里的那棵老树。' + '树枝在风里摇晃，叶子一片片落下来，铺满了青石板。'.repeat(12);

const LOW_CONN = Array.from({ length: 90 }, () => '风很大。天阴沉。远处钟声响。他抬头。云层厚。').join('\n');

/** name → [段落, 上游实测命中的本项目 code] */
const FIXTURES: readonly (readonly [string, readonly string[], readonly string[]])[] = [
  ['long_paragraph', [LONG_PARA], ['long_paragraph']],
  [
    'formulaic_parallelism',
    ['不吃晚饭，不吃早饭。', '至于去不去，怎么去，他没说。'],
    ['formulaic_parallelism'],
  ],
  [
    'action_list_tic',
    ['他伸手拿起杯子，转身放下，抬头看向窗外，低头握住笔，推开椅子。'],
    ['action_list_tic'],
  ],
  ['period_stutter', ['他站。她坐。天冷。风大。灯灭。人散。夜深。'], ['period_stutter']],
  [
    'micro_action_tic',
    ['他看了一眼，动了一下，说了一声，喘了口气，愣了一会，又瞥了一眼。'],
    ['micro_action_tic'],
  ],
  [
    'stock_reaction_tic',
    ['指尖微微泛白。喉结滚了一下。眼眶发红。声音放轻。'],
    ['stock_reaction_tic'],
  ],
  [
    'cliche_density_tic',
    ['仿佛一丝缓缓，微微轻轻淡淡，犹如一抹些许几分，宛若隐约深吸一口气，仿佛如同。'],
    ['cliche_density_tic'],
  ],
  ['metaphor_density_tic', ['像水像冰像火像刀像针像网像墙一样。'], ['metaphor_density_tic']],
  [
    'reasoning_chain_tic',
    ['他知道。他明白。他意识到。他清楚。这意味着。也就是说。必须确认。需要承担。任务。风险。'],
    // 上游在短句 fixture 上同时命中 period-stutter，如实记录
    ['period_stutter', 'reasoning_chain_tic'],
  ],
  [
    'system_notice_formality_tic',
    [
      '【当前规则：必须维持公共区域秩序，不得违规，否则处罚。】',
      '【本公告提示：任务失败必须承担单位责任，不得撤回。】',
      '【临时权限状态：等级必须维持，违规将被视为放弃。】',
      '【执行指令：必须优先维持秩序，不得违规，否则计入处罚。】',
    ],
    ['system_notice_formality_tic'],
  ],
  [
    'overcompressed_prose_tic',
    [
      ...Array.from({ length: 48 }, (_, i) => `他抬头。风很大。天阴沉。第${i}次。`),
      ...Array.from({ length: 12 }, () =>
        '远处钟声响彻云层一群乌鸦从枯树顶上掠过落在残墙另一端随后又飞向更远地方天空灰白一片风吹动荒草枝叶沙沙作响院里空无一人',
      ),
    ],
    ['period_stutter', 'overcompressed_prose_tic', 'low_connective_density_tic'],
  ],
  [
    'low_connective_density_tic',
    [LOW_CONN],
    ['period_stutter', 'low_connective_density_tic'],
  ],
  [
    'abstract_summary_tic',
    ['这一刻他终于明白。命运齿轮开始转动。前所未有的决意。反击才刚刚开始。'],
    // ⚠ 上游在此 fixture 上**还**报了 trailer-summary / trailer-ending，
    //   但那是 blocking 类（已由 ported-detectors.ts 覆盖），
    //   不在本文件的 TYPE_TO_CODE 映射内 —— 所以这里只期望 advisory 那一个。
    ['abstract_summary_tic'],
  ],
  [
    'quote_emphasis_tic',
    ['他是被请来“把关”的，所谓“流程”只是走个“形式”，这就是“规矩”。'],
    ['quote_emphasis_tic'],
  ],
];

// ── 测试 ────────────────────────────────────────────────────────

describe('advisory 移植保真度 —— 与上游实测逐条比对', () => {
  it('14 类 detector 全部可调用（没有一个是空壳）', () => {
    expect(DETECTORS).toHaveLength(14);
    for (const [code, fn] of DETECTORS) {
      expect(Array.isArray(fn(['他走进屋子，坐下。'])), `${code} 应返回数组`).toBe(true);
    }
  });

  it('② 构造正例：每类都能命中，且命中集合与上游一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nwa-advisory-pos-'));
    const failures: string[] = [];
    try {
      for (const [name, paras, expected] of FIXTURES) {
        const file = join(dir, `${name}.md`);
        writeFileSync(file, paras.join('\n\n'), 'utf8');

        const up = upstreamCodes(file);
        const mine = ourCodes(paras);

        // 上游期望必须与写死的一致（上游改了 → 这里要同步）
        const upSorted = [...up].sort().join(',');
        const expSorted = [...expected].sort().join(',');
        if (upSorted !== expSorted) {
          failures.push(`${name}: 上游实测=[${upSorted}] 与记录的期望=[${expSorted}] 不符（上游可能已改）`);
        }
        // 本项目必须与上游一致
        const onlyUp = [...up].filter((c) => !mine.has(c));
        const onlyMine = [...mine].filter((c) => !up.has(c));
        if (onlyUp.length || onlyMine.length) {
          failures.push(`${name}: 上游独有=[${onlyUp}] 本项目独有=[${onlyMine}]`);
        }
      }
      expect(failures, `\n${failures.join('\n')}\n`).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('② 正例覆盖度：14 类**每一类**都被至少一个正例真正触发', () => {
    const covered = new Set<string>();
    for (const [, paras] of FIXTURES) {
      for (const c of ourCodes(paras)) covered.add(c);
    }
    const all = DETECTORS.map(([c]) => c);
    const missing = all.filter((c) => !covered.has(c));
    // ⚠ 这条防的是"某类检测器存在但从未被任何用例触发"
    expect(missing, `未被任何正例触发: ${missing.join(', ')}`).toEqual([]);
  });

  it('① 真人语料：14 类 advisory 应当 ≈0 命中（上游校准基线）', () => {
    const samples = loadHumanSamples();
    // 前置断言：探针真的拿到了数据，否则"0 命中"是假的
    expect(samples.length).toBeGreaterThan(0);
    const totalParas = samples.reduce((n, s) => n + s.paragraphs.length, 0);
    expect(totalParas, '真人语料段落数太少，不足以作为对照').toBeGreaterThan(500);

    const dir = mkdtempSync(join(tmpdir(), 'nwa-advisory-neg-'));
    const mismatches: string[] = [];
    const upstreamHit = new Map<string, number>();
    let compared = 0;
    try {
      for (const sample of samples) {
        const file = join(dir, `${sample.name.replace(/[^\w.-]/g, '_')}.md`);
        writeFileSync(file, sample.paragraphs.join('\n\n'), 'utf8');

        const up = upstreamCodes(file); // 不 catch：读不到就失败，不伪装成通过
        const mine = ourCodes(sample.paragraphs);
        compared += 1;

        for (const c of up) upstreamHit.set(c, (upstreamHit.get(c) ?? 0) + 1);

        const onlyUp = [...up].filter((c) => !mine.has(c));
        const onlyMine = [...mine].filter((c) => !up.has(c));
        if (onlyUp.length || onlyMine.length) {
          mismatches.push(
            `${sample.name}: 上游独有=[${onlyUp.join(',')}] 本项目独有=[${onlyMine.join(',')}]`,
          );
        }
      }

      expect(compared, '一个样本都没比过 —— 断言无意义').toBeGreaterThan(0);
      expect(mismatches, `\n${mismatches.join('\n')}\n`).toEqual([]);

      // 如实打印：真人在哪些类上被触发（若有），供校准参考
      const triggered = [...upstreamHit.keys()];
      console.log(
        `[真人语料对照] ${compared} 个样本，上游触发 ${triggered.length} 类` +
          (triggered.length ? `: ${triggered.join(', ')}` : '（14 类均未触发，符合上游校准基线）'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
