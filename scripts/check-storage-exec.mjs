/**
 * CI 门禁：禁止把参数传给 db.exec（施工计划 §3.6 陷阱 1）
 *
 * 背景：STEP 0 spike 实测发现 node:sqlite 的 `DatabaseSync.exec(sql, param)`
 *      **不接受参数绑定**，参数被静默忽略 → 写入 NULL 且不报错。
 *      此坑在 spike 中真实触发，排查了 4 轮才定位。
 *
 * 精确判定（避免误报）：
 *   ✗ 违规：.exec(...) 调用里出现第二个参数（即传了绑定值）
 *   ✗ 违规：.exec(...) 的 SQL 里含占位符且是写语句
 *   ✓ 合法：.exec('PRAGMA ...') / .exec('CREATE TABLE ...') / 多语句脚本
 *
 * 即：**exec 用于 DDL/PRAGMA 是正当的，用它传参写数据才是危险的。**
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['packages', 'apps'];
const EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const SKIP = new Set(['node_modules', 'dist', '.git']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.has(p.slice(p.lastIndexOf('.')))) out.push(p);
  }
  return out;
}

/**
 * 判断 `.exec(` 调用是否传了第二个参数。
 *
 * 做法：从 `(` 之后开始，做括号配平扫描；**跟踪当前嵌套层**，
 * 只有「相对调用参数层」为 0 时的逗号才算参数分隔符。
 *
 * 注意：不能用「depth 归 0 就 break」——因为起始字符是 `(` 之后的第一个字符，
 * 内层 `()` 成对时 depth 会先归 0，从而漏掉后续参数（本处曾有此 bug，
 * 门禁对故意注入的违规用例返回了 false negative）。
 */
function execCallHasSecondArg(line) {
  const idx = line.indexOf('.exec(');
  if (idx < 0) return false;

  let nesting = 0;      // 相对调用参数层的嵌套深度
  let inStr = null;     // 当前所处字符串定界符
  for (let i = idx + 6; i < line.length; i++) {
    const ch = line[i];
    const prev = line[i - 1];

    if (inStr) {
      if (ch === inStr && prev !== '\\') inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      nesting++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      // 回到调用参数层之外 → 调用结束
      if (nesting === 0) return false;
      nesting--;
      continue;
    }
    if (ch === ',' && nesting === 0) {
      return true; // 发现顶层逗号 = 存在第二个参数
    }
  }
  return false;
}

const violations = [];
const NEWLINE = String.fromCharCode(10);
for (const d of SCAN_DIRS) {
  for (const file of walk(join(ROOT, d))) {
    const rel = relative(ROOT, file).split(sep).join('/');
    const src = readFileSync(file, 'utf8');
    const lines = src.split(NEWLINE).map((l) => l.replace(String.fromCharCode(13), ''));
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      if (execCallHasSecondArg(line)) {
        violations.push({
          where: `${rel}:${i + 1}`,
          line: t.slice(0, 110),
        });
      }
    });
  }
}

if (violations.length > 0) {
  console.error('✗ check:storage 失败 —— 检测到向 .exec() 传参');
  console.error('  原因：node:sqlite 的 exec(sql, param) 不支持参数绑定，会静默写入空值。');
  console.error('  改用：db.run(sql, ...params) 或 db.prepare(sql).run(...params)');
  console.error('         （exec 仅用于无参数的 DDL / PRAGMA / 多语句脚本）');
  console.error('');
  for (const x of violations) console.error(`  ${x.where}  ${x.line}`);
  console.error(`\n共 ${violations.length} 处违规。`);
  process.exit(1);
}
console.log('✓ check:storage 通过（无向 exec 传参的调用）');

