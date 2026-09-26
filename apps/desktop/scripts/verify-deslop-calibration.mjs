/**
 * M10 阈值校准 —— **真实语料误报率实测**（ADR-0009 的验收门槛）。
 *
 *   pnpm verify:deslop-calib [--json]
 *
 * ## 这个脚本要回答的问题
 *
 * ADR-0009 最大的风险写着：
 *
 *   「参考项目的阈值是在**网文语料**上校准的，本项目语料可能偏严」
 *   「实测误报率过高（>30%）→ 重评是否只保留 blocking 类别」
 *
 * 所以移植完不能只看「测试通过」—— 必须**在真实正文上量一次**：
 * 这些检测器会不会对**人写的正常小说**疯狂报错？
 *
 * ## ⚠ 与 `advisory-vs-upstream.test.ts` 的分工（不是重复）
 *
 *   · 那个测试证明**保真**：我的实现 == 上游实现（跑上游逐条比对）。
 *   · 这个脚本回答**适用性**：上游的阈值用在本项目语料上，
 *     误报率高不高。**两者可以同时为真** —— 一个忠实移植了
 *     一组不适合本语料的阈值，正是本脚本要抓的情形。
 *
 * ## ⚠ 误报的判定口径
 *
 * 语料是**已出版的真人作品**，所以**任何命中都算误报**（假阳性）。
 * 这不是说检测器没用 —— 它说明的是"在真人语料上的触发率"，
 * 也就是作者用这个功能时会被打扰的频率。
 *
 * 按**类**统计"有多少章触发了该类"，并给出总误报率：
 *   总误报率 = 触发过任一类的章数 / 总章数
 * （这是作者视角："我点一次检查，有多少概率被告知有问题"）
 *
 * @verify-kind: needs-model — 需读取用户/上游真实语料路径，且非幂等
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const UPSTREAM_SCRIPT =
  'D:/HermesWorkSpace/oh-story-claudecode/skills/story-deslop/scripts/check-ai-patterns.js';
const CORPUS_ROOT = 'D:/HermesWorkSpace/oh-story-claudecode/demo';

/** 真人语料（上游 demo 里的已出版正文） */
const HUMAN_FILES = [
  '短篇-曾将爱意私藏.txt',
  '长篇-让你管账号，你高燃混剪炸全网.txt',
  '拆文库/曾将爱意私藏/原文/原文.txt',
];

/** ADR-0009 的阈值 */
const FALSE_POSITIVE_LIMIT = 0.3;

const JSON_OUT = process.argv.includes('--json');

