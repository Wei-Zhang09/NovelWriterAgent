/**
 * 生产构建（资源拷贝 + 迁移 SQL）
 *
 * ## ⚠ 这里曾有一个"静默漏拷"的缺陷
 *
 * 原实现写死了三个文件名：
 * ```js
 * for (const f of ['index.html', 'style.css', 'renderer.js'])
 * ```
 * 于是 STEP 22 新增 `panels.js`（被 `renderer.js` 用 `import` 引用）后，
 * 构建**不报错**、产物里也没有这个文件 —— 渲染进程的 import 404，
 * **整个界面白屏**。
 *
 * 而失败现象是"tools=0 / 找不到表单"，看起来像渲染逻辑出错，
 * 排查方向会完全跑偏。
 *
 * 现在改为**拷贝 renderer 目录下的全部资源**（白名单排除 .map 之类），
 * 这样新增前端文件不需要记得改构建脚本 —— 依赖"记得改"的约定
 * 迟早会被漏掉。
 */
import { mkdirSync, copyFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const dist = join(appRoot, 'dist');
const srcRenderer = join(appRoot, 'src', 'renderer');

/** 需要拷贝的前端资源扩展名（其余如 .map/.ts 不拷） */
const ASSET_EXT = new Set(['.html', '.css', '.js', '.mjs', '.svg', '.png', '.ico', '.woff2']);

mkdirSync(join(dist, 'renderer'), { recursive: true });

let copied = 0;
for (const entry of readdirSync(srcRenderer)) {
  const src = join(srcRenderer, entry);
  if (!statSync(src).isFile()) continue; // 子目录（如有）暂不处理
  if (!ASSET_EXT.has(extname(entry))) continue;
  copyFileSync(src, join(dist, 'renderer', entry));
  copied++;
}
console.log(`[build] renderer 资源已拷贝：${copied} 个文件`);

const migDst = join(appRoot, '..', '..', 'packages', 'storage', 'dist', 'migrations');
const migSrc = join(appRoot, '..', '..', 'packages', 'storage', 'src', 'migrations');
if (existsSync(migSrc)) {
  mkdirSync(migDst, { recursive: true });
  const files = readdirSync(migSrc).filter((x) => x.endsWith('.sql'));
  for (const f of files) {
    copyFileSync(join(migSrc, f), join(migDst, f));
  }
  console.log(`[build] 迁移 SQL 已拷贝：${files.length} 个`);
}
console.log('[build] 完成');
