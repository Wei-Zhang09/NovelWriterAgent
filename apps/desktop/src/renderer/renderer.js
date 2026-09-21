/**
 * 渲染进程（纯 JS，无构建步骤）
 *
 * STEP 0 目标：验证「renderer → main → utilityProcess → storage」整条链路贯通。
 * 四栏自检项对应施工计划 STEP 0 的 spike 结论，UI 上直接可视化。
 */
const $ = (id) => document.getElementById(id);

function renderCheck(label, state, value) {
  const cls = state === 'ok' ? 'ok' : state === 'err' ? 'err' : 'wait';
  return `<div class="check">
    <span class="dot dot--${cls}"></span>
    <span class="label">${label}</span>
    <span class="value">${value}</span>
  </div>`;
}

async function invoke(method, params) {
  return window.nwa.invoke(method, params);
}

async function run() {
  const checks = [];

  // 1. 进程与版本
  const info = await window.nwa.appInfo();
  $('ver').textContent = `Electron ${info.electron} · Node ${info.node}`;
  checks.push(renderCheck('Electron / Node', 'ok', `Electron ${info.electron} · Node ${info.node}`));

  // 2. core utilityProcess 通路
  try {
    const health = await invoke('core.health');
    if (health.ok) {
      checks.push(renderCheck(
        'core utilityProcess（ADR-0001）', 'ok',
        `pid ${health.data.pid} · node ${health.data.node} · sqlite ${health.data.sqlite}`,
      ));
    } else {
      checks.push(renderCheck('core utilityProcess', 'err', health.error.message));
    }
  } catch (e) {
    checks.push(renderCheck('core utilityProcess', 'err', String(e)));
  }

  // 3. SQLite 迁移
  try {
    const mig = await invoke('core.migrations');
    if (mig.ok) {
      const ids = mig.data.applied.map((m) => m.id).join(', ');
      checks.push(renderCheck('迁移已应用', mig.data.applied.length > 0 ? 'ok' : 'err', ids || '（无）'));
    } else {
      checks.push(renderCheck('迁移已应用', 'err', mig.error.message));
    }
  } catch (e) {
    checks.push(renderCheck('迁移已应用', 'err', String(e)));
  }

  // 4. Schema 统计（验证 22 张表 + 索引 + 外键）
  let stats = null;
  try {
    const r = await invoke('core.schema.stats');
    if (r.ok) {
      stats = r.data;
      const expectTables = 22;
      checks.push(renderCheck(
        '数据表 / 索引', stats.tableCount >= expectTables ? 'ok' : 'wait',
        `${stats.tableCount} 张表 · ${stats.indexCount} 个索引 · ${stats.ftsCount} 张 FTS`,
      ));
      $('diag').textContent =
        `表清单（${stats.tableCount}）：\n` + stats.tables.map((t) => '  · ' + t).join('\n');
    } else {
      checks.push(renderCheck('数据表 / 索引', 'err', r.error.message));
    }
  } catch (e) {
    checks.push(renderCheck('数据表 / 索引', 'err', String(e)));
  }

  // 5. FTS5 + BM25（ADR-0004 的基础）
  try {
    const r = await invoke('core.fts.probe');
    if (r.ok) {
      checks.push(renderCheck(
        'FTS5 + bm25()（ADR-0004）', r.data.bm25Works ? 'ok' : 'err',
        r.data.bm25Works ? 'MATCH 命中 1 行，bm25 排序可用' : 'FTS5 可用但 bm25 排序异常',
      ));
    } else {
      checks.push(renderCheck('FTS5 + bm25()', 'err', r.error.message));
    }
  } catch (e) {
    checks.push(renderCheck('FTS5 + bm25()', 'err', String(e)));
  }

  $('checks').innerHTML = checks.join('');
}

window.nwa.onCoreExited((p) => {
  $('diag').textContent = `core 进程已退出：${JSON.stringify(p)}\n（UI 存活 —— ADR-0001 的进程隔离生效）`;
});

run().catch((e) => {
  $('checks').innerHTML = renderCheck('启动失败', 'err', String(e));
});
