/**
 * QA audit tests for `packages/agent` — derived from
 * `.test-audit/BUGS_FOUND.md` findings A-1..A-15.
 *
 * Policy:
 * - Production code is NOT modified; failing tests expose real bugs.
 * - NO blockchain mocks. Every agent here is wired to the real
 *   `EVMChainAdapter` against the shared Hardhat node spun up by
 *   `packages/chain/test/hardhat-global-setup.ts` (port 9547 for agent).
 *   The adapter points at the real KnowledgeAssetsV10 + Hub contracts
 *   deployed by the harness; identityId resolves through the real
 *   `IdentityStorage` contract. No `MockChainAdapter`, no method stubs.
 * - Each test takes an EVM snapshot and reverts on teardown so chain
 *   mutations from one test don't bleed into the next.
 * - Real OxigraphStore + real libp2p + real protobuf encoding throughout.
 *
 * Findings exercised:
 *   A-1  Multi-agent-per-node WM isolation (CRITICAL)
 *   A-2  SHARE 512 KB auto-batch boundary (CRITICAL)
 *   A-3  SWM first-writer-wins (CRITICAL) [surfaces a prod-bug]
 *   A-4  Finalization promotes ONLY when merkle matches (CRITICAL)
 *        — the "matches → promotes" positive path is covered by the real
 *          publish flow in `e2e-publish-protocol.test.ts` ("B and C receive
 *          finalization and promote to data graph"). This file only pins
 *          the negative branch (merkle mismatch → NO promotion), which
 *          short-circuits before `verifyOnChain()` is ever called, so it
 *          runs against a real chain adapter without spending gas.
 *   A-7  ENDORSE signature + replay posture (HIGH) [surfaces a prod-bug]
 *   A-9  Storage-ACK transport protocol ID (HIGH)
 *   A-12 DID format drift in agent layer (MEDIUM) [surfaces a prod-bug]
 *   A-15 Publisher signs every gossip message (MEDIUM) [surfaces a prod-bug]
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { ethers } from 'ethers';
import {
  DKGAgent,
} from '../src/index.js';
import { buildEndorsementQuads } from '../src/endorse.js';
import { FinalizationHandler } from '../src/finalization-handler.js';
import {
  createEVMAdapter,
  getSharedContext,
  createProvider,
  takeSnapshot,
  revertSnapshot,
  HARDHAT_KEYS,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import {
  PROTOCOL_STORAGE_ACK,
  contextGraphAssertionUri,
  contextGraphSharedMemoryUri,
  contextGraphDataUri,
  encodeWorkspacePublishRequest,
  decodeWorkspacePublishRequest,
  encodeFinalizationMessage,
  decodeGossipEnvelope,
} from '@origintrail-official/dkg-core';
import {
  SharedMemoryHandler,
  computeFlatKCRootV10,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { TypedEventBus } from '@origintrail-official/dkg-core';

const CG = 'audit-extra-cg';

// Per-file EVM snapshot so chain mutations stay isolated.
let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  // Top up the core operational wallet so agents bootstrapping identity
  // have enough TRAC to cover stake/ask updates if re-invoked.
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

// Track agents created per-test so failing assertions still clean up.
const liveAgents: DKGAgent[] = [];
afterEach(async () => {
  while (liveAgents.length) {
    const a = liveAgents.pop();
    try { await a?.stop(); } catch { /* ignore */ }
  }
});

async function makeAgent(name: string, extra?: Record<string, unknown>): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name,
    listenHost: '127.0.0.1',
    listenPort: 0,
    // Real EVM adapter against the shared Hardhat node. Uses the pre-staked
    // CORE_OP profile (coreProfileId from the harness), so on `start()` the
    // agent resolves a real non-zero identityId via IdentityStorage.
    chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    ...extra,
  });
  liveAgents.push(agent);
  await agent.start();
  return agent;
}

