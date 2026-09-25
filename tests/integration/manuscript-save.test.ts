/**
 * Manuscript 仓储（M3，第二阶段施工单 §二 / §四 / §十 / §十一 / §三十六）
 *
 * ## 本文件要证伪的核心主张
 *
 * §二：**`SAVE != COMMIT`**
 *
 *   「绝对不能把保存正文设计成自动写入 Canon。」
 *
 * 这条最容易在实现时被破坏，因为"保存顺手提交一下"看起来很自然
 * （用户保存了，系统帮他推进状态多方便）。所以必须用**证伪测试**固化：
 * `manuscript.save()` 之后断言
 *
 *   ① `facts` 表 CANON 条数**不变**
 *   ② `chapters.status` **不变**
 *   ③ 无 `commit_manifests` 产生
 *
 * ⚠ 断言必须查**数据流下游终点**（HANDOVER 工程约定 2）：
 *   查库表而不是查 `save()` 的返回值。返回值说"我没提交"是自证 ——
 *   而缺陷的形态恰恰是"它说自己没提交，实际提交了"。
 *
 * ## 第二个要证伪的：Autosave 不能静默覆盖
 *
 * §十一：「不要直接静默覆盖」。所以 `open()` **只检测不恢复**，
 * 恢复必须由用户显式确认（`acceptAutosave`）。
 *
 * ## 第三个：自动保存不能写正式正文
 *
 * 若 `autosave()` 直接写 `manuscript.md`，等于"自动保存 = 保存"，
 * §十二 的切章保护就失去意义（没什么可保护的了）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Logger, sha256Text , workspaceRel } from '@nwa/core';
import { ManuscriptRepository } from '@nwa/storage';
import { WORKSPACE_FILES } from '@nwa/story';
import { createTestProject, makeChapter, type TestProject } from './helpers.js';

const logger = new Logger('test:manuscript-save', { level: 'error' });

let dir: string;
let t: TestProject | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nwa-ms-'));
});

afterEach(() => {
  t?.cleanup();
  t = null;
  rmSync(dir, { recursive: true, force: true });
});

function makeRepo(proj: TestProject): ManuscriptRepository {
  return new ManuscriptRepository({ db: proj.db, rootDir: proj.dir, logger });
}

/** 造一章并返回 { chapter, repo } */
function setup(text?: string) {
  const proj = createTestProject({ rootDir: dir });
  t = proj;
  const chapter = makeChapter(proj, 1);
  const repo = makeRepo(proj);
  if (text !== undefined) repo.save(proj.bookId, 1, text);
  return { proj, chapter, repo };
}

/** 读库里的 Canon 事实条数（下游终点，不是返回值） */
function canonCount(proj: TestProject): number {
  const row = proj.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM facts WHERE book_id = ? AND status = 'CANON'",
    proj.bookId,
  );
  return row?.n ?? 0;
}

function manifestCount(proj: TestProject): number {
  const row = proj.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM commit_manifests');
  return row?.n ?? 0;
}

// ────────────────────────────────────────────────────────────
describe('① ⚠⚠ Save ≠ Commit（本阶段成立与否的判据）', () => {
  it('⚠ save() 之后：Canon / 章节状态 / manifest 三者全都不变', () => {
    const { proj, chapter, repo } = setup();

    const canonBefore = canonCount(proj);
    const statusBefore = proj.repos.chapters.get(chapter.id).status;
    const manifestBefore = manifestCount(proj);

    repo.save(proj.bookId, 1, '第一章\n\n他把信塞进靴筒，然后推开门。');

    // ⚠ 三条都查**库表**，不查返回值
    expect(canonCount(proj)).toBe(canonBefore);
    expect(proj.repos.chapters.get(chapter.id).status).toBe(statusBefore);
    expect(manifestCount(proj)).toBe(manifestBefore);
    expect(statusBefore).toBe('DRAFT');
  });

  it('⚠ 正文真的落盘了（不能只是"没提交"，还要"真的保存了"）', () => {
    const { proj, repo } = setup();
    const text = '第一章\n\n雨下得很大。';
    const res = repo.save(proj.bookId, 1, text);

    // 只断言"没提交"会漏掉"其实什么都没干"
    expect(existsSync(res.path)).toBe(true);
    expect(readFileSync(res.path, 'utf8')).toBe(text);
    expect(repo.get(proj.bookId, 1)).toBe(text);
  });

  it('⚠ save() 返回的 sourceHash === sha256Text(正文)（stale 锚点的依据）', () => {
    const { proj, repo } = setup();
    const text = '第一章\n\n他把信塞进靴筒。';
    const res = repo.save(proj.bookId, 1, text);
    expect(res.sourceHash).toBe(sha256Text(text));
  });

  it('⚠ 保存改一个字的正文 → sourceHash 必须变（锚点不是常量）', () => {
    const { proj, repo } = setup();
    const a = repo.save(proj.bookId, 1, '他把信塞进靴筒。');
    const b = repo.save(proj.bookId, 1, '他把信塞进靴筒，');
    expect(a.sourceHash).not.toBe(b.sourceHash);
  });
});

