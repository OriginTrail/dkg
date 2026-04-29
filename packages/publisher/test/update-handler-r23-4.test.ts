import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { TypedEventBus, encodeKAUpdateRequest } from '@origintrail-official/dkg-core';
import { UpdateHandler } from '../src/update-handler.js';

/**
 * r23-4: forged-attribution defence.
 *
 * A peer with its own legitimate wallet could historically wrap a
 * KAUpdateRequest whose `publisherAddress` claims a DIFFERENT
 * operator's EVM address and gossip-sign it. The inner protobuf
 * then carried an attribution that the receiving node trusted for
 * ownership checks / metadata writes / downstream auth.
 *
 * The fix: `UpdateHandler.handle` now accepts the outer envelope
 * signer and short-circuits when the two disagree, BEFORE any
 * chain RPC. Unsigned-envelope calls (legacy path) keep working
 * for rolling upgrades — the envelope-layer warning already covers
 * that risk and the chain-layer `verifyKAUpdate` ultimately catches
 * a forged txHash.
 *
 * This file uses a bare mock chain adapter and a real Oxigraph
 * store so the test exercises the real `handle` method end-to-end
 * up to the first short-circuit. It does NOT exercise on-chain
 * verification — that has comprehensive coverage in
 * `ka-update.test.ts` against the shared Hardhat harness.
 */

const PARANET = 'test-update-r23-4';
const ENTITY = 'urn:test:entity:a';

function quadsToNQuads(quads: Quad[], graph: string): Uint8Array {
  const str = quads
    .map((qd) => `<${qd.subject}> <${qd.predicate}> ${qd.object.startsWith('"') ? qd.object : `<${qd.object}>`} <${graph}> .`)
    .join('\n');
  return new TextEncoder().encode(str);
}

function makeRequest(overrides?: Partial<{
  publisherAddress: string;
  publisherPeerId: string;
  batchId: bigint;
  txHash: string;
}>): Uint8Array {
  const quads: Quad[] = [{ subject: ENTITY, predicate: 'http://schema.org/name', object: '"Alice"', graph: '' }];
  return encodeKAUpdateRequest({
    paranetId: PARANET,
    batchId: overrides?.batchId ?? 1n,
    nquads: quadsToNQuads(quads, `did:dkg:context-graph:${PARANET}`),
    manifest: [{ rootEntity: ENTITY, privateTripleCount: 0 }],
    publisherPeerId: overrides?.publisherPeerId ?? '12D3KooWUpdater',
    publisherAddress: overrides?.publisherAddress ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    txHash: overrides?.txHash ?? '0x' + 'ab'.repeat(32),
    blockNumber: 100n,
    newMerkleRoot: new Uint8Array(32),
    timestampMs: BigInt(Date.now()),
  });
}

function buildHandler(store: OxigraphStore): { handler: UpdateHandler; verifyCalls: number } {
  const state = { verifyCalls: 0 };
  // Minimal chain adapter stub. If the r23-4 check DOES short-circuit,
  // `verifyKAUpdate` must never be called. If the check lets a
  // message through, it will bump `verifyCalls`.
  const chainAdapter = {
    verifyKAUpdate: async () => {
      state.verifyCalls++;
      return { verified: false, reason: 'test-stub' };
    },
    // Other methods UpdateHandler might reach; we only need enough
    // surface area to not crash on happy-path references.
    getChainId: () => 31337n,
  } as any;
  const eventBus = new TypedEventBus();
  const handler = new UpdateHandler(store, chainAdapter, eventBus);
  return Object.assign(state, { handler });
}

describe('UpdateHandler — r23-4 envelope signer MUST match KAUpdateRequest.publisherAddress', () => {
  let store: OxigraphStore;

  beforeEach(() => {
    store = new OxigraphStore();
  });

  it('short-circuits BEFORE chain RPC when envelope signer mismatches the claimed publisherAddress', async () => {
    const legitOperator = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const attackerSigner = '0xDEADBEEFdeadBEEFDEADbeefdeadBEEFDEADbEeF';

    const data = makeRequest({ publisherAddress: legitOperator });
    const built = buildHandler(store);

    await built.handler.handle(data, '12D3KooWUpdater', attackerSigner);

    expect(built.verifyCalls).toBe(0);
  });

  it('short-circuits when the envelope is signed but publisherAddress is empty', async () => {
    const data = makeRequest({ publisherAddress: '' });
    const built = buildHandler(store);

    await built.handler.handle(data, '12D3KooWUpdater', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');

    expect(built.verifyCalls).toBe(0);
  });

  it('skips the envelope check when envelopeSigner is undefined (rolling-upgrade / unsigned path)', async () => {
    // The legacy path must still reach verifyKAUpdate so that the
    // chain-layer is the source of truth for attribution. Otherwise
    // we would break every node that hasn't rolled to signed
    // envelopes yet.
    const data = makeRequest();
    const built = buildHandler(store);

    await built.handler.handle(data, '12D3KooWUpdater');

    expect(built.verifyCalls).toBe(1);
  });

  it('passes the envelope check when signer matches publisherAddress (case-insensitive) and reaches chain RPC', async () => {
    const publisher = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const data = makeRequest({ publisherAddress: publisher });
    const built = buildHandler(store);

    // Lower-cased variant on purpose — the guard must be
    // case-insensitive because ethers.recoverAddress returns
    // checksum-case but protobuf carries the string as-sent.
    await built.handler.handle(data, '12D3KooWUpdater', publisher.toLowerCase());

    expect(built.verifyCalls).toBe(1);
  });
});
