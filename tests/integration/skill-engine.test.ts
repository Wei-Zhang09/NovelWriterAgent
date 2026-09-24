/**
 * Skill Engine 测试（施工文档 §25 Skill Runtime）
 *
 * ## 这组测试的核心
 *
 * 1. ⚠ **Top-N 上限** —— 绝不能把整个技能库塞进 Prompt（§25 明文）
 * 2. ⚠ **场景功能不匹配时宁可不注入** —— 给错建议比不给更糟。
 *    把"冲突要拉张力"的技能注入到缓冲场景，正好写反。
 * 3. ⚠ **反模式不参与截断** —— 截掉反模式等于只给"该怎么做"
 *    而不给"什么时候不该用"，那正是最容易写出问题的用法。
 * 4. ⚠ **类型隔离**（§21）与 **STYLE 默认不可见**
 * 5. ⚠ **落选有原因** —— "某技能从未被用到"必须能查出原因
 * 6. ⚠ **排序不能只看 confidence** —— 否则高分技能在每个场景都被注入
 */
import { describe, it, expect } from 'vitest';
import { SkillEngine, parseSkillRow, renderSkill } from '@nwa/writing';
import type { SkillRow } from '@nwa/storage';

function mkRow(over: Partial<SkillRow> & { id: string; name: string }): SkillRow {
  return {
    category: 'conflict',
    summary: '这是技能的说明',
    trigger_json: JSON.stringify({ sceneTypes: ['CONFLICT'], genres: ['都市'] }),
    rules_json: JSON.stringify([{ rule: '把冲突安排在公共空间' }]),
    anti_patterns_json: JSON.stringify(['私密对峙时不要硬塞围观群体']),
    examples_json: '[]',
    evidence_refs_json: JSON.stringify(['sc1']),
    confidence: 0.7,
    version: 1,
    status: 'CANDIDATE',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    genre: '都市',
    scope: 'GENRE',
    source_document_ids_json: JSON.stringify(['doc_a']),
    ...over,
  } as SkillRow;
}

/**
 * ⚠ 造**内容互不相同**的技能行。
 *
 * 用 `mkRow({name:'skill_N'})` 批量造会让所有行文本完全一样，
 * 而运行时近重复抑制会把它们合并成 1 条（那是**正确行为**）——
 * 于是"Top-N 上限"这类测试就测不到东西了。
 * 这个辅助函数给每行不同的 summary/rules/antiPatterns。
 */
function mkDistinctRow(i: number, over: Partial<SkillRow> = {}): SkillRow {
  const topics = [
    '用旁观者的议论与注视把冲突压力外化',
    '把人物情绪拆成可观察的生理动作与短对白',
    '让强势方用具体物件标定资源差距',
    '把关键信息藏在动作里延后揭示',
    '用环境细节映射人物当下心境',
    '让第三方闯入打断私密对话',
    '用重复出现的仪式动作标记关系变化',
    '把对话写成话语解码而非直接表态',
    '在场景收束处留一个未解的问句',
    '用时间跳跃压缩无关过程',
    '把群体反应当作主角处境的镜子',
    '让物件承担人物关系的象征',
    '用短句与长句交替控制阅读节奏',
    '把回忆切碎嵌入当下动作中',
    '让对手的失态反衬主角的克制',
    '用感官细节替代抽象形容',
    '把冲突放在公共空间以获得见证者',
    '让主角做出有代价的选择而非宣言',
    '用留白让读者自行完成道德判断',
    '把伏笔埋进看似无关的日常细节',
  ];
  const t = topics[i % topics.length]!;
  return mkRow({
    id: `s${i}`,
    name: `skill_${i}`,
    summary: `${t}（第 ${i} 种手法）`,
    rules_json: JSON.stringify([{ rule: `${t}：具体做法第 ${i} 号` }]),
    anti_patterns_json: JSON.stringify([`第 ${i} 种手法在场景容量不足时不要硬塞`]),
    ...over,
  });
}

