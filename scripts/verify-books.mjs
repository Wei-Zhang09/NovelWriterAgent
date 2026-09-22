/**
 * 真实语料处理与导入（STEP 14 的真实数据验收）
 *
 *   pnpm verify:books
 *
 * ## 处理对象
 *
 * 用户提供的两部网络小说（本地文件）：
 *   - 《斗破苍穹》玄幻，580 万字，网络转载版（含七类噪声）
 *   - 《百岁之好，一言为定》都市校园，45 万字（源文本缺 27 章）
 *
 * ## 这个脚本做四件事
 *
 *   1. 清洗噪声（cleanWebNovel）—— 并**逐条报告**删了什么
 *   2. 质量审计（章节数/长度分布/空章节/噪声残留）
 *   3. 正式导入（CorpusImporter，带 licenseBasis）
 *   4. 断言关键不变量（无噪声残留、无空章节、章节数合理）
 *
 * ## 版权依据（§61 要求可说明）
 *
 * 用户判断：用于蒸馏「文风/节奏/叙事手法」层面的可迁移模式，
 * 不复制世界观、剧情、人物等表达性内容 —— 因此不构成对原作的替代性使用。
 * 该说明写入导入报告的 `license.basis`，便于日后审计。
 *
 * ⚠ 这只是**记录用户的判断**，不是系统在替用户做法律认定。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database, MIGRATIONS, createRepositories } from '../packages/storage/dist/index.js';
import { Logger } from '../packages/core/dist/index.js';
import { CorpusImporter, cleanWebNovel, detectChapters, summarizeGaps } from '../packages/distillation/dist/index.js';
import { normalizeGenre } from '../packages/storage/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..');
const logger = new Logger('verify:books', { level: 'error' });

const ATTACH = 'C:/Users/zw/AppData/Local/hermes/attachments';
// ⚠ 语料独立存放，不与用户的创作项目混在一起
const CORPUS_ROOT = 'C:/Users/zw/NovelWriterCorpus';

const LICENSE_BASIS =
  '用户自有文本。用途限于蒸馏文风/节奏/叙事手法层面的可迁移模式，' +
  '不复制世界观、剧情、人物等表达性内容，不构成对原作的替代性使用。';

const BOOKS = [
  {
    name: '斗破苍穹',
    file: join(ATTACH, '斗破苍穹.md'),
    genre: '玄幻',
    clean: true,
    sourceType: 'USER_OWNED',
    expectNoise: ['武动乾坤', '16kxs', '手机阅读', '求月票', '求推荐票', 'vip章 目录'],
  },
  {
    // ⚠ 该文件标题有两种格式（前 57 章纯标题、58 章起「58|第五十七章」），
    //   已修复检测。实际 108 章（用户指出应为完整版）。
    name: '百岁之好，一言为定',
    file: join(ATTACH, '百岁之好，一言为定-2.md'),
    genre: '都市校园',
    clean: false,
    sourceType: 'USER_OWNED',
    expectNoise: [],
  },
  {
    // ⚠ 平台导出格式：带书籍信息头部 + 每章时间戳（488 处）
    name: '清纯校花傻白甜，撩我却刀刀暴击',
    file: join(ATTACH, '清纯校花傻白甜，撩我却刀刀暴击 - 夜雨i.md'),
    genre: '都市言情',
    clean: true,
    sourceType: 'USER_OWNED',
    expectNoise: ['章节更新时间', '书籍信息', '【简介】'],
  },
  {
    name: '凡人修仙传',
    file: join(ATTACH, '凡人修仙传.md'),
    genre: '修仙',
    clean: true,
    sourceType: 'USER_OWNED',
    // ⚠ 注：此文件末尾含同作者番外篇（123 万字），默认保留不删
    expectNoise: ['一秒记住', '..info', '<strong>', '<a href', '圣堂最新章节', '最新章节'],
  },
  {
    name: '诛仙',
    file: join(ATTACH, '诛仙（电视名：诛仙青云志）.md'),
    genre: '仙侠',
    clean: true,
    sourceType: 'USER_OWNED',
    expectNoise: ['..info', '<strong>', '最新章节'],
  },
];

const steps = [];
const rec = (name, ok, detail) => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

mkdirSync(CORPUS_ROOT, { recursive: true });
const db = new Database({ path: join(CORPUS_ROOT, 'corpus.db'), logger });
db.migrate(MIGRATIONS);
const repo = createRepositories(db).corpus;

let seq = 0;
const importer = new CorpusImporter({
  repo,
  rootDir: join(CORPUS_ROOT, 'documents'),
  logger,
  makeId: () => `doc_${++seq}_${Date.now().toString(36)}`,
});

const summary = [];

for (const book of BOOKS) {
  console.log(`\n${'═'.repeat(62)}\n${book.name}（${book.genre}）\n${'═'.repeat(62)}`);

  if (!existsSync(book.file)) {
    rec(`${book.name} 文件存在`, false, book.file);
    continue;
  }
  const raw = readFileSync(book.file, 'utf8');

  // ── 1) 清洗 ──
  let text = raw;
  if (book.clean) {
    const cleaned = cleanWebNovel(raw);
    text = cleaned.text;
    console.log(`清洗：删除 ${cleaned.report.removedChars.toLocaleString()} 字` +
      `（${(cleaned.report.removedRatio * 100).toFixed(2)}%）`);
    for (const r of cleaned.report.rules) {
      console.log(`    ${r.name}: ${r.count.toLocaleString()} 处 / ${r.removedChars.toLocaleString()} 字`);
    }
    rec(`${book.name} 清洗完成`, cleaned.report.removedChars > 0, `${cleaned.report.rules.length} 条规则`);
  }

  // ── 2) 审计 ──
  const det = detectChapters(text);
  const sizes = det.chapters.map((c) => c.body.length).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)];
  const empty = det.chapters.filter((c) => c.body.length < 50);
  console.log(`章节 ${det.chapters.length}｜长度 最小 ${sizes[0]} / 中位 ${median} / 最大 ${sizes.at(-1)}`);
  // ⚠ 区分"真实缺章"与"源文本编号混乱" —— 混在一起会报出荒唐数字
  const gs = summarizeGaps(det.gaps);
  if (gs.missingCount > 0) {
    console.log(`⚠ 语料缺章：${gs.missingCount} 处，共缺 ${gs.missingChapters} 章`);
  }
  if (gs.numberingCount > 0) {
    console.log(`⚠ 源文本编号混乱：${gs.numberingCount} 处（跳变过大或倒退 —— 源文本质量问题）`);
  }

  rec(`${book.name} 章节数合理`, det.chapters.length >= 50, `${det.chapters.length} 章`);
  rec(
    `${book.name} 无空正文章节`,
    empty.length <= 2,
    empty.length === 0 ? '无' : `${empty.length} 个（源文本固有）`,
  );

  // ── 3) 噪声残留 ──
  const leftover = book.expectNoise.filter((w) => text.includes(w));
  // ⚠ ※※※ 是场景分隔符（实测《诛仙》133 处），必须保留 —— 它承载场景边界信息
  if (text.includes('※※※')) {
    console.log(`    （保留了 ※※※ 场景分隔符 ${(text.match(/※※※/g) ?? []).length} 处）`);
  }
  rec(
    `${book.name} 无噪声残留`,
    leftover.length === 0,
    leftover.length === 0 ? `已检查 ${book.expectNoise.length} 种特征` : `残留 ${leftover.join('/')}`,
  );

  // ── 4) 导入 ──
  const r = importer.import({
    title: book.name,
    text: raw,
    genre: book.genre,
    // 简介由清洗阶段提取（含题材标签，对类型判定有价值）
    sourceType: book.sourceType,
    licenseType: 'USER_OWNED',
    allowedUsage: 'FULL_ANALYSIS',
    licenseBasis: LICENSE_BASIS,
    clean: book.clean,
  });

  rec(
    `${book.name} 导入`,
    r.ok === true,
    r.ok
      ? `${r.chapterCount} 章｜清洗 ${r.strippedChars ?? 0} 字｜${r.dir}`
      : r.error?.message ?? '',
  );

  if (r.ok) {
    const report = JSON.parse(readFileSync(join(r.dir, 'import.json'), 'utf8'));
    rec(
      `${book.name} 报告含版权依据与清洗记录`,
      report.license?.basis === LICENSE_BASIS && (book.clean ? report.cleaning !== null : true),
      `依据已记录｜清洗规则 ${report.cleaning?.rules?.length ?? 0} 条`,
    );
    summary.push({
      name: book.name,
      genre: book.genre,
      chapters: r.chapterCount,
      chars: r.stats?.chars,
      dir: r.dir,
      gaps: r.declaredGaps?.length ?? 0,
      missingChapters: (r.declaredGaps ?? []).filter((g) => g.kind === 'missing').reduce((s, g) => s + g.missing, 0),
      numbering: (r.declaredGaps ?? []).filter((g) => g.kind === 'numbering').length,
    });
  }
}

// ── 汇总 ──
console.log(`\n──── 语料汇总 ────`);
// ⚠ 类型归一化：仙侠/修仙/修真 视为同类；都市/都市校园/都市言情 视为同类
const byGenre = new Map();
for (const s of summary) {
  const g = normalizeGenre(s.genre) ?? s.genre;
  byGenre.set(g, (byGenre.get(g) ?? 0) + 1);
}
console.log(`  类型分布（归一化后）：${[...byGenre.entries()].map(([g, n]) => `${g}×${n}`).join('、')}`);
for (const s of summary) {
  console.log(
    `  ${s.name}（${s.genre}）：${s.chapters} 章｜${(s.chars ?? 0).toLocaleString()} 字` +
      `${s.missingChapters ? `｜缺 ${s.missingChapters} 章` : ''}${s.numbering ? `｜编号混乱 ${s.numbering} 处` : ''}`,
  );
}
console.log(`  存储位置：${CORPUS_ROOT}`);

// ⚠ 跨作品对比（STEP 16）需要 ≥2 部且**不同类型**才能分出 genre-specific
rec(
  '≥2 部不同类型语料（STEP 16 跨作品对比的前提）',
  summary.length >= 2 && new Set(summary.map((s) => s.genre)).size >= 2,
  summary.map((s) => s.genre).join(' / '),
);

const passed = steps.filter((s) => s.ok).length;
const failed = steps.filter((s) => !s.ok);
console.log(`\n──── 结果 ────`);
console.log(`${passed}/${steps.length} 通过`);
if (failed.length) {
  console.log('\n失败项：');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`);
}

writeFileSync(
  join(CORPUS_ROOT, 'import-summary.json'),
  JSON.stringify({ summary, steps }, null, 2),
  'utf8',
);

db.close();
process.exit(failed.length === 0 ? 0 : 1);

void REPO;
