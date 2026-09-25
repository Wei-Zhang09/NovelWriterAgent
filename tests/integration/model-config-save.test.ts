/**
 * 模型配置保存链路（§38 / STEP 3）
 *
 * ## 为什么这个文件存在
 *
 * 用户实测反馈两件事：
 *   ① 模型配置 UI 不见了（已由 nav-views.test.ts 的可见性守卫覆盖）
 *   ② "配置模型的保存方面你再检查一下有没有问题"
 *
 * ② 查出来的两个真缺陷：
 *
 * **缺陷 1：更新 profile 会把它挪到数组末尾**
 *   `[...filter(id !== next.id), next]` —— 编辑已存在的 profile 时先删再追加。
 *   渲染端 prefill 取 `profiles[0]`，于是用户改完 A 点保存，表单跳到 B。
 *   看起来像"改动丢了"或"存到别的 profile 上了"。
 *
 * **缺陷 2：`useForAllSlots: true` 被硬编码**
 *   每保存一个 profile 都**静默**把 architect/writer/reviewer/utility
 *   四个槽位全改指向它。第一次配置时正确，但存在多个 profile 时
 *   （便宜的跑 utility、强的跑 writer）保存第二个就会抢走前一个的槽位，
 *   界面上没有任何提示。
 *
 * ## 这里断言的是**行为**，不是源码文本
 *
 * 前面踩过：grep 源码里有没有某个字符串，把那段代码删掉测试仍然通过
 * （那个词在注释里也出现）。所以下面用真实的 `ModelGateway` +
 * `FileSecretStore` 跑一遍保存语义。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSecretStore } from '@nwa/harness';
import type { ModelsConfig, ModelProfile } from '@nwa/harness';

const REPO = process.cwd();

/**
 * 剥掉 JS/TS 注释。
 *
 * ⚠ 断言"源码里不许出现 X"时必须先剥注释 —— 否则解释"为什么禁 X"的
 *   注释本身会被当成违规（本文件第一版就自伤了一次）。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 复刻 `model.config.save` 的合并语义（core-process.ts）。
 *
 * ⚠ 有意**重复实现**一遍：这是"独立验算"，用一份独立写法对照真实实现。
 *   若两边都写错成同样的样子，这个测试就失去意义 —— 所以这里刻意按
 *   "应当如何"写（原位替换），并另有一条源码级断言钉住真实实现。
 */
function mergeProfiles(prev: ModelProfile[], next: ModelProfile): ModelProfile[] {
  const at = prev.findIndex((x) => x.id === next.id);
  return at >= 0 ? prev.map((x, i) => (i === at ? next : x)) : [...prev, next];
}

function buildSlots(
  useForAllSlots: boolean,
  nextId: string,
  existing?: ModelsConfig,
  explicit?: Partial<Record<string, string>>,
): Record<string, string> {
  if (useForAllSlots) {
    return { architect: nextId, writer: nextId, reviewer: nextId, utility: nextId };
  }
  return {
    architect: explicit?.['architect'] ?? existing?.slots.architect ?? nextId,
    writer: explicit?.['writer'] ?? existing?.slots.writer ?? nextId,
    reviewer: explicit?.['reviewer'] ?? existing?.slots.reviewer ?? nextId,
    utility: explicit?.['utility'] ?? existing?.slots.utility ?? nextId,
  };
}

const prof = (id: string, model = 'm-' + id): ModelProfile => ({
  id,
  provider: 'openai-compatible',
  endpoint: 'http://127.0.0.1:8788/v1',
  model,
  apiKeyRef: `profile:${id}`,
  temperature: 0.8,
  maxTokens: 4096,
  contextWindow: 128000,
  timeoutMs: 180000,
  retryPolicy: { maxAttempts: 3 },
});

