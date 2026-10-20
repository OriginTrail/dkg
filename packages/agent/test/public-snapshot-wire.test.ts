import { AgentWorkLifetime } from '../src/agent-work-lifetime.js';
import { expect, it, vi } from 'vitest';
import { decodeCoreChainCacheSnapshotRequest, encodeCoreChainCacheSnapshotRequest, decodePublicGraphSnapshotRequest, encodePublicGraphSnapshotRequest, PUBLIC_GRAPH_SNAPSHOT_REQUEST_MAX_BYTES } from '../src/public-snapshot-wire.js';
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
    subscribedContextGraphs: subscriptions, workLifetime: new AgentWorkLifetime(),   } as never);
  expect(router.register.mock.calls[0]?.[2]).toEqual({ maxReadBytes: PUBLIC_GRAPH_SNAPSHOT_REQUEST_MAX_BYTES });
  for (const wire of invalidRequests) {
    expect(() => decodePublicGraphSnapshotRequest(wire)).toThrow();
    expect(JSON.parse(new TextDecoder().decode(await handler(wire)))).toEqual({ unavailable: true });
  }
  expect(subscriptions.get).not.toHaveBeenCalled();
  expect(chain.readPublicGraphSnapshot).not.toHaveBeenCalled();
});

it('round trips and validates the typed chain-cache wire contract before admission', () => {
  const scope = { chainId: 'gnosis:100', deploymentId: 'gnosis:100:hub=fixture' };
  const valid = { ...request, ...scope };
  expect(decodeCoreChainCacheSnapshotRequest(encodeCoreChainCacheSnapshotRequest(valid))).toEqual(valid);
  const malformed = [null, [], {}, { ...valid, extra: true }, { ...valid, chainId: 1 },
    { ...valid, chainId: '' }, { ...valid, deploymentId: 'x'.repeat(257) }, { ...valid, deploymentId: undefined },
    { ...valid, version: 2 }, { ...valid, refresh: 'false' }, { ...valid, onChainId: '01' },
    { ...valid, contextGraphId: '../private' }];
  for (const value of malformed) {
    expect(() => decodeCoreChainCacheSnapshotRequest(bytes(value))).toThrow();
    expect(() => encodeCoreChainCacheSnapshotRequest(value as never)).toThrow();
  }
  for (const wire of [Uint8Array.of(0xff), bytes('{'), new Uint8Array(1025)])
    expect(() => decodeCoreChainCacheSnapshotRequest(wire)).toThrow();
});
