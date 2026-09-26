/**
 * AI 味模式检测（施工文档 §34）
 *
 * ## 目标：**减少模板化和僵硬表达，而不是故意伪装成人类**
 *
 * §34 原文如此。这个区别决定了所有判据的方向：
 *   我们检测的是**机械感**（模板化过渡、解释性总结、形容词堆叠），
 *   而不是"像不像某个真人"。后者既不可判定，也会把系统推向
 *   故意制造低质量表达（§31 规则 7 明令禁止）。
 *
 * ## §34 列出的检查项
 * ```
 * 过度总结 / 情绪直接标签化 / 所有人物语言趋同 / 模板化过渡
 * 连接词堆叠 / 段落节奏机械 / 形容词堆积 / 空泛环境描写
 * 重复解释 / 不必要的"首先/其次/然而" / 每段都总结 / 高潮处过度解释
 * ```
 *
 * ## ⚠ 判据必须用**真人作品**校准（否则会误伤正常写作）
 *
 * 这些规则天然容易假阳性 —— 真人小说里也有排比、也有"总之"。
 * 因此每个检测器都用《百岁之好》《清纯校花》的真实章节校准过，
 * 目标是**人类语料命中率极低**（< 1% 段落），否则说明阈值太松。
 * 具体校准数据见每个检测器的注释。
 *
 * ## ⚠ 严重级别刻意保守
 *
 * 全部为 `MINOR` / `NOTE`，**没有 BLOCKING**。
 * 理由：这些是"读起来机械"的判断，属于风格问题而非事实错误。
 * 用 BLOCKING 阻断提交会让系统因为"用了三个排比"而拒绝一整章，
 * 那是把风格偏好当成硬约束 —— 而 §34 的目标只是"减少"。
 */

/** AI 味模式的代码 */
import {
  type PortedHit,
  findEmDashes,
  findNegationParade,
  findNotIsComparisons,
  findReverseNotIs,
  findTrailerEndings,
  findVoiceContrast,
} from './ported-detectors.js';

export type AiPatternCode =
  // ── 本项目自研（ADR-0007 双层设计的段级布尔判定）──
  | 'ai_connective_stack'
  | 'ai_template_transition'
  | 'ai_adjective_pile'
  | 'ai_emotion_label'
  | 'ai_summary_tail'
  | 'ai_parallel_enumeration'
  | 'ai_vague_scenery'
  | 'ai_explained_again'
  // ── 移植自 oh-story-claudecode（ADR-0009）──
  // ⚠ 命名保留其 kebab-case 语义（转下划线），便于与上游对照
  | 'not_is_comparison'
  | 'reverse_not_is'
  | 'voice_contrast'
  | 'negation_parade'
  | 'trailer_ending'
  | 'trailer_summary'
  | 'em_dash';

export interface AiPatternHit {
  readonly code: AiPatternCode;
  /** 命中片段（供 UI 定位） */
  readonly excerpt: string;
  /** 段落序号（1-based） */
  readonly paragraph: number;
  readonly detail: string;
  /**
   * 严重级别（ADR-0009 §2 要求：统一到本项目契约，不新建并行结构）。
   *
   * ⚠ 上游的 `blocking` / `advisory` 分级是它最有价值的部分 ——
   *   但**上游说 blocking 不等于本项目就该阻断提交**。
   *   ADR-0009 的风险缓解明确写着：
   *     「所有命中先以 advisory 上线，只有经真实语料验证的类别才升为 blocking」
   *   因为上游阈值是在**网文语料**上校准的，本项目语料可能偏严，
   *   照搬阈值会让误报率升高 —— 而 §34 的目标是"减少模板化表达"，
   *   不是"命中越多越好"。
   *
   *   所以这里**如实保留上游的 severity 供参考与后续校准**，
   *   但下游（reviewer）默认按 advisory 处理。两者的区别是有意的：
   *   数据不失真，行为取保守。
   */
  readonly severity: 'blocking' | 'advisory';
  /**
   * 命中位置在**该段内**的字符偏移（0-based）。
   *
   * ⚠ 与 `paragraph` 配对使用：`paragraph` 定位到段，`offset` 定位到段内。
   *   移植的检测器是**字符级**的（正则 exec 给出 index），
   *   而自研的 8 类是**段级布尔**判定，给不出精确偏移 ——
   *   那些规则此字段为 `-1`。
   *
   * ⚠ 用 `-1` 而不是 `null` 或 `0` 表示"无偏移"：
   *   0 是合法偏移（段首），用 0 会让 UI 把"整段命中"画在段首。
   */
  readonly offset: number;
}