describe('§25 检索输入与 Top-N 上限', () => {
  it('⚠ 最多注入 maxSkills 个（不把整个技能库塞进 Prompt）', () => {
    const rows = Array.from({ length: 20 }, (_, i) => mkDistinctRow(i));
    const engine = new SkillEngine({ maxSkills: 3 });
    const sel = engine.retrieve(rows, { sceneFunction: 'CONFLICT', genre: '都市' });
    expect(sel.selected.length).toBe(3);
  });

  it('maxSkills 被夹在 1~8（防止误传 0 或 999）', () => {
    const rows = Array.from({ length: 20 }, (_, i) => mkDistinctRow(i));
    // ⚠ 必须传 genre：GENRE 作用域技能在"目标类型未指定"时**一律不用**
    //   （genre.ts 的既定规则）—— 不传 genre 会得到 0 个，那是另一条规则
    const ctx = { sceneFunction: 'CONFLICT', genre: '都市' };
    expect(new SkillEngine({ maxSkills: 0 }).retrieve(rows, ctx).selected.length).toBe(1);
    expect(new SkillEngine({ maxSkills: 999 }).retrieve(rows, ctx).selected.length).toBe(8);
  });

  it('⚠ 未指定目标类型时，GENRE 技能一律不用（不是"全都用"）', () => {
    // 这是 genre.ts 的既定安全规则：不知道写什么类型时，
    // 套用某类型的技能可能完全不对路 —— 宁可不给。
    const rows = [mkRow({ id: 's1', name: 'skill_1' })];
    const sel = new SkillEngine().retrieve(rows, { sceneFunction: 'CONFLICT', genre: null });
    expect(sel.selected.length).toBe(0);
    expect(sel.rejected.some((r) => r.reason.includes('目标类型未指定'))).toBe(true);
  });

  it('UNIVERSAL 技能在未指定类型时仍可用（它不限类型）', () => {
    const u = mkRow({
      id: 'u1',
      name: 'universal_skill',
      scope: 'UNIVERSAL',
      genre: null,
      trigger_json: JSON.stringify({ sceneTypes: ['CONFLICT'], genres: [] }),
    });
    const sel = new SkillEngine().retrieve([u], { sceneFunction: 'CONFLICT', genre: null });
    expect(sel.selected.length).toBe(1);
  });

  it('技能库为空时不崩，返回空块', () => {
    const sel = new SkillEngine().retrieve([], { sceneFunction: 'CONFLICT' });
    expect(sel.selected).toEqual([]);
    expect(sel.block).toBe('');
  });
});

describe('⚠ 场景功能匹配：给错建议比不给更糟', () => {
  it('⚠ COOLDOWN 场景不会拿到 CONFLICT 专属技能', () => {
    const rows = [mkRow({ id: 'c1', name: 'conflict_skill' })];
    const sel = new SkillEngine().retrieve(rows, {
      sceneFunction: 'COOLDOWN',
      genre: '都市',
    });
    // 宁可不注入，也不要把"冲突要拉张力"用在缓冲场景上
    expect(sel.selected.length).toBe(0);
    expect(sel.block).toBe('');
  });

  it('⚠ 落选时给出可读原因（能回答"某技能为什么没用到"）', () => {
    const rows = [mkRow({ id: 'c1', name: 'conflict_skill' })];
    const sel = new SkillEngine().retrieve(rows, { sceneFunction: 'COOLDOWN', genre: '都市' });
    expect(sel.rejected.length).toBeGreaterThan(0);
    expect(sel.rejected[0]!.reason).toContain('场景功能不匹配');
  });

  it('场景功能匹配时正常注入', () => {
    const rows = [mkRow({ id: 'c1', name: 'conflict_skill' })];
    const sel = new SkillEngine().retrieve(rows, { sceneFunction: 'CONFLICT', genre: '都市' });
    expect(sel.selected.length).toBe(1);
    expect(sel.selected[0]!.reasons.some((r) => r.includes('CONFLICT'))).toBe(true);
  });

  it('技能不限定场景功能时对任何场景都可用（但权重较低）', () => {
    const generic = mkRow({
      id: 'g1',
      name: 'generic_skill',
      trigger_json: JSON.stringify({ sceneTypes: [], genres: ['都市'] }),
    });
    const sel = new SkillEngine().retrieve([generic], {
      sceneFunction: 'COOLDOWN',
      genre: '都市',
    });
    expect(sel.selected.length).toBe(1);
    expect(sel.selected[0]!.reasons.some((r) => r.includes('不限定场景功能'))).toBe(true);
  });

  it('未声明 sceneFunction 时不过滤（兼容旧计划）', () => {
    const rows = [mkRow({ id: 'c1', name: 'conflict_skill' })];
    const sel = new SkillEngine().retrieve(rows, { sceneFunction: null, genre: '都市' });
    expect(sel.selected.length).toBe(1);
  });
});

