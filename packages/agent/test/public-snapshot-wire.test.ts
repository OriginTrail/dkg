import { expect, it, vi } from 'vitest';
import { decodePublicGraphSnapshotRequest, encodePublicGraphSnapshotRequest, PUBLIC_GRAPH_SNAPSHOT_REQUEST_MAX_BYTES } from '../src/public-snapshot-wire.js';
import { PublicSnapshotMethods } from '../src/dkg-agent-public-snapshot.js';

const request = { version: 1 as const, contextGraphId: 'snapshot-wire', onChainId: '1', refresh: false };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const invalidRequests = [null, [], {}, { ...request, extra: true }, { ...request, refresh: undefined },
  { ...request, version: 2 }, { ...request, refresh: 'false' }, { ...request, contextGraphId: '../private' },
  { ...request, onChainId: 1 }, { ...request, onChainId: '0' }, { ...request, onChainId: '01' },
  { ...request, onChainId: '1'.repeat(79) }, { ...request, onChainId: (1n << 256n).toString() }].map(bytes);
invalidRequests.push(Uint8Array.of(0xff), new TextEncoder().encode('{'), new Uint8Array(PUBLIC_GRAPH_SNAPSHOT_REQUEST_MAX_BYTES + 1));

it.each([false, true])('round trips the exact version-one contract (refresh=%s)', refresh => {
  const value = { ...request, refresh, onChainId: ((1n << 256n) - 1n).toString() };
  expect(decodePublicGraphSnapshotRequest(encodePublicGraphSnapshotRequest(value))).toEqual(value);
});

it('keeps malformed wire input outside subscription and chain admission with a uniform refusal', async () => {
  let handler!: (data: Uint8Array) => Promise<Uint8Array>;
  const chain = { readPublicGraphSnapshot: vi.fn() }, subscriptions = { get: vi.fn() };
  const router = { register: vi.fn((_protocol, read) => { handler = read; }) };
  PublicSnapshotMethods.prototype.startPublicGraphSnapshots.call({ config: { nodeRole: 'core' }, chain, router,
    subscribedContextGraphs: subscriptions } as never);
  expect(router.register.mock.calls[0]?.[2]).toEqual({ maxReadBytes: PUBLIC_GRAPH_SNAPSHOT_REQUEST_MAX_BYTES });
  for (const wire of invalidRequests) {
    expect(() => decodePublicGraphSnapshotRequest(wire)).toThrow();
    expect(JSON.parse(new TextDecoder().decode(await handler(wire)))).toEqual({ unavailable: true });
  }
  expect(subscriptions.get).not.toHaveBeenCalled();
  expect(chain.readPublicGraphSnapshot).not.toHaveBeenCalled();
});
