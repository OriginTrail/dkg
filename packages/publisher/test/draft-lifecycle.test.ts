import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_GOSSIP_MAX_MESSAGE_BYTES,
  TypedEventBus,
  generateEd25519Keypair,
  contextGraphAssertionUri,
  contextGraphSharedMemoryUri,
  assertionLifecycleUri,
} from '@origintrail-official/dkg-core';
import { DKGPublisher } from '../src/index.js';
import { ethers } from 'ethers';
import { createEVMAdapter, getSharedContext, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';

const CG_ID = 'test-assertion-cg';
const SWM_GRAPH = `did:dkg:context-graph:${CG_ID}/_shared_memory`;
const AGENT = '0x1234567890abcdef1234567890abcdef12345678';
const AGENT_B = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const PEER = '12D3KooWPromoteBoundary';
const ASSERTION_NAME = 'my-assertion';

const TRIPLES = [
  { subject: 'urn:test:entity:alice', predicate: 'http://schema.org/name', object: '"Alice"' },
  { subject: 'urn:test:entity:alice', predicate: 'http://schema.org/age', object: '"30"' },
  { subject: 'urn:test:entity:bob', predicate: 'http://schema.org/name', object: '"Bob"' },
];

function largePayloadQuads(prefix: string, bytes: number): Quad[] {
  const chunkBytes = 16 * 1024;
  const quads: Quad[] = [];
  let remaining = bytes;
  let index = 0;
  while (remaining > 0) {
    const size = Math.min(chunkBytes, remaining);
    quads.push({
      subject: `urn:test:entity:${prefix}:${index}`,
      predicate: 'http://schema.org/description',
      object: `"${'x'.repeat(size)}"`,
      graph: '',
    });
    remaining -= size;
    index += 1;
  }
  return quads;
}

describe('Working Memory Assertion Lifecycle', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
  });

  it('create returns the correct assertion graph URI', async () => {
    const uri = await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    expect(uri).toBe(contextGraphAssertionUri(CG_ID, AGENT, ASSERTION_NAME));
  });

  it('write inserts triples into the assertion graph', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);

    const quads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(quads.length).toBe(3);
    const subjects = new Set(quads.map((q: Quad) => q.subject));
    expect(subjects.has('urn:test:entity:alice')).toBe(true);
    expect(subjects.has('urn:test:entity:bob')).toBe(true);
  });

  it('query returns triples from the assertion only', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);

    // Write something to a different assertion — should not appear
    await publisher.assertionCreate(CG_ID, 'other-assertion', AGENT);
    await publisher.assertionWrite(CG_ID, 'other-assertion', AGENT, [
      { subject: 'urn:test:entity:charlie', predicate: 'http://schema.org/name', object: '"Charlie"' },
    ]);

    const quads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(quads.length).toBe(3);
    const subjects = new Set(quads.map((q: Quad) => q.subject));
    expect(subjects.has('urn:test:entity:charlie')).toBe(false);
  });

  it('promote moves all triples to SWM and empties assertion', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);

    const result = await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);
    expect(result.promotedCount).toBe(3);

    const assertionQuads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(assertionQuads.length).toBe(0);

    const swmResult = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${SWM_GRAPH}> { ?s ?p ?o } }`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      expect(swmResult.bindings.length).toBe(3);
    }
  });

  it('promote accepts a payload above the old 512 KB cap and below 10 MB', async () => {
    await publisher.assertionCreate(CG_ID, 'large-promote', AGENT);
    const quads = largePayloadQuads('large-promote', 2 * 1024 * 1024);
    await publisher.assertionWrite(CG_ID, 'large-promote', AGENT, quads);

    const result = await publisher.assertionPromote(CG_ID, 'large-promote', AGENT, {
      publisherPeerId: PEER,
    });

    expect(result.promotedCount).toBe(quads.length);
    expect(result.gossipMessage).toBeInstanceOf(Uint8Array);
    expect(result.gossipMessage!.length).toBeGreaterThan(512 * 1024);
    expect(result.gossipMessage!.length).toBeLessThan(DKG_GOSSIP_MAX_MESSAGE_BYTES);
  });

  it('promote rejects payloads above 10 MB before mutating WM or SWM', async () => {
    await publisher.assertionCreate(CG_ID, 'too-large-promote', AGENT);
    const quads = largePayloadQuads('too-large-promote', DKG_GOSSIP_MAX_MESSAGE_BYTES + 1024 * 1024);
    await publisher.assertionWrite(CG_ID, 'too-large-promote', AGENT, quads);

    await expect(
      publisher.assertionPromote(CG_ID, 'too-large-promote', AGENT, { publisherPeerId: PEER }),
    ).rejects.toThrow(/Promoted assertion too large for gossip.*10\s*MB/i);

    const assertionQuads = await publisher.assertionQuery(CG_ID, 'too-large-promote', AGENT);
    expect(assertionQuads.length).toBe(quads.length);

    const swmResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${SWM_GRAPH}> { <urn:test:entity:too-large-promote:0> <http://schema.org/description> ?o } }`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      expect(swmResult.bindings.length).toBe(0);
    }
  });

  it('promote with entity filter only moves selected entities', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);

    const result = await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
      entities: ['urn:test:entity:alice'],
    });
    expect(result.promotedCount).toBe(2);

    const remaining = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(remaining.length).toBe(1);
    expect(remaining[0].subject).toBe('urn:test:entity:bob');

    const swmResult = await store.query(
      `SELECT ?s WHERE { GRAPH <${SWM_GRAPH}> { ?s ?p ?o } }`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      const swmSubjects = new Set(swmResult.bindings.map((b) => b['s']));
      expect(swmSubjects.has('urn:test:entity:alice')).toBe(true);
      expect(swmSubjects.has('urn:test:entity:bob')).toBe(false);
    }
  });

  it('discard drops the assertion graph', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await publisher.assertionDiscard(CG_ID, ASSERTION_NAME, AGENT);

    const quads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(quads.length).toBe(0);
  });

  it('different agents have isolated assertion graphs', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT_B);

    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, [
      { subject: 'urn:test:alice', predicate: 'http://schema.org/name', object: '"Alice"' },
    ]);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT_B, [
      { subject: 'urn:test:bob', predicate: 'http://schema.org/name', object: '"Bob"' },
    ]);

    const agentAQuads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(agentAQuads.length).toBe(1);
    expect(agentAQuads[0].subject).toBe('urn:test:alice');

    const agentBQuads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT_B);
    expect(agentBQuads.length).toBe(1);
    expect(agentBQuads[0].subject).toBe('urn:test:bob');
  });

  it('promote on empty assertion returns 0', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    const result = await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);
    expect(result.promotedCount).toBe(0);
  });

  it('promote records ShareTransition metadata in _shared_memory_meta', async () => {
    const SWM_META = `did:dkg:context-graph:${CG_ID}/_shared_memory_meta`;
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);

    const result = await store.query(
      `SELECT ?s ?type WHERE {
        GRAPH <${SWM_META}> {
          ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?type .
        }
      }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      const shareTransitions = result.bindings.filter(
        (b) => b['type'] === 'http://dkg.io/ontology/ShareTransition',
      );
      expect(shareTransitions.length).toBe(1);
      expect(shareTransitions[0]['s']).toMatch(/^urn:dkg:share:/);
    }
  });

  it('GH #748 migration: rewrites peer-ID literal wasAttributedTo → agent DID URI when AGENTS lookup hits, leaves miss as-is, backfills dkg:publisherPeerId on legacy per-root snapshots, skips marked CGs on re-run', async () => {
    // Canonical AGENTS graph URI — `did:dkg:context-graph:agents` (no /_data
    // suffix) per `contextGraphDataGraphUri('agents')` in @origintrail-official/dkg-core.
    const AGENTS_GRAPH = 'did:dkg:context-graph:agents';
    const CG_META = `did:dkg:context-graph:${CG_ID}/_meta`;
    const SWM_META = `did:dkg:context-graph:${CG_ID}/_shared_memory_meta`;
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const DKG = 'http://dkg.io/ontology/';
    // GH #748 Codex round 3: AGENTS registry uses the spec-aligned
    // `https://dkg.network/ontology#` namespace (same as `buildAgentProfile`
    // in agent/profile.ts), not the internal `http://dkg.io/ontology/` one
    // used by SWM meta predicates.
    const DKG_REGISTRY = 'https://dkg.network/ontology#';
    const PROV = 'http://www.w3.org/ns/prov#';

    // Seed AGENTS registry: one peer with a known agent address, one without.
    const PEER_KNOWN = '12D3KooWKnownPeer';
    const PEER_UNKNOWN = '12D3KooWUnknownPeer';
    // Lowercased per `canonicalAgentDidSubject` — matches what
    // `buildAgentProfile` writes when registering an agent.
    const ADDR_KNOWN = '0xaf7e932f79263f1a303790bd6c01b096f5334bbb';

    await store.insert([
      { subject: `did:dkg:agent:${ADDR_KNOWN}`, predicate: RDF_TYPE, object: `${DKG_REGISTRY}Agent`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${ADDR_KNOWN}`, predicate: `${DKG_REGISTRY}peerId`, object: `"${PEER_KNOWN}"`, graph: AGENTS_GRAPH },
    ]);

    // Seed SWM meta with three legacy rows that mirror real shapes:
    //   - WorkspaceOperation (resolvable peer) — already has both
    //     `dkg:publisherPeerId` and `prov:wasAttributedTo` (the new field
    //     should NOT be re-inserted by the backfill).
    //   - WorkspaceOperation (unresolved peer) — same two fields.
    //   - Per-root snapshot (resolvable peer) — only `prov:wasAttributedTo`
    //     literal, NO `dkg:publisherPeerId`. The migration must materialise
    //     the peer-ID field from the literal before rewriting.
    const OP_KNOWN = `urn:dkg:share:${CG_ID}:op-known`;
    const OP_UNKNOWN = `urn:dkg:share:${CG_ID}:op-unknown`;
    const SNAPSHOT_LEGACY = `urn:dkg:share:${CG_ID}:op-known:snapshot/urn:test:root`;
    await store.insert([
      { subject: OP_KNOWN, predicate: RDF_TYPE, object: `${DKG}WorkspaceOperation`, graph: SWM_META },
      { subject: OP_KNOWN, predicate: `${DKG}publisherPeerId`, object: `"${PEER_KNOWN}"`, graph: SWM_META },
      { subject: OP_KNOWN, predicate: `${PROV}wasAttributedTo`, object: `"${PEER_KNOWN}"`, graph: SWM_META },
      { subject: OP_UNKNOWN, predicate: RDF_TYPE, object: `${DKG}WorkspaceOperation`, graph: SWM_META },
      { subject: OP_UNKNOWN, predicate: `${DKG}publisherPeerId`, object: `"${PEER_UNKNOWN}"`, graph: SWM_META },
      { subject: OP_UNKNOWN, predicate: `${PROV}wasAttributedTo`, object: `"${PEER_UNKNOWN}"`, graph: SWM_META },
      // Legacy per-root snapshot row — wasAttributedTo only, no dkg:publisherPeerId
      { subject: SNAPSHOT_LEGACY, predicate: `${PROV}wasAttributedTo`, object: `"${PEER_KNOWN}"`, graph: SWM_META },
    ]);
    // Ensure the CG itself appears in `listContextGraphs` so the migration
    // visits its meta graph (the bare `_meta` graph plus any data is enough).
    await store.insert([
      { subject: `did:dkg:context-graph:${CG_ID}`, predicate: RDF_TYPE, object: `${DKG}ContextGraph`, graph: CG_META },
    ]);

    // First pass: rewrite resolvable rows (OP_KNOWN + SNAPSHOT_LEGACY = 2),
    // leave the unresolved one, drop a marker.
    const r1 = await publisher.migrateSwmAttributionToAgentDid();
    expect(r1.rewritten).toBe(2);
    expect(r1.skipped).toBe(1);

    const rowsAfter = await store.query(
      `SELECT ?s ?o WHERE { GRAPH <${SWM_META}> { ?s <${PROV}wasAttributedTo> ?o } }`,
    );
    expect(rowsAfter.type).toBe('bindings');
    if (rowsAfter.type === 'bindings') {
      const known = rowsAfter.bindings.find((b) => b['s'] === OP_KNOWN);
      const unknown = rowsAfter.bindings.find((b) => b['s'] === OP_UNKNOWN);
      const snapshot = rowsAfter.bindings.find((b) => b['s'] === SNAPSHOT_LEGACY);
      // Resolvable rows → URI form (no surrounding quotes).
      expect(known!['o']).toBe(`did:dkg:agent:${ADDR_KNOWN}`);
      expect(snapshot!['o']).toBe(`did:dkg:agent:${ADDR_KNOWN}`);
      // Unresolved peer → still a literal.
      expect(unknown!['o']).toBe(`"${PEER_UNKNOWN}"`);
    }

    // Backward-compat backfill: SNAPSHOT_LEGACY had no `dkg:publisherPeerId`
    // before the migration. After migration, it MUST carry the peer-ID
    // literal materialised from the old `wasAttributedTo` value, so the
    // post-fix readers (which now query `dkg:publisherPeerId`) still find it.
    const peerIdAfter = await store.query(
      `SELECT ?s ?o WHERE { GRAPH <${SWM_META}> { ?s <${DKG}publisherPeerId> ?o } }`,
    );
    expect(peerIdAfter.type).toBe('bindings');
    if (peerIdAfter.type === 'bindings') {
      const snapshotPid = peerIdAfter.bindings.find((b) => b['s'] === SNAPSHOT_LEGACY);
      expect(snapshotPid).toBeDefined();
      expect(snapshotPid!['o']).toBe(`"${PEER_KNOWN}"`);
      // OP_KNOWN already had a dkg:publisherPeerId — the migration must NOT
      // have duplicated it.
      const opKnownPids = peerIdAfter.bindings.filter((b) => b['s'] === OP_KNOWN);
      expect(opKnownPids.length).toBe(1);
    }

    // Codex round 2 Finding 6: marker is NOT written when cgSkipped > 0 (one
    // unresolved row remained). Future boots must retry as AGENTS data syncs.
    const markerAfter = await store.query(
      `SELECT ?ts WHERE { GRAPH <${CG_META}> { <urn:dkg:migration:swm-attr-agent-did> <${DKG}appliedAt> ?ts } }`,
    );
    expect(markerAfter.type).toBe('bindings');
    if (markerAfter.type === 'bindings') expect(markerAfter.bindings.length).toBe(0);

    // Second pass with no AGENTS changes: nothing new to resolve, marker
    // still not written, no churn — the literal-only filter eliminates the
    // already-rewritten URI rows so we only retry the genuine unresolved one.
    const r2 = await publisher.migrateSwmAttributionToAgentDid();
    expect(r2.rewritten).toBe(0);
    expect(r2.skipped).toBe(1);

    // Add the previously-missing AGENTS record for the unresolved peer.
    const ADDR_LATE = '0xba7e932f79263f1a303790bd6c01b096f5334bba';
    await store.insert([
      { subject: `did:dkg:agent:${ADDR_LATE}`, predicate: RDF_TYPE, object: `${DKG_REGISTRY}Agent`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${ADDR_LATE}`, predicate: `${DKG_REGISTRY}peerId`, object: `"${PEER_UNKNOWN}"`, graph: AGENTS_GRAPH },
    ]);
    // Third pass: the previously-unresolved row now resolves, and since
    // cgSkipped reaches 0 the marker finally gets written.
    const r3 = await publisher.migrateSwmAttributionToAgentDid();
    expect(r3.rewritten).toBe(1);
    expect(r3.skipped).toBe(0);
    const markerFinal = await store.query(
      `SELECT ?ts WHERE { GRAPH <${CG_META}> { <urn:dkg:migration:swm-attr-agent-did> <${DKG}appliedAt> ?ts } }`,
    );
    if (markerFinal.type === 'bindings') expect(markerFinal.bindings.length).toBe(1);

    // Fourth pass: marker present → fast-path skip; no SPARQL work.
    const r4 = await publisher.migrateSwmAttributionToAgentDid();
    expect(r4.rewritten).toBe(0);
    expect(r4.skipped).toBe(0);
  });

  it('GH #748 Codex round 2: ambiguous peer→agent mapping (multi-agent-per-node) leaves literal in place', async () => {
    // Two agents share the same libp2p peer ID (multi-agent-per-node, e.g.
    // via `DKGAgent.registerAgent`). The resolver must NOT pick one
    // arbitrarily — the migration leaves the legacy literal alone.
    const AGENTS_GRAPH = 'did:dkg:context-graph:agents';
    const CG_META = `did:dkg:context-graph:${CG_ID}/_meta`;
    const SWM_META = `did:dkg:context-graph:${CG_ID}/_shared_memory_meta`;
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const DKG = 'http://dkg.io/ontology/';
    const PROV = 'http://www.w3.org/ns/prov#';
    const PEER_SHARED = '12D3KooWMultiAgentNode';
    const ADDR_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const ADDR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    // GH #748 Codex round 3: registry namespace is `https://dkg.network/ontology#`.
    const DKG_REGISTRY = 'https://dkg.network/ontology#';

    await store.insert([
      { subject: `did:dkg:agent:${ADDR_A}`, predicate: RDF_TYPE, object: `${DKG_REGISTRY}Agent`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${ADDR_A}`, predicate: `${DKG_REGISTRY}peerId`, object: `"${PEER_SHARED}"`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${ADDR_B}`, predicate: RDF_TYPE, object: `${DKG_REGISTRY}Agent`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${ADDR_B}`, predicate: `${DKG_REGISTRY}peerId`, object: `"${PEER_SHARED}"`, graph: AGENTS_GRAPH },
    ]);

    const OP = `urn:dkg:share:${CG_ID}:op-ambiguous`;
    await store.insert([
      { subject: OP, predicate: RDF_TYPE, object: `${DKG}WorkspaceOperation`, graph: SWM_META },
      { subject: OP, predicate: `${DKG}publisherPeerId`, object: `"${PEER_SHARED}"`, graph: SWM_META },
      { subject: OP, predicate: `${PROV}wasAttributedTo`, object: `"${PEER_SHARED}"`, graph: SWM_META },
      { subject: `did:dkg:context-graph:${CG_ID}`, predicate: RDF_TYPE, object: `${DKG}ContextGraph`, graph: CG_META },
    ]);

    const r = await publisher.migrateSwmAttributionToAgentDid();
    expect(r.rewritten).toBe(0);
    expect(r.skipped).toBe(1);

    // The row stays as a literal — no arbitrary attribution.
    const after = await store.query(
      `SELECT ?o WHERE { GRAPH <${SWM_META}> { <${OP}> <${PROV}wasAttributedTo> ?o } }`,
    );
    if (after.type === 'bindings') {
      expect(after.bindings.length).toBe(1);
      expect(after.bindings[0]['o']).toBe(`"${PEER_SHARED}"`);
    }
  });

  it('full lifecycle: create → write → promote → verify SWM → discard', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);

    let quads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(quads.length).toBe(3);

    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);

    quads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(quads.length).toBe(0);

    const swmResult = await store.query(
      `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${SWM_GRAPH}> { ?s ?p ?o } }`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      const count = Number(String(swmResult.bindings[0]?.['c'] ?? '0').replace(/^"|"$/g, '').replace(/"?\^\^.*/, ''));
      expect(count).toBe(3);
    }

    await publisher.assertionDiscard(CG_ID, ASSERTION_NAME, AGENT);
  });
});

describe('Working Memory Assertion sub-graph registration check', () => {
  const SG_CG_ID = 'sg-check-cg';
  const SG_NAME = 'code';
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
  });

  async function registerSubGraph(): Promise<void> {
    const metaGraph = `did:dkg:context-graph:${SG_CG_ID}/_meta`;
    const sgUri = `did:dkg:context-graph:${SG_CG_ID}/${SG_NAME}`;
    await store.createGraph(metaGraph);
    await store.insert([
      {
        subject: sgUri,
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'http://dkg.io/ontology/SubGraph',
        graph: metaGraph,
      },
      {
        subject: sgUri,
        predicate: 'http://schema.org/name',
        object: `"${SG_NAME}"`,
        graph: metaGraph,
      },
      {
        subject: sgUri,
        predicate: 'http://dkg.io/ontology/createdBy',
        object: 'did:dkg:agent:test-agent',
        graph: metaGraph,
      },
    ]);
  }

  it('assertionCreate throws when sub-graph is not registered', async () => {
    await expect(
      publisher.assertionCreate(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME),
    ).rejects.toThrow(/Sub-graph "code" has not been registered/);
  });

  it('assertionWrite throws when sub-graph is not registered', async () => {
    await expect(
      publisher.assertionWrite(SG_CG_ID, ASSERTION_NAME, AGENT, TRIPLES, SG_NAME),
    ).rejects.toThrow(/Sub-graph "code" has not been registered/);
  });

  it('assertionPromote throws when sub-graph is not registered', async () => {
    await expect(
      publisher.assertionPromote(SG_CG_ID, ASSERTION_NAME, AGENT, { subGraphName: SG_NAME }),
    ).rejects.toThrow(/Sub-graph "code" has not been registered/);
  });

  it('assertion mutation guard requires full registration metadata, not just the SubGraph type marker', async () => {
    const metaGraph = `did:dkg:context-graph:${SG_CG_ID}/_meta`;
    const sgUri = `did:dkg:context-graph:${SG_CG_ID}/${SG_NAME}`;
    await store.createGraph(metaGraph);
    await store.insert([
      {
        subject: sgUri,
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'http://dkg.io/ontology/SubGraph',
        graph: metaGraph,
      },
    ]);

    await expect(
      publisher.assertionCreate(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME),
    ).rejects.toThrow(/Sub-graph "code" has not been registered/);
  });

  it('assertionQuery and assertionDiscard still work for legacy unregistered sub-graph graphs', async () => {
    const graphUri = contextGraphAssertionUri(SG_CG_ID, AGENT, ASSERTION_NAME, SG_NAME);
    await store.createGraph(graphUri);
    await store.insert(TRIPLES.map((triple) => ({ ...triple, graph: graphUri })));

    const quads = await publisher.assertionQuery(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    expect(quads.length).toBe(3);

    await publisher.assertionDiscard(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    const afterDiscard = await publisher.assertionQuery(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    expect(afterDiscard.length).toBe(0);
  });

  it('assertion ops succeed after the sub-graph is registered', async () => {
    await registerSubGraph();

    const uri = await publisher.assertionCreate(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    expect(uri).toContain(`/${SG_NAME}/`);

    await publisher.assertionWrite(SG_CG_ID, ASSERTION_NAME, AGENT, TRIPLES, SG_NAME);
    const quads = await publisher.assertionQuery(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    expect(quads.length).toBe(3);

    await publisher.assertionDiscard(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    const afterDiscard = await publisher.assertionQuery(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    expect(afterDiscard.length).toBe(0);
  });

  it('assertionPromote routes promoted triples into the registered sub-graph shared memory', async () => {
    const swmGraph = contextGraphSharedMemoryUri(SG_CG_ID, SG_NAME);

    await registerSubGraph();
    await publisher.assertionCreate(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    await publisher.assertionWrite(SG_CG_ID, ASSERTION_NAME, AGENT, TRIPLES, SG_NAME);

    const result = await publisher.assertionPromote(SG_CG_ID, ASSERTION_NAME, AGENT, { subGraphName: SG_NAME });
    expect(result.promotedCount).toBe(3);

    const assertionQuads = await publisher.assertionQuery(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    expect(assertionQuads.length).toBe(0);

    const swmResult = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      expect(swmResult.bindings.length).toBe(3);
    }
  });

  it('assertion ops without a sub-graph name still work (guard is opt-in)', async () => {
    const uri = await publisher.assertionCreate(SG_CG_ID, ASSERTION_NAME, AGENT);
    expect(uri).toBe(contextGraphAssertionUri(SG_CG_ID, AGENT, ASSERTION_NAME));
  });

  it('invalid sub-graph name is rejected before the registration check', async () => {
    await expect(
      publisher.assertionCreate(SG_CG_ID, ASSERTION_NAME, AGENT, 'Invalid Name With Spaces'),
    ).rejects.toThrow(/Invalid sub-graph name/);
  });
});

describe('Assertion Lifecycle Provenance (Event-Sourced, PROV-O)', () => {
  const META_GRAPH = `did:dkg:context-graph:${CG_ID}/_meta`;
  const DKG = 'http://dkg.io/ontology/';
  const PROV = 'http://www.w3.org/ns/prov#';
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
  });

  async function queryLifecycleState(name: string = ASSERTION_NAME): Promise<string | undefined> {
    const uri = assertionLifecycleUri(CG_ID, AGENT, name);
    const result = await store.query(
      `SELECT ?state WHERE { GRAPH <${META_GRAPH}> { <${uri}> <${DKG}state> ?state } } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;
    return result.bindings[0]['state']?.replace(/^"|"$/g, '');
  }

  async function queryMemoryLayer(name: string = ASSERTION_NAME): Promise<string | undefined> {
    const uri = assertionLifecycleUri(CG_ID, AGENT, name);
    const result = await store.query(
      `SELECT ?layer WHERE { GRAPH <${META_GRAPH}> { <${uri}> <${DKG}memoryLayer> ?layer } } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;
    return result.bindings[0]['layer']?.replace(/^"|"$/g, '');
  }

  async function queryEvents(name: string = ASSERTION_NAME): Promise<Array<{ type: string; fromLayer: string; toLayer: string }>> {
    const uri = assertionLifecycleUri(CG_ID, AGENT, name);
    const result = await store.query(
      `SELECT ?event ?type ?from ?to WHERE {
        GRAPH <${META_GRAPH}> {
          { ?event <${PROV}generated> <${uri}> }
          UNION
          { ?event <${PROV}used> <${uri}> }
          ?event a <${PROV}Activity> .
          ?event <${RDF_TYPE}> ?type .
          FILTER(STRSTARTS(STR(?type), "${DKG}"))
          ?event <${DKG}fromLayer> ?from .
          ?event <${DKG}toLayer> ?to .
        }
      } ORDER BY ?event`,
    );
    if (result.type !== 'bindings') return [];
    return result.bindings.map(b => ({
      type: (b['type'] ?? '').replace(DKG, ''),
      fromLayer: (b['from'] ?? '').replace(/^"|"$/g, ''),
      toLayer: (b['to'] ?? '').replace(/^"|"$/g, ''),
    }));
  }

  it('assertionCreate writes state "created" and memoryLayer "WM"', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    expect(await queryLifecycleState()).toBe('created');
    expect(await queryMemoryLayer()).toBe('WM');
  });

  it('assertionCreate includes assertionGraph link', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    const uri = assertionLifecycleUri(CG_ID, AGENT, ASSERTION_NAME);
    const result = await store.query(
      `SELECT ?g WHERE { GRAPH <${META_GRAPH}> { <${uri}> <${DKG}assertionGraph> ?g } } LIMIT 1`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings[0]['g']).toContain('/assertion/');
    }
  });

  it('assertionCreate produces an AssertionCreated event entity', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    const events = await queryEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('AssertionCreated');
    expect(events[0].fromLayer).toBe('none');
    expect(events[0].toLayer).toBe('WM');
  });

  it('promote updates state to "promoted" and memoryLayer to "SWM"', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);

    expect(await queryLifecycleState()).toBe('promoted');
    expect(await queryMemoryLayer()).toBe('SWM');
  });

  it('promote appends an AssertionPromoted event (WM → SWM)', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);

    const events = await queryEvents();
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('AssertionPromoted');
    expect(events[1].fromLayer).toBe('WM');
    expect(events[1].toLayer).toBe('SWM');
  });

  it('promote event records rootEntities and shareOperationId', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);

    const uri = assertionLifecycleUri(CG_ID, AGENT, ASSERTION_NAME);
    const evResult = await store.query(
      `SELECT ?event WHERE { GRAPH <${META_GRAPH}> { ?event <${PROV}used> <${uri}> . ?event a <${DKG}AssertionPromoted> } } LIMIT 1`,
    );
    expect(evResult.type).toBe('bindings');
    if (evResult.type === 'bindings') {
      const eventUri = evResult.bindings[0]['event'];
      const opResult = await store.query(
        `SELECT ?opId WHERE { GRAPH <${META_GRAPH}> { <${eventUri}> <${DKG}shareOperationId> ?opId } } LIMIT 1`,
      );
      expect(opResult.type === 'bindings' && opResult.bindings.length).toBeGreaterThan(0);
      const entityResult = await store.query(
        `SELECT ?entity WHERE { GRAPH <${META_GRAPH}> { <${eventUri}> <${DKG}rootEntity> ?entity } }`,
      );
      if (entityResult.type === 'bindings') {
        expect(entityResult.bindings.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('discard updates state to "discarded" and removes memoryLayer', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionDiscard(CG_ID, ASSERTION_NAME, AGENT);

    expect(await queryLifecycleState()).toBe('discarded');
    expect(await queryMemoryLayer()).toBeUndefined();
  });

  it('discard appends an AssertionDiscarded event (WM → none)', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionDiscard(CG_ID, ASSERTION_NAME, AGENT);

    const events = await queryEvents();
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('AssertionDiscarded');
    expect(events[1].fromLayer).toBe('WM');
    expect(events[1].toLayer).toBe('none');
  });

  it('lifecycle record persists in _meta even after assertion graph is emptied', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);

    const assertionQuads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(assertionQuads.length).toBe(0);

    expect(await queryLifecycleState()).toBe('promoted');
    expect(await queryMemoryLayer()).toBe('SWM');
  });

  it('lifecycle record and events persist after discard drops the data graph', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await publisher.assertionDiscard(CG_ID, ASSERTION_NAME, AGENT);

    const events = await queryEvents();
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('AssertionCreated');
    expect(events[1].type).toBe('AssertionDiscarded');
  });

  it('different agents have separate lifecycle records', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT_B);

    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);

    expect(await queryLifecycleState()).toBe('promoted');

    const uriBResult = await store.query(
      `SELECT ?state WHERE { GRAPH <${META_GRAPH}> { <${assertionLifecycleUri(CG_ID, AGENT_B, ASSERTION_NAME)}> <${DKG}state> ?state } } LIMIT 1`,
    );
    expect(uriBResult.type).toBe('bindings');
    if (uriBResult.type === 'bindings') {
      expect(uriBResult.bindings[0]['state']?.replace(/^"|"$/g, '')).toBe('created');
    }
  });
});