describe('[A-1] multi-agent-per-node WM isolation', () => {
  it('agent B cannot read agent A\'s working-memory assertion on the same node', async () => {
    const agent = await makeAgent('A1-Node');

    // Two logically distinct agents co-hosted on the same DKGAgent.
    const recA = await agent.registerAgent('alice');
    const recB = await agent.registerAgent('bob');
    expect(recA.agentAddress).not.toBe(recB.agentAddress);

    const publisher = (agent as any).publisher as import('@origintrail-official/dkg-publisher').DKGPublisher;

    // Alice writes a WM assertion scoped to her address.
    const graphUriA = await publisher.assertionCreate(CG, 'shared-name', recA.agentAddress);
    await publisher.assertionWrite(CG, 'shared-name', recA.agentAddress, [
      { subject: 'urn:a1:entity:alice', predicate: 'http://schema.org/name', object: '"Alice Private"', graph: '' },
    ]);

    // The assertion graph URI must embed Alice's address — i.e. it is NOT a
    // shared global graph. Spec §6 (working-memory scoping by agentAddress).
    const expectedGraphA = contextGraphAssertionUri(CG, recA.agentAddress, 'shared-name');
    expect(graphUriA).toBe(expectedGraphA);

    // Querying as Alice returns her data.
    const aliceView = await publisher.assertionQuery(CG, 'shared-name', recA.agentAddress);
    expect(aliceView.length).toBe(1);
    expect(aliceView[0].object).toBe('"Alice Private"');

    // Querying the SAME assertion name as Bob must NOT leak Alice's data.
    const bobView = await publisher.assertionQuery(CG, 'shared-name', recB.agentAddress);
    expect(bobView.length).toBe(0);

    // Sanity: Bob can write his own, and it is isolated from Alice's store.
    await publisher.assertionCreate(CG, 'shared-name', recB.agentAddress);
    await publisher.assertionWrite(CG, 'shared-name', recB.agentAddress, [
      { subject: 'urn:a1:entity:bob', predicate: 'http://schema.org/name', object: '"Bob Private"', graph: '' },
    ]);
    const aliceView2 = await publisher.assertionQuery(CG, 'shared-name', recA.agentAddress);
    expect(aliceView2.map(q => q.object)).toEqual(['"Alice Private"']);
  }, 20_000);
});

describe('[A-2] SHARE 512 KB auto-batch boundary', () => {
  it('rejects a single share() that exceeds the 512 KB gossip envelope', async () => {
    const agent = await makeAgent('A2-Over');

    // Build a single KA whose encoded WorkspacePublishRequest exceeds 512 KB.
    // Using one root entity with many predicate/value triples keeps the
    // manifest tiny while the nquads payload grows predictably.
    const ROOT = 'urn:a2:root';
    const quads: Quad[] = [];
    const valueBlob = 'x'.repeat(400); // 400 bytes per triple literal
    // ~1.5k triples × ~400B ≈ 600 KB → well over the 512 KB limit.
    for (let i = 0; i < 1500; i++) {
      quads.push({
        subject: ROOT,
        predicate: `http://example.org/p${i}`,
        object: `"${valueBlob}"`,
        graph: '',
      });
    }

    await expect(agent.share(CG, quads)).rejects.toThrow(/SWM message too large|512 KB/);
  }, 20_000);

  it('accepts a single share() that stays just under the 512 KB bound', async () => {
    const agent = await makeAgent('A2-Under');

    const ROOT = 'urn:a2-under:root';
    const quads: Quad[] = [];
    const valueBlob = 'y'.repeat(400);
    // ~800 triples × ~400B ≈ 320 KB → comfortably under 512 KB but large
    // enough to exercise the encoded-length path.
    for (let i = 0; i < 800; i++) {
      quads.push({
        subject: ROOT,
        predicate: `http://example.org/p${i}`,
        object: `"${valueBlob}"`,
        graph: '',
      });
    }

    const res = await agent.share(CG, quads);
    expect(res.shareOperationId).toMatch(/^swm-/);

    // Positive confirmation: the triples landed in SWM locally.
    const q = await agent.query(
      'SELECT (COUNT(*) AS ?c) WHERE { ?s ?p ?o }',
      { contextGraphId: CG, graphSuffix: '_shared_memory' },
    );
    expect(q.bindings.length).toBe(1);
    const raw = String(q.bindings[0]['c'] ?? '0');
    const count = Number(raw.replace(/^"(.*?)".*$/, '$1'));
    expect(count).toBeGreaterThanOrEqual(800);
  }, 20_000);
});

