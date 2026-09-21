/**
 * 把迁移 SQL 拷贝到 dist（构建步骤）
 *
 * ## 为什么必须有这一步
 *
 * `tsc -b` 只编译 .ts，**不会**拷贝 .sql。而 `loadMigrations()` 的探测顺序是
 * `dist/migrations` → `src/migrations`：
 *
 *   开发态（vitest 从 src 导入）→ 命中 src/migrations，一切正常
 *   构建后（Electron 从 dist 加载）→ dist/migrations 里的 SQL 是**旧的**，
 *                                   新迁移永远不会执行
 *
 * ⚠ 这个 bug 极其隐蔽：它不会报错，只会让构建产物**静默缺少新迁移**。
 *   本次是"补缺口"时通过核对 sqlite_master 的实际表数才发现的 ——
 *   单元测试全绿，因为测试走的是 src。
 *
 * 因此把拷贝固化成构建步骤，并**在拷贝后校验数量一致**（防止将来又漏）。
 */
import { readdirSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const srcDir = join(pkgRoot, 'src', 'migrations');
const distDir = join(pkgRoot, 'dist', 'migrations');

mkdirSync(distDir, { recursive: true });

const sqls = readdirSync(srcDir).filter((f) => f.endsWith('.sql'));
for (const f of sqls) {
  copyFileSync(join(srcDir, f), join(distDir, f));
}

// 校验：源与产物数量必须一致，否则构建失败（宁可失败也不要静默缺迁移）
const copied = existsSync(distDir) ? readdirSync(distDir).filter((f) => f.endsWith('.sql')) : [];
if (copied.length !== sqls.length) {
  console.error(
    `[copy-migrations] 失败：src 有 ${sqls.length} 个 .sql，dist 只有 ${copied.length} 个`,
  );
  process.exit(1);
}

console.log(`[copy-migrations] 已拷贝 ${copied.length} 个迁移到 dist/migrations`);
