/**
 * 语料导入真实验证（STEP 14）
 *
 *   pnpm verify:corpus [--file=<path>]
 *
 * ## 为什么需要真实语料验证
 *
 * 单测（corpus-import.test.ts，57 项）证明的是**机制**：
 * 去重生效、许可被拦、章节识别策略正确。
 * 但它证明不了"真实小说导进来会怎样" —— 实测正是真实语料暴露了两个
 * 单测想不到的问题：
 *
 *   1. **Gutenberg 样板污染**：末尾 25KB 英文许可文本混进最后一章
 *      （30993 字 vs 其他章 ~5500），会被切成"场景"、标注 sceneFunction、
 *      挖出"叙事模式"，污染整条 NDE 链路。
 *   2. **回目缺口**：源文本从「九十九回」跳到「一一一回」（缺 100–110），
 *      只按出现顺序编号会让证据引用对不上原文回目（§46 要求可回溯）。
 *
 * 因此这个脚本用**真实公版小说**验证，并断言这两个问题不再出现。
 *
 * ## 无网络时
 *
 * 用 `--file=` 指定本地文本；都没有则用内置的最小公版样本，
 * 并如实标注"未使用真实语料"（不假装验证过）。
 *
 * @verify-kind: standalone — 语料导入/章节识别，自己造临时语料目录
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Database, MIGRATIONS, createRepositories } from '../packages/storage/dist/index.js';
import { Logger } from '../packages/core/dist/index.js';
import { CorpusImporter, detectChapters, normalizeWithStrip } from '../packages/distillation/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const logger = new Logger('verify:corpus', { level: 'error' });

const steps = [];
const rec = (name, ok, detail) => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
}

/** 内置最小公版样本（无网络时的兜底；内容为公版古典小说的开头） */
const FALLBACK = [
  '*** START OF THE PROJECT GUTENBERG EBOOK 樣本 ***',
  '',
  '第一回：樣本開篇',
  '',
  '話說天下大勢，分久必合，合久必分。',
  '',
  '第二回：樣本續篇',
  '',
  '且說當時有一人，姓甚名誰，未及細表。',
  '',
  '*** END OF THE PROJECT GUTENBERG EBOOK 樣本 ***',
  '',
  'Updated editions will replace the previous one.',
  'Creating the works from print editions not protected by',
  'U.S. copyright law means that no one owns a United States',
  'copyright in these works.',
].join('\n');

const dir = mkdtempSync(join(tmpdir(), 'nwa-verify-corpus-'));
let db;

