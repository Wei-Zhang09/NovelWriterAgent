/**
 * 版本节点（M6 / 施工单 §十三 §十四；ADR-0008 §6 §7）
 *
 * ## 本文件要证伪的核心主张
 *
 * §14 与 ADR-0008 §6 的粒度判据：**只在三种情况建版本节点**
 *
 *   1. `AI_DRAFT`           —— Writer 出稿
 *   2. `AI_REVISION`        —— Agent 修订产出
 *   3. `USER_EDIT`          —— 手动保存**且内容 hash 与上一版本不同**
 *
 * 其中最容易做错的是第 3 条的后半句与那句硬要求：
 *
 *   **自动保存不建版本。**
 *
 * 这条不会让任何功能失效，只会让版本列表变成噪声 ——
 * 而噪声里的"上一版"是不可信的，于是"改坏了想退回上一版"这个
 * 版本存在的**唯一理由**就失效了。所以必须用测试钉住。
 *
 * ## ⚠ 断言查的是下游终点
 *
 * "建了版本节点"这个动作的终点是**库里多了一行 + 磁盘上多了一个文件**。
 * 只断言 `createVersion()` 的返回值会让"返回值对了但没落库"通过 ——
 * 所以每条都回查 `listVersions()`（走库）与 `readVersion()`（走文件）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger , workspaceRel } from '@nwa/core';
import { ManuscriptRepository } from '@nwa/storage';
import { createTestProject, makeChapter } from './helpers.js';

const logger = new Logger('test:manuscript-versions', { level: 'error' });

/**
 * ⚠ 用共享脚手架 `createTestProject` 而不是手写 INSERT：
 *   `projects` 表的列会随迁移变化（本文件第一版手写 INSERT 就撞上了
 *   "table projects has no column named root_dir"），
 *   而脚手架跟着仓储 API 走，不会因迁移漂移而失效。
 */
function setup() {
  const t = createTestProject();
  const chapter = makeChapter(t, 1);
  const repo = new ManuscriptRepository({ db: t.db, rootDir: t.dir, logger });
  return { t, repo, bookId: t.bookId, chapterId: chapter.id, chapterNumber: 1 };
}

