import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { encodeFinalizationMessage, type FinalizationMessageMsg } from '@origintrail-official/dkg-core';
import { FinalizationHandler, type ResolveContextGraphOnChainId } from '../src/finalization-handler.js';

/**
 * Hand-rolled call recorder: wraps an implementation, records every call's
 * argument list in `.calls`, and forwards to `impl`. Replaces the former
 * mock factory for the resolver dependency-injection seam.
 */
function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

/**
 * Regression tests for the receiver-side `ctxGraphId` resolution in
 * `handleFinalizationMessage`.
 *
 * Two related bugs converge on the same line on the receiver side:
 *
 *  1. Pre-cd68fa689 publishers emitted `targetContextGraphId: undefined`
 *     for every non-REMAP publish (the publish-from-SWM common path).
 *     Receivers reading the wire literally then promoted SWM into the
 *     legacy `<cgName>/_meta` graph instead of the per-cgId
 *     `<cgName>/context/<cgId>/_meta` graph the RS prover reads from —
 *     so the prover loop reported `kc-not-synced` for every challenge
 *     on every KC the receiver didn't publish itself.
 *
 *     `cd68fa689` fixes the publisher to always plumb the resolved
 *     on-chain CG id into the gossip envelope. These tests pin the
 *     receiver-side behavior so a future refactor doesn't accidentally
 *     re-introduce the "use it iff the wire has it" downgrade.
 *
 *  2. During rolling upgrades (one core ships the fix, another doesn't)
 *     a stale publisher still floats `undefined` on the wire. To keep
 *     an upgraded receiver useful in a mixed-version mesh we resolve
 *     the on-chain id locally when the wire is empty, via a constructor-
 *     injected callback that mirrors `DKGAgent#getContextGraphOnChainId`.
 *
 * Strategy
 * ────────
 * The dedup guard at the top of `handleFinalizationMessage` runs
 *   ASK { GRAPH <metaGraph> { <ual> dkg:status "confirmed" } }
 * where `metaGraph` is computed FROM the resolved `ctxGraphId`. We
 * pre-seed a confirmed-status quad in each candidate meta graph and
 * confirm the handler probes the right one (sanity-checked by also
 * pre-seeding the OTHER meta graph and asserting it is NOT probed).
 *
 * Wrapping `store.query` to capture every SPARQL string the handler
 * issues is the lightest way to observe which graph URI got built —
 * we don't need to spin up a chain adapter, mock libp2p, or run merkle
 * verification, all of which are exercised in the existing
 * `e2e-publish-protocol.test.ts` round-trip.
 */

const CONTEXT_GRAPH = 'cg-finalize-defensive';
const PER_CG_ID_FROM_GOSSIP = '5';
const PER_CG_ID_FROM_RESOLVER = '7';
const UAL = 'did:dkg:evm:31337/0xABC/1';
const LEGACY_META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
const GOSSIP_PER_CG_META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${PER_CG_ID_FROM_GOSSIP}/_meta`;
const RESOLVER_PER_CG_META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${PER_CG_ID_FROM_RESOLVER}/_meta`;

function makeMsg(overrides?: Partial<FinalizationMessageMsg>): FinalizationMessageMsg {
  return {
    ual: UAL,
    contextGraphId: CONTEXT_GRAPH,
    kcMerkleRoot: new Uint8Array(32),
    txHash: '0x' + 'ab'.repeat(32),
    blockNumber: 100,
    batchId: 1,
    startKAId: 1,
    endKAId: 2,
    publisherAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    rootEntities: ['urn:test:entity'],
    timestampMs: Date.now(),
    operationId: 'op-defensive-test',
    ...overrides,
  };
}

/**
 * Wrap `store.query` to capture every SPARQL string the handler issues.
 * Returns the underlying captured-strings array (mutated in place).
 */
function captureQueries(store: OxigraphStore): string[] {
  const captured: string[] = [];
  const orig = store.query.bind(store);
  store.query = (async (sparql: string, ...rest: unknown[]) => {
    captured.push(sparql);
    return (orig as (s: string, ...r: unknown[]) => unknown)(sparql, ...rest);
  }) as typeof store.query;
  return captured;
}

/** Did any captured SPARQL string mention the given graph URI? */
function queriedGraph(captured: string[], graphUri: string): boolean {
  return captured.some((q) => q.includes(`<${graphUri}>`));
}

/**
 * Seed a `<UAL> dkg:status "confirmed"` quad in the given meta graph so
 * the handler's dedup ASK probe lights up and short-circuits processing.
 * This is the same dedup mechanism the existing
 * `finalization-handler.test.ts` "deduplicates messages with same UAL"
 * test relies on.
 */
async function seedConfirmedAt(store: OxigraphStore, metaGraph: string): Promise<void> {
  await store.insert([
    {
      subject: UAL,
      predicate: 'http://dkg.io/ontology/status',
      object: '"confirmed"',
      graph: metaGraph,
    },
  ]);
}

