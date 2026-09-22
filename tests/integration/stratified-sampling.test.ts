/**
 * 分层抽样测试（跨作品分析的前提）
 *
 * ## 为什么这组测试重要
 *
 * `sourceDocumentIds` 是从**送给模型的样本**里算出来的，
 * 它决定了模式算"类型规律"还是"作者风格"（见 resolveScope）。
 *
 * 若抽样不保证"每部作品都有代表"，会出现**虚假的"证据不足"**：
 * 某组有 2 部作品，抽 8 个时全落在一部 → 明明有跨作品证据，
 * 却被降档为 STYLE → 跨作品分析白做。
 *
 * ⚠ 实测数据形态：《百岁之好》CHARACTER_DEVELOPMENT 67 个场景，
 *   《清纯校花》里更多 —— 两部作品场景数悬殊，均匀抽样很容易全落一部。
 */
import { describe, it, expect } from 'vitest';
import { sampleStratifiedByDocument, sampleEvenly } from '@nwa/distillation';

interface S {
  readonly id: string;
  readonly document_id: string;
}

function mk(doc: string, n: number, prefix = 's'): S[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}_${doc}_${i}`, document_id: doc }));
}

describe('⚠ 按作品分层抽样', () => {
  it('⚠ 两部作品场景数悬殊时，每部都必须有代表', () => {
    // doc_a 有 100 个场景，doc_b 只有 3 个 —— 均匀抽样会全落在 doc_a
    const items = [...mk('a', 100), ...mk('b', 3)];
    const s = sampleStratifiedByDocument(items, 8);

    const docs = new Set(s.map((x) => x.document_id));
    expect(docs.has('a')).toBe(true);
    expect(docs.has('b')).toBe(true);
    expect(s.length).toBe(8);
  });

  it('⚠ 极端悬殊（1000 : 1）时仍保留少数作品', () => {
    const items = [...mk('a', 1000), ...mk('b', 1)];
    const s = sampleStratifiedByDocument(items, 8);
    const docs = new Set(s.map((x) => x.document_id));
    expect(docs.size).toBe(2);
  });

  it('均匀抽样在同样数据上会漏掉少数作品（对比证明分层有必要）', () => {
    const items = [...mk('a', 100), ...mk('b', 3)];
    const even = sampleEvenly(items, 8);
    const stratified = sampleStratifiedByDocument(items, 8);

    // 均匀抽样大概率全是 doc_a
    expect(new Set(even.map((x) => x.document_id)).size).toBeLessThanOrEqual(2);
    // 分层抽样必定两部都有
    expect(new Set(stratified.map((x) => x.document_id)).size).toBe(2);
  });

  it('三部作品都有代表', () => {
    const items = [...mk('a', 50), ...mk('b', 40), ...mk('c', 30)];
    const s = sampleStratifiedByDocument(items, 9);
    expect(new Set(s.map((x) => x.document_id)).size).toBe(3);
    expect(s.length).toBe(9);
  });

  it('单一作品时退化为均匀抽样', () => {
    const items = mk('a', 100);
    const s = sampleStratifiedByDocument(items, 8);
    expect(s.length).toBe(8);
    expect(new Set(s.map((x) => x.document_id)).size).toBe(1);
  });

  it('场景数不超过上限时原样返回', () => {
    const items = [...mk('a', 3), ...mk('b', 2)];
    const s = sampleStratifiedByDocument(items, 10);
    expect(s.length).toBe(5);
  });

  it('保持原始顺序（便于模型看到连贯上下文）', () => {
    const items = [...mk('a', 20), ...mk('b', 20)];
    const s = sampleStratifiedByDocument(items, 6);
    const ids = s.map((x) => x.id);
    const order = items.map((x) => x.id);
    const idx = ids.map((id) => order.indexOf(id));
    // 索引应递增
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]!).toBeGreaterThan(idx[i - 1]!);
    }
  });

  it('不产生重复场景', () => {
    const items = [...mk('a', 50), ...mk('b', 10)];
    const s = sampleStratifiedByDocument(items, 12);
    expect(new Set(s.map((x) => x.id)).size).toBe(s.length);
  });

  it('⚠ 每部作品都抽到多个（不只 1 个），保证该作品的写法有代表性', () => {
    const items = [...mk('a', 50), ...mk('b', 50)];
    const s = sampleStratifiedByDocument(items, 8);
    const byDoc = new Map<string, number>();
    for (const x of s) byDoc.set(x.document_id, (byDoc.get(x.document_id) ?? 0) + 1);
    // 各 4 个（8/2）
    expect(byDoc.get('a')).toBe(4);
    expect(byDoc.get('b')).toBe(4);
  });
});
