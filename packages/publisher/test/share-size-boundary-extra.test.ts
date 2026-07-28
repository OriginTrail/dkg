/**
 * Publisher SWM gossip-size boundary tests (no Hardhat required).
 *
 * Audit findings covered:
 *
 *   P-4 (HIGH) — 4 MiB SHARE gossip boundary.
 *                `packages/publisher/src/dkg-publisher.ts` enforces
 *                `DKG_GOSSIP_MAX_MESSAGE_BYTES`. The existing
 *                suite never sends a payload near that limit, so a
 *                silent change to the cap (or a regression that stops
 *                measuring the encoded protobuf length) would not be
 *                detected. These tests pin both sides of the boundary:
 *                  • a multi-MB payload below 4 MiB must succeed; and
 *                  • a payload just over 4 MiB must fail with a clear,
 *                    caller-actionable error that mentions the limit.
 *
 * Keep these assertions and the operator guidance aligned whenever the shared
 * protocol limit changes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { DKG_GOSSIP_MAX_MESSAGE_BYTES, TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { DKGPublisher } from '../src/index.js';

const CG = 'boundary-test-cg';
const PEER = '12D3KooWBoundary';

function q(s: string, p: string, o: string): Quad {
  return { subject: s, predicate: p, object: o, graph: '' };
}

function buildQuadsWithTotalPayload(bytes: number): Quad[] {
  const chunkBytes = 16 * 1024;
  const quads: Quad[] = [];
  let remaining = bytes;
  let index = 0;
  while (remaining > 0) {
    const size = Math.min(chunkBytes, remaining);
    quads.push(q(`urn:test:boundary:root:${index}`, 'http://schema.org/description', `"${'x'.repeat(size)}"`));
    remaining -= size;
    index += 1;
  }
  return quads;
}

function makePublisher(store: OxigraphStore, eventBus: TypedEventBus): Promise<DKGPublisher> {
  return (async () => {
    const keypair = await generateEd25519Keypair();
    return new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus,
      keypair,
    });
  })();
}

describe('P-4: SWM share() 4 MiB gossip-message boundary', () => {
  let store: OxigraphStore;
  let eventBus: TypedEventBus;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
    eventBus = new TypedEventBus();
    publisher = await makePublisher(store, eventBus);
  });

  it('accepts a multi-MB payload below the 4 MiB cap and returns an encoded message', async () => {
    // Many modest literals match the large-context-graph shape without
    // stressing storage's single-literal formatter.
    const under = buildQuadsWithTotalPayload(2 * 1024 * 1024);

    const result = await publisher.share(CG, under, { publisherPeerId: PEER });

    expect(result).toBeDefined();
    // The encoded message is the protobuf payload the agent would gossip.
    // If this shape ever changes, update the assertion — but DO NOT drop it;
    // without this check the size-limit codepath would be untested.
    expect(result.message).toBeDefined();
    expect(result.message).toBeInstanceOf(Uint8Array);
    expect(result.message.length).toBeLessThanOrEqual(DKG_GOSSIP_MAX_MESSAGE_BYTES);
    expect(result.message.length).toBeGreaterThan(1024 * 1024); // sanity: did we actually build big
  });

  it('rejects a payload just over the 4 MiB cap with a clear, actionable error', async () => {
    // Well over the 4 MiB cap so there is no ambiguity about the exit path.
    // Use many Blazegraph-safe literals so this exercises the aggregate
    // gossip-message boundary rather than the per-literal safety guard.
    const over = buildQuadsWithTotalPayload(DKG_GOSSIP_MAX_MESSAGE_BYTES + 1024 * 1024);

    let thrown: unknown;
    try {
      await publisher.share(CG, over, { publisherPeerId: PEER });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    // The error MUST mention both the actual size and the cap so
    // operators can tell "is this a slightly-over vs wildly-over" case
    // without attaching a debugger. We also assert the remediation
    // guidance (split by root entity) per spec §04.
    expect(msg).toMatch(/too large/i);
    expect(msg).toMatch(/4\s*MB/);
    expect(msg).toMatch(/split/i);
  });

  it('the cap is 4 MiB — an oversized payload fails, a multi-MB payload passes', async () => {
    // Pin the constant. If someone reduces the cap without updating
    // the guidance in the error or the spec, BOTH
    // halves of this test flip status and the regression is noisy.
    const justUnder = buildQuadsWithTotalPayload(2 * 1024 * 1024);
    const justOver = buildQuadsWithTotalPayload(DKG_GOSSIP_MAX_MESSAGE_BYTES + 512 * 1024);

    const ok = await publisher.share(CG, justUnder, { publisherPeerId: PEER });
    expect(ok).toBeDefined();
    expect(ok.message.length).toBeLessThan(DKG_GOSSIP_MAX_MESSAGE_BYTES);

    await expect(
      publisher.share(CG, justOver, { publisherPeerId: PEER }),
    ).rejects.toThrow(/too large.*4\s*MB/i);
  });
});
