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
 *
 * ## ⚠ 第二次复发：子目录被静默跳过
 *
 * M7 把 Diff 放进 `renderer/manuscript/`（算法与渲染分离），
 * 而上面那句 `if (!statSync(src).isFile()) continue; // 子目录暂不处理`
 * 把整个子目录**静默丢掉** —— 渲染进程 import 404，
 * **整个界面白屏**，失败现象同样是"tools=0 / 找不到表单"。
 *
 * 所以改成**递归拷贝**：约定必须由代码保证，不能靠"记得别用子目录"。
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

let copied = 0;

/**
 * 递归拷贝（保持相对目录结构）。
 *
 * ⚠ 保持结构是必需的：`import './manuscript/diff-view.js'` 里的路径
 *   是相对于源文件的，把子目录文件拍平到 renderer/ 根下会让 import 404。
 */
function copyTree(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const src = join(srcDir, entry);
    if (statSync(src).isDirectory()) {
      copyTree(src, join(dstDir, entry));
      continue;
    }
    if (!ASSET_EXT.has(extname(entry))) continue;
    copyFileSync(src, join(dstDir, entry));
    copied++;
  }
}

copyTree(srcRenderer, join(dist, 'renderer'));
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
