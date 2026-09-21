/**
 * Writer 测试（STEP 7，施工文档 §7.3 / §9.1）
 *
 * 最重要的两条：
 *   1. **Writer 只写工作区** —— 正式章节文件与数据库都不会被碰
 *   2. **不信任自由文本** —— 正文由结构化字段驱动，前文衔接只取尾部
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writer, assembleChapter, extractDeviations, stripDeviationNotes } from '@nwa/writing';
import type { TextCompleter } from '@nwa/writing';
import { ChapterWorkspace } from '@nwa/story';
import { Logger, ErrorCode, AppError } from '@nwa/core';
import { PlanOutputSchema } from '@nwa/shared';

let root: string;
const logger = new Logger('test:writer', { level: 'error' });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nwa-writer-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const planOf = (over: Record<string, unknown> = {}) =>
  PlanOutputSchema.parse({
    brief: {
      chapterNumber: 1,
      purpose: '主角离乡',
      previousState: '安稳',
      targetState: '踏上旅途',
      mainCharacters: ['张三'],
      requiredEvents: ['与母亲告别'],
      forbiddenEvents: ['主角死亡'],
      hook: '他回头看了一眼',
    },
    scenes: [
      {
        sceneId: 's1',
        purpose: '告别',
        setting: '城门口',
        startState: '未出发',
        endState: '已出城',
        continuityConstraints: ['母亲身体不好'],
      },
      { sceneId: 's2', purpose: '上路', startState: '已出城', endState: '远行途中' },
    ],
    ...over,
  });

/** 记录调用并返回预设文本的补全器 */
function completer(texts: string[]): {
  fn: TextCompleter;
  calls: { messages: readonly { role: string; content: string }[]; maxTokens?: number }[];
} {
  const calls: { messages: readonly { role: string; content: string }[]; maxTokens?: number }[] = [];
  let i = 0;
  const fn: TextCompleter = async (req) => {
    calls.push({ messages: req.messages, ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}) });
    const t = texts[Math.min(i, texts.length - 1)]!;
    i++;
    if (t === '__FAIL__') {
      // 约定：失败时抛错（与 ModelGateway.chat 的实际行为一致）
      throw new AppError(ErrorCode.MODEL_TIMEOUT, '模型超时');
    }
    return { text: t, usage: { inputTokens: 100, outputTokens: 200 } };
  };
  return { fn, calls };
}

const writerOf = (c: TextCompleter, n = 1) =>
  new Writer({ complete: c, workspace: new ChapterWorkspace({ rootDir: root, chapterNumber: n, logger }), logger });

describe('⚠ Writer 只写工作区（§9.1 核心原则）', () => {
  it('产物落在 workspace/chapter-001/draft.md', async () => {
    const { fn } = completer(['场景一正文', '场景二正文']);
    const r = await writerOf(fn).draft(planOf());

    expect(r.ok).toBe(true);
    expect(r.draft!.draftPath).toBe(join(root, 'workspace', 'chapter-001', 'draft.md'));
    expect(existsSync(r.draft!.draftPath)).toBe(true);
  });

  it('⚠ 绝不创建 chapters/ 下的正式章节文件', async () => {
    const { fn } = completer(['正文']);
    await writerOf(fn).draft(planOf());

    expect(existsSync(join(root, 'chapters'))).toBe(false);
    expect(existsSync(join(root, 'chapters', '001.md'))).toBe(false);
  });

  it('⚠ 绝不创建 canon/ 或更新任何 Canon 文件', async () => {
    const { fn } = completer(['正文']);
    await writerOf(fn).draft(planOf());

    expect(existsSync(join(root, 'canon'))).toBe(false);
    expect(existsSync(join(root, 'memory'))).toBe(false);
  });

  it('Writer 构造参数里没有 repo/db —— 物理上无法改库', () => {
    const { fn } = completer(['x']);
    const w = writerOf(fn);
    expect(Object.keys(w)).not.toContain('repos');
    expect(Object.keys(w)).not.toContain('db');
    expect(Object.keys(w)).not.toContain('tools');
  });

  it('同时落盘 plan 与 scene-plan，便于回溯"这段为什么这样写"', async () => {
    const { fn } = completer(['a', 'b']);
    const w = writerOf(fn);
    await w.draft(planOf());

    expect(w['workspace'].has('plan')).toBe(true);
    expect(w['workspace'].has('scenePlan')).toBe(true);

    const sp = JSON.parse(readFileSync(join(root, 'workspace', 'chapter-001', 'scene-plan.json'), 'utf8'));
    expect(sp.scenes.map((s: { sceneId: string }) => s.sceneId)).toEqual(['s1', 's2']);
    expect(sp.scenes[0].chars).toBe(1);
  });
});

