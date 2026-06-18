/**
 * Finalization-handler promotion — real chain, real data, real promotion.
 *
 * Audit findings covered:
 *   A-4 (CRITICAL / POSSIBLE PROD-BUG) — the existing test
 *       `finalization-handler.test.ts` "promotes workspace data to canonical
 *       when merkle matches (no chain adapter)" is misleading: it builds
 *       a `FinalizationHandler` with `chain: undefined`, which makes
 *       `verifyOnChain()` return false synchronously, so the promotion
 *       branch is never taken. The test name claims promotion happens;
 *       the assertion verifies it *doesn't*. That flipped-name coverage
 *       is the A-4 finding.
 *
 *   This file fills the gap in two directions:
 *
 *     1. Direct invariant test: call `promoteSharedMemoryToCanonical`
 *        (private method, accessed via the same test-only reflection the
 *        existing backfill test uses) without a sub-graph name, and
 *        assert the data ends up in the canonical data graph. This pins
 *        the promotion contract irrespective of the chain.
 *
 *     2. Full e2e test: publish real data via `DKGAgent#publish()` against
 *        Hardhat, then query the `view:'verifiable-memory'` canonical graph
 *        and assert the published data is observable. If the full pipeline
 *        ever stops promoting confirmed data out of SWM and into canonical
 *        (the A-4 prod-bug suspicion), this test catches it immediately.
 *
 * No mocks — real `FinalizationHandler`, real store, real `DKGAgent`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestKaNumberAllocator } from "./_helpers/ka-allocator.js";
import { ethers } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { FinalizationHandler } from '../src/finalization-handler.js';
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
import { installHardhatACKProvider } from './_helpers/v10-acks.js';

const CONTEXT_GRAPH = `a4-finalize-${ethers.hexlify(ethers.randomBytes(4)).slice(2)}`;

let _fileSnapshot: string;
let nodeA: DKGAgent | undefined;

beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(
    provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('1000000'),
  );
  const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  nodeA = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
    name: 'A4Promoter',
    listenPort: 0,
    skills: [],
    chainAdapter: chain,
    nodeRole: 'core',
  });
  await nodeA.start();
  await installHardhatACKProvider(nodeA, chain);
});

afterAll(async () => {
  try { await nodeA?.stop(); } catch { /* */ }
  await revertSnapshot(_fileSnapshot);
});

describe('A-4: promoteSharedMemoryToCanonical lands data in the CANONICAL data graph', () => {
  it('writes SWM quads into `did:dkg:context-graph:<id>` when no sub-graph is set', async () => {
    const store = new OxigraphStore();
    const handler = new FinalizationHandler(store, undefined);
    const entity = 'urn:a4:alice';
    const publisher = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const dataGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}`;

    // Seed workspace memory that would be promoted. Not strictly required
    // since the promote method takes quads as an argument, but mirrors
    // how the handler is fed in production.
    const quads = [
      { subject: entity, predicate: 'http://schema.org/name', object: '"Alice-A4"', graph: '' },
    ];

    await (handler as any).promoteSharedMemoryToCanonical(
      CONTEXT_GRAPH,
      quads,
      'did:dkg:evm:31337/0xA4/1',
      [entity],
      publisher,
      '0x' + 'ab'.repeat(32),
      100,
      1n, 1n, 1n,
      createOperationContext('system'),
      undefined, // ctxGraphId
      undefined, // subGraphName → canonical default graph
    );

    const result = await store.query(
      `ASK { GRAPH <${dataGraph}> { <${entity}> <http://schema.org/name> "Alice-A4" } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') {
      expect(
        result.value,
        'promoteSharedMemoryToCanonical must write the quad into the canonical data graph (BUGS_FOUND.md A-4)',
      ).toBe(true);
    }
  });
});

