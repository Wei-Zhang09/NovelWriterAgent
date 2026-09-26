/**
 * CI 门禁：验证脚本覆盖度
 *
 * 「一个从没被跑过的验证脚本，等于没有验证。」
 *
 * ## 这个门禁要防的缺陷
 *
 * `pnpm verify:all` 是「一键验收」入口，但它只串了 5 个脚本，而仓库里有 27 个。
 * 实测踩到：`verify:manuscript-editor` 在 M6/M7 加相对导入后整跑崩溃（exit 1），
 * 却因为不在 `verify:all` 里，**连续四个里程碑没人发现** —— 一条断言都没跑，
 * 而所有里程碑的验收报告都写着"验证通过"。
 *
 * `verify:simulate` 更直接：`CommitEngine` 要求 `bookId` 后它整跑失败（0/1），
 * 而它**在** `verify:all` 里，才被这轮排查抓到。
 *
 * 结论：脚本"存在"不等于"在跑"。每个脚本必须**显式归类**，新增脚本若不归类
 * 直接失败 —— 让遗漏在 CI 暴露，而不是等到某次人工排查。
 *
 * ## 归类（三者必居其一）
 *
 *   aggregate   在 `verify:all` 的串联里（每次验收都跑）
 *   standalone  可离线单跑，但需要自己的 setup（真 Electron、独立目录）
 *   needs-model 必须真实模型，故不进默认串联
 *
 * `standalone` / `needs-model` 的理由必须写在脚本头部注释里，格式：
 *   `@verify-kind: <kind> — <理由>`
 * 门禁会核对注释与归类表一致，防止"改了归类忘了改理由"。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const violations = [];
const v = (msg) => violations.push(msg);

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const scripts = pkg.scripts ?? {};
const aggregateChain = scripts['verify:all'] ?? '';

/**
 * 归类表。
 *
 * ⚠ 新增 verify:* 脚本必须在这里出现，否则门禁失败（这是本门禁的主要作用）。
 * ⚠ `standalone` / `needs-model` 的理由要与脚本头部的 `@verify-kind` 注释一致。
 */
const CLASSIFY = {
  // ── 已串在 verify:all 里 ──────────────────────────────
  'verify:smoke': 'aggregate',
  'verify:gui': 'aggregate',
  'verify:flow': 'aggregate',
  'verify:model': 'aggregate',
  'verify:simulate': 'aggregate',
  'verify:standalone': 'aggregate',

  // ── 可离线单跑，但需要自己的 setup（真 Electron / 独立目录）──
  'verify:manuscript-editor': 'standalone',
  'verify:autosave-scheduler': 'standalone',
  'verify:workflow-panel': 'standalone',
  'verify:corpus': 'standalone',
  'verify:corpus-import': 'standalone',
  'verify:multibook': 'standalone',
  'verify:endpoint': 'standalone',
  'verify:backup': 'standalone',
  'verify:prune': 'standalone',

  // ── 必须真实模型 ─────────────────────────────────────
  'verify:writing': 'needs-model',
  'verify:plan': 'needs-model',
  'verify:annotate': 'needs-model',
  'verify:persist': 'needs-model',
  'verify:mine': 'needs-model',
  'verify:skill': 'needs-model',
  'verify:skill-runtime': 'needs-model',
  'verify:skill-writer': 'needs-model',
  'verify:workflow': 'needs-model',
  'verify:retrieval': 'needs-model',
  'verify:state': 'needs-model',
  'verify:timeline': 'needs-model',
  'verify:summary-gate': 'needs-model',
  'verify:books': 'needs-model',
  'verify:chain': 'needs-model',
  'verify:deslop-calib': 'needs-model',
};

const ALLOWED_KINDS = new Set(['aggregate', 'standalone', 'needs-model']);

// ── 规则 1：每个 verify:* 脚本都必须归类 ──────────────────
const verifyKeys = Object.keys(scripts).filter(
  (k) => k.startsWith('verify:') && k !== 'verify:all',
);

