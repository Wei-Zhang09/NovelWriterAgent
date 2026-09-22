/**
 * 网络语料清洗（真实语料验证暴露）
 *
 * ## 为什么需要它
 *
 * 用户提供的《斗破苍穹》文本来自网络转载，含四类噪声
 * （实测统计，全文 580 万字）：
 *
 * | 噪声 | 规模 |
 * |---|---|
 * | 反爬水印 `武动乾坤`（插在句末标点前） | **40498 处 ≈ 20.2 万字** |
 * | 括号内 ASCII 水印（`（手机阅读16kxs)` 等） | 80 处 |
 * | 作者话（`ps：求月票…`） | 37 行 |
 * | 强促销段落（求票/加更/新书宣传） | 95 行 |
 *
 * ## 为什么必须清（而不是"多一点噪声"）
 *
 * 水印出现 4 万次，会让 NDE 全链路产生**系统性偏差**：
 *   - 场景标注：每句话尾都粘着另一部作品的名字
 *   - 模式挖掘：`武动乾坤` 会被当成高频词/实体
 *   - 编译出的 Skill 可能把"句尾加一个无关名词"学成模式
 *
 * ## ⚠ 清洗是**破坏性**操作，必须可审计
 *
 * 清洗改变了原文，因此：
 *   1. 每条规则**记录删除量**，不静默
 *   2. 保留原始 content hash（清洗前后都记）
 *   3. 保守优先：宁可漏删让人工发现，也不要误删正文
 *
 * 实测踩到的误删风险：`目光迷离的望着那…（最后四天时间，拜请诸位弟兄点击下方推荐月票…`
 * —— 一行里**前半是正文、后半是促销**。所以按"整行删除"处理会丢掉正文，
 * 必须按"括号片段"删除。
 */
import type { CleanReport } from './types.js';

/** 反爬水印：插在句末标点前的另一个作品名 */
const WATERMARK_WORDS = ['武动乾坤'];

/**
 * 括号内水印的特征词（命中任一即判定为水印）。
 *
 * ⚠ 用具体特征而非"含 ASCII 就删" —— 正文里合法出现的英文
 *   （人名、术语）不能被误删。
 */
const PAREN_WM_PATTERNS: readonly RegExp[] = [
  // ⚠ 促销类括号也算水印：实测有「…复杂的情绪（最后四天时间，拜请诸位弟兄点击下方推荐月票支持作者）」
  //   —— 正文在前、促销在括号里，必须只删括号。
  /月票|推荐票|求票|加更|收藏|订阅/,
  /支持作者|支持正版|拜请|恳求|感激|谢谢/,
  /手机阅读|电脑阅读|手机站|wap|WAP/,
  /\d*\s*k?xs/i,
  /\.(com|net|cn|org|cc|info)\b/i,
  /www\./i,
  /手打|会员上传|会员手打/,
  /txt格式|下载txt/i,
  /登陆|登录.*阅读/,
  /首发|首发于/,
];

/**
 * 内联水印（**不在括号里**，直接插进句子中间）。
 *
 * ⚠ 实测形态很刁钻，水印会和正文粘在一起：
 *   - `更/新/最/快16kxs砰`（插在拟声词中间）
 *   - `手机快速阅读：16kxs中，药材丹药这一部分…`（水印后正文继续）
 *   - `手机看小说访问wap.16kxs还将如何正确化解心火的诀窍…`
 *
 * 因此按"水印片段"删除，而不是整行删除 —— 整行删会丢掉后面的正文。
 */
/**
 * 书籍元信息头部（番茄/起点等平台的导出格式）。
 *
 * ⚠ 实测《清纯校花傻白甜》开头有：
 *   ```
 *   书籍信息
 *   书名：…
 *   连载状态：已完结
 *   字数：117.9 万字
 *   章节数：488 章
 *   【简介】…
 *   ————————————————
 *   ```
 *   这段是**平台元信息 + 简介**，不是正文。简介还会被当成正文
 *   参与场景标注 —— 而它其实是"全书概要"，会让模式挖掘
 *   误判"开篇手法"。
 *
 * ⚠ 但简介本身有信息量（题材标签），因此**单独提取**而非丢弃。
 */
const META_HEADER = /^书籍信息\s*$[\s\S]{0,4000}?(?:^[—-]{4,}\s*$)/m;

