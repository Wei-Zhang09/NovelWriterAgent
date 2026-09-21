/**
 * Atomic Commit + Repair 测试（STEP 11【MVP 门槛】）
 *
 * 覆盖施工文档 §52 Test D 与 ADR-0002 的全部关键约束：
 *
 *   Test D：在 APPLY 阶段强制中断，重启后 Repair 必须给出**确定性判定**，
 *          且不丢已完成的 artifact。
 *
 *   kill 注入 4 个点全覆盖（施工计划明示的硬要求）：
 *     ① PREPARE 后
 *     ② APPLY 文件写完（rename 后）
 *     ③ APPLY DB 提交前
 *     ④ VERIFY 中
 *
 * 另验证 ADR-0002 的四条不可违反约束：
 *   - 路径必须 .next + rename（读者永不见半截文件）
 *   - Repair **只能删 manifest 列出的路径**，绝不扫目录
 *   - Repair 每步写 run_events
 *   - 不自动执行破坏性操作
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommitEngine, AtomicFileSet, CommitLock, RepairEngine, sha256, findAliases } from '@nwa/harness';
import type { KillSwitch } from '@nwa/harness';
import { Logger } from '@nwa/core';
import { createTestProject, makeChapter, type TestProject } from './helpers.js';

const logger = new Logger('test:commit', { level: 'error' });

let dir: string;
let t: TestProject | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nwa-commit-'));
});
afterEach(() => {
  // ⚠ 只让 proj.cleanup() 负责删目录：两边都删会在 Windows 上触发 EPERM
  //   （句柄竞争）。t 为 null 时才自己兜底清理。
  if (t) {
    t.cleanup();
    t = null;
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 起一个带章节的测试项目 */
function setup() {
  // ⚠ 必须把 proj 存到 t，让 afterEach 走 proj.cleanup()（先关 DB 再删目录）。
  //   否则 DB 句柄未关就删目录 → Windows 上 EPERM。
  const proj = createTestProject({ rootDir: dir });
  t = proj;
  const chapter = makeChapter(proj, 1);
  return { proj, chapter };
}

function engineOf(proj: TestProject, kill?: readonly KillSwitch['at'][number][]) {
  return new CommitEngine({
    db: proj.db,
    repos: proj.repos,
    rootDir: dir,
    logger,
    ...(kill ? { killSwitch: { at: kill } } : {}),
  });
}

const req = (chapterId: string) => ({
  chapterId,
  chapterNumber: 1,
  body: '张三推开门走了进来。\n他看了一眼窗外。',
  summary: '张三进城。',
});

const chapterFile = () => join(dir, 'chapters', '001.md');
const summaryFile = () => join(dir, 'summaries', '001.md');
const indexFile = () => join(dir, 'artifacts', 'index.json');

// ══════════════════════════════════════════════════════════
// 正常路径
// ══════════════════════════════════════════════════════════

describe('正常提交（PREPARE → APPLY → VERIFY）', () => {
  it('全绿：文件落盘、状态 COMMITTED、manifest COMMITTED', () => {
    const { proj, chapter } = setup();
    const r = engineOf(proj).commit(req(chapter.id));

    expect(r.ok).toBe(true);
    expect(r.status).toBe('COMMITTED');
    expect(r.phase).toBe('committed');
    expect(existsSync(chapterFile())).toBe(true);
    expect(readFileSync(chapterFile(), 'utf8')).toContain('张三推开门');
    expect(proj.repos.chapters.get(chapter.id).status).toBe('COMMITTED');
  });

  it('body_path 被正确写入（这是「正文已验证」的物理标记）', () => {
    const { proj, chapter } = setup();
    engineOf(proj).commit(req(chapter.id));
    expect(proj.repos.chapters.get(chapter.id).body_path).toBe('chapters/001.md');
  });

  it('摘要文件与 artifacts/index.json 一并写入', () => {
    const { proj, chapter } = setup();
    engineOf(proj).commit(req(chapter.id));
    expect(existsSync(summaryFile())).toBe(true);
    expect(existsSync(indexFile())).toBe(true);
  });

  it('提交后清理 .next / .previous 残留', () => {
    const { proj, chapter } = setup();
    engineOf(proj).commit(req(chapter.id));
    expect(existsSync(chapterFile() + '.next')).toBe(false);
    expect(existsSync(chapterFile() + '.previous')).toBe(false);
  });

  it('提交后释放锁（不留下 .commit.lock）', () => {
    const { proj, chapter } = setup();
    engineOf(proj).commit(req(chapter.id));
    expect(existsSync(join(dir, '.commit.lock'))).toBe(false);
  });

  it('applied_count 反映实际写入的产物数', () => {
    const { proj, chapter } = setup();
    const r = engineOf(proj).commit(req(chapter.id));
    expect(r.appliedCount).toBeGreaterThanOrEqual(3); // chapter + summary + index
  });
});

