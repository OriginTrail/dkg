import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB } from '../src/db.js';

let db: DashboardDB;
let dir: string;

const baseEvent = {
  id: 'semantic-event-1',
  kind: 'file_import',
  idempotency_key: 'assertion-1:file-hash-1:md-hash-1:v1',
  payload_json: JSON.stringify({ assertionUri: 'did:dkg:assertion:1' }),
  status: 'pending' as const,
  attempts: 0,
  max_attempts: 3,
  next_attempt_at: 1_000,
  created_at: 900,
  updated_at: 900,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-semantic-enrichment-db-test-'));
  db = new DashboardDB({ dataDir: dir });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function insertEvent(overrides: Partial<typeof baseEvent> = {}): void {
  db.insertSemanticEnrichmentEvent({ ...baseEvent, ...overrides });
}

describe('DashboardDB — semantic enrichment events', () => {
  it('claims the next runnable event atomically and leases it to one worker', () => {
    insertEvent();

    const claimed = db.claimNextRunnableSemanticEnrichmentEvent(1_000, 'worker-a');
    expect(claimed).toBeDefined();
    expect(claimed!.status).toBe('leased');
    expect(claimed!.lease_owner).toBe('worker-a');
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.lease_expires_at).toBe(1_000 + 5 * 60_000);

    expect(db.getRunnableSemanticEnrichmentEvents(1_000)).toHaveLength(0);
    expect(db.getSemanticEnrichmentHealth(1_000)).toMatchObject({
      pending_count: 0,
      leased_count: 1,
      completed_count: 0,
      dead_letter_count: 0,
    });
  });

  it('renews a lease only for the owning worker before expiry', () => {
    insertEvent();

    const claimed = db.claimNextRunnableSemanticEnrichmentEvent(1_000, 'worker-a');
    expect(claimed).toBeDefined();

    const renewed = db.renewSemanticEnrichmentLease(claimed!.id, 'worker-a', 2_000);
    expect(renewed).toBe(true);

    const row = db.getSemanticEnrichmentEvent(claimed!.id);
    expect(row).toBeDefined();
    expect(row!.lease_owner).toBe('worker-a');
    expect(row!.status).toBe('leased');
    expect(row!.lease_expires_at).toBe(2_000 + 5 * 60_000);
    expect(row!.lease_expires_at).toBeGreaterThan(claimed!.lease_expires_at!);

    expect(db.renewSemanticEnrichmentLease(claimed!.id, 'worker-b', 2_100)).toBe(false);
    expect(db.getSemanticEnrichmentEvent(claimed!.id)!.lease_owner).toBe('worker-a');
  });

  it('reclaims expired leases and ignores a late completion from the orphaned worker', () => {
    insertEvent();

    const claimed = db.claimNextRunnableSemanticEnrichmentEvent(1_000, 'worker-a');
    expect(claimed).toBeDefined();

    const reclaimed = db.reclaimExpiredSemanticEnrichmentEvents(400_000);
    expect(reclaimed).toBe(1);

    const afterReclaim = db.getSemanticEnrichmentEvent(claimed!.id);
    expect(afterReclaim).toBeDefined();
    expect(afterReclaim!.status).toBe('pending');
    expect(afterReclaim!.lease_owner).toBeNull();
    expect(afterReclaim!.lease_expires_at).toBeNull();
    expect(afterReclaim!.next_attempt_at).toBe(400_000);

    expect(db.completeSemanticEnrichmentEvent(claimed!.id, 'worker-a', 400_100)).toBe(false);
    expect(db.getSemanticEnrichmentEvent(claimed!.id)!.status).toBe('pending');

    const reclaimedByNextWorker = db.claimNextRunnableSemanticEnrichmentEvent(400_100, 'worker-b');
    expect(reclaimedByNextWorker).toBeDefined();
    expect(reclaimedByNextWorker!.lease_owner).toBe('worker-b');
    expect(reclaimedByNextWorker!.attempts).toBe(2);
  });

  it('dead-letters expired leases that have already exhausted max attempts', () => {
    insertEvent({
      id: 'semantic-event-exhausted',
      idempotency_key: 'semantic-event-exhausted',
      status: 'leased',
      attempts: 3,
      max_attempts: 3,
      lease_owner: 'worker-a',
      lease_expires_at: 1_500,
      next_attempt_at: 1_000,
    } as Partial<typeof baseEvent> & { lease_owner: string; lease_expires_at: number });

    const reclaimed = db.reclaimExpiredSemanticEnrichmentEvents(2_000);
    expect(reclaimed).toBe(1);

    const row = db.getSemanticEnrichmentEvent('semantic-event-exhausted');
    expect(row).toBeDefined();
    expect(row!.status).toBe('dead_letter');
    expect(row!.lease_owner).toBeNull();
    expect(row!.lease_expires_at).toBeNull();
    expect(db.getRunnableSemanticEnrichmentEvents(2_000)).toHaveLength(0);
  });

  it('schedules a retry with backoff when failure remains under max attempts', () => {
    insertEvent({ max_attempts: 3 });

    const claimed = db.claimNextRunnableSemanticEnrichmentEvent(1_000, 'worker-a');
    expect(claimed).toBeDefined();

    const nextAttemptAt = db.getSemanticEnrichmentNextAttemptAt(1_500, claimed!.attempts);
    expect(nextAttemptAt).toBe(1_500 + 1_000);

    const status = db.failSemanticEnrichmentEvent(
      claimed!.id,
      'worker-a',
      claimed!.attempts,
      claimed!.max_attempts,
      nextAttemptAt,
      1_500,
      'temporary failure',
    );
    expect(status).toBe('pending');

    const row = db.getSemanticEnrichmentEvent(claimed!.id);
    expect(row).toBeDefined();
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(1);
    expect(row!.next_attempt_at).toBe(nextAttemptAt);
    expect(row!.lease_owner).toBeNull();
    expect(row!.lease_expires_at).toBeNull();
    expect(row!.last_error).toBe('temporary failure');
    expect(db.getRunnableSemanticEnrichmentEvents(1_499)).toHaveLength(0);
    expect(db.getRunnableSemanticEnrichmentEvents(nextAttemptAt)).toHaveLength(1);
  });

  it('moves to dead_letter after the final attempt and reports health accurately', () => {
    insertEvent({ max_attempts: 1 });

    const claimed = db.claimNextRunnableSemanticEnrichmentEvent(1_000, 'worker-a');
    expect(claimed).toBeDefined();

    const status = db.failSemanticEnrichmentEvent(
      claimed!.id,
      'worker-a',
      claimed!.attempts,
      claimed!.max_attempts,
      db.getSemanticEnrichmentNextAttemptAt(1_500, claimed!.attempts),
      1_500,
      'permanent failure',
    );
    expect(status).toBe('dead_letter');

    const row = db.getSemanticEnrichmentEvent(claimed!.id);
    expect(row).toBeDefined();
    expect(row!.status).toBe('dead_letter');
    expect(row!.last_error).toBe('permanent failure');
    expect(db.getRunnableSemanticEnrichmentEvents(1_500)).toHaveLength(0);

    const health = db.getSemanticEnrichmentHealth(1_500);
    expect(health).toMatchObject({
      pending_count: 0,
      leased_count: 0,
      completed_count: 0,
      dead_letter_count: 1,
      overdue_pending_count: 0,
      expired_lease_count: 0,
    });
  });

  it('persists semantic triple counts on completed events for idempotent descriptor reuse', () => {
    insertEvent();

    const claimed = db.claimNextRunnableSemanticEnrichmentEvent(1_000, 'worker-a');
    expect(claimed).toBeDefined();

    const completed = db.completeSemanticEnrichmentEvent(claimed!.id, 'worker-a', 1_500, 9);
    expect(completed).toBe(true);

    const row = db.getSemanticEnrichmentEvent(claimed!.id);
    expect(row).toBeDefined();
    expect(row!.status).toBe('completed');
    expect(row!.semantic_triple_count).toBe(9);
  });

  it('dead-letters active semantic events and clears leases so later completions fail closed', () => {
    insertEvent({
      id: 'semantic-event-pending',
      idempotency_key: 'semantic-event-pending',
    });
    insertEvent({
      id: 'semantic-event-leased',
      idempotency_key: 'semantic-event-leased',
      status: 'leased',
      attempts: 1,
      lease_owner: 'worker-a',
      lease_expires_at: 2_000,
    } as Partial<typeof baseEvent> & { lease_owner: string; lease_expires_at: number });

    const rows = db.deadLetterActiveSemanticEnrichmentEvents(3_000, 'semantic worker unavailable');

    expect(rows.map((row) => row.id).sort()).toEqual(['semantic-event-leased', 'semantic-event-pending']);
    expect(db.getSemanticEnrichmentEvent('semantic-event-pending')).toMatchObject({
      status: 'dead_letter',
      lease_owner: null,
      lease_expires_at: null,
      last_error: 'semantic worker unavailable',
    });
    expect(db.getSemanticEnrichmentEvent('semantic-event-leased')).toMatchObject({
      status: 'dead_letter',
      lease_owner: null,
      lease_expires_at: null,
      last_error: 'semantic worker unavailable',
    });
    expect(db.completeSemanticEnrichmentEvent('semantic-event-leased', 'worker-a', 3_100, 2)).toBe(false);
    expect(db.getSemanticEnrichmentEvent('semantic-event-leased')).toMatchObject({
      status: 'dead_letter',
      semantic_triple_count: 0,
    });
  });

  it('does not claim pending rows that have already reached max attempts', () => {
    insertEvent({
      id: 'semantic-event-maxed-pending',
      idempotency_key: 'semantic-event-maxed-pending',
      attempts: 3,
      max_attempts: 3,
      next_attempt_at: 1_000,
    });

    expect(db.getRunnableSemanticEnrichmentEvents(1_000)).toHaveLength(0);
    expect(db.claimNextRunnableSemanticEnrichmentEvent(1_000, 'worker-a')).toBeUndefined();
    expect(db.getSemanticEnrichmentEvent('semantic-event-maxed-pending')?.status).toBe('pending');
  });

  it('prunes completed and dead-letter events but keeps active rows', () => {
    const now = Date.now();
    const oldTs = now - 100_000;

    db.close();
    db = new DashboardDB({ dataDir: dir, retentionDays: 0 });
    db.insertSemanticEnrichmentEvent({
      ...baseEvent,
      id: 'completed-old',
      idempotency_key: 'completed-old',
      status: 'completed',
      attempts: 1,
      max_attempts: 3,
      next_attempt_at: oldTs,
      lease_owner: null,
      lease_expires_at: null,
      last_error: null,
      created_at: oldTs,
      updated_at: oldTs,
    });
    db.insertSemanticEnrichmentEvent({
      ...baseEvent,
      id: 'dead-letter-old',
      idempotency_key: 'dead-letter-old',
      status: 'dead_letter',
      attempts: 1,
      max_attempts: 3,
      next_attempt_at: oldTs,
      lease_owner: null,
      lease_expires_at: null,
      last_error: 'boom',
      created_at: oldTs,
      updated_at: oldTs,
    });
    db.insertSemanticEnrichmentEvent({
      ...baseEvent,
      id: 'pending-old',
      idempotency_key: 'pending-old',
      status: 'pending',
      attempts: 0,
      max_attempts: 3,
      next_attempt_at: oldTs,
      lease_owner: null,
      lease_expires_at: null,
      last_error: null,
      created_at: oldTs,
      updated_at: oldTs,
    });
    db.insertSemanticEnrichmentEvent({
      ...baseEvent,
      id: 'leased-old',
      idempotency_key: 'leased-old',
      status: 'leased',
      attempts: 1,
      max_attempts: 3,
      next_attempt_at: oldTs,
      lease_owner: 'worker-a',
      lease_expires_at: oldTs + 1_000,
      last_error: null,
      created_at: oldTs,
      updated_at: oldTs,
    });

    db.prune();

    expect(db.getSemanticEnrichmentEvent('completed-old')).toBeUndefined();
    expect(db.getSemanticEnrichmentEvent('dead-letter-old')).toBeUndefined();
    expect(db.getSemanticEnrichmentEvent('pending-old')).toBeDefined();
    expect(db.getSemanticEnrichmentEvent('leased-old')).toBeDefined();
  });

  it('stores extraction-status snapshots for restart-safe semantic polling', () => {
    db.upsertExtractionStatusSnapshot({
      assertion_uri: 'did:dkg:context-graph:cg/assertion/peer/roadmap',
      record_json: JSON.stringify({
        status: 'completed',
        fileHash: 'keccak256:file-1',
        detectedContentType: 'text/markdown',
        pipelineUsed: 'text/markdown',
        tripleCount: 7,
        startedAt: '2026-04-15T12:00:00.000Z',
        completedAt: '2026-04-15T12:00:01.000Z',
        semanticEnrichment: {
          eventId: 'evt-1',
          status: 'pending',
          semanticTripleCount: 0,
          updatedAt: '2026-04-15T12:00:01.000Z',
        },
      }),
      updated_at: 1_234,
    });

    expect(db.getExtractionStatusSnapshot('did:dkg:context-graph:cg/assertion/peer/roadmap')).toMatchObject({
      assertion_uri: 'did:dkg:context-graph:cg/assertion/peer/roadmap',
      updated_at: 1_234,
    });

    db.deleteExtractionStatusSnapshot('did:dkg:context-graph:cg/assertion/peer/roadmap');
    expect(db.getExtractionStatusSnapshot('did:dkg:context-graph:cg/assertion/peer/roadmap')).toBeUndefined();
  });
});
