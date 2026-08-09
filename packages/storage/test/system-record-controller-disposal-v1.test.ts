import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Adapter registration is a side effect of importing the module.
import '../src/adapters/sparql-http.js';

import {
  attachManagedOxigraphLeaseV1,
  createManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphSupervisorHandoffV1,
} from '../src/internal/managed-oxigraph-ownership-v1.js';
import type { SystemRecordLaneActivationV1 } from '../src/system-record-materializer-v1.js';
import { createTripleStore, type TripleStore } from '../src/triple-store.js';

let QUERY_ENDPOINT: string;
let UPDATE_ENDPOINT: string;
const ACTIVATION: SystemRecordLaneActivationV1 = {
  networkId: 'testnet',
  kinds: ['agents'],
  mode: 'shadow',
};

/**
 * The process-global lane registration must be released by `store.close()`.
 *
 * NOTE, and it is the point of this file: nothing here calls
 * `__resetSystemRecordControllerRegistrationForTests`. That helper clears the
 * global UNCONDITIONALLY, which is precisely what the production path must never
 * do, and a `beforeEach` that used it would keep every test in this file green
 * even if `close()` released nothing at all. Each test therefore hands the
 * registration to the next one through the production path, or it fails.
 */
describe('system-record controller disposal', () => {
  let stores: TripleStore[];
  let server: Server;
  let epoch: string | null;

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        if (request.url === '/query') {
          response.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
          response.end(JSON.stringify({
            head: { vars: ['epoch'] },
            results: {
              bindings: epoch === null ? [] : [{ epoch: { type: 'literal', value: epoch } }],
            },
          }));
          return;
        }
        const inserted = /INSERT[\s\S]*?materialization-epoch> "([0-9]+)"/u.exec(body)?.[1];
        if (inserted !== undefined) epoch = inserted;
        response.writeHead(204);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    QUERY_ENDPOINT = `http://127.0.0.1:${port}/query`;
    UPDATE_ENDPOINT = `http://127.0.0.1:${port}/update`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const recordingSupervisor = () => {
    const calls: string[] = [];
    const handoff: ManagedOxigraphSupervisorHandoffV1 = {
      stopAndProveOwnedChildDead: async () => {
        calls.push('stop');
      },
      startAndProveCleanGeneration: async () => {
        calls.push('start');
      },
    };
    return { calls, handoff };
  };

  const managedStore = async (
    handoff: ManagedOxigraphSupervisorHandoffV1,
    ownership: ManagedOxigraphOwnershipControllerV1,
  ): Promise<TripleStore> => {
    const store = await createTripleStore({
      backend: 'sparql-http',
      options: attachManagedOxigraphLeaseV1(
        {
          queryEndpoint: QUERY_ENDPOINT,
          updateEndpoint: UPDATE_ENDPOINT,
          managedByDkg: true,
        },
        ownership.lease,
        handoff,
      ) as unknown as Record<string, unknown>,
      graphSetIndex: false,
    });
    stores.push(store);
    return store;
  };

  const freshOwnership = () => {
    const ownership = createManagedOxigraphOwnershipControllerV1(
      QUERY_ENDPOINT,
      UPDATE_ENDPOINT,
    );
    ownership.bindReadyGeneration();
    return ownership;
  };

  beforeEach(() => {
    stores = [];
    epoch = null;
  });

  afterEach(async () => {
    for (const store of stores) await store.close().catch(() => undefined);
  });

  it('releases the registration when a discovery-only store closes', async () => {
    // The reported repro. A store probed purely for feature detection never
    // opens a session, so the only production release site — a session
    // shutdown — is unreachable, and the registration was held for the process
    // lifetime.
    const a = await managedStore(recordingSupervisor().handoff, freshOwnership());
    expect(a.getSystemRecordLaneControllerV1?.()).toBeDefined();

    await a.close();

    const b = await managedStore(recordingSupervisor().handoff, freshOwnership());
    expect(b.getSystemRecordLaneControllerV1?.()).toBeDefined();
  });

  it('releases the registration after a FAILED open', async () => {
    const ownership = freshOwnership();
    const failing: ManagedOxigraphSupervisorHandoffV1 = {
      stopAndProveOwnedChildDead: async () => {
        ownership.invalidate('port-release-unproven');
        throw new Error('port release unproven');
      },
      startAndProveCleanGeneration: async () => undefined,
    };
    const a = await managedStore(failing, ownership);
    const lane = a.getSystemRecordLaneControllerV1?.();
    expect(lane).toBeDefined();
    await expect(lane!.open(ACTIVATION)).rejects.toThrow();

    await a.close();

    const b = await managedStore(recordingSupervisor().handoff, freshOwnership());
    expect(b.getSystemRecordLaneControllerV1?.()).toBeDefined();
  });

  it('releases EXACTLY its own registration, never a replacement store\'s', async () => {
    // The sharpest test here. A releases by shutting its session down; B then
    // registers. A's LATER close() must not touch B's registration — an
    // unconditional clear would hand C a second live controller over the same
    // managed child, which is the state the single-registration invariant
    // exists to make unreachable.
    const a = await managedStore(recordingSupervisor().handoff, freshOwnership());
    const aLane = a.getSystemRecordLaneControllerV1?.();
    const session = await aLane!.open(ACTIVATION);
    await session.close('shutdown');

    const b = await managedStore(recordingSupervisor().handoff, freshOwnership());
    const bController = b.getSystemRecordLaneControllerV1?.();
    expect(bController).toBeDefined();

    await a.close();

    const c = await managedStore(recordingSupervisor().handoff, freshOwnership());
    expect(c.getSystemRecordLaneControllerV1?.()).toBeUndefined();
    expect(b.getSystemRecordLaneControllerV1?.()).toBe(bController);
  });

  it('detaches WITHOUT signalling the child', async () => {
    // `close()` must not run the lane's teardown: the adapter never owned the
    // child, and the daemon supervisor that does stops it itself. A second
    // stop-and-prove is the double process signal the shutdown path documents
    // as unsafe.
    const { calls, handoff } = recordingSupervisor();
    const a = await managedStore(handoff, freshOwnership());
    const lane = a.getSystemRecordLaneControllerV1?.();

    await a.close();

    expect(calls).toEqual([]);
    await expect(lane!.open(ACTIVATION)).rejects.toThrow(/terminal \(detached\)/);
  });

  it('latches a retained live session terminal', async () => {
    const a = await managedStore(recordingSupervisor().handoff, freshOwnership());
    const lane = a.getSystemRecordLaneControllerV1?.();
    const session = await lane!.open(ACTIVATION);
    expect(session.state).toBe('enabled');

    await a.close();

    expect(session.state).toBe('detached');
    await expect(session.applyVerified({})).resolves.toEqual({ outcome: 'capability-lost' });
  });

  it('never advertises again after close, and does not re-register', async () => {
    // A store that is closed BEFORE it was ever probed. Its lease still reads
    // ready — the supervisor stops the child afterwards — so without the closed
    // flag a first probe here would construct a controller over a closed store
    // and take the registration from the replacement.
    const a = await managedStore(recordingSupervisor().handoff, freshOwnership());
    await a.close();
    expect(a.getSystemRecordLaneControllerV1?.()).toBeUndefined();

    const b = await managedStore(recordingSupervisor().handoff, freshOwnership());
    expect(b.getSystemRecordLaneControllerV1?.()).toBeDefined();
  });

  it('latches SYNCHRONOUSLY under an in-flight enable', async () => {
    // The analogue of the shutdown latch, and the case that makes
    // `commitState` refusing off `detached` load-bearing: a store can close at
    // ANY point of ANY transition, and the enable that resumes afterwards must
    // publish neither state nor activation generation on a closed store.
    const ownership = freshOwnership();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const started = new Promise<void>((r) => { reached = r; });

    const stalling: ManagedOxigraphSupervisorHandoffV1 = {
      stopAndProveOwnedChildDead: async () => undefined,
      startAndProveCleanGeneration: async () => {
        reached();
        await gate;
      },
    };

    const a = await managedStore(stalling, ownership);
    const lane = a.getSystemRecordLaneControllerV1?.();
    const opening = lane!.open(ACTIVATION).then(() => 'resolved', () => 'rejected');
    await started;

    let closed = false;
    const closing = a.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(await opening).toBe('rejected');

    // The replacement can register, and the superseded lane never reopened.
    const b = await managedStore(recordingSupervisor().handoff, freshOwnership());
    expect(b.getSystemRecordLaneControllerV1?.()).toBeDefined();
    await expect(lane!.open(ACTIVATION)).rejects.toThrow(/terminal/);
  });

  it('is idempotent across repeated close', async () => {
    const a = await managedStore(recordingSupervisor().handoff, freshOwnership());
    expect(a.getSystemRecordLaneControllerV1?.()).toBeDefined();

    await a.close();
    await expect(a.close()).resolves.toBeUndefined();

    const b = await managedStore(recordingSupervisor().handoff, freshOwnership());
    expect(b.getSystemRecordLaneControllerV1?.()).toBeDefined();
  });

  it('a store that was REFUSED the lane does not release the holder on close', async () => {
    // The reverse hazard, from the other side: B never held the registration,
    // so B.close() must be a no-op with respect to the global.
    const a = await managedStore(recordingSupervisor().handoff, freshOwnership());
    const aController = a.getSystemRecordLaneControllerV1?.();
    expect(aController).toBeDefined();

    const b = await managedStore(recordingSupervisor().handoff, freshOwnership());
    expect(b.getSystemRecordLaneControllerV1?.()).toBeUndefined();

    await b.close();

    // A still holds it, and a third store still cannot take it.
    const c = await managedStore(recordingSupervisor().handoff, freshOwnership());
    expect(c.getSystemRecordLaneControllerV1?.()).toBeUndefined();
    expect(a.getSystemRecordLaneControllerV1?.()).toBe(aController);
  });
});
