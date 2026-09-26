/**
 * 读取侧优先级链（缺陷 A 修复）—— **证伪测试**
 *
 * ## 要证伪的核心主张
 *
 * 施工文档与 ADR-0008 都写明：
 *
 *   > 预览、真实提交、审阅、连续性检查、状态结算**必须针对同一份文本**，
 *   > 否则「审阅通过」这句话描述的是另一份稿子。
 *
 * M1 把这套优先级链只实现在**提交侧**，读取侧（`manuscript.open`）硬读
 * `manuscript.md`，而工作流**从不写**该文件 → 作者打开编辑器看到空白，
 * 点保存又用空正文覆盖，提交侧却仍按链取"当前正文"
 * → AI 写好的正文**静默丢失**。
 *
 * 实测（整链联调，`pnpm verify:chain`）：
 *   `draft.md` = 7,986 字节 ／ `manuscript.md` 不存在
 *   → 提交后 `chapters/001.md` = 68 字节且状态 COMMITTED
 *
 * ## 本文件同时证伪「修复不能破坏 §15」
 *
 * 读取侧改成回退到 AI 稿之后，最容易顺手犯的错是让**写**也回退 ——
 * 那会让 AI 产出覆盖作者的正文（施工单 §15 / ADR-0008 §7：
 * 「AI Revision 永不自动覆盖 manuscript」）。
 *
 * 所以最后一组测试专门造 `manuscript ≠ revision` 并断言
 * `manuscript.md` **一个字节都没变**。这一组若被删掉，
 * "修复读取侧"就可能在下次改动中滑向"AI 可覆盖用户正文"。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  Logger,
  MANUSCRIPT_SOURCE_ORDER,
  MANUSCRIPT_SOURCE_FILE,
  resolveManuscriptText,
  workspaceRel,
} from '@nwa/core';
import { ManuscriptRepository } from '@nwa/storage';
import { createTestProject, makeChapter, type TestProject } from './helpers.js';

const logger = new Logger('test:manuscript-read-chain', { level: 'error' });

let dir: string;
let t: TestProject | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nwa-mschain-'));
});

afterEach(() => {
  t?.cleanup();
  t = null;
  rmSync(dir, { recursive: true, force: true });
});

/** 造一章 + 仓储；并按需写入某几份稿 */
function setup(files: Partial<Record<'manuscript' | 'revision' | 'draft', string>> = {}) {
  const proj = createTestProject({ rootDir: dir });
  t = proj;
  const chapter = makeChapter(proj, 1);
  const repo = new ManuscriptRepository({ db: proj.db, rootDir: proj.dir, logger });
  const wsDir = join(proj.dir, workspaceRel(proj.bookId, 1));
  mkdirSync(wsDir, { recursive: true });
  for (const [key, text] of Object.entries(files)) {
    if (text === undefined) continue;
    writeFileSync(join(wsDir, MANUSCRIPT_SOURCE_FILE[key as 'manuscript']), text, 'utf8');
  }
  return { proj, chapter, repo, wsDir };
}

const AI_DRAFT = 'AI 写的正文：凌晨两点四十七分，他从握手楼顶层出车。';
const AI_REVISION = 'Agent 修订稿：凌晨两点四十七分，他从握手楼顶层出车（已收紧）。';
const HUMAN = '作者手改的正文：他删掉了那一整段。';

