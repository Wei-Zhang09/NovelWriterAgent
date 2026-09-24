/**
 * 类型隔离（用户要求）
 *
 * ## 需求原话
 *
 *   > 要做好区分，在写对应类型小说时，才使用对应的内容。
 *
 * ## 为什么必须由代码强制
 *
 * 如果只靠"调用方记得过滤"，后果是**静默的题材错配**：
 * 写校园恋爱时注入了修仙的"渡劫—飞升"节奏，或把玄幻的
 * "打脸—升级"套路用在都市日常里。这类错配不会报错，
 * 只会让产出"读起来不对劲"——而没人能定位原因。
 *
 * ## 三档作用域（与施工文档 §21 的分层对应）
 *
 * | scope | 含义 | 使用条件 |
 * |---|---|---|
 * | `UNIVERSAL` | 跨类型通用（如"用行为代替情绪直述"） | 任何题材都可用 |
 * | `GENRE` | 类型专属（如"渡劫前的铺垫节奏"） | **仅同 genre** |
 * | `STYLE` | 作者风格（§21 明确"不默认使用作者特有策略"） | 需显式开启 |
 *
 * ## ⚠ 为什么不能只做 genre 等值过滤
 *
 * 有些手法确实跨类型有效（"减少情绪直述"在恋爱文与玄幻文里都对）。
 * 若一刀切按 genre 过滤，会把这些通用手法也挡掉，白白损失可用知识。
 * 因此用**作用域**表达"适用范围"，而不是把一切都绑到 genre 上。
 */
import type { CorpusDocumentRow, CorpusSceneRow } from './corpus.js';

/** 作用域 */
export const SKILL_SCOPES = ['UNIVERSAL', 'GENRE', 'STYLE'] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];

/**
 * 类型别名归一化。
 *
 * ⚠ 必须归一化：用户/导入时的写法不统一 ——
 *   "仙侠" / "修仙" / "仙侠修真" 指向同一大类；
 *   "都市" / "都市校园" / "都市言情" 同理。
 *   不做归一化会导致**本该匹配的语料匹配不上**（漏用），
 *   比错用更难发现。
 */
const GENRE_ALIASES: Record<string, string> = {
  // 仙侠类
  仙侠: '仙侠',
  修仙: '仙侠',
  修真: '仙侠',
  仙侠修真: '仙侠',
  玄幻仙侠: '仙侠',
  // 玄幻类
  玄幻: '玄幻',
  东方玄幻: '玄幻',
  异世大陆: '玄幻',
  // 都市类
  都市: '都市',
  都市校园: '都市',
  都市言情: '都市',
  校园: '都市',
  言情: '都市',
  现代言情: '都市',
  // 其他
  历史: '历史',
  军事: '军事',
  科幻: '科幻',
  悬疑: '悬疑',
  武侠: '武侠',
};

/** 归一化类型名（未知类型原样返回小写，不做猜测） */
export function normalizeGenre(genre: string | null | undefined): string | null {
  if (!genre) return null;
  const t = genre.trim();
  if (t.length === 0) return null;
  return GENRE_ALIASES[t] ?? t;
}

/** 判断两个类型是否属于同一大类 */
export function sameGenre(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeGenre(a);
  const nb = normalizeGenre(b);
  if (na === null || nb === null) return false;
  return na === nb;
}