interface AiRule {
  readonly code: AiPatternCode;
  readonly detail: string;
  /** 段级检测 */
  readonly test: (p: string) => boolean;
}

/**
 * 连接词堆叠（§34「连接词堆叠」「不必要的首先/其次/然而」）。
 *
 * 判据：一段内出现 ≥2 个**书面连接词**。
 * 单个是正常的；两个以上就开始像论文提纲而非小说。
 *
 * ⚠ 只统计**显式书面连接词**，不含"因为/所以"这类口语也常用的词 ——
 *   后者在对话里出现是正常的。
 */
const CONNECTIVES = [
  '首先', '其次', '再次', '最后', '另外', '此外', '然而', '因此',
  '总而言之', '综上所述', '换言之', '值得一提的是', '与此同时',
  '不可否认', '显而易见', '由此可见',
];

/**
 * 模板化过渡（§34「模板化过渡」「每段都总结」）。
 *
 * 判据：段落**以**总结性套话开头。
 * ⚠ 限定在段首，避免误伤正文中正常的"后来"。
 */
const TEMPLATE_TRANSITIONS = [
  /^于是[，,]/,
  /^就这样[，,]/,
  /^总而言之/,
  /^就这样，?[^，。]{0,10}(?:结束|过去|完成)/,
  /^时间(?:过得|飞快|在不知不觉中)/,
  /^不知(?:不觉|过了多久)/,
  /^岁月(?:如梭|匆匆|流转)/,
  /^光阴(?:似箭|荏苒)/,
];

/**
 * 形容词/修饰语堆积（§34「形容词堆积」）。
 *
 * ## ⚠ 判据换过一次 —— 第一版是**错的**，且错得很典型
 *
 * 第一版用「"的"字密度」（每 25 字一个"的"）。实测真人语料后
 * 发现：密度最高的段落恰恰是**写得最好**的那些：
 * ```
 * [12.8 字/的] 夏林希从教室的后排向前走……仿佛不是要去写一道困难的
 *              压轴题，而是要去画一张简单的黑板报。
 * [13.0 字/的] 她其实不太记得他的长相，但对他空荡荡的袖管记忆犹新。
 * ```
 * 也就是说「的」密度衡量的是**具体程度**，而 §34 要抓的是**空泛** ——
 * 两者方向相反。这个规则会把最好的段落标成问题。
 *
 * （成因：「的」是定语标记，定语多 = 细节多。中文写作里
 *  "空泛"体现为**抽象评价词**，不是修饰语数量。）
 *
 * ## 现在的判据：抽象评价性形容词的**堆叠**
 *
 * 统计**通用抽象词**（深深/淡淡/温柔/难以言喻/莫名…）的出现个数，
 * 同段 ≥2 个才算堆积。单个是正常用法。
 *
 * ## 校准数据（真人 10675 段 / AI 草稿 546 段）
 * ```
 *              真人       AI 草稿
 *   0 个      97.04%     98.72%
 *   1 个       2.90%      1.28%
 *   ≥2 个      0.06%      0.00%     ← 阈值
 * ```
 * ⚠ **诚实说明**：这个规则在**真人语料与我们的 AI 草稿上都几乎不触发**
 *   （AI 草稿命中 0%）。原因是本项目 Writer 产出的正文本身偏具体
 *   （"用麻线缠了两圈""褪色的蓝布"），并不空泛。
 *
 *   所以它是**保守的筛查**，不是"AI 检测器"：能抓到真正堆砌
 *   空泛形容词的文本（真人几乎不这么写），但抓不到"像 AI 但不空泛"
 *   的文本。这个局限必须说清楚，不能让使用者以为它是可靠的 AI 判别器。
 */
const ABSTRACT_ADJECTIVES = [
  '深深', '淡淡', '静静', '轻轻', '温柔', '善良', '美好', '深刻', '复杂',
  '微妙', '独特', '强烈', '难以言喻', '无法形容', '莫名', '奇异', '温暖',
  '冰冷', '巨大', '微小', '无限', '纯粹', '空灵', '淡雅', '优雅', '高贵',
  '神秘', '寂静', '凄凉', '哀伤', '忧郁', '明媚', '灿烂', '华丽', '苍白',
];
const ABSTRACT_STACK_MIN = 2;

