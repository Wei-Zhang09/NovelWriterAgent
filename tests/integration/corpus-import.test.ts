/**
 * 语料导入测试（施工文档 §45 / §61）
 *
 * ## 这组测试要锁死的两件事
 *
 * **1. 版权是硬约束，不是提示（§61）**
 *
 * 产品不得默认假设所有网上小说都可自由训练或再分发。
 * `UNKNOWN` 许可的内容**代码层禁止**进入自动分析/蒸馏链 ——
 * 这一条必须在仓储层与导入层都被拒绝，而不是靠调用方自觉。
 *
 * **2. 去重靠 content hash（§45）**
 *
 * 同一份文本重复导入必须被拒。否则模式挖掘会把同一部作品
 * 当多部统计，污染 `sample_count` 与 `confidence` ——
 * 而那种污染是静默的（数字看起来仍然合理）。
 *
 * ## 第三件事：章节识别"不猜"
 *
 * 分章错误是静默的：后续所有环节都基于错误的边界工作，
 * 但每一环节单独看都正常。所以识别不出时必须整篇一章并如实标注。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database, MIGRATIONS, createRepositories, canProcess } from '@nwa/storage';
import type { CorpusRepository } from '@nwa/storage';
import { Logger } from '@nwa/core';
import {
  CorpusImporter,
  normalizeText,
  normalizeWithStrip,
  stripBoilerplate,
  contentHash,
  textStats,
  detectChapters,
  parseChineseNumber,
  declaredNumberOf,
  summarizeGaps,
} from '@nwa/distillation';

const logger = new Logger('test:corpus', { level: 'error' });

let dir: string;
let db: Database;
let repo: CorpusRepository;
let seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nwa-corpus-'));
  db = new Database({ path: join(dir, 'project.db'), logger });
  db.migrate(MIGRATIONS);
  repo = createRepositories(db).corpus;
  seq = 0;
});
afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
});

function importer() {
  return new CorpusImporter({
    repo,
    rootDir: join(dir, 'corpus'),
    logger,
    makeId: () => `doc_${++seq}`,
  });
}

const NOVEL = [
  '第一章 开端',
  '',
  '沈砚站在渡口，看着货船靠岸。',
  '他摸了摸怀里的铜牌，凉。',
  '',
  '第二章 冲突',
  '',
  '周舵从船上下来，径直走向他。',
  '"你手里那东西，给我看看。"',
  '',
  '第三章 转折',
  '',
  '沈砚后退一步，握紧了铜牌。',
].join('\n');

// ══════════════════════════════════════════════════════════
describe('文本规范化（§45）', () => {
  it('去掉 BOM', () => {
    expect(normalizeText('\uFEFF第一章')).toBe('第一章\n');
  });

  it('统一换行符（CRLF / CR → LF）', () => {
    expect(normalizeText('a\r\nb\rc')).toBe('a\nb\nc\n');
  });

  it('压缩 3+ 连续空行为 2 个', () => {
    expect(normalizeText('a\n\n\n\n\nb')).toBe('a\n\nb\n');
  });

  it('去掉行尾空白', () => {
    expect(normalizeText('a   \nb\t')).toBe('a\nb\n');
  });

  it('去掉首尾多余空行', () => {
    expect(normalizeText('\n\n\n正文\n\n\n')).toBe('正文\n');
  });

  it('⚠ 不改动正文内容（证据引用必须能对上原文）', () => {
    const src = '他说：“别动。”\n她退了一步。';
    const out = normalizeText(src);
    expect(out).toContain('他说：“别动。”');
    expect(out).toContain('她退了一步。');
  });

  it('非字符串输入报错', () => {
    expect(() => normalizeText(null as unknown as string)).toThrow();
  });
});

describe('内容哈希与统计', () => {
  it('同内容同哈希（去重的基础）', () => {
    expect(contentHash(normalizeText('abc'))).toBe(contentHash(normalizeText('abc')));
  });

  it('不同内容不同哈希', () => {
    expect(contentHash('abc')).not.toBe(contentHash('abd'));
  });

  it('⚠ 哈希基于规范化后的文本 —— 换行符不同不该算新文档', () => {
    expect(contentHash(normalizeText('a\r\nb'))).toBe(contentHash(normalizeText('a\nb')));
  });

  it('统计字符/行/段落', () => {
    const s = textStats('第一段。\n\n第二段。\n第三行。\n');
    expect(s.paragraphs).toBe(2);
    expect(s.nonEmptyLines).toBe(3);
    expect(s.chars).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════
describe('章节识别（§18）', () => {
  it('识别「第X章」标题', () => {
    const r = detectChapters(NOVEL);
    expect(r.strategy).toBe('explicit-title');
    expect(r.chapters).toHaveLength(3);
    expect(r.chapters[0]!.title).toContain('第一章');
    expect(r.chapters[1]!.title).toContain('第二章');
  });

  it('章节正文不含标题行本身', () => {
    const r = detectChapters(NOVEL);
    expect(r.chapters[0]!.body).not.toContain('第一章 开端');
    expect(r.chapters[0]!.body).toContain('沈砚站在渡口');
  });

  it('识别阿拉伯数字标题', () => {
    const r = detectChapters('第1章 甲\n\n内容一\n\n第2章 乙\n\n内容二\n');
    expect(r.chapters).toHaveLength(2);
  });

  it('识别 Chapter N', () => {
    const r = detectChapters('Chapter 1\n\nalpha\n\nChapter 2\n\nbeta\n');
    expect(r.strategy).toBe('explicit-title');
    expect(r.chapters).toHaveLength(2);
  });

  it('⚠ 标题前的引子并入第一章（不丢内容）', () => {
    const r = detectChapters('这是序言。\n\n第一章 甲\n\n正文\n\n第二章 乙\n\n正文2\n');
    expect(r.chapters[0]!.body).toContain('这是序言。');
  });

  it('记录起始行号（证据可回溯）', () => {
    const r = detectChapters(NOVEL);
    expect(r.chapters[0]!.startLine).toBe(1);
    expect(r.chapters[1]!.startLine).toBeGreaterThan(1);
  });

  it('分隔符策略：无标题但有 *** 时', () => {
    const r = detectChapters('甲段。\n\n***\n\n乙段。\n\n***\n\n丙段。\n');
    expect(r.strategy).toBe('separator');
    expect(r.chapters).toHaveLength(3);
  });

  it('⚠ 识别不出就整篇一章（不猜）', () => {
    const r = detectChapters('这是一段没有任何章节标记的散文。\n\n它就一段。\n');
    expect(r.strategy).toBe('whole-document');
    expect(r.chapters).toHaveLength(1);
  });

  it('⚠ 只有一个标题时不算章节结构（可能是正文偶然匹配）', () => {
    const r = detectChapters('第一章 唯一的标题\n\n然后是正文。\n');
    expect(r.strategy).toBe('whole-document');
  });
});

// ══════════════════════════════════════════════════════════
describe('导入流程', () => {
  it('导入成功，返回章节数与策略', () => {
    const r = importer().import({
      title: '测试小说',
      text: NOVEL,
      sourceType: 'PUBLIC_DOMAIN',
      licenseType: 'PUBLIC_DOMAIN',
      allowedUsage: 'FULL_ANALYSIS',
    });

    expect(r.ok).toBe(true);
    expect(r.chapterCount).toBe(3);
    expect(r.strategy).toBe('explicit-title');
    expect(r.contentHash).toBeTruthy();
  });

  it('落盘：original.txt + 每章文件 + import.json', () => {
    const r = importer().import({
      title: '测试小说',
      text: NOVEL,
      sourceType: 'PUBLIC_DOMAIN',
      licenseType: 'PUBLIC_DOMAIN',
      allowedUsage: 'FULL_ANALYSIS',
    });

    expect(existsSync(join(r.dir!, 'original.txt'))).toBe(true);
    expect(existsSync(join(r.dir!, 'chapters', '001.md'))).toBe(true);
    expect(existsSync(join(r.dir!, 'chapters', '003.md'))).toBe(true);
    expect(existsSync(join(r.dir!, 'import.json'))).toBe(true);

    const report = JSON.parse(readFileSync(join(r.dir!, 'import.json'), 'utf8'));
    expect(report.chapterCount).toBe(3);
    expect(report.strategy).toBe('explicit-title');
  });

  it('章节文件内容与该章正文一致', () => {
    const r = importer().import({
      title: '测试小说',
      text: NOVEL,
      sourceType: 'PUBLIC_DOMAIN',
      licenseType: 'PUBLIC_DOMAIN',
      allowedUsage: 'FULL_ANALYSIS',
    });
    const ch1 = readFileSync(join(r.dir!, 'chapters', '001.md'), 'utf8');
    expect(ch1).toContain('沈砚站在渡口');
  });

  it('空文本被拒', () => {
    const r = importer().import({
      title: '空',
      text: '   ',
      sourceType: 'PUBLIC_DOMAIN',
      licenseType: 'PUBLIC_DOMAIN',
      allowedUsage: 'FULL_ANALYSIS',
    });
    expect(r.ok).toBe(false);
    expect(r.error!.message).toContain('文本为空');
  });

  it('空标题被拒', () => {
    const r = importer().import({
      title: '  ',
      text: NOVEL,
      sourceType: 'PUBLIC_DOMAIN',
      licenseType: 'PUBLIC_DOMAIN',
      allowedUsage: 'FULL_ANALYSIS',
    });
    expect(r.ok).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════
describe('⚠ 去重（§45）', () => {
  it('同内容第二次导入被拒', () => {
    const imp = importer();
    const base = {
      title: '第一次',
      text: NOVEL,
      sourceType: 'PUBLIC_DOMAIN' as const,
      licenseType: 'PUBLIC_DOMAIN' as const,
      allowedUsage: 'FULL_ANALYSIS' as const,
    };
    expect(imp.import(base).ok).toBe(true);

    const second = imp.import({ ...base, title: '第二次（同内容）' });
    expect(second.ok).toBe(false);
    expect(second.error!.message).toContain('已导入过');
    // ⚠ 必须说明后果，而不只是"重复"
    expect(second.error!.message).toContain('污染');
  });

  it('⚠ 换行符不同但内容相同 → 仍算重复', () => {
    const imp = importer();
    const base = {
      title: 'A',
      sourceType: 'PUBLIC_DOMAIN' as const,
      licenseType: 'PUBLIC_DOMAIN' as const,
      allowedUsage: 'FULL_ANALYSIS' as const,
    };
    expect(imp.import({ ...base, text: NOVEL }).ok).toBe(true);
    const crlf = NOVEL.replace(/\n/g, '\r\n');
    expect(imp.import({ ...base, title: 'B', text: crlf }).ok).toBe(false);
  });

  it('不同内容可以导入', () => {
    const imp = importer();
    const base = {
      sourceType: 'PUBLIC_DOMAIN' as const,
      licenseType: 'PUBLIC_DOMAIN' as const,
      allowedUsage: 'FULL_ANALYSIS' as const,
    };
    expect(imp.import({ ...base, title: 'A', text: NOVEL }).ok).toBe(true);
    expect(imp.import({ ...base, title: 'B', text: NOVEL + '\n额外的内容' }).ok).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
describe('⚠ 版权约束（§61）—— 代码强制，非提示', () => {
  it('⚠ UNKNOWN 许可 + FULL_ANALYSIS 被拒', () => {
    const r = importer().import({
      title: '来路不明',
      text: NOVEL,
      sourceType: 'UNKNOWN',
      licenseType: 'UNKNOWN',
      allowedUsage: 'FULL_ANALYSIS',
    });
    expect(r.ok).toBe(false);
    expect(r.error!.message).toContain('UNKNOWN');
    expect(r.error!.message).toContain('§61');
  });

  it('⚠ UNKNOWN 许可 + DISTILLATION_ONLY 也被拒（不得进入蒸馏链）', () => {
    const r = importer().import({
      title: '来路不明',
      text: NOVEL,
      sourceType: 'UNKNOWN',
      licenseType: 'UNKNOWN',
      allowedUsage: 'DISTILLATION_ONLY',
    });
    expect(r.ok).toBe(false);
  });

  it('UNKNOWN 许可 + RETRIEVAL_ONLY 允许（只是存着，不分析）', () => {
    const r = importer().import({
      title: '仅供检索',
      text: NOVEL,
      sourceType: 'UNKNOWN',
      licenseType: 'UNKNOWN',
      allowedUsage: 'RETRIEVAL_ONLY',
    });
    expect(r.ok).toBe(true);
  });

  it('UNKNOWN 许可 + NO_PROCESSING 允许', () => {
    const r = importer().import({
      title: '不处理',
      text: NOVEL,
      sourceType: 'UNKNOWN',
      licenseType: 'UNKNOWN',
      allowedUsage: 'NO_PROCESSING',
    });
    expect(r.ok).toBe(true);
  });

  it('⚠ 仓储层也拒绝（不能绕过导入器）', () => {
    expect(() =>
      repo.register({
        id: 'doc_x',
        title: '绕过导入器',
        sourceType: 'UNKNOWN',
        licenseType: 'UNKNOWN',
        allowedUsage: 'FULL_ANALYSIS',
        contentHash: 'abc123',
      }),
    ).toThrow(/UNKNOWN/);
  });

  it('listProcessable 只返回可处理文档', () => {
    const imp = importer();
    imp.import({
      title: '可处理',
      text: NOVEL,
      sourceType: 'USER_OWNED',
      licenseType: 'USER_OWNED',
      allowedUsage: 'FULL_ANALYSIS',
    });
    imp.import({
      title: '仅检索',
      text: NOVEL + '\n不同',
      sourceType: 'UNKNOWN',
      licenseType: 'UNKNOWN',
      allowedUsage: 'RETRIEVAL_ONLY',
    });

    const ok = repo.listProcessable();
    expect(ok).toHaveLength(1);
    expect(ok[0]!.title).toBe('可处理');
  });

  it('⚠ requireProcessable 对不可处理的文档报错（不静默返回）', () => {
    importer().import({
      title: '仅检索',
      text: NOVEL,
      sourceType: 'UNKNOWN',
      licenseType: 'UNKNOWN',
      allowedUsage: 'RETRIEVAL_ONLY',
    });
    const doc = repo.list()[0]!;
    expect(() => repo.requireProcessable(doc.id)).toThrow(/不允许进入蒸馏链/);
  });

  it('canProcess 判定矩阵', () => {
    const mk = (usage: string) =>
      ({ allowed_usage: usage }) as unknown as Parameters<typeof canProcess>[0];
    // FULL_ANALYSIS 许可 → 什么都能做
    expect(canProcess(mk('FULL_ANALYSIS'), 'FULL_ANALYSIS')).toBe(true);
    expect(canProcess(mk('FULL_ANALYSIS'), 'DISTILLATION_ONLY')).toBe(true);
    // DISTILLATION_ONLY 许可 → 不能做 FULL_ANALYSIS
    expect(canProcess(mk('DISTILLATION_ONLY'), 'FULL_ANALYSIS')).toBe(false);
    expect(canProcess(mk('DISTILLATION_ONLY'), 'DISTILLATION_ONLY')).toBe(true);
    // RETRIEVAL_ONLY → 不能蒸馏
    expect(canProcess(mk('RETRIEVAL_ONLY'), 'DISTILLATION_ONLY')).toBe(false);
    // NO_PROCESSING → 什么都不行
    expect(canProcess(mk('NO_PROCESSING'), 'FULL_ANALYSIS')).toBe(false);
    expect(canProcess(mk('NO_PROCESSING'), 'DISTILLATION_ONLY')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════
describe('从文件导入', () => {
  it('导入 .txt 文件', () => {
    const f = join(dir, 'novel.txt');
    // 用 writeFileSync 直接写（避免依赖被测代码）
    writeFileSync(f, NOVEL, 'utf8');
    const r = importer().importFile(f, {
      title: '文件导入',
      sourceType: 'USER_OWNED',
      licenseType: 'USER_OWNED',
      allowedUsage: 'FULL_ANALYSIS',
    });
    expect(r.ok).toBe(true);
    expect(r.chapterCount).toBe(3);
  });

  it('文件不存在时报错', () => {
    const r = importer().importFile(join(dir, 'nope.txt'), {
      title: 'x',
      sourceType: 'USER_OWNED',
      licenseType: 'USER_OWNED',
      allowedUsage: 'FULL_ANALYSIS',
    });
    expect(r.ok).toBe(false);
    expect(r.error!.message).toContain('文件不存在');
  });

  it('⚠ 不支持的格式明确报错（不假装支持）', () => {
    const f = join(dir, 'novel.epub');
    writeFileSync(f, 'fake', 'utf8');
    const r = importer().importFile(f, {
      title: 'x',
      sourceType: 'USER_OWNED',
      licenseType: 'USER_OWNED',
      allowedUsage: 'FULL_ANALYSIS',
    });
    expect(r.ok).toBe(false);
    expect(r.error!.message).toContain('只支持');
  });
});

// ══════════════════════════════════════════════════════════
describe('⚠ 样板文本剥离（真实数据验证暴露）', () => {
  // 真实场景：Gutenberg 版《三国演义》末尾附了约 25KB 英文许可文本，
  // 导致最后一章 30993 字（其他章 ~5500）。若不剥离，这些法律条文
  // 会被切成"场景"、标注 sceneFunction、挖出"叙事模式"，污染整条 NDE 链路。
  const GUTEN = [
    'The Project Gutenberg eBook of 测试书',
    '',
    'This eBook is for the use of anyone anywhere at no cost',
    'almost no restrictions whatsoever.',
    '',
    '*** START OF THE PROJECT GUTENBERG EBOOK 测试书 ***',
    '',
    '第一章 开端',
    '',
    '正文内容在这里。',
    '',
    '第二章 冲突',
    '',
    '更多正文。',
    '',
    '*** END OF THE PROJECT GUTENBERG EBOOK 测试书 ***',
    '',
    'Updated editions will replace the previous one.',
    'Creating the works from print editions not protected by',
    'U.S. copyright law means that no one owns a United States',
    'copyright in these works, so the Foundation (and you!) can',
  ].join('\n');

  it('剥离头部与尾部样板', () => {
    const r = stripBoilerplate(normalizeText(GUTEN));
    expect(r.removedChars).toBeGreaterThan(0);
    expect(r.text).toContain('第一章 开端');
    expect(r.text).toContain('更多正文。');
  });

  it('⚠ 尾部法律文本被完全剥离（否则会污染整条链路）', () => {
    const r = stripBoilerplate(normalizeText(GUTEN));
    expect(r.text).not.toContain('Updated editions will replace');
    expect(r.text).not.toContain('copyright law means');
  });

  it('头部样板也被剥离', () => {
    const r = stripBoilerplate(normalizeText(GUTEN));
    expect(r.text).not.toContain('This eBook is for the use');
    expect(r.text).not.toContain('The Project Gutenberg eBook of');
  });

  it('记录命中的标记（人工可核对是否剥错）', () => {
    const r = stripBoilerplate(normalizeText(GUTEN));
    expect(r.hitMarkers.length).toBeGreaterThanOrEqual(2);
    expect(r.hitMarkers.some((m) => m.startsWith('START'))).toBe(true);
    expect(r.hitMarkers.some((m) => m.startsWith('END'))).toBe(true);
  });

  it('没有样板时不动文本', () => {
    const r = stripBoilerplate(normalizeText('第一章\n\n纯正文。\n\n第二章\n\n还是正文。'));
    expect(r.removedChars).toBe(0);
    expect(r.hitMarkers).toEqual([]);
  });

  it('⚠ 剥样板后章节数不变（只删样板，不删正文）', () => {
    const before = detectChapters(normalizeText(GUTEN));
    const after = detectChapters(normalizeWithStrip(GUTEN).text);
    expect(after.chapters.length).toBe(before.chapters.length);
  });

  it('⚠ 剥样板后最后一章不再异常膨胀', () => {
    const r = normalizeWithStrip(GUTEN);
    const det = detectChapters(r.text);
    const last = det.chapters.at(-1)!;
    // 剥离前最后一章含大段许可文本，剥离后应只剩正文
    expect(last.body).not.toContain('copyright');
    expect(last.body.length).toBeLessThan(200);
  });

  it('⚠ 取最早的 END 标记（实测踩到：End of Project Gutenberg\'s 在 *** END *** 之前）', () => {
    // 真实文件里 "End of Project Gutenberg's ..."（21328 行）
    // 出现在 "*** END OF THE PROJECT GUTENBERG EBOOK ***"（21332 行）之前。
    // 若按"第一个命中的模式"截断，就会把前一句英文留在正文里。
    const t = [
      '第一章 正文',
      '正文内容。',
      '',
      "End of Project Gutenberg's 某书, by 某作者",
      '',
      '*** END OF THE PROJECT GUTENBERG EBOOK 某书 ***',
      '',
      'Updated editions will replace the previous one.',
    ].join('\n');
    const r = stripBoilerplate(normalizeText(t));
    expect(r.text).not.toContain("End of Project Gutenberg's");
    expect(r.text).not.toContain('Updated editions');
    expect(r.text).toContain('正文内容。');
  });

  it('⚠ 取最晚的 START 标记（头部可能有两段样板）', () => {
    const t = [
      'This eBook is for the use of anyone anywhere',
      'almost no restrictions whatsoever.',
      '',
      '*** START OF THE PROJECT GUTENBERG EBOOK 某书 ***',
      '',
      '第一章 正文',
    ].join('\n');
    const r = stripBoilerplate(normalizeText(t));
    expect(r.text).not.toContain('This eBook is for');
    expect(r.text).not.toContain('START OF THE PROJECT');
    expect(r.text).toContain('第一章 正文');
  });

  it('⚠ 只有 END 标记没有 START 时也剥离尾部（保守但有效）', () => {
    const only = '第一章\n\n正文。\n\n*** END OF THE PROJECT GUTENBERG EBOOK X ***\n\n大段样板';
    const r = stripBoilerplate(normalizeText(only));
    expect(r.text).toContain('正文。');
    expect(r.text).not.toContain('大段样板');
  });
});

// ══════════════════════════════════════════════════════════
describe('⚠ 中文数字解析与回目缺口（真实数据验证暴露）', () => {
  // 真实场景：《三国演义》Gutenberg 版从「九十九回」直接跳到「一一一回」
  // （源文本缺 100–110 回）。若只按出现顺序编号（1..108），
  // 证据引用就无法对上原文回目（§46 要求可回溯）。
  it('解析中文数字', () => {
    expect(parseChineseNumber('一')).toBe(1);
    expect(parseChineseNumber('十')).toBe(10);
    expect(parseChineseNumber('十五')).toBe(15);
    expect(parseChineseNumber('二十')).toBe(20);
    expect(parseChineseNumber('九十九')).toBe(99);
    expect(parseChineseNumber('一百')).toBe(100);
    expect(parseChineseNumber('一百二十')).toBe(120);
  });

  it('解析逐位写法（一一九 = 119）', () => {
    expect(parseChineseNumber('一一九')).toBe(119);
    expect(parseChineseNumber('一一一')).toBe(111);
  });

  it('解析阿拉伯数字', () => {
    expect(parseChineseNumber('42')).toBe(42);
  });

  it('无法解析时返回 null（不猜）', () => {
    expect(parseChineseNumber('abc')).toBeNull();
    expect(parseChineseNumber('')).toBeNull();
  });

  it('从标题提取声明号', () => {
    expect(declaredNumberOf('第一百二十回：某标题')).toBe(120);
    expect(declaredNumberOf('第5章 开端')).toBe(5);
    expect(declaredNumberOf('Chapter 7')).toBe(7);
    expect(declaredNumberOf('无编号的标题')).toBeNull();
    expect(declaredNumberOf(null)).toBeNull();
  });

  it('⚠ 检出回目缺口（99 → 111 表示缺 100–110）', () => {
    const text = [
      '第九十九回 甲', '正文', '',
      '第一一一回 乙', '正文', '',
      '第一一二回 丙', '正文',
    ].join('\n');
    const r = detectChapters(text);
    // 跳变 11 章 > 10 → 归为"编号混乱"而非真实缺章
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]!.after).toBe(99);
    expect(r.gaps[0]!.before).toBe(111);
    expect(r.gaps[0]!.kind).toBe('numbering');
  });

  it('⚠ 真实缺章（跳变 ≤3）归为 missing', () => {
    // 阈值取 3：实测源文本的小幅乱序是 1~3 章
    const text = ['第九十九回 甲', '正文', '', '第一百零二回 乙', '正文'].join('\n');
    const r = detectChapters(text);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]!.kind).toBe('missing');
    expect(r.gaps[0]!.missing).toBe(2);
  });

  it('⚠ 跳变 >3 归为 numbering（源文本乱序）', () => {
    const text = ['第九十九回 甲', '正文', '', '第一百零五回 乙', '正文'].join('\n');
    const r = detectChapters(text);
    expect(r.gaps[0]!.kind).toBe('numbering');
  });

  it('连续回目无缺口', () => {
    const text = ['第一回 甲', '正文', '', '第二回 乙', '正文', '', '第三回 丙', '正文'].join('\n');
    expect(detectChapters(text).gaps).toEqual([]);
  });

  it('⚠ summarizeGaps 区分缺章与编号混乱（实测斗破混着两种）', () => {
    const text = [
      '第一回 甲', '正文', '',
      '第三回 乙', '正文', '',      // 缺 1 章（missing）
      '第一四二四回 丙', '正文',    // 跳变巨大（numbering）
    ].join('\n');
    const r = detectChapters(text);
    const s = summarizeGaps(r.gaps);
    expect(s.missingCount).toBe(1);
    expect(s.missingChapters).toBe(1);
    expect(s.numberingCount).toBe(1);
  });

  it('⚠ 声明号与序号分离（序号连续、声明号会跳）', () => {
    const text = ['第九十九回 甲', '正文', '', '第一一一回 乙', '正文'].join('\n');
    const r = detectChapters(text);
    expect(r.chapters[0]!.number).toBe(1);
    expect(r.chapters[0]!.declaredNumber).toBe(99);
    expect(r.chapters[1]!.number).toBe(2);
    expect(r.chapters[1]!.declaredNumber).toBe(111);
  });

  it('无标题章节没有声明号', () => {
    const r = detectChapters('纯散文，没有章节标记。');
    expect(r.chapters[0]!.declaredNumber).toBeNull();
    expect(r.gaps).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════
describe('导入报告记录样板与缺口', () => {
  it('报告含 boilerplate 与 declaredGaps', () => {
    const text = [
      '*** START OF THE PROJECT GUTENBERG EBOOK 测试 ***',
      '',
      '第一回 甲', '正文一', '',
      '第二回 乙', '正文二', '',
      '*** END OF THE PROJECT GUTENBERG EBOOK 测试 ***',
      '样板文本',
    ].join('\n');

    const r = importer().import({
      title: '带样板',
      text,
      sourceType: 'PUBLIC_DOMAIN',
      licenseType: 'PUBLIC_DOMAIN',
      allowedUsage: 'FULL_ANALYSIS',
    });

    expect(r.ok).toBe(true);
    expect(r.strippedChars).toBeGreaterThan(0);
    expect(r.hitMarkers!.length).toBeGreaterThan(0);

    const report = JSON.parse(readFileSync(join(r.dir!, 'import.json'), 'utf8'));
    expect(report.boilerplate.removedChars).toBeGreaterThan(0);
    expect(report.boilerplate.hitMarkers.length).toBeGreaterThan(0);
    expect(Array.isArray(report.declaredGaps)).toBe(true);
  });
});
