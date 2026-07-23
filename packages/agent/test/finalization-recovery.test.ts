import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeFinalizationMessage,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  type FinalizationMessageMsg,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import {
  parseGraphScopedFinalization,
} from '../src/finalization-graph-envelope.js';
import { FinalizationRecovery } from '../src/finalization-recovery.js';
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

  it('wires the data-directory journal through the production agent factory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-recovery-wiring-'));
    let agent: DKGAgent | undefined;
    try {
      agent = await DKGAgent.create({
        name: 'FinalizationRecoveryWiringBot',
        dataDir: directory,
        listenHost: '127.0.0.1',
      });
      await agent.start();
      const originalQuery = agent.store.query.bind(agent.store);
      agent.store.query = async () => {
        throw new StoreSchedulerBusyError(
          'queue_wait_timeout',
          'normal',
          'finalization-runtime-wiring.query',
        );
      };
      try {
        await agent.getOrCreateFinalizationHandler().handleFinalizationMessage(
          encodeFinalizationMessage(message()),
          CONTEXT_GRAPH,
          '12D3KooWPublisher',
        );
      } finally {
        agent.store.query = originalQuery;
      }

      expect(await new FinalizationRecoveryJournal(directory).list()).toMatchObject([{
        state: 'raw',
        sourcePeerId: '12D3KooWPublisher',
        ual: UAL,
        targetContextGraphId: '42',
      }]);
    } finally {
      await agent?.stop().catch(() => {});
      await agent?.store.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['applied', 0],
    ['already-confirmed', 0],
    ['deferred', 1],
  ] as const)(
    'drives journal transition from the explicit %s replay outcome',
    async (applyOutcome, expectedEntries) => {
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
          { info: () => {}, warn: () => {} },
        );
        await recovery.recordRawOnBusy({
          rawMessage: Uint8Array.from([1]),
          contextGraphId: CONTEXT_GRAPH,
          sourcePeerId: '12D3KooWPublisher',
          candidate: parsed.value,
        });

        const entries = await recovery.matchingEntries({
          chainId: chain.chainId,
          contextGraphId: CONTEXT_GRAPH,
          onChainCgId: '42',
          ual: UAL,
          merkleRoot: `0x${'00'.repeat(32)}`,
          kaId: PACKED_KA_ID.toString(),
        });
        expect(entries).toHaveLength(1);
        await recovery.settleEntry(entries[0], applyOutcome);
        expect(await journal.list()).toHaveLength(expectedEntries);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['the target context graph differs', '43', `0x${'00'.repeat(32)}`],
    ['the latest root differs', '42', `0x${'ff'.repeat(32)}`],
  ])('retains the envelope and selects no replay candidate when %s', async (_label, onChainCgId, latestRoot) => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-recovery-gate-'));
    try {
      const parsed = parseGraphScopedFinalization(message(), CONTEXT_GRAPH);
      if (!parsed.ok) throw new Error(`unexpected admission failure: ${parsed.reason}`);
      const journal = new FinalizationRecoveryJournal(directory);
      const chain = {
        chainId: 'base:84532',
        getLatestMerkleRoot: async () => Buffer.from(latestRoot.slice(2), 'hex'),
        getMerkleRootCount: async () => 1n,
        getKAContextGraphId: async () => BigInt(onChainCgId),
      } as ChainAdapter;
      const recovery = new FinalizationRecovery(
        journal,
        chain,
        { info: () => {}, warn: () => {} },
      );
      await recovery.recordRawOnBusy({
        rawMessage: Uint8Array.from([1]),
        contextGraphId: CONTEXT_GRAPH,
        sourcePeerId: '12D3KooWPublisher',
        candidate: parsed.value,
      });

      await expect(recovery.matchingEntries({
        chainId: chain.chainId,
        contextGraphId: CONTEXT_GRAPH,
        onChainCgId: '42',
        ual: UAL,
        merkleRoot: `0x${'00'.repeat(32)}`,
        kaId: PACKED_KA_ID.toString(),
      })).resolves.toEqual([]);
      expect(await journal.list()).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
