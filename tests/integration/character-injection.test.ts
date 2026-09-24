/**
 * 角色设定注入（P2-2）
 *
 * ## 这个缺陷长什么样
 *
 * 角色表、`character.create/list/update` 三个工具、`characterState` 槽位
 * **全都存在**，但没有任何地方把角色喂给模型：
 *   - Planner 的 `contextText` 被传空串
 *   - Writer 只吃 plan.brief + 结构化约束 + 技能块
 *   - `characterState` 槽位定义了但永远为空
 *
 * 于是作者写了「沈砚左手有旧伤」，模型完全不知道 ——
 * 它只能靠检索旧章节猜，猜不到就自己编。这是"能力已存在、路径没接上"
 * 的典型，也是本项目反复出现的一类。
 *
 * ## 测试重点
 *
 * 不是"字符串拼得对不对"，而是几个**判断**：
 *   1. 相关角色要能选出来（按名字/别名）
 *   2. 第 1 章没有提示时**必须**注入（否则设定在最需要它的那章被丢掉）
 *   3. 必须说明"这是设定不是已发生的情节"（否则模型把背景当剧情写）
 *   4. 坏掉的 JSON 不能让整章写不出来
 */
import { describe, expect, it } from 'vitest';
import {
  renderCharacterBlock,
  selectRelevantCharacters,
  toCharacterBrief,
  type CharacterBrief,
} from '@nwa/harness';

function brief(over: Partial<CharacterBrief> = {}): CharacterBrief {
  return {
    name: '沈砚',
    aliases: [],
    role: null,
    currentStatus: null,
    profile: null,
    ...over,
  };
}

describe('渲染角色设定块', () => {
  it('空列表 → 空串（不产生一个只有标题的空块）', () => {
    expect(renderCharacterBlock([])).toBe('');
  });

  it('含名字 / 别名 / 定位 / 档案', () => {
    const block = renderCharacterBlock([
      brief({
        name: '沈砚',
        aliases: ['老沈', '砚哥'],
        role: '主角',
        currentStatus: '在旧货市场',
        profile: '修表匠，左手有旧伤',
      }),
    ]);
    expect(block).toContain('沈砚');
    expect(block).toContain('老沈');
    expect(block).toContain('主角');
    expect(block).toContain('在旧货市场');
    expect(block).toContain('左手有旧伤');
  });

  it('⚠ 必须声明"这是设定，不是已发生的情节"', () => {
    // 不加这句，模型会把"设定里的背景"当成"本章已发生的事"写进正文 ——
    // 例如把"他曾在南方待过"写成"他刚从南方回来"。
    const block = renderCharacterBlock([brief({ profile: '曾在南方待过' })]);
    expect(block).toContain('不是本章已发生的情节');
    expect(block).toContain('不得编造');
  });

  it('档案是对象时逐项渲染', () => {
    const block = renderCharacterBlock([
      brief({ profile: { 外貌: '瘦高', 性格: '寡言' } }),
    ]);
    expect(block).toContain('外貌：瘦高');
    expect(block).toContain('性格：寡言');
  });

  it('档案是数组时用顿号连接', () => {
    const block = renderCharacterBlock([brief({ profile: ['修表匠', '左手有旧伤'] })]);
    expect(block).toContain('修表匠、左手有旧伤');
  });

  it('多角色逐行渲染', () => {
    const block = renderCharacterBlock([
      brief({ name: '沈砚' }),
      brief({ name: '阿棠' }),
    ]);
    expect(block).toContain('沈砚');
    expect(block).toContain('阿棠');
    // 两个角色各占一行
    expect(block.split('\n').filter((l) => l.startsWith('- ')).length).toBe(2);
  });

  it('没有档案时不留下多余的分隔符', () => {
    const block = renderCharacterBlock([brief({ name: '沈砚' })]);
    expect(block).toContain('- 沈砚');
    expect(block).not.toContain('- 沈砚。');
  });
});