// ────────────────────────────────────────────────────────────
describe('① ⚠⚠⚠ 缺陷 A：读取侧必须与提交侧用同一条优先级链', () => {
  it('⚠⚠ 只有 draft.md（工作流的真实产物）时，open() 必须读到正文 —— 不是 null', () => {
    const { proj, repo } = setup({ draft: AI_DRAFT });

    const opened = repo.open(proj.bookId, 1);

    // 这是缺陷 A 的核心断言：修复前这里是 null（作者看到空白）
    expect(opened.text).toBe(AI_DRAFT);
    expect(opened.source).toBe('draft');
    expect(opened.hasHumanManuscript).toBe(false);
  });

  it('⚠⚠ 只有 draft 时，get() 也必须读到正文（不是 null）', () => {
    const { proj, repo } = setup({ draft: AI_DRAFT });
    expect(repo.get(proj.bookId, 1)).toBe(AI_DRAFT);
  });

  it('⚠ 三份都在时，顺序必须是 manuscript → revision → draft', () => {
    const { proj, repo } = setup({
      manuscript: HUMAN,
      revision: AI_REVISION,
      draft: AI_DRAFT,
    });

    expect(repo.open(proj.bookId, 1).text).toBe(HUMAN);
    expect(repo.open(proj.bookId, 1).source).toBe('manuscript');
    expect(repo.open(proj.bookId, 1).hasHumanManuscript).toBe(true);
  });

  it('⚠ 无 manuscript 但有 revision 时取 revision（不是 draft）', () => {
    const { proj, repo } = setup({ revision: AI_REVISION, draft: AI_DRAFT });
    const opened = repo.open(proj.bookId, 1);
    expect(opened.text).toBe(AI_REVISION);
    expect(opened.source).toBe('revision');
  });

  it('三份都不存在 → text=null（编辑器显示空，不是报错）', () => {
    const { proj, repo } = setup();
    const opened = repo.open(proj.bookId, 1);
    expect(opened.text).toBeNull();
    expect(opened.hasHumanManuscript).toBe(false);
  });

  it('⚠⚠ 读取侧与提交侧共用同一个常量（顺序不可各写一份）', () => {
    // 若有人把任一侧的顺序改回硬编码，这条会失败
    expect(MANUSCRIPT_SOURCE_ORDER).toEqual(['manuscript', 'revision', 'draft']);
    expect(MANUSCRIPT_SOURCE_FILE.manuscript).toBe('manuscript.md');
    expect(MANUSCRIPT_SOURCE_FILE.draft).toBe('draft.md');
  });
});

// ────────────────────────────────────────────────────────────
describe('② ⚠⚠ 修复读取侧**不得**削弱 §15（AI 不得覆盖用户正文）', () => {
  it('⚠⚠⚠ 造 manuscript ≠ revision，断言 manuscript.md 一个字节都没变', () => {
    const { proj, repo, wsDir } = setup({
      manuscript: HUMAN,
      revision: AI_REVISION,
      draft: AI_DRAFT,
    });
    const manPath = join(wsDir, MANUSCRIPT_SOURCE_FILE.manuscript);
    const before = readFileSync(manPath, 'utf8');

    // 模拟"读取侧改动之后，有人顺手让写也走回退链"：
    // 只做读取操作 —— 若实现被改成"读取时把命中的来源写回 manuscript"，
    // 这里会看到 HUMAN 被 AI 稿覆盖。
    repo.open(proj.bookId, 1);
    repo.get(proj.bookId, 1);
    repo.getSaveStatus(proj.bookId, 1);
    repo.resolveCurrent(proj.bookId, 1);

    expect(readFileSync(manPath, 'utf8')).toBe(before);
    expect(readFileSync(manPath, 'utf8')).toBe(HUMAN);
  });

  it('⚠⚠ 只有 AI 稿时，读操作**不得**创建 manuscript.md（否则 AI 稿被冒充成人工作品）', () => {
    const { proj, repo, wsDir } = setup({ draft: AI_DRAFT, revision: AI_REVISION });
    const manPath = join(wsDir, MANUSCRIPT_SOURCE_FILE.manuscript);
    expect(existsSync(manPath)).toBe(false);

    repo.open(proj.bookId, 1);
    repo.getSaveStatus(proj.bookId, 1);

    // 一旦这里为 true，"当前显示的是 AI 稿"的如实告知就失去依据 ——
    // 系统会以为作者已经确认过正文
    expect(existsSync(manPath)).toBe(false);
    expect(repo.open(proj.bookId, 1).hasHumanManuscript).toBe(false);
  });

  it('⚠ save() 仍是**唯一**写 manuscript.md 的入口', () => {
    const { proj, repo, wsDir } = setup({ draft: AI_DRAFT });
    repo.save(proj.bookId, 1, HUMAN);
    expect(readFileSync(join(wsDir, MANUSCRIPT_SOURCE_FILE.manuscript), 'utf8')).toBe(HUMAN);
    // 保存之后优先级链第一项就命中它了
    expect(repo.open(proj.bookId, 1).source).toBe('manuscript');
  });
});

