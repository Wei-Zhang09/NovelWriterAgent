/**
 * M7 Diff —— 段落对齐 + 段内词级高亮（§十六 / §十七 / §三十七）。
 *
 * ## 作者已确认的决策（施工计划 M7）
 * > 第一版**不做真 hunk 算法**，用"段落对齐 + 段内词级高亮"
 *
 * ## ⚠ 为什么必须有词级层（缺陷 F7）
 *
 * 整段 Diff 的实际缺陷：**一段 300 字里只改了一个词，整段被标成"已修改"**，
 * 作者看不出改了哪 —— 那就等于没做 Diff，作者还得自己逐字找。
 *
 * 所以这里分两层：
 *   段级 —— 定位「哪一段变了」（对齐）
 *   词级 —— 在变了的段里标出「具体改了哪几个词」（染色）
 *
 * ## ⚠ 对齐算法：为什么是 LCS 而不是按序号
 *
 * 按序号对齐（第 n 段对第 n 段）在**插入或删除一段**后会全盘错位：
 * 在第 3 段插入一段后，第 4 段起全部显示为"已修改"，
 * 而实际上后面几十段一个字都没动。
 *
 * LCS（最长公共子序列）能识别出"这段是插进来的"，后面的段落自动对齐回去。
 * 代价是 O(n·m) 时间与空间 —— 但章节段落数在几十到几百量级，
 * 完全可接受；真正的 hunk 算法（Myers）是为**行数极大**的源码 diff 准备的，
 * 对小说正文是过度设计。
 *
 * ## ⚠ 纯函数，不碰 DOM 与 IPC
 *
 * 这样它可以**穷举测试**（施工计划指定的验收方式就是跑纯函数测试）。
 * 渲染层只负责把结果画出来。
 */

/** 段落的变更类型 */
export const CHANGE_KINDS = ['equal', 'insert', 'delete', 'modify'];

/**
 * 把正文切成段落。
 *
 * ⚠ 空白行不算段落，但要**保留它们的数量**吗？不保留 ——
 *   小说正文的段落以换行分隔，空行只是排版空隙。
 *   把空行当段落会让"插入一个空行"显示成"新增一段"，
 *   而作者其实什么都没写。
 *
 * ⚠ 行尾的 `\r` 必须去掉：本仓文件混用 CRLF/LF（工程约定 4），
 *   不去掉的话同一段在两个版本里可能一个带 `\r` 一个不带，
 *   于是**内容完全相同却显示为已修改**。
 */
export function splitParagraphs(text) {
  if (typeof text !== 'string') return [];
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 段内词级差异 —— 返回给渲染层的高亮片段。
 *
 * ## ⚠ 为什么按"字符级 LCS"而不是按词
 *
 * 中文没有空格分词。用 `split(/\s+/)` 切"词"，一整段中文会被当成
 * **一个词** —— 于是"改了两个字"变成"整个词被替换"，
 * 又回到 F7 那个"看不出改了哪"的问题。
 *
 * 按字符做 LCS 对中文是正确的粒度：改动会被精确到字。
 * 对英文会略显碎（一个单词可能被拆成几段高亮），但小说以中文为主，
 * 且碎总比"整段标红"好。
 *
 * ## ⚠ 代价与取舍
 *
 * 字符级 LCS 是 O(n·m)。单段正文通常几十到几百字，
 * 最坏情况 500×500 = 25 万格 —— 单段可接受。
 * 但**整章**逐段做下来在长章（5000 字）会明显卡顿，
 * 所以调用方必须**只对 modify 的段**做词级比较，
 * 不要对 equal 的段也做（那是纯粹的浪费）。
 *
 * 返回值：`{ text, changed }[]` —— 相邻且 changed 相同的片段会合并，
 * 避免渲染出一堆零碎 span。
 */
export function diffWords(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');

  const m = left.length;
  const n = right.length;

  // 逐字符 LCS 长度表
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] =
        left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // 回溯，产出左右两侧各自的片段
  const outLeft = [];
  const outRight = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (left[i] === right[j]) {
      push(outLeft, left[i], false);
      push(outRight, right[j], false);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // 左侧这一字在右侧找不到 → 删除
      push(outLeft, left[i], true);
      i += 1;
    } else {
      // 右侧这一字是新增的
      push(outRight, right[j], true);
      j += 1;
    }
  }
  while (i < m) {
    push(outLeft, left[i], true);
    i += 1;
  }
  while (j < n) {
    push(outRight, right[j], true);
    j += 1;
  }

  return { left: outLeft, right: outRight };
}

