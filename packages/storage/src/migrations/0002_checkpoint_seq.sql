-- ═══════════════════════════════════════════════════════════════════
-- 0002：checkpoints 增加 seq 列
--
-- 原因（STEP 4 实测）：latestCheckpoint 原先按 created_at DESC 排序，
-- 但同一毫秒内写入的两个 checkpoint 时间戳相同，排序结果不确定，
-- 导致 resume 恢复到的阶段不稳定（测试间歇失败复现）。
--
-- 用 per-run 单调递增的 seq 作为主排序键。
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE checkpoints ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

-- 回填已有数据的 seq（按 created_at 顺序编号）
UPDATE checkpoints SET seq = (
  SELECT COUNT(*) FROM checkpoints c2
  WHERE c2.run_id = checkpoints.run_id
    AND (c2.created_at < checkpoints.created_at
         OR (c2.created_at = checkpoints.created_at AND c2.id <= checkpoints.id))
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_run_seq ON checkpoints(run_id, seq DESC);
