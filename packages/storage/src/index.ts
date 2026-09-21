/**
 * @nwa/storage —— SQLite 访问层
 *
 * ⚠ 所有数据库访问必须经由此包。其他包不得直接 require('node:sqlite')。
 *   `scripts/check-storage-exec.mjs` 会在 CI 中强制这一点。
 */
export { Database } from './database.js';
export type { DatabaseOptions, Migration } from './database.js';
export { MIGRATIONS } from './migrations/index.js';