describe('逐场景生成与衔接', () => {
  it('每个场景一次模型调用', async () => {
    const { fn, calls } = completer(['a', 'b']);
    await writerOf(fn).draft(planOf());
    expect(calls).toHaveLength(2);
  });

  it('第一个场景不带前文', async () => {
    const { fn, calls } = completer(['a', 'b']);
    await writerOf(fn).draft(planOf());
    const firstUser = calls[0]!.messages.at(-1)!.content;
    expect(firstUser).not.toContain('前文结尾');
  });

  it('第二个场景带上第一个场景的结尾', async () => {
    const { fn, calls } = completer(['第一个场景的结尾文字', 'b']);
    await writerOf(fn).draft(planOf());
    const secondUser = calls[1]!.messages.at(-1)!.content;
    expect(secondUser).toContain('前文结尾');
    expect(secondUser).toContain('第一个场景的结尾文字');
  });

  it('⚠ 前文只取尾部（不把全文塞回去挤占生成空间）', async () => {
    const long = '甲'.repeat(2000);
    const { fn, calls } = completer([long, 'b']);
    const w = new Writer({
      complete: fn,
      workspace: new ChapterWorkspace({ rootDir: root, chapterNumber: 1, logger }),
      logger,
      tailChars: 100,
    });
    await w.draft(planOf());

    const secondUser = calls[1]!.messages.at(-1)!.content;
    // 只带 100 字尾部，而不是 2000 字全文
    expect(secondUser.split('甲').length - 1).toBe(100);
  });

  it('maxTokens 按目标字数换算（中文留足余量）', async () => {
    const { fn, calls } = completer(['a', 'b']);
    const w = new Writer({
      complete: fn,
      workspace: new ChapterWorkspace({ rootDir: root, chapterNumber: 1, logger }),
      logger,
      wordsPerScene: 1000,
    });
    await w.draft(planOf());
    expect(calls[0]!.maxTokens).toBe(2200);
  });
});

describe('⚠ 不信任自由文本：结构化字段驱动', () => {
  it('requiredEvents 被逐条写入约束块', async () => {
    const { fn, calls } = completer(['a', 'b']);
    await writerOf(fn).draft(planOf());
    expect(calls[0]!.messages[1]!.content).toContain('与母亲告别');
    expect(calls[0]!.messages[1]!.content).toContain('本章必须发生');
  });

  it('forbiddenEvents 单独成块（绝不与 required 混在一起）', async () => {
    const { fn, calls } = completer(['a', 'b']);
    await writerOf(fn).draft(planOf());
    const block = calls[0]!.messages[1]!.content;
    expect(block).toContain('本章绝不发生');
    expect(block).toContain('主角死亡');
  });

  it('场景的 continuityConstraints 被传达', async () => {
    const { fn, calls } = completer(['a', 'b']);
    await writerOf(fn).draft(planOf());
    expect(calls[0]!.messages[1]!.content).toContain('母亲身体不好');
  });

  it('场景的 endState 作为"必须到达"传达', async () => {
    const { fn, calls } = completer(['a', 'b']);
    await writerOf(fn).draft(planOf());
    expect(calls[0]!.messages[1]!.content).toContain('必须到达：已出城');
  });

  it('伏笔 plant/reinforce/payoff 分块传达', async () => {
    const p = planOf();
    p.brief.foreshadowing = { plant: ['玉佩'], reinforce: ['旧伤'], payoff: ['父亲的承诺'] };
    const { fn, calls } = completer(['a', 'b']);
    await writerOf(fn).draft(p);
    const block = calls[0]!.messages[1]!.content;
    expect(block).toContain('本章需要埋下');
    expect(block).toContain('玉佩');
    expect(block).toContain('本章需要强化');
    expect(block).toContain('本章需要回收');
  });

  it('system prompt 含中文写作规范（省略号而非破折号）', async () => {
    const { fn, calls } = completer(['a', 'b']);
    await writerOf(fn).draft(planOf());
    const sys = calls[0]!.messages.map((m) => m.content).join('\n');
    expect(sys).toContain('省略号');
    expect(sys).toContain('不要复述双方都已知的信息');
  });

  it('场景序号在约束块中标注', async () => {
    const { fn, calls } = completer(['a', 'b']);
    await writerOf(fn).draft(planOf());
    expect(calls[0]!.messages[1]!.content).toContain('1/2');
    expect(calls[1]!.messages[1]!.content).toContain('2/2');
  });
});

