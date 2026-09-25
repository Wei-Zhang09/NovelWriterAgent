/**
 * ID 生成（施工计划 §3.1b：主键必须内容派生）
 *
 * 三类 ID 的生成策略不同，禁止混用：
 *
 *  1. 内容派生 ID（幂等）：同一输入永远得到同一 ID —— 用于 fact / evidence / event。
 *     理由（研究报告 §2.1 采纳 3）：随机 UUID 会让「重放一次投影」产生重复事实。
 *
 *  2. 时间有序 ID：用于 run / checkpoint / commit_manifest —— 需要按创建顺序排序。
 *
 *  3. 命名空间 ID：用于 project / book / chapter 等用户可见的稳定标识。
 */
import { createHash, randomUUID } from 'node:crypto';

/** 内容派生的稳定哈希（sha1 前 16 位十六进制） */
function contentHash(parts: readonly (string | number)[]): string {
  const stable = parts.map((p) => String(p)).join('|');
  return createHash('sha1').update(stable, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Fact 主键（内容派生）
 *
 * ⚠ 不得包含 status / confidence —— 否则同一事实的置信度变化会变成"新事实"，
 *   导致 Canon 里堆积多条互相矛盾却 ID 不同的记录。
 */
export function factId(input: {
  subjectType: string;
  subjectId: string;
  predicate: string;
  objectValue: string;
}): string {
  return `fact_${contentHash([
    input.subjectType,
    input.subjectId,
    input.predicate,
    input.objectValue,
  ])}`;
}

/**
 * Evidence 主键（内容派生）
 *
 * quote 只取前 64 字符参与哈希：超长引用（整段）会让同一证据因一个标点差异而分裂成两条。
 */
export function evidenceId(input: {
  sourceRef: string;
  startOffset: number;
  endOffset: number;
  quote: string;
}): string {
  return `evid_${contentHash([
    input.sourceRef,
    input.startOffset,
    input.endOffset,
    input.quote.slice(0, 64),
  ])}`;
}

/**
 * Run 事件 ID（内容派生 + 序号，保证同一章节重放时事件 ID 稳定）
 *
 * 形如 `evt-ch031-0007-3f4a1b2c9d`，同时可按 chapter 前缀做范围查询。
 */
export function eventId(input: {
  chapter: number;
  index: number;
  /** 参与哈希的负载（调用方需自行剔除易变字段，如时间戳） */
  payload: Record<string, unknown>;
}): string {
  const stable = JSON.stringify(input.payload, Object.keys(input.payload).sort());
  const digest = createHash('sha1').update(stable, 'utf8').digest('hex').slice(0, 10);
  const ch = String(input.chapter).padStart(3, '0');
  const ix = String(input.index).padStart(4, '0');
  return `evt-ch${ch}-${ix}-${digest}`;
}

/**
 * 时间线事件 ID（内容派生）。
 *
 * ⚠ 内容派生而不是随机：同一条事件重复登记时得到同一个 id，
 *   配合主键冲突就能做到"不重复记账"。随机 id 会让同一事件
 *   在重跑后变成两条，"这件事发生过几次"就说不清了。
 *
 * ⚠ 参与哈希的是 (book, chapter, offset, title) —— **不含**故事时间。
 *   故事时间是会随后续修正而变的字段；把它算进 id 会让"修正时间"
 *   变成"新建一条事件"，而原事件还留着错误的时间。
 */
export function timelineEventId(input: {
  bookId: string;
  chapter: number;
  offset: number;
  title: string;
}): string {
  const digest = contentHash([input.bookId, input.chapter, input.offset, input.title]);
  const ch = String(input.chapter).padStart(3, '0');
  return `te-ch${ch}-${digest}`;
}

/**
 * Commit 绕过审计记录 ID（P1）。
 *
 * ⚠ 用时间有序前缀而不是内容哈希：同一次绕过**不该**被去重。
 *   内容哈希会让"同一章两次绕过"合并成一条，而审计要的正是
 *   "绕过发生过几次"。时间有序保证同毫秒内也不冲突。
 */
export function commitOverrideId(): string {
  return timeOrderedId('cov');
}

/** 时间有序 ID：前缀 + 毫秒时间戳(base36) + 随机后缀，保证同一毫秒内不冲突 */
function timeOrderedId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = randomUUID().replace(/-/g, '').slice(0, 8);
  return `${prefix}_${ts}${rand}`;
}

export const runId = (): string => timeOrderedId('run');
export const checkpointId = (): string => timeOrderedId('ckpt');
export const commitManifestId = (): string => timeOrderedId('cmt');
export const promptCallId = (): string => timeOrderedId('call');

/** 命名空间 ID：用户可见的稳定标识 */
export const projectId = (): string => `proj_${randomUUID()}`;
export const bookId = (): string => `book_${randomUUID()}`;
export const characterId = (): string => `char_${randomUUID()}`;
/** 世界观设定实体（P2-3）。用命名空间 ID：设定是用户可见的稳定标识 */
export const worldEntityId = (): string => `world_${randomUUID()}`;
/** 卷（开书向导 Phase 3）。用命名空间 ID：卷是用户可见的稳定标识 */
export const volumeId = (): string => `vol_${randomUUID()}`;

/** 章节 ID 由 book + 章节号决定，保证唯一且可预测 */
export const chapterId = (book: string, chapterNumber: number): string =>
  `ch_${book}_${String(chapterNumber).padStart(3, '0')}`;

// ⚠ workspaceDirName / chapterFileName 已移到 `paths.ts`。
//   它们属于"项目内路径契约"，与"ID 生成"是两件事；而且路径只能有一处定义
//   —— 两处各写一份必然漂移，表现为"写到 A 处、读从 B 处"，不报错只是对不上。
//   这里保留 re-export 以免既有 import 断裂。
export { workspaceDirName, chapterFileName } from './paths.js';
