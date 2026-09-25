/**
 * 开书向导仓储（前置设定流程）
 *
 * 表结构见 `migrations/0019_book_blueprint.sql`；判定语义见
 * `@nwa/core` 的 `blueprint-gate.ts`。
 *
 * ## ⚠ 本仓储最重要的约束：SETTINGS 步的内容**不从这里读**
 *
 * 角色与世界设定的权威副本是 `characters` / `world_entities` ——
 * 那才是 prompt 真正读到的东西。若把副本也存进 `draft_json` 并参与
 * 指纹计算，就会出现**门禁放行、prompt 读到的却是别的内容**这种假绿
 * （哈希的对象不是被消费的对象）。
 *
 * 所以 `snapshot()` 对 SETTINGS 步**从正式表现取内容**，
 * `draft_json` 对它只是"AI 提议的暂存区"。
 *
 * ## 有效内容 = edited_json ?? draft_json
 *
 * 用户要求「选择、修改」—— 得先看到 AI 原稿才能选。只存一份的话，
 * 用户点「重新生成」就永久丢失自己改过的内容。两份都留，
 * 且"这一步是 AI 生成的还是我改过的"成为可审计的事实。
 */
import { AppError, ErrorCode, hashAfterBlueprintConfirm } from '@nwa/core';
import type {
  BlueprintStep,
  BlueprintStepSnapshot,
  BlueprintStatus,
} from '@nwa/core';
import type { Database } from '../database.js';
import { now, parseJsonColumn, serializeJsonColumn, type Timestamped } from './types.js';

export interface BlueprintStepRow extends Timestamped {
  readonly id: string;
  readonly book_id: string;
  readonly step: string;
  readonly status: string;
  readonly draft_json: string | null;
  readonly edited_json: string | null;
  readonly generated_at: string | null;
  readonly edited_at: string | null;
  readonly confirmed_at: string | null;
}

export interface BookBlueprintRow extends Timestamped {
  readonly book_id: string;
  readonly confirmed_hash: string | null;
  readonly confirmed_at: string | null;
}

/** 四步的固定顺序 —— 界面按此顺序渲染，不依赖 DB 返回顺序 */
export const BLUEPRINT_STEP_ORDER: readonly BlueprintStep[] = [
  'CONCEPT',
  'SETTINGS',
  'OUTLINE',
  'DETAIL',
];

export class BlueprintRepository {
  constructor(private readonly db: Database) {}

  /**
   * 取某本书的全部步骤，**保证四步齐全**。
   *
   * ⚠ 缺的步骤补成 NOT_STARTED 的空行（不落库）：
   *   让调用方永远拿到固定四条，界面不必处理"这一步还没有行"。
   *   落库则没必要 —— 状态就是 NOT_STARTED，与"没有行"等价。
   */
  stepsOf(bookId: string): BlueprintStepRow[] {
    const rows = this.db.all<BlueprintStepRow>(
      'SELECT * FROM blueprint_steps WHERE book_id = ?',
      bookId,
    );
    const byStep = new Map(rows.map((r) => [r.step, r]));
    const ts = now();
    return BLUEPRINT_STEP_ORDER.map(
      (step) =>
        byStep.get(step) ?? {
          id: `bp_${bookId}_${step}`,
          book_id: bookId,
          step,
          status: 'NOT_STARTED',
          draft_json: null,
          edited_json: null,
          generated_at: null,
          edited_at: null,
          confirmed_at: null,
          created_at: ts,
          updated_at: ts,
        },
    );
  }

  findStep(bookId: string, step: BlueprintStep): BlueprintStepRow {
    const row = this.db.get<BlueprintStepRow>(
      'SELECT * FROM blueprint_steps WHERE book_id = ? AND step = ?',
      bookId,
      step,
    );
    if (row) return row;
    // 未落库的步骤按 NOT_STARTED 返回（与 stepsOf 一致）
    const ts = now();
    return {
      id: `bp_${bookId}_${step}`,
      book_id: bookId,
      step,
      status: 'NOT_STARTED',
      draft_json: null,
      edited_json: null,
      generated_at: null,
      edited_at: null,
      confirmed_at: null,
      created_at: ts,
      updated_at: ts,
    };
  }

  /**
   * 写入 AI 生成的原稿。
   *
   * ⚠ **不覆盖用户已编辑的内容**（edited_json 保留）。
   *   用户点「重新生成」时，他的编辑还在 —— 但 status 回落到 GENERATED，
   *   因为当前生效的是新草案（edited 被保留为历史，需要时可由界面恢复）。
   *
   *   `content` 为 null 表示这一步没有结构化内容（如 SETTINGS 步，
   *   其内容在正式表里）。
   */
  saveDraft(bookId: string, step: BlueprintStep, content: unknown): BlueprintStepRow {
    const ts = now();
    this.db.run(
      `INSERT INTO blueprint_steps
         (id, book_id, step, status, draft_json, generated_at, created_at, updated_at)
       VALUES (?, ?, ?, 'GENERATED', ?, ?, ?, ?)
       ON CONFLICT(book_id, step) DO UPDATE SET
         status = 'GENERATED',
         draft_json = excluded.draft_json,
         generated_at = excluded.generated_at,
         updated_at = excluded.updated_at`,
      `bp_${bookId}_${step}`,
      bookId,
      step,
      serializeJsonColumn(content ?? null),
      ts,
      ts,
      ts,
    );
    return this.findStep(bookId, step);
  }

