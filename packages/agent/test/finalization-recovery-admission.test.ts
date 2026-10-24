import { describe, expect, it, vi } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  encodeFinalizationMessage,
  type FinalizationMessageMsg,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { FinalizationHandler } from '../src/finalization-handler.js';

const CONTEXT_GRAPH_ID = 'recovery-admission';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;
const PACKED_KA_ID = (BigInt(AUTHOR) << 96n) | 7n;

function message(): FinalizationMessageMsg {
  return {
    ual: UAL,
    contextGraphId: CONTEXT_GRAPH_ID,
    kcMerkleRoot: new Uint8Array(32),
    txHash: `0x${'ab'.repeat(32)}`,
    blockNumber: 123,
    txIndex: 4,
    batchId: PACKED_KA_ID,
    startKAId: PACKED_KA_ID,
    endKAId: PACKED_KA_ID,
    publisherAddress: '0x2222222222222222222222222222222222222222',
    rootEntities: [],
    timestampMs: Date.now(),
    operationId: 'recovery-admission-op',
    targetContextGraphId: '42',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    assertionVersion: '1',
    publicTripleCount: 1,
    privateTripleCount: 0,
  };
}

describe('finalization recovery admission', () => {
  it('does not consult the chain or journal work rejected by local ownership', async () => {
    const resolveCanonicalFinalizationReceipt = vi.fn();
    const recoveryStore = {
      upsertPending: vi.fn(),
      markSettled: vi.fn(),
      markRetryable: vi.fn(),
      markPermanent: vi.fn(),
      listRecoverable: vi.fn(async () => []),
    };
    const handler = new FinalizationHandler(
      new OxigraphStore(),
      {
        chainId: 'legacy:1',
        isV10Ready: () => true,
        resolveCanonicalFinalizationReceipt,
      } as unknown as ChainAdapter,
      {
        recoveryStore: recoveryStore as never,
        finalizationRecoveryEligibility: async () => false,
      },
    );

    await handler.handleFinalizationMessage(
      encodeFinalizationMessage(message()),
      CONTEXT_GRAPH_ID,
      '12D3KooWPublisher',
    );

    expect(resolveCanonicalFinalizationReceipt).not.toHaveBeenCalled();
    expect(recoveryStore.upsertPending).not.toHaveBeenCalled();
    expect(recoveryStore.markSettled).not.toHaveBeenCalled();
  });
});
