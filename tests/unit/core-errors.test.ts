/**
 * @nwa/core 错误码语义测试
 *
 * 重点：施工文档 §55 Rule 8「禁止 try/catch 吞异常」的落地保障 ——
 * AppError.from() 必须保留原始信息，不得丢栈丢 code。
 */
import { describe, it, expect } from 'vitest';
import { AppError, ErrorCode } from '@nwa/core';

describe('AppError', () => {
  it('按错误码赋予默认可恢复/可重试语义', () => {
    const timeout = new AppError(ErrorCode.MODEL_TIMEOUT, '超时');
    expect(timeout.recoverable).toBe(true);
    expect(timeout.retryable).toBe(true);

    const authErr = new AppError(ErrorCode.MODEL_AUTH_FAILED, '鉴权失败');
    expect(authErr.recoverable).toBe(false);
    expect(authErr.retryable).toBe(false);
  });

  it('BLOCKING 类一致性错误不可自动恢复', () => {
    const blocked = new AppError(ErrorCode.CONTINUITY_BLOCKED, '已死亡角色复活');
    expect(blocked.retryable).toBe(false);
  });

  it('CAS 冲突与硬链接别名必须不可自动解决（ADR-0002 v2）', () => {
    expect(new AppError(ErrorCode.COMMIT_CONFLICT, 'x').retryable).toBe(false);
    expect(new AppError(ErrorCode.COMMIT_ALIAS_DETECTED, 'x').recoverable).toBe(false);
    expect(new AppError(ErrorCode.WORKSPACE_CORRUPTED, 'x').recoverable).toBe(false);
  });

  it('可覆盖默认语义', () => {
    const e = new AppError(ErrorCode.MODEL_TIMEOUT, 'x', { retryable: false });
    expect(e.retryable).toBe(false);
  });

  it('from() 保留 Error 的原始信息，不丢失', () => {
    const original = new Error('底层失败');
    const wrapped = AppError.from(original);
    expect(wrapped.message).toBe('底层失败');
    expect(wrapped.cause).toBe(original);
  });

  it('from() 幂等：已是 AppError 则原样返回', () => {
    const e = new AppError(ErrorCode.CANON_CONFLICT, 'x');
    expect(AppError.from(e)).toBe(e);
  });

  it('from() 处理非 Error 抛出物', () => {
    const wrapped = AppError.from('字符串错误');
    expect(wrapped.message).toBe('字符串错误');
    expect(wrapped.details).toBe('字符串错误');
  });

  it('toJSON 可安全写入 run_events.payload_json', () => {
    const json = new AppError(ErrorCode.TOOL_VALIDATION_ERROR, 'x', { details: { a: 1 } }).toJSON();
    expect(() => JSON.stringify(json)).not.toThrow();
    expect(json.code).toBe('TOOL_VALIDATION_ERROR');
  });
});