try {
  db = new Database({ path: join(dir, 'project.db'), logger });
  db.migrate(MIGRATIONS);
  const repo = createRepositories(db).corpus;

  let seq = 0;
  const importer = new CorpusImporter({
    repo,
    rootDir: join(dir, 'corpus'),
    logger,
    makeId: () => `doc_${++seq}`,
  });

  // ── 取语料 ──
  const explicit = arg('file');
  const cached = join(tmpdir(), 'nwa-corpus-real', 'zh-novel.txt');
  let text = null;
  let source = '';

  if (explicit && existsSync(explicit)) {
    text = readFileSync(explicit, 'utf8');
    source = `本地文件 ${explicit}`;
  } else if (existsSync(cached)) {
    text = readFileSync(cached, 'utf8');
    source = `缓存的真实语料 ${cached}`;
  } else {
    text = FALLBACK;
    source = '⚠ 内置最小样本（未使用真实语料 —— 请用 --file= 指定，或先下载一份）';
  }

  rec('取得语料', true, `${source}（${text.length} 字）`);

  // ── 1) 样板剥离 ──
  const { text: cleaned, stripped } = normalizeWithStrip(text);
  const hasBoiler = /PROJECT GUTENBERG/i.test(text);
  if (hasBoiler) {
    rec(
      '⚠ 检出并剥离样板文本（否则会污染最后一章）',
      stripped.removedChars > 0,
      `剥离 ${stripped.removedChars} 字，命中 ${stripped.hitMarkers.length} 个标记`,
    );
    rec(
      '⚠ 剥离后不含 Gutenberg 法律条文',
      !/Updated editions will replace/i.test(cleaned) && !/copyright law means/i.test(cleaned),
      '',
    );
  } else {
    rec('样板剥离（该语料无样板，跳过）', true, '无 PROJECT GUTENBERG 标记');
  }

  // ── 2) 章节识别 ──
  const det = detectChapters(cleaned);
  rec(
    '章节识别',
    det.chapters.length > 0,
    `${det.chapters.length} 章｜策略 ${det.strategy}｜模式 ${det.patternName ?? '—'}`,
  );

  // ── 3) ⚠ 章节内容未被样板污染（真实数据暴露的问题）──
  //
  // ⚠ 不能只用"章节长度是否异常"判断：实测《三国演义》第 99 回
  //   有 65565 字（中位的 12.5 倍），但逐字检查后确认**全部是正文** ——
  //   那是源文本缺了 100–110 回的标题，导致一整段归入该回。
  //   长度异常只是**线索**，真正的判据是"有没有混入非正文内容"。
  const lens = det.chapters.map((c) => c.body.length).sort((a, b) => a - b);
  const median = lens[Math.floor(lens.length / 2)];
  const max = lens.at(-1);

  const LEGAL = ['copyright', 'Gutenberg', 'Foundation', 'redistribut', 'trademark', 'PROJECT GUTENBERG'];
  let polluted = null;
  for (const c of det.chapters) {
    const latin = (c.body.match(/[A-Za-z]/g) || []).length;
    const ratio = c.body.length > 0 ? latin / c.body.length : 0;
    const hits = LEGAL.filter((w) => new RegExp(w, 'i').test(c.body));
    // 中文章节里出现大量拉丁字母或许可用语 → 污染
    if (ratio > 0.15 || hits.length > 0) {
      polluted = { n: c.number, ratio: ratio.toFixed(3), hits };
      break;
    }
  }
  rec(
    '⚠ 无章节混入样板/非正文内容',
    polluted === null,
    polluted
      ? `第 ${polluted.n} 章混入非正文（拉丁字母占比 ${polluted.ratio}，命中 ${polluted.hits.join('/')}）`
      : `最大 ${max} / 中位 ${median}（${(max / median).toFixed(1)}×，逐字检查无污染）`,
  );

  // ── 4) ⚠ 回目缺口如实报出 ──
  if (det.gaps.length > 0) {
    rec(
      '⚠ 检出回目缺口并如实记录（语料不完整会影响样本覆盖度）',
      true,
      det.gaps.map((g) => `缺 ${g.after + 1}–${g.before - 1}`).join('、'),
    );
  } else {
    rec('回目连续（无缺口）', true, '');
  }

  // ── 5) 完整导入 ──
  const r = importer.import({
    title: '验证用公版语料',
    text,
    sourceType: 'PUBLIC_DOMAIN',
    licenseType: 'PUBLIC_DOMAIN',
    allowedUsage: 'FULL_ANALYSIS',
  });
  rec('完整导入', r.ok === true, r.ok ? `${r.chapterCount} 章｜落盘 ${r.dir}` : r.error?.message);

  if (r.ok) {
    const report = JSON.parse(readFileSync(join(r.dir, 'import.json'), 'utf8'));
    rec(
      '导入报告含样板与缺口记录（人工可核对）',
      typeof report.boilerplate?.removedChars === 'number' && Array.isArray(report.declaredGaps),
      `样板 ${report.boilerplate.removedChars} 字｜缺口 ${report.declaredGaps.length} 处`,
    );
  }

  // ── 6) ⚠ 去重（同内容再导必须被拒）──
  const dup = importer.import({
    title: '重复导入',
    text,
    sourceType: 'PUBLIC_DOMAIN',
    licenseType: 'PUBLIC_DOMAIN',
    allowedUsage: 'FULL_ANALYSIS',
  });
  rec(
    '⚠ 同内容重复导入被拒（防污染样本统计）',
    dup.ok === false && /已导入过/.test(dup.error?.message ?? ''),
    dup.ok ? '未拒绝 —— 会让同一作品被当多部统计！' : '',
  );

  // ── 7) ⚠ 版权硬约束 ──
  // ⚠ 用独立的短文本：追加到真实文本会让它先被"去重"拦掉，
  //   从而**掩盖**版权校验是否真的生效（实测踩到）。
  const bad = importer.import({
    title: '来路不明',
    text: '第一回 甲\n\n这是另一份来路不明的内容。\n\n第二回 乙\n\n正文。',
    sourceType: 'UNKNOWN',
    licenseType: 'UNKNOWN',
    allowedUsage: 'FULL_ANALYSIS',
  });
  rec(
    '⚠ UNKNOWN 许可被拒（§61 代码强制）',
    bad.ok === false && /UNKNOWN|§61/.test(bad.error?.message ?? ''),
    bad.ok ? '未拒绝 —— 版权约束失效！' : '',
  );
} finally {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const passed = steps.filter((s) => s.ok).length;
const failed = steps.filter((s) => !s.ok);
console.log(`\n──── 结果 ────`);
console.log(`${passed}/${steps.length} 通过`);
if (failed.length > 0) {
  console.log('\n失败项：');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`);
}
process.exit(failed.length === 0 ? 0 : 1);

void here;