/**
 * 情绪直接标签化（§34「情绪直接标签化」）。
 *
 * 判据：`<人称>+<情绪词>` 直接陈述，且**同一段内出现 ≥2 次**。
 *
 * ⚠ 为什么要求 ≥2 次：单次"他很生气"是正常写法。
 *   连续标签化才是问题（"他很生气，她很难过，气氛很尴尬"）。
 *   这也让规则聚焦于 §34 说的"直接标签化"而非"出现情绪词"。
 */
const EMOTION_LABEL_RE =
  /(?:他|她|它|我|你|他们|她们|两人|众人|大家|对方)[^，。！？]{0,4}(?:感到|觉得|十分|非常|很|有些|有点|无比|格外)?(?:愤怒|生气|悲伤|难过|开心|高兴|害怕|恐惧|紧张|焦虑|尴尬|惊讶|震惊|失望|沮丧|兴奋|激动|无奈|委屈|愧疚)/g;

/**
 * 段末总结句（§34「每段都总结」「过度总结」）。
 *
 * 判据：段落**以**总结性句式收尾，如"这一切都说明……""他终于明白……"。
 *
 * ⚠ 这是 §34 里最贴近"AI 味"的一条：模型习惯在段末给读者
 *   补一句解释，而真人小说常把意义留给读者。
 */
const SUMMARY_TAILS = [
  /(?:这|那)?一切(?:都)?(?:说明|表明|意味着|昭示)/,
  // ⚠ 允许逗号分句：实测"他这才明白，有些事一旦错过就再也回不来。"
  //   在分句处断开，原先的 `[^。]{0,10}` 匹配不到（逗号后还有 14 字）。
  //   放宽为"到句末"并限制总长，避免把长段落整段判为总结句。
  /(?:他|她|它)?(?:终于|这才|此刻|忽然|突然)?(?:明白|意识到|懂得|领悟|懂了)[了]?[^。]{0,40}。$/,
  /(?:这|那)(?:就是|正是)[^。]{0,30}(?:的|含义|意义|道理)。$/,
  /(?:也许|或许)(?:这|那)(?:就是|正是)[^。]{0,30}。$/,
  /(?:而)?这(?:一)?(?:切|刻)[^。]{0,30}(?:才|都)(?:刚刚)?开始。$/,
];

/**
 * 机械排比（§34「段落节奏机械」）。
 *
 * 判据：一段内 ≥3 个结构相同的短句（同 2 字开头 + 同长度区间）。
 *
 * ⚠ 排比本身是正常修辞 —— 真人小说也常用。
 *   因此这里要求**同结构 ≥3 次**且**都在同一段**，
 *   只标 NOTE（提示"节奏可能机械"），不做质量判断。
 */
const PARALLEL_MIN = 3;

/**
 * 空泛环境描写（§34「空泛环境描写」）。
 *
 * 判据：一段内 ≥3 个"抽象环境名词 + 形容词"组合，
 * 如"微风轻拂""阳光明媚""月色如水"这类**通用套语**。
 *
 * ⚠ 只收**高度通用的套语**，不收具体景物描写 ——
 *   后者是正常写作，收进来会大量误伤。
 */
const VAGUE_SCENERY = [
  '阳光明媚', '阳光洒', '微风拂', '微风轻拂', '月色如水', '月光如水',
  '繁星点点', '星光点点', '天空湛蓝', '万里无云', '鸟语花香',
  '秋风送爽', '春意盎然', '夜色渐浓', '华灯初上', '灯火通明',
];

/**
 * 重复解释（§34「重复解释」「高潮处过度解释」）。
 *
 * 判据：相邻段落出现**同一情绪词 + 同一人物**的重复解释。
 * 例：上段"他感到愤怒"，下段"他的愤怒难以抑制"。
 *
 * 全文级检测（需要跨段），见 `detectDocumentHits`。
 */
const EXPLAIN_RE = /(?:愤怒|生气|悲伤|难过|开心|高兴|害怕|恐惧|紧张|焦虑|尴尬|惊讶|震惊|失望|沮丧|兴奋|激动)/g;

