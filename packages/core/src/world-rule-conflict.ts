/**
 * 世界规则与正文的冲突判据（P2-4）
 *
 * ## 解决的问题
 *
 * P2-3 让作者能写并确认世界观设定，设定也进了 Writer/Planner 的 prompt。
 * 但**连续性检查仍然只看 Canon facts**（从正文里推断出来的），
 * 作者手写的世界规则完全不在检查范围内：
 *
 *   设定说「灵力枯竭，施法会消耗寿命，不可逆」
 *   正文写「他恢复了被抽走的寿命」
 *   → 检查器一声不响。
 *
 * 这正是"设定与 Canon 尚未联动"——作者以为设定是权威，实际只是提示词里的一句话。
 *
 * ## 为什么放 core 而不是 story
 *
 * `story`（ContinuityChecker）要判，`harness`（审稿上下文装配）也要判，
 * 而 `harness` 已经依赖 `story`，两边都需要。按"共享判据放一处、
 * 放在双方都够得到的最低层"的原则，上提到零依赖的 `core`。
 * 与 `rule-conflict.ts`（P0-7 技能冲突判据）是同一个理由与同一层。
 *
 * ## ⚠ 判据的边界：宁可漏判，不可误判
 *
 * 自然语言规则无法精确判定。实测取舍（同 `rule-conflict.ts` 的既定原则）：
 *
 * - **误判的代价**：作者被指出一个并不存在的问题，会开始不信任检查报告，
 *   进而忽略真正的问题 —— 这比不检查更糟。
 * - **漏判的代价**：作者仍可在审稿报告里看到规则清单，自行核对。
 *
 * 所以这里**只判两类能被机械确定的**：
 *   1. `不可逆 / 无法恢复` 类不变量被正文**明确推翻**（出现"恢复/复原/逆转"）
 *   2. `禁止/不能 + 动作` 类禁令，其**动作关键词**在正文中**被肯定地执行**
 *
 * 把握不足的一律不报。语义层面的判断交给模型（Reviewer 会拿到规则清单，
 * 可以引用规则 id 报 WORLD_RULE 问题）—— 这也是本项目一贯的分工：
 * 机械判定只做能确定的部分。
 */
import { Logger } from './logging.js';

/** 参与判定的世界规则（只含判定所需字段，便于单测构造） */
export interface WorldRuleForCheck {
  readonly id: string;
  /** 规则名，如「灵力枯竭」 */
  readonly name: string;
  /** 规则内容，如「施法会消耗寿命，不可逆」 */
  readonly description: string;
}

export type RuleKind = 'INVARIANT' | 'PROHIBITION';

export interface ParsedRule {
  readonly id: string;
  readonly kind: RuleKind;
  /** 被声明为不变/被禁止的核心词（用于在正文中定位） */
  readonly keywords: readonly string[];
  /** 原始规则文本 */
  readonly raw: string;
}

export interface RuleViolation {
  readonly ruleId: string;
  readonly kind: RuleKind;
  /** 正文中触发判定的片段（供人工定位，必须非空） */
  readonly quote: string;
  /** 人可读说明 */
  readonly explanation: string;
}

/**
 * 声明"不可逆 / 无法恢复"的词。
 *
 * ⚠ 这些词决定了规则是否属于可机械判定的不变量。不在表内的规则
 *   （如"灵力稀薄"这类描述性设定）不做自动判定 —— 判不了就别判。
 */
const IRREVERSIBLE_MARKERS: readonly RegExp[] = [
  /不可逆/,
  /不可逆转/,
  /无法逆转/,
  /不可恢复/,
  /无法恢复/,
  /不可复原/,
  /永久(性)?(地)?(失去|损毁|消失|无法)/,
  /一旦[^，。；]{0,12}(就|便|再也)/,
];

/** 正文里"把不可逆的事扭转回来"的写法 */
const REVERSAL_MARKERS: readonly RegExp[] = [
  /恢复(了|过来|如初|原样|正常)/,
  /复原(了|如初)/,
  /逆转(了|过来)/,
  /失而复得/,
  /重新(获得|得到|拥有|长出)/,
  /又(能|可以|可以再)/,
  /复活/,
  /死而复生/,
];

/** 禁止类标记 */
const PROHIBITION_MARKERS: readonly RegExp[] = [
  /禁止/,
  /严禁/,
  /不得/,
  /不能/,
  /不可/,
  /无法/,
  /绝(不|不能)/,
];

/**
 * 停用词：这些词出现在规则里但不指示具体动作，
 * 拿它们在正文里搜索会产生大量无关命中。
 */
const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '被', '把', '让', '给',
  '可以', '能够', '任何', '所有', '一切', '都', '也', '还', '就',
  '这个', '那个', '一个', '什么', '自己', '他人', '别人',
  '使用', '进行', '出现', '发生', '产生', '成为', '存在',
]);