describe('筛选相关角色', () => {
  const all = [
    brief({ name: '沈砚', aliases: ['老沈'] }),
    brief({ name: '阿棠' }),
    brief({ name: '周鹤年', role: '反派' }),
  ];

  it('按名字命中', () => {
    const r = selectRelevantCharacters(all, ['本章沈砚去旧货市场']);
    expect(r.map((c) => c.name)).toEqual(['沈砚']);
  });

  it('按别名命中', () => {
    const r = selectRelevantCharacters(all, ['老沈推开门']);
    expect(r.map((c) => c.name)).toEqual(['沈砚']);
  });

  it('多个提示合并（用户指令 + 上一章摘要）', () => {
    const r = selectRelevantCharacters(all, ['沈砚出场', '阿棠在门口']);
    expect(r.map((c) => c.name).sort()).toEqual(['沈砚', '阿棠']);
  });

  it('都不命中 → 空（不注入无关的人）', () => {
    // 注入了没打算写的人，模型会想办法让他们出场（"角色出现即要交代"）
    const r = selectRelevantCharacters(all, ['这一章在写天气']);
    expect(r).toEqual([]);
  });

  it('⚠ 无任何提示（如第 1 章）→ 注入全部（设定不能被丢掉）', () => {
    // 第 1 章没有上一章摘要。若"无提示就不注入"，作者刚写好的设定
    // **恰恰在最需要它的那一章**被丢掉 —— 而"作者先写设定 → Agent 按设定写"
    // 正是本项目的既定流程。
    const r = selectRelevantCharacters(all, []);
    expect(r.length).toBe(3);
  });

  it('空白提示等同于无提示', () => {
    expect(selectRelevantCharacters(all, ['', '   ']).length).toBe(3);
  });

  it('⚠ 无提示时仍受 cap 约束（上下文预算保护）', () => {
    const many = Array.from({ length: 50 }, (_, i) => brief({ name: `角色${i}` }));
    expect(selectRelevantCharacters(many, []).length).toBe(20);
    expect(selectRelevantCharacters(many, [], 5).length).toBe(5);
  });

  it('命中很多时也受 cap 约束', () => {
    const many = Array.from({ length: 50 }, (_, i) => brief({ name: `角色${i}` }));
    const hints = many.map((c) => c.name).join(' ');
    expect(selectRelevantCharacters(many, [hints], 3).length).toBe(3);
  });

  it('空角色表 → 空（不抛错）', () => {
    expect(selectRelevantCharacters([], ['随便'])).toEqual([]);
  });
});

describe('从数据库行构造 brief', () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({
      id: 'ch1',
      book_id: 'b1',
      name: '沈砚',
      aliases_json: null,
      role: null,
      current_status: null,
      profile_json: null,
      created_at: '',
      updated_at: '',
      ...over,
    }) as never;

  it('解析 JSON 列', () => {
    const b = toCharacterBrief(
      row({
        aliases_json: JSON.stringify(['老沈']),
        profile_json: JSON.stringify({ 外貌: '瘦高' }),
        role: '主角',
        current_status: '在旧货市场',
      }),
    );
    expect(b.aliases).toEqual(['老沈']);
    expect(b.profile).toEqual({ 外貌: '瘦高' });
    expect(b.role).toBe('主角');
    expect(b.currentStatus).toBe('在旧货市场');
  });

  it('⚠ JSON 坏掉不能让整章写不出来（按空处理）', () => {
    // 一个角色的档案坏了，不该让这一章生成失败 ——
    // 缺设定的稿仍是可用的草稿。
    const b = toCharacterBrief(
      row({ aliases_json: 'not json', profile_json: '{broken' }),
    );
    expect(b.aliases).toEqual([]);
    expect(b.profile).toBeNull();
    expect(b.name).toBe('沈砚');
  });

  it('别名 JSON 不是数组时按空处理', () => {
    const b = toCharacterBrief(row({ aliases_json: JSON.stringify({ a: 1 }) }));
    expect(b.aliases).toEqual([]);
  });

  it('别名数组里混入非字符串时过滤掉', () => {
    const b = toCharacterBrief(row({ aliases_json: JSON.stringify(['老沈', 42, null]) }));
    expect(b.aliases).toEqual(['老沈']);
  });

  it('null 列 → 空值', () => {
    const b = toCharacterBrief(row());
    expect(b.aliases).toEqual([]);
    expect(b.profile).toBeNull();
  });
});
