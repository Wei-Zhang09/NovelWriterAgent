import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
  },
});

