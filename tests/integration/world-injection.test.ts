/**
 * 世界观设定注入（P2-3 收尾）
 *
 * ## 为什么补这一段
 *
 * P2-3 的门禁与存储做完后，设定**仍然没有进 prompt** ——
 * 那意味着"确认"这个动作只是让 Agent 别拦你，而不是让它按设定写。
 * 用户选的流程是「作者先写设定 → Agent 按设定写」，少了这段只完成一半。
 *
 * ## 测试重点（不是"字符串拼得对不对"，而是几个判断）
 *
 * 1. ⚠ **只注入 CONFIRMED**：草稿是"作者还在改，先别当准"，
 *    把草稿当权威设定注入会让模型按作者尚未想清楚的内容写正文。
 * 2. ⚠ **草稿条数必须如实上报**：不能静默忽略。作者写了设定却看到它没生效，
 *    必须能知道原因，而不是猜"是不是没保存成功"。
 * 3. ⚠ **必须声明边界**：设定是"世界的规矩"不是"本章已发生的事"。
 * 4. 不按章筛选（世界观是整本书的不变量，与角色不同）。
 */
import { describe, expect, it } from 'vitest';
import {
  renderWorldBlock,
  selectWorldSettings,
  toWorldBrief,
  typeLabel,
  type WorldBrief,
} from '@nwa/harness';

function w(over: Partial<WorldBrief> = {}): WorldBrief {
  return {
    type: 'WORLD_RULE',
    name: '灵力枯竭',
    description: '施法会消耗寿命，不可逆',
    status: 'CONFIRMED',
    ...over,
  };
}

describe('渲染世界观设定块', () => {
  it('空列表 → 空串（不产生只有标题的空块）', () => {
    expect(renderWorldBlock([])).toBe('');
  });

  it('含名称与内容', () => {
    const b = renderWorldBlock([w()]);
    expect(b).toContain('灵力枯竭');
    expect(b).toContain('施法会消耗寿命');
  });

  it('种类渲染成可读中文', () => {
    const b = renderWorldBlock([w({ type: 'LOCATION', name: '雾隐城' })]);
    expect(b).toContain('地理');
    expect(b).toContain('雾隐城');
    expect(b).not.toContain('LOCATION');
  });

  it('⚠ 必须声明"这是设定，不是本章已发生的情节"', () => {
    // 不加这句，模型容易把设定里的背景写成刚刚发生的剧情。
    const b = renderWorldBlock([w()]);
    expect(b).toContain('不是本章已发生的情节');
    expect(b).toContain('不得违反');
  });

  it('无描述的条目不留多余标点', () => {
    const b = renderWorldBlock([w({ description: '' })]);
    expect(b).toContain('- [世界规则] 灵力枯竭');
    expect(b).not.toContain('灵力枯竭：');
  });

  it('多条逐行渲染', () => {
    const b = renderWorldBlock([w({ name: '甲' }), w({ name: '乙' })]);
    expect(b.split('\n').filter((l) => l.startsWith('- ')).length).toBe(2);
  });

  it('typeLabel：未知种类原样返回（不丢信息）', () => {
    expect(typeLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(typeLabel('FACTION')).toBe('势力');
  });
});

describe('⚠ 只注入已确认的设定', () => {
  it('全部 CONFIRMED → 全部注入', () => {
    const sel = selectWorldSettings([w({ name: '甲' }), w({ name: '乙' })]);
    expect(sel.usedCount).toBe(2);
    expect(sel.skippedDrafts).toBe(0);
    expect(sel.block).toContain('甲');
    expect(sel.block).toContain('乙');
  });

  it('⚠ 草稿不注入（作者还在改，不能当权威设定）', () => {
    const sel = selectWorldSettings([
      w({ name: '已定稿' }),
      w({ name: '草稿中', status: 'DRAFT' }),
    ]);
    expect(sel.block).toContain('已定稿');
    expect(sel.block).not.toContain('草稿中');
    expect(sel.usedCount).toBe(1);
  });

  it('⚠ 草稿条数如实上报（不能静默忽略）', () => {
    // 作者写了设定却看到它没生效，必须能知道原因，
    // 而不是猜"是不是没保存成功"。
    const sel = selectWorldSettings([
      w({ name: '甲', status: 'DRAFT' }),
      w({ name: '乙', status: 'DRAFT' }),
      w({ name: '丙' }),
    ]);
    expect(sel.skippedDrafts).toBe(2);
    expect(sel.usedCount).toBe(1);
  });

  it('全部是草稿 → 空块，且草稿数如实上报', () => {
    const sel = selectWorldSettings([w({ status: 'DRAFT' }), w({ status: 'DRAFT' })]);
    expect(sel.block).toBe('');
    expect(sel.usedCount).toBe(0);
    expect(sel.skippedDrafts).toBe(2);
  });

  it('空列表 → 空块', () => {
    const sel = selectWorldSettings([]);
    expect(sel.block).toBe('');
    expect(sel.usedCount).toBe(0);
    expect(sel.skippedDrafts).toBe(0);
  });

  it('⚠ 受 cap 约束（上下文预算保护）', () => {
    const many = Array.from({ length: 80 }, (_, i) => w({ name: `设定${i}` }));
    expect(selectWorldSettings(many).usedCount).toBe(60);
    expect(selectWorldSettings(many, 5).usedCount).toBe(5);
  });

  it('cap 只限制注入，不改变草稿计数', () => {
    const many = Array.from({ length: 80 }, (_, i) => w({ name: `设定${i}` }));
    const sel = selectWorldSettings(many, 3);
    expect(sel.usedCount).toBe(3);
    expect(sel.skippedDrafts).toBe(0);
  });
});

describe('从数据库行构造 brief', () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({
      id: 'w1',
      book_id: 'b1',
      type: 'WORLD_RULE',
      name: '灵力枯竭',
      description: '施法消耗寿命',
      data_json: null,
      status: 'CONFIRMED',
      ord: 0,
      created_at: '',
      updated_at: '',
      ...over,
    }) as never;

  it('解析字段', () => {
    const b = toWorldBrief(row());
    expect(b.name).toBe('灵力枯竭');
    expect(b.description).toBe('施法消耗寿命');
    expect(b.status).toBe('CONFIRMED');
  });

  it('⚠ 状态不明时按 DRAFT 处理（宁可少注入，不把状态不明的当权威设定）', () => {
    expect(toWorldBrief(row({ status: 'SOMETHING' })).status).toBe('DRAFT');
    expect(toWorldBrief(row({ status: '' })).status).toBe('DRAFT');
  });

  it('description 为 null → 空串（不出现 "null" 字样）', () => {
    const b = toWorldBrief(row({ description: null }));
    expect(b.description).toBe('');
    expect(renderWorldBlock([b])).not.toContain('null');
  });
});
