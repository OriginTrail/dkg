import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  VerifiedGraphScopedFinalizationEvidence,
} from '../src/finalization-graph-envelope.js';

export const TX_HASH = `0x${'ab'.repeat(32)}`;
export const BLOCK_HASH = `0x${'cd'.repeat(32)}`;
export const RAW = Uint8Array.from([1, 2, 3, 4]);

export function received(overrides: Record<string, unknown> = {}) {
  return {
    key: 'entry-1',
    chainId: 'base:84532',
    contextGraphId: 'graph',
    sourcePeerId: '12D3KooWPublisher',
    ual: 'did:dkg:base:84532/0x1111111111111111111111111111111111111111/7',
    txHash: TX_HASH,
    assertionVersion: '1',
    merkleRoot: `0x${'01'.repeat(32)}`,
    kaId: '7',
    batchId: '7',
    targetContextGraphId: '42',
    rawMessage: RAW,
    ...overrides,
  };
}

export function evidence(
  overrides: Partial<VerifiedGraphScopedFinalizationEvidence> = {},
): VerifiedGraphScopedFinalizationEvidence {
  return {
    assertionVersion: '1',
    publicTripleCount: 2,
    privateTripleCount: 0,
    publicQuadsDigest: `sha256:${'02'.repeat(32)}`,
    publisherPeerId: '12D3KooWPublisher',
    publisherAddress: '0x2222222222222222222222222222222222222222',
    transactionHash: TX_HASH,
    blockNumber: 123,
    blockHash: BLOCK_HASH,
    txIndex: 4,
    authorAddress: '0x1111111111111111111111111111111111111111',
    accessPolicy: 'ownerOnly',
    allowedPeers: [],
    ...overrides,
  };
}

export async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dkg-finalization-inbox-'));
}
