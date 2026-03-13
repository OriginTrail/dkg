import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB } from '../src/db.js';
import { StructuredLogger } from '../src/structured-logger.js';
import type { OperationContext } from '@origintrail-official/dkg-core';

let db: DashboardDB;
let dir: string;

function ctx(name: string = 'system', id: string = 'test-op'): OperationContext {
  return { operationName: name as any, operationId: id };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-logger-test-'));
  db = new DashboardDB({ dataDir: dir });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('StructuredLogger', () => {
  it('persists info messages to SQLite', () => {
    const logger = new StructuredLogger('TestModule', db);
    logger.info(ctx(), 'hello world');

    const { logs } = db.searchLogs({});
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('info');
    expect(logs[0].module).toBe('TestModule');
    expect(logs[0].message).toBe('hello world');
    expect(logs[0].operation_id).toBe('test-op');
    expect(logs[0].operation_name).toBe('system');
  });

  it('persists warn messages to SQLite', () => {
    const logger = new StructuredLogger('Publisher', db);
    logger.warn(ctx('publish', 'pub-1'), 'low balance');

    const { logs } = db.searchLogs({ level: 'warn' });
    expect(logs).toHaveLength(1);
    expect(logs[0].module).toBe('Publisher');
    expect(logs[0].operation_name).toBe('publish');
  });

  it('persists error messages to SQLite', () => {
    const logger = new StructuredLogger('Chain', db);
    logger.error(ctx('connect', 'conn-1'), 'rpc unreachable');

    const { logs } = db.searchLogs({ level: 'error' });
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('rpc unreachable');
  });

  it('logs are searchable by operation ID', () => {
    const logger = new StructuredLogger('Agent', db);
    logger.info(ctx('sync', 'sync-abc'), 'page 1 received');
    logger.info(ctx('sync', 'sync-abc'), 'page 2 received');
    logger.info(ctx('query', 'query-xyz'), 'unrelated query');

    const result = db.searchLogs({ operationId: 'sync-abc' });
    expect(result.total).toBe(2);
  });

  it('logs are searchable via full-text search', () => {
    const logger = new StructuredLogger('Agent', db);
    logger.info(ctx(), 'merkle root verified for KC 42');
    logger.info(ctx(), 'connection established');

    const result = db.searchLogs({ q: 'merkle' });
    expect(result.total).toBe(1);
    expect(result.logs[0].message).toContain('merkle');
  });

  it('does not throw when DB is closed', () => {
    const logger = new StructuredLogger('Test', db);
    db.close();

    // Should silently catch — never crash the node
    expect(() => logger.info(ctx(), 'after close')).not.toThrow();
  });
});
