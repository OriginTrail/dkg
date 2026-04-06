import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB } from '../src/db.js';
import { OperationTracker } from '../src/operation-tracker.js';
import type { OperationContext } from '@origintrail-official/dkg-core';

let db: DashboardDB;
let dir: string;
let tracker: OperationTracker;

function ctx(name: string, id: string): OperationContext {
  return { operationName: name as any, operationId: id };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-tracker-test-'));
  db = new DashboardDB({ dataDir: dir });
  tracker = new OperationTracker(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('OperationTracker', () => {
  it('tracks start → complete lifecycle', () => {
    const c = ctx('publish', 'op-1');
    tracker.start(c, { peerId: 'peer-abc', contextGraphId: 'testing' });

    let op = db.getOperation('op-1').operation;
    expect(op).toBeDefined();
    expect(op!.status).toBe('in_progress');
    expect(op!.peer_id).toBe('peer-abc');
    expect(op!.paranet_id).toBe('testing');

    tracker.complete(c, { tripleCount: 50 });

    op = db.getOperation('op-1').operation;
    expect(op!.status).toBe('success');
    expect(op!.triple_count).toBe(50);
    expect(op!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('tracks start → fail lifecycle', () => {
    const c = ctx('sync', 'op-2');
    tracker.start(c);
    tracker.fail(c, new Error('timeout'));

    const op = db.getOperation('op-2').operation;
    expect(op!.status).toBe('error');
    expect(op!.error_message).toBe('timeout');
  });

  it('handles fail with non-Error objects', () => {
    const c = ctx('query', 'op-3');
    tracker.start(c);
    tracker.fail(c, 'string error');

    const op = db.getOperation('op-3').operation;
    expect(op!.error_message).toBe('string error');
  });

  it('stores details as JSON', () => {
    const c = ctx('publish', 'op-4');
    tracker.start(c, { details: { quads: 100, contextGraph: 'testing' } });

    const op = db.getOperation('op-4').operation;
    const details = JSON.parse(op!.details!);
    expect(details.quads).toBe(100);
  });

  it('is a no-op when db is null', () => {
    const nullTracker = new OperationTracker(null);
    const c = ctx('publish', 'op-5');

    // These should not throw
    nullTracker.start(c);
    nullTracker.complete(c);
    nullTracker.fail(c, new Error('test'));
  });

  it('never throws even if DB is broken', () => {
    const c = ctx('publish', 'op-6');
    tracker.start(c);
    db.close();

    // Should silently catch the error, not throw
    expect(() => tracker.complete(c)).not.toThrow();
  });

  it('tracks phase lifecycle (startPhase → completePhase)', async () => {
    const c = ctx('publish', 'op-phases');
    tracker.start(c, { contextGraphId: 'testing' });

    tracker.startPhase(c, 'prepare');
    await new Promise(r => setTimeout(r, 10));
    tracker.completePhase(c, 'prepare');

    tracker.startPhase(c, 'store');
    await new Promise(r => setTimeout(r, 10));
    tracker.completePhase(c, 'store');

    tracker.complete(c);

    const { phases } = db.getOperation('op-phases');
    expect(phases).toHaveLength(2);
    expect(phases[0].phase).toBe('prepare');
    expect(phases[0].status).toBe('success');
    expect(phases[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(phases[1].phase).toBe('store');
    expect(phases[1].status).toBe('success');
  });

  it('sets cost via setCost()', () => {
    const c = ctx('publish', 'op-cost');
    tracker.start(c);
    tracker.setCost(c, {
      gasUsed: 210000n,
      gasPrice: 250000000n,
      gasCost: 52500000000000n,
      tracCost: 500000000000000000n,
    });
    tracker.complete(c);

    const { operation } = db.getOperation('op-cost');
    expect(operation!.gas_used).toBe(210000);
    expect(operation!.gas_price_gwei).toBeCloseTo(0.25);
    expect(operation!.gas_cost_eth).toBeCloseTo(0.0000525);
    expect(operation!.trac_cost).toBeCloseTo(0.5);
  });

  it('sets tx hash via setTxHash()', () => {
    const c = ctx('publish', 'op-tx');
    tracker.start(c);
    tracker.setTxHash(c, '0xdeadbeef', 84532);
    tracker.complete(c);

    const { operation } = db.getOperation('op-tx');
    expect(operation!.tx_hash).toBe('0xdeadbeef');
    expect(operation!.chain_id).toBe(84532);
  });

  it('phase/cost methods are no-ops when db is null', () => {
    const nullTracker = new OperationTracker(null);
    const c = ctx('publish', 'op-null');
    nullTracker.startPhase(c, 'prepare');
    nullTracker.completePhase(c, 'prepare');
    nullTracker.setCost(c, { gasUsed: 100n });
    nullTracker.setTxHash(c, '0xabc');
  });

  // --- Nested phase cleanup on fail() ---------------------------------

  it('fail() cleans up ALL active phases, not just one', async () => {
    const c = ctx('publish', 'op-nested-fail');
    tracker.start(c, { contextGraphId: 'testing' });

    // Start nested phases: prepare > prepare:merkle (both active)
    tracker.startPhase(c, 'prepare');
    tracker.startPhase(c, 'prepare:merkle');
    await new Promise(r => setTimeout(r, 5));

    // Fail the whole operation — both phase keys must be cleaned up
    tracker.fail(c, new Error('chain reverted'));

    const { operation, phases } = db.getOperation('op-nested-fail');
    expect(operation!.status).toBe('error');
    expect(operation!.error_message).toBe('chain reverted');

    // Both phases should have been failed (not left dangling)
    const failedPhases = phases.filter(p => p.status === 'error');
    expect(failedPhases.length).toBe(2);
    expect(failedPhases.map(p => p.phase).sort()).toEqual(['prepare', 'prepare:merkle']);
  });

  it('fail() with no active phases still fails the operation', () => {
    const c = ctx('sync', 'op-no-phases');
    tracker.start(c);
    tracker.fail(c, new Error('timeout'));

    const { operation, phases } = db.getOperation('op-no-phases');
    expect(operation!.status).toBe('error');
    expect(phases.filter(p => p.status === 'error')).toHaveLength(0);
  });

  it('fail() does not affect phases from other operations', async () => {
    const c1 = ctx('publish', 'op-A');
    const c2 = ctx('sync', 'op-B');

    tracker.start(c1);
    tracker.start(c2);
    tracker.startPhase(c1, 'prepare');
    tracker.startPhase(c2, 'fetch');
    await new Promise(r => setTimeout(r, 5));

    // Fail op-A — op-B's phase should be untouched
    tracker.fail(c1, new Error('boom'));

    // op-B should still be in progress
    const { operation: opB } = db.getOperation('op-B');
    expect(opB!.status).toBe('in_progress');

    // Complete op-B normally
    tracker.completePhase(c2, 'fetch');
    tracker.complete(c2);
    const { operation: opB2, phases: phasesB } = db.getOperation('op-B');
    expect(opB2!.status).toBe('success');
    expect(phasesB[0].phase).toBe('fetch');
    expect(phasesB[0].status).toBe('success');
  });

  // --- phaseCallback() helper ------------------------------------------

  it('phaseCallback() produces a working start/end callback', async () => {
    const c = ctx('publish', 'op-cb');
    tracker.start(c);

    const cb = tracker.phaseCallback(c);

    cb('prepare', 'start');
    await new Promise(r => setTimeout(r, 5));
    cb('prepare', 'end');

    cb('store', 'start');
    await new Promise(r => setTimeout(r, 5));
    cb('store', 'end');

    tracker.complete(c);

    const { phases } = db.getOperation('op-cb');
    expect(phases).toHaveLength(2);
    expect(phases[0].phase).toBe('prepare');
    expect(phases[0].status).toBe('success');
    expect(phases[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(phases[1].phase).toBe('store');
    expect(phases[1].status).toBe('success');
  });

  // --- trackPhase() async helper ---------------------------------------

  it('trackPhase() completes phase on success', async () => {
    const c = ctx('publish', 'op-track');
    tracker.start(c);

    const result = await tracker.trackPhase(c, 'prepare', async () => {
      await new Promise(r => setTimeout(r, 5));
      return 42;
    });

    expect(result).toBe(42);
    tracker.complete(c);

    const { phases } = db.getOperation('op-track');
    expect(phases).toHaveLength(1);
    expect(phases[0].phase).toBe('prepare');
    expect(phases[0].status).toBe('success');
  });

  it('trackPhase() fails phase and re-throws on error', async () => {
    const c = ctx('publish', 'op-track-err');
    tracker.start(c);

    await expect(
      tracker.trackPhase(c, 'chain', async () => {
        throw new Error('tx reverted');
      }),
    ).rejects.toThrow('tx reverted');

    tracker.fail(c, new Error('tx reverted'));

    const { phases } = db.getOperation('op-track-err');
    const chainPhase = phases.find(p => p.phase === 'chain');
    expect(chainPhase).toBeDefined();
    expect(chainPhase!.status).toBe('error');
  });
});