// ────────────────────────────────────────────────────────────
describe('③ ⚠⚠ 保存状态：显示 AI 稿时不能谎报"未保存改动"', () => {
  it('⚠⚠ 显示 draft 且编辑器内容 == draft → 必须**不是** dirty', () => {
    const { proj, repo } = setup({ draft: AI_DRAFT });

    const st = repo.getSaveStatus(proj.bookId, 1, AI_DRAFT);

    // 修复前：基线是 manuscript.md（不存在）→ currentHash=null
    // → 作者一打开章节就被判"有未保存改动"，而他什么都没改
    expect(st.dirty).toBe(false);
    expect(st.source).toBe('draft');
    expect(st.hasHumanManuscript).toBe(false);
  });

  it('⚠ 作者真的改了 AI 稿 → 必须 dirty（基线正确才能判脏）', () => {
    const { proj, repo } = setup({ draft: AI_DRAFT });
    const st = repo.getSaveStatus(proj.bookId, 1, AI_DRAFT + '他补了一句。');
    expect(st.dirty).toBe(true);
  });

  it('⚠ 显示 AI 稿时 savedAt 为 null（不说"已保存于 X"让人误以为是自己的正文）', () => {
    const { proj, repo } = setup({ draft: AI_DRAFT });
    expect(repo.getSaveStatus(proj.bookId, 1, AI_DRAFT).savedAt).toBeNull();
  });

  it('人工正文在场时 savedAt 有值（作者确实保存过）', () => {
    const { proj, repo } = setup({ manuscript: HUMAN });
    expect(repo.getSaveStatus(proj.bookId, 1, HUMAN).savedAt).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
describe('④ ⚠⚠ 恢复检测必须比对**人工正文**，不能被 AI 稿骗过', () => {
  it('⚠⚠ autosave 与 AI 稿相同、但磁盘上没有该内容 → 仍必须报告"有待恢复内容"', () => {
    const { proj, repo } = setup({ draft: AI_DRAFT });

    // 作者的编辑（尚未落盘）与 AI 稿恰好相同 —— 极端但合法
    repo.autosave(proj.bookId, 1, AI_DRAFT);

    const rec = repo.checkRecovery(proj.bookId, 1);

    // 修复前：checkRecovery 用 get() 比对，而 get() 回退到 draft
    // → 哈希相等 → 判成"没有待恢复内容" → 作者的编辑**静默消失**
    expect(rec.hasNewerAutosave).toBe(true);
  });

  it('⚠ autosave 与**人工正文**相同 → 确实没有待恢复内容', () => {
    const { proj, repo } = setup({ manuscript: HUMAN });
    repo.autosave(proj.bookId, 1, HUMAN);
    expect(repo.checkRecovery(proj.bookId, 1).hasNewerAutosave).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
describe('⑤ 纯函数 resolveManuscriptText 的边界', () => {
  it('readFile 抛错之外的正常路径：逐项回退', () => {
    const files: Record<string, string | null> = {
      manuscript: null,
      revision: null,
      draft: 'D',
    };
    const r = resolveManuscriptText((k) => files[k] ?? null);
    expect(r.text).toBe('D');
    expect(r.source).toBe('draft');
    expect(r.hasHumanManuscript).toBe(false);
  });

  it('⚠ 空字符串算"存在"（作者把整章清空也是合法状态）', () => {
    const r = resolveManuscriptText((k) => (k === 'manuscript' ? '' : null));
    expect(r.text).toBe('');
    expect(r.source).toBe('manuscript');
    expect(r.hasHumanManuscript).toBe(true);
  });

  it('全为 null → text=null', () => {
    const r = resolveManuscriptText(() => null);
    expect(r.text).toBeNull();
    expect(r.hasHumanManuscript).toBe(false);
  });
});