for (const key of verifyKeys) {
  if (!(key in CLASSIFY)) {
    v(
      `[未归类] ${key} 不在 check-verify-coverage.mjs 的 CLASSIFY 表里。` +
        `未归类的脚本不会被任何验收跑到 —— 要么串进 verify:all，` +
        `要么标 standalone/needs-model 并写明理由。`,
    );
  }
}

// ── 规则 2：归类表里不能有已删除的脚本（防表与仓库漂移）──
for (const key of Object.keys(CLASSIFY)) {
  if (!(key in scripts)) {
    v(`[已失效] 归类表里的 ${key} 已不在 package.json 中，请删除该条目。`);
  }
  if (!ALLOWED_KINDS.has(CLASSIFY[key])) {
    v(`[非法归类] ${key} 的归类 "${CLASSIFY[key]}" 不在允许集合内。`);
  }
}

// ── 规则 3：标 aggregate 的必须真在 verify:all 串联里 ─────
for (const [key, kind] of Object.entries(CLASSIFY)) {
  if (kind !== 'aggregate') continue;
  // verify:all 里以 `pnpm <key>` 形式出现
  if (!aggregateChain.includes(`pnpm ${key}`)) {
    v(
      `[假聚合] ${key} 标为 aggregate，但 verify:all 里没有 "pnpm ${key}"。` +
        `标 aggregate 却不跑 = 比不归类更危险（看起来覆盖了）。`,
    );
  }
}

// ── 规则 4：非 aggregate 的脚本头部必须有 @verify-kind 注释且与表一致 ──
function scriptFile(key) {
  const cmd = scripts[key] ?? '';
  // 从命令里取脚本相对路径（形如 `node scripts/x.mjs` 或 `electron apps/.../x.mjs`）
  const m = cmd.match(/([\w./-]+\.(?:mjs|ts|js))/);
  return m ? m[1] : null;
}

for (const [key, kind] of Object.entries(CLASSIFY)) {
  if (kind === 'aggregate') continue;
  const rel = scriptFile(key);
  if (!rel) {
    v(`[无法定位] ${key} 的命令里找不到脚本文件：${scripts[key]}`);
    continue;
  }
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    v(`[文件缺失] ${key} 指向的脚本不存在：${rel}`);
    continue;
  }
  const head = readFileSync(abs, 'utf8').split('\n').slice(0, 60).join('\n');
  const tag = head.match(/@verify-kind:\s*([a-z-]+)/);
  if (!tag) {
    v(
      `[缺理由] ${rel} 没有 "@verify-kind: <kind> — <理由>" 注释。` +
        `不写理由的排除项，下一个人无法判断它是否还该被排除。`,
    );
  } else if (tag[1] !== kind) {
    v(`[不一致] ${rel} 注释写 @verify-kind: ${tag[1]}，归类表写 ${kind}。`);
  }
}

// ── 规则 5：串在 verify:all 里的每个 pnpm 调用都得有对应脚本 ──
for (const m of aggregateChain.matchAll(/pnpm (verify:[\w-]+)/g)) {
  const key = m[1];
  if (!(key in scripts)) {
    v(`[断链] verify:all 调用了不存在的 ${key}。`);
  }
}

// ── 输出 ─────────────────────────────────────────────────
const counts = { aggregate: 0, standalone: 0, 'needs-model': 0 };
for (const k of verifyKeys) {
  const kind = CLASSIFY[k];
  if (kind in counts) counts[kind] += 1;
}

console.log('验证脚本覆盖度检查');
console.log('─'.repeat(52));
console.log(`  总计 ${verifyKeys.length} 个 verify:* 脚本`);
console.log(`    aggregate   ${counts.aggregate}  （verify:all 每次跑）`);
console.log(`    standalone  ${counts.standalone}  （可离线单跑）`);
console.log(`    needs-model ${counts['needs-model']}  （需真实模型）`);
console.log('─'.repeat(52));

if (violations.length > 0) {
  console.log(`\n✗ ${violations.length} 项问题：\n`);
  for (const msg of violations) console.log(`  - ${msg}`);
  process.exit(1);
}
console.log('✓ 全部 verify:* 脚本均已归类，且归类与实现一致');
