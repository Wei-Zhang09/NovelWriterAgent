import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 测试时把 @nwa/* 指向各包的 src（而非 dist）。
 *
 * 理由：测试应当验证**源码**，不应依赖构建产物 —— 否则「改了源码忘了 build」
 * 会得到假绿。同时 typecheck 由 tsc -b 单独把关。
 */
const alias = {
  '@nwa/core': join(here, 'packages/core/src/index.ts'),
  '@nwa/shared': join(here, 'packages/shared/src/index.ts'),
  '@nwa/storage': join(here, 'packages/storage/src/index.ts'),
  '@nwa/story': join(here, 'packages/story/src/index.ts'),
  '@nwa/retrieval': join(here, 'packages/retrieval/src/index.ts'),
  '@nwa/harness': join(here, 'packages/harness/src/index.ts'),
  '@nwa/writing': join(here, 'packages/writing/src/index.ts'),
  '@nwa/distillation': join(here, 'packages/distillation/src/index.ts'),
};

/**
 * ⚠ 运行级临时根目录 —— 所有测试的 `tmpdir()` 都落在它下面。
 *
 * 问题：测试用 `mkdtempSync(join(tmpdir(), 'nwa-xxx-'))` 建临时目录却
 * **从不删除**，实测 `%TEMP%` 下累积了 14,175 个 `nwa-*` 条目。
 *
 * 做法：把 TMPDIR/TMP/TEMP 指到一个本次运行专属的根目录，
 * 跑完整棵删掉（见 `tests/global-setup.ts`）。
 * 这样**将来新写的测试也自动被覆盖**，不必逐个文件改。
 *
 * ⚠ 在配置加载时创建（而非 globalSetup）：`test.env` 需要在 worker
 *   启动前就确定。
 */
const testTmpRoot = mkdtempSync(join(tmpdir(), 'nwa-testrun-'));
process.env.NWA_TEST_TMP_ROOT = testTmpRoot;

export default defineConfig({
  resolve: { alias },
  test: {
    // 契约一致性优先于新特性
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    // 研究报告 §1.2 决策 7：核心逻辑必须能在无 Electron 环境下测试
    globals: false,
    reporters: ['default'],
    globalSetup: ['./tests/global-setup.ts'],
    // 所有 worker 的临时目录都指向本次运行的根目录，跑完统一清理
    env: {
      TMPDIR: testTmpRoot,
      TMP: testTmpRoot,
      TEMP: testTmpRoot,
    },
  },
});
