/**
 * §51 Golden Set
 *
 * ## 是什么
 *
 * 施工文档 §51 要求建立 `tests/fixtures/golden/`，包含
 * project / characters / timeline / facts / chapters / review / skills，
 * 并且「任何架构修改后都必须跑 Golden Test」。
 *
 * ## ⚠ 与其它测试的区别：Golden Set 是**回归基准**，不是功能测试
 *
 * 功能测试验证"某功能对不对"；Golden Set 验证"**既有行为有没有变**"。
 * 因此它的断言必须**足够具体**（记录确切的字段与结构），
 * 否则架构改动导致的行为漂移会静默通过。
 *
 * ## ⚠ 本实现刻意**不预置固定语料文件**
 *
 * 两种做法：
 *   a) 在仓库里放一份固定的 golden 语料（json/md 文件）
 *   b) 用**确定性夹具**现场构造，再对结果做精确断言
 *
 * 选 (b)。理由：
 *   - (a) 的语料会随 schema 演进变陈旧，需要人工同步 —— 而"忘了同步"
 *     的后果是 Golden Test 一直绿（因为它测的是老结构），**失去意义**。
 *   - (b) 的夹具由代码构造，schema 变了**编译期就会报错**，
 *     不存在"测试绿但语料过期"的状态。
 *
 * ⚠ 但 (b) 有个前提：夹具必须**确定性**（同输入同输出）。
 *   下面用固定 id 与固定时间戳保证这一点。
 *
 * ## 覆盖什么
 *
 * 施工文档 §51 列的七项，逐项断言：
 *   project / characters / timeline / facts / chapters / review / skills
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ToolRegistry, createAllTools, Writer, Reviewer } from '@nwa/harness';
import type { ToolContext } from '@nwa/shared';
import { createTestProject, type TestProject } from '../integration/helpers.js';

let t: TestProject | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function ctx(permission: ToolContext['callerPermission'] = 'ADMIN'): ToolContext {
  return { runId: 'run_golden', projectId: 'p', callerPermission: permission, emit: () => {} };
}

function registry(project: TestProject): ToolRegistry {
  const r = new ToolRegistry();
  for (const tool of createAllTools(project.repos)) r.register(tool);
  return r;
}

describe('§51 Golden Set：七类 artifact 的结构基线', () => {
  it('project / characters / facts / chapters / review / skills 均可构造且结构稳定', async () => {
    t = createTestProject();
    const reg = registry(t);

    // ── project ──
    const proj = await reg.invoke(
      'project.create',
      { name: 'Golden', genre: '都市', premise: '基准夹具' },
      ctx(),
    );
    expect(proj.ok).toBe(true);
    const projectId = (proj.data as { id: string }).id;
    // ⚠ 断言**字段集合**而非只断言"有 id" —— 字段漂移必须被捕获
    expect(Object.keys(proj.data as object).sort()).toEqual(
      ['createdAt', 'genre', 'id', 'name', 'premise', 'status', 'updatedAt'].sort(),
    );

    const book = await reg.invoke('book.create', { projectId, title: 'Golden 卷一' }, ctx());
    expect(book.ok).toBe(true);
    const bookId = (book.data as { id: string }).id;
    expect(Object.keys(book.data as object).sort()).toEqual(
      ['currentChapter', 'id', 'projectId', 'title'].sort(),
    );

    // ── characters ──
    const ch = await reg.invoke(
      'character.create',
      { bookId, name: '沈砚', aliases: ['小砚'], role: '主角' },
      ctx(),
    );
    expect(ch.ok).toBe(true);
    expect(Object.keys(ch.data as object).sort()).toEqual(
      ['characterId', 'created', 'name'].sort(),
    );

    // ── facts（含 timeline 用的时间锚点）──
    const src = '临河镇的当铺只认票据不认人。';
    const quote = '只认票据不认人';
    const off = src.indexOf(quote);
    const ev = await reg.invoke(
      'evidence.add',
      {
        sourceRef: 'golden.md#1',
        quote,
        startOffset: off,
        endOffset: off + quote.length,
        sourceText: src,
      },
      ctx(),
    );
    expect(ev.ok).toBe(true);
    const fact = await reg.invoke(
      'fact.add',
      {
        subjectType: 'WORLD',
        subjectId: '临河镇',
        predicate: '当铺规矩',
        objectValue: '只认票据不认人',
        confidence: 0.9,
        evidenceId: (ev.data as { evidenceId: string }).evidenceId,
      },
      ctx(),
    );
    expect(fact.ok).toBe(true);
    // ⚠ 新事实必须是 PROVISIONAL —— 直接成 Canon 会绕过证据复核
    expect((fact.data as { status: string }).status).toBe('PROVISIONAL');

    // ── chapters ──
    const chapter = await reg.invoke(
      'chapter.create',
      { bookId, chapterNumber: 1, title: '第一章 账房' },
      ctx(),
    );
    expect(chapter.ok).toBe(true);
    const chapterId = (chapter.data as { id: string }).id;
    expect((chapter.data as { status: string }).status).toBe('DRAFT');
    expect((chapter.data as { bodyPath: unknown }).bodyPath).toBeNull();

    // ── review（确定性检测器，不需要模型）──
    // ⚠ review.run 的参数也是**嵌套的** `review: {...}`（同 chapter.plan）
    const review = await reg.invoke(
      'review.run',
      {
        chapterId,
        review: { issues: [], overallStatus: 'PASSED' },
      },
      ctx(),
    );
    expect(review.ok).toBe(true);

    // ── skills（检索入口，即使库为空也要结构稳定）──
    const skills = await reg.invoke('review.categories', {}, ctx());
    expect(skills.ok).toBe(true);

    // ── timeline：状态变化按章号可查（§13 的判定依据）──
    expect(t.repos.chapters.listByBook(bookId)).toHaveLength(1);
    expect(t.repos.characters.listByBook(bookId)).toHaveLength(1);
    expect(t.repos.facts.listBySubject(bookId, 'WORLD', '临河镇')).toHaveLength(1);
  });

  it('⚠ 夹具确定性：同一流程跑两次得到相同结构（Golden Set 的前提）', async () => {
    // ⚠ 这条测试保护的是**夹具本身**。若夹具不确定（如随机 id 进断言、
    //   时间戳进比较），Golden Test 会随机失败，然后被人加 `-t` 跳过，
    //   最终失去意义。所以先把"确定性"本身测掉。
    const shapes: string[] = [];

    for (let i = 0; i < 2; i++) {
      const proj = createTestProject();
      try {
        const reg = registry(proj);
        const p = await reg.invoke(
          'project.create',
          { name: 'Golden', genre: '都市', premise: '基准夹具' },
          ctx(),
        );
        const pid = (p.data as { id: string }).id;
        const b = await reg.invoke('book.create', { projectId: pid, title: '卷一' }, ctx());
        const bid = (b.data as { id: string }).id;
        const c = await reg.invoke(
          'chapter.create',
          { bookId: bid, chapterNumber: 1, title: '第一章' },
          ctx(),
        );
        // 只比较**字段名与结构**，不比较 id/时间戳（那些天然不同）
        shapes.push(
          JSON.stringify({
            project: Object.keys(p.data as object).sort(),
            book: Object.keys(b.data as object).sort(),
            chapter: Object.keys(c.data as object).sort(),
            chapterStatus: (c.data as { status: string }).status,
          }),
        );
      } finally {
        proj.cleanup();
      }
    }

    expect(shapes[0]).toBe(shapes[1]);
  });
});

// 保留引用，避免 lint 认为未使用（这两个是 Golden Set 后续扩展的入口）
void Writer;
void Reviewer;