describe('PR #779: same-graph dual-write into root + per-on-chain-id partition', () => {
  // Pin the new behaviour added to fix the v10-rc-validation §5
  // gossip-replication regression: when the publisher kept a root copy of
  // the canonical quads (same-graph publish, signalled on the wire by
  // `keepRootCopyOnLabel: true`), receivers MUST also write the quads to
  // the root `<cg>` graph alongside the per-on-chain-id partition
  // `<cg>/context/<ctxGraphId>`. Without this, label-scoped queries
  // (`contextGraphId=<label>` with no `/context/<num>` suffix) return 0
  // bindings on every replica even though the data is local. CI was
  // previously only exercising the remap branch via `e2e-context-graph`,
  // so a regression on the new wire flag would have escaped — the
  // automated suite now pins both branches (Codex review on PR #779 r2).
  const cgRoot = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
  const cgPerCgId = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/42`;

  it('keepRootCopyOnLabel=true → quads AND meta land in BOTH root and per-cgId graphs', async () => {
    const store = new OxigraphStore();
    const handler = new FinalizationHandler(store, undefined);
    const entity = 'urn:dualwrite:alice';
    const publisher = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const ual = 'did:dkg:evm:31337/0xDW/1';
    const quads = [
      { subject: entity, predicate: 'http://schema.org/name', object: '"DualWrite"', graph: '' },
    ];

    await (handler as any).promoteSharedMemoryToCanonical(
      CONTEXT_GRAPH,
      quads,
      ual,
      [entity],
      publisher,
      '0x' + '11'.repeat(32),
      300,
      1n, 1n, 1n,
      createOperationContext('system'),
      '42', // ctxGraphId — non-undefined enables per-cgId partition routing
      undefined, // subGraphName
      undefined, // authorAddress
      true, // keepRootCopyOnLabel — same-graph signal from the wire
    );

    const perCgIdAsk = await store.query(
      `ASK { GRAPH <${cgPerCgId}> { <${entity}> <http://schema.org/name> "DualWrite" } }`,
    );
    expect(perCgIdAsk.type).toBe('boolean');
    if (perCgIdAsk.type === 'boolean') expect(perCgIdAsk.value).toBe(true);

    const rootAsk = await store.query(
      `ASK { GRAPH <${cgRoot}> { <${entity}> <http://schema.org/name> "DualWrite" } }`,
    );
    expect(rootAsk.type).toBe('boolean');
    if (rootAsk.type === 'boolean') {
      expect(
        rootAsk.value,
        'same-graph publish (keepRootCopyOnLabel=true) MUST mirror publisher dual-write so label-scoped queries find the data on replicas',
      ).toBe(true);
    }

    // Codex r3: confirmed `_meta` must also live in BOTH root `_meta` and
    // per-cgId `_meta` so label-only status / UAL / authoredBy lookups
    // converge across publisher and replicas. Pin the dual-write of the
    // confirmed status quad on both meta graphs.
    const rootMeta = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
    const perCgIdMeta = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/42/_meta`;
    const rootMetaAsk = await store.query(
      `ASK { GRAPH <${rootMeta}> { <${ual}> <http://dkg.io/ontology/status> "confirmed" } }`,
    );
    expect(rootMetaAsk.type).toBe('boolean');
    if (rootMetaAsk.type === 'boolean') {
      expect(
        rootMetaAsk.value,
        'same-graph publish must dual-write confirmed `_meta` to ROOT meta graph too — label-only meta lookups otherwise miss the KC on replicas',
      ).toBe(true);
    }
    const perCgIdMetaAsk = await store.query(
      `ASK { GRAPH <${perCgIdMeta}> { <${ual}> <http://dkg.io/ontology/status> "confirmed" } }`,
    );
    expect(perCgIdMetaAsk.type).toBe('boolean');
    if (perCgIdMetaAsk.type === 'boolean') expect(perCgIdMetaAsk.value).toBe(true);
  });

  it('keepRootCopyOnLabel=false → root stays empty (remap-style publisher deleted root)', async () => {
    const store = new OxigraphStore();
    const handler = new FinalizationHandler(store, undefined);
    const entity = 'urn:dualwrite:remap';
    const publisher = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const quads = [
      { subject: entity, predicate: 'http://schema.org/name', object: '"Remap"', graph: '' },
    ];

    await (handler as any).promoteSharedMemoryToCanonical(
      CONTEXT_GRAPH,
      quads,
      'did:dkg:evm:31337/0xRM/1',
      [entity],
      publisher,
      '0x' + '22'.repeat(32),
      301,
      1n, 1n, 1n,
      createOperationContext('system'),
      '42', // ctxGraphId set
      undefined, // subGraphName
      undefined, // authorAddress
      false, // keepRootCopyOnLabel=false — remap-style, publisher deleted root
    );

    const perCgIdAsk = await store.query(
      `ASK { GRAPH <${cgPerCgId}> { <${entity}> <http://schema.org/name> "Remap" } }`,
    );
    expect(perCgIdAsk.type).toBe('boolean');
    if (perCgIdAsk.type === 'boolean') expect(perCgIdAsk.value).toBe(true);

    const rootAsk = await store.query(
      `ASK { GRAPH <${cgRoot}> { <${entity}> <http://schema.org/name> "Remap" } }`,
    );
    expect(rootAsk.type).toBe('boolean');
    if (rootAsk.type === 'boolean') {
      expect(
        rootAsk.value,
        'remap-style publish (keepRootCopyOnLabel=false) MUST NOT dual-write root — receiver would re-expose KC under source CG label and double-count in unscoped queries',
      ).toBe(false);
    }
  });

  it('keepRootCopyOnLabel undefined (older publisher) at promote-call layer → conservative no-dual-write', async () => {
    // Codex r5b — the receiver-side legacy-publisher fallback that
    // earlier rounds inferred from
    // `targetContextGraphId === local-on-chain-id` is GONE. That signal
    // can't distinguish a legacy same-graph publish from an explicit
    // remap-to-self (`subContextGraphId === ownCG.onChainId`), so the
    // fallback would re-add a root copy the publisher had intentionally
    // dropped. The new contract is simpler and unambiguous: only an
    // explicit wire-level `keepRootCopyOnLabel === true` triggers the
    // recipient dual-write. Anything else — `false`, `undefined`, an
    // unknown forward-compat sentinel, a legacy message with no tag-15
    // at all — keeps the per-cgId-only path. This test pins the
    // `undefined` case at the lower-level promote API; the wire-flag
    // round-trips and legacy decode behaviour are covered by
    // `proto-finalization-edge.test.ts`.
    const store = new OxigraphStore();
    const handler = new FinalizationHandler(store, undefined);
    const entity = 'urn:dualwrite:legacy';
    const publisher = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const quads = [
      { subject: entity, predicate: 'http://schema.org/name', object: '"Legacy"', graph: '' },
    ];

    await (handler as any).promoteSharedMemoryToCanonical(
      CONTEXT_GRAPH,
      quads,
      'did:dkg:evm:31337/0xLG/1',
      [entity],
      publisher,
      '0x' + '33'.repeat(32),
      302,
      1n, 1n, 1n,
      createOperationContext('system'),
      '42',
      undefined,
      undefined,
      undefined, // keepRootCopyOnLabel undefined at the promote layer
    );

    const rootAsk = await store.query(
      `ASK { GRAPH <${cgRoot}> { <${entity}> <http://schema.org/name> "Legacy" } }`,
    );
    expect(rootAsk.type).toBe('boolean');
    if (rootAsk.type === 'boolean') expect(rootAsk.value).toBe(false);
  });
});