/** 平台元信息字段行（书名：/字数：/章节数：/连载状态：） */
const META_FIELD = /^(书名|作者|连载状态|字数|章节数|更新时间|标签|分类)[：:].*$/;

/** 简介块标记 */
const SYNOPSIS_MARK = /^【简介】\s*$/;

/** 每章的时间戳行（实测 488 处） */
const CHAPTER_TIMESTAMP = /^\s*章节更新时间[：:]\s*[\d\-:\s]+$/;

/** 卷尾标记后缀：「第61章 未来（第一卷 完）」 */
const VOLUME_END_SUFFIX = /[（(]第[0-9一二三四五六七八九十百千零〇两]+卷\s*完[）)]/;

const INLINE_WM: readonly RegExp[] = [
  // ⚠ 新形态（实测《凡人修仙传》《诛仙》）：
  //   - `圣堂最新章节` 直接插在句子中间（11 处）
  //   - `<strong>最新章节全文阅读..info</strong>` 带 HTML 标签（134 处）
  //   - `一秒记住【..info】，为您提供精彩小说阅读。` 独立成行（2485 处）
  //   - `<ahref=""target="_nk">http://"></a>` 空链接（85 处）
  /<[a-zA-Z/][^>]{0,60}>/g, // 所有 HTML 标签
  /圣堂最新章节/g,
  /一秒记住\s*【[^】]{0,30}】[，,]?\s*为您提供精彩小说阅读[。.]?/g,
  /最新章节全文阅读/g,
  /最新章节/g,
  /\.\.info/g,
  /https?:\/\/\S{0,80}/g,
  // ⚠ 一律限定为 **ASCII/标点**，绝不能用 \S* ——
  //   实测 `手机快速阅读[：:]\s*\S*` 会把后面的中文正文一起吃掉
  //   （「手机快速阅读：16kxs中，药材丹药这一部分…」整段消失）。
  /手机看小说访问\s*[0-9a-zA-Z._:/]*/g,
  /手机快速阅读[：:]\s*[0-9a-zA-Z._:/]*/g,
  /更\/新\/最\/快\s*[0-9a-zA-Z._:/]*/g,
  /wap\.[0-9a-z.]+/gi,
  /\d*kxs/gi,
  /文字版首发[0-9a-zA-Z._:/]*/g,
  /如欲知后事如何[^\n）)]{0,40}/g,
  /(?:请)?登陆[^\n）)]{0,20}章节更多[^\n）)]{0,20}/g,
  /支持作者[，,]?\s*支持正版阅读[！!]?/g,
  /手机端阅读请登陆[0-9a-zA-Z._:/]*/g,
];

/**
 * 明确的"求票/作者话"短语。
 *
 * ⚠ 这些短语**正文绝不会出现**（正常叙事不会写"求月票"），
 *   因此可以精确匹配，不必依赖信号词计数。
 *   实测残留的 44 处全是这类短小独立段落。
 */
const EXPLICIT_SOLICIT = new RegExp(
  [
    '求月票',
    '求推荐票',
    '拜求',
    '恳求月票',
    '求票',
    // ⚠ 「未完待续」必须限定在**句末**：实测《百岁之好》有
    //   「心里惦记着未完待续的吻」—— 那是正当正文，误删会丢内容。
    // ⚠ 只认**句末**的「未完待续」（后跟句末标点或行尾）。
    //   实测放宽到逗号会误判：《百岁之好》有正当正文
    //   「课后习题都是未完待续，明天就要开始检查了」。
    //   含逗号的求票段落改由「信号词 ≥3」规则覆盖。
    '未完待续(?=[。！？…）)\\s]|$)',
    '如欲知后事',
    '支持正版阅读',
    '月票距离',
    '月票被',
    '月票涨',
    '投给.{0,6}月票',
    '更新到[～~]',
  ].join('|'),
);

/** 强促销信号词（用于识别作者话/求票段落） */
const PROMO_SIGNALS = [
  '月票', '推荐票', '求票', '加更', '断更', '新书', '收藏', '点击',
  '读者', '书友', '投票', '票数', '更新', '正版', '盗版', '码字',
  '三江', '访谈', '爆发',
];

/** 判断一段文字是否是"促销/作者话"（命中 ≥2 个信号词） */
export function isPromoText(s: string): boolean {
  const hits = PROMO_SIGNALS.filter((k) => s.includes(k)).length;
  return hits >= 2;
}