/**
 * 解析一条世界规则。
 *
 * ⚠ 只接受**能解析出关键词**的规则；解析不出就返回 null（不判）。
 *   返回 null 不是失败，是"这条规则不适合机械判定"。
 */
export function parseWorldRule(rule: WorldRuleForCheck): ParsedRule | null {
  const text = `${rule.name}。${rule.description}`.trim();
  if (text.length === 0) return null;

  // 优先级：不变量 > 禁令。
  // 「施法会消耗寿命，不可逆」同时含禁令词"不"与不变量词"不可逆"，
  // 按不变量判更准 —— 它约束的是"结果能否被扭转"。
  const isInvariant = IRREVERSIBLE_MARKERS.some((re) => re.test(text));
  if (isInvariant) {
    const keywords = extractKeywords(rule.name, rule.description);
    if (keywords.length === 0) return null;
    return { id: rule.id, kind: 'INVARIANT', keywords, raw: text };
  }

  const prohibition = PROHIBITION_MARKERS.find((re) => re.test(text));
  if (prohibition) {
    // 取标记之后的部分作为"被禁止的动作"
    const idx = text.search(prohibition);
    const after = text.slice(idx).replace(prohibition, '');
    const keywords = extractKeywords('', after);
    if (keywords.length === 0) return null;
    return { id: rule.id, kind: 'PROHIBITION', keywords, raw: text };
  }

  return null;
}

/**
 * 抽取可用于正文搜索的关键词。
 *
 * ⚠ **必须细到能在正文里命中**。第一版只按标点切分，于是规则
 *   「施法会消耗寿命，不可逆」抽出的关键词是整句「施法会消耗寿命」——
 *   正文里写「被抽走的寿命」永远匹配不上，判据静默失效（实测被测试抓到）。
 *
 * 做法：标点切分 → 再按连接/助动词切分 → 对每个片段补 2~4 字后缀。
 * 中文的实词多以 2 字为主（"寿命""枯竭""复活"），补后缀能让它们露出来。
 *
 * ⚠ 刻意**保留长短两种粒度**（"消耗寿命" 与 "寿命" 并存）：
 *   判定时取正文中**命中且最长**的那个用于引用定位，
 *   精度与召回各取所需 —— 这比只留一种更稳。
 */
export function extractKeywords(name: string, body: string): string[] {
  const out = new Set<string>();
  for (const src of [name, body]) {
    // 1) 按标点切分
    for (const chunk of src.split(/[，。；、：！？,.;:!?\s（）()「」《》""'']+/)) {
      const t = chunk.trim();
      if (t.length < 2) continue;
      // 2) 再按连接词/助动词切分（"施法会消耗寿命" → "施法" / "消耗寿命"）
      for (const part of t.split(/[会能可要须得让使把被对向从在与和及或非未别]/)) {
        const p = part.trim();
        if (p.length < 2) continue;
        if (STOPWORDS.has(p)) continue;
        out.add(p);
        // 3) 补 2~4 字后缀（中文实词多为 2 字，需要它们露出来）
        for (let len = 2; len <= 4 && len < p.length; len++) {
          const suf = p.slice(p.length - len);
          if (!STOPWORDS.has(suf)) out.add(suf);
        }
      }
    }
  }
  return [...out].slice(0, 12);
}

/**
 * 在正文里找违反规则的位置。
 *
 * 返回 null = 没发现可判定的违反（**不代表没违反**，见模块头的边界说明）。
 */
export function findRuleViolation(
  rule: ParsedRule,
  draftText: string,
): RuleViolation | null {
  if (rule.keywords.length === 0) return null;

  // ⚠ 取**命中且最长**的那个用于定位：短词（"寿命"）用于召回，
  //   长词（"消耗寿命"）用于给出更精确的引用片段。
  const hits = rule.keywords.filter((k) => draftText.includes(k));
  const longestHit = hits.length > 0 ? hits.reduce((a, b) => (b.length > a.length ? b : a)) : null;

  if (rule.kind === 'INVARIANT') {
    // 找"把不可逆的事扭转回来"的写法
    const reversal = REVERSAL_MARKERS.find((re) => re.test(draftText));
    if (!reversal) return null;
    const reversalText = draftText.match(reversal)?.[0] ?? '';

    // ⚠ 关联性判定 —— 必须有这一步，否则一条"死亡不可逆"会去报
    //   正文里任何一处"恢复"（无关场景），变成噪音。
    //
    // 两条通路任一成立即算关联：
    //   a) 规则关键词在正文里出现（"寿命"）
    //   b) 反转写法与规则文本**有共同实词字**（"死而复生" ↔ "死亡不可逆"）
    //
    // 通路 b 是必需的：规则「死亡不可逆」抽不出"死而复生"这个词，
    // 只靠关键词会漏掉这一类（实测被测试抓到）。
    const linked =
      longestHit !== null || sharesContentChar(reversalText, rule.raw);
    if (!linked) return null;

    const anchor = longestHit ?? reversalText;
    return {
      ruleId: rule.id,
      kind: 'INVARIANT',
      quote: quoteAround(draftText, anchor),
      explanation:
        `规则「${rule.raw}」声明为不可逆，但正文出现「${reversalText}」类写法` +
        (longestHit !== null ? `（涉及「${longestHit}」）` : ''),
    };
  }

  if (longestHit === null) return null;

  // PROHIBITION：被禁止的动作关键词在正文中出现，且**不是**在否定语境里
  const idx = draftText.indexOf(longestHit);
  if (idx < 0) return null;
  const window = draftText.slice(Math.max(0, idx - 24), idx + longestHit.length + 24);
  if (isNegated(window, longestHit)) return null;

  return {
    ruleId: rule.id,
    kind: 'PROHIBITION',
    quote: quoteAround(draftText, longestHit),
    explanation: `规则「${rule.raw}」禁止的行为在正文中出现（「${longestHit}」）`,
  };
}

