import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SparqlHttpStore } from '../src/adapters/sparql-http.js';
import {
  attachManagedOxigraphLeaseV1,
  createManagedOxigraphOwnershipControllerV1,
} from '../src/managed-oxigraph-ownership-v1-internal.js';
import type { SystemRecordLaneExecutionBindingV1 } from '../src/system-record-materializer-v1.js';
import { __resetSystemRecordControllerRegistrationForTests } from '../src/system-record-materializer-v1.js';
import { attachSystemRecordAtomicApplyProbeForTestsV1 } from '../src/system-record-atomic-apply-probe-v1-internal.js';
import { resolveOwnedSystemRecordRuntimeV1 } from '../src/system-record-runtime-v1-internal.js';
import { externalStorePriorityScheduler } from '../src/store-priority-scheduler.js';
import {
  makeAuthenticActiveReplacementIssueV1,
  SYSTEM_RECORD_FIXTURE_NETWORK,
} from './helpers/system-record-active-replacement-fixture.js';

let server: Server;
let queryEndpoint: string;
let updateEndpoint: string;
let epoch: string | null;
let requests: Array<{ path: string; body: string }>;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ path: req.url ?? '', body });
      if (req.url === '/query') {
        res.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
        res.end(JSON.stringify({
          head: { vars: ['epoch'] },
          results: {
            bindings: epoch === null ? [] : [{ epoch: { type: 'literal', value: epoch } }],
          },
        }));
        return;
      }
      const inserted = /INSERT[\s\S]*?materialization-epoch> "([0-9]+)"/u.exec(body)?.[1];
      if (inserted === undefined) {
        res.writeHead(400);
        res.end('missing epoch');
        return;
      }
      epoch = inserted;
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server has no port');
  queryEndpoint = `http://127.0.0.1:${address.port}/query`;
  updateEndpoint = `http://127.0.0.1:${address.port}/update`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  __resetSystemRecordControllerRegistrationForTests();
  epoch = null;
  requests = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetSystemRecordControllerRegistrationForTests();
});

describe('sparql-http managed epoch handoff', () => {
  it('rotates through the generation-owned client inside the control barrier', async () => {
    // The lane MUST take the result-preserving path: a coalesced caller has to
    // receive the first transition's typed lifecycle data, not an unassigned
    // local capture. A result-free variant existed alongside it and this test
    // asserted it was never called — a public API pinned as unreachable, which
    // is why it is gone rather than merely unused.
    const resultBarrier = vi.spyOn(externalStorePriorityScheduler, 'runTypedControlBarrier');
    const ownership = createManagedOxigraphOwnershipControllerV1(queryEndpoint, updateEndpoint);
    ownership.bindReadyGeneration();
    let observedBinding: SystemRecordLaneExecutionBindingV1 | undefined;
    const managedOptions = attachManagedOxigraphLeaseV1(
      { queryEndpoint, updateEndpoint },
      ownership.lease,
      {
        stopAndProveOwnedChildDead: async () => undefined,
        startAndProveCleanGeneration: async () => undefined,
      },
    );
    const options = attachSystemRecordAtomicApplyProbeForTestsV1(
      managedOptions,
      ownership.lease,
      {
        observe: (binding) => {
          observedBinding = binding;
        },
      },
    );
    const runtime = resolveOwnedSystemRecordRuntimeV1(ownership.lease);
    const store = new SparqlHttpStore(options);
    const controller = store.getSystemRecordLaneControllerV1();
    expect(controller).toBeDefined();

    const first = await controller!.open({
      networkId: SYSTEM_RECORD_FIXTURE_NETWORK,
      kinds: ['agents'],
      mode: 'shadow',
    });
    expect(resultBarrier).toHaveBeenCalled();
    expect(epoch).toBe('1');
    await first.close('disable');
    expect(epoch).toBe('2');
    const second = await controller!.open({
      networkId: SYSTEM_RECORD_FIXTURE_NETWORK,
      kinds: ['agents'],
      mode: 'shadow',
    });
    expect(epoch).toBe('3');
    expect(requests.map((request) => request.path)).toEqual([
      '/query', '/update', '/query',
      '/query', '/update', '/query',
      '/query', '/update', '/query',
    ]);
    expect(requests.filter((request) => request.path === '/query'))
      .toSatisfy((queries: Array<{ body: string }>) =>
        queries.every((query) => query.body.endsWith('LIMIT 2')),
      );

    const beforeForgedApply = requests.length;
    // Production composition now reaches the atomic executor's private
    // registry consumer. A caller-authored object is rejected there before a
    // reserved-state query or update; the former validation-mismatch stub is
    // no longer the production bound path.
    await expect(second.applyVerified(Object.freeze({}))).resolves.toEqual({
      outcome: 'capability-lost',
    });
    expect(requests).toHaveLength(beforeForgedApply);

    if (observedBinding === undefined) throw new Error('atomic executor did not observe a binding');
    const proof = runtime.issuer.issueActive(makeAuthenticActiveReplacementIssueV1(
      observedBinding,
      Math.ceil(performance.now() + 10_000),
    ));
    const beforeAuthenticApply = requests.length;
    await expect(second.applyVerified(proof)).resolves.toEqual({
      outcome: 'deferred',
      reason: 'validation-mismatch',
    });
    expect(requests.slice(beforeAuthenticApply).map((request) => request.path)).toEqual(['/query']);

    await second.close('shutdown');
    const barrierKeys = resultBarrier.mock.calls.map((call) => call[1]);
    expect(barrierKeys.map((key) => key.purpose)).toEqual([
      'system-record.enable',
      'system-record.disable',
      'system-record.enable',
      'system-record.shutdown',
    ]);
    expect(barrierKeys[0]).toBe(barrierKeys[2]);
    expect(barrierKeys[1]).not.toBe(barrierKeys[0]);
    expect(barrierKeys[3]).not.toBe(barrierKeys[0]);
    expect(barrierKeys[3]).not.toBe(barrierKeys[1]);
    await store.close();
  });
});
