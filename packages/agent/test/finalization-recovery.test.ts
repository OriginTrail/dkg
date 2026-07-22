import { describe, expect, it } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  type FinalizationMessageMsg,
} from '@origintrail-official/dkg-core';
import { parseGraphScopedFinalization } from '../src/finalization-recovery.js';

const CONTEXT_GRAPH = 'finalization-recovery-admission';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;
const PACKED_KA_ID = (BigInt(AUTHOR) << 96n) | 7n;

function message(overrides: Partial<FinalizationMessageMsg> = {}): FinalizationMessageMsg {
  return {
    ual: UAL,
    contextGraphId: CONTEXT_GRAPH,
    kcMerkleRoot: new Uint8Array(32),
    txHash: `0x${'ab'.repeat(32)}`,
    blockNumber: 123,
    batchId: PACKED_KA_ID,
    startKAId: PACKED_KA_ID,
    endKAId: PACKED_KA_ID,
    publisherAddress: '0x2222222222222222222222222222222222222222',
    rootEntities: [],
    timestampMs: Date.now(),
    operationId: 'recovery-admission-test',
    targetContextGraphId: '42',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    assertionVersion: '1',
    publicTripleCount: 1,
    privateTripleCount: 0,
    ...overrides,
  };
}

describe('graph-scoped finalization recovery admission', () => {
  it('returns a typed parsed envelope for a valid singleton finalization', () => {
    const result = parseGraphScopedFinalization(message(), CONTEXT_GRAPH);
    expect(result).toMatchObject({
      ok: true,
      value: {
        assertionVersion: '1',
        kaId: PACKED_KA_ID,
        publicTripleCount: 1,
      },
    });
  });

  it('names an invalid graph-scoped identity rejection', () => {
    expect(parseGraphScopedFinalization(
      message({ ual: 'not-a-canonical-ual' }),
      CONTEXT_GRAPH,
    )).toEqual({ ok: false, reason: 'invalid-identity' });
  });

  it('names an invalid access-envelope rejection', () => {
    expect(parseGraphScopedFinalization(message({
      accessPolicy: 'allowList',
      allowedPeers: ['12D3KooWReader', '12D3KooWReader'],
    }), CONTEXT_GRAPH)).toEqual({ ok: false, reason: 'invalid-allowed-peers' });
  });
});
