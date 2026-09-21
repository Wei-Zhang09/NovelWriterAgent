/**
 * 仓储层公共类型与工具
 *
 * 设计约束（施工计划 STEP 1）：
 *   仓储**只暴露领域方法**，不暴露裸 SQL。业务包（story/writing/harness）
 *   不得自己拼 SQL，否则 §59 的「真源/派生」边界会失去单一控制点。
 */
import { AppError, ErrorCode } from '@nwa/core';

/** 所有持久化实体的公共字段（时间戳统一 ISO 8601 UTC 字符串） */
export interface Timestamped {
  readonly created_at: string;
  readonly updated_at: string;
}

/** 当前时间的统一表示，避免各处 new Date().toISOString() 格式漂移 */
export function now(): string {
  return new Date().toISOString();
}

/**
 * 断言查询返回了行；用于「按主键取一条，取不到即错误」的场景。
 *
 * 不用 `!` 强断言 —— 那会在数据缺失时产生难以定位的 undefined 传播。
 */
export function requireRow<T>(row: T | undefined, what: string, id: string): T {
  if (row === undefined) {
    throw new AppError(ErrorCode.STORAGE_QUERY_FAILED, `${what} 不存在：${id}`, {
      details: { entity: what, id },
    });
  }
  return row;
}

/**
 * JSON 列的读取封装。
 *
 * 约定：JSON 列在 DB 中为 TEXT，读出来必须经过一次显式解析。
 * 解析失败**不静默返回默认值** —— 那会把数据损坏伪装成「字段为空」。
 */
export function parseJsonColumn<T>(raw: string | null, column: string, id: string): T | null {
  if (raw === null || raw === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new AppError(ErrorCode.WORKSPACE_CORRUPTED, `字段 ${column} 不是合法 JSON（${id}）`, {
      cause,
      details: { column, id, head: raw.slice(0, 120) },
    });
  }
}

/** JSON 列的写入封装：undefined/null 统一写 NULL，不写字符串 "undefined" */
export function serializeJsonColumn(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/** 布尔在 SQLite 中用 0/1 表示（memory_items.protected / compressible） */
export const toSqlBool = (v: boolean): number => (v ? 1 : 0);
export const fromSqlBool = (v: number): boolean => v !== 0;