/** 统计促销信号词命中数 */
function countPromoSignals(s: string): number {
  return PROMO_SIGNALS.filter((k) => s.includes(k)).length;
}

/** 首个促销信号词的位置（用于切出前面的正文） */
function firstPromoIndex(s: string): number {
  let min = -1;
  for (const k of PROMO_SIGNALS) {
    const i = s.indexOf(k);
    if (i >= 0 && (min < 0 || i < min)) min = i;
  }
  // 显式求票短语的起点更准（如「继续求月票」应切在「继续」之前）
  const m = EXPLICIT_SOLICIT.exec(s);
  if (m && (min < 0 || m.index < min)) min = m.index;
  return min < 0 ? s.length : min;
}

export interface CleanOptions {
  /**
   * 是否删除番外篇（默认 **false** —— 不删）。
   *
   * ## 为什么默认不删（实测数据推翻了原设计）
   *
   * 原设计默认删除，理由是"番外从第一章重新编号会污染章节统计"。
   * 但实测两部书的规模差异极大：
   *
   * | 作品 | 番外规模 | 占全文 |
   * |---|---|---|
   * | 斗破苍穹 | 31,847 字 | 0.5% |
   * | 凡人修仙传 | **1,235,903 字** | **15%** |
   *
   * 静默丢掉 15% 的正文（且是同作者同世界观的可用材料）
   * 远比"章号碰撞"严重 —— 章号碰撞已经有 `declaredNumber`
   * 如实暴露（记为 numbering 缺口），人工能看到；
   * 而内容一旦删掉就没了。
   *
   * 因此改为**默认保留**，需要删时显式传 `dropExtras: true`。
   */
  readonly dropExtras?: boolean;
  /** 生成清理报告（默认 true） */
  readonly report?: boolean;
}

export interface CleanResult {
  readonly text: string;
  readonly report: CleanReport;
}

interface RuleStat {
  readonly name: string;
  readonly count: number;
  readonly removedChars: number;
}

/**
 * 清洗网络转载小说文本。
 *
 * ⚠ 顺序有讲究：先删水印（局部替换），再删整行/整段（块删除），
 *   最后处理番外（尾部截断）—— 顺序反了会让后面的规则基于脏数据判断。
 */