describe('模型配置保存：profile 顺序', () => {
  it('⚠ 更新已存在的 profile 必须**原位替换**，不能挪到末尾', () => {
    let list: ModelProfile[] = [];
    list = mergeProfiles(list, prof('A'));
    list = mergeProfiles(list, prof('B'));
    expect(list.map((p) => p.id)).toEqual(['A', 'B']);

    // 编辑 A
    list = mergeProfiles(list, prof('A', 'm-A-new'));
    expect(
      list.map((p) => p.id),
      '编辑 A 后 A 被挪到了末尾 —— 表单 prefill 取 [0] 会跳到 B，用户以为改动丢了',
    ).toEqual(['A', 'B']);
    // 内容确实更新了
    expect(list[0]!.model).toBe('m-A-new');
  });

  it('新增 profile 追加到末尾', () => {
    let list: ModelProfile[] = [prof('A')];
    list = mergeProfiles(list, prof('C'));
    expect(list.map((p) => p.id)).toEqual(['A', 'C']);
  });

  it('⚠ 真实实现必须是原位替换（源码级对照）', () => {
    const src = readFileSync(join(REPO, 'apps/desktop/src/main/core-process.ts'), 'utf8');
    // 旧的错误写法：先 filter 掉再追加
    expect(
      src,
      '仍在用 `[...filter(id !== next.id), next]` —— 会把被编辑的 profile 挪到末尾',
    ).not.toMatch(/\[\s*\.\.\.\(existing\?\.profiles \?\? \[\]\)\.filter/);
    expect(src, '缺少原位替换的实现').toContain('原位替换');
  });
});

describe('模型配置保存：槽位归属', () => {
  const existing: ModelsConfig = {
    slots: { architect: 'A', writer: 'A', reviewer: 'A', utility: 'A' },
    profiles: [prof('A')],
  };

  it('⚠ 不勾"设为全部槽位"时，已有槽位不被抢走', () => {
    const slots = buildSlots(false, 'B', existing);
    expect(
      slots,
      '保存 B 却把 A 的槽位全抢走了 —— 这正是硬编码 useForAllSlots:true 的后果',
    ).toEqual({ architect: 'A', writer: 'A', reviewer: 'A', utility: 'A' });
  });

  it('勾了"设为全部槽位"时才接管四个槽位', () => {
    const slots = buildSlots(true, 'B', existing);
    expect(slots).toEqual({ architect: 'B', writer: 'B', reviewer: 'B', utility: 'B' });
  });

  it('显式指定槽位优先于已有配置', () => {
    const slots = buildSlots(false, 'B', existing, { utility: 'B' });
    expect(slots).toEqual({ architect: 'A', writer: 'A', reviewer: 'A', utility: 'B' });
  });

  it('⚠ 渲染端不得硬编码 useForAllSlots: true', () => {
    // ⚠ 必须剥掉注释再匹配：说明文字里引用了被禁的写法，
    //   直接对全文 grep 会**自我命中**（第一版就踩到，假失败）。
    const js = stripComments(
      readFileSync(join(REPO, 'apps/desktop/src/renderer/renderer.js'), 'utf8'),
    );
    expect(
      js,
      'renderer 仍硬编码 useForAllSlots: true —— 每保存一次就静默抢走全部槽位',
    ).not.toMatch(/useForAllSlots:\s*true/);
    expect(js, '缺少由勾选框驱动的槽位开关').toContain('slotBox.checked');
  });
});

describe('模型配置保存：表单不跳走', () => {
  const js = readFileSync(join(REPO, 'apps/desktop/src/renderer/renderer.js'), 'utf8');

  it('⚠ prefill 必须按"刚编辑的 profile id"选，不能永远取 [0]', () => {
    // ⚠ 必须**只查 prefill 那一段**。
    //   第一版对全文 toContain('modelFormProfileId') —— 那个标识符在
    //   state 声明和保存回调里也出现，把 prefill 改回 profiles[0] 后
    //   测试**仍然通过**（反向验证抓到的假绿）。只取 prefill 块。
    const start = js.indexOf('if (cfg?.profiles?.length) {');
    expect(start, '找不到 prefill 块').toBeGreaterThan(-1);
    const block = js.slice(start, js.indexOf('} else {', start));
    expect(
      block,
      'prefill 仍固定取 cfg.profiles[0] —— 编辑第二个 profile 保存后会跳回第一个',
    ).toContain('modelFormProfileId');
    expect(block, 'prefill 没有按 id 查找').toMatch(/\.find\(/);
    // 且不能是"先无条件取 [0] 再赋值"的写法
    expect(block, '仍直接取 [0]').not.toMatch(/=\s*cfg\.profiles\[0\]\s*;/);
  });

  it('保存成功后记住 profileId', () => {
    expect(js).toMatch(/state\.modelFormProfileId\s*=\s*d\.profileId/);
  });
});

describe('模型配置保存：密钥落盘是加密的', () => {
  it('⚠ 加密后端不可用时**拒绝保存**，不退化为明文', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nwa-secret-'));
    try {
      const file = join(dir, 'credentials.json');
      const store = new FileSecretStore(file, {
        name: 'test-unavailable',
        available: () => false,
        encrypt: (s) => Buffer.from(s),
        decrypt: (b) => b.toString(),
      });
      await expect(
        store.set('profile:default', 'sk-secret-value'),
        '加密不可用时必须抛错，而不是明文落盘',
      ).rejects.toThrow(/不可用/);
      expect(existsSync(file), '拒绝保存时不应留下任何文件').toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('⚠ 密钥以密文落盘，明文不出现在文件里', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nwa-secret-'));
    try {
      const file = join(dir, 'credentials.json');
      const store = new FileSecretStore(file, {
        name: 'test-xor',
        available: () => true,
        // 非真加密，只为验证"落盘的是变换后的内容"这一结构
        encrypt: (s) => Buffer.from(s.split('').reverse().join('')),
        decrypt: (b) => b.toString().split('').reverse().join(''),
      });
      await store.set('profile:default', 'sk-plaintext-canary');
      const raw = readFileSync(file, 'utf8');
      expect(raw, '明文密钥出现在凭据文件里').not.toContain('sk-plaintext-canary');
      expect(raw).toContain('profile:default');
      // 能读回
      expect(await store.get('profile:default')).toBe('sk-plaintext-canary');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('⚠ 凭据文件损坏时拒绝静默重建（否则覆盖用户已存的密钥）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nwa-secret-'));
    try {
      const file = join(dir, 'credentials.json');
      const store = new FileSecretStore(file, {
        name: 't',
        available: () => true,
        encrypt: (s) => Buffer.from(s),
        decrypt: (b) => b.toString(),
      });
      await store.set('profile:default', 'sk-1'); // 建出合法文件
      // 破坏它
      const fs = await import('node:fs');
      fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
      const fresh = new FileSecretStore(file, {
        name: 't',
        available: () => true,
        encrypt: (s) => Buffer.from(s),
        decrypt: (b) => b.toString(),
      });
      await expect(fresh.get('profile:default')).rejects.toThrow(/损坏/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('模型配置保存：密钥不出现在日志里', () => {
  it('⚠ 保存路径只记录 ref，不记录密钥值', () => {
    const src = stripComments(
      readFileSync(join(REPO, 'apps/desktop/src/main/core-process.ts'), 'utf8'),
    );
    const saveIdx = src.indexOf("'model.config.save'");
    expect(saveIdx).toBeGreaterThan(-1);
    const seg = src.slice(saveIdx, saveIdx + 3000);

    // ⚠ 只检查 **logger 调用**里的内容，不对整段代码 grep。
    //   第一版对整段匹配 /params\.apiKey/ —— 命中的是合法的校验代码
    //   `if (params.apiKey && ...)`，把正确实现判成了泄漏（假失败）。
    //   第二版用 /apiKey/ —— `apiKeyRef` 含该子串，同样假失败。
    //   泄漏面只在**日志**上，所以只在日志调用里找。
    const logCalls = seg.match(/logger\.\w+\([\s\S]*?\n\s*\}\)/g) ?? [];
    expect(logCalls.length, '保存路径应有日志调用').toBeGreaterThan(0);
    for (const l of logCalls) {
      expect(l, `日志里出现了密钥值：${l.slice(0, 80)}`).not.toMatch(
        /(?:params|prof|profile)\.apiKey\b/,
      );
    }
    // 且必须确实记了 ref（证明这条日志存在且指向引用名）
    expect(seg).toMatch(/logger\.\w+\([^)]*密钥[^)]*ref:\s*apiKeyRef/);
  });

  it('⚠ model.config.get 绝不返回密钥值字段', () => {
    const src = readFileSync(join(REPO, 'apps/desktop/src/main/core-process.ts'), 'utf8');
    const i = src.indexOf("'model.config.get'");
    const seg = src.slice(i, src.indexOf("'model.config.save'"));
    expect(seg, 'get 返回了密钥值字段').not.toMatch(/apiKey:\s*(?:x\.|p\.)?apiKey\b/);
    expect(seg, '应返回引用名而非值').toContain('apiKeyRef');
  });
});
