/**
 * Manuscript 仓储（M3，第二阶段施工单 §四 / §十 / §三十五）
 *
 * ## 语义边界（本文件存在的全部理由）
 *
 *   draft.md      = Writer 的原始产出（AI 初稿）
 *   revision.md   = Agent 的修订建议（AI 修订）
 *   manuscript.md = **用户当前正在编辑的正文**（人的产出）
 *
 * 施工单 §二 的硬要求：`SAVE != COMMIT`。
 *
 * **本仓储只允许碰 `manuscript.md` 与 `editor-state.json`。**
 * 绝不触碰：
 *   - `chapters` 表（章节状态、正文路径、摘要）
 *   - `facts` / `character_states` / `timeline` / `foreshadowing`（Canon）
 *   - `commit_manifests`（提交记录）
 *
 * 这条不是纪律，是**代码层边界**：本文件不 import 任何能写上述对象的东西。
 * 与之配套的是 `tests/integration/manuscript-save.test.ts` 的证伪测试 ——
 * `save()` 之后断言 Canon 条数、章节状态、manifest 数**全都没变**。
 *
 * ## 为什么 Save 与 Commit 必须分开（产品角度）
 *
 * 用户按 Ctrl+S 的意图是"别丢我的字"，不是"把这一章定为正史"。
 * 两者混淆会让作者**不敢随手保存** —— 而一个需要犹豫才敢按的保存键，
 * 等于没有自动保存。
 *
 * ## 为什么版本锚点要在这里更新
 *
 * §十 要求保存动作"更新 manuscript artifact / 更新 manuscript hash /
 * 记录保存时间"。`workflow_artifacts.content_hash` 存的是**产物文件自身**的
 * 哈希（见 `@nwa/core/staleness.ts` 的说明），而 stale 判定需要的是
 * "当前正文的哈希"。两者语义不同，因此：
 *   - 本仓储负责写 `manuscript.md` 并返回其内容哈希
 *   - 调用方（IPC / workflow）用该哈希去比对 Review / Continuity / State 的锚点
 *
 * ⚠ 不在这里做 stale 判定：判定是纯函数（`@nwa/core`），
 *   放这里会让"判定逻辑"与"文件写入"耦合成一个不可单测的整体。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  ErrorCode,
  sha256Text,
  assertSafeBookId,
  workspaceRel,
  resolveManuscriptText,
  MANUSCRIPT_SOURCE_FILE,
  MANUSCRIPT_SOURCE_IS_HUMAN,
  type ManuscriptSourceKey,
  type ResolvedManuscriptText,
  type Logger,
  type Nullable,
} from '@nwa/core';
import { now, type Database } from '@nwa/storage';

/**
 * 编辑器状态（§十一：崩溃恢复需要的不只是文本）。
 *
 * ⚠ 光标/选区/滚动位置**必须一起存**：只恢复文本会让作者回到章节开头，
 *   在一篇 3000 字里手工找回刚才那一句 —— 那和没恢复差别不大。
 */
export interface EditorState {
  /** 光标位置（字符偏移，0 起） */
  readonly cursor: number;
  /** 选区起点（无选区时等于 cursor） */
  readonly selectionStart: number;
  /** 选区终点 */
  readonly selectionEnd: number;
  /** 滚动位置（像素） */
  readonly scrollTop: number;
  /** 最后保存时间（ISO） */
  readonly savedAt: string;
  /** 该状态对应的正文哈希（用于判断"这份状态是不是当前正文的"） */
  readonly sourceHash: string;
}

/** 自动保存快照（§十一） */
export interface AutosaveSnapshot {
  readonly text: string;
  readonly sourceHash: string;
  /** 自动保存落盘时间 */
  readonly savedAt: string;
  readonly state: EditorState | null;
}

export interface ManuscriptSaveResult {
  readonly chapterId: string;
  readonly chapterNumber: number;
  readonly path: string;
  /** 保存后正文的内容哈希（stale 判定的"当前正文哈希"） */
  readonly sourceHash: string;
  readonly bytes: number;
  /** 本次保存是否真的改变了内容（false = 与上次完全相同，无副作用） */
  readonly changed: boolean;
  readonly savedAt: string;
}

