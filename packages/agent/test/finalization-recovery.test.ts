import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  type FinalizationMessageMsg,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import {
  FinalizationRecovery,
  parseGraphScopedFinalization,
  type FinalizationRecoveryApplyOutcome,
} from '../src/finalization-recovery.js';
import { FinalizationRecoveryJournal } from '../src/finalization-recovery-journal.js';

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

  it('treats the protobuf default empty target context graph id as absent', () => {
    expect(parseGraphScopedFinalization(
      message({ targetContextGraphId: '' }),
      CONTEXT_GRAPH,
    )).toMatchObject({ ok: true });
  });

  it.each([
    ['applied', true, 0],
    ['already-confirmed', true, 0],
    ['deferred', false, 1],
    ['busy', false, 1],
  ] as const)(
    'drives journal transition from the explicit %s replay outcome',
    async (applyOutcome, expectedRecovered, expectedEntries) => {
      const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-recovery-outcome-'));
      try {
        const parsed = parseGraphScopedFinalization(message(), CONTEXT_GRAPH);
        if (!parsed.ok) throw new Error(`unexpected admission failure: ${parsed.reason}`);
        const journal = new FinalizationRecoveryJournal(directory);
        const chain = {
          chainId: 'base:84532',
          getLatestMerkleRoot: async () => new Uint8Array(32),
          getMerkleRootCount: async () => 1n,
          getKAContextGraphId: async () => 42n,
        } as ChainAdapter;
        const recovery = new FinalizationRecovery(
          journal,
          chain,
          async () => {
            if (applyOutcome === 'busy') {
              throw new StoreSchedulerBusyError(
                'queue_wait_timeout',
                'normal',
                'sparql-http.query',
              );
            }
            return applyOutcome as FinalizationRecoveryApplyOutcome;
          },
          { info: () => {}, warn: () => {} },
        );
        await recovery.recordRawOnBusy({
          rawMessage: Uint8Array.from([1]),
          contextGraphId: CONTEXT_GRAPH,
          sourcePeerId: '12D3KooWPublisher',
          candidate: parsed.value,
        });

        await expect(recovery.replayMatching({
          chainId: chain.chainId,
          contextGraphId: CONTEXT_GRAPH,
          onChainCgId: '42',
          ual: UAL,
          merkleRoot: `0x${'00'.repeat(32)}`,
          kaId: PACKED_KA_ID.toString(),
        })).resolves.toBe(expectedRecovered);
        expect(await journal.list()).toHaveLength(expectedEntries);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