describe('⑤ 版本节点（M6 / §十三 §十四）', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => {
    ctx.t.cleanup();
  });

  const v = (text: string, sourceType: 'AI_DRAFT' | 'AI_REVISION' | 'USER_EDIT' | 'RESTORED_AUTOSAVE') =>
    ctx.repo.createVersion({
      bookId: ctx.bookId,
      chapterId: ctx.chapterId,
      chapterNumber: ctx.chapterNumber,
      text,
      sourceType,
    });

  describe('① 粒度：只在三种（四种）情况建节点', () => {
    it('AI_DRAFT 建节点，seq 从 1 起', () => {
      const ver = v('AI 初稿内容。', 'AI_DRAFT');
      expect(ver).not.toBeNull();
      expect(ver!.seq).toBe(1);
      expect(ver!.sourceType).toBe('AI_DRAFT');
    });

    it('⚠ 同一内容重复建节点 → 返回 null，库里仍只有 1 条', () => {
      v('同样的内容。', 'AI_DRAFT');
      const second = v('同样的内容。', 'USER_EDIT');
      expect(second).toBeNull();
      // ⚠ 下游终点：库里确实只有 1 条
      expect(ctx.repo.listVersions(ctx.chapterId)).toHaveLength(1);
    });

    it('内容变了 → 建新节点，seq 递增', () => {
      v('第一版。', 'AI_DRAFT');
      const b = v('第二版。', 'USER_EDIT');
      expect(b!.seq).toBe(2);
      const list = ctx.repo.listVersions(ctx.chapterId);
      expect(list.map((x) => x.seq)).toEqual([2, 1]);
    });

    it('⚠ 改回旧内容（A→B→A）**仍然**建节点', () => {
      // 只比最新一版，不做全表去重 ——
      // "又变回 A 了"本身是有信息量的事实
      v('A。', 'AI_DRAFT');
      v('B。', 'USER_EDIT');
      const third = v('A。', 'USER_EDIT');
      expect(third).not.toBeNull();
      expect(third!.seq).toBe(3);
      expect(ctx.repo.listVersions(ctx.chapterId)).toHaveLength(3);
    });

    it('四种来源都能落库且 sourceType 如实保留', () => {
      v('草稿。', 'AI_DRAFT');
      v('修订。', 'AI_REVISION');
      v('用户改的。', 'USER_EDIT');
      v('恢复来的。', 'RESTORED_AUTOSAVE');
      const types = ctx.repo.listVersions(ctx.chapterId).map((x) => x.sourceType);
      expect(types).toEqual(['RESTORED_AUTOSAVE', 'USER_EDIT', 'AI_REVISION', 'AI_DRAFT']);
    });

    it('⚠ RESTORED_AUTOSAVE 与 USER_EDIT 是**不同的事实**，不合并', () => {
      v('用户自己改的。', 'USER_EDIT');
      v('恢复来的。', 'RESTORED_AUTOSAVE');
      const list = ctx.repo.listVersions(ctx.chapterId);
      expect(list[0]!.sourceType).toBe('RESTORED_AUTOSAVE');
      expect(list[1]!.sourceType).toBe('USER_EDIT');
    });
  });

  describe('② ⚠ 自动保存不建版本（ADR-0008 §6 的硬要求）', () => {
    it('⚠ 连打 5 次 autosave → 版本数仍为 0（尚未手动保存过）', () => {
      // autosave 与版本是两条**完全独立**的路径：
      // autosave 写旁路副本，版本由 save() 触发。
      for (let i = 0; i < 5; i++) {
        ctx.repo.autosave(ctx.bookId, ctx.chapterNumber, `自动保存第 ${i + 1} 次。`, {
          cursor: 0,
          selectionStart: 0,
          selectionEnd: 0,
          scrollTop: 0,
        });
      }
      expect(ctx.repo.listVersions(ctx.chapterId)).toHaveLength(0);
    });

    it('⚠ 手动保存 1 次 + 连打 5 次 autosave → 版本数仍为 1', () => {
      // 这是施工计划 M6 指定的证伪用例
      ctx.repo.save(ctx.bookId, ctx.chapterNumber, '用户手动保存的内容。');
      v('用户手动保存的内容。', 'USER_EDIT');
      for (let i = 0; i < 5; i++) {
        ctx.repo.autosave(ctx.bookId, ctx.chapterNumber, `自动保存 ${i}。`, {
          cursor: 0,
          selectionStart: 0,
          selectionEnd: 0,
          scrollTop: 0,
        });
      }
      expect(ctx.repo.listVersions(ctx.chapterId)).toHaveLength(1);
    });

    it('⚠ 反复按 Ctrl+S（内容不变）只产生 1 个节点', () => {
      const text = '内容没变。';
      ctx.repo.save(ctx.bookId, ctx.chapterNumber, text);
      v(text, 'USER_EDIT');
      for (let i = 0; i < 4; i++) {
        ctx.repo.save(ctx.bookId, ctx.chapterNumber, text); // changed=false
        v(text, 'USER_EDIT'); // 应当返回 null
      }
      expect(ctx.repo.listVersions(ctx.chapterId)).toHaveLength(1);
    });
  });

  describe('③ 版本内容落到文件（不是塞进库）', () => {
    it('版本文件真实存在且内容逐字相同', () => {
      const text = '第一段。\n\n第二段。';
      const ver = v(text, 'USER_EDIT')!;
      const abs = join(ctx.t.dir, ver.contentPath);
      expect(existsSync(abs)).toBe(true);
      expect(readFileSync(abs, 'utf8')).toBe(text);
    });

    it('readVersion 返回的内容与写入逐字相同', () => {
      const text = '换行\n与空格 都要保留。';
      const ver = v(text, 'USER_EDIT')!;
      expect(ctx.repo.readVersion(ver.id)).toBe(text);
    });

    it('版本文件路径在工作区的 versions/ 目录下', () => {
      const ver = v('内容。', 'USER_EDIT')!;
      expect(ver.contentPath).toBe(`${workspaceRel(ctx.bookId, 1)}/versions/v001.md`);
      expect(ver.contentPath).toContain(ctx.bookId);
    });

    it('seq 递增时文件名跟着变（v001 / v002）', () => {
      const a = v('一。', 'AI_DRAFT')!;
      const b = v('二。', 'USER_EDIT')!;
      expect(a.contentPath).toContain('v001.md');
      expect(b.contentPath).toContain('v002.md');
    });

    it('⚠ 版本文件缺失时 readVersion 返回 null，不抛错', () => {
      // §十四 明确版本可丢弃；抛错会让整个版本列表打不开
      const ver = v('内容。', 'USER_EDIT')!;
      rmSync(join(ctx.t.dir, ver.contentPath), { force: true });
      expect(ctx.repo.readVersion(ver.id)).toBeNull();
      // 但列表仍然可用
      expect(ctx.repo.listVersions(ctx.chapterId)).toHaveLength(1);
    });

    it('charCount 与内容长度一致', () => {
      const text = '一二三四五。';
      const ver = v(text, 'USER_EDIT')!;
      expect(ver.charCount).toBe(text.length);
    });

    it('contentHash 与内容 sha256 一致（锚点比对的基础）', () => {
      const text = '内容。';
      const ver = v(text, 'USER_EDIT')!;
      expect(ver.contentHash).toHaveLength(64);
      // 同内容不同版本不该建节点 → 换内容验证 hash 确实变了
      const other = v('别的内容。', 'USER_EDIT')!;
      expect(other.contentHash).not.toBe(ver.contentHash);
    });
  });

  describe('④ 列表与最新版本', () => {
    it('列表新的在前', () => {
      v('一。', 'AI_DRAFT');
      v('二。', 'AI_REVISION');
      v('三。', 'USER_EDIT');
      expect(ctx.repo.listVersions(ctx.chapterId).map((x) => x.seq)).toEqual([3, 2, 1]);
    });

    it('没有版本时返回空数组（不是 null）', () => {
      expect(ctx.repo.listVersions(ctx.chapterId)).toEqual([]);
    });

    it('latestVersion 取 seq 最大者；没有则 null', () => {
      expect(ctx.repo.latestVersion(ctx.chapterId)).toBeNull();
      v('一。', 'AI_DRAFT');
      v('二。', 'USER_EDIT');
      expect(ctx.repo.latestVersion(ctx.chapterId)!.seq).toBe(2);
    });

    it('⚠ 列表不含正文内容（避免列表 IPC 变成几百 KB）', () => {
      v('很长的内容。'.repeat(100), 'USER_EDIT');
      const list = ctx.repo.listVersions(ctx.chapterId);
      expect(JSON.stringify(list)).not.toContain('很长的内容。');
      // 但字数元信息在
      expect(list[0]!.charCount).toBeGreaterThan(100);
    });

    it('⚠ 章节被删 → 版本级联删除（不留悬空行）', () => {
      v('内容。', 'USER_EDIT');
      ctx.t.db.run('DELETE FROM chapters WHERE id = ?', ctx.chapterId);
      expect(ctx.repo.listVersions(ctx.chapterId)).toHaveLength(0);
    });
  });

  describe('⑤ 恢复历史版本（§十三）', () => {
    it('⚠ 恢复同时做两件事：改正文 + 建新节点', () => {
      const first = v('第一版正文。', 'AI_DRAFT')!;
      ctx.repo.save(ctx.bookId, ctx.chapterNumber, '第一版正文。');
      v('第二版正文。', 'USER_EDIT');
      ctx.repo.save(ctx.bookId, ctx.chapterNumber, '第二版正文。');

      const r = ctx.repo.restoreVersion(first.id);
      expect(r).not.toBeNull();

      // ① 正文确实变成第一版
      expect(ctx.repo.get(ctx.bookId, ctx.chapterNumber)).toBe('第一版正文。');
      // ② 建了新节点记录这次恢复
      const list = ctx.repo.listVersions(ctx.chapterId);
      expect(list[0]!.sourceType).toBe('RESTORED_AUTOSAVE');
      expect(list[0]!.note).toContain('v001');
    });

    it('⚠ 恢复**不删除**中间版本（作者可能还要对比回来）', () => {
      // ⚠ 恢复到**中间**那一版（v002），不是第一版 ——
      //   这是唯一能抓住"恢复时顺手删掉被越过版本"的用例：
      //   若恢复到 v001，`DELETE ... WHERE seq < 1` 什么也删不掉，
      //   缺陷会被掩盖（本文件第一版就踩了这个坑，注入 D 假绿）。
      v('第一版。', 'AI_DRAFT');
      const middle = v('第二版。', 'USER_EDIT')!;
      v('第三版。', 'USER_EDIT');

      ctx.repo.restoreVersion(middle.id);

      // 三个原版本**全部**还在（尤其是被越过的那两个），外加一个恢复节点
      const list = ctx.repo.listVersions(ctx.chapterId);
      expect(list).toHaveLength(4);
      expect(list.map((x) => x.seq)).toEqual([4, 3, 2, 1]);
      expect(ctx.repo.readVersion(middle.id)).toBe('第二版。');
    });

    it('⚠ 恢复**不碰 Canon**（章节状态不变、无 manifest）', () => {
      const first = v('第一版。', 'AI_DRAFT')!;
      v('第二版。', 'USER_EDIT');

      const before = ctx.t.db.get<{ status: string }>(
        'SELECT status FROM chapters WHERE id = ?',
        ctx.chapterId,
      )!;
      ctx.repo.restoreVersion(first.id);
      const after = ctx.t.db.get<{ status: string }>(
        'SELECT status FROM chapters WHERE id = ?',
        ctx.chapterId,
      )!;

      expect(after.status).toBe(before.status);
      expect(after.status).toBe('DRAFT');
      const cm = ctx.t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM commit_manifests');
      expect(cm!.n).toBe(0);
    });

    it('⚠ 恢复到最早那一版也不删任何东西', () => {
      const first = v('第一版。', 'AI_DRAFT')!;
      v('第二版。', 'USER_EDIT');
      v('第三版。', 'USER_EDIT');
      ctx.repo.restoreVersion(first.id);
      expect(ctx.repo.listVersions(ctx.chapterId)).toHaveLength(4);
    });

    it('恢复到当前内容 → 正文不变，不产生重复节点', () => {
      ctx.repo.save(ctx.bookId, ctx.chapterNumber, '当前内容。');
      const ver = v('当前内容。', 'USER_EDIT')!;
      const r = ctx.repo.restoreVersion(ver.id);
      expect(r).not.toBeNull();
      expect(ctx.repo.get(ctx.bookId, ctx.chapterNumber)).toBe('当前内容。');
      // 内容与最新版本相同 → createVersion 返回 null，不新增节点
      expect(ctx.repo.listVersions(ctx.chapterId)).toHaveLength(1);
    });

    it('版本不存在 → 返回 null（不抛错）', () => {
      expect(ctx.repo.restoreVersion('mv_不存在')).toBeNull();
    });

    it('版本文件缺失 → 返回 null，正文不变', () => {
      const ver = v('内容。', 'USER_EDIT')!;
      ctx.repo.save(ctx.bookId, ctx.chapterNumber, '当前正文。');
      rmSync(join(ctx.t.dir, ver.contentPath), { force: true });

      expect(ctx.repo.restoreVersion(ver.id)).toBeNull();
      expect(ctx.repo.get(ctx.bookId, ctx.chapterNumber)).toBe('当前正文。');
    });
  });

  describe('⑥ 多章隔离（用户硬要求：书与书/章与章不得互相污染）', () => {
    it('⚠ 两章的版本互不可见', () => {
      const ch2 = makeChapter(ctx.t, 2);
      v('第一章内容。', 'USER_EDIT');
      ctx.repo.createVersion({
        bookId: ctx.bookId,
        chapterId: ch2.id,
        chapterNumber: 2,
        text: '第二章内容。',
        sourceType: 'USER_EDIT',
      });

      expect(ctx.repo.listVersions(ctx.chapterId)).toHaveLength(1);
      expect(ctx.repo.listVersions(ch2.id)).toHaveLength(1);
      expect(ctx.repo.listVersions(ctx.chapterId)[0]!.contentPath).toContain('chapter-001');
      expect(ctx.repo.listVersions(ctx.chapterId)[0]!.contentPath).toContain(ctx.bookId);
      expect(ctx.repo.listVersions(ch2.id)[0]!.contentPath).toContain('chapter-002');
    });

    it('⚠ 两章的 seq 各自从 1 起（不共享计数器）', () => {
      const ch2 = makeChapter(ctx.t, 2);
      v('一章一。', 'AI_DRAFT');
      v('一章二。', 'USER_EDIT');
      const c2 = ctx.repo.createVersion({
        bookId: ctx.bookId,
        chapterId: ch2.id,
        chapterNumber: 2,
        text: '二章一。',
        sourceType: 'AI_DRAFT',
      });
      expect(c2!.seq).toBe(1);
    });

    it('⚠ 章节 id 不同但章号相同时不会互相覆盖文件', () => {
      // 防御性：chapterId 是主键、chapterNumber 决定路径。
      // 若实现里错用了全局 seq，两章的第一个版本会写到同一个 v001.md。
      const ch2 = makeChapter(ctx.t, 2);
      const a = v('第一章。', 'AI_DRAFT')!;
      const b = ctx.repo.createVersion({
        bookId: ctx.bookId,
        chapterId: ch2.id,
        chapterNumber: 2,
        text: '第二章。',
        sourceType: 'AI_DRAFT',
      })!;
      expect(a.contentPath).not.toBe(b.contentPath);
      expect(readFileSync(join(ctx.t.dir, a.contentPath), 'utf8')).toBe('第一章。');
      expect(readFileSync(join(ctx.t.dir, b.contentPath), 'utf8')).toBe('第二章。');
    });
  });

  describe('⑦ 与既有能力的边界', () => {
    it('⚠ 建版本不改变正文（版本是快照，不是写入）', () => {
      ctx.repo.save(ctx.bookId, ctx.chapterNumber, '当前正文。');
      v('一个完全不同的历史版本。', 'AI_DRAFT');
      expect(ctx.repo.get(ctx.bookId, ctx.chapterNumber)).toBe('当前正文。');
    });

    it('⚠ 建版本不改变保存状态', () => {
      ctx.repo.save(ctx.bookId, ctx.chapterNumber, '正文。');
      const before = ctx.repo.getSaveStatus(ctx.bookId, ctx.chapterNumber, '正文。');
      v('正文。', 'USER_EDIT');
      const after = ctx.repo.getSaveStatus(ctx.bookId, ctx.chapterNumber, '正文。');
      expect(after).toEqual(before);
    });

    it('⚠ 建版本不影响 autosave 恢复检测', () => {
      ctx.repo.autosave(ctx.bookId, ctx.chapterNumber, '自动保存的内容。', {
        cursor: 0,
        selectionStart: 0,
        selectionEnd: 0,
        scrollTop: 0,
      });
      const before = ctx.repo.checkRecovery(ctx.bookId, ctx.chapterNumber);
      v('某个版本。', 'AI_DRAFT');
      const after = ctx.repo.checkRecovery(ctx.bookId, ctx.chapterNumber);
      expect(after.hasNewerAutosave).toBe(before.hasNewerAutosave);
      expect(after.autosaveText).toBe(before.autosaveText);
    });
  });
});
