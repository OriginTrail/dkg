import { describe, expect, it, vi } from 'vitest';

import { StorePriorityScheduler } from '../../src/store-priority-scheduler.js';
import type { TripleStore } from '../../src/triple-store.js';
import type {
  Rfc64SharedProjectionStreamCapabilityV1,
} from '../../src/rfc64-shared-projection-stream-capability.js';
import { createRfc64SharedProjectionTestFixture } from './rfc64-shared-projection-fixture.js';
import {
  collectProjectionBytes as collect,
  projectionByteStream as byteStream,
} from './rfc64-projection-stream-test-io.js';

const FIXTURE = createRfc64SharedProjectionTestFixture();
const LINE_A = '<urn:a> <urn:p> "alpha" .\n';
const LINE_Z = '<urn:z> <urn:p> "zeta" .\n';

export interface Rfc64HttpProjectionCapabilityConformanceOptions {
  readonly adapterName: string;
  readonly createStore: (
    scheduler: StorePriorityScheduler,
    timeoutMs: number,
  ) => TripleStore & Rfc64SharedProjectionStreamCapabilityV1;
}

/** Shared HTTP capability contract; vendor suites retain only vendor-specific assertions. */
export function runRfc64HttpProjectionCapabilityConformance(
  options: Rfc64HttpProjectionCapabilityConformanceOptions,
): void {
  describe(`${options.adapterName} RFC-64 HTTP projection capability conformance`, () => {
    it('sorts graphless output under background scheduler admission', async () => {
      const scheduler = new StorePriorityScheduler({ maxConcurrent: 2, ackReservedSlots: 0 });
      const schedule = vi.spyOn(scheduler, 'run');
      globalThis.fetch = (async () => new Response(byteStream([LINE_Z, LINE_A]), {
        status: 200,
      })) as typeof fetch;
      const store = options.createStore(scheduler, 1_000);

      const source = await store.rfc64SharedProjectionStreamV1(FIXTURE.operation, {
        byteCeiling: 4096,
      });

      expect(await collect(source)).toEqual(FIXTURE.projectionBytes);
      expect(schedule).toHaveBeenCalledWith(
        'background',
        'rfc64.shared-projection.SYNC_KA_SHARED_PROJECTION_STREAM_V1',
        expect.any(Function),
        expect.any(AbortSignal),
        { storeOperation: 'construct' },
      );
    });

    it('accepts the authenticated named graph and rejects a foreign graph', async () => {
      const scheduler = new StorePriorityScheduler({ maxConcurrent: 2, ackReservedSlots: 0 });
      const store = options.createStore(scheduler, 1_000);
      globalThis.fetch = (async () => new Response(
        `<urn:a> <urn:p> "alpha" <${FIXTURE.graph}> .\n`,
        { status: 200 },
      )) as typeof fetch;
      const exact = await store.rfc64SharedProjectionStreamV1(
        oneTripleOperation(),
        { byteCeiling: 4096 },
      );
      expect(await collect(exact)).toEqual(new TextEncoder().encode(LINE_A));

      globalThis.fetch = (async () => new Response(
        '<urn:a> <urn:p> "alpha" <urn:foreign> .\n',
        { status: 200 },
      )) as typeof fetch;
      await expect(store.rfc64SharedProjectionStreamV1(
        oneTripleOperation(),
        { byteCeiling: 4096 },
      )).rejects.toThrow('escaped the exact authenticated graph');
    });

    it('holds scheduler admission through body consumption and aborts promptly', async () => {
      const scheduler = new StorePriorityScheduler({ maxConcurrent: 2, ackReservedSlots: 0 });
      const started = Promise.withResolvers<void>();
      let transportSignal: AbortSignal | null = null;
      globalThis.fetch = (async (_input, init) => {
        transportSignal = init?.signal as AbortSignal;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(LINE_A));
            started.resolve();
            transportSignal?.addEventListener('abort', () => {
              controller.error(transportSignal?.reason);
            }, { once: true });
          },
        }), { status: 200 });
      }) as typeof fetch;
      const store = options.createStore(scheduler, 30_000);
      const abort = new AbortController();

      const pending = store.rfc64SharedProjectionStreamV1(FIXTURE.operation, {
        byteCeiling: 4096,
        signal: abort.signal,
      });
      await started.promise;
      expect(scheduler.snapshot.backgroundInflight).toBe(1);
      abort.abort(new DOMException('caller stopped', 'AbortError'));

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(transportSignal?.aborted).toBe(true);
      await vi.waitFor(() => expect(scheduler.snapshot.backgroundInflight).toBe(0));
    });

    it('uses the configured store deadline while a successful body is stalled', async () => {
      const scheduler = new StorePriorityScheduler({ maxConcurrent: 2, ackReservedSlots: 0 });
      const started = Promise.withResolvers<void>();
      let transportSignal: AbortSignal | null = null;
      globalThis.fetch = (async (_input, init) => {
        transportSignal = init?.signal as AbortSignal;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(LINE_A));
            started.resolve();
            transportSignal?.addEventListener('abort', () => {
              controller.error(transportSignal?.reason);
            }, { once: true });
          },
        }), { status: 200 });
      }) as typeof fetch;
      const store = options.createStore(scheduler, 20);

      const pending = store.rfc64SharedProjectionStreamV1(FIXTURE.operation, {
        byteCeiling: 4096,
      });
      await started.promise;
      expect(scheduler.snapshot.backgroundInflight).toBe(1);

      await expect(pending).rejects.toMatchObject({
        code: 'STORE_OPERATION_TIMEOUT',
        operation: 'construct',
      });
      expect(transportSignal?.aborted).toBe(true);
      await vi.waitFor(() => expect(scheduler.snapshot.backgroundInflight).toBe(0));
    });

    it('keeps caller cancellation live after the spool releases its scheduler slot', async () => {
      const scheduler = new StorePriorityScheduler({ maxConcurrent: 2, ackReservedSlots: 0 });
      globalThis.fetch = (async () => new Response(byteStream([LINE_Z, LINE_A]), {
        status: 200,
      })) as typeof fetch;
      const store = options.createStore(scheduler, 1_000);
      const abort = new AbortController();
      const source = await store.rfc64SharedProjectionStreamV1(FIXTURE.operation, {
        byteCeiling: 4096,
        signal: abort.signal,
      });
      await vi.waitFor(() => expect(scheduler.snapshot.backgroundInflight).toBe(0));

      const reason = new DOMException('consumer stopped', 'AbortError');
      abort.abort(reason);

      await expect(collect(source)).rejects.toBe(reason);
    });
  });
}

function oneTripleOperation() {
  const fixture = createRfc64SharedProjectionTestFixture({
    triples: [{ subject: 'urn:a', predicate: 'urn:p', object: '"alpha"' }],
  });
  return fixture.operation;
}