/** 恢复检测结果（§十一：不静默覆盖） */
export interface AutosaveRecoveryCheck {
  /** 是否存在比正式正文更新的自动保存 */
  readonly hasNewerAutosave: boolean;
  /** 自动保存的内容（仅在 hasNewerAutosave 时有意义） */
  readonly autosaveText: Nullable<string>;
  readonly autosaveAt: Nullable<string>;
  readonly manuscriptAt: Nullable<string>;
  readonly state: Nullable<EditorState>;
  /** 人话说明（UI 直接展示，不拼接） */
  readonly message: string;
}

/**
 * 章节工作区内的文件名。
 *
 * ⚠ 与 `@nwa/story` 的 `WORKSPACE_FILES` 必须一致。
 *   这里重新声明而不是 import，是因为 `@nwa/storage` 是**更底层**的包
 *   （`@nwa/story` 依赖它，反向依赖会造成循环）。
 *   一致性由 `tests/integration/manuscript-save.test.ts` 断言。
 */
/**
 * 版本节点的来源（§十三）。
 *
 * ⚠ 与 §十三 的清单**逐字对应**，不要合并同类项：
 *   `RESTORED_AUTOSAVE` 与 `USER_EDIT` 的内容可能完全相同，
 *   但"作者自己改的"与"作者点了恢复到某一版"是**不同的事实** ——
 *   事后回看版本历史时，这两者的含义完全不同。
 */
export const MANUSCRIPT_VERSION_SOURCES = [
  'AI_DRAFT',
  'AI_REVISION',
  'USER_EDIT',
  'RESTORED_AUTOSAVE',
  /**
   * 从**历史版本**恢复（§十三）。
   *
   * ⚠ 与 `RESTORED_AUTOSAVE` 是两件事，不能合并：
   *   `RESTORED_AUTOSAVE` = 把旁路 autosave 副本载入编辑器（**未落盘**）
   *   `RESTORED_VERSION`  = 把某个历史版本写回正文（**已落盘**）
   * 两者的来源、是否落盘、能否撤回都不同。此前 `restoreVersion()`
   * 复用 `RESTORED_AUTOSAVE` 是**错标**：版本列表会把一次历史回退
   * 显示成"恢复了自动保存"，作者据此判断"这是刚才没保存的内容"，
   * 而实际正文已被改写。
   *
   * ⚠ 加这个值**不需要迁移**：0017 的 `source_type` 刻意不加 CHECK 约束，
   *   正是为了新增来源类型时不改表（见该迁移注释）。
   */
  'RESTORED_VERSION',
] as const;
export type ManuscriptVersionSource = (typeof MANUSCRIPT_VERSION_SOURCES)[number];

/** 版本节点（§十三 的 `ManuscriptVersion`） */
export interface ManuscriptVersion {
  readonly id: string;
  readonly chapterId: string;
  /** 章节所属的书（版本内容路径按书隔离，P0-1）。0018 之前的老数据为 null */
  readonly bookId: string | null;
  readonly chapterNumber: number;
  /** 同章内单调递增序号（从 1 起）。⚠ 排序用它，不用 created_at */
  readonly seq: number;
  readonly sourceType: ManuscriptVersionSource;
  /** 内容文件相对**项目根**的路径 */
  readonly contentPath: string;
  readonly contentHash: string;
  readonly charCount: number;
  readonly note: Nullable<string>;
  readonly createdAt: string;
}

/** 库行（snake_case） */
interface ManuscriptVersionRow {
  readonly id: string;
  readonly chapter_id: string;
  /** 0018 新增；老行为 null（其 content_path 指向旧布局） */
  readonly book_id: string | null;
  readonly chapter_number: number;
  readonly seq: number;
  readonly source_type: string;
  readonly content_path: string;
  readonly content_hash: string;
  readonly char_count: number;
  readonly note: string | null;
  readonly created_at: string;
}

function toVersion(r: ManuscriptVersionRow): ManuscriptVersion {
  return {
    id: r.id,
    chapterId: r.chapter_id,
    bookId: r.book_id,
    chapterNumber: r.chapter_number,
    seq: r.seq,
    // ⚠ 不信任库里的字符串：表上没有 CHECK 约束（迁移里刻意不加，
    //   因为新增来源类型时要改表），所以在这里收窄。
    //   遇到未知值按 USER_EDIT 处理而不是抛错 —— 版本列表打不开
    //   比"来源标签不准"严重得多。
    sourceType: (MANUSCRIPT_VERSION_SOURCES as readonly string[]).includes(r.source_type)
      ? (r.source_type as ManuscriptVersionSource)
      : 'USER_EDIT',
    contentPath: r.content_path,
    contentHash: r.content_hash,
    charCount: r.char_count,
    note: r.note,
    createdAt: r.created_at,
  };
}

