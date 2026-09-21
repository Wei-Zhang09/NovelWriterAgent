/**
 * 迁移注册表。
 *
 * 约定：迁移只增不改。已完成迁移的 id 一旦发布即冻结，
 * 修改已发布迁移会导致老项目无法升级。
 *
 * SQL 以文件形式放在同目录，运行时读取（而非打包内联）：
 * 理由 —— 迁移 SQL 需要能被人工审阅与 diff，内联进 JS 会失去这一性质。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Migration } from '../database.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 读取全部迁移文件，按文件名排序（文件名的数字前缀即执行顺序）。
 *
 * 探测两个位置：`src/migrations`（开发态）与 `dist/migrations`（构建后）。
 */
function loadMigrations(): Migration[] {
  const candidates = [join(here, 'migrations'), here];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    return files.sort().map((f) => ({
      id: f.replace(/\.sql$/, ''),
      sql: readFileSync(join(dir, f), 'utf8'),
    }));
  }
  return [];
}

export const MIGRATIONS: readonly Migration[] = loadMigrations();
