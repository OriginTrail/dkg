import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB } from '../src/db.js';
import { ChatPersistenceQueue, type TurnPersistenceStatusEvent } from '../src/chat-persistence-queue.js';
import type { ChatMemoryManager } from '../src/chat-memory.js';

let db: DashboardDB;
let dir: string;
let queue: ChatPersistenceQueue | null = null;

function waitFor(check: () => boolean, timeoutMs = 6_000, intervalMs = 25): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('ChatPersistenceQueue', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-chat-persist-'));
    db = new DashboardDB({ dataDir: dir });
  });

  afterEach(() => {
    if (queue) {
      queue.dispose();
      queue = null;
    }
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('processes queued turns and marks them stored', async () => {
    const memory = {
      storeChatExchange: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChatMemoryManager;
    queue = new ChatPersistenceQueue(db, memory, { maxAttempts: 3, retryBaseMs: 250, retryMaxMs: 250, batchSize: 2 });

    const events: TurnPersistenceStatusEvent[] = [];
    queue.subscribe((event) => events.push(event));

    queue.enqueue({
      turnId: 'turn-1',
      sessionId: 'session-1',
      userMessage: 'Hello',
      assistantReply: 'Hi there',
    });

    await waitFor(() => events.some((e) => e.turnId === 'turn-1' && e.status === 'stored'));

    expect(memory.storeChatExchange).toHaveBeenCalledTimes(1);
    expect(memory.storeChatExchange).toHaveBeenCalledWith(
      'session-1',
      'Hello',
      'Hi there',
      undefined,
      { turnId: 'turn-1', persistenceState: 'stored' },
    );

    const row = db.getChatPersistenceJob('turn-1');
    expect(row).toBeDefined();
    expect(row!.status).toBe('stored');
    expect(row!.attempts).toBe(1);
    expect(row!.store_ms).toBeTypeOf('number');

    const statuses = events.filter((e) => e.turnId === 'turn-1').map((e) => e.status);
    expect(statuses).toContain('pending');
    expect(statuses).toContain('in_progress');
    expect(statuses).toContain('stored');
  });

  it('retries failed jobs and eventually stores them', async () => {
    const memory = {
      storeChatExchange: vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockResolvedValueOnce(undefined),
    } as unknown as ChatMemoryManager;
    queue = new ChatPersistenceQueue(db, memory, { maxAttempts: 3, retryBaseMs: 250, retryMaxMs: 250 });

    const events: TurnPersistenceStatusEvent[] = [];
    queue.subscribe((event) => events.push(event));

    queue.enqueue({
      turnId: 'turn-2',
      sessionId: 'session-2',
      userMessage: 'retry me',
      assistantReply: 'ok',
    });

    await waitFor(() => events.some((e) => e.turnId === 'turn-2' && e.status === 'stored'));

    expect(memory.storeChatExchange).toHaveBeenCalledTimes(2);
    const retryPending = events.find((e) => e.turnId === 'turn-2' && e.status === 'pending' && e.attempts === 1);
    expect(retryPending?.error).toContain('temporary failure');

    const row = db.getChatPersistenceJob('turn-2');
    expect(row).toBeDefined();
    expect(row!.status).toBe('stored');
    expect(row!.attempts).toBe(2);
  });

  it('marks jobs failed after max attempts and reports health', async () => {
    const memory = {
      storeChatExchange: vi.fn().mockRejectedValue(new Error('hard failure')),
    } as unknown as ChatMemoryManager;
    queue = new ChatPersistenceQueue(db, memory, { maxAttempts: 2, retryBaseMs: 250, retryMaxMs: 250 });

    const events: TurnPersistenceStatusEvent[] = [];
    queue.subscribe((event) => events.push(event));

    queue.enqueue({
      turnId: 'turn-3',
      sessionId: 'session-3',
      userMessage: 'will fail',
      assistantReply: 'nope',
    });

    await waitFor(() => events.some((e) => e.turnId === 'turn-3' && e.status === 'failed'));

    expect(memory.storeChatExchange).toHaveBeenCalledTimes(2);
    const row = db.getChatPersistenceJob('turn-3');
    expect(row).toBeDefined();
    expect(row!.status).toBe('failed');
    expect(row!.attempts).toBe(2);
    expect(row!.error_message).toContain('hard failure');

    const health = queue.getHealthSnapshot();
    expect(health.failed).toBeGreaterThanOrEqual(1);
  });

  it('treats duplicate enqueue for the same turn as idempotent', async () => {
    const memory = {
      storeChatExchange: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChatMemoryManager;
    queue = new ChatPersistenceQueue(db, memory, { maxAttempts: 3, retryBaseMs: 250, retryMaxMs: 250 });

    const first = queue.enqueue({
      turnId: 'turn-idem',
      sessionId: 'session-idem',
      userMessage: 'hello',
      assistantReply: 'world',
    });
    const second = queue.enqueue({
      turnId: 'turn-idem',
      sessionId: 'session-idem',
      userMessage: 'hello',
      assistantReply: 'world',
    });

    expect(first.turnId).toBe('turn-idem');
    expect(second.turnId).toBe('turn-idem');

    await waitFor(() => db.getChatPersistenceJob('turn-idem')?.status === 'stored');
    expect(memory.storeChatExchange).toHaveBeenCalledTimes(1);
    const count = db.db.prepare('SELECT COUNT(*) AS c FROM chat_persistence_jobs WHERE turn_id = ?')
      .get('turn-idem') as { c: number };
    expect(count.c).toBe(1);
  });
});
