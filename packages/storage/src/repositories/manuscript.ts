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
import { join } from 'node:path';
import { AppError, ErrorCode, sha256Text, type Logger, type Nullable } from '@nwa/core';
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

  /** 章节工作区目录（与 ChapterWorkspace 的布局一致：workspace/chapter-NNN） */
  private dirOf(chapterNumber: number): string {
    if (!Number.isInteger(chapterNumber) || chapterNumber <= 0) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `章号必须是正整数，收到：${String(chapterNumber)}`,
      );
    }
    return join(this.rootDir, 'workspace', `chapter-${String(chapterNumber).padStart(3, '0')}`);
  }

  private pathOf(chapterNumber: number, name: string): string {
    return join(this.dirOf(chapterNumber), name);
  }

  /**
   * 读取正式正文。
   *
   * ⚠ 不存在返回 null 而不是抛错：调用方（编辑器）要能区分
   *   "这一章还没有正文"（显示空编辑器）与"读取失败"（报错）。
   */
  get(chapterNumber: number): Nullable<string> {
    const p = this.pathOf(chapterNumber, FILES.manuscript);
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8');
  }

  /**
   * 打开章节：正文 + 自动保存恢复检测。
   *
   * ⚠ 这里**只检测不恢复**。§十一 明确要求"不要直接静默覆盖" ——
   *   自动恢复会让作者在不知情的情况下拿到一份没确认过的文本，
   *   而"我以为打开的是定稿"是最难查的一类错乱。
   */
  open(chapterNumber: number): {
    text: Nullable<string>;
    sourceHash: Nullable<string>;
    recovery: AutosaveRecoveryCheck;
  } {
    const text = this.get(chapterNumber);
    const sourceHash = text === null ? null : sha256Text(text);
    return { text, sourceHash, recovery: this.checkRecovery(chapterNumber) };
  }

  /**
   * 保存正文（§十）。
   *
   * ⚠ 幂等：内容没变时 `changed: false` 且**不重写文件** ——
   *   重写会更新 mtime，而 mtime 正是 §十一 判断"哪份更新"的依据之一。
   *   每次 autosave 都刷新 mtime 会让恢复检测永远认为"有更新的内容"。
   */
  save(chapterNumber: number, text: string): ManuscriptSaveResult {
    const p = this.pathOf(chapterNumber, FILES.manuscript);
    const prev = this.get(chapterNumber);
    const hash = sha256Text(text);
    const changed = prev === null || sha256Text(prev) !== hash;

    if (changed) {
      mkdirSync(this.dirOf(chapterNumber), { recursive: true });
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
    chapterNumber: number,
    text: string,
    state?: Omit<EditorState, 'savedAt' | 'sourceHash'>,
  ): { path: string; sourceHash: string; savedAt: string } {
    const hash = sha256Text(text);
    const savedAt = now();
    mkdirSync(this.dirOf(chapterNumber), { recursive: true });
    writeFileSync(this.pathOf(chapterNumber, FILES.autosave), text, {
      encoding: 'utf8',
      flag: 'w',
    });

    if (state) {
      const full: EditorState = { ...state, savedAt, sourceHash: hash };
      writeFileSync(
        this.pathOf(chapterNumber, FILES.editorState),
        JSON.stringify(full, null, 2),
        { encoding: 'utf8', flag: 'w' },
      );
    }

    return { path: this.pathOf(chapterNumber, FILES.autosave), sourceHash: hash, savedAt };
  }

  /** 读编辑器状态；损坏或缺失返回 null（不让坏数据炸掉打开流程） */
  readEditorState(chapterNumber: number): Nullable<EditorState> {
    const p = this.pathOf(chapterNumber, FILES.editorState);
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
  checkRecovery(chapterNumber: number): AutosaveRecoveryCheck {
    const autoPath = this.pathOf(chapterNumber, FILES.autosave);
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
    const manuscript = this.get(chapterNumber);
    const manuscriptHash = manuscript === null ? null : sha256Text(manuscript);

    const state = this.readEditorState(chapterNumber);
    const autoAt = state?.savedAt ?? safeMtime(autoPath);
    const manAt = existsSync(this.pathOf(chapterNumber, FILES.manuscript))
      ? safeMtime(this.pathOf(chapterNumber, FILES.manuscript))
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
  acceptAutosave(chapterNumber: number): Nullable<ManuscriptSaveResult> {
    const rec = this.checkRecovery(chapterNumber);
    if (!rec.hasNewerAutosave || rec.autosaveText === null) return null;
    const res = this.save(chapterNumber, rec.autosaveText);
    this.clearAutosave(chapterNumber);
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
  clearAutosave(chapterNumber: number): void {
    for (const key of [FILES.autosave, FILES.editorState] as const) {
      const p = this.pathOf(chapterNumber, key);
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
    chapterNumber: number,
    editorText?: string,
  ): {
    chapterNumber: number;
    hasManuscript: boolean;
    sourceHash: Nullable<string>;
    savedAt: Nullable<string>;
    dirty: boolean;
    hasPendingAutosave: boolean;
  } {
    const p = this.pathOf(chapterNumber, FILES.manuscript);
    const has = existsSync(p);
    const current = this.get(chapterNumber);
    const currentHash = current === null ? null : sha256Text(current);
    const editorHash = editorText === undefined ? currentHash : sha256Text(editorText);
    const rec = this.checkRecovery(chapterNumber);

    return {
      chapterNumber,
      hasManuscript: has,
      sourceHash: currentHash,
      savedAt: has ? safeMtime(p) : null,
      // 无正文且编辑器有内容 → 也算脏（新建章还没保存过）
      dirty: editorHash !== currentHash,
      hasPendingAutosave: rec.hasNewerAutosave,
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
}

/** 文件 mtime（ISO）；取不到返回 null（不让权限/竞态炸掉调用方） */
function safeMtime(path: string): Nullable<string> {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}