describe('FinalizationHandler ctxGraphId resolution', () => {
  let store: OxigraphStore;
  let captured: string[];

  beforeEach(() => {
    store = new OxigraphStore();
    captured = captureQueries(store);
  });

  it('uses targetContextGraphId from the gossip envelope when present (cd68fa689 contract)', async () => {
    // Pre-seed BOTH candidate meta graphs with the confirmed-status sentinel.
    // The handler should dedup against the per-cgId graph (because the
    // gossip envelope carries targetContextGraphId="5"); the legacy graph
    // seed is a tripwire that lights up only on regression.
    await seedConfirmedAt(store, GOSSIP_PER_CG_META_GRAPH);
    await seedConfirmedAt(store, LEGACY_META_GRAPH);

    const resolver = recorder<Parameters<ResolveContextGraphOnChainId>, ReturnType<ResolveContextGraphOnChainId>>(
      () => Promise.resolve('UNEXPECTED'),
    );
    const handler = new FinalizationHandler(store, undefined, undefined, resolver);

    const msg = makeMsg({ targetContextGraphId: PER_CG_ID_FROM_GOSSIP });
    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), CONTEXT_GRAPH);

    expect(queriedGraph(captured, GOSSIP_PER_CG_META_GRAPH)).toBe(true);
    expect(resolver.calls).toEqual([]);
  });

  it('falls back to the resolver when the gossip envelope omits targetContextGraphId', async () => {
    // Pre-seed the resolver-target meta graph so dedup short-circuits there.
    // The legacy graph stays empty — if we regress and skip the resolver,
    // dedup will miss and the handler will proceed to the SWM lookup
    // (which we'd observe via additional queries against the canonical
    // workspace graph, NOT the resolver-target graph).
    await seedConfirmedAt(store, RESOLVER_PER_CG_META_GRAPH);

    const resolver = recorder<Parameters<ResolveContextGraphOnChainId>, ReturnType<ResolveContextGraphOnChainId>>(
      () => Promise.resolve(PER_CG_ID_FROM_RESOLVER),
    );
    const handler = new FinalizationHandler(store, undefined, undefined, resolver);

    const msg = makeMsg();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), CONTEXT_GRAPH);

    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls.at(-1)).toEqual([CONTEXT_GRAPH]);
    expect(queriedGraph(captured, RESOLVER_PER_CG_META_GRAPH)).toBe(true);
    // Adversarial review F5 (read-both dedup): the dedup ASK now legitimately
    // UNIONs the label `_meta` graph as the status fallback (the minimal
    // per-cgId partition shape carries no `dkg:status` row), so the legacy
    // URI is allowed to appear — but ONLY inside the same read-both ASK that
    // probes the resolver-target graph. A standalone probe of the legacy
    // graph (the original regression: "use the wire iff present" downgrade
    // routing dedup/promotion to `<cgName>/_meta`) must still trip this.
    const legacyMentions = captured.filter((q) => q.includes(`<${LEGACY_META_GRAPH}>`));
    expect(legacyMentions.every((q) => q.includes(`<${RESOLVER_PER_CG_META_GRAPH}>`))).toBe(true);
  });

  it('falls back to the legacy meta URI when no resolver is wired (back-compat)', async () => {
    await seedConfirmedAt(store, LEGACY_META_GRAPH);
    const handler = new FinalizationHandler(store, undefined);

    const msg = makeMsg();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), CONTEXT_GRAPH);

    expect(queriedGraph(captured, LEGACY_META_GRAPH)).toBe(true);
  });

  it('falls back to the legacy meta URI when the resolver throws', async () => {
    // Resolver failure must NOT poison finalization — the receiver should
    // still attempt the legacy meta probe so we degrade gracefully to the
    // pre-cd68fa689 behaviour rather than dropping the gossip on the floor.
    await seedConfirmedAt(store, LEGACY_META_GRAPH);

    const resolver = recorder<Parameters<ResolveContextGraphOnChainId>, ReturnType<ResolveContextGraphOnChainId>>(
      () => Promise.reject(new Error('chain RPC dead')),
    );
    const handler = new FinalizationHandler(store, undefined, undefined, resolver);

    const msg = makeMsg();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), CONTEXT_GRAPH);

    expect(resolver.calls).toHaveLength(1);
    expect(queriedGraph(captured, LEGACY_META_GRAPH)).toBe(true);
  });

  it('falls back to the legacy meta URI when the resolver returns null (CG not on-chain)', async () => {
    // A CG that exists locally but hasn't been registered on-chain returns
    // null from `getContextGraphOnChainId`. Per-cgId promotion is
    // meaningless in that case — the prover only ever samples on-chain
    // CGs — so we keep the legacy semantics intact.
    await seedConfirmedAt(store, LEGACY_META_GRAPH);

    const resolver = recorder<Parameters<ResolveContextGraphOnChainId>, ReturnType<ResolveContextGraphOnChainId>>(
      () => Promise.resolve(null),
    );
    const handler = new FinalizationHandler(store, undefined, undefined, resolver);

    const msg = makeMsg();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), CONTEXT_GRAPH);

    expect(resolver.calls).toHaveLength(1);
    expect(queriedGraph(captured, LEGACY_META_GRAPH)).toBe(true);
  });

  it('prefers gossip targetContextGraphId over the resolver (resolver never called)', async () => {
    // Two-source-of-truth precedence test: when the wire carries an id
    // AND a resolver is wired, the wire wins. This locks in the contract
    // that publisher-side fix #758 is the canonical signal; the resolver
    // is a strict fallback, not an override.
    await seedConfirmedAt(store, GOSSIP_PER_CG_META_GRAPH);

    const resolver = recorder<Parameters<ResolveContextGraphOnChainId>, ReturnType<ResolveContextGraphOnChainId>>(
      () => Promise.resolve('99'),
    );
    const handler = new FinalizationHandler(store, undefined, undefined, resolver);

    const msg = makeMsg({ targetContextGraphId: PER_CG_ID_FROM_GOSSIP });
    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), CONTEXT_GRAPH);

    expect(resolver.calls).toEqual([]);
    expect(queriedGraph(captured, GOSSIP_PER_CG_META_GRAPH)).toBe(true);
    expect(queriedGraph(captured, `did:dkg:context-graph:${CONTEXT_GRAPH}/context/99/_meta`)).toBe(false);
  });
});