// ══════════════════════════════════════════════════════════
// §52 Test D —— MVP 门槛
// ══════════════════════════════════════════════════════════

describe('⚠ §52 Test D：4 个 kill 注入点全覆盖', () => {
  it('① PREPARE 后中断 → Repair 判定为「未开始 APPLY」→ 回滚', () => {
    const { proj, chapter } = setup();
    expect(() => engineOf(proj, ['after-prepare']).commit(req(chapter.id))).toThrow();

    const repair = engineOf(proj).recoverOnStartup();
    expect(repair.repaired).toHaveLength(1);
    expect(repair.repaired[0]!.branch).toBe('prepared-to-rollback');
    expect(repair.repaired[0]!.resultingStatus).toBe('ROLLED_BACK');

    // 确定性判定：文件没被写
    expect(existsSync(chapterFile())).toBe(false);
    expect(proj.repos.chapters.get(chapter.id).status).toBe('DRAFT_READY');
  });

  it('② APPLY 文件写完（rename 后）中断 → 回滚，不留孤儿文件', () => {
    const { proj, chapter } = setup();
    expect(() => engineOf(proj, ['after-file-apply']).commit(req(chapter.id))).toThrow();

    const repair = engineOf(proj).recoverOnStartup();
    expect(repair.repaired).toHaveLength(1);
    expect(repair.repaired[0]!.resultingStatus).toBe('ROLLED_BACK');

    // ⚠ 关键：不回状态就提交 = 孤儿章节文件
    expect(proj.repos.chapters.get(chapter.id).status).toBe('DRAFT_READY');
    expect(existsSync(chapterFile() + '.next')).toBe(false);
  });

  it('③ APPLY DB 提交前中断 → 回滚', () => {
    const { proj, chapter } = setup();
    expect(() => engineOf(proj, ['before-db-commit']).commit(req(chapter.id))).toThrow();

    const repair = engineOf(proj).recoverOnStartup();
    expect(repair.repaired).toHaveLength(1);

    const c = proj.repos.chapters.get(chapter.id);
    expect(c.status).toBe('DRAFT_READY');
    expect(c.body_path).toBeNull();
  });

  it('④ VERIFY 中中断 → manifest 为 APPLIED、DB 已提交 → 判定为已完成', () => {
    const { proj, chapter } = setup();
    expect(() => engineOf(proj, ['during-verify']).commit(req(chapter.id))).toThrow();

    // DB 事务 B 已提交，所以章节已是 COMMITTED
    expect(proj.repos.chapters.get(chapter.id).status).toBe('COMMITTED');

    const repair = engineOf(proj).recoverOnStartup();
    expect(repair.repaired).toHaveLength(1);
    expect(repair.repaired[0]!.branch).toBe('committing-to-verify');
    expect(repair.repaired[0]!.resultingStatus).toBe('COMMITTED');

    // 判定为已完成后，manifest 也该是 COMMITTED
    const m = proj.db.get<{ status: string }>(
      'SELECT status FROM commit_manifests WHERE chapter_id = ?',
      chapter.id,
    );
    expect(m!.status).toBe('COMMITTED');
  });

  it('⚠ 四个注入点都给出确定性判定（无 NEEDS_HUMAN、无未分类）', () => {
    const points: KillSwitch['at'][number][] = [
      'after-prepare',
      'after-file-apply',
      'before-db-commit',
      'during-verify',
    ];
    for (const p of points) {
      // 每个注入点用独立的项目，避免相互干扰
      const localDir = mkdtempSync(join(tmpdir(), `nwa-${p}-`));
      const proj = createTestProject({ rootDir: localDir });
      try {
        const chapter = makeChapter(proj, 1);
        const eng = new CommitEngine({
          db: proj.db,
          repos: proj.repos,
          rootDir: localDir,
          logger,
          killSwitch: { at: [p] },
        });
        expect(() => eng.commit({ ...req(chapter.id) })).toThrow();

        const repair = new RepairEngine({
          db: proj.db,
          repos: proj.repos,
          files: new AtomicFileSet(localDir),
          logger,
        }).repairAll();

        // ⚠ 确定性：必须分类到具体分支，且不需要人工介入
        expect(repair.scanned).toBe(1);
        expect(repair.needsHuman).toHaveLength(0);
        expect(repair.repaired).toHaveLength(1);
        expect(['ROLLED_BACK', 'COMMITTED']).toContain(repair.repaired[0]!.resultingStatus);
      } finally {
        proj.cleanup();
        rmSync(localDir, { recursive: true, force: true });
      }
    }
  });

  it('⚠ 中断后重试提交能成功（不因残留而卡死）', () => {
    const { proj, chapter } = setup();
    expect(() => engineOf(proj, ['after-file-apply']).commit(req(chapter.id))).toThrow();
    engineOf(proj).recoverOnStartup();

    // 第二次提交应当正常完成
    const r = engineOf(proj).commit(req(chapter.id));
    expect(r.ok).toBe(true);
    expect(proj.repos.chapters.get(chapter.id).status).toBe('COMMITTED');
  });

  it('已完成的事务不会被重复修复（幂等）', () => {
    const { proj, chapter } = setup();
    engineOf(proj).commit(req(chapter.id));

    const repair = engineOf(proj).recoverOnStartup();
    expect(repair.scanned).toBe(0); // COMMITTED 的不进扫描范围
    expect(repair.repaired).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════
// ADR-0002 关键约束
// ══════════════════════════════════════════════════════════

describe('⚠ 约束：Repair 只能删 manifest 列出的路径（绝不扫目录）', () => {
  it('用户手动放入 chapters/ 的文件在 Repair 后必须仍在', () => {
    const { proj, chapter } = setup();
    mkdirSync(join(dir, 'chapters'), { recursive: true });
    // 用户手工放的文件 —— 不在任何 manifest 里
    writeFileSync(join(dir, 'chapters', '999-手工笔记.md'), '这是我自己写的，别删', 'utf8');

    expect(() => engineOf(proj, ['after-file-apply']).commit(req(chapter.id))).toThrow();
    engineOf(proj).recoverOnStartup();

    // ⚠ 如果 Repair 扫目录，这个文件就会被当孤儿删掉
    expect(existsSync(join(dir, 'chapters', '999-手工笔记.md'))).toBe(true);
    expect(readFileSync(join(dir, 'chapters', '999-手工笔记.md'), 'utf8')).toBe('这是我自己写的，别删');
  });

  it('workspace/ 下的其他章节工作区不受影响', () => {
    const { proj, chapter } = setup();
    const otherWs = join(dir, 'workspace', 'chapter-002');
    mkdirSync(otherWs, { recursive: true });
    writeFileSync(join(otherWs, 'draft.md'), '第二章草稿', 'utf8');

    expect(() => engineOf(proj, ['after-prepare']).commit(req(chapter.id))).toThrow();
    engineOf(proj).recoverOnStartup();

    expect(readFileSync(join(otherWs, 'draft.md'), 'utf8')).toBe('第二章草稿');
  });
});

describe('⚠ 约束：文件写入经 .next + rename（读者永不见半截文件）', () => {
  it('提交过程中正式文件的内容要么是旧版、要么是完整新版', () => {
    const { proj, chapter } = setup();
    writeFileSync(chapterFile().replace(/chapters.*/, 'x'), '', 'utf8'); // 无关
    mkdirSync(join(dir, 'chapters'), { recursive: true });
    writeFileSync(chapterFile(), '旧内容', 'utf8');

    engineOf(proj).commit(req(chapter.id));
    // rename 是原子的：最终内容必须完整
    expect(readFileSync(chapterFile(), 'utf8')).toContain('张三推开门');
    expect(readFileSync(chapterFile(), 'utf8')).not.toBe('旧内容');
  });

  it('stage 会备份原文件为 .previous', () => {
    const files = new AtomicFileSet(dir);
    mkdirSync(join(dir, 'chapters'), { recursive: true });
    writeFileSync(join(dir, 'chapters', '001.md'), '旧内容', 'utf8');

    const r = files.stage({
      target: 'chapters/001.md',
      expectedSha256: sha256('旧内容'),
      content: '新内容',
    });

    expect(r.backupPath).toBe(join(dir, 'chapters', '001.md.previous'));
    expect(existsSync(r.stagedPath)).toBe(true);
    expect(readFileSync(r.backupPath!, 'utf8')).toBe('旧内容');
    // 正式文件尚未变（rename 还没发生）
    expect(readFileSync(join(dir, 'chapters', '001.md'), 'utf8')).toBe('旧内容');
  });
});

describe('⚠ 约束：CAS 冲突不得自动覆盖', () => {
  it('目标文件被外部修改 → 中止并报 COMMIT_CONFLICT', () => {
    const { proj, chapter } = setup();
    mkdirSync(join(dir, 'chapters'), { recursive: true });
    writeFileSync(chapterFile(), '外部修改前', 'utf8');

    const files = new AtomicFileSet(dir);
    // 模拟：PREPARE 时记录的哈希已过期（用户随后手工改了文件）
    expect(() =>
      files.stage({
        target: 'chapters/001.md',
        expectedSha256: sha256('PREPARE 时看到的内容'),
        content: 'Agent 想写的内容',
      }),
    ).toThrow(/CAS 冲突/);

    // ⚠ 用户的手工修改必须原封不动
    expect(readFileSync(chapterFile(), 'utf8')).toBe('外部修改前');
    void proj;
    void chapter;
  });

  it('冲突时保留现场，不写 .next（避免留下半成品）', () => {
    const files = new AtomicFileSet(dir);
    mkdirSync(join(dir, 'chapters'), { recursive: true });
    writeFileSync(join(dir, 'chapters', '001.md'), '现状', 'utf8');

    try {
      files.stage({
        target: 'chapters/001.md',
        expectedSha256: 'wrong',
        content: 'x',
      });
    } catch {
      /* expected */
    }
    expect(existsSync(join(dir, 'chapters', '001.md.next'))).toBe(false);
  });

  it('CAS 错误详情带 COMMIT_CONFLICT 码（供 UI 识别）', () => {
    const files = new AtomicFileSet(dir);
    mkdirSync(join(dir, 'chapters'), { recursive: true });
    writeFileSync(join(dir, 'chapters', '001.md'), 'a', 'utf8');
    try {
      files.stage({ target: 'chapters/001.md', expectedSha256: 'nope', content: 'b' });
      expect.unreachable();
    } catch (e) {
      expect((e as { details: { code: string } }).details.code).toBe('COMMIT_CONFLICT');
    }
  });
});

describe('⚠ 约束：硬链接别名检测', () => {
  it('检测到同一 inode 的两个路径 → 拒绝事务', () => {
    const files = new AtomicFileSet(dir);
    mkdirSync(join(dir, 'chapters'), { recursive: true });
    const a = join(dir, 'chapters', '001.md');
    writeFileSync(a, 'x', 'utf8');
    // 硬链接（Windows 上 NTFS 支持；不支持时跳过）
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { linkSync } = require('node:fs') as typeof import('node:fs');
      linkSync(a, join(dir, 'chapters', '002.md'));
    } catch {
      return; // 文件系统不支持硬链接 → 跳过该用例
    }

    expect(() => files.assertNoAliases(['chapters/001.md', 'chapters/002.md'])).toThrow(/硬链接别名/);
  });

  it('findAliases 对普通独立文件返回空', () => {
    mkdirSync(join(dir, 'chapters'), { recursive: true });
    writeFileSync(join(dir, 'chapters', '001.md'), 'a', 'utf8');
    writeFileSync(join(dir, 'chapters', '002.md'), 'b', 'utf8');
    expect(
      findAliases([join(dir, 'chapters', '001.md'), join(dir, 'chapters', '002.md')]),
    ).toEqual([]);
  });

  it('身份比较用稳定的 dev+ino 组合', () => {
    mkdirSync(join(dir, 'chapters'), { recursive: true });
    writeFileSync(join(dir, 'chapters', '001.md'), 'a', 'utf8');
    const st = statSync(join(dir, 'chapters', '001.md'));
    expect(Number.isFinite(Number(st.dev))).toBe(true);
    expect(Number.isFinite(Number(st.ino))).toBe(true);
  });
});

describe('⚠ 约束：路径不得逃逸项目目录', () => {
  it('stage 拒绝 ../ 之外的路径', () => {
    const files = new AtomicFileSet(dir);
    expect(() => files.stage({ target: '../../evil.md', expectedSha256: null, content: 'x' })).toThrow(
      /拒绝项目目录之外的路径/,
    );
  });

  it('绝对路径也会被拒（不能绕过 rootDir）', () => {
    const files = new AtomicFileSet(dir);
    // 绝对路径在 resolve 后会落在 rootDir 之外，必须被拒
    expect(() => files.stage({ target: 'C:/Windows/evil.md', expectedSha256: null, content: 'x' })).toThrow();
  });
});

// ══════════════════════════════════════════════════════════
// 排他锁
// ══════════════════════════════════════════════════════════

describe('排他锁（ADR-0002 v2 机制 ④）', () => {
  it('已有活跃锁时拒绝第二个提交', () => {
    const lock1 = new CommitLock({ rootDir: dir, staleAfterMs: 30_000, ownerId: 'A' });
    lock1.acquire();

    const lock2 = new CommitLock({ rootDir: dir, staleAfterMs: 30_000, ownerId: 'B' });
    expect(() => lock2.acquire()).toThrow(/已有提交正在进行/);
  });

  it('⚠ 陈旧锁被自动回收（不要求用户手删 —— InkOS 的教训）', () => {
    // 手写一个心跳很旧的锁
    const stale = {
      ownerId: 'DEAD_PROCESS',
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      pid: 999999,
    };
    writeFileSync(join(dir, '.commit.lock'), JSON.stringify(stale), 'utf8');

    const lock = new CommitLock({ rootDir: dir, staleAfterMs: 30_000, ownerId: 'B' });
    const r = lock.acquire();

    expect(r.ok).toBe(true);
    expect(r.reclaimed).toBeDefined();
    expect(r.reclaimed!.ownerId).toBe('DEAD_PROCESS');
  });

  it('损坏的锁文件按陈旧处理（不让项目卡死）', () => {
    writeFileSync(join(dir, '.commit.lock'), '{ 这不是 JSON', 'utf8');
    const lock = new CommitLock({ rootDir: dir, staleAfterMs: 30_000, ownerId: 'B' });
    expect(lock.acquire().ok).toBe(true);
  });

  it('释放后他人可以获取', () => {
    const a = new CommitLock({ rootDir: dir, staleAfterMs: 30_000, ownerId: 'A' });
    const ha = a.acquire().handle;
    ha.release();

    const b = new CommitLock({ rootDir: dir, staleAfterMs: 30_000, ownerId: 'B' });
    expect(b.acquire().ok).toBe(true);
  });

  it('⚠ 不删别人的锁（只释放自己的）', () => {
    const a = new CommitLock({ rootDir: dir, staleAfterMs: 30_000, ownerId: 'A' });
    const ha = a.acquire().handle;
    // B 越过锁（模拟陈旧回收后 A 又来释放）
    writeFileSync(
      join(dir, '.commit.lock'),
      JSON.stringify({ ownerId: 'B', heartbeatAt: new Date().toISOString(), acquiredAt: new Date().toISOString(), pid: 1 }),
      'utf8',
    );
    ha.release();
    // B 的锁必须还在
    expect(existsSync(join(dir, '.commit.lock'))).toBe(true);
  });

  it('续租会更新心跳时间', () => {
    const lock = new CommitLock({ rootDir: dir, staleAfterMs: 30_000, ownerId: 'A' });
    const h = lock.acquire().handle;
    const before = JSON.parse(readFileSync(join(dir, '.commit.lock'), 'utf8')) as { heartbeatAt: string };
    h.renew();
    const after = JSON.parse(readFileSync(join(dir, '.commit.lock'), 'utf8')) as { heartbeatAt: string };
    expect(Date.parse(after.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(before.heartbeatAt));
  });
});

// ══════════════════════════════════════════════════════════
// Repair 记录与幂等
// ══════════════════════════════════════════════════════════

describe('Repair 的可审计性（§55 Rule 8）', () => {
  it('修复动作写入 run_events', () => {
    const { proj, chapter } = setup();

    // ⚠ Run 必须在 Repair **之前**建好 —— 否则 Repair 时查不到 Run，
    //   事件退化为"只记日志"。这是上一版测试失败的原因（顺序写反了）。
    const runId = `run_${chapter.id}`;
    // runs 表的真实列：project_id / workflow_type / status / started_at
    proj.db.run(
      `INSERT INTO runs (id, project_id, workflow_type, status, started_at)
       VALUES (?, ?, 'system', 'RUNNING', ?)`,
      runId,
      proj.projectId,
      new Date().toISOString(),
    );

    expect(() => engineOf(proj, ['after-prepare']).commit(req(chapter.id))).toThrow();
    engineOf(proj).recoverOnStartup();

    // ⚠ 列名是 event_type（不是 type）
    const events = proj.db.all<{ event_type: string }>(
      "SELECT event_type FROM run_events WHERE event_type = 'COMMIT_REPAIRED'",
    );
    expect(events.length).toBeGreaterThan(0);
  });

  it('重复执行 Repair 不会重复处理已收尾的事务', () => {
    const { proj, chapter } = setup();
    expect(() => engineOf(proj, ['after-prepare']).commit(req(chapter.id))).toThrow();

    const first = engineOf(proj).recoverOnStartup();
    const second = engineOf(proj).recoverOnStartup();

    expect(first.repaired).toHaveLength(1);
    expect(second.repaired).toHaveLength(0); // 已是 ROLLED_BACK，不在扫描范围
  });

  it('manifest 损坏时拒绝自动修复（保留现场）', () => {
    const { proj, chapter } = setup();
    expect(() => engineOf(proj, ['after-prepare']).commit(req(chapter.id))).toThrow();

    // 破坏 artifact JSON
    proj.db.run(
      "UPDATE commit_manifests SET artifact_manifest_json = '{ 坏的' WHERE chapter_id = ?",
      chapter.id,
    );

    const repair = engineOf(proj).recoverOnStartup();
    expect(repair.needsHuman).toHaveLength(1);
    expect(repair.needsHuman[0]!.branch).toBe('manifest-unreadable');
    expect(repair.needsHuman[0]!.resultingStatus).toBe('NEEDS_HUMAN');
  });
});
