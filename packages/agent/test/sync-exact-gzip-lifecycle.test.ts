import { describe, expect, it } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import {
  encodeNegotiatedExactSyncResponse,
  EXACT_SYNC_GZIP_ENCODING,
} from '../src/sync/wire-compression.js';

const UAL = 'did:dkg:base:8453/0x1111111111111111111111111111111111111111/7';
const CG = 'gzip-lifecycle';
const GRAPH = `did:dkg:context-graph:${CG}`;
const PEER = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

async function agentWithResponse(body: Uint8Array) {
  const agent = await DKGAgent.create({
    name: 'ExactGzipLifecycle', listenHost: '127.0.0.1',
    chainAdapter: new MockChainAdapter(), rfc64CatalogActivation: { enabled: false },
  });
  let calls = 0;
  (agent as any).resolveRfc64CatalogReceiverAuthorityV1 = () => ({ legacySyncAllowed: true });
  (agent as any).messenger = { sendToPeer: async () => ++calls === 1 ? body : new Uint8Array() };
  // Authentication and mixed-version builders are covered by the wire suite;
  // this test exercises the actual lifecycle profile and parser worker.
  (agent as any).buildSyncRequest = async () => new Uint8Array([1]);
  return agent;
}

function fetch(agent: DKGAgent, options: { exact?: boolean; maxHeap?: number } = {}) {
  return (agent as any).fetchSyncPages(
    createOperationContext('sync'), PEER, CG, false, 'data', GRAPH, Date.now() + 30_000,
    {
      ...(options.exact === false ? {} : { assetUals: [UAL] }),
      ...(options.maxHeap === undefined ? {} : { maxAcceptedHeapBytesEstimate: options.maxHeap }),
      forceFreshSession: true,
    },
  );
}

describe('production lifecycle exact gzip profile', () => {
  it('admits a valid singleton above the old four-MiB wire ceiling and keeps wire telemetry separate', async () => {
    const rows = 6_000;
    const raw = new TextEncoder().encode(Array.from({ length: rows }, (_, index) =>
      `<urn:row:${index}> <urn:value> "${'x'.repeat(800)}" <${GRAPH}> .\n`).join(''));
    expect(raw.byteLength).toBeGreaterThan(4 * 1024 * 1024);
    const frame = await encodeNegotiatedExactSyncResponse(raw, {
      request: { responseEncoding: EXACT_SYNC_GZIP_ENCODING, assetUals: [UAL], phase: 'data' },
    });
    const agent = await agentWithResponse(frame);
    try {
      const result = await fetch(agent);
      expect(result.completed).toBe(true);
      expect(result.quads).toHaveLength(rows);
      expect(result.decodedBytesReceived).toBe(raw.byteLength);
      expect(result.bytesReceived).toBe(frame.byteLength);
      expect(result.quads[rows - 1].subject).toBe(`urn:row:${rows - 1}`);
    } finally { await agent.stop(); }
  });

  it('preserves a smaller caller heap budget after negotiating compression', async () => {
    const raw = new TextEncoder().encode(`<urn:row> <urn:value> "${'x'.repeat(1_000)}" <${GRAPH}> .\n`);
    const frame = await encodeNegotiatedExactSyncResponse(raw, {
      request: { responseEncoding: EXACT_SYNC_GZIP_ENCODING, assetUals: [UAL], phase: 'data' },
    });
    const agent = await agentWithResponse(frame);
    try { await expect(fetch(agent, { maxHeap: 100 })).rejects.toThrow(/heap-bytes/); }
    finally { await agent.stop(); }
  });

  it('rejects an unsolicited compressed full-graph response', async () => {
    const raw = new TextEncoder().encode(`<urn:row> <urn:value> "${'x'.repeat(1_000)}" <${GRAPH}> .\n`);
    const frame = await encodeNegotiatedExactSyncResponse(raw, {
      request: { responseEncoding: EXACT_SYNC_GZIP_ENCODING, assetUals: [UAL], phase: 'data' },
    });
    const agent = await agentWithResponse(frame);
    try { await expect(fetch(agent, { exact: false })).rejects.toThrow(/Unnegotiated/); }
    finally { await agent.stop(); }
  });
});
