/**
 * 项目目录契约测试（施工计划 §6.1）
 *
 * 这是**兼容性契约**测试：一旦有用户数据落盘，路径结构不得破坏性变更。
 * 因此这里逐个断言固定路径，任何改动都会让测试失败并强制走 ADR 流程。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scaffoldProjectDir,
  readProjectMeta,
  projectPaths,
  ensureChapterWorkspace,
  PROJECT_DIRS,
  PROJECT_META_FILE,
  WORKSPACE_FILES,
  now,
} from '@nwa/storage';
import { projectId, bookId } from '@nwa/core';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'nwa-layout-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

function meta() {
  return {
    id: projectId(),
    name: '契约测试',
    bookId: bookId(),
    title: '书',
    createdAt: now(),
    schemaVersion: '0001_init',
  };
}

describe('项目目录脚手架', () => {
  it('创建全部约定子目录', () => {
    const root = tmp();
    scaffoldProjectDir(root, meta());
    for (const d of Object.values(PROJECT_DIRS)) {
      expect(existsSync(join(root, d)), `缺少目录 ${d}`).toBe(true);
    }
    expect(existsSync(join(root, PROJECT_META_FILE))).toBe(true);
  });

  it('project.json 可读回且字段完整', () => {
    const root = tmp();
    const m = meta();
    scaffoldProjectDir(root, m);
    const read = readProjectMeta(root);
    expect(read.id).toBe(m.id);
    expect(read.bookId).toBe(m.bookId);
    expect(read.schemaVersion).toBe('0001_init');
  });

  it('⚠ 幂等：已存在的项目不覆盖 project.json（保住原始创建时间）', () => {
    const root = tmp();
    const first = meta();
    scaffoldProjectDir(root, first);
    const originalCreatedAt = readProjectMeta(root).createdAt;

    // 再次 scaffold，传入不同的元数据
    scaffoldProjectDir(root, { ...meta(), name: '不该生效的新名字' });
    const after = readProjectMeta(root);
    expect(after.createdAt).toBe(originalCreatedAt);
    expect(after.name).toBe('契约测试'); // 未被覆盖
  });

  it('已有项目时会补齐缺失的子目录', () => {
    const root = tmp();
    scaffoldProjectDir(root, meta());
    rmSync(join(root, PROJECT_DIRS.chapters), { recursive: true, force: true });
    expect(existsSync(join(root, PROJECT_DIRS.chapters))).toBe(false);
    scaffoldProjectDir(root, meta());
    expect(existsSync(join(root, PROJECT_DIRS.chapters))).toBe(true);
  });

  it('缺少 project.json 时 readProjectMeta 报 WORKSPACE_CORRUPTED', () => {
    const root = tmp();
    expect(() => readProjectMeta(root)).toThrow(/不是有效的项目目录/);
  });

  it('project.json 损坏时报错而非静默返回空', () => {
    const root = tmp();
    scaffoldProjectDir(root, meta());
    writeFileSync(join(root, PROJECT_META_FILE), '{坏 json', 'utf8');
    expect(() => readProjectMeta(root)).toThrow(/不是合法 JSON/);
  });
});

describe('路径辅助函数的固定形状', () => {
  it('章节 / 摘要 / 工作区路径符合契约', () => {
    const p = projectPaths('D:/demo/book');
    expect(p.chapter(1).replace(/\\/g, '/')).toMatch(/chapters\/001\.md$/);
    expect(p.chapter(31).replace(/\\/g, '/')).toMatch(/chapters\/031\.md$/);
    expect(p.summary(7).replace(/\\/g, '/')).toMatch(/summaries\/007\.md$/);
    expect(p.workspace(4).replace(/\\/g, '/')).toMatch(/workspace\/chapter-004$/);
  });

  it('工作区内 10 个中间产物文件路径固定', () => {
    const p = projectPaths('D:/demo/book');
    expect(WORKSPACE_FILES).toHaveLength(10);
    for (const f of WORKSPACE_FILES) {
      expect(p.workspaceFile(3, f).replace(/\\/g, '/')).toMatch(
        new RegExp(`workspace/chapter-003/${f.replace('.', '\\.')}$`),
      );
    }
  });

  it('WORKSPACE_FILES 的内容与施工文档 §9 一致', () => {
    expect([...WORKSPACE_FILES]).toEqual([
      'plan.json', 'context.json', 'scene-plan.json', 'draft.md', 'review.json',
      'revision.md', 'continuity.json', 'proposed_facts.json', 'proposed_state.json', 'run.json',
    ]);
  });
});

describe('章节工作区', () => {
  it('ensureChapterWorkspace 创建并返回目录，可重复调用', () => {
    const root = tmp();
    scaffoldProjectDir(root, meta());
    const d1 = ensureChapterWorkspace(root, 5);
    expect(existsSync(d1)).toBe(true);
    const d2 = ensureChapterWorkspace(root, 5);
    expect(d2).toBe(d1);
  });

  it('不同章节使用不同工作区（隔离性）', () => {
    const root = tmp();
    scaffoldProjectDir(root, meta());
    ensureChapterWorkspace(root, 1);
    ensureChapterWorkspace(root, 2);
    const ws = readdirSync(join(root, PROJECT_DIRS.workspace)).sort();
    expect(ws).toEqual(['chapter-001', 'chapter-002']);
  });

  it('⚠ 工作区与正式章节目录分离（未验证正文不得进 chapters/）', () => {
    const root = tmp();
    scaffoldProjectDir(root, meta());
    ensureChapterWorkspace(root, 1);
    writeFileSync(projectPaths(root).workspaceFile(1, 'draft.md'), '草稿内容', 'utf8');
    // 草稿存在于 workspace，但 chapters/ 仍为空
    expect(readdirSync(join(root, PROJECT_DIRS.chapters))).toHaveLength(0);
  });
});

describe('⚠ verify 脚本的隔离约定（源码级防回退）', () => {
  it('⚠ 所有 verify 脚本传给 project.open 的目录参数名必须被实现接受', () => {
    // 实测事故：`project.open` 只读 `params.dir`，而 8 个脚本传的是
    // `rootDir` —— 参数被**静默忽略**，脚本以为在临时目录跑，
    // 实际全部打开了用户真实项目目录并往里写测试数据。
    //
    // 这类缺陷靠"跑测试"发现不了（脚本一路显示通过）。
    // 因此在这里做**源码级**扫描：脚本里出现 project.open 时，
    // 必须用 `dir:`，或确认实现已支持该键名。
    const scriptsDir = join(process.cwd(), 'apps', 'desktop', 'scripts');
    const files = readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs'));
    const offenders: string[] = [];

    for (const f of files) {
      const text = readFileSync(join(scriptsDir, f), 'utf8');
      // 匹配 project.open({ ... }) 里用了 rootDir 的地方
      const calls = text.matchAll(/project\.open'\s*,\s*\{([^}]*)\}/g);
      for (const m of calls) {
        const args = m[1] ?? '';
        if (/\brootDir\b/.test(args) && !/\bdir\b/.test(args)) {
          offenders.push(`${f}: ${args.trim()}`);
        }
      }
    }

    // ⚠ 实现已接受 rootDir 作为别名（见 core-process 的 project.open），
    //   所以这里允许 rootDir；但**不允许**传了别名却不带 dir 的写法
    //   在实现被改回只认 dir 时静默失效 —— 故断言"要么用 dir，
    //   要么实现里同时接受两者"。
    const impl = readFileSync(
      join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'core-process.ts'),
      'utf8',
    );
    const implAcceptsAlias = /params\.rootDir/.test(impl);

    expect(
      offenders.length === 0 || implAcceptsAlias,
      `脚本用了 rootDir 但实现不接受该键名：\n${offenders.join('\n')}`,
    ).toBe(true);
  });
});
