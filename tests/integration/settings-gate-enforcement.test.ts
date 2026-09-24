/**
 * 设定门禁的**执行层**验证（P2-3）—— 门禁真的拦住了 plan/write。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, createRepositories, MIGRATIONS } from '@nwa/storage';
import { Logger, hashAfterConfirm } from '@nwa/core';
import { createWorkflowServices } from '../../apps/desktop/src/main/workflow-services.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'nwa-gate-probe-'));
  const db = new Database({ path: join(dir, 'p.db'), migrations: MIGRATIONS });
  const repos = createRepositories(db);
  const project = repos.projects.create({ id: 'prj1', name: 'P' });
  const book = repos.books.create({ id: 'bk1', projectId: project.id, title: '书' });
  const ch = repos.chapters.create({ id: 'ch1', bookId: book.id, chapterNumber: 1 });
  const services = createWorkflowServices({
    repos,
    db,
    dir,
    logger: new Logger('probe'),
    loadSkills: () => ({ rows: [], genre: null }),
  } as never);
  return { repos, book, ch, services };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'NO_ERROR';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

describe('P2-3 门禁反向验证', () => {
  it('未确认 → plan 必须被 SETTINGS_NOT_CONFIRMED 拦住', async () => {
    const { repos, book, ch, services } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '灵力枯竭' });
    expect(await codeOf(() => services.plan({ chapterId: ch.id }))).toBe(
      'SETTINGS_NOT_CONFIRMED',
    );
  });

  it('未确认 → write 也必须被拦', async () => {
    const { repos, book, ch, services } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '灵力枯竭' });
    expect(await codeOf(() => services.write({ chapterId: ch.id }))).toBe(
      'SETTINGS_NOT_CONFIRMED',
    );
  });

  it('确认后 → 门禁放行（报的是别的错，不再是 SETTINGS_NOT_CONFIRMED）', async () => {
    const { repos, book, ch, services } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '灵力枯竭' });
    repos.world.confirmAll(book.id);
    repos.books.confirmSettings(book.id, hashAfterConfirm(repos.world.snapshot(book.id)));
    expect(await codeOf(() => services.plan({ chapterId: ch.id }))).not.toBe(
      'SETTINGS_NOT_CONFIRMED',
    );
  });

  it('确认后又改设定 → 再次被拦', async () => {
    const { repos, book, ch, services } = setup();
    repos.world.create({ id: 'w1', bookId: book.id, type: 'WORLD_RULE', name: '灵力枯竭' });
    repos.world.confirmAll(book.id);
    repos.books.confirmSettings(book.id, hashAfterConfirm(repos.world.snapshot(book.id)));
    repos.world.update('w1', { description: '改成：施法不消耗寿命' });
    expect(await codeOf(() => services.plan({ chapterId: ch.id }))).toBe(
      'SETTINGS_NOT_CONFIRMED',
    );
  });

  it('没有设定 → 放行（允许直接开写的流程）', async () => {
    const { ch, services } = setup();
    expect(await codeOf(() => services.plan({ chapterId: ch.id }))).not.toBe(
      'SETTINGS_NOT_CONFIRMED',
    );
  });
});
