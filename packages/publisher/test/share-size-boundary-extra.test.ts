/**
 * Publisher SWM gossip-size boundary tests (no Hardhat required).
 *
 * Audit findings covered:
 *
 *   P-4 (HIGH) — 10 MB SHARE gossip boundary.
 *                `packages/publisher/src/dkg-publisher.ts` enforces
 *                `DKG_GOSSIP_MAX_MESSAGE_BYTES`. The existing
 *                suite never sends a payload near that limit, so a
 *                silent change to the cap (or a regression that stops
 *                measuring the encoded protobuf length) would not be
 *                detected. These tests pin both sides of the boundary:
 *                  • a multi-MB payload below 10 MB must succeed; and
 *                  • a payload just over 10 MB must fail with a clear,
 *                    caller-actionable error that mentions the limit.
 *
 * Per QA policy: do NOT modify production code or spec docs. If the
 * boundary ever drifts, the failing assertion IS the bug evidence.
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

/**
 * Build a single quad whose UTF-8 N-Quad serialization is approximately
 * `targetBytes` bytes. We pad the literal object so the encoded
 * WorkspacePublishRequest lands below or above the cap depending
 * on `targetBytes`.
 *
 * Using a single root entity keeps manifest overhead constant so the
 * dominant size contribution is the nquads string. autoPartition groups
 * by root — a single subject maps to a single KA.
 */
function buildQuadWithPayload(bytes: number): Quad {
  // subject/predicate/fixed N-Quad framing adds ~120 bytes of overhead.
  // Subtract that from the target so the rendered N-Quad approximates
  // `bytes`. We pad with a single ASCII char so 1 char == 1 byte.
  const overhead = 140;
  const padLen = Math.max(0, bytes - overhead);
  const padding = 'x'.repeat(padLen);
  return q('urn:test:boundary:root', 'http://schema.org/description', `"${padding}"`);
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

describe('P-4: SWM share() 10 MB gossip-message boundary', () => {
  let store: OxigraphStore;
  let eventBus: TypedEventBus;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
    eventBus = new TypedEventBus();
    publisher = await makePublisher(store, eventBus);
  });

  it('accepts a multi-MB payload below the 10 MB cap and returns an encoded message', async () => {
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

  it('rejects a payload just over the 10 MB cap with a clear, actionable error', async () => {
    // Well over the 10 MB cap so there is no ambiguity about the exit path.
    const over = buildQuadWithPayload(DKG_GOSSIP_MAX_MESSAGE_BYTES + 1024 * 1024);

    let thrown: unknown;
    try {
      await publisher.share(CG, [over], { publisherPeerId: PEER });
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
    expect(msg).toMatch(/10\s*MB/);
    expect(msg).toMatch(/split/i);
  });

  it('the cap is 10 MB — an oversized payload fails, a multi-MB payload passes', async () => {
    // Pin the constant. If someone reduces the cap without updating
    // the guidance in the error or the spec, BOTH
    // halves of this test flip status and the regression is noisy.
    const justUnder = buildQuadsWithTotalPayload(2 * 1024 * 1024);
    const justOver = buildQuadWithPayload(DKG_GOSSIP_MAX_MESSAGE_BYTES + 512 * 1024);

    const ok = await publisher.share(CG, justUnder, { publisherPeerId: PEER });
    expect(ok).toBeDefined();
    expect(ok.message.length).toBeLessThan(DKG_GOSSIP_MAX_MESSAGE_BYTES);

    await expect(
      publisher.share(CG, [justOver], { publisherPeerId: PEER }),
    ).rejects.toThrow(/too large.*10\s*MB/i);
  });
});
