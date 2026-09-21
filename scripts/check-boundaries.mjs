/**
 * CI 门禁：架构边界（施工计划 §3.5b）
 *
 * 「架构约束只有在 CI 会失败时才是真的约束。」—— DeepWrite AGENTS.md
 *
 * 规则：
 *   R1  packages/* 不得依赖 electron
 *   R2  非 storage 包不得直接 require('node:sqlite')
 *   R3  core 不得依赖任何其他 @nwa/* 包（保持零依赖基础层）
 *   R4  distillation 不得被 MVP 包依赖（NDE 硬门槛）
 *   R5  core/shared 不得依赖 storage/harness/writing（分层方向）
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const violations = [];
const v = (rule, msg) => violations.push(`[${rule}] ${msg}`);

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function listPackages() {
  const base = join(ROOT, 'packages');
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((d) => ({ dir: d, path: join(base, d) }))
    .filter((p) => statSync(p.path).isDirectory());
}

const pkgs = listPackages();
const pkgNames = new Map();
for (const p of pkgs) {
  const j = readJson(join(p.path, 'package.json'));
  if (j) pkgNames.set(p.dir, { name: j.name, deps: Object.keys(j.dependencies ?? {}) });
}

const CORE_ONLY = new Set(['core']);          // R3
const LEAF_OK = new Set(['core', 'shared']);  // R5：不得依赖更上层的包

for (const [dir, info] of pkgNames) {
  for (const dep of info.deps) {
    // R1
    if (dep === 'electron') v('R1', `packages/${dir} 依赖 electron（packages 层禁止依赖桌面框架）`);
    // R3
    if (CORE_ONLY.has(dir) && dep.startsWith('@nwa/')) {
      v('R3', `packages/core 依赖 ${dep}（core 必须保持零 @nwa 依赖）`);
    }
    // R5
    if (LEAF_OK.has(dir) && ['@nwa/storage', '@nwa/harness', '@nwa/writing', '@nwa/retrieval', '@nwa/story'].includes(dep)) {
      v('R5', `packages/${dir} 依赖 ${dep}（分层方向错误：\`${dir}\` 属底层，不得依赖上层包）`);
    }
    // R4
    if (dep === '@nwa/distillation' && dir !== 'distillation') {
      v('R4', `packages/${dir} 依赖 distillation（NDE 在 STEP 11 通过前不得被依赖）`);
    }
  }
}

// R2：全仓扫描直接 require('node:sqlite')
const SKIP = new Set(['node_modules', 'dist', '.git', 'research']);
const EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.has(p.slice(p.lastIndexOf('.')))) out.push(p);
  }
  return out;
}
for (const file of walk(join(ROOT, 'packages'))) {
  const rel = relative(ROOT, file).split(sep).join('/');
  if (rel.startsWith('packages/storage/')) continue;
  const src = readFileSync(file, 'utf8');
  if (/from\s+['"]node:sqlite['"]|require\(\s*['"]node:sqlite['"]\s*\)/.test(src)) {
    v('R2', `${rel} 直接引用 node:sqlite（只允许 packages/storage）`);
  }
}

if (violations.length > 0) {
  console.error('✗ check:boundary 失败');
  for (const x of violations) console.error('  ' + x);
  process.exit(1);
}
console.log('✓ check:boundary 通过（R1-R5 全部合规）');
