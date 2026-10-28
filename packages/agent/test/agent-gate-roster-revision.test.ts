// SPDX-License-Identifier: Apache-2.0

// The agent gate of a real agent prototype over the real store, projection and
// production store wrapper: which writes make it read its roster again (GH#3069).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS, contextGraphDataGraphUri } from '@origintrail-official/dkg-core';
import { type OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';

import { DKGAgent } from '../src/dkg-agent.js';
import type { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import {
  resolveContextGraphAgentGateAuthorityDecision,
} from '../src/internal/context-graph-authority/context-graph-agent-gate-authority.js';
import {
  CG_DID, CONTROL_GRAPH, KA_GRAPH, KA_UAL, MEMORY_LAYER, META_GRAPH, NAME, SWM_META_GRAPH, keyFact, quad, stack,
} from './_helpers/recipient-fence-stack.js';

const CG = '0xabc/proj';
const OTHER_CG = '0xother/graph';
const OTHER_DID = `did:dkg:context-graph:${OTHER_CG}`;
const OTHER_META = `${OTHER_DID}/_meta`;
const AGENTS_GRAPH = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
const ONTOLOGY_GRAPH = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
const WALLET_LOCKS = 'urn:dkg:publisher:wallet-locks';
const ALLOWED = DKG_ONTOLOGY.DKG_ALLOWED_AGENT;
const PARTICIPANT = DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT;
const REVOKED = DKG_ONTOLOGY.DKG_REVOKED_AGENT;

const signer = new ethers.Wallet(`0x${'5'.repeat(64)}`);
const MEMBER = signer.address;
const OTHER_MEMBER = ethers.getAddress(`0x${'22'.repeat(20)}`);
const JOINER = ethers.getAddress(`0x${'33'.repeat(20)}`);
const literal = (value: string): string => `"${value}"`;
const fact = (predicate: string, agent: string, graph = META_GRAPH, subject = CG_DID): Quad => (
  { subject, predicate, object: literal(agent), graph }
);

type Write = (store: TripleStore, projection: ContextGraphMetaProjection) => Promise<unknown> | void;
type Gate = Awaited<ReturnType<typeof resolveContextGraphAgentGateAuthorityDecision>>;
const sorted = (authority: Gate): Gate => (
  authority.kind === 'available'
    ? { kind: 'available', agentAddresses: [...authority.agentAddresses].sort() }
    : authority
);
const available = (...agents: string[]): Gate => ({ kind: 'available', agentAddresses: [...agents].sort() });

const stores: OxigraphStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

/**
 * An agent whose gate reads this store. Chain authority is the one thing stubbed:
 * it answers that the graph is public, which leaves the decision to the local
 * roster, and a test can make a read of it take as long as a write of its own.
 */
async function open(options: {
  members?: readonly string[];
  seed?: readonly Quad[];
  inner?: (store: OxigraphStore) => TripleStore;
} = {}) {
  const built = await stack(options.inner ? { inner: options.inner } : {});
  stores.push(built.store);
  await built.wrapper.insert([
    ...(options.members ?? [MEMBER, OTHER_MEMBER]).map((member) => fact(ALLOWED, member)),
    ...(options.seed ?? []),
  ]);
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.contextGraphMetaProjection = built.projection;
  agent.store = built.wrapper;
  agent.subscribedContextGraphs = new Map();
  agent.localAgents = new Map([[MEMBER.toLowerCase(), { agentAddress: MEMBER, privateKey: signer.privateKey }]]);
  let whileTransportIsRead: (() => Promise<unknown> | void) | undefined;
  agent.resolveSwmTransportAuthority = vi.fn(async () => {
    await whileTransportIsRead?.();
    return { kind: 'plaintext' };
  });
  const rosterReads = vi.spyOn(agent, 'getCgMeta');
  return {
    ...built,
    agent,
    rosterReads,
    gate: async (contextGraphId = CG): Promise<Gate> => sorted(await agent.resolveContextGraphAgentGateAuthority(contextGraphId)),
    /**
     * Run `write` in the next resolution, after the gate has read its roster
     * the first time and before it compares revisions: its second chain read.
     */
    landDuringFirstRead(write: Write): void {
      let reads = 0;
      whileTransportIsRead = async () => {
        reads += 1;
        if (reads === 2) await write(built.wrapper, built.projection);
      };
    },
    /** Run `during` in every chain read the gate makes. */
    landDuringEveryRead(during: () => Promise<unknown>): void {
      whileTransportIsRead = during;
    },
  };
}

describe('agent gate: writes that cannot change its roster (GH#3069)', () => {
  const unrelated: Array<[string, Write]> = [
    ['an agent is allowed into another context graph', (s) => s.insert([fact(ALLOWED, JOINER, OTHER_META, OTHER_DID)])],
    ['a member of another context graph is revoked', (s) => s.insert([fact(REVOKED, MEMBER, OTHER_META, OTHER_DID)])],
    ['the roster of another context graph is replaced', (s) => s.replaceSubject!(OTHER_META, OTHER_DID, [
      fact(ALLOWED, JOINER, OTHER_META, OTHER_DID)])],
    ['another context graph is invalidated', (_s, projection) => projection.markDirty(OTHER_CG)],
    ['an agent is allowed into another context graph through the shared agents graph', (s) => s.insert([
      fact(ALLOWED, JOINER, AGENTS_GRAPH, OTHER_DID)])],
    ['a promote-queue job is replaced', (s) => s.replaceSubject!(CONTROL_GRAPH, 'urn:dkg:promote-queue:job:j1', [
      quad('urn:dkg:promote-queue:job:j1', 'urn:dkg:promote-queue:state', CONTROL_GRAPH)])],
    ['a wallet lock is released', (s) => s.deleteByPatternWithoutCount!({ graph: WALLET_LOCKS, subject: 'urn:dkg:publisher:lock:1' })],
    ['a named graph that is not a context graph is dropped', (s) => s.dropGraph(WALLET_LOCKS)],
    ['knowledge-asset metadata is replaced in its own meta graph', (s) => s.replaceSubject!(META_GRAPH, KA_UAL, [
      quad(KA_UAL, NAME, META_GRAPH)])],
    ['knowledge-asset metadata is deleted from its own meta graph', (s) => s.deleteByPatternWithoutCount!({
      graph: META_GRAPH, subject: KA_UAL })],
    ['an assertion layer is deleted from its own meta graph', (s) => s.deleteByPatternWithoutCount!({
      graph: META_GRAPH, subject: KA_GRAPH, predicate: MEMORY_LAYER })],
    ['a knowledge asset and its metadata are replaced together', (s) => s.replaceGraphAndSubject!(
      `${CG_DID}/_shared_memory/b`, [quad('urn:x:doc', NAME, `${CG_DID}/_shared_memory/b`)],
      META_GRAPH, KA_UAL, [quad(KA_UAL, NAME, META_GRAPH)])],
    ['share metadata is deleted from its shared-memory meta graph', (s) => s.deleteByPatternWithoutCount!({
      graph: SWM_META_GRAPH, subject: 'urn:dkg:share:s1' })],
    ['an agent publishes a key', (s) => s.insert([keyFact()])],
    // The roster predicate, on a subject no record reads, in a graph no record reads.
    ['content names a roster predicate on a blank node', (s) => s.insert([
      { subject: '_:b0', predicate: ALLOWED, object: literal(JOINER), graph: KA_GRAPH }])],
  ];

  it.each(unrelated)('answers from one read when %s during it', async (_label, write) => {
    const { gate, landDuringFirstRead, rosterReads, projection } = await open();
    const rosterRevision = projection.peerGateRevision.read(CG);
    const nodeWideRevision = projection.readAuthorityFactsRevision;
    landDuringFirstRead(write);

    await expect(gate()).resolves.toEqual(available(MEMBER, OTHER_MEMBER));

    expect(rosterReads).toHaveBeenCalledTimes(1);
    expect(projection.peerGateRevision.read(CG)).toBe(rosterRevision);
    // Each of these moves the node-wide revision, which the gate used to compare.
    expect(projection.readAuthorityFactsRevision).not.toBe(nodeWideRevision);
  });
});

describe('agent gate: writes that change its roster (GH#3069)', () => {
  const REVOKED_BEFORE = fact(REVOKED, OTHER_MEMBER);
  const SHARED_BEFORE = fact(ALLOWED, JOINER, AGENTS_GRAPH);
  const changes: Array<[string, Write, Gate, (readonly Quad[])?]> = [
    ['an agent is allowed', (s) => s.insert([fact(ALLOWED, JOINER)]), available(MEMBER, OTHER_MEMBER, JOINER)],
    ['a participant agent is added', (s) => s.insert([fact(PARTICIPANT, JOINER)]), available(MEMBER, OTHER_MEMBER, JOINER)],
    ['a member is revoked', (s) => s.insert([fact(REVOKED, MEMBER)]), available(OTHER_MEMBER)],
    ['a member is removed by pattern', (s) => s.deleteByPatternWithoutCount!({
      graph: META_GRAPH, subject: CG_DID, predicate: ALLOWED, object: literal(MEMBER) }), available(OTHER_MEMBER)],
    ['a member is removed by value', (s) => s.delete([fact(ALLOWED, MEMBER)]), available(OTHER_MEMBER)],
    ['a revocation is lifted', (s) => s.deleteByPatternWithoutCount!({
      graph: META_GRAPH, subject: CG_DID, predicate: REVOKED }), available(MEMBER, OTHER_MEMBER), [REVOKED_BEFORE]],
    ['its own subject is replaced', (s) => s.replaceSubject!(META_GRAPH, CG_DID, [fact(ALLOWED, JOINER)]), available(JOINER)],
    ['its meta graph is replaced', (s) => s.replaceGraph!(META_GRAPH, [fact(ALLOWED, JOINER)]), available(JOINER)],
    ['its meta graph is dropped', (s) => s.dropGraph(META_GRAPH), { kind: 'ungated' }],
    ['an agent is allowed in the shared agents graph', (s) => s.insert([fact(ALLOWED, JOINER, AGENTS_GRAPH)]),
      available(MEMBER, OTHER_MEMBER, JOINER)],
    ['a member is revoked in the shared agents graph', (s) => s.insert([fact(REVOKED, MEMBER, AGENTS_GRAPH)]),
      available(OTHER_MEMBER)],
    ['an agent is removed from the shared agents graph', (s) => s.deleteByPatternWithoutCount!({
      graph: AGENTS_GRAPH, subject: CG_DID, predicate: ALLOWED }), available(MEMBER, OTHER_MEMBER), [SHARED_BEFORE]],
    ['an agent is allowed in the shared ontology graph', (s) => s.insert([fact(ALLOWED, JOINER, ONTOLOGY_GRAPH)]),
      available(MEMBER, OTHER_MEMBER, JOINER)],
    ['a member is revoked in the shared ontology graph', (s) => s.insert([fact(REVOKED, MEMBER, ONTOLOGY_GRAPH)]),
      available(OTHER_MEMBER)],
    ['a participant is removed from the shared ontology graph by value', (s) => s.delete([
      fact(PARTICIPANT, JOINER, ONTOLOGY_GRAPH)]), available(MEMBER, OTHER_MEMBER), [fact(PARTICIPANT, JOINER, ONTOLOGY_GRAPH)]],
    ['an update revokes a member', (s) => s.update!(
      `INSERT DATA { GRAPH <${META_GRAPH}> { <${CG_DID}> <${REVOKED}> ${literal(MEMBER)} } }`), available(OTHER_MEMBER)],
  ];

  it.each(changes)('reads its roster again when %s during the read', async (_label, write, expected, seed) => {
    const { gate, landDuringFirstRead, rosterReads, projection } = await open({ seed });
    const before = await gate();
    rosterReads.mockClear();
    const rosterRevision = projection.peerGateRevision.read(CG);
    landDuringFirstRead(write);

    const authority = await gate();

    expect(authority).toEqual(expected);
    expect(authority).not.toEqual(before);
    expect(rosterReads).toHaveBeenCalledTimes(2);
    expect(projection.peerGateRevision.read(CG)).not.toBe(rosterRevision);
  });

  // Only a plain IRI is stored as written. These model what the SPARQL adapters
  // do with the other terms: a blank node in a delete matches any subject, and
  // the characters a graph name may not hold are dropped from it.
  const asSparqlAdapter = (inner: OxigraphStore): TripleStore => new Proxy(inner, {
    get(target, property) {
      if (property === 'delete') {
        return async (quads: Quad[]) => {
          for (const { subject, ...pattern } of quads) {
            if (subject.startsWith('_:')) await target.deleteByPattern(pattern);
            else await target.delete([{ subject, ...pattern }]);
          }
        };
      }
      if (property === 'insert') {
        return (quads: Quad[]) => target.insert(quads.map((q) => ({ ...q, graph: q.graph.replace(/[<>"{}|\\^`]/g, '') })));
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });

  const blankNode = (predicate: string, agent: string, graph: string): Quad => (
    { subject: '_:b0', predicate, object: literal(agent), graph }
  );
  const unattributed: Array<[string, Write, Gate, (readonly Quad[])?]> = [
    ['a delete removes a member through a blank node that the store matches against any subject',
      (s) => s.delete([blankNode(ALLOWED, MEMBER, META_GRAPH)]), available(OTHER_MEMBER)],
    ['a delete does the same in the shared agents graph',
      (s) => s.delete([blankNode(ALLOWED, JOINER, AGENTS_GRAPH)]), available(MEMBER, OTHER_MEMBER), [SHARED_BEFORE]],
    ['a delete does the same in the shared ontology graph',
      (s) => s.delete([blankNode(PARTICIPANT, JOINER, ONTOLOGY_GRAPH)]), available(MEMBER, OTHER_MEMBER),
      [fact(PARTICIPANT, JOINER, ONTOLOGY_GRAPH)]],
    ['a revocation is stored in its meta graph under a name the store cleans',
      (s) => s.insert([fact(REVOKED, MEMBER, `${META_GRAPH}{}`)]), available(OTHER_MEMBER)],
    ['a revocation is stored in the shared agents graph under a name the store cleans',
      (s) => s.insert([fact(REVOKED, MEMBER, `${AGENTS_GRAPH}|`)]), available(OTHER_MEMBER)],
  ];

  it.each(unattributed)('reads its roster again when %s', async (_label, write, expected, seed) => {
    const { gate, landDuringFirstRead, rosterReads } = await open({ inner: asSparqlAdapter, seed });
    landDuringFirstRead(write);

    await expect(gate()).resolves.toEqual(expected);
    expect(rosterReads).toHaveBeenCalledTimes(2);
  });

  it('keeps the record of every graph current after a roster fact it cannot attribute', async () => {
    const { gate, wrapper, projection } = await open({ inner: asSparqlAdapter });
    await expect(gate()).resolves.toEqual(available(MEMBER, OTHER_MEMBER));

    await wrapper.delete([{ subject: '_:b0', predicate: ALLOWED, object: literal(MEMBER), graph: META_GRAPH }]);

    await expect(gate()).resolves.toEqual(available(OTHER_MEMBER));
    expect((await projection.get(CG)).allowedAgents).toEqual([OTHER_MEMBER]);
  });
});

describe('agent gate under unrelated store traffic (GH#3069)', () => {
  // What a busy node writes while a share resolves its signer. None of it is a roster fact of this graph.
  const traffic: Array<(store: TripleStore, n: number) => Promise<unknown>> = [
    (s, n) => s.replaceSubject!(CONTROL_GRAPH, `urn:dkg:promote-queue:job:j${n}`, [
      quad(`urn:dkg:promote-queue:job:j${n}`, 'urn:dkg:promote-queue:state', CONTROL_GRAPH)]),
    (s, n) => s.replaceGraphAndSubject!(
      `${CG_DID}/_shared_memory/a${n}`, [quad('urn:x:doc', NAME, `${CG_DID}/_shared_memory/a${n}`)],
      META_GRAPH, KA_UAL, [quad(KA_UAL, NAME, META_GRAPH)]),
    (s) => s.deleteByPatternWithoutCount!({ graph: SWM_META_GRAPH, subject: 'urn:dkg:share:s1' }),
    (s) => s.insert([fact(ALLOWED, JOINER, OTHER_META, OTHER_DID)]),
    (s) => s.dropGraph(WALLET_LOCKS),
    (s) => s.insert([keyFact()]),
  ];

  /** Writes one after another until stopped. `next()` settles once a write that began after the call has landed. */
  function writer(store: TripleStore, writes = traffic) {
    let stopped = false;
    let landed = 0;
    let waiting: Array<{ after: number; wake: () => void }> = [];
    const loop = (async () => {
      for (let n = 0; !stopped; n += 1) {
        await writes[n % writes.length](store, n);
        landed += 1;
        const due = waiting.filter(({ after }) => landed > after);
        waiting = waiting.filter(({ after }) => landed <= after);
        for (const { wake } of due) wake();
      }
    })();
    return {
      get landed() { return landed; },
      // One write may already be in flight; the one after it began after this call.
      next: () => new Promise<void>((wake) => { waiting.push({ after: landed + 1, wake }); }),
      async stop() {
        stopped = true;
        await loop;
      },
    };
  }

  it('answers and finds its signer while unrelated writes land during every one of its reads', async () => {
    const { agent, gate, landDuringEveryRead, rosterReads, projection, wrapper } = await open({ members: [MEMBER] });
    const busy = writer(wrapper);
    landDuringEveryRead(() => busy.next());
    try {
      // The same reads, compared on the node-wide revision, are refused: each sees it move.
      const nodeWideRevision = projection.readAuthorityFactsRevision;
      await expect(resolveContextGraphAgentGateAuthorityDecision({
        contextGraphId: CG,
        getTransportAuthority: () => agent.resolveSwmTransportAuthority(CG),
        readRosterRevision: () => projection.readAuthorityFactsRevision,
        getLegacyMeta: () => projection.get(CG),
        getSubscriptionAgents: () => [],
      })).resolves.toMatchObject({ kind: 'unavailable', reason: 'local-existence-unavailable' });
      expect(projection.readAuthorityFactsRevision).toBeGreaterThan(nodeWideRevision + 2);

      const rosterRevision = projection.peerGateRevision.read(CG);
      const landedBefore = busy.landed;
      await expect(gate()).resolves.toEqual(available(MEMBER));
      await expect(agent.getContextGraphAgentGateAddresses(CG)).resolves.toEqual([MEMBER]);
      await expect(agent.resolveWorkspaceGossipSigningAgent(CG)).resolves.toMatchObject({ agentAddress: MEMBER });

      expect(rosterReads).toHaveBeenCalledTimes(3);
      expect(busy.landed - landedBefore).toBeGreaterThanOrEqual(6);
      expect(projection.peerGateRevision.read(CG)).toBe(rosterRevision);
    } finally {
      await busy.stop();
    }
  });

  it('answers ungated for a graph without a roster under the same traffic', async () => {
    const { agent, landDuringEveryRead, rosterReads, wrapper } = await open({ members: [] });
    const busy = writer(wrapper);
    landDuringEveryRead(() => busy.next());
    try {
      await expect(agent.getContextGraphAgentGateAddresses(CG)).resolves.toBeNull();
      expect(rosterReads).toHaveBeenCalledTimes(1);
    } finally {
      await busy.stop();
    }
  });

  it('still leaves out a member revoked in the middle of that traffic', async () => {
    const { agent, landDuringEveryRead, rosterReads, wrapper } = await open();
    const busy = writer(wrapper);
    let reads = 0;
    landDuringEveryRead(async () => {
      reads += 1;
      // The gate has read its roster once; the revocation lands before it compares revisions.
      if (reads === 2) await wrapper.insert([fact(REVOKED, MEMBER)]);
      await busy.next();
    });
    try {
      await expect(agent.getContextGraphAgentGateAddresses(CG)).resolves.toEqual([OTHER_MEMBER]);
      expect(rosterReads).toHaveBeenCalledTimes(2);
    } finally {
      await busy.stop();
    }
  });
});