describe('⚠ 排序不能只看 confidence', () => {
  it('⚠ 场景功能匹配的技能优先于高置信度但不匹配的', () => {
    const matched = mkRow({ id: 'm', name: 'matched', confidence: 0.5 });
    const highConfOther = mkRow({
      id: 'h',
      name: 'high_conf_generic',
      confidence: 0.95,
      trigger_json: JSON.stringify({ sceneTypes: [], genres: ['都市'] }),
    });
    const sel = new SkillEngine({ maxSkills: 1 }).retrieve([highConfOther, matched], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    expect(sel.selected[0]!.skill.name).toBe('matched');
  });

  it('同分时用 confidence 作次级依据', () => {
    const a = mkRow({ id: 'a', name: 'aaa', confidence: 0.4 });
    const b = mkRow({ id: 'b', name: 'bbb', confidence: 0.9 });
    const sel = new SkillEngine({ maxSkills: 1 }).retrieve([a, b], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    expect(sel.selected[0]!.skill.name).toBe('bbb');
  });

  it('排序稳定（同分同置信度时按 id，保证可重复）', () => {
    const a = mkRow({ id: 'zzz', name: 'z_skill' });
    const b = mkRow({ id: 'aaa', name: 'a_skill' });
    const sel = new SkillEngine({ maxSkills: 1 }).retrieve([a, b], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    expect(sel.selected[0]!.skill.id).toBe('aaa');
  });
});

describe('⚠ 运行时近重复抑制（同一场景内）', () => {
  // 实测形态：这两条技能相似度 0.435（低于编译期 0.45 阈值）
  // 因而都留在库里，但同一个 CONFLICT 场景会把**两条都选中** ——
  // 模型收到两份近乎相同的指令，既浪费预算又可能互相干扰。
  const RULES_A = [
    { rule: '让主角在对方发难后给出一句简短、冷静、逻辑清晰的陈述' },
    { rule: '陈述后不追加情绪化补充，用沉默或转身留给对方和读者消化' },
  ];
  const RULES_B = [
    { rule: '让主角在对方发难后只给出一句简短、冷静、逻辑完整的陈述' },
    { rule: '陈述后不追加情绪化补充，用沉默、转身或一个物理动作留给对方消化' },
  ];
  const ANTI = ['主角本身理亏却使用冷静陈述会被识破为强词夺理'];

  const dupA = mkRow({
    id: 'a1',
    name: 'calm_counterstatement_in_conflict',
    summary: '在冲突中让主角用简短冷静的陈述占据道德高地，并以沉默收束',
    rules_json: JSON.stringify(RULES_A),
    anti_patterns_json: JSON.stringify(ANTI),
    confidence: 0.65,
  });
  const dupB = mkRow({
    id: 'b1',
    name: 'calm_upper_hand_declaration',
    summary: '在情绪化对抗中用简短冷静、逻辑闭环的陈述抢占道德高地',
    rules_json: JSON.stringify(RULES_B),
    anti_patterns_json: JSON.stringify(ANTI),
    confidence: 0.65,
  });

  it('⚠ 同一场景内不会同时注入两条近重复技能', () => {
    const sel = new SkillEngine({ maxSkills: 4 }).retrieve([dupA, dupB], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    expect(sel.selected.length).toBe(1);
  });

  it('⚠ 被抑制的那条给出可读原因（可诊断）', () => {
    const sel = new SkillEngine({ maxSkills: 4 }).retrieve([dupA, dupB], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    expect(sel.rejected.some((r) => r.reason.includes('近重复'))).toBe(true);
  });

  it('⚠ 先去重再取 Top-N（名额不被近重复占掉）', () => {
    // 两条重复 + 两条不同 → 去重后应有 3 条可选
    const other1 = mkRow({
      id: 'o1',
      name: 'other_one',
      summary: '用旁观者议论放大冲突压力',
      rules_json: JSON.stringify([{ rule: '把冲突安排在有旁观者的公共空间' }]),
      anti_patterns_json: JSON.stringify(['私密对峙时不要硬塞围观群体']),
    });
    const other2 = mkRow({
      id: 'o2',
      name: 'other_two',
      summary: '用时间跳跃压缩无关过程',
      rules_json: JSON.stringify([{ rule: '跳过赶路过程，直接写到达后的场面' }]),
      anti_patterns_json: JSON.stringify(['关键过程本身有戏剧性时不要跳']),
    });
    const sel = new SkillEngine({ maxSkills: 3 }).retrieve([dupA, dupB, other1, other2], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    // 若先取 Top-N 再去重，会被重复项占掉名额 → 只得到 2 条
    expect(sel.selected.length).toBe(3);
  });

  it('内容确实不同的技能不会被误抑制', () => {
    const a = mkRow({
      id: 'x1',
      name: 'aaa_skill',
      summary: '用旁观者议论放大冲突压力',
      rules_json: JSON.stringify([{ rule: '把冲突安排在有旁观者的公共空间' }]),
      anti_patterns_json: JSON.stringify(['私密对峙时不要硬塞围观群体']),
    });
    const b = mkRow({
      id: 'x2',
      name: 'bbb_skill',
      summary: '用倒叙揭示人物动机',
      rules_json: JSON.stringify([{ rule: '先给结果再回溯原因' }]),
      anti_patterns_json: JSON.stringify(['悬念本身不成立时不要倒叙']),
    });
    const sel = new SkillEngine({ maxSkills: 4 }).retrieve([a, b], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    expect(sel.selected.length).toBe(2);
  });

  it('阈值与编译期一致（0.40），避免"编译判重复、运行又同注"的不一致', () => {
    // 默认阈值应与 skill-compile 的 dedupeSkills 默认值相同
    const sel = new SkillEngine({ maxSkills: 4 }).retrieve([dupA, dupB], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    // 实测这两条相似度 0.435 ≥ 0.40 → 应被抑制为 1 条
    expect(sel.selected.length).toBe(1);
  });
});

describe('⚠ 类型隔离（§21）', () => {
  it('⚠ 写都市时拿不到仙侠的 GENRE 技能', () => {
    const xianxia = mkRow({
      id: 'x1',
      name: 'xianxia_skill',
      genre: '仙侠',
    });
    const sel = new SkillEngine().retrieve([xianxia], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    expect(sel.selected.length).toBe(0);
    expect(sel.rejected.some((r) => r.reason.includes('类型'))).toBe(true);
  });

  it('类型归一化后同类可命中（修仙 与 仙侠）', () => {
    const row = mkRow({ id: 'x1', name: 'x_skill', genre: '修仙' });
    const sel = new SkillEngine().retrieve([row], { sceneFunction: 'CONFLICT', genre: '仙侠' });
    expect(sel.selected.length).toBe(1);
  });

  it('UNIVERSAL 技能对所有类型可用', () => {
    const u = mkRow({
      id: 'u1',
      name: 'universal_skill',
      scope: 'UNIVERSAL',
      genre: null,
      trigger_json: JSON.stringify({ sceneTypes: ['CONFLICT'], genres: [] }),
    });
    const sel = new SkillEngine().retrieve([u], { sceneFunction: 'CONFLICT', genre: '仙侠' });
    expect(sel.selected.length).toBe(1);
  });
});

describe('⚠ STYLE 默认不可见（§21）', () => {
  const styleRow = mkRow({
    id: 'st1',
    name: 'style_skill',
    scope: 'STYLE',
    trigger_json: JSON.stringify({ sceneTypes: ['CONFLICT'], genres: [] }),
  });

  it('⚠ 默认不注入 STYLE 技能', () => {
    const sel = new SkillEngine().retrieve([styleRow], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    expect(sel.selected.length).toBe(0);
  });

  it('allowStyle 显式开启后才注入', () => {
    const sel = new SkillEngine({ allowStyle: true }).retrieve([styleRow], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    expect(sel.selected.length).toBe(1);
  });

  // ── §九 第三条方案：STYLE 的可见性由**来源/风格类型**决定 ──
  //
  // 用户决策：不要在编译期提升 Scope 来绕过可见性，那是在伪造证据范围。
  // 正确做法是运行时按"有没有明确的使用理由"判定。

  it('⚠ 指定来源作品且技能来自该作品 → STYLE 可见', () => {
    // styleRow 的 source_document_ids_json 是 ['doc_a']
    const sel = new SkillEngine({ styleSources: ['doc_a'] }).retrieve([styleRow], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    expect(sel.selected.length).toBe(1);
    expect(sel.selected[0]!.skill.scope).toBe('STYLE');
  });

  it('⚠ 指定了来源，但技能来自**别的**作品 → 仍不可见', () => {
    // 这是关键：用户说"照《诛仙》写"，就不该混进《斗破》的风格
    const sel = new SkillEngine({ styleSources: ['doc_other'] }).retrieve([styleRow], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    expect(sel.selected.length).toBe(0);
  });

  it('⚠ 通过 SceneContext 传 styleSources 同样生效（逐场景可调）', () => {
    const sel = new SkillEngine().retrieve([styleRow], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
      styleSources: ['doc_a'],
    });
    expect(sel.selected.length).toBe(1);
  });

  it('⚠ 指定风格类型且类型一致 → STYLE 可见（未指定具体作品时的退路）', () => {
    const sel = new SkillEngine({ styleGenre: '都市' }).retrieve([styleRow], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    expect(sel.selected.length).toBe(1);
  });

  it('⚠ 指定风格类型但类型不一致 → 不可见（防跨类型串风格）', () => {
    const sel = new SkillEngine({ styleGenre: '仙侠' }).retrieve([styleRow], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    expect(sel.selected.length).toBe(0);
  });

  it('⚠ 排除原因如实说明"缺什么"，便于诊断为什么没用到', () => {
    const sel = new SkillEngine().retrieve([styleRow], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    const why = sel.rejected.find((r) => r.name === 'style_skill')?.reason ?? '';
    expect(why).toContain('STYLE');
    expect(why).toContain('来源');
  });

  it('⚠ STYLE 已可见时仍能被打分（此前 STYLE 完全不参与打分）', () => {
    const sel = new SkillEngine({ styleSources: ['doc_a'] }).retrieve([styleRow], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    expect(sel.selected.length).toBe(1);
    const reasons = sel.selected[0]!.reasons.join('｜');
    expect(reasons).toContain('作者风格');
  });
});

describe('⚠ 反模式必须完整保留（不参与截断）', () => {
  it('⚠ 超长规则被截断，但反模式一条不少', () => {
    const longRules = Array.from({ length: 30 }, (_, i) => ({
      rule: `这是第 ${i + 1} 条相当长的规则描述文字，用来把字符预算撑爆`,
    }));
    const anti = ['第一条反模式：不适用的情况 A', '第二条反模式：不适用的情况 B'];
    const row = mkRow({
      id: 'r1',
      name: 'long_skill',
      rules_json: JSON.stringify(longRules),
      anti_patterns_json: JSON.stringify(anti),
    });

    const skill = parseSkillRow(row)!;
    const { rendered, truncated } = renderSkill(skill, 400);

    expect(truncated).toBe(true);
    // ⚠ 反模式必须完整 —— 截掉它等于只给"该怎么做"不给"什么时候不该用"
    for (const a of anti) expect(rendered).toContain(a);
    expect(rendered).toContain('不适用的情况');
  });

  it('不超预算时不截断', () => {
    const skill = parseSkillRow(mkRow({ id: 'r2', name: 'short_skill' }))!;
    const { truncated } = renderSkill(skill, 5000);
    expect(truncated).toBe(false);
  });
});

describe('注入文本的措辞（影响模型是否误当硬性要求）', () => {
  const rows = [mkRow({ id: 'c1', name: 'conflict_skill' })];

  it('⚠ 明确说明"策略建议，不是必须逐条执行"', () => {
    const sel = new SkillEngine().retrieve(rows, { sceneFunction: 'CONFLICT', genre: '都市' });
    expect(sel.block).toContain('策略建议');
    expect(sel.block).toContain('不是必须');
  });

  it('⚠ 强调"用错场合比不用更糟"', () => {
    const sel = new SkillEngine().retrieve(rows, { sceneFunction: 'CONFLICT', genre: '都市' });
    expect(sel.block).toContain('不适用');
  });

  it('说明技能来源（跨作品分析）以建立可信度', () => {
    const sel = new SkillEngine().retrieve(rows, { sceneFunction: 'CONFLICT', genre: '都市' });
    expect(sel.block).toContain('真实作品');
  });
});

describe('⚠ 坏行不阻断检索', () => {
  it('解析失败的行被如实记录，不影响其他技能', () => {
    const good = mkRow({ id: 'ok', name: 'good_skill' });
    const bad = mkRow({
      id: 'bad',
      name: 'bad_skill',
      rules_json: 'not json at all',
      anti_patterns_json: '{}',
    });
    const sel = new SkillEngine().retrieve([good, bad], {
      sceneFunction: 'CONFLICT',
      genre: '都市',
    });
    expect(sel.selected.length).toBe(1);
    expect(sel.selected[0]!.skill.name).toBe('good_skill');
    // ⚠ 坏行要被记录，否则"某技能从未被用到"查不出原因
    expect(sel.rejected.some((r) => r.name === 'bad_skill')).toBe(true);
  });
});

describe('considered 的语义', () => {
  it('⚠ considered 是过滤后的候选数，不是库行总数', () => {
    const rows = [
      mkRow({ id: 'a', name: 'a_skill' }),
      // 已下架 → 被状态过滤
      mkRow({ id: 'b', name: 'b_skill', status: 'DEPRECATED' }),
      // 类型不符 → 被类型过滤
      mkRow({ id: 'c', name: 'c_skill', genre: '仙侠' }),
    ];
    const sel = new SkillEngine().retrieve(rows, { sceneFunction: 'CONFLICT', genre: '都市' });
    expect(sel.considered).toBe(1);
    expect(rows.length).toBe(3);
  });
});