const FILES = {
  manuscript: 'manuscript.md',
  autosave: 'manuscript.autosave.md',
  editorState: 'editor-state.json',
} as const;

export class ManuscriptRepository {
  private readonly db: Database;
  private readonly logger: Logger;
  /** 项目根目录（工作区在其下） */
  private readonly rootDir: string;

  constructor(opts: { readonly db: Database; readonly rootDir: string; readonly logger: Logger }) {
    this.db = opts.db;
    this.rootDir = opts.rootDir;
    this.logger = opts.logger;
  }

  /**
   * 章节工作区目录（与 ChapterWorkspace 的布局一致，**按书隔离**）。
   *
   * ⚠ 路径是 `books/<bookId>/workspace/chapter-NNN`。原先是
   *   `workspace/chapter-NNN`（只有章号），而 DB 允许两本书各有第 1 章，
   *   于是两书同章号共用同一目录 —— 用户正文与版本节点会互相覆盖（P0-1）。
   */
  private dirOf(bookId: string, chapterNumber: number): string {
    if (!Number.isInteger(chapterNumber) || chapterNumber <= 0) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `章号必须是正整数，收到：${String(chapterNumber)}`,
      );
    }
    assertSafeBookId(bookId);
    return join(this.rootDir, workspaceRel(bookId, chapterNumber));
  }

  private pathOf(bookId: string, chapterNumber: number, name: string): string {
    return join(this.dirOf(bookId, chapterNumber), name);
  }

  /**
   * 回查章节所属的书（权威来源：`chapters.book_id`）。
   *
   * ⚠ 只用于**老数据**（0018 之前的版本行没有 book_id）。
   *   新数据一律自带 book_id，不走这里。
   */
  private bookIdOfChapter(chapterId: string): string | null {
    const row = this.db.get<{ book_id: string }>(
      'SELECT book_id FROM chapters WHERE id = ?',
      chapterId,
    );
    return row?.book_id ?? null;
  }

  /**
   * 按优先级链解析「当前正文」（ADR-0008 / 缺陷 A 修复）。
   *
   * ⚠ 这是本仓储读取侧的**唯一入口**，与提交侧共用 `@nwa/core` 的
   *   `resolveManuscriptText` —— 两侧必须由同一个函数决定
   *   "当前正文是哪份"，否则就是缺陷 A（作者看到 0 字、提交却命中别的文件）。
   */
  resolveCurrent(bookId: string, chapterNumber: number): ResolvedManuscriptText {
    return resolveManuscriptText((key) => this.readWorkspaceFile(bookId, chapterNumber, key));
  }

  /**
   * 读取工作区某一份稿；不存在返回 null。
   *
   * ⚠ 私有：外部只应通过 `resolveCurrent` / `get` 取正文 ——
   *   直接按文件名读就是"自己定一套"，正是缺陷 A 的形状。
   */
  private readWorkspaceFile(
    bookId: string,
    chapterNumber: number,
    key: ManuscriptSourceKey,
  ): Nullable<string> {
    const p = this.pathOf(bookId, chapterNumber, MANUSCRIPT_SOURCE_FILE[key]);
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8');
  }

  /**
   * 读取**当前正文**（优先级链 `manuscript ?? revision ?? draft`）。
   *
   * ⚠ 不存在返回 null 而不是抛错：调用方（编辑器）要能区分
   *   "这一章还没有正文"（显示空编辑器）与"读取失败"（报错）。
   *
   * ⚠⚠ 语义变化（缺陷 A 修复）：此前硬读 `manuscript.md`，而工作流
   *   **从不写**该文件（它写 draft/revision）→ 作者看到空白，
   *   点保存又用空正文覆盖，而提交侧仍按优先级链取"当前正文"
   *   → AI 写好的 10KB 正文静默丢失（实测 chapters/001.md = 68 字节
   *   且状态为 COMMITTED）。
   *
   * ⚠ 这只改**读取侧**：`manuscript.md` 仍**只**由 `save()`（人的动作）写入。
   *   AI 产出永不自动覆盖它（施工单 §15 / ADR-0008 §7）——
   *   证伪测试见 `tests/integration/manuscript-read-chain.test.ts`。
   */
  get(bookId: string, chapterNumber: number): Nullable<string> {
    return this.resolveCurrent(bookId, chapterNumber).text;
  }

  /**
   * 读取**人工正文**（仅 `manuscript.md`）。
   *
   * ⚠ 与 `get` 的区别不是细节：`get` 是"当前正文"（可能来自 AI），
   *   本方法是"作者确认过的正文"。恢复检测 / 保存状态 /
   *   版本节点判定要用后者，否则会把 AI 稿误当成"作者已确认"。
   */
  getHumanManuscript(bookId: string, chapterNumber: number): Nullable<string> {
    return this.readWorkspaceFile(bookId, chapterNumber, 'manuscript');
  }

  /**
   * 打开章节：正文 + 自动保存恢复检测。
   *
   * ⚠ 这里**只检测不恢复**。§十一 明确要求"不要直接静默覆盖" ——
   *   自动恢复会让作者在不知情的情况下拿到一份没确认过的文本，
   *   而"我以为打开的是定稿"是最难查的一类错乱。
   *
   * ⚠ 返回 `source` / `hasHumanManuscript`：UI **必须**据此如实告知
   *   "当前显示的是 AI 稿（还没有你确认过的正文）" ——
   *   否则上面那条禁令会以另一种形式被违反（显示的是 AI 稿，
   *   作者却以为是自己上次的定稿）。
   */
  open(bookId: string, chapterNumber: number): {
    text: Nullable<string>;
    sourceHash: Nullable<string>;
    source: ManuscriptSourceKey;
    hasHumanManuscript: boolean;
    recovery: AutosaveRecoveryCheck;
  } {
    const resolved = this.resolveCurrent(bookId, chapterNumber);
    const text = resolved.text;
    const sourceHash = text === null ? null : sha256Text(text);
    return {
      text,
      sourceHash,
      source: resolved.source,
      hasHumanManuscript: resolved.hasHumanManuscript,
      recovery: this.checkRecovery(bookId, chapterNumber),
    };
  }

  /**
   * 保存正文（§十）。
   *
   * ⚠ 幂等：内容没变时 `changed: false` 且**不重写文件** ——
   *   重写会更新 mtime，而 mtime 正是 §十一 判断"哪份更新"的依据之一。
   *   每次 autosave 都刷新 mtime 会让恢复检测永远认为"有更新的内容"。
   */
  save(bookId: string, chapterNumber: number, text: string): ManuscriptSaveResult {
    const p = this.pathOf(bookId, chapterNumber, FILES.manuscript);
    const prev = this.get(bookId, chapterNumber);
    const hash = sha256Text(text);
    const changed = prev === null || sha256Text(prev) !== hash;

    if (changed) {
      mkdirSync(this.dirOf(bookId, chapterNumber), { recursive: true });
      writeFileSync(p, text, { encoding: 'utf8', flag: 'w' });
    }

    const savedAt = now();
    this.logger.info('正文已保存（不涉及 Canon）', {
      chapterNumber,
      bytes: Buffer.byteLength(text, 'utf8'),
      changed,
    });

    return {
      chapterId: '', // 由调用方填充（仓储不知道 chapterId，只知道章号）
      chapterNumber,
      path: p,
      sourceHash: hash,
      bytes: Buffer.byteLength(text, 'utf8'),
      changed,
      savedAt,
    };
  }

  // ────────────── 自动保存（§八 / §十一）──────────────

  /**
   * 写自动保存副本。
   *
   * ⚠ 与 `save()` 的差别不只是"另一个文件"：
   *   - `save()` 写的是**正式正文**（用户按了 Ctrl+S 或点了保存）
   *   - `autosave()` 写的是**旁路副本**，正文一个字节都不动
   *
   *   若 autosave 直接写正式正文，就等于"自动保存 = 保存"——
   *   那会让 §十二 的"切章保护"失去意义（没什么可保护的了），
   *   也会让用户在没确认的情况下丢掉旧正文。
   */
  autosave(
    bookId: string,
    chapterNumber: number,
    text: string,
    state?: Omit<EditorState, 'savedAt' | 'sourceHash'>,
  ): { path: string; sourceHash: string; savedAt: string } {
    const hash = sha256Text(text);
    const savedAt = now();
    mkdirSync(this.dirOf(bookId, chapterNumber), { recursive: true });
    writeFileSync(this.pathOf(bookId, chapterNumber, FILES.autosave), text, {
      encoding: 'utf8',
      flag: 'w',
    });

    if (state) {
      const full: EditorState = { ...state, savedAt, sourceHash: hash };
      writeFileSync(
        this.pathOf(bookId, chapterNumber, FILES.editorState),
        JSON.stringify(full, null, 2),
        { encoding: 'utf8', flag: 'w' },
      );
    }

    return { path: this.pathOf(bookId, chapterNumber, FILES.autosave), sourceHash: hash, savedAt };
  }

  /** 读编辑器状态；损坏或缺失返回 null（不让坏数据炸掉打开流程） */
  readEditorState(bookId: string, chapterNumber: number): Nullable<EditorState> {
    const p = this.pathOf(bookId, chapterNumber, FILES.editorState);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as EditorState;
    } catch (e) {
      this.logger.warn('编辑器状态损坏（按缺失处理）', {
        chapterNumber,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * 检测是否存在"未恢复的编辑内容"（§十一）。
   *
   * 判据是**两个都要看**：
   *   1. autosave 存在
   *   2. autosave 与正式正文**内容不同**（hash 比对）
   *
   * ⚠ 为什么不能只看 mtime：`save()` 与 `autosave()` 的写入顺序
   *   会让 mtime 关系不稳定（先 autosave 后 save 时 autosave 更旧但内容更新）。
   *   内容哈希才是"用户是否还有未保存的字"的判据。
   *
   * ⚠ 内容相同时**不算**有未恢复内容：否则用户每次打开章节都会看到
   *   "发现未恢复的编辑内容" —— 一个总是出现的提示等于没有提示，
   *   作者会条件反射地点"放弃"，真正的丢失场景就救不回来了。
   */
  checkRecovery(bookId: string, chapterNumber: number): AutosaveRecoveryCheck {
    const autoPath = this.pathOf(bookId, chapterNumber, FILES.autosave);
    const empty: AutosaveRecoveryCheck = {
      hasNewerAutosave: false,
      autosaveText: null,
      autosaveAt: null,
      manuscriptAt: null,
      state: null,
      message: '没有未恢复的编辑内容',
    };

    if (!existsSync(autoPath)) return empty;

    const autoText = readFileSync(autoPath, 'utf8');
    const autoHash = sha256Text(autoText);
    // ⚠⚠ 这里必须比对**人工正文**（`getHumanManuscript`），不是 `get()`。
    //
    //   缺陷 A 修复后 `get()` 会回退到 draft —— 若用它比对，
    //   "autosave 与 AI 稿相同"就会被判成"没有待恢复内容"，
    //   而磁盘上其实没有这份内容（autosave 还没被接受）。
    //   结果是作者的编辑**静默消失**：他以为已恢复，实际从没落盘。
    //
    //   恢复检测的语义是"磁盘上的正式正文 vs 旁路副本"，
    //   只有人的产出算"正式正文"。
    const manuscript = this.getHumanManuscript(bookId, chapterNumber);
    const manuscriptHash = manuscript === null ? null : sha256Text(manuscript);

    const state = this.readEditorState(bookId, chapterNumber);
    const autoAt = state?.savedAt ?? safeMtime(autoPath);
    const manAt = existsSync(this.pathOf(bookId, chapterNumber, FILES.manuscript))
      ? safeMtime(this.pathOf(bookId, chapterNumber, FILES.manuscript))
      : null;

    // 内容一致 → 没有未恢复的东西（无论时间戳如何）
    if (manuscriptHash === autoHash) return empty;

    return {
      hasNewerAutosave: true,
      autosaveText: autoText,
      autosaveAt: autoAt,
      manuscriptAt: manAt,
      state,
      message:
        manuscript === null
          ? '发现自动保存的编辑内容（还没有正式正文），是否恢复？'
          : '发现未恢复的编辑内容（比正式正文更新），是否恢复？',
    };
  }

  /** 接受自动保存：把 autosave 内容提升为正式正文（用户点「恢复」时调用） */
  acceptAutosave(bookId: string, chapterNumber: number): Nullable<ManuscriptSaveResult> {
    const rec = this.checkRecovery(bookId, chapterNumber);
    if (!rec.hasNewerAutosave || rec.autosaveText === null) return null;
    const res = this.save(bookId, chapterNumber, rec.autosaveText);
    this.clearAutosave(bookId, chapterNumber);
    return res;
  }

  /**
   * 放弃自动保存（用户点「放弃」时调用）。
   *
   * ⚠ **删除**文件，不是写空串。写空串会制造一个无法区分的状态：
   *   "已清除" 与 "用户把整章清空了、autosave 里确实是空的"
   *   两者文件内容都是 '' —— 于是作者清空章节后每次打开都会看到
   *   "发现未恢复的编辑内容（内容为空）"，或者反过来，真正的清空操作
   *   被当成"没有未恢复内容"而丢掉。
   *   删除则是明确的状态：文件不在 = 没有待恢复的东西。
   */
  clearAutosave(bookId: string, chapterNumber: number): void {
    for (const key of [FILES.autosave, FILES.editorState] as const) {
      const p = this.pathOf(bookId, chapterNumber, key);
      if (existsSync(p)) rmSync(p, { force: true });
    }
    this.logger.info('自动保存副本已清除', { chapterNumber });
  }

  /**
   * 保存状态查询（§九 / §三十五）。
   *
   * ⚠ 用**内容比对**而不是"上次保存时间"：编辑器里那份文本可能是
   *   从别处粘贴/撤销出来的，与磁盘上的正式正文未必同源。
   *   只比时间会给出"已保存"而实际有未落盘的字。
   */
  getSaveStatus(
    bookId: string,
    chapterNumber: number,
    editorText?: string,
  ): {
    chapterNumber: number;
    hasManuscript: boolean;
    sourceHash: Nullable<string>;
    savedAt: Nullable<string>;
    dirty: boolean;
    hasPendingAutosave: boolean;
    /** 当前正文来自哪一份（缺陷 A 修复后新增，UI 据此如实告知） */
    source: ManuscriptSourceKey;
    /** 是否已存在人工正文（作者确认过的） */
    hasHumanManuscript: boolean;
  } {
    const resolved = this.resolveCurrent(bookId, chapterNumber);
    const manPath = this.pathOf(bookId, chapterNumber, FILES.manuscript);
    const has = existsSync(manPath);
    const current = resolved.text;
    const currentHash = current === null ? null : sha256Text(current);
    // ⚠⚠ dirty 的基线必须是**编辑器里那份文本的来源**：
    //
    //   作者打开章节时看到的可能是 AI 稿（draft）而不是 manuscript.md。
    //   若仍与 manuscript.md 比较，而该文件还不存在 →
    //   `currentHash === null` → 作者一打开章节就被判为"有未保存改动"，
    //   而他一个字节都没改。接着切章/关窗会触发"未保存"确认，
    //   久而久之作者学会无脑点"放弃" —— 那时真的丢字。
    //
    //   `resolveCurrent` 返回的 `source` 已经告诉我们编辑器显示的是哪份，
    //   直接用它做基线（AI 稿被原地改动后同样能正确判脏）。
    const editorHash = editorText === undefined ? currentHash : sha256Text(editorText);
    const rec = this.checkRecovery(bookId, chapterNumber);

    return {
      chapterNumber,
      hasManuscript: has,
      sourceHash: currentHash,
      // ⚠ 时间戳只在**基线就是 manuscript.md** 时有意义 ——
      //   显示 AI 稿时说"已保存于 X"会让人以为那是自己保存的正文。
      savedAt: MANUSCRIPT_SOURCE_IS_HUMAN[resolved.source] ? safeMtime(manPath) : null,
      // 无正文且编辑器有内容 → 也算脏（新建章还没保存过）
      dirty: editorHash !== currentHash,
      hasPendingAutosave: rec.hasNewerAutosave,
      source: resolved.source,
      hasHumanManuscript: resolved.hasHumanManuscript,
    };
  }

  /**
   * 该章正文是否已进入正式章节（§三十：Commit 按钮与保存必须视觉可辨）。
   *
   * ⚠ 只读 `chapters` 表，**不写** —— 本仓储对 Canon 只读。
   *   放在这里是为了让 UI 一次调用就能拿到"这份正文是不是已经是正史"，
   *   否则 UI 要自己拼两个 IPC，两处判定必然漂移。
   */
  isCommitted(chapterId: string): boolean {
    const row = this.db.get<{ status: string }>(
      'SELECT status FROM chapters WHERE id = ?',
      chapterId,
    );
    if (!row) return false;
    return row.status === 'COMMITTED' || row.status === 'COMMITTING';
  }

  // ────────────── 版本节点（M6 / §十三 §十四）──────────────
  //
  // ⚠ 粒度由 ADR-0008 §6 钉死：只在 AI_DRAFT / AI_REVISION /
  //   USER_EDIT（且 hash 变化）/ RESTORED_AUTOSAVE 建节点。
  //   **自动保存不建版本** —— 否则一次编辑产生几十个节点，
  //   与 §41「不要复杂版本树 UI」直接冲突，而且真正的节点会被淹没。

  /**
   * 建一个版本节点。
   *
   * ⚠ 幂等判据是**内容 hash**，不是"调用了几次"：
   *   作者反复按 Ctrl+S（内容没变）不该堆出一串内容相同的节点 ——
   *   那会让版本历史变成噪声，而噪声里的"上一版"是不可信的。
   *
   * @param input.chapterId     章节 id（chapters.id）
   * @param input.chapterNumber 章号（工作区路径按它拼接）
   * @param input.text          该版本的正文内容
   * @param input.sourceType    AI_DRAFT / AI_REVISION / USER_EDIT / RESTORED_AUTOSAVE
   * @param input.note          可选说明
   * @returns 新建的版本；若与最新版本内容相同则返回 null（未新建）
   */
  createVersion(input: {
    bookId: string;
    chapterId: string;
    chapterNumber: number;
    text: string;
    sourceType: ManuscriptVersionSource;
    note?: string;
  }): Nullable<ManuscriptVersion> {
    const hash = sha256Text(input.text);
    const latest = this.latestVersion(input.chapterId);

    // ⚠ 内容与最新版本相同 → 不建节点。
    //   注意这里**只比最新一个**，不是"全表去重"：作者改回旧内容
    //   （A → B → A）是一次真实的编辑动作，应当留下痕迹 ——
    //   "又变回 A 了"本身是有信息量的事实。
    if (latest !== null && latest.contentHash === hash) return null;

    const seq = (latest?.seq ?? 0) + 1;
    const fileName = `v${String(seq).padStart(3, '0')}.md`;
    // ⚠ 版本内容路径按书隔离（P0-1）。原先是
    //   `workspace/chapter-NNN/versions/vNNN.md` —— 只有章号，两本书各自的
    //   seq 都从 1 起，B 的 v001 会覆盖 A 的 v001：A 的版本列表仍列出 v001
    //   （DB 行还在），读出来却是 B 的文本。
    const relPath = `${workspaceRel(input.bookId, input.chapterNumber)}/versions/${fileName}`;
    const absPath = join(this.rootDir, relPath);

    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, input.text, { encoding: 'utf8', flag: 'w' });

    const id = `mv_${randomUUID()}`;
    const createdAt = now();
    this.db.run(
      `INSERT INTO manuscript_versions
         (id, book_id, chapter_id, chapter_number, seq, source_type, content_path, content_hash, char_count, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.bookId,
      input.chapterId,
      input.chapterNumber,
      seq,
      input.sourceType,
      relPath,
      hash,
      input.text.length,
      input.note ?? null,
      createdAt,
    );

    this.logger.info('版本节点已创建', {
      chapterNumber: input.chapterNumber,
      seq,
      sourceType: input.sourceType,
      chars: input.text.length,
    });

    return {
      id,
      chapterId: input.chapterId,
      bookId: input.bookId,
      chapterNumber: input.chapterNumber,
      seq,
      sourceType: input.sourceType,
      contentPath: relPath,
      contentHash: hash,
      charCount: input.text.length,
      note: input.note ?? null,
      createdAt,
    };
  }

  /**
   * 按章列出全部版本（新的在前）。
   *
   * ⚠ 不返回正文内容：一章节几十个版本，把内容全带上会让列表 IPC
   *   变成几百 KB 的传输，而列表 UI 只需要元信息。
   *   要看内容走 `readVersion()`。
   */
  listVersions(chapterId: string): ManuscriptVersion[] {
    const rows = this.db.all<ManuscriptVersionRow>(
      `SELECT * FROM manuscript_versions WHERE chapter_id = ? ORDER BY seq DESC`,
      chapterId,
    );
    return rows.map(toVersion);
  }

  /** 最新版本；没有则 null */
  latestVersion(chapterId: string): Nullable<ManuscriptVersion> {
    const row = this.db.get<ManuscriptVersionRow>(
      `SELECT * FROM manuscript_versions WHERE chapter_id = ? ORDER BY seq DESC LIMIT 1`,
      chapterId,
    );
    return row ? toVersion(row) : null;
  }

  /**
   * 读某个版本的正文内容。
   *
   * ⚠ 文件缺失返回 null 而不是抛错：版本文件可能被人工清理
   *   （§十四 明确版本是可丢弃的），此时列表仍应可用，
   *   只是那一版的内容打不开 —— 报错会让整个版本列表打不开。
   */
  readVersion(versionId: string): Nullable<string> {
    const row = this.db.get<ManuscriptVersionRow>(
      `SELECT * FROM manuscript_versions WHERE id = ?`,
      versionId,
    );
    if (!row) return null;
    const abs = join(this.rootDir, row.content_path);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, 'utf8');
  }

  /**
   * 恢复到某个版本（§十三：用户显式动作）。
   *
   * ⚠ 恢复**必须**同时做两件事，缺一不可：
   *   1. 把该版本内容写成新的**当前正文**（用户点了恢复就是要这个）
   *   2. 再建一个 `RESTORED_AUTOSAVE` 节点记录这次动作
   *
   *   只做 1 会丢失"是谁把它改回去的"这条信息；
   *   只做 2 则正文没变，用户看到的还是旧内容。
   *
   * ⚠ 恢复**不删除**中间版本。作者恢复后往往还要再对比回来 ——
   *   删掉中间版本等于替用户做了不可逆的决定。
   */
  restoreVersion(versionId: string): Nullable<{
    version: ManuscriptVersion;
    saved: ManuscriptSaveResult;
    restoredFrom: ManuscriptVersion;
  }> {
    const row = this.db.get<ManuscriptVersionRow>(
      `SELECT * FROM manuscript_versions WHERE id = ?`,
      versionId,
    );
    if (!row) return null;
    const source = toVersion(row);
    const text = this.readVersion(versionId);
    if (text === null) return null;

    // ⚠ 老版本行（0018 之前）没有 book_id。回查 chapters 拿权威来源，
    //   而不是猜一本书 —— 猜错会把正文写进别的书的工作区。
    const bookId = source.bookId ?? this.bookIdOfChapter(source.chapterId);
    if (bookId === null) {
      throw new AppError(
        ErrorCode.WORKSPACE_CORRUPTED,
        `版本 ${versionId} 无法确定所属书（章节 ${source.chapterId} 不存在）`,
      );
    }

    const saved = this.save(bookId, source.chapterNumber, text);
    const created = this.createVersion({
      bookId,
      chapterId: source.chapterId,
      chapterNumber: source.chapterNumber,
      text,
      sourceType: 'RESTORED_VERSION',
      note: `恢复到 v${String(source.seq).padStart(3, '0')}`,
    });

    // ⚠ createVersion 可能返回 null（内容与最新版本相同）——
    //   那意味着"恢复到的就是当前内容"，此时没有新节点可报，
    //   但恢复动作本身已经生效（正文已是该版本）。
    //   用一个合成的视图返回，避免调用方以为失败。
    const version =
      created ??
      this.latestVersion(source.chapterId) ??
      source;

    this.logger.info('已恢复到历史版本', {
      chapterNumber: source.chapterNumber,
      from: source.seq,
      newSeq: created?.seq ?? null,
    });

    return { version, saved, restoredFrom: source };
  }
}

/** 文件 mtime（ISO）；取不到返回 null（不让权限/竞态炸掉调用方） */
function safeMtime(path: string): Nullable<string> {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}
