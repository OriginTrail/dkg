/**
 * SHARE / SWM 512 KB gossip-size boundary, exercised from the agent layer.
 *
 * Audit findings covered:
 *   A-2 (CRITICAL) — `DKGPublisher#_shareImpl` rejects encoded SWM messages
 *        larger than `MAX_GOSSIP_MESSAGE_SIZE = 512 * 1024`. The agent's
 *        `DKGAgent#share` is the only user-facing entry point. We pin:
 *          1. Positive: a payload whose encoded size is safely below the
 *             limit succeeds and produces a shareOperationId + SWM quads
 *             observable via `query({view: 'shared-working-memory'})`.
 *          2. Negative: a payload well above the limit throws the exact
 *             "SWM message too large" error, with the guidance pointing at
 *             split-into-smaller-share() batches.
 *          3. Boundary: callers that hit the limit see a *clear* error, not
 *             a silent libp2p-level drop. Error message contains both the
 *             observed KB and the 512 KB limit so operators can react.
 *
 * No mocks — real `DKGAgent` + real libp2p + real chain (only used to boot
 * the agent; share() never submits a tx).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/index.js';
import {
  HARDHAT_KEYS,
  createEVMAdapter,
  createProvider,
  getSharedContext,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

let _fileSnapshot: string;
let nodeA: DKGAgent | undefined;

function freshCgId(prefix: string): string {
  return `${prefix}-${ethers.hexlify(ethers.randomBytes(4)).slice(2)}`;
}

beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(
    provider,
    hubAddress,
    HARDHAT_KEYS.DEPLOYER,
    coreOp.address,
    ethers.parseEther('1000000'),
  );
  nodeA = await DKGAgent.create({
    name: 'SwmBoundaryA',
    listenPort: 0,
    skills: [],
    chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    nodeRole: 'core',
  });
  await nodeA.start();
});

afterAll(async () => {
  try { await nodeA?.stop(); } catch { /* best-effort */ }
  await revertSnapshot(_fileSnapshot);
});

describe('A-2: SHARE 512 KB gossip-size boundary', () => {
  it('share() with a payload well BELOW 512 KB succeeds and lands in SWM', async () => {
    const cgId = freshCgId('bnd-lo');
    await nodeA!.createContextGraph({ id: cgId, name: 'Boundary Lo', description: '' });

    // Target ~100 KB of literal payload — well under the 512 KB cap.
    // Split across multiple literals to mimic realistic agent output.
    const chunkCount = 10;
    const chunkLen = 10 * 1024; // 10 KB per chunk
    const chunk = 'x'.repeat(chunkLen);
    const quads = Array.from({ length: chunkCount }, (_, i) => ({
      subject: `urn:swm:lo:e${i}`,
      predicate: 'http://schema.org/description',
      object: `"${chunk}"`,
      graph: '',
    }));

    const result = await nodeA!.share(cgId, quads);
    expect(result.shareOperationId).toMatch(/.+/);

    // Data landed in SWM — can be queried via view:'shared-working-memory'.
    const qr = await nodeA!.query(
      `SELECT ?s WHERE { ?s <http://schema.org/description> ?o }`,
      { contextGraphId: cgId, view: 'shared-working-memory' },
    );
    const subs = new Set(qr.bindings.map((b) => b['s']));
    for (let i = 0; i < chunkCount; i++) {
      expect(subs.has(`urn:swm:lo:e${i}`)).toBe(true);
    }
  });

  it('share() with a payload WELL ABOVE 512 KB is rejected with the expected error message', async () => {
    const cgId = freshCgId('bnd-hi');
    await nodeA!.createContextGraph({ id: cgId, name: 'Boundary Hi', description: '' });

    // One literal of ~700 KB — guaranteed to push the encoded message
    // past the 512 KB gossip-size cap even after protobuf framing.
    const big = 'y'.repeat(700 * 1024);
    const quads = [
      {
        subject: 'urn:swm:hi:alice',
        predicate: 'http://schema.org/description',
        object: `"${big}"`,
        graph: '',
      },
    ];

    let caught: Error | null = null;
    try {
      await nodeA!.share(cgId, quads);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught, 'share() should reject a 700 KB payload with a size-limit error').not.toBeNull();
    // Spec text from dkg-publisher.ts: "SWM message too large (<KB> KB, limit 512 KB)."
    expect(caught!.message).toMatch(/SWM message too large/);
    expect(caught!.message).toMatch(/limit\s+512\s*KB/);
    // Operator-actionable guidance: split into multiple share() calls.
    expect(caught!.message.toLowerCase()).toMatch(/split|multiple share/);
  });

  it('share() is atomic on rejection — no SWM quads from the oversized attempt persist', async () => {
    const cgId = freshCgId('bnd-atomic');
    await nodeA!.createContextGraph({ id: cgId, name: 'Boundary Atomic', description: '' });

    const big = 'z'.repeat(600 * 1024);
    const quads = [
      {
        subject: 'urn:swm:atomic:bob',
        predicate: 'http://schema.org/description',
        object: `"${big}"`,
        graph: '',
      },
    ];

    await expect(nodeA!.share(cgId, quads)).rejects.toThrow(/SWM message too large/);

    // SWM view for this CG must be empty for the attempted subject: the
    // oversized share must not have half-written into the store.
    const qr = await nodeA!.query(
      `SELECT ?o WHERE { <urn:swm:atomic:bob> <http://schema.org/description> ?o }`,
      { contextGraphId: cgId, view: 'shared-working-memory' },
    );
    expect(
      qr.bindings.length,
      'oversized share must not persist ANY triples; store leak would let large payloads bypass the limit',
    ).toBe(0);
  });
});