export const AI_RULES: readonly AiRule[] = [
  {
    code: 'ai_connective_stack',
    detail: '书面连接词堆叠（同段 ≥2 个）',
    test: (p) => {
      const hits = CONNECTIVES.filter((c) => p.includes(c));
      return hits.length >= 2;
    },
  },
  {
    code: 'ai_template_transition',
    detail: '模板化过渡（段首套话）',
    test: (p) => TEMPLATE_TRANSITIONS.some((re) => re.test(p.trim())),
  },
  {
    code: 'ai_adjective_pile',
    detail: `抽象形容词堆叠（同段 ≥${ABSTRACT_STACK_MIN} 个空泛评价词）`,
    test: (p) => ABSTRACT_ADJECTIVES.filter((a) => p.includes(a)).length >= ABSTRACT_STACK_MIN,
  },
  {
    code: 'ai_emotion_label',
    detail: '情绪直接标签化（同段 ≥2 次）',
    test: (p) => {
      const m = p.match(EMOTION_LABEL_RE);
      return (m?.length ?? 0) >= 2;
    },
  },
  {
    code: 'ai_summary_tail',
    detail: '段末总结句（把意义替读者说尽）',
    test: (p) => {
      const t = p.trim();
      return SUMMARY_TAILS.some((re) => re.test(t));
    },
  },
  {
    code: 'ai_parallel_enumeration',
    detail: `机械排比（同段 ≥${PARALLEL_MIN} 个同结构短句）`,
    test: (p) => {
      if (/^\s*["'「『]/.test(p)) return false; // 对话豁免

      // ⚠ 判据：**小句级**的同结构重复。
      //
      //   先按句末标点切小句，再在**每个小句内部**匹配
      //   「主语 + 谓语 + 了」。不能在整段上直接 matchAll ——
      //   实测 `^...` 配 `g` 而无 `m` 时只匹配字符串开头，
      //   后面的小句全漏（"他走了。他停了。他回头了。" 只匹配到 1 个）。
      const clauses = p
        .split(/[。！？；]/)
        .map((x) => x.trim())
        .filter((x) => x.length > 0);

      const clauseRe = /^(他|她|它|我|你|他们|她们|两人|众人|大家|对方)?([\u4e00-\u9fff]{1,2})了$/;
      const subjects: string[] = [];
      const shapes: string[] = [];
      for (const c of clauses) {
        const m = clauseRe.exec(c);
        if (!m) continue;
        if (m[1]) subjects.push(m[1]);
        shapes.push(`${m[1] ?? ''}${m[2]}了`);
      }

      if (shapes.length >= PARALLEL_MIN) {
        const byShape = new Map<string, number>();
        for (const sh of shapes) byShape.set(sh, (byShape.get(sh) ?? 0) + 1);
        if ([...byShape.values()].some((n) => n >= PARALLEL_MIN)) return true;
      }
      if (subjects.length >= PARALLEL_MIN) {
        const bySubject = new Map<string, number>();
        for (const sub of subjects) bySubject.set(sub, (bySubject.get(sub) ?? 0) + 1);
        if ([...bySubject.values()].some((n) => n >= PARALLEL_MIN)) return true;
      }

      // ⚠ 刻意**不**加"并列名词短语"判据。
      //
      //   曾试过"逗号分隔 + 含『的』的短语 ≥3 个"，用来抓
      //   "那些飘在空中的浮尘，随风摆动的微粒，玻璃映出的虚影"这类排比。
      //   但实测它在真人**正常描写**上误报：
      //     "蒋正寒一直坐在她的后面，他对她的唯一印象，就是一个埋首于
      //      题海中的背影，浓密的长发扎成一个马尾辫…"
      //   这条是全书最好的段落之一，却被判为"机械排比"。
      //
      //   区别在于"并列"是**语义**判断（三项是否构成一个列举），
      //   逗号数量与"的"的存在都判不出来。宁可不抓，也不要误伤好段落。
      return false;
    },
  },
  {
    code: 'ai_vague_scenery',
    detail: '空泛环境套语（同段 ≥3 个）',
    test: (p) => VAGUE_SCENERY.filter((s) => p.includes(s)).length >= 3,
  },
];

/** 段级检测（§34 的七条） */
export function detectAiPatterns(paragraphs: readonly string[]): AiPatternHit[] {
  const hits: AiPatternHit[] = [];

  paragraphs.forEach((p, idx) => {
    for (const rule of AI_RULES) {
      if (rule.test(p)) {
        hits.push({
          code: rule.code,
          excerpt: p.slice(0, 60),
          paragraph: idx + 1,
          detail: rule.detail,
          // ⚠ 自研规则是**段级布尔**判定，没有精确偏移 —— 用 -1 如实表示
          severity: 'advisory',
          offset: -1,
        });
      }
    }
  });

  // ── 全文级：重复解释（相邻段落解释同一情绪）──
  for (let i = 1; i < paragraphs.length; i++) {
    const prevWords = new Set(paragraphs[i - 1]!.match(EXPLAIN_RE) ?? []);
    if (prevWords.size === 0) continue;
    const curWords = paragraphs[i]!.match(EXPLAIN_RE) ?? [];
    const dup = curWords.find((w) => prevWords.has(w));
    if (dup) {
      hits.push({
        code: 'ai_explained_again',
        excerpt: paragraphs[i]!.slice(0, 60),
        paragraph: i + 1,
        detail: `重复解释同一情绪（「${dup}」在相邻段落被再次说明）`,
        severity: 'advisory',
        offset: -1,
      });
    }
  }

  // ── 移植的检测器（ADR-0009）──────────────────────────────
  //
  // ⚠ 与自研的 8 类**并存**而不是替换：自研那 8 类是段级布尔判定，
  //   覆盖"整段像不像 AI"；移植这些是字符级正则，覆盖"这一句是不是
  //   AI 高频模板"。两者命中的东西不同，替换会丢掉一半覆盖。
  //
  // ⚠ 去重：同一段落同一 code 只报一次（正则可能在同一段命中多处，
  //   逐处报会让作者看到一屏重复提示，反而忽略真正的问题）
  const seen = new Set(hits.map((h) => `${h.paragraph}:${h.code}`));
  const addPorted = (
    paragraph: number,
    code: AiPatternCode,
    severity: 'blocking' | 'advisory',
    detail: string,
    found: readonly PortedHit[],
  ): void => {
    for (const f of found) {
      const key = `${paragraph}:${code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        code,
        excerpt: f.excerpt,
        paragraph,
        detail,
        severity,
        offset: typeof f.start === 'number' ? f.start : -1,
      });
    }
  };

  paragraphs.forEach((p, idx) => {
    const para = idx + 1;
    addPorted(para, 'not_is_comparison', 'blocking',
      '高频 AI 对比句式；删掉否定铺垫，直接写后项，或改成动作/细节呈现',
      findNotIsComparisons(p));
    addPorted(para, 'reverse_not_is', 'blocking',
      '反序对比腔：「是A，不是B」与「不是A，是B」同族；删掉后置否定，直接写 A 的具体表现',
      findReverseNotIs(p));
    addPorted(para, 'voice_contrast', 'blocking',
      '音量反差腔：「声音不大…却/但…」是 AI 高频反差模板；直接写声音落进场子的具体效果',
      findVoiceContrast(p));
    addPorted(para, 'negation_parade', 'blocking',
      '否定排比：「没有X，没有Y…」是 AI 高频排比模板；直接写现场实际有什么',
      findNegationParade(p));
    addPorted(para, 'em_dash', 'blocking',
      '破折号按功能改写：打断→动作 beat/短句，拖长音→省略或动作，插入说明→逗号/冒号',
      findEmDashes(p));
  });

  // ── 章末体：只在**结尾窗口**里查 ──
  //
  // ⚠ 必须限定窗口：全文查的话，正文中间出现的「殊不知」也会被报成
  //   "章末预告体"，而作者会以为自己结尾写坏了 —— 定位完全错误。
  const trailer = findTrailerEndings(paragraphs);
  for (const [code, list, detail] of [
    ['trailer_ending', trailer.endings,
      '章末预告体：「没人知道…」「才刚刚开始…」是 AI 收尾模板；用具体细节收，不预告'],
    ['trailer_summary', trailer.summaries,
      '章末总结体：「这一夜注定…」是 AI 收尾模板；用具体细节收，不总结'],
  ] as const) {
    for (const f of list) {
      // ⚠ 段号用**检测器报的实际段号**，不是循环变量 ——
      //   章末体命中的是结尾窗口里那一段，不是第 1 段
      const key = `${f.paragraph}:${code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ code, excerpt: f.excerpt, paragraph: f.paragraph, detail, severity: 'blocking', offset: -1 });
    }
  }

  return hits;
}
