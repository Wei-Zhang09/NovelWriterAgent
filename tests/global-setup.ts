/**
 * 测试运行时临时目录清理（vitest globalSetup）。
 *
 * ## 为什么需要
 *
 * 测试用 `mkdtempSync(join(tmpdir(), 'nwa-xxx-'))` 建临时目录，
 * 但**从不删除** —— 实测 `%TEMP%` 下累积了 **14,175 个** `nwa-*` 条目
 * （`nwa-settings-*` 1880 个、`nwa-word-target-*` 824 个…）。
 *
 * 单次泄漏无害，但每跑一次测试就多几个，长期把用户临时目录塞满。
 * 之前没人发现，是因为**没有任何断言在看这件事** ——
 * 这是"验证脚本自己的副作用无人检查"的典型。
 *
 * ## 做法
 *
 * `vitest.config.ts` 在配置加载时建一个**运行级临时根目录**，并把
 * `TMPDIR/TMP/TEMP` 指过去（`test.env`）。于是**所有**测试里的
 * `tmpdir()` 都落在这个根目录下 —— 包括将来新写的测试，不用逐个改。
 *
 * 本文件只负责跑完**整棵删掉**。
 *
 * ⚠ 用运行级根目录而不是逐个改 31 个测试文件：逐个改既要动很多文件，
 *   又防不住新写的测试再漏。根目录方案是**按构造**覆盖的。
 */
import { rmSync } from 'node:fs';

export function teardown(): void {
  const root = process.env.NWA_TEST_TMP_ROOT;
  if (!root) return;
  // ⚠ 只删我们自己建的根目录，且路径必须带 nwa-testrun- 前缀 ——
  //   防止环境变量被误设成别的目录时把用户的东西删了。
  if (!root.includes('nwa-testrun-')) return;
  rmSync(root, { recursive: true, force: true });
}