// ────────────────────────────────────────────────────────────
describe('② save() 的幂等性与 changed 语义', () => {
  it('内容相同时 changed=false，且**不重写文件**（mtime 是恢复判据之一）', async () => {
    const { proj, repo } = setup('第一版内容');
    const p = join(dir, workspaceRel(proj.bookId, 1), 'manuscript.md');
    const mtimeBefore = readFileSync(p, 'utf8');

    await new Promise((r) => setTimeout(r, 10));
    const res = repo.save(proj.bookId, 1, '第一版内容');

    expect(res.changed).toBe(false);
    // 内容确实没被改动
    expect(readFileSync(p, 'utf8')).toBe(mtimeBefore);
  });

  it('内容变了 → changed=true', () => {
    const { proj, repo } = setup('第一版');
    expect(repo.save(proj.bookId, 1, '第二版').changed).toBe(true);
  });

  it('首次保存（原本没有文件）→ changed=true', () => {
    const { proj, repo } = setup();
    expect(repo.save(proj.bookId, 1, '初次').changed).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
describe('③ ⚠ autosave 绝不能写正式正文（否则 §十二 切章保护失去意义）', () => {
  it('⚠ autosave() 之后 manuscript.md 内容**一个字节都没变**', () => {
    const { proj, repo } = setup('正式正文 v1');
    repo.autosave(proj.bookId, 1, '用户正在打字但还没保存的内容');

    expect(repo.get(proj.bookId, 1)).toBe('正式正文 v1');
  });

  it('autosave 落在旁路文件，不落在 manuscript.md', () => {
    const { proj, repo } = setup('正式正文');
    const r = repo.autosave(proj.bookId, 1, '未保存的编辑');
    expect(r.path.endsWith('manuscript.autosave.md')).toBe(true);
    expect(r.path.endsWith('manuscript.md')).toBe(false);
  });

  it('⚠ 文件名必须与 @nwa/story 的 WORKSPACE_FILES 一致（两处声明会漂移）', () => {
    // 本仓储在 @nwa/storage 层，不能 import @nwa/story（会形成反向依赖），
    // 所以文件名是重新声明的。这条断言把两处钉在一起。
    const { proj, repo } = setup('x');
    const r = repo.autosave(proj.bookId, 1, 'y');
    expect(r.path.endsWith(WORKSPACE_FILES.manuscriptAutosave)).toBe(true);

    const s = repo.save(proj.bookId, 1, 'z');
    expect(s.path.endsWith(WORKSPACE_FILES.manuscript)).toBe(true);
  });

  it('传了光标状态 → 一起落盘（§十一：只恢复文本等于没恢复）', () => {
    const { proj, repo } = setup('正文');
    repo.autosave(proj.bookId, 1, '正文加了一个字', {
      cursor: 7,
      selectionStart: 3,
      selectionEnd: 7,
      scrollTop: 420,
    });
    const st = repo.readEditorState(proj.bookId, 1);
    expect(st?.cursor).toBe(7);
    expect(st?.selectionStart).toBe(3);
    expect(st?.selectionEnd).toBe(7);
    expect(st?.scrollTop).toBe(420);
    // 状态必须自带它对应的正文哈希，否则无法判断"这份光标属于哪一版"
    expect(st?.sourceHash).toBe(sha256Text('正文加了一个字'));
  });

  it('编辑器状态损坏 → 返回 null 而不是抛错（不让坏数据炸掉打开流程）', () => {
    const { proj, repo } = setup('正文');
    const p = join(dir, workspaceRel(proj.bookId, 1), 'editor-state.json');
    writeFileSync(p, '{ 这不是合法 JSON', 'utf8');
    expect(repo.readEditorState(proj.bookId, 1)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
describe('④ ⚠ 崩溃恢复检测：不静默覆盖（§十一）', () => {
  it('⚠ 没有 autosave → 不报"有未恢复内容"', () => {
    const { proj, repo } = setup('正文');
    const rec = repo.checkRecovery(proj.bookId, 1);
    expect(rec.hasNewerAutosave).toBe(false);
    expect(rec.message).toContain('没有未恢复');
  });

  it('⚠⚠ autosave 与正文**内容相同** → 不算有未恢复内容', () => {
    // 若只比时间戳，用户每次打开章节都会看到"发现未恢复的编辑内容" ——
    // 一个总是出现的提示等于没有提示，作者会条件反射点「放弃」，
    // 真正的丢失场景就救不回来了。
    const { proj, repo } = setup('一模一样的内容');
    repo.autosave(proj.bookId, 1, '一模一样的内容');
    expect(repo.checkRecovery(proj.bookId, 1).hasNewerAutosave).toBe(false);
  });

  it('⚠ autosave 内容与正文不同 → 检测到，且**不自动覆盖**', () => {
    const { proj, repo } = setup('正式正文');
    repo.autosave(proj.bookId, 1, '用户改了一半还没保存的正文');

    const rec = repo.checkRecovery(proj.bookId, 1);
    expect(rec.hasNewerAutosave).toBe(true);
    expect(rec.autosaveText).toBe('用户改了一半还没保存的正文');
    expect(rec.message).toContain('是否恢复');

    // ⚠ 关键：检测之后正文**仍然没变** —— 恢复必须由用户显式确认
    expect(repo.get(proj.bookId, 1)).toBe('正式正文');
  });

  it('⚠ open() 只检测不恢复（打开章节不得改正文）', () => {
    const { proj, repo } = setup('正式正文');
    repo.autosave(proj.bookId, 1, '未保存的编辑');

    const opened = repo.open(proj.bookId, 1);
    expect(opened.text).toBe('正式正文');
    expect(opened.recovery.hasNewerAutosave).toBe(true);
    expect(repo.get(proj.bookId, 1)).toBe('正式正文');
  });

  it('⚠ 只有 autosave、没有正式正文 → 也报有未恢复内容（新建章场景）', () => {
    const { proj, repo } = setup();
    repo.autosave(proj.bookId, 1, '第一章开头我写了几个字');
    const rec = repo.checkRecovery(proj.bookId, 1);
    expect(rec.hasNewerAutosave).toBe(true);
    expect(rec.message).toContain('还没有正式正文');
  });

  it('用户点「恢复」→ acceptAutosave 把 autosave 提升为正文，并清掉副本', () => {
    const { proj, repo } = setup('旧正文');
    repo.autosave(proj.bookId, 1, '新正文');

    const res = repo.acceptAutosave(proj.bookId, 1);
    expect(res?.sourceHash).toBe(sha256Text('新正文'));
    expect(repo.get(proj.bookId, 1)).toBe('新正文');
    // 恢复后再检测不应重复提示
    expect(repo.checkRecovery(proj.bookId, 1).hasNewerAutosave).toBe(false);
  });

  it('用户点「放弃」→ clearAutosave 清掉副本，正文不变', () => {
    const { proj, repo } = setup('正式正文');
    repo.autosave(proj.bookId, 1, '不要的内容');
    repo.clearAutosave(proj.bookId, 1);

    expect(repo.get(proj.bookId, 1)).toBe('正式正文');
    expect(repo.checkRecovery(proj.bookId, 1).hasNewerAutosave).toBe(false);
  });

  it('没有 autosave 时 acceptAutosave 返回 null（不凭空造正文）', () => {
    const { proj, repo } = setup('正文');
    expect(repo.acceptAutosave(proj.bookId, 1)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
describe('⑤ 保存状态查询（§九 / §三十五）', () => {
  it('编辑器文本与磁盘一致 → dirty=false', () => {
    const { proj, repo } = setup('正文内容');
    expect(repo.getSaveStatus(proj.bookId, 1, '正文内容').dirty).toBe(false);
  });

  it('⚠ 编辑器文本与磁盘不同 → dirty=true（用内容比对，不是比时间）', () => {
    const { proj, repo } = setup('正文内容');
    expect(repo.getSaveStatus(proj.bookId, 1, '正文内容改过了').dirty).toBe(true);
  });

  it('⚠ 没保存过但编辑器有内容 → 也算 dirty（新建章场景）', () => {
    const { proj, repo } = setup();
    const st = repo.getSaveStatus(proj.bookId, 1, '刚写的开头');
    expect(st.hasManuscript).toBe(false);
    expect(st.dirty).toBe(true);
  });

  it('存在未处理的 autosave → hasPendingAutosave=true（UI 要能提示）', () => {
    const { proj, repo } = setup('正式');
    repo.autosave(proj.bookId, 1, '未保存的');
    expect(repo.getSaveStatus(proj.bookId, 1, '正式').hasPendingAutosave).toBe(true);
  });

  it('sourceHash 与正文一致（供 UI 展示/校验）', () => {
    const { proj, repo } = setup('正文');
    expect(repo.getSaveStatus(proj.bookId, 1).sourceHash).toBe(sha256Text('正文'));
  });
});

// ────────────────────────────────────────────────────────────
describe('⑥ ⚠ 与 Canon 的隔离：本仓储对 chapters 只读', () => {
  it('⚠ isCommitted 只读不写（多次调用不改变状态）', () => {
    const { proj, chapter, repo } = setup('正文');
    const before = proj.repos.chapters.get(chapter.id).status;
    for (let i = 0; i < 3; i++) expect(repo.isCommitted(chapter.id)).toBe(false);
    expect(proj.repos.chapters.get(chapter.id).status).toBe(before);
  });

  it('章节已提交时 isCommitted=true（供 §30 的"提交按钮与保存视觉可辨"）', () => {
    const { proj, chapter, repo } = setup('正文');
    proj.repos.chapters.updateStatus(chapter.id, 'COMMITTED');
    expect(repo.isCommitted(chapter.id)).toBe(true);
  });

  it('⚠ 全流程（save + autosave + 恢复 + 放弃）后 Canon 与 manifest 仍为 0', () => {
    const { proj, chapter, repo } = setup();
    repo.save(proj.bookId, 1, 'v1');
    repo.autosave(proj.bookId, 1, 'v2', { cursor: 1, selectionStart: 1, selectionEnd: 1, scrollTop: 0 });
    repo.checkRecovery(proj.bookId, 1);
    repo.acceptAutosave(proj.bookId, 1);
    repo.save(proj.bookId, 1, 'v3');
    repo.autosave(proj.bookId, 1, 'v4');
    repo.clearAutosave(proj.bookId, 1);
    repo.getSaveStatus(proj.bookId, 1, 'v5');
    repo.isCommitted('c-不存在');

    expect(canonCount(proj)).toBe(0);
    expect(manifestCount(proj)).toBe(0);
    expect(proj.repos.chapters.get(chapter.id).status).toBe('DRAFT');
  });
});

// ────────────────────────────────────────────────────────────
describe('⑦ 多书 / 多章隔离', () => {
  it('⚠ 不同章节的正文互不干扰', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    makeChapter(proj, 1);
    makeChapter(proj, 2);
    const repo = makeRepo(proj);

    repo.save(proj.bookId, 1, '第一章正文');
    repo.save(proj.bookId, 2, '第二章正文');

    expect(repo.get(proj.bookId, 1)).toBe('第一章正文');
    expect(repo.get(proj.bookId, 2)).toBe('第二章正文');
    // 哈希不同（不共享状态）
    expect(repo.getSaveStatus(proj.bookId, 1).sourceHash).not.toBe(repo.getSaveStatus(proj.bookId, 2).sourceHash);
  });

  it('⚠ 第 1 章的 autosave 不会被第 2 章的检测命中', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    makeChapter(proj, 1);
    makeChapter(proj, 2);
    const repo = makeRepo(proj);

    repo.save(proj.bookId, 2, '第二章正文');
    repo.autosave(proj.bookId, 1, '第一章未保存的内容');

    expect(repo.checkRecovery(proj.bookId, 2).hasNewerAutosave).toBe(false);
    expect(repo.checkRecovery(proj.bookId, 1).hasNewerAutosave).toBe(true);
  });

  it('⚠ 章号非法（0 / 负数 / 小数）→ 抛错，不写出目录', () => {
    const { proj, repo } = setup();
    expect(() => repo.save(proj.bookId, 0, 'x')).toThrow(/正整数/);
    expect(() => repo.save(-1, 'x')).toThrow(/正整数/);
    expect(() => repo.save(1.5, 'x')).toThrow(/正整数/);
  });
});

// ────────────────────────────────────────────────────────────
describe('⑧ ⚠ 工作区目录不存在时能自建（首次编辑的场景）', () => {
  it('目录不存在 → save() 自动创建（不报错）', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    makeChapter(proj, 7);
    const repo = makeRepo(proj);

    // 确认目录确实不存在
    expect(existsSync(join(dir, workspaceRel(proj.bookId, 7)))).toBe(false);

    const res = repo.save(proj.bookId, 7, '第七章');
    expect(res.chapterNumber).toBe(7);
    expect(existsSync(res.path)).toBe(true);
    expect(repo.get(proj.bookId, 7)).toBe('第七章');
  });

  it('目录已存在但有其他产物 → save 不破坏它们', () => {
    const proj = createTestProject({ rootDir: dir });
    t = proj;
    makeChapter(proj, 1);
    const wsDir = join(dir, workspaceRel(proj.bookId, 1));
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'draft.md'), 'AI 初稿', 'utf8');

    makeRepo(proj).save(proj.bookId, 1, '用户改的');

    // ⚠ draft 必须原样保留 —— 它是"AI 到底写了什么"的唯一记录，
    //   被 Save 覆盖会让"用户改了什么"无法回答。
    expect(readFileSync(join(wsDir, 'draft.md'), 'utf8')).toBe('AI 初稿');
    expect(readFileSync(join(wsDir, 'manuscript.md'), 'utf8')).toBe('用户改的');
  });
});
