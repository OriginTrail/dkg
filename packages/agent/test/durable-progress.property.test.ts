import { expect, it } from 'vitest';
import fc from 'fast-check';
import { DurableSyncAccumulator } from '../src/sync/durable-progress.js';
import { propertyOptions } from '../../../scripts/testing/property-options.js';

const failures = ['timedOutPhases', 'failedPeers', 'failedPhases', 'deniedPhases', 'dataRejectedMissingMeta', 'rejectedKcs', 'deferredBackpressure'] as const;
const event = fc.oneof(
  fc.record({ kind: fc.constant('data'), count: fc.nat(1000) }),
  fc.record({ kind: fc.constant('failure'), field: fc.constantFrom(...failures), count: fc.integer({ min: 1, max: 5 }) }),
  fc.record({ kind: fc.constant('boundary'), reached: fc.boolean() }),
);

it('completion requires a terminal boundary and remains false after any failed segment', () => {
  fc.assert(fc.property(fc.array(event, { maxLength: 80 }), (events) => {
    const accumulator = new DurableSyncAccumulator();
    let triples = 0; let boundaries = 0; let allReached = true; let failed = false;
    for (const item of events) {
      if (item.kind === 'data' && 'count' in item) {
        triples += item.count;
        accumulator.recordDiagnostics({ insertedTriples: item.count, insertedDataTriples: item.count });
      } else if (item.kind === 'failure' && 'field' in item) {
        failed = true;
        accumulator.recordDiagnostics({ [item.field]: item.count });
      } else if ('reached' in item) {
        boundaries++;
        allReached = allReached && item.reached;
        accumulator.recordTerminalBoundary(item.reached, { countCompletedPhase: true });
      }
      const result = accumulator.finalize();
      expect(result.insertedDataTriples).toBe(triples);
      expect(result.complete).toBe(boundaries > 0 && allReached && !failed);
      // Observing progress must not mutate the accumulator's next verdict.
      expect(accumulator.finalize()).toEqual(result);
    }
  }), propertyOptions());
});

it('splitting and regrouping peer segments preserves sums, peer-failure maxima and completion', () => {
  const segment = fc.record({ insertedDataTriples: fc.nat(100), failedPeers: fc.nat(5), completedPhases: fc.nat(3), reached: fc.boolean() });
  fc.assert(fc.property(fc.array(segment, { minLength: 1, maxLength: 30 }), (segments) => {
    const parts = segments.map(({ reached, ...diagnostics }) => new DurableSyncAccumulator().recordDiagnostics(diagnostics).recordTerminalBoundary(reached));
    const direct = parts.reduce((all, part) => all.merge(part), new DurableSyncAccumulator()).finalize();
    const reversed = [...parts].reverse().reduce((all, part) => all.merge(part), new DurableSyncAccumulator()).finalize();
    expect(reversed).toEqual(direct);
    expect(direct.insertedDataTriples).toBe(segments.reduce((sum, part) => sum + part.insertedDataTriples, 0));
    expect(direct.failedPeers).toBe(Math.max(...segments.map((part) => part.failedPeers)));
    expect(direct.complete).toBe(segments.every((part) => part.reached && part.failedPeers === 0) && segments.some((part) => part.completedPhases > 0));
  }), propertyOptions());
});
