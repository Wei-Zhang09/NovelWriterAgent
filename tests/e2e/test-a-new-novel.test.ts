/**
 * §52 Test A：新建小说
 *
 * ```
 * create project → add character → add world rule → add outline
 * ```
 * 全部成功。
 *
 * ## ⚠ 本测试暴露的真实缺陷（写它的时候才发现）
 *
 * `character.create` **此前不存在** —— `CharacterRepository` 存储层
 * 完整（create/get/listByBook/updateProfile），但没有任何工具暴露它。
 *
 * 也就是说 §52 Test A 的第二步在补这个工具之前**根本无法执行**。
 * 这与 `detectProseIssues`（写了没接线）、`ChapterBrief.skillRefs`
 * （字段没人填）同类：底层齐备，使用者够不到，而代码审查看不出来。
 *
 * ## 「world rule」怎么落
 *
 * 不新造表 —— `facts` 已支持 `subject_type='WORLD'`（见 FACT_SUBJECT_TYPES）。
 * 世界规则就是 subjectType=WORLD 的事实。复用既有模型而非平行造一套，
 * 避免世界观设定存在两处、且两处会漂移。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ToolRegistry, createAllTools } from '@nwa/harness';
import type { ToolContext } from '@nwa/shared';
import { createTestProject, type TestProject } from '../integration/helpers.js';

let t: TestProject | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function ctx(permission: ToolContext['callerPermission'] = 'ADMIN'): ToolContext {
  return { runId: 'run_a', projectId: 'p', callerPermission: permission, emit: () => {} };
}

function registry(project: TestProject): ToolRegistry {
  const r = new ToolRegistry();
  for (const tool of createAllTools(project.repos)) r.register(tool);
  return r;
}

describe('§52 Test A：新建小说', () => {
  it('create project → add character → add world rule → add outline 全部成功', async () => {
    t = createTestProject();
    const reg = registry(t);

    // ── 1. create project ──
    //
    // ⚠ `createTestProject()` 已预置一个项目（"测试项目"）与一本书 ——
    //   这是测试夹具的既有约定。断言"项目数为 1"会与它冲突，
    //   所以这里断言**新增了一个**项目，而不是"只有一个"。
    const before = t.repos.projects.list().length;

    const proj = await reg.invoke(
      'project.create',
      { name: '夜航', genre: '都市', premise: '一个在江边当铺打杂的少年' },
      ctx(),
    );
    expect(proj.ok).toBe(true);
    const projectId = (proj.data as { id: string }).id;
    expect(projectId).toBeTruthy();
    expect(t.repos.projects.list()).toHaveLength(before + 1);

    // ⚠ 建书必须用 book.create —— 此前**没有这个工具**（只有 IPC），
    //   导致"新建项目 → 建书 → 建章"这条链路在建书这一步断掉。
    //   误用 project.create 会静默再建一个**项目**（它忽略 projectId 参数），
    //   而不是报错 —— 这是本测试写出来时才发现的缺陷。
    const book = await reg.invoke('book.create', { projectId, title: '夜航·卷一' }, ctx());
    expect(book.ok).toBe(true);
    const bookId = (book.data as { id: string }).id;
    expect(bookId).toBeTruthy();
    // 确认建的是**书**不是项目（误用 project.create 会静默多建一个项目）
    expect(t.repos.books.listByProject(projectId)).toHaveLength(1);
    expect(t.repos.projects.list()).toHaveLength(before + 1);

    // ── 2. add character（⚠ 此前没有这个工具，Test A 卡在这一步）──
    const ch = await reg.invoke(
      'character.create',
      {
        bookId,
        name: '沈砚',
        aliases: ['小砚'],
        role: '主角',
        profile: { age: 16, skill: '抄账' },
      },
      ctx(),
    );
    expect(ch.ok).toBe(true);
    expect((ch.data as { created: boolean }).created).toBe(true);
    const characterId = (ch.data as { characterId: string }).characterId;
    expect(characterId).toBeTruthy();

    // 同名不重复创建 —— 否则"这个角色是谁"产生歧义，
    // 而连续性检查按名字匹配正文 → 歧义直接变成误判。
    const again = await reg.invoke('character.create', { bookId, name: '沈砚' }, ctx());
    expect(again.ok).toBe(true);
    expect((again.data as { created: boolean }).created).toBe(false);
    expect((again.data as { characterId: string }).characterId).toBe(characterId);

    // ── 3. add world rule（走 facts 的 WORLD 主体，不另造表）──
    // ⚠ evidence.add 的契约要求 quote 与 sourceText 的 [start,end) **精确匹配**
    //   （EVIDENCE_QUOTE_MISMATCH 是硬校验）—— 这保证证据可回溯到原文（§46）。
    const srcText = '临河镇的当铺只认票据不认人，这是祖上传下的规矩。';
    const quote = '只认票据不认人';
    const startOffset = srcText.indexOf(quote);
    const ev = await reg.invoke(
      'evidence.add',
      {
        sourceRef: 'world.md#1',
        quote,
        startOffset,
        endOffset: startOffset + quote.length,
        sourceText: srcText,
      },
      ctx(),
    );
    expect(ev.ok).toBe(true);

    const rule = await reg.invoke(
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
    expect(rule.ok).toBe(true);

    // ── 4. add outline（章节 + 计划）──
    const chapter = await reg.invoke(
      'chapter.create',
      { bookId, chapterNumber: 1, title: '第一章 账房' },
      ctx(),
    );
    expect(chapter.ok).toBe(true);
    // ⚠ chapter.create 的返回字段是 `id`，不是 `chapterId`
    const chapterId = (chapter.data as { id: string }).id;

    // ⚠ chapter.plan 的参数是**嵌套的** `plan: { brief, scenes }`，
    //   不是把 brief/scenes 平铺在顶层（平铺会报"缺少 plan 参数"）。
    const plan = await reg.invoke(
      'chapter.plan',
      {
        chapterId,
        plan: {
          brief: {
            chapterNumber: 1,
            purpose: '建立主角处境',
            previousState: '初到临河镇',
            targetState: '接手当铺账目',
            mainCharacters: ['沈砚'],
            requiredEvents: ['他第一次见到铜牌'],
            forbiddenEvents: [],
            emotionalArc: '警惕 → 好奇',
            pacingPlan: '前慢后快',
            hook: '铜牌上的纹路像某个字',
          },
          scenes: [
            {
              sceneId: 'sc1',
              purpose: '开场建立处境',
              endState: '他决定留下',
              sceneFunction: 'SETUP',
            },
          ],
        },
      },
      ctx(),
    );
    expect(plan.ok).toBe(true);

    // ── 汇总：四步都留下可查的记录（不只"调用返回 ok"）──
    expect(t.repos.projects.list().length).toBeGreaterThan(before);
    expect(t.repos.characters.listByBook(bookId)).toHaveLength(1);
    // ⚠ FactRepository 没有 listByBook —— 按主体查（WORLD 规则挂在 subjectId 上）
    expect(t.repos.facts.listBySubject(bookId, 'WORLD', '临河镇')).toHaveLength(1);
    expect(t.repos.chapters.listByBook(bookId)).toHaveLength(1);
    // 计划确实落库（outline 不是只在内存里）
    expect(t.repos.chapters.readPlan(chapterId)).not.toBeNull();
  });
});
