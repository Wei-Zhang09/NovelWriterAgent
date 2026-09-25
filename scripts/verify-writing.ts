/**
 * 端到端真实写作验证（需要一个真实的 LLM）
 *
 *   NWA_API_KEY=sk-xxx pnpm verify:writing -- --model=deepseek-chat --chapters=3
 *
 * ## 与 verify:simulate 的分工
 *
 *   verify:simulate —— "提交流程在批量下会不会丢数据"（fixture，不调模型）
 *   本脚本          —— **"写出来的东西能不能看"**（真调模型，走完整链路）
 *
 * 因此检查的不是"没崩"，而是：
 *   - 上下文是否带上了长程记忆（检索是否真的生效）
 *   - 计划是否落实（场景数、目的、钩子）
 *   - 正文是否有实质内容（字数 + 字符去重率，用于发现复读/空转）
 *   - 审稿是否真的在判断（而非空过）
 *   - 全链路产物齐备且可提交
 *
 * ## ⚠ 密钥
 *
 * 从 `NWA_API_KEY` 或 `~/.config/novelwriter-agent/credentials.json` 读，
 * **绝不打印**。都没有则明确失败并说明配置方式 —— 不静默降级为 fixture
 * （那会让"真实写作验证"变成假的）。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { Logger } from '@nwa/core';
import { Database, FtsIndex, createRepositories, MIGRATIONS } from '@nwa/storage';
import { bigramTokenizer, Retriever, buildMatchExpression } from '@nwa/retrieval';
import { ContextEngine, MemoryGatherer, ModelGateway, SummaryIndexer } from '@nwa/harness';
import type { ModelProfile, SecretStore, SlotName } from '@nwa/harness';
import { Planner, Writer, Reviewer } from '@nwa/writing';
import { ChapterWorkspace, ContinuityChecker } from '@nwa/story';
import { CommitEngine } from '@nwa/harness';
import type { PlanOutput, ReviewIssue } from '@nwa/shared';

const logger = new Logger('writing', { level: 'warn' });

// ── 参数 ────────────────────────────────────────────────────
function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const model = arg('model', 'deepseek-chat');
const baseUrl = arg('endpoint', 'https://api.deepseek.com/v1');
const chapters = Number(arg('chapters', '3'));
const outDirArg = arg('out', '');

// ── 密钥（绝不打印） ────────────────────────────────────────
function loadApiKey(): { key: string; source: string } {
  const env = process.env['NWA_API_KEY'];
  if (env && env.trim().length > 0) return { key: env.trim(), source: '环境变量 NWA_API_KEY' };

  const file = join(homedir(), '.config', 'novelwriter-agent', 'credentials.json');
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      for (const k of ['apiKey', 'api_key', 'key', 'default']) {
        const v = raw[k];
        if (typeof v === 'string' && v.trim().length > 0) return { key: v.trim(), source: `${file}（键 ${k}）` };
      }
    } catch (e) {
      console.error(`凭据文件解析失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { key: '', source: '' };
}

const cred = loadApiKey();
if (cred.key.length === 0) {
  console.error(`
未找到 API 密钥 —— 无法进行真实写作验证。

配置方式（任选其一）：
  1) 桌面端「模型设置」里填入并保存（加密落到
     ~/.config/novelwriter-agent/credentials.json）
  2) 临时环境变量：  NWA_API_KEY=sk-xxx pnpm verify:writing

⚠ 密钥不会出现在本脚本的任何输出里。
`);
  process.exit(2);
}
console.log(`密钥来源：${cred.source}（值不打印）`);

// ── 内存密钥存储（仅本次进程有效，不落盘） ──────────────────
function memSecrets(key: string): SecretStore {
  const M = new Map<string, string>([['default', key]]);
  return {
    backend: 'memory',
    get: async (ref) => M.get(ref),
    set: async (ref, v) => void M.set(ref, v),
    delete: async (ref) => void M.delete(ref),
  };
}

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name} — ${detail}`);
}

const outDir = outDirArg.length > 0 ? outDirArg : mkdtempSync(join(tmpdir(), 'nwa-writing-'));
mkdirSync(outDir, { recursive: true });
console.log(`\n项目目录：${outDir}`);
console.log(`模型：${model} @ ${baseUrl}，章数：${chapters}\n`);

let db: Database | null = null;

async function main(): Promise<void> {
try {
  db = new Database({ path: join(outDir, 'project.db'), migrations: MIGRATIONS });
  const repos = createRepositories(db);
  const projectId = 'proj_writing';
  const bookId = 'book_writing';
  repos.projects.create({ id: projectId, name: '写作验证项目', genre: 'urban_fantasy' });
  repos.books.create({ id: bookId, projectId, title: '夜行记' });
  repos.characters.create({ id: 'ch_zhang', bookId, name: '张三' });
  repos.characters.create({ id: 'ch_mu', bookId, name: '母亲' });

  // Model Gateway（§54 四槽位；验证时全部指向同一 profile）
  const profile: ModelProfile = {
    id: 'verify',
    provider: 'openai-compatible',
    endpoint: baseUrl,
    model,
    apiKeyRef: 'default',
    temperature: 0.8,
    maxTokens: 4096,
    contextWindow: 64_000,
    timeoutMs: 120_000,
    retryPolicy: { maxAttempts: 2 },
  };
  const gateway = new ModelGateway({
    profiles: [profile],
    slots: { architect: 'verify', writer: 'verify', reviewer: 'verify', utility: 'verify' },
    secrets: memSecrets(cred.key),
    logger,
  });

  const fts = new FtsIndex({ db, tokenizer: bigramTokenizer, logger });

  for (let n = 1; n <= chapters; n++) {
    console.log(`\n──────── 第 ${n} 章 ────────`);
    const chapterId = `ch_w_${String(n).padStart(3, '0')}`;
    const chapter = repos.chapters.create({
      id: chapterId,
      bookId,
      chapterNumber: n,
      title: `第 ${n} 章`,
    });

    // 1) 上下文装配（含长程检索）
    const retriever = new Retriever({ runner: fts, tokenizer: bigramTokenizer });
    const memory = new MemoryGatherer({
      retriever,
      memoryIndex: fts,
      buildMatch: (q) => buildMatchExpression(bigramTokenizer.query(q)),
      logger,
    }).gather(`第 ${n} 章 张三 旅途 母亲`, { bookId, includeMemoryIndex: true });

    const canon = repos.facts.listByStatus(bookId, 'CANON');
    const chars = repos.characters.listByBook(bookId);
    const prev = repos.chapters.listApprovedSummaries(bookId);

    const slotEntries: Partial<Record<SlotName, readonly {
      id: string;
      sourceType: 'FACT' | 'SUMMARY' | 'PROFILE';
      sourceRef: string;
      content: string;
      priority: number;
      isProtected?: boolean;
    }[]>> = {
      system: [
        {
          id: 'sys',
          sourceType: 'PROFILE' as const,
          sourceRef: 'system/identity.md',
          content: '你是中文长篇小说写作助手。Canon 是事实来源，不确定时不要自行创造。',
          priority: 100,
          isProtected: true,
        },
      ],
      protectedCanon: canon.map((f) => ({
        id: f.id,
        sourceType: 'FACT' as const,
        sourceRef: `facts/${f.id}`,
        content: `${chars.find((c) => c.id === f.subject_id)?.name ?? '—'}｜${f.predicate} = ${f.object_value}`,
        priority: 90,
        isProtected: true,
      })),
      topMemory: [
        ...prev.map((c) => ({
          id: `sum_${c.id}`,
          sourceType: 'SUMMARY' as const,
          sourceRef: c.body_path ?? `chapters/${c.chapter_number}.md`,
          content: `第 ${c.chapter_number} 章摘要：${c.summary}`,
          priority: c.chapter_number,
        })),
        ...memory.entries.map((e) => ({
          id: e.id,
          sourceType: 'SUMMARY' as const,
          sourceRef: e.sourceRef,
          content: e.content,
          priority: e.priority,
        })),
      ],
    };

    const assembled = new ContextEngine({ logger }).assemble({
      budget: { inputTokens: 32_000, outputReserveTokens: 8_000, protectedMaxTokens: 16_000 },
      slots: slotEntries,
    });
    check(
      `第 ${n} 章上下文装配`,
      assembled.text.length > 0,
      `${assembled.report.totalTokens} tokens｜保护槽位 ${assembled.report.slots.length} 个｜长程记忆 ${memory.entries.length} 条`,
    );

    // 2) 规划
    const planRes = await new Planner({
      structured: (req) => gateway.structured('architect', req),
      logger,
    }).plan({
      chapterNumber: n,
      contextText: assembled.text,
      ...(prev.length > 0 && prev[prev.length - 1]!.summary
        ? { previousSummary: prev[prev.length - 1]!.summary! }
        : {}),
    });

    if (!planRes.ok || !planRes.plan) {
      check(`第 ${n} 章规划`, false, planRes.error?.message ?? '规划失败');
      break;
    }
    const plan: PlanOutput = planRes.plan;
    repos.chapters.savePlan(chapter.id, plan);
    check(
      `第 ${n} 章规划`,
      plan.scenes.length > 0,
      `${plan.scenes.length} 场景｜${plan.brief.purpose.slice(0, 40)}｜钩子「${(plan.brief.hook ?? '').slice(0, 24)}」`,
    );

    // 3) 写作
    const ws = new ChapterWorkspace({ rootDir: outDir, bookId, chapterNumber: n, logger });
    ws.ensure();
    const draftRes = await new Writer({
      complete: async (req) => {
        const r = await gateway.chat('writer', {
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          temperature: req.temperature ?? 0.85,
          maxTokens: req.maxTokens ?? 2048,
        });
        return { text: r.text, usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens } };
      },
      workspace: ws,
      logger,
      wordsPerScene: 900,
    }).draft(plan);

    if (!draftRes.ok || !draftRes.draft) {
      check(`第 ${n} 章写作`, false, draftRes.error?.message ?? '写作失败');
      break;
    }
    const body = draftRes.draft.text;
    const charsOnly = body.replace(/\s/g, '');
    const uniqRatio = charsOnly.length > 0 ? new Set(charsOnly.split('')).size / charsOnly.length : 0;
    check(
      `第 ${n} 章写作`,
      body.length > 200,
      `${draftRes.draft.totalChars} 字｜${draftRes.draft.scenes.length} 场景｜字符去重率 ${(uniqRatio * 100).toFixed(0)}%`,
    );

    // 4) 一致性（确定性）
    const cReport = new ContinuityChecker({ repos, logger, bookId }).check({
      chapterNumber: n,
      draftText: body,
      plan,
    });
    check(
      `第 ${n} 章一致性`,
      cReport.ok,
      cReport.ok
        ? `无阻塞（对账 ${cReport.checked.canonFacts} Canon / ${cReport.checked.characters} 角色）`
        : `${cReport.blockingCount} 阻塞：${cReport.issues[0]?.message.slice(0, 46)}`,
    );

    // 5) 审稿（模型）
    const det: ReviewIssue[] = cReport.issues.map((i) => ({
      id: i.id,
      severity: i.severity === 'BLOCKING' ? 'BLOCKING' : 'MAJOR',
      category: 'CONTINUITY' as const,
      claim: i.message,
      evidence: [i.sourceRef],
      suggestions: [],
    }));
    const review = await new Reviewer({
      structured: (req) => gateway.structured('reviewer', req),
      logger,
    }).review({ chapterNumber: n, draftText: body, contextText: assembled.text, deterministicIssues: det });

    check(
      `第 ${n} 章审稿`,
      review.ok,
      review.ok
        ? `${review.issues.length} 问题（阻塞 ${review.summary.bySeverity.BLOCKING}）｜可提交=${review.canCommit}`
        : `模型审阅失败：${(review.error?.message ?? '').slice(0, 50)}`,
    );
    repos.chapters.saveReview(
      chapter.id,
      { overallStatus: review.status, issues: review.issues },
      review.status,
    );

    // 6) 提交
    ws.writeText('draft', body);
    const commitRes = new CommitEngine({
      db,
      repos,
      rootDir: outDir,
      logger,
      indexer: {
        indexChapter: (input) => {
          fts.indexChapter({
            chapterId: input.chapterId,
            bookId,
            chapterNumber: input.chapterNumber,
            sourceRef: input.sourceRef,
            text: input.body,
          });
        },
      },
    }).commit({ chapterId: chapter.id, chapterNumber: n, body, summary: plan.brief.purpose });

    check(
      `第 ${n} 章提交`,
      commitRes.ok,
      commitRes.ok
        ? `COMMITTED（${commitRes.appliedCount} 产物）`
        : `${commitRes.status}：${(commitRes.error?.message ?? '').slice(0, 50)}`,
    );
    if (!commitRes.ok) break;

    // 摘要确认 → 进检索（ADR-0006 约束 C）
    repos.chapters.approveSummary(chapter.id);
    new SummaryIndexer({ repos, fts, logger }).indexChapter(chapter.id);
  }

  // ── 总体验收 ──────────────────────────────────────────────
  console.log('\n──────── 总体验收 ────────');

  const committedRows = repos.chapters.listByStatus(bookId, 'COMMITTED');
  check('全部章节已提交', committedRows.length === chapters, `${committedRows.length}/${chapters}`);

  for (const c of committedRows) {
    const p = c.body_path ? join(outDir, c.body_path) : '';
    const text = p && existsSync(p) ? readFileSync(p, 'utf8') : '';
    const cs = text.replace(/\s/g, '');
    const ratio = cs.length > 0 ? new Set(cs.split('')).size / cs.length : 0;
    check(
      `第 ${c.chapter_number} 章正文充实度`,
      text.length >= 400 && ratio > 0.15,
      `${text.length} 字｜去重率 ${(ratio * 100).toFixed(0)}%`,
    );
  }

  const retriever = new Retriever({ runner: fts, tokenizer: bigramTokenizer });
  const trace = retriever.retrieve({ query: '张三', limit: 20, filter: { bookId } });
  check('长程检索命中', trace.hits.length > 0 || chapters === 0, `命中 ${trace.hits.length} 章`);

  const mem = new MemoryGatherer({
    retriever,
    memoryIndex: fts,
    buildMatch: (q) => buildMatchExpression(bigramTokenizer.query(q)),
    logger,
  }).gather('张三', { bookId, includeMemoryIndex: true });
  check('摘要进入检索', mem.retrieved, `${mem.entries.length} 条记忆`);

  const first = committedRows[0];
  if (first?.body_path && existsSync(join(outDir, first.body_path))) {
    const text = readFileSync(join(outDir, first.body_path), 'utf8');
    writeFileSync(join(outDir, 'SAMPLE.txt'), text, 'utf8');
    console.log('\n──── 第 1 章正文（前 700 字，供人工评估质量）────\n');
    console.log(text.slice(0, 700));
    console.log('\n────（样例结束；完整文本见 SAMPLE.txt）────');
  }
} catch (e) {
  check('未捕获异常', false, e instanceof Error ? e.message : String(e));
} finally {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
}

}

main()
  .then(() => {
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
    if (failed.length > 0) {
      console.log('未通过项：');
      for (const f of failed) console.log(`  - ${f.name}：${f.detail}`);
    }
    console.log(`产物目录：${outDir}`);
    if (failed.length === 0) rmSync(join(outDir, 'SAMPLE.txt'), { force: true });
    process.exit(failed.length > 0 ? 1 : 0);
  })
  .catch((e: unknown) => {
    console.error('验证脚本异常：', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