export interface SkillFilter {
  /** 目标类型（写什么类型的小说） */
  readonly genre: string | null;
  /**
   * 是否允许使用 STYLE 作用域的技能（作者风格）。
   *
   * ⚠ 默认 **false**：施工文档 §21 明确要求
   *   「Writer 默认优先使用 Genre-specific + 高置信通用策略，
   *     而不是直接使用作者特有策略」。
   *   直接套用某位作者的风格会让产出失去原创性。
   */
  readonly allowStyle?: boolean;
  /**
   * 用户**指定要模仿的来源作品**（语料 documentId 列表）。
   *
   * ## 为什么需要它 —— 这是"STYLE 技能可见性"的正确开关
   *
   * 早先 STYLE 只有"全局开关 + 类型一致"两个条件，于是产生了一个
   * 被误判为"编译问题"的现象：一条 STYLE 模式混进某个技能组，
   * 该技能就永远检索不到 —— 看起来像"编译了却用不了"。
   *
   * 当时的应对是**在编译期把 scope 升级**（取最宽），让技能变得可见。
   * 但那是拿**证据范围**去迁就**可见性**：技能实际只依据一部作品，
   * 却被标成跨作品验证过的 GENRE。这是伪造证据范围，不能这么做。
   *
   * 正确做法：STYLE 的可见性由**运行时**按来源判断 ——
   * 用户明确说"照这部作品的路子写"时，来自该作品的 STYLE 技能就可见。
   * scope 保持如实，可见性另管。
   */
  readonly styleSources?: readonly string[];
  /**
   * 当前作品的风格类型（可选）。
   *
   * 与 `styleSources` 是"或"的关系：没指定具体作品、但指定了风格类型时，
   * 同类型的 STYLE 技能可见。
   */
  readonly styleGenre?: string | null;
}

export interface FilterableSkill {
  readonly genre?: string | null;
  readonly scope?: string | null;
  readonly confidence?: number;
  readonly status?: string | null;
  /** STYLE 技能的来源作品（可见性判据）—— 已解析的形态 */
  readonly sourceDocumentIds?: readonly string[];
  /**
   * 来源作品的**原始 JSON 列**（数据库行的形态）。
   *
   * ⚠ 两种形态都要支持：调用方有的传解析好的 `Skill`，有的直接传
   *   `SkillRow`（`listSkills()` 的返回）。只认一种会让另一条路径
   *   静默地"STYLE 永远不可见" —— 而那看起来像编译问题，很难查。
   */
  readonly source_document_ids_json?: string | null;
}

/** 取来源作品（兼容"已解析"与"原始 JSON 列"两种形态） */
function sourceDocsOf(s: FilterableSkill): readonly string[] {
  if (s.sourceDocumentIds && s.sourceDocumentIds.length > 0) return s.sourceDocumentIds;
  const raw = s.source_document_ids_json;
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as string[]) : [];
  } catch {
    // 脏数据不该让整个过滤崩掉，也不该被当成"有来源"
    return [];
  }
}

export interface SkillFilterResult<T> {
  readonly kept: readonly T[];
  /** 被类型隔离挡掉的（如实报告，便于诊断"为什么没用到某个技能"） */
  readonly excluded: readonly { readonly skill: T; readonly reason: string }[];
}

/**
 * 按类型过滤技能 —— **类型隔离的唯一入口**。
 *
 * ⚠ 所有需要"取技能"的地方都必须走这里，不要各自写 where 条件：
 *   过滤规则一旦分散，就会出现"某条路径忘了按类型过滤"的漏洞，
 *   而那种漏洞只在跨类型场景下暴露，测试很容易漏。
 */