/** 追加片段；与上一段 changed 相同则合并（少产出零碎 span） */
function push(list, text, changed) {
  const last = list[list.length - 1];
  if (last && last.changed === changed) {
    last.text += text;
  } else {
    list.push({ text, changed });
  }
}

/**
 * 段落对齐 + 逐段变更判定。
 *
 * @param {string} oldText 旧版正文
 * @param {string} newText 新版正文
 * @returns {{ kind: string, oldIndex: number|null, newIndex: number|null,
 *             oldText: string|null, newText: string|null,
 *             words: { left: object[], right: object[] } | null }[]}
 *
 * ⚠ `oldIndex` / `newIndex` 是**各自版本内的段号**（0 起），
 *   不是同一个坐标系。插入段的 `oldIndex` 是 `null`，删除段反之 ——
 *   界面据此决定"这一侧要不要留空位"，用同一个索引会错位。
 */
export function diffParagraphs(oldText, newText) {
  const a = splitParagraphs(oldText);
  const b = splitParagraphs(newText);

  // 段落级 LCS：先找出两边共同的部分
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  /** 先收集"严格相等"的配对，剩下的是插入/删除候选 */
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      pairs.push({ oldIndex: i, newIndex: j });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pairs.push({ oldIndex: i, newIndex: null });
      i += 1;
    } else {
      pairs.push({ oldIndex: null, newIndex: j });
      j += 1;
    }
  }
  while (i < m) {
    pairs.push({ oldIndex: i, newIndex: null });
    i += 1;
  }
  while (j < n) {
    pairs.push({ oldIndex: null, newIndex: j });
    j += 1;
  }

  // ⚠ 相邻的"删除 + 插入"应合并成 **modify**（一段被改写），
  //   而不是显示成"删了一段、又加了一段"。
  //   作者的直觉是"我改了这一段"，而删+增的呈现方式会让他以为
  //   段落顺序变了 —— 那是两件完全不同的事。
  const out = [];
  for (let k = 0; k < pairs.length; k += 1) {
    const cur = pairs[k];
    const next = pairs[k + 1];

    if (cur.oldIndex !== null && cur.newIndex !== null) {
      out.push({
        kind: 'equal',
        oldIndex: cur.oldIndex,
        newIndex: cur.newIndex,
        oldText: a[cur.oldIndex],
        newText: b[cur.newIndex],
        words: null,
      });
      continue;
    }

    // 删除紧跟插入（或反之）→ 视为改写
    if (
      cur.oldIndex !== null &&
      cur.newIndex === null &&
      next &&
      next.oldIndex === null &&
      next.newIndex !== null
    ) {
      out.push({
        kind: 'modify',
        oldIndex: cur.oldIndex,
        newIndex: next.newIndex,
        oldText: a[cur.oldIndex],
        newText: b[next.newIndex],
        // ⚠ 只对 modify 段做词级比较（字符级 LCS 不便宜）
        words: diffWords(a[cur.oldIndex], b[next.newIndex]),
      });
      k += 1; // 消耗掉 next
      continue;
    }
    if (
      cur.oldIndex === null &&
      cur.newIndex !== null &&
      next &&
      next.oldIndex !== null &&
      next.newIndex === null
    ) {
      out.push({
        kind: 'modify',
        oldIndex: next.oldIndex,
        newIndex: cur.newIndex,
        oldText: a[next.oldIndex],
        newText: b[cur.newIndex],
        words: diffWords(a[next.oldIndex], b[cur.newIndex]),
      });
      k += 1;
      continue;
    }

    if (cur.oldIndex !== null) {
      out.push({
        kind: 'delete',
        oldIndex: cur.oldIndex,
        newIndex: null,
        oldText: a[cur.oldIndex],
        newText: null,
        words: null,
      });
    } else {
      out.push({
        kind: 'insert',
        oldIndex: null,
        newIndex: cur.newIndex,
        oldText: null,
        newText: b[cur.newIndex],
        words: null,
      });
    }
  }

  return out;
}

/** 统计各类变更的段数（界面显示"改了几段"） */
export function summarizeHunks(hunks) {
  const counts = { equal: 0, insert: 0, delete: 0, modify: 0 };
  for (const h of hunks ?? []) {
    if (counts[h.kind] !== undefined) counts[h.kind] += 1;
  }
  return {
    ...counts,
    /** 有变化的段数（不含 equal）—— 这才是作者关心的"改了哪几段" */
    changed: counts.insert + counts.delete + counts.modify,
    total: (hunks ?? []).length,
  };
}