describe('正文组装', () => {
  it('场景之间用空行分隔，无标记污染', async () => {
    const { fn } = completer(['第一段', '第二段']);
    const r = await writerOf(fn).draft(planOf());
    expect(r.draft!.text).toBe('第一段\n\n第二段');
    expect(r.draft!.text).not.toContain('场景1');
    expect(r.draft!.text).not.toContain('sceneId');
  });

  it('assembleChapter 过滤空场景', () => {
    expect(
      assembleChapter([
        { sceneId: 'a', purpose: 'p', text: '甲', chars: 1, deviations: [] },
        { sceneId: 'b', purpose: 'p', text: '  ', chars: 0, deviations: [] },
        { sceneId: 'c', purpose: 'p', text: '乙', chars: 1, deviations: [] },
      ]),
    ).toBe('甲\n\n乙');
  });

  it('统计总字数与 token 用量', async () => {
    const { fn } = completer(['12345', '678']);
    const r = await writerOf(fn).draft(planOf());
    expect(r.draft!.totalChars).toBe(5 + 3 + 2); // 两段字数 + 分隔的 \n\n
    expect(r.draft!.usage).toEqual({ inputTokens: 200, outputTokens: 400 });
  });
});

describe('失败处理', () => {
  it('场景失败时返回 failedSceneIndex', async () => {
    const { fn } = completer(['第一节', '__FAIL__']);
    const r = await writerOf(fn).draft(planOf());
    expect(r.ok).toBe(false);
    expect(r.failedSceneIndex).toBe(1);
    expect(r.error!.code).toBe(ErrorCode.MODEL_TIMEOUT);
  });

  it('⚠ 部分完成时保留已生成内容（不让用户白等）', async () => {
    const { fn } = completer(['已完成的场景', '__FAIL__']);
    const r = await writerOf(fn).draft(planOf());

    expect(r.ok).toBe(false);
    const draft = readFileSync(join(root, 'workspace', 'chapter-001', 'draft.md'), 'utf8');
    expect(draft).toBe('已完成的场景');
  });

  it('记录 run.json 标记 PARTIAL 与已完成场景', async () => {
    const { fn } = completer(['甲', '__FAIL__']);
    await writerOf(fn).draft(planOf());
    const run = JSON.parse(readFileSync(join(root, 'workspace', 'chapter-001', 'run.json'), 'utf8'));
    expect(run.status).toBe('PARTIAL');
    expect(run.completedScenes).toEqual(['s1']);
  });

  it('第一个场景就失败时不写任何产物', async () => {
    const { fn } = completer(['__FAIL__']);
    const r = await writerOf(fn).draft(planOf());
    expect(r.ok).toBe(false);
    expect(r.failedSceneIndex).toBe(0);
    expect(existsSync(join(root, 'workspace', 'chapter-001', 'draft.md'))).toBe(false);
  });

  it('空场景计划被拒绝', async () => {
    const p = planOf();
    (p as { scenes: unknown[] }).scenes = [];
    const { fn } = completer(['x']);
    const r = await writerOf(fn).draft(p);
    expect(r.ok).toBe(false);
    expect(r.error!.message).toContain('没有场景');
  });
});

describe('偏离说明的提取（自报，不作判定依据）', () => {
  it('识别【偏离说明】并从正文中剥离', () => {
    const t = '正文正文正文正文正文正文正文正文\n\n【偏离说明】我调整了告别的地点';
    expect(extractDeviations(t)).toEqual(['我调整了告别的地点']);
    expect(stripDeviationNotes(t)).toBe('正文正文正文正文正文正文正文正文');
  });

  it('说明段出现在前半部分时不当成偏离（避免误判正文内容）', () => {
    const t = '【说明】开头\n' + '正文'.repeat(50);
    expect(extractDeviations(t)).toEqual([]);
  });

  it('无说明时返回空数组', () => {
    expect(extractDeviations('普通正文，没有说明')).toEqual([]);
  });

  it('过长的"说明"不被采信（可能是正文）', () => {
    const t = '正文'.repeat(20) + '\n【说明】' + '很长'.repeat(300);
    expect(extractDeviations(t)).toEqual([]);
  });

  it('偏离说明记入 scene-plan.json 供人工复核', async () => {
    const { fn } = completer(['正文正文正文正文正文正文正文正文\n\n【偏离说明】改了地点', '乙']);
    const w = writerOf(fn);
    await w.draft(planOf());
    const sp = JSON.parse(readFileSync(join(root, 'workspace', 'chapter-001', 'scene-plan.json'), 'utf8'));
    expect(sp.scenes[0].deviations).toEqual(['改了地点']);
  });
});