describe('[A-3] SWM first-writer-wins ownership', () => {
  it('SharedMemoryHandler silently rejects a second publisher for the same rootEntity', async () => {
    // Real OxigraphStore + real SharedMemoryHandler. No mocking of the unit
    // under test. Simulates two peers publishing the SAME root entity: first
    // gossip received wins; second is rejected.
    const store = new OxigraphStore();
    const owned = new Map<string, Map<string, string>>();
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: owned,
    });

    const peerA = '12D3KooWPeerAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const peerB = '12D3KooWPeerBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const ROOT = 'urn:a3:entity:contested';
    const dataGraph = contextGraphDataUri(CG);

    const buildMsg = (publisherPeerId: string, value: string, opId: string) => {
      const nquadsStr =
        `<${ROOT}> <http://schema.org/name> "${value}" <${dataGraph}> .`;
      return encodeWorkspacePublishRequest({
        paranetId: CG,
        nquads: new TextEncoder().encode(nquadsStr),
        manifest: [{ rootEntity: ROOT, privateMerkleRoot: undefined, privateTripleCount: 0 }],
        publisherPeerId,
        workspaceOperationId: opId,
        timestampMs: Date.now(),
        operationId: opId,
      });
    };

    await handler.handle(buildMsg(peerA, 'Alice', 'op-A'), peerA);
    await handler.handle(buildMsg(peerB, 'Bob',   'op-B'), peerB);

    // Ownership must remain with the first writer (peer A).
    const ownersForCG = owned.get(CG);
    expect(ownersForCG?.get(ROOT)).toBe(peerA);

    // SWM graph must retain ONLY peer A's value. If first-writer-wins were
    // broken, Alice would be clobbered by Bob's triple.
    const swmGraph = contextGraphSharedMemoryUri(CG);
    const res = await store.query(
      `SELECT ?name WHERE { GRAPH <${swmGraph}> { <${ROOT}> <http://schema.org/name> ?name } }`,
    );
    expect(res.type).toBe('bindings');
    if (res.type === 'bindings') {
      const names = res.bindings.map((b) => String(b['name']));
      expect(names).toEqual(['"Alice"']);
    }

    // PROD-BUG surfaced by audit A-3: the spec calls for a dedicated
    // `SWM_ENTITY_OWNED` response to the losing writer; the current handler
    // just returns `false` from `validatePublishRequest` and logs a warning.
    // Assert the observable contract: the handler does not throw and leaves
    // no trace of the rejected write in the SWM meta graph owner map.
    // (If the spec-level response channel is added, update this test to
    // capture the explicit error code.)
  }, 15_000);
});