  /** 写入用户编辑后的版本（status → EDITED） */
  saveEdited(bookId: string, step: BlueprintStep, content: unknown): BlueprintStepRow {
    const ts = now();
    this.db.run(
      `INSERT INTO blueprint_steps
         (id, book_id, step, status, edited_json, edited_at, created_at, updated_at)
       VALUES (?, ?, ?, 'EDITED', ?, ?, ?, ?)
       ON CONFLICT(book_id, step) DO UPDATE SET
         status = 'EDITED',
         edited_json = excluded.edited_json,
         edited_at = excluded.edited_at,
         updated_at = excluded.updated_at`,
      `bp_${bookId}_${step}`,
      bookId,
      step,
      serializeJsonColumn(content ?? null),
      ts,
      ts,
      ts,
    );
    return this.findStep(bookId, step);
  }

  /** 把某一步标记为已确认 */
  confirmStep(bookId: string, step: BlueprintStep): BlueprintStepRow {
    const ts = now();
    this.db.run(
      `INSERT INTO blueprint_steps
         (id, book_id, step, status, confirmed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'CONFIRMED', ?, ?, ?)
       ON CONFLICT(book_id, step) DO UPDATE SET
         status = 'CONFIRMED',
         confirmed_at = excluded.confirmed_at,
         updated_at = excluded.updated_at`,
      `bp_${bookId}_${step}`,
      bookId,
      step,
      ts,
      ts,
      ts,
    );
    return this.findStep(bookId, step);
  }

  /** 取有效内容：用户改过就用改过的，否则用 AI 原稿 */
  effectiveContent(row: BlueprintStepRow): unknown {
    const raw = row.edited_json ?? row.draft_json;
    if (raw === null) return null;
    return parseJsonColumn<unknown>(raw, 'blueprint content', row.id);
  }

  // ── 统一确认（用户说的「最后确认一切前置信息」） ──────────────────

  /**
   * 构造四步的内容快照，供指纹计算。
   *
   * ⚠ `extraContent` 是 SETTINGS 步的**正式表内容**（角色 + 世界设定），
   *   由调用方（工具层 / IPC）现取后传入。本仓储不读那两张表 ——
   *   依赖方向是 storage 内部，但让仓储自己去读会让
   *   "谁负责保证哈希对象 == 被消费对象"这件事变得模糊。
   *   调用方显式传入 = 职责明确。
   */
  snapshot(
    bookId: string,
    extraContent?: Partial<Record<BlueprintStep, string>>,
  ): BlueprintStepSnapshot[] {
    return this.stepsOf(bookId).map((row) => {
      const step = row.step as BlueprintStep;
      const extra = extraContent?.[step];
      return {
        step,
        status: row.status as BlueprintStatus,
        content: extra !== undefined ? extra : stableStringify(this.effectiveContent(row)),
      };
    });
  }

  /** 统一确认：记录当前四步内容的指纹 */
  confirmAll(
    bookId: string,
    extraContent?: Partial<Record<BlueprintStep, string>>,
  ): { hash: string; steps: number } {
    const snap = this.snapshot(bookId, extraContent);
    const hash = hashAfterBlueprintConfirm(snap);
    const ts = now();
    this.db.run(
      `INSERT INTO book_blueprints (book_id, confirmed_hash, confirmed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(book_id) DO UPDATE SET
         confirmed_hash = excluded.confirmed_hash,
         confirmed_at = excluded.confirmed_at,
         updated_at = excluded.updated_at`,
      bookId,
      hash,
      ts,
      ts,
      ts,
    );
    return { hash, steps: snap.length };
  }

  blueprintOf(bookId: string): BookBlueprintRow {
    return (
      this.db.get<BookBlueprintRow>(
        'SELECT * FROM book_blueprints WHERE book_id = ?',
        bookId,
      ) ?? {
        book_id: bookId,
        confirmed_hash: null,
        confirmed_at: null,
        created_at: now(),
        updated_at: now(),
      }
    );
  }

  /** 供门禁使用：已确认指纹（NULL = 从未统一确认） */
  confirmedHash(bookId: string): string | null {
    const row = this.db.get<{ confirmed_hash: string | null }>(
      'SELECT confirmed_hash FROM book_blueprints WHERE book_id = ?',
      bookId,
    );
    return row?.confirmed_hash ?? null;
  }

  /** 撤销统一确认（用户要求重新走一遍时用） */
  revokeConfirm(bookId: string): void {
    this.db.run('DELETE FROM book_blueprints WHERE book_id = ?', bookId);
  }
}

/**
 * 稳定序列化：对象键排序后再 JSON。
 *
 * ⚠ 必要性：指纹必须对**同内容**恒定。若直接 `JSON.stringify`，
 *   `{a:1,b:2}` 与 `{b:2,a:1}` 会算出不同指纹 —— 而它们语义完全相同。
 *   用户重新生成一次、模型键序变了，门禁就会误判成"内容被改过"。
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** 校验步骤名（防 IPC 传入非法值） */
export function assertBlueprintStep(step: string): BlueprintStep {
  if (!BLUEPRINT_STEP_ORDER.includes(step as BlueprintStep)) {
    throw new AppError(
      ErrorCode.TOOL_VALIDATION_ERROR,
      `未知的开书向导步骤：${step}（合法值：${BLUEPRINT_STEP_ORDER.join(' / ')}）`,
    );
  }
  return step as BlueprintStep;
}
