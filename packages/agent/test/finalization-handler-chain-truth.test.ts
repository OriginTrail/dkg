import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { encodeFinalizationMessage, type FinalizationMessageMsg } from '@origintrail-official/dkg-core';
import { FinalizationHandler } from '../src/finalization-handler.js';

/**
 * Regression for STEP 0 (RS cgId-race forward-prevention): when the gossip
 * envelope omits `targetContextGraphId`, `handleFinalizationMessage` resolves
 * the on-chain CG id from CHAIN TRUTH first (`chain.getKAContextGraphId(batchId)`)
 * — authoritative and immune to the local ontology-binding lag that strands KCs
 * in legacy `_meta`. Two contracts must hold:
 *   1. A positive chain resolve routes finalization to the SCOPED
 *      `<cg>/context/<id>/_meta` graph the RS prover reads.
 *   2. A 0/miss is NOT cached (POSITIVE-only cache): a finalization that races
 *      ahead of its on-chain KA→CG binding must re-query the chain next time,
 *      not get pinned to legacy forever. A positive result IS cached.
 *
 * Technique (mirrors finalization-handler-defensive-cg-id.test.ts): capture the
 * SPARQL the handler issues, seed a `dkg:status "confirmed"` sentinel in the
 * expected meta graph so the dedup ASK short-circuits, and assert which graph
 * URI got probed.
 */

const CONTEXT_GRAPH = 'cg-chain-truth';
const UAL = 'did:dkg:evm:31337/0xABC/1';
const BATCH_ID = 7;
const CHAIN_CG_ID = '5';
const LEGACY_META = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
const SCOPED_META = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${CHAIN_CG_ID}/_meta`;

function makeMsg(overrides?: Partial<FinalizationMessageMsg>): FinalizationMessageMsg {
  return {
    ual: UAL,
    contextGraphId: CONTEXT_GRAPH,
    kcMerkleRoot: new Uint8Array(32),
    txHash: '0x' + 'ab'.repeat(32),
    blockNumber: 100,
    batchId: BATCH_ID,
    startKAId: 1,
    endKAId: 2,
    publisherAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    rootEntities: ['urn:test:entity'],
    timestampMs: Date.now(),
    operationId: 'op-chain-truth-test',
    ...overrides,
  };
}

function captureQueries(store: OxigraphStore): string[] {
  const captured: string[] = [];
  const orig = store.query.bind(store);
  store.query = (async (sparql: string, ...rest: unknown[]) => {
    captured.push(sparql);
    return (orig as (s: string, ...r: unknown[]) => unknown)(sparql, ...rest);
  }) as typeof store.query;
  return captured;
}

const queriedGraph = (captured: string[], graphUri: string): boolean =>
  captured.some((q) => q.includes(`<${graphUri}>`));

async function seedConfirmedAt(store: OxigraphStore, metaGraph: string): Promise<void> {
  await store.insert([{
    subject: UAL, predicate: 'http://dkg.io/ontology/status', object: '"confirmed"', graph: metaGraph,
  }]);
}

/** Minimal ChainAdapter stub exposing only what STEP 0 touches, returning a scripted sequence. */
type ChainArg = ConstructorParameters<typeof FinalizationHandler>[1];
function chainStub(sequence: Array<bigint | number | null>): { chain: ChainArg; calls: bigint[] } {
  const calls: bigint[] = [];
  let i = 0;
  const stub = {
    chainId: 'hardhat',
    getKAContextGraphId: async (batchId: bigint) => {
      calls.push(batchId);
      const v = sequence[Math.min(i, sequence.length - 1)];
      i += 1;
      return v;
    },
  };
  return { chain: stub as unknown as ChainArg, calls };
}

describe('FinalizationHandler STEP 0 — chain-truth cgId resolution', () => {
  let store: OxigraphStore;
  let captured: string[];

  beforeEach(() => {
    store = new OxigraphStore();
    captured = captureQueries(store);
  });

  it('routes to the scoped graph on a positive chain-truth resolve (no targetContextGraphId)', async () => {
    await seedConfirmedAt(store, SCOPED_META);
    const { chain, calls } = chainStub([5n]);
    const handler = new FinalizationHandler(store, chain);

    await handler.handleFinalizationMessage(encodeFinalizationMessage(makeMsg()), CONTEXT_GRAPH);

    expect(calls).toEqual([BigInt(BATCH_ID)]);
    expect(queriedGraph(captured, SCOPED_META)).toBe(true);
  });

  it('does NOT cache a 0/miss (re-queries the chain), but DOES cache a positive', async () => {
    // Both candidate graphs carry the sentinel so every call short-circuits at
    // the dedup ASK regardless of which graph it resolves to.
    await seedConfirmedAt(store, LEGACY_META);
    await seedConfirmedAt(store, SCOPED_META);
    const { chain, calls } = chainStub([0n, 5n]); // miss, then positive (then stays positive)
    const handler = new FinalizationHandler(store, chain);

    // Call 1 — chain returns 0 → unresolved → legacy probe; the miss is NOT cached.
    await handler.handleFinalizationMessage(
      encodeFinalizationMessage(makeMsg({ txHash: '0x' + '11'.repeat(32) })), CONTEXT_GRAPH,
    );
    expect(calls).toHaveLength(1);

    // Call 2 — same batchId, fresh txHash. If the 0 had been cached, the chain
    // would NOT be re-queried and we'd be pinned to legacy. It must re-query and
    // now resolve to the scoped graph.
    const mark = captured.length;
    await handler.handleFinalizationMessage(
      encodeFinalizationMessage(makeMsg({ txHash: '0x' + '22'.repeat(32) })), CONTEXT_GRAPH,
    );
    expect(calls).toHaveLength(2); // re-queried — miss was NOT cached
    expect(queriedGraph(captured.slice(mark), SCOPED_META)).toBe(true);

    // Call 3 — the positive (5) is now cached: the chain must NOT be re-queried.
    await handler.handleFinalizationMessage(
      encodeFinalizationMessage(makeMsg({ txHash: '0x' + '33'.repeat(32) })), CONTEXT_GRAPH,
    );
    expect(calls).toHaveLength(2); // still 2 — positive WAS cached
  });
});