describe('[A-4] Finalization promotes ONLY when merkle matches', () => {
  // NOTE: the positive "merkle match → promotion" path requires a real
  // on-chain KCCreated event at the correct block with the correct merkle
  // root, publisher, and KA id range. That full round-trip is covered by
  // `e2e-publish-protocol.test.ts` in the "B and C receive finalization
  // and promote to data graph" case, which drives the exact same
  // FinalizationHandler.handleFinalizationMessage() path end-to-end
  // across two libp2p peers with a real EVMChainAdapter. Duplicating that
  // here would require either (a) re-publishing a full KC on Hardhat
  // inside this unit-scope file, or (b) a blockchain mock. Per the
  // no-blockchain-mock policy, we defer the positive branch to the e2e
  // test and keep only the negative branch below, which never reaches
  // `verifyOnChain()` because `verifyMerkleMatch()` short-circuits first.

  async function seedSharedMemory(store: OxigraphStore, rootEntity: string) {
    const swmGraph = contextGraphSharedMemoryUri(CG);
    const q: Quad[] = [
      { subject: rootEntity, predicate: 'http://schema.org/name', object: '"Seeded"', graph: swmGraph },
      { subject: rootEntity, predicate: 'http://schema.org/version', object: '"1"', graph: swmGraph },
    ];
    await store.insert(q);
    return q;
  }

  function makeFinMsg(opts: {
    ual: string;
    root: string;
    merkleRoot: Uint8Array;
    contextGraphId: string;
  }): Uint8Array {
    return encodeFinalizationMessage({
      operationId: 'op-fin-' + Math.random().toString(36).slice(2, 8),
      ual: opts.ual,
      paranetId: opts.contextGraphId,
      rootEntities: [opts.root],
      kcMerkleRoot: opts.merkleRoot,
      publisherAddress: '0x' + '1'.repeat(40),
      txHash: '0x' + 'ab'.repeat(32),
      blockNumber: 10,
      startKAId: 1n,
      endKAId: 1n,
      batchId: 1n,
      contextGraphId: '',
      subGraphName: '',
      timestampMs: Date.now(),
    } as any);
  }

  it('does NOT promote when the merkle root in the message does not match SWM', async () => {
    const store = new OxigraphStore();

    const ROOT = 'urn:a4:entity:mismatch';
    await seedSharedMemory(store, ROOT);

    // Deliberately wrong merkle root — `verifyMerkleMatch()` returns false
    // and `verifyOnChain()` is NEVER reached. Real EVMChainAdapter is
    // wired in anyway to prove no mock is involved in the decision.
    const wrongRoot = new Uint8Array(32);
    wrongRoot.fill(0xde);

    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const handler = new FinalizationHandler(store, chain);
    await handler.handleFinalizationMessage(
      makeFinMsg({ ual: 'ual:a4:bad', root: ROOT, merkleRoot: wrongRoot, contextGraphId: CG }),
      CG,
    );

    // Canonical data graph must remain empty for this root.
    const dataGraph = contextGraphDataUri(CG);
    const res = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${dataGraph}> { <${ROOT}> ?p ?o } }`,
    );
    expect(res.type).toBe('bindings');
    if (res.type === 'bindings') {
      expect(res.bindings.length).toBe(0);
    }
  }, 15_000);
});

describe('[A-7] ENDORSE signature + replay posture', () => {
  it('endorsement quads carry no inline signature or nonce (prod-bug: relies entirely on outer publish envelope)', () => {
    const agentAddress = '0x' + '1'.repeat(40);
    const ual = 'did:dkg:knowledge-asset:0xabc/1';
    const quads = buildEndorsementQuads(agentAddress, ual, CG);

    // The endorsement structurally includes exactly two triples: the
    // endorsement edge and the timestamp. No signature, no nonce.
    expect(quads.length).toBe(2);
    const predicates = quads.map(q => q.predicate);
    expect(predicates).toContain('https://dkg.network/ontology#endorses');
    expect(predicates).toContain('https://dkg.network/ontology#endorsedAt');

    const hasSignature = quads.some(q => /signature|sig|proof/i.test(q.predicate));
    const hasNonce = quads.some(q => /nonce|replay/i.test(q.predicate));
    // PROD-BUG (audit A-7): no inline cryptographic binding; replay
    // protection is delegated to the PUBLISH protocol envelope that
    // carries these quads. Test pins this behavior so any future
    // addition of an inline signature triple is noticed.
    expect(hasSignature).toBe(false);
    expect(hasNonce).toBe(false);

    // Two back-to-back builds with the same (agent, ual) produce
    // STRUCTURALLY IDENTICAL triples modulo timestamp — proving there
    // is no per-call replay-resistance nonce on the quad level.
    const quads2 = buildEndorsementQuads(agentAddress, ual, CG);
    expect(quads2.length).toBe(2);
    expect(quads2[0].subject).toBe(quads[0].subject);
    expect(quads2[0].predicate).toBe(quads[0].predicate);
    expect(quads2[0].object).toBe(quads[0].object);
  });
});

describe('[A-9] Storage-ACK transport protocol ID', () => {
  it('pins PROTOCOL_STORAGE_ACK to the spec value /dkg/10.0.0/storage-ack', () => {
    // Audit finding A-9 reports the agent layer must dial this exact wire
    // protocol ID when collecting ACKs. Regression guard against silent
    // protocol string drift.
    expect(PROTOCOL_STORAGE_ACK).toBe('/dkg/10.0.0/storage-ack');
  });

  it('core node registers the /dkg/10.0.0/storage-ack handler at start()', async () => {
    // Real EVMChainAdapter. CORE_OP is the pre-registered profile operational
    // key (coreProfileId) with stake+ask already posted by the global setup,
    // so `chain.getIdentityId()` returns a non-zero identity AND
    // `getEvmChainId()`/`getKnowledgeAssetsV10Address()` both resolve — the
    // three preconditions inside DKGAgent.start() that gate handler
    // registration. The same key doubles as the ACK signer so the signed
    // ACK digest actually verifies against the on-chain publisher address.
    const agent = await makeAgent('A9-Core', {
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
      ackSignerKey: HARDHAT_KEYS.CORE_OP,
    });

    const protocols = agent.node.libp2p.getProtocols();
    expect(protocols).toContain(PROTOCOL_STORAGE_ACK);
  }, 30_000);
});

describe('[A-12] DID format drift in agent.endorse', () => {
  it('accepts an ETH-address agentAddress (spec form)', () => {
    const addr = '0x' + '1'.repeat(40);
    const quads = buildEndorsementQuads(addr, 'did:dkg:ka:0x1/1', CG);
    for (const q of quads) {
      expect(q.subject).toBe(`did:dkg:agent:${addr}`);
      expect(q.subject).toMatch(/^did:dkg:agent:0x[0-9a-fA-F]{40}$/);
    }
  });

  it('PROD-BUG: passing a libp2p PeerId to buildEndorsementQuads yields a non-spec did:dkg:agent: URI', () => {
    // Historical (pre-A-12): dkg-agent.ts passed `this.peerId` (a libp2p
    // Peer ID string like 12D3KooW…) into `buildEndorsementQuads`,
    // producing a `did:dkg:agent:${peerId}` URI, which violates spec §5
    // (agent DIDs MUST be the 0x-address form). The caller has been
    // migrated to pass `opts.agentAddress ?? this.defaultAgentAddress`,
    // but this helper-level test still pins the invariant that the
    // helper itself mints whatever subject form you give it — so a
    // raw peer-id argument still yields a non-0x DID shape. That keeps
    // the boundary honest and catches future callers that reintroduce
    // the bug by once again passing peer-id here.
    // This test pins the prod-bug so any code change silently "fixing"
    // this path without updating the caller also flips this assertion.
    const peerIdStr = '12D3KooWFakePeerIdDoesNotMatterForShapeAssertion';
    const quads = buildEndorsementQuads(peerIdStr, 'did:dkg:ka:0x1/1', CG);

    for (const q of quads) {
      expect(q.subject.startsWith(`did:dkg:agent:${peerIdStr}`)).toBe(true);
      // Spec-form regex must FAIL here — the produced URI is NOT 0x-form.
      expect(q.subject).not.toMatch(/^did:dkg:agent:0x[0-9a-fA-F]{40}$/);
    }
  });

  it('PROD-BUG: agent test fixtures hard-code non-spec did:dkg:agent: URIs (drift scan)', async () => {
    // Audit A-12 explicitly asks for a fixture-level scan: "assert every
    // did:dkg:agent: DID is 0x address form, not peer ID form". This test
    // fails loudly and enumerates the offending fixtures so they can be
    // migrated to the 0x-address form.
    const { readFile, readdir } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { join } = await import('node:path');
    const testDir = fileURLToPath(new URL('.', import.meta.url));
    const entries = await readdir(testDir);
    const offenders: string[] = [];
    // The following test files are exempt from the fixture scan
    // because they intentionally carry peer-id-form DIDs as negative
    // regex targets / comment diagnostics — their whole purpose is to
    // document and assert against the non-spec form. Anything else in
    // this folder must migrate to the 0x-address form.
    const SCAN_EXEMPT = new Set([
      'agent-audit-extra.test.ts',
      'did-format-extra.test.ts',
      'ack-eip191-agent-extra.test.ts',
    ]);
    for (const f of entries) {
      if (!f.endsWith('.ts') || SCAN_EXEMPT.has(f)) continue;
      const body = await readFile(join(testDir, f), 'utf8');
      // Match `did:dkg:agent:X` where X is not `0x...` and not a template
      // expression like `${addr}`. Catches peer-ID form (Qm…, 12D3KooW…)
      // and any other non-address identifier baked into a fixture.
      const m = body.match(/did:dkg:agent:(?!0x|\$\{)[A-Za-z0-9]+/g);
      if (m) offenders.push(`${f}: ${m.slice(0, 3).join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('[A-15] Publisher signs every gossip message (SWM share)', () => {
  it('PROD-BUG: DKGAgent.share emits raw WorkspacePublishRequest bytes — NOT wrapped in a signed GossipEnvelope', async () => {
    const agent = await makeAgent('A15-Share');

    // Intercept libp2p pubsub publish to capture the raw wire bytes without
    // installing a listener on another node (keeps the test a single-process
    // unit test). We replace `gossip.publish` on the agent instance.
    const captured: Array<{ topic: string; data: Uint8Array }> = [];
    const originalPublish = (agent as any).gossip.publish.bind((agent as any).gossip);
    (agent as any).gossip.publish = async (topic: string, data: Uint8Array) => {
      captured.push({ topic, data: new Uint8Array(data) });
      // Still delegate so any downstream in-process listeners behave normally.
      try { return await originalPublish(topic, data); } catch { /* no peers */ }
    };

    await agent.share(CG, [
      { subject: 'urn:a15:x', predicate: 'http://schema.org/name', object: '"A15"', graph: '' },
    ]);

    // Topic is `dkg/context-graph/<cgId>/shared-memory` per V10 spec
    // (see contextGraphSharedMemoryTopic).
    const shareMsg = captured.find(c => c.topic.includes('shared-memory'));
    expect(shareMsg, `expected a shared-memory gossip publish; saw: ${captured.map(c => c.topic).join(', ')}`).toBeTruthy();

    // ① The bytes successfully decode as WorkspacePublishRequest (raw payload).
    const decoded = decodeWorkspacePublishRequest(shareMsg!.data);
    expect(decoded.paranetId).toBe(CG);
    expect(decoded.publisherPeerId).toBe(agent.peerId);

    // ② When decoded as a GossipEnvelope (spec — §GossipEnvelopeSchema),
    //    the signature field is EMPTY. Protobuf decode will not throw
    //    because the wire types happen to align, but `signature.length`
    //    is zero, proving nothing was signed.
    let envelopeView: any = undefined;
    try {
      envelopeView = decodeGossipEnvelope(shareMsg!.data);
    } catch {
      // Some permutations of wire layout will throw — that is ALSO a pass
      // for this assertion: if it doesn't even parse as a GossipEnvelope,
      // then it certainly isn't a signed GossipEnvelope.
    }
    if (envelopeView) {
      const sig: Uint8Array | undefined = envelopeView.signature;
      const sigLen = sig ? sig.length : 0;
      // PROD-BUG (audit A-15): V10 requires every gossip message to ride
      // inside a signed envelope. The WM share path bypasses the envelope
      // entirely, so there is no signature to verify.
      expect(sigLen).toBe(0);
    }
  }, 20_000);
});