/** 上游 type → 本项目 code（只含 14 类 advisory） */
const TYPE_TO_CODE = {
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

/**
 * 按章切分。
 *
 * ⚠ 章节边界取**上游正文里真实存在的分隔形态**（`###01` 这类标题行），
 *   不是按固定字数硬切 —— 硬切会把一章的句子切成两半，
 *   让 density 类检测（per-kilo）在切缝处产生假命中。
 */
function splitChapters(text) {
  const lines = text.split(/\r?\n/);
  const chapters = [];
  let cur = [];
  const isHeading = (l) => /^#{1,6}\s*\d*\s*$/.test(l.trim()) || /^第[零一二三四五六七八九十百千万\d]+章/.test(l.trim());
  for (const line of lines) {
    if (isHeading(line) && cur.join('').trim().length > 0) {
      chapters.push(cur.join('\n'));
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.join('').trim().length > 0) chapters.push(cur.join('\n'));
  return chapters.filter((c) => c.replace(/\s/g, '').length >= 300);
}

function upstreamCodes(file) {
  const r = spawnSync('node', [UPSTREAM_SCRIPT, '--json', file], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = r.stdout ?? '';
  if (!out.trim()) return null;
  try {
    const parsed = JSON.parse(out);
    const set = new Set();
    for (const f of parsed.findings) {
      const code = TYPE_TO_CODE[f.type];
      if (code) set.add(code);
    }
    return set;
  } catch {
    return null;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'nwa-deslop-calib-'));
const perClass = new Map(); // code -> 触发的章数
const perClassSamples = new Map();
let totalChapters = 0;
let chaptersWithAnyHit = 0;
const corpusReport = [];

try {
  for (const rel of HUMAN_FILES) {
    const full = join(CORPUS_ROOT, rel);
    if (!existsSync(full)) {
      corpusReport.push({ file: rel, chapters: 0, note: '不存在，跳过' });
      continue;
    }
    const chapters = splitChapters(readFileSync(full, 'utf8'));
    let fileHits = 0;

    for (let i = 0; i < chapters.length; i += 1) {
      const file = join(dir, `ch.md`);
      writeFileSync(file, chapters[i], 'utf8');
      const codes = upstreamCodes(file);
      if (codes === null) {
        corpusReport.push({ file: rel, chapters: 0, note: '上游无输出，跳过整文件' });
        break;
      }
      totalChapters += 1;
      if (codes.size > 0) {
        chaptersWithAnyHit += 1;
        fileHits += 1;
      }
      for (const c of codes) {
        perClass.set(c, (perClass.get(c) ?? 0) + 1);
        if (!perClassSamples.has(c)) perClassSamples.set(c, `${rel}#${i + 1}`);
      }
    }
    corpusReport.push({ file: rel, chapters: chapters.length, hits: fileHits });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const allClasses = Object.values(TYPE_TO_CODE);
const fpRate = totalChapters > 0 ? chaptersWithAnyHit / totalChapters : 0;

const report = {
  corpus: corpusReport,
  totalChapters,
  chaptersWithAnyHit,
  falsePositiveRate: Number(fpRate.toFixed(4)),
  limit: FALSE_POSITIVE_LIMIT,
  verdict: fpRate > FALSE_POSITIVE_LIMIT ? 'FAIL' : 'PASS',
  perClass: allClasses
    .map((c) => ({
      code: c,
      chaptersHit: perClass.get(c) ?? 0,
      rate: totalChapters > 0 ? Number(((perClass.get(c) ?? 0) / totalChapters).toFixed(4)) : 0,
      firstSample: perClassSamples.get(c) ?? null,
    }))
    .sort((a, b) => b.chaptersHit - a.chaptersHit),
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('════ M10 阈值校准：真实语料误报率 ════\n');
  console.log('语料（已出版真人作品，任何命中都计为误报）：');
  for (const c of report.corpus) {
    console.log(`  ${c.file}  →  ${c.chapters} 章${c.hits !== undefined ? `，${c.hits} 章触发` : ''}${c.note ? `（${c.note}）` : ''}`);
  }
  console.log(`\n总章数：${totalChapters}｜触发过任一类的章数：${chaptersWithAnyHit}`);
  console.log(`总误报率：${(fpRate * 100).toFixed(1)}%   （ADR-0009 门槛：>${FALSE_POSITIVE_LIMIT * 100}% 需重评）`);
  console.log('\n分类明细：');
  for (const r of report.perClass) {
    const mark = r.chaptersHit > 0 ? '●' : '○';
    console.log(
      `  ${mark} ${r.code.padEnd(30)} ${String(r.chaptersHit).padStart(3)} 章  ${(r.rate * 100).toFixed(1).padStart(5)}%` +
        (r.firstSample ? `   例：${r.firstSample}` : ''),
    );
  }
  const neverFired = report.perClass.filter((r) => r.chaptersHit === 0).length;
  console.log(`\n从未在真人语料触发：${neverFired}/14 类`);
  console.log(`\n结论：${report.verdict}（误报率 ${(fpRate * 100).toFixed(1)}% ${fpRate > FALSE_POSITIVE_LIMIT ? '>' : '≤'} ${FALSE_POSITIVE_LIMIT * 100}%）`);
}

process.exit(report.verdict === 'PASS' ? 0 : 1);