export function cleanWebNovel(input: string, opts: CleanOptions = {}): CleanResult {
  let text = input;
  const stats: RuleStat[] = [];
  const samples: { rule: string; sample: string }[] = [];

  const before = text.length;

  // ── 规则 1：反爬水印（紧贴句末标点前）──
  //
  // 实测：40498/40500 处的形态是「…骚动武动乾坤。」，
  // 水印插在句末标点**之前**。删水印、保留标点。
  let wmCount = 0;
  let wmChars = 0;
  for (const w of WATERMARK_WORDS) {
    // 「X武动乾坤。」→「X。」（保留标点）
    const rePunct = new RegExp(`([^。！？，、；：…）)】」』])${w}([。！？])`, 'g');
    text = text.replace(rePunct, (_m, p1: string, p2: string) => {
      wmCount++;
      wmChars += w.length;
      return p1 + p2;
    });
    // 剩余的裸水印（作者话里的正当提及也在这里被清掉，但那些行稍后整行删）
    const reBare = new RegExp(w, 'g');
    text = text.replace(reBare, () => {
      wmCount++;
      wmChars += w.length;
      return '';
    });
  }
  if (wmCount > 0) {
    stats.push({ name: '反爬水印', count: wmCount, removedChars: wmChars });
    samples.push({ rule: '反爬水印', sample: '…带起了一阵嘲讽的骚动[武动乾坤]。 → …骚动。' });
  }

  // ── 规则 2：括号内水印（按片段删，不整行删）──
  //
  // ⚠ 必须按片段：实测有一行前半是正文、后半是促销。
  let parenCount = 0;
  let parenChars = 0;
  text = text.replace(/[（(]([^（）()]{1,80})[）)]/g, (m, inner: string) => {
    const isWm = PAREN_WM_PATTERNS.some((re) => re.test(inner));
    if (isWm) {
      parenCount++;
      parenChars += m.length;
      return '';
    }
    return m;
  });
  if (parenCount > 0) {
    stats.push({ name: '括号水印', count: parenCount, removedChars: parenChars });
    samples.push({ rule: '括号水印', sample: '（手机阅读16kxs) → （删除）' });
  }

  // ── 规则 2b：内联水印（不在括号里，粘在正文中）──
  let inlineCount = 0;
  let inlineChars = 0;
  for (const re of INLINE_WM) {
    const g = new RegExp(re.source, re.flags);
    text = text.replace(g, (m) => {
      inlineCount++;
      inlineChars += m.length;
      return '';
    });
  }
  if (inlineCount > 0) {
    stats.push({ name: '内联水印', count: inlineCount, removedChars: inlineChars });
    samples.push({ rule: '内联水印', sample: '更/新/最/快16kxs砰 → 砰' });
  }

  // ── 规则 3：整行促销/作者话 ──
  //
  // 判据（保守）：整行**完全**被括号包裹且是促销，或整行以 ps 开头。
  // ⚠ 不做"含促销词就删行" —— 正文里可能正当提到"更新"等词。
  const lines = text.split('\n');
  const kept: string[] = [];
  let lineCount = 0;
  let lineChars = 0;
  let tocCount = 0;
  let tocChars = 0;
  for (const raw of lines) {
    const s = raw.trim();
    if (s.length === 0) {
      kept.push(raw);
      continue;
    }
    // ⚠ 目录行（实测 101 条）：形如「vip章 目录 第五百四十章 胜!」。
    //   这类行的"正文"其实是下一章的内容，会造出**空正文章节**
    //   并让章节号错位（实测 55 章正文为空）。
    //   判据：行首出现"目录"字样 —— 正常正文不会这样写。
    if (/^(vip)?章?\s*目录|^目录\s*第/.test(s)) {
      tocCount++;
      tocChars += raw.length + 1;
      continue;
    }
    const isPs = /^(ps|PS|Ps)[：:）)]/.test(s);
    const fullyParened = /^[（(].*[）)]$/.test(s);
    // ⚠ 整行被括号包裹时，**1 个**信号词即判定为促销：
    //   小说正文极少整行加括号，那通常是作者话。
    //   实测「（第二更到，希望诸位弟兄能够丢几张推荐票，谢谢）」只有 1 个信号词。
    const drop = isPs || (fullyParened && countPromoSignals(s) >= 1);
    if (drop) {
      lineCount++;
      lineChars += raw.length + 1;
      continue;
    }
    kept.push(raw);
  }
  text = kept.join('\n');
  if (lineCount > 0) {
    stats.push({ name: '作者话/促销行', count: lineCount, removedChars: lineChars });
    samples.push({ rule: '作者话/促销行', sample: 'ps：第二更到。第三更十二点后' });
  }
  if (tocCount > 0) {
    stats.push({ name: '目录行（会造出空正文章节）', count: tocCount, removedChars: tocChars });
    samples.push({ rule: '目录行', sample: 'vip章 目录 第五百四十章 胜! → 删除（其"正文"属于下一章）' });
  }

  // ── 规则 3b：段落级促销（作者话与正文同段的情形）──
  //
  // ⚠ 阈值取 ≥3 个信号词（而非 ≥2）：实测 ≥2 会命中 140 段，
  //   其中混有正常叙事（"更新"等词在正文里也会出现）；
  //   ≥3 命中 68 段且样例全部是求票/作者话，更保守。
  //
  // ⚠ 只删**段落中从促销起点到段尾**的部分，不整段删 ——
  //   实测有"正文前半 + 促销后半"同段的情形。
  let paraCount = 0;
  let paraChars = 0;
  const paras = text.split(/\n\s*\n/);
  const keptParas: string[] = [];
  for (const para of paras) {
    const t = para.trim();
    if (t.length === 0) {
      keptParas.push(para);
      continue;
    }
    // ⚠ 两级判据：
    //   1) 显式求票短语（正文绝不出现）→ 直接判定为促销
    //   2) 信号词 ≥3（应对不含显式短语的作者话）
    // ⚠ 四级判据（从严到宽）：
    //   1) 显式求票短语（求月票/求推荐票/拜求/恳求月票/求票）—— 正文绝不出现
    //   2) 句末「未完待续」等弱显式短语
    //   3) 出现「未完待续」+ ≥1 个信号词
    //      （实测「…大家看完更新…万分感激了！未完待续，…」只有 1 个信号词，
    //        但「未完待续」在此数据集里是作者话的强标记）
    //   4) 信号词 ≥3
    //
    // ⚠ 第 3 条不会误伤正当正文：「课后习题都是未完待续，明天就要开始检查了」
    //   的信号词数为 0，因此不会被删（实测确认）。
    const hasSolicitWord = /求月票|求推荐票|拜求|恳求月票|求票/.test(t);
    const explicit = EXPLICIT_SOLICIT.test(t);
    const signals = countPromoSignals(t);
    const unfinishedPlusSignal = t.includes('未完待续') && signals >= 1;
    if (hasSolicitWord || explicit || unfinishedPlusSignal || (isPromoText(t) && signals >= 3)) {
      // 找促销起点：首个信号词的位置（尽量保住前面的正文）
      const idx = firstPromoIndex(t);
      const bodyPart = idx > 20 ? t.slice(0, idx).trim() : '';
      paraChars += t.length - bodyPart.length;
      paraCount++;
      if (bodyPart.length > 0) keptParas.push(bodyPart);
      continue;
    }
    keptParas.push(para);
  }
  text = keptParas.join('\n\n');
  if (paraCount > 0) {
    stats.push({ name: '段落促销（保留正文部分）', count: paraCount, removedChars: paraChars });
    samples.push({
      rule: '段落促销',
      sample: '…如嫉妒，如羡慕（最后四天时间，拜请诸位弟兄点击下方推荐月票… → 只留前半正文',
    });
  }

  // ── 规则 3c：空壳标题行（源文本的重复目录页）──
  //
  // ⚠ 实测形态：同一章标题出现**两次**，第一次后面没有任何正文：
  //     「第五百四十章 药皇，韩枫!」   ← 空壳（目录页残留）
  //     （空行）
  //     「第五百一十二章药皇，韩枫！」  ← 真正的章节，后面才有正文
  //   不清掉会让空壳抢走章节号，真章节反被降级（实测 56 章正文为空）。
  //
  // 判据严格：标题行之后**只有空行**，紧接着又是标题行 → 前者是空壳。
  let shellCount = 0;
  let shellChars = 0;
  {
    const ls = text.split('\n');
    const TITLE_LINE = /^第[0-9一二三四五六七八九十百千零〇两]+[章回节卷篇]/;
    const drop = new Set<number>();
    for (let i = 0; i < ls.length; i++) {
      if (!TITLE_LINE.test(ls[i]!.trim())) continue;
      // 往后找第一个非空行
      let j = i + 1;
      while (j < ls.length && ls[j]!.trim().length === 0) j++;
      if (j < ls.length && TITLE_LINE.test(ls[j]!.trim())) {
        drop.add(i);
        shellChars += ls[i]!.length + 1;
        shellCount++;
      }
    }
    if (drop.size > 0) {
      text = ls.filter((_, i) => !drop.has(i)).join('\n');
    }
  }
  if (shellCount > 0) {
    stats.push({ name: '空壳标题行（重复目录页）', count: shellCount, removedChars: shellChars });
    samples.push({ rule: '空壳标题行', sample: '「第五百四十章 药皇，韩枫!」后无正文，真章节在下一处' });
  }

  // ── 规则 3d：卷+章合并标题归一化 ──
  //
  // ⚠ 实测《凡人修仙传》：388 行标题形如
  //   「第九卷灵界百族第一千六百五十三章尸体与真血」
  //   —— 卷名与章名挤在一行。若不归一化，chapter-detect 只认
  //   「第X章」开头的行，这 388 章会被漏掉或与前章合并。
  //   归一化：拆成「卷行 + 章行」两行。
  let volChCount = 0;
  {
    const ls = text.split('\n');
    const out: string[] = [];
    const VOLCH = /^(\s*)(第[0-9一二三四五六七八九十百千零〇两]+卷[^第]{0,20}?)(第[0-9一二三四五六七八九十百千零〇两]+[章回].*)$/;
    for (const line of ls) {
      const m = VOLCH.exec(line);
      if (m) {
        out.push(`${m[1]}${m[2]}`.trimEnd());
        out.push(`${m[1]}${m[3]}`);
        volChCount++;
      } else {
        out.push(line);
      }
    }
    text = out.join('\n');
  }
  if (volChCount > 0) {
    stats.push({ name: '卷+章合并标题（归一化，不删内容）', count: volChCount, removedChars: 0 });
    samples.push({ rule: '卷+章合并标题', sample: '第九卷灵界百族第一千六百五十三章尸体与真血 → 拆两行' });
  }

  // ── 规则 3f：平台元信息头部（提取简介后删除）──
  //
  // ⚠ 简介单独提取保存：它是"全书概要"不是正文，参与场景标注会让
  //   模式挖掘误判"开篇手法"；但其中的题材标签对类型判定有价值。
  let synopsis: string | undefined;
  let metaChars = 0;
  {
    const m = META_HEADER.exec(text);
    if (m) {
      const block = m[0];
      // 提取简介部分
      const lines = block.split('\n');
      const synStart = lines.findIndex((l) => SYNOPSIS_MARK.test(l.trim()));
      if (synStart >= 0) {
        synopsis = lines
          .slice(synStart + 1)
          .filter((l) => !META_FIELD.test(l.trim()) && l.trim().length > 0)
          .join('\n')
          .trim();
      }
      metaChars = block.length;
      text = text.slice(m.index + block.length);
    }
  }
  if (metaChars > 0) {
    stats.push({ name: '平台元信息头部（简介已单独提取）', count: 1, removedChars: metaChars });
    samples.push({ rule: '平台元信息头部', sample: '「书籍信息 / 书名：… / 字数：… / 【简介】…」整块删除' });
  }

  // ── 规则 3g：每章时间戳行 ──
  //
  // ⚠ 实测《清纯校花傻白甜》488 章各有「章节更新时间：2023-04-30 21:17」。
  //   不清掉会混进场景文本（且它含数字，会污染 prose 统计）。
  let tsCount = 0;
  let tsChars = 0;
  {
    const ls = text.split('\n');
    const out: string[] = [];
    for (const line of ls) {
      if (CHAPTER_TIMESTAMP.test(line)) {
        tsCount++;
        tsChars += line.length + 1;
        continue;
      }
      out.push(line);
    }
    text = out.join('\n');
  }
  if (tsCount > 0) {
    stats.push({ name: '章节更新时间行', count: tsCount, removedChars: tsChars });
    samples.push({ rule: '章节更新时间行', sample: '章节更新时间：2023-04-30 21:17' });
  }

  // ── 规则 3h：卷尾后缀 ──
  //
  // ⚠ 实测形态：「第61章 未来（第一卷 完）」。
  //   后缀不删会让章节标题带上"（第一卷 完）"，
  //   影响标题文本的统计（虽不影响章号解析）。
  let volSuffix = 0;
  {
    const ls = text.split('\n');
    for (let i = 0; i < ls.length; i++) {
      if (VOLUME_END_SUFFIX.test(ls[i]!)) {
        ls[i] = ls[i]!.replace(VOLUME_END_SUFFIX, '').trimEnd();
        volSuffix++;
      }
    }
    if (volSuffix > 0) text = ls.join('\n');
  }
  if (volSuffix > 0) {
    stats.push({ name: '卷尾后缀（不删内容）', count: volSuffix, removedChars: 0 });
    samples.push({ rule: '卷尾后缀', sample: '第61章 未来（第一卷 完） → 第61章 未来' });
  }

  // ── 规则 3e：重复的 banner 标题行（同章号且无标题正文）──
  //
  // ⚠ 实测《凡人修仙传》每章标题出现**两次**：
  //     「 第二百三十二章 大衍决」        ← banner（无空格分隔标题与正文）
  //     「    第二百三十二章大衍决」      ← 真正的章标题（缩进 4 空格）
  //   两条都会命中标题正则，造成**同号重复**（实测 404 处假"编号混乱"）。
  //
  //   判据：同一声明号出现两次时，保留**带缩进**的那条（源文本用缩进标章标题），
  //   剔除另一条。若无缩进差异则保留第一条（不猜）。
  let bannerCount = 0;
  {
    const ls = text.split('\n');
    const TITLE_ONLY = /^(\s*)第([0-9一二三四五六七八九十百千零〇两]+)[章回](.*)$/;
    // 按声明号分组，记录出现位置
    const byNum = new Map<string, number[]>();
    for (let i = 0; i < ls.length; i++) {
      const m = TITLE_ONLY.exec(ls[i]!);
      if (!m) continue;
      const key = m[2]!;
      const arr = byNum.get(key) ?? [];
      arr.push(i);
      byNum.set(key, arr);
    }
    const drop = new Set<number>();
    for (const [, idxs] of byNum) {
      if (idxs.length < 2) continue;
      // 相邻出现（中间只有水印/空行）才可能是 banner 重复
      for (let k = 0; k + 1 < idxs.length; k++) {
        const a = idxs[k]!;
        const b = idxs[k + 1]!;
        if (b - a > 6) continue; // 隔太远，不是 banner 重复
        // 中间不能有别的章标题
        let hasOther = false;
        for (let j = a + 1; j < b; j++) {
          if (TITLE_ONLY.test(ls[j]!) && !/^\s*$/.test(ls[j]!)) {
            const mm = TITLE_ONLY.exec(ls[j]!);
            if (mm && mm[2] !== ls[a]!.match(TITLE_ONLY)![2]) hasOther = true;
          }
        }
        if (hasOther) continue;
        const indentA = /^(\s*)/.exec(ls[a]!)![1]!.length;
        const indentB = /^(\s*)/.exec(ls[b]!)![1]!.length;
        // 保留缩进更深的那条
        if (indentA !== indentB) {
          drop.add(indentA > indentB ? b : a);
        } else {
          drop.add(a); // 缩进相同 → 保留后者（banner 通常在前）
        }
      }
    }
    if (drop.size > 0) {
      text = ls.filter((_, i) => !drop.has(i)).join('\n');
      bannerCount = drop.size;
    }
  }
  if (bannerCount > 0) {
    stats.push({ name: '重复 banner 标题行', count: bannerCount, removedChars: 0 });
    samples.push({ rule: '重复 banner 标题行', sample: '「 第X章 标题」与「    第X章标题」重复 → 保留缩进版' });
  }

  // ── 规则 4：番外篇（章节号重置）──
  let extrasChars = 0;
  if (opts.dropExtras === true) {
    const cut = findExtrasStart(text);
    if (cut > 0) {
      extrasChars = text.length - cut;
      text = text.slice(0, cut);
      stats.push({ name: '番外篇', count: 1, removedChars: extrasChars });
      samples.push({ rule: '番外篇', sample: '章节号重置为「第一章」处之后的内容' });
    }
  }

  const removedChars = before - text.length;
  return {
    text,
    report: {
      ...(synopsis ? { synopsis } : {}),
      removedChars,
      removedRatio: before > 0 ? Number((removedChars / before).toFixed(4)) : 0,
      rules: stats,
      samples,
    },
  };
}