describe('Round 5 §10: replica-side author provenance (prov:wasAttributedTo)', () => {
  it('attributes the KC to the threaded author via prov:wasAttributedTo (no dkg:Publication — RFC ka-metadata-trim)', async () => {
    // Regression for the round-5 review finding: replicas confirming a KC via
    // FinalizationHandler used to rebuild `_meta` without author provenance,
    // making it inconsistent across the network. Fix threads the
    // EIP-712-attested author from `KnowledgeAssetCreated.author`
    // into `KCMetadata` via `verifyOnChain`. This unit-level pin verifies the
    // promote-side wiring without standing up a full chain.
    // RFC ka-metadata-trim Phase 1: the `dkg:Publication`/`dkg:authoredBy`
    // mirror was dropped — attribution is carried by `prov:wasAttributedTo`
    // on the KC row.
    const store = new OxigraphStore();
    const handler = new FinalizationHandler(store, undefined);
    const cgId = `r5-author-${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;
    const entity = 'urn:r5:doc:authored';
    const publisher = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const author = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const txHash = '0x' + 'cd'.repeat(32);
    const metaGraph = `did:dkg:context-graph:${cgId}/_meta`;

    await (handler as any).promoteSharedMemoryToCanonical(
      cgId,
      [{ subject: entity, predicate: 'http://schema.org/name', object: '"Authored"', graph: '' }],
      `did:dkg:evm:31337/${publisher}/1`,
      [entity],
      publisher,
      txHash,
      200,
      1n, 1n, 1n,
      createOperationContext('system'),
      undefined, undefined,
      author,
    );

    // Attribution lands on the KC row as the author's agent DID
    // (lowercased EVM address — see `agentDid()`).
    const attrAsk = await store.query(
      `ASK { GRAPH <${metaGraph}> { ?kc <http://www.w3.org/ns/prov#wasAttributedTo> <did:dkg:agent:${author.toLowerCase()}> } }`,
    );
    expect(attrAsk.type).toBe('boolean');
    if (attrAsk.type === 'boolean') {
      expect(
        attrAsk.value,
        'replica must attribute the KC to the threaded on-chain author via prov:wasAttributedTo',
      ).toBe(true);
    }

    // RFC ka-metadata-trim: no dkg:Publication subject is emitted anymore.
    const pubAsk = await store.query(
      `ASK { GRAPH <${metaGraph}> { ?p a <http://dkg.io/ontology/Publication> } }`,
    );
    expect(pubAsk.type).toBe('boolean');
    if (pubAsk.type === 'boolean') expect(pubAsk.value).toBe(false);
  });

  it('treats authorAddress address(0) as unattributed (no fake agent DID, no Publication)', async () => {
    // RFC-001 §3.6 unattributed-publish path on chain stores
    // `address(0)` for `KnowledgeAssetCreated.author`. Replicas must
    // preserve that semantic by NOT minting a `did:dkg:agent:0x000…000`
    // attribution — the legacy no-author behaviour is the contract for
    // downstream queries that treat an agent-DID attribution as
    // "verified author on file".
    const store = new OxigraphStore();
    const handler = new FinalizationHandler(store, undefined);
    const cgId = `r5-noauth-${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;
    const entity = 'urn:r5:doc:unattributed';
    const publisher = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const txHash = '0x' + 'ef'.repeat(32);
    const metaGraph = `did:dkg:context-graph:${cgId}/_meta`;

    await (handler as any).promoteSharedMemoryToCanonical(
      cgId,
      [{ subject: entity, predicate: 'http://schema.org/name', object: '"Unattributed"', graph: '' }],
      `did:dkg:evm:31337/${publisher}/2`,
      [entity],
      publisher,
      txHash,
      201,
      1n, 1n, 1n,
      createOperationContext('system'),
      undefined, undefined,
      '0x0000000000000000000000000000000000000000',
    );

    const pubAsk = await store.query(
      `ASK { GRAPH <${metaGraph}> { ?p a <http://dkg.io/ontology/Publication> } }`,
    );
    expect(pubAsk.type).toBe('boolean');
    if (pubAsk.type === 'boolean') {
      expect(
        pubAsk.value,
        'replica must NOT emit a Publication subject (writer removed; sentinel must not resurrect it)',
      ).toBe(false);
    }

    // And no zero-address agent DID is minted for the attribution.
    const zeroAttrAsk = await store.query(
      `ASK { GRAPH <${metaGraph}> { ?kc <http://www.w3.org/ns/prov#wasAttributedTo> <did:dkg:agent:0x0000000000000000000000000000000000000000> } }`,
    );
    expect(zeroAttrAsk.type).toBe('boolean');
    if (zeroAttrAsk.type === 'boolean') expect(zeroAttrAsk.value).toBe(false);
  });
});

describe('A-4: e2e — agent.publish() data lands in canonical (data) view post-confirmation', () => {
  it('published data is observable via query(contextGraphId: cgId) AND via view=verifiable-memory on the publisher (RC11 / PR-A: Codex #671)', async () => {
    const cgId = `a4-e2e-${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;
    const entity = `urn:a4:e2e:${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;

    await nodeA!.createContextGraph({ id: cgId, name: 'A4 E2E', description: '' });
    await nodeA!.registerContextGraph(cgId);

    const pub = await nodeA!.publish(cgId, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"E2E-A4"', graph: '' },
    ]);
    expect(pub.status, 'publish must confirm for the promotion invariant to apply').toBe('confirmed');

    // RC11 / PR2: the canonical data graph (`did:dkg:context-graph:{cg}`)
    // is populated AFTER on-chain confirmation now (not unconditionally
    // pre-chain). The original BUGS_FOUND.md A-4 invariant — "confirmed
    // publishes land where the publisher's own SPARQL can see them" —
    // is unchanged; we check it both via the default context-graph
    // scope AND via `view: 'verifiable-memory'` (RC11 / PR-A re-includes
    // the root data graph in VM so memory-search-style callers see
    // post-publish data immediately, without needing an explicit
    // `verify` step).
    const qr = await nodeA!.query(
      `SELECT ?o WHERE { <${entity}> <http://schema.org/name> ?o }`,
      cgId,
    );
    expect(
      qr.bindings.length,
      'root context-graph must contain the published triple after confirmed publish (BUGS_FOUND.md A-4)',
    ).toBe(1);
    expect(qr.bindings[0]['o']).toBe('"E2E-A4"');

    // RC11 / PR-A (Codex review fix on #671, comment 3302058969):
    // `view: 'verifiable-memory'` now unions the root context-graph with
    // `_verifiable_memory/{vmId}` sub-graphs, so a confirmed publish is
    // immediately observable via VM. The tentative-VM leak the PR2
    // first cut was guarding against is plugged at the publisher
    // (root-graph insert deferred to the chain-success branch), so
    // re-including root in VM no longer surfaces unconfirmed quads.
    const vmQr = await nodeA!.query(
      `SELECT ?o WHERE { <${entity}> <http://schema.org/name> ?o }`,
      { contextGraphId: cgId, view: 'verifiable-memory' },
    );
    expect(
      vmQr.bindings.length,
      'verifiable-memory view must include confirmed publishes immediately (PR-A: root graph re-unioned into VM)',
    ).toBe(1);
    expect(vmQr.bindings[0]['o']).toBe('"E2E-A4"');

    // And the same data MUST NOT remain in SWM post-confirmation —
    // leaving it there would be a double-counting leak.
    const swmQr = await nodeA!.query(
      `SELECT ?o WHERE { <${entity}> <http://schema.org/name> ?o }`,
      { contextGraphId: cgId, view: 'shared-working-memory' },
    );
    expect(
      swmQr.bindings.length,
      'SWM must be cleared after confirmed publish — lingering quads indicate a failed promotion cleanup',
    ).toBe(0);
  });
});

describe('#774 F1: registerContextGraph access-policy mismatch is rejected (Codex review on #777)', () => {
  // Regression coverage for #774 finding #1. Before this fix, a CG
  // created public could be registered on-chain with `accessPolicy: 1`
  // (curated). The on-chain side ended up curated while the local
  // ACL stayed open; the next `dkg publish` then tripped the
  // pre-publish LU-5 guard with a mismatch error and the operator had
  // no easy path to recover. The fix fails fast at register time with
  // a remediation pointer. These tests pin both the rejection branch
  // and the matching-policy branch so the half-registered state can't
  // slip back in.
  it('rejects register({ accessPolicy: 1 }) on a public-created CG with a remediation message', async () => {
    // Codex r2 on #777: capture the rejection once and assert all
    // substrings against the same error object — the previous draft
    // invoked `registerContextGraph` twice just to match two
    // fragments, and the new guard runs after some local metadata
    // setup so a future refactor could make the second call land in
    // a different state/path while the test still passes.
    const cgId = `f1-mismatch-${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;
    await nodeA!.createContextGraph({ id: cgId, name: 'F1 mismatch', description: '' });

    let caught: Error | undefined;
    try {
      await nodeA!.registerContextGraph(cgId, { accessPolicy: 1 });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught, 'expected register({ accessPolicy: 1 }) to reject').toBeDefined();
    const msg = caught!.message;
    expect(msg, 'message must surface the actual local ACL state').toMatch(
      /local access policy=public\/open \(0\)/i,
    );
    expect(msg, 'message must point at the supported atomic create+register path').toMatch(
      /dkg context-graph create.*--access-policy 1/,
    );
    expect(msg, 'message must mention the single-call API alternative').toMatch(
      /POST \/api\/context-graph\/create/,
    );
  });

  it('accepts register({ accessPolicy: 0 }) on a public-created CG (matching policy is fine)', async () => {
    const cgId = `f1-match-${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;
    await nodeA!.createContextGraph({ id: cgId, name: 'F1 match', description: '' });

    const result = await nodeA!.registerContextGraph(cgId, { accessPolicy: 0 });
    expect(result.onChainId).toBeDefined();
    expect(Number(result.onChainId)).toBeGreaterThan(0);
  });
});