/**
 * 两段文本是否共享"有内容"的汉字。
 *
 * ⚠ 必须剔除高频虚词 —— 否则"的/了/不/是"会让任意两句话都被判成相关，
 *   关联性判定就失去意义了。
 */
const CONTENT_STOPCHARS = new Set('的了不是和与或在有也就都还让把被给对向从并且但是因为所以这那什么一个我你他她它们'.split(''));

function sharesContentChar(a: string, b: string): boolean {
  for (const ch of a) {
    if (CONTENT_STOPCHARS.has(ch)) continue;
    if (b.includes(ch)) return true;
  }
  return false;
}

/**
 * 判断关键词是否处于否定语境。
 *
 * ⚠ 必须有这一步：规则本身常含否定词，正文复述规则时（"他想起长老说过，
 *   不能消耗寿命"）会命中关键词 —— 那不是违反，是在遵守。
 */
function isNegated(window: string, keyword: string): boolean {
  const at = window.indexOf(keyword);
  const before = window.slice(Math.max(0, at - 10), at);
  return /(不|没|未|别|勿|禁止|严禁|无法|不能|不可|没有|从不)/.test(before);
}

/** 取关键词附近的一段原文作为定位片段 */
function quoteAround(text: string, keyword: string, radius = 20): string {
  const at = text.indexOf(keyword);
  if (at < 0) return keyword;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + keyword.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

export interface WorldRuleCheckResult {
  readonly violations: readonly RuleViolation[];
  /** 实际解析并参与判定的规则数（可断言，防"空跑也算通过"） */
  readonly parsedRules: number;
  /** 解析不出关键词、未参与判定的规则数（如实上报，不假装都查了） */
  readonly skippedRules: number;
}

/**
 * 批量检查：世界规则 vs 正文。
 *
 * ⚠ 未解析成功的规则计入 `skippedRules` 并记日志 ——
 *   否则"检查了 0 条规则"会伪装成"没有违反"。这与
 *   `ContinuityReport.checked` 的既有约定一致。
 */
export function checkWorldRules(
  rules: readonly WorldRuleForCheck[],
  draftText: string,
  logger?: Logger,
): WorldRuleCheckResult {
  const violations: RuleViolation[] = [];
  let parsedRules = 0;
  const skipped: string[] = [];

  for (const r of rules) {
    const parsed = parseWorldRule(r);
    if (parsed === null) {
      skipped.push(r.id);
      continue;
    }
    parsedRules++;
    const v = findRuleViolation(parsed, draftText);
    if (v !== null) violations.push(v);
  }

  if (skipped.length > 0) {
    logger?.debug('世界规则无法机械判定，未参与检查', {
      skipped: skipped.length,
      ids: skipped.slice(0, 5),
    });
  }

  return { violations, parsedRules, skippedRules: skipped.length };
}

/**
 * 生成交给模型判定的规则清单。
 *
 * ⚠ 机械判定只能覆盖明确的两类。其余规则（"灵力稀薄""贵族不得经商"等）
 *   需要模型结合上下文判断 —— 把规则**原文 + id** 给出去，
 *   模型才能引用规则 id 报 WORLD_RULE 问题（可复核），
 *   而不是凭感觉说"好像违反了世界观"。
 */
export function renderWorldRulesForReview(
  rules: readonly WorldRuleForCheck[],
): string {
  if (rules.length === 0) return '';
  const lines = rules.map(
    (r) => `- [${r.id}] ${r.name}${r.description ? `：${r.description}` : ''}`,
  );
  return ['## 作者已确认的世界规则（判断 WORLD_RULE 问题时的依据）', ...lines].join('\n');
}