export function filterSkillsByGenre<T extends FilterableSkill>(
  skills: readonly T[],
  filter: SkillFilter,
): SkillFilterResult<T> {
  const target = normalizeGenre(filter.genre);
  const allowStyle = filter.allowStyle === true;
  const kept: T[] = [];
  const excluded: { skill: T; reason: string }[] = [];

  for (const s of skills) {
    // 已废弃的技能不参与（状态过滤）
    if (s.status === 'DEPRECATED') {
      excluded.push({ skill: s, reason: 'status=DEPRECATED' });
      continue;
    }

    const scope = (s.scope ?? 'GENRE') as SkillScope;

    if (scope === 'UNIVERSAL') {
      kept.push(s);
      continue;
    }

    if (scope === 'STYLE') {
      // ── STYLE 可见性（§九 第三条方案的运行时部分）──
      //
      // ⚠ 这里**不是**"STYLE 默认不可见"，而是"需要明确的使用理由"。
      //   理由有两类，任一满足即可见：
      //     a) 用户指定了来源作品，且技能确实来自该作品
      //     b) 用户指定了风格类型，且技能类型一致
      //   若都没指定，退回到 allowStyle 这个全局开关（向后兼容）。
      //
      //   为什么要有 a)：STYLE 是"某部作品的写法"。用户说"照《诛仙》
      //   的路子写"时，来自《诛仙》的技能就是**有明确使用理由**的；
      //   而来自别的作品的 STYLE 技能仍然不该用。
      //   没有这个判据时，只能靠"全局打开 allowStyle"或"编译期升档"
      //   来让技能可见 —— 前者会连带引入无关作品的风格，后者伪造证据。
      const sources = filter.styleSources ?? [];
      const fromNamedSource =
        sources.length > 0 && sourceDocsOf(s).some((d) => sources.includes(d));
      const styleGenreMatch =
        filter.styleGenre !== null &&
        filter.styleGenre !== undefined &&
        sameGenre(s.genre, filter.styleGenre);

      if (!fromNamedSource && !styleGenreMatch && !allowStyle) {
        excluded.push({
          skill: s,
          reason:
            'STYLE 作用域需要明确的使用理由：未指定来源作品、未指定风格类型，' +
            '且全局开关 allowStyle=false（§21 要求不直接套用作者特有策略）',
        });
        continue;
      }

      // 即便可见，也要求类型一致（避免把某作者的玄幻风格用在都市里）。
      //
      // ⚠ 例外：来源作品被明确指定时，类型一致不再是必要条件 ——
      //   用户指定"照这部写"时，他就是要这部作品的写法。
      if (!fromNamedSource && target !== null && !sameGenre(s.genre, target)) {
        excluded.push({
          skill: s,
          reason: `类型不匹配：技能 genre=${s.genre ?? '未标注'} vs 目标 ${filter.genre ?? '未指定'}`,
        });
        continue;
      }
      kept.push(s);
      continue;
    }

    // scope === 'GENRE'：必须类型一致
    if (target === null) {
      excluded.push({ skill: s, reason: '目标类型未指定，GENRE 作用域技能不予使用' });
      continue;
    }
    if (!sameGenre(s.genre, target)) {
      excluded.push({
        skill: s,
        reason: `类型不匹配：技能 genre=${s.genre ?? '未标注'} vs 目标 ${filter.genre}`,
      });
      continue;
    }
    kept.push(s);
  }

  return { kept, excluded };
}

/**
 * 按类型过滤语料文档 —— 蒸馏时只用同类型语料。
 *
 * ⚠ 为什么蒸馏也要过滤：跨类型混算会得出**伪相关**。
 *   例如某 trigger 在玄幻里高频、都市里罕见，
 *   混算后得到一个看似"通用"的中频值 —— 实际两边都不适用。
 *   必须先按类型分组，再分别挖掘（STEP 16 的跨作品对比正是做这件事）。
 */
export function filterDocumentsByGenre(
  docs: readonly CorpusDocumentRow[],
  genre: string | null,
): { readonly kept: readonly CorpusDocumentRow[]; readonly excluded: readonly { doc: CorpusDocumentRow; reason: string }[] } {
  const target = normalizeGenre(genre);
  if (target === null) {
    return {
      kept: [],
      excluded: docs.map((d) => ({ doc: d, reason: '目标类型未指定' })),
    };
  }
  const kept: CorpusDocumentRow[] = [];
  const excluded: { doc: CorpusDocumentRow; reason: string }[] = [];
  for (const d of docs) {
    if (sameGenre(d.genre, target)) kept.push(d);
    else {
      excluded.push({
        doc: d,
        reason: `类型不匹配：文档 genre=${d.genre ?? '未标注'} vs 目标 ${genre}`,
      });
    }
  }
  return { kept, excluded };
}

/** 按类型过滤场景（模式挖掘的输入） */
export function filterScenesByGenre(
  scenes: readonly CorpusSceneRow[],
  genre: string | null,
): readonly CorpusSceneRow[] {
  const target = normalizeGenre(genre);
  if (target === null) return [];
  return scenes.filter((s) => sameGenre(s.genre, target));
}

/** 列出可用的类型（供 UI 选择"我要写什么类型"） */
export function listGenres(docs: readonly CorpusDocumentRow[]): { genre: string; count: number }[] {
  const m = new Map<string, number>();
  for (const d of docs) {
    const g = normalizeGenre(d.genre);
    if (!g) continue;
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => b.count - a.count);
}
