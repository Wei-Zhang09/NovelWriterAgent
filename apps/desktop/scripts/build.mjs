/**
 * 生产构建（STEP 0 只做资源拷贝；electron-builder 打包在 STEP 22 引入）
 */
import { mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const dist = join(appRoot, 'dist');

mkdirSync(join(dist, 'renderer'), { recursive: true });
for (const f of ['index.html', 'style.css', 'renderer.js']) {
  copyFileSync(join(appRoot, 'src', 'renderer', f), join(dist, 'renderer', f));
}

const migDst = join(appRoot, '..', '..', 'packages', 'storage', 'dist', 'migrations');
const migSrc = join(appRoot, '..', '..', 'packages', 'storage', 'src', 'migrations');
if (existsSync(migSrc)) {
  mkdirSync(migDst, { recursive: true });
  for (const f of readdirSync(migSrc).filter((x) => x.endsWith('.sql'))) {
    copyFileSync(join(migSrc, f), join(migDst, f));
  }
}
console.log('[build] 完成');