/**
 * 找出番外篇的起点。
 *
 * 判据：已出现过较大章号（≥100）之后，章号**重置**为 1 的位置。
 *
 * ⚠ 只认"重置为 1"这种明确信号，不做启发式猜测 ——
 *   误切会把正文当番外删掉。
 */
export function findExtrasStart(text: string): number {
  const lines = text.split('\n');
  // ⚠ 与 chapter-detect 同款严格正则：单位字后必须是空白/冒号/行尾。
  //   否则正文里的「在第一章，如果时间…」会被当成章节标题，
  //   导致 findExtrasStart 在 87% 处误切（实测删掉 74 万字正文）。
  const TITLE = /^第([0-9一二三四五六七八九十百千零〇两]+)章(?=[\s：:]|$)/;
  let maxSeen = 0;
  let offset = 0;

  for (const line of lines) {
    const m = TITLE.exec(line.trim());
    if (m?.[1]) {
      const n = parseCn(m[1]);
      if (n !== null) {
        // 已见过 ≥100 章，且现在重置为很小的号 → 番外开始
        if (maxSeen >= 100 && n <= 3) return offset;
        if (n > maxSeen) maxSeen = n;
      }
    }
    offset += line.length + 1;
  }
  return -1;
}

/** 中文数字解析（与 chapter-detect 同语义，此处独立避免循环依赖） */
function parseCn(t: string): number | null {
  const d: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (/^[0-9]+$/.test(t)) return Number(t);
  if (!/[十百千]/.test(t)) {
    let n = 0;
    for (const ch of t) {
      const v = d[ch];
      if (v === undefined) return null;
      n = n * 10 + v;
    }
    return n;
  }
  const u: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of t) {
    const v = d[ch];
    if (v !== undefined) {
      digit = v;
      continue;
    }
    const unit = u[ch];
    if (unit === undefined) return null;
    section += (digit === 0 ? 1 : digit) * unit;
    digit = 0;
  }
  total += section + digit;
  return total > 0 ? total : null;
}
