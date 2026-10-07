// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';

import {
  RECIPIENT_KEY_ROUTE_PREDICATES,
  RecipientKeyRouteFence,
} from '../src/internal/recipient-key-route-fence.js';

const AGENT = 'did:dkg:agent:0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const AGENT_LOWER = AGENT.toLowerCase();
const KEY_IRI = `${AGENT_LOWER}#x25519-0123456789abcdef0123456789abcdef`;
const PROFILE_GRAPH = 'did:dkg:context-graph:agents';
const DATA_GRAPH = 'did:dkg:context-graph:0xabc/proj/assertion/0xdef/notes';
const MEMORY_LAYER = 'http://dkg.io/ontology/memoryLayer';

const quad = (subject: string, predicate: string, graph = PROFILE_GRAPH): Quad => ({
  subject,
  predicate,
  object: '"v"',
  graph,
});

/** A store whose only job is to answer the key-graph scan. */
function scanStore(graphs: string[] | (() => never)): { store: TripleStore; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => {
    if (typeof graphs === 'function') graphs();
    return { type: 'bindings' as const, bindings: (graphs as string[]).map((g) => ({ g })) };
  });
  return { store: { query } as unknown as TripleStore, query };
}

async function readyFence(graphs: string[] = [PROFILE_GRAPH]): Promise<RecipientKeyRouteFence> {
  const fence = new RecipientKeyRouteFence(scanStore(graphs).store);
  await fence.ensureReady();
  return fence;
}

function moved(fence: RecipientKeyRouteFence, act: () => void): boolean {
  const before = fence.revision;
  act();
  return fence.revision !== before;
}

describe('RecipientKeyRouteFence (GH#3067)', () => {
  describe('key and route predicates', () => {
    it('are exactly the seven the recipient key lookup reads', () => {
      expect([...RECIPIENT_KEY_ROUTE_PREDICATES].sort()).toEqual([
        DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_ALGORITHM,
        DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_PROOF,
        DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_REVOCATION_PROOF,
        DKG_ONTOLOGY.DKG_PEER_ID,
        DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY,
        DKG_ONTOLOGY.DKG_REVOKED_AT,
        DKG_ONTOLOGY.DKG_REVOKED_BY,
      ].sort());
    });
  });

  describe('noteQuads', () => {
    it.each([...RECIPIENT_KEY_ROUTE_PREDICATES])('moves for %s on an agent DID, a lowercase DID and a key IRI', async (predicate) => {
      const fence = await readyFence();
      for (const subject of [AGENT, AGENT_LOWER, KEY_IRI, `<${AGENT}>`]) {
        expect(moved(fence, () => fence.noteQuads([quad(subject, predicate)])), subject).toBe(true);
      }
    });

    it('sees a bracketed predicate and remembers a bracketed graph under its bare name', async () => {
      const fence = await readyFence([]);
      const bracketed = { subject: AGENT, predicate: `<${DKG_ONTOLOGY.DKG_PEER_ID}>`, object: '"p"', graph: `<${DATA_GRAPH}>` };
      expect(moved(fence, () => fence.noteQuads([bracketed]))).toBe(true);
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(true);
    });

    it('moves for a key predicate on a blank node, which a store may turn into a variable that matches an agent', async () => {
      const fence = await readyFence();
      for (const predicate of RECIPIENT_KEY_ROUTE_PREDICATES) {
        expect(moved(fence, () => fence.noteQuads([quad('_:b0', predicate)])), predicate).toBe(true);
      }
      expect(moved(fence, () => fence.noteQuads([quad('_:b0', 'http://schema.org/name')]))).toBe(false);
    });

    it('learns the graph of a blank-node key quad before it is dispatched', async () => {
      const fence = await readyFence([PROFILE_GRAPH]);
      fence.begin({ quads: [quad('_:b0', DKG_ONTOLOGY.DKG_PEER_ID, DATA_GRAPH)] });
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(true);
    });

    it('does not move for a key predicate on a subject that is not an agent', async () => {
      const fence = await readyFence();
      const quads = [...RECIPIENT_KEY_ROUTE_PREDICATES].flatMap((predicate) => [
        quad('urn:dkg:share:s1', predicate, 'did:dkg:context-graph:0xabc/proj/_shared_memory_meta'),
        quad('did:dkg:context-graph:0xabc/proj', predicate),
        quad('urn:dkg:promote-queue:job:j1', predicate, 'urn:dkg:promote-queue:control-plane'),
      ]);
      expect(moved(fence, () => fence.noteQuads(quads))).toBe(false);
    });

    it('does not move for an agent subject with any other predicate', async () => {
      const fence = await readyFence();
      const quads = [
        quad(AGENT, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
        quad(AGENT, 'http://schema.org/name'),
        quad(AGENT, DKG_ONTOLOGY.DKG_ALLOWED_AGENT),
        quad(AGENT, DKG_ONTOLOGY.DKG_ACCESS_POLICY),
      ];
      expect(moved(fence, () => fence.noteQuads(quads))).toBe(false);
      expect(moved(fence, () => fence.noteQuads([]))).toBe(false);
    });

    it('moves once for a mixed batch and remembers every graph that held a fact', async () => {
      const fence = await readyFence([]);
      const before = fence.revision;
      fence.noteQuads([
        quad('urn:x:y', 'http://schema.org/name', 'urn:dkg:other'),
        quad(AGENT, DKG_ONTOLOGY.DKG_PEER_ID, 'urn:dkg:graph-a'),
        quad(AGENT, DKG_ONTOLOGY.DKG_REVOKED_AT, 'urn:dkg:graph-b'),
      ]);
      expect(fence.revision).toBe(before + 1);
      expect(moved(fence, () => fence.noteRemoval({ graph: 'urn:dkg:graph-a' }))).toBe(true);
      expect(moved(fence, () => fence.noteRemoval({ graph: 'urn:dkg:graph-b' }))).toBe(true);
      expect(moved(fence, () => fence.noteRemoval({ graph: 'urn:dkg:other' }))).toBe(false);
    });
  });

  describe('noteRemoval: each proof of harmlessness stands alone', () => {
    it('a bare subject that is not an agent DID proves it, whatever the graph', async () => {
      const fence = await readyFence([PROFILE_GRAPH, DATA_GRAPH]);
      for (const subject of [
        'urn:dkg:promote-queue:job:j1',
        'urn:dkg:publisher:lift-job:l1',
        'urn:dkg:share:s1',
        'did:dkg:base:84532/0x1234567890123456789012345678901234567890/7',
        'did:dkg:context-graph:0xabc/proj/assertion/0xdef/notes',
      ]) {
        expect(moved(fence, () => fence.noteRemoval({ graph: PROFILE_GRAPH, subject })), subject).toBe(false);
      }
    });

    it('a bare predicate that is not a key or route predicate proves it, whatever the graph and subject', async () => {
      const fence = await readyFence([PROFILE_GRAPH]);
      expect(moved(fence, () => fence.noteRemoval({ graph: PROFILE_GRAPH, predicate: MEMORY_LAYER }))).toBe(false);
      expect(moved(fence, () => fence.noteRemoval({ predicate: 'http://schema.org/name' }))).toBe(false);
      expect(moved(fence, () => fence.noteRemoval({ subject: AGENT, predicate: 'http://schema.org/name' }))).toBe(false);
    });

    it('a graph that never held a key fact proves it once the graphs are known', async () => {
      const fence = await readyFence([PROFILE_GRAPH]);
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(false);
      expect(moved(fence, () => fence.noteRemoval({ graph: `<${DATA_GRAPH}>` }))).toBe(false);
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH, predicate: DKG_ONTOLOGY.DKG_PEER_ID }))).toBe(false);
    });

    it('does not move for an agent subject in a graph that never held a key fact', async () => {
      const fence = await readyFence([PROFILE_GRAPH]);
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH, subject: AGENT }))).toBe(false);
    });

    it('moves for everything it cannot prove harmless', async () => {
      const fence = await readyFence([PROFILE_GRAPH]);
      for (const [label, scope] of [
        ['agent DID subject in a key graph', { graph: PROFILE_GRAPH, subject: AGENT }],
        ['key IRI subject in a key graph', { graph: PROFILE_GRAPH, subject: KEY_IRI }],
        ['agent DID subject, graph unknown', { subject: AGENT }],
        ['key predicate, graph unknown', { predicate: DKG_ONTOLOGY.DKG_PEER_ID }],
        ['a graph that holds key facts', { graph: PROFILE_GRAPH }],
        ['nothing named', {}],
        ['a key predicate on a key graph', { graph: PROFILE_GRAPH, predicate: DKG_ONTOLOGY.DKG_REVOKED_AT }],
      ] as const) {
        expect(moved(fence, () => fence.noteRemoval(scope)), label).toBe(true);
      }
    });

    it.each([
      ['an empty subject (a wildcard on some stores)', { subject: '', graph: PROFILE_GRAPH }],
      ['a half-bracketed subject', { subject: `<${AGENT}`, graph: PROFILE_GRAPH }],
      ['a bracketed agent subject', { subject: `<${AGENT}>`, graph: PROFILE_GRAPH }],
      ['a subject with a space', { subject: 'urn:x y', graph: PROFILE_GRAPH }],
      ['a subject with a quote', { subject: 'urn:x"y', graph: PROFILE_GRAPH }],
      ['a subject with braces', { subject: 'urn:x{y}', graph: PROFILE_GRAPH }],
      ['a subject with a pipe', { subject: 'urn:x|y', graph: PROFILE_GRAPH }],
      ['a subject with a backslash', { subject: 'urn:x\\y', graph: PROFILE_GRAPH }],
      ['a subject with a caret', { subject: 'urn:x^y', graph: PROFILE_GRAPH }],
      ['a subject with a backtick', { subject: 'urn:x`y', graph: PROFILE_GRAPH }],
      ['a name without a scheme', { subject: 'relative-name', graph: PROFILE_GRAPH }],
      ['an unsafe predicate', { predicate: 'urn:p q', graph: PROFILE_GRAPH }],
      ['an empty predicate', { predicate: '', graph: PROFILE_GRAPH }],
    ])('does not trust %s as proof', async (_label, scope) => {
      const fence = await readyFence([PROFILE_GRAPH]);
      expect(moved(fence, () => fence.noteRemoval(scope))).toBe(true);
    });

    it('does not trust an empty or unsafe graph even when everything else is known', async () => {
      const fence = await readyFence([PROFILE_GRAPH]);
      expect(moved(fence, () => fence.noteRemoval({ graph: '' }))).toBe(true);
      expect(moved(fence, () => fence.noteRemoval({ graph: 'urn:g h' }))).toBe(true);
      expect(moved(fence, () => fence.noteRemoval({ graph: '<urn:g' }))).toBe(true);
      expect(moved(fence, () => fence.noteRemoval({ graph: 'relative-graph' }))).toBe(true);
    });
  });

  describe('which graphs hold key facts', () => {
    it('is untrusted until the scan has run, so a bare graph proves nothing', () => {
      const fence = new RecipientKeyRouteFence(scanStore([]).store);
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(true);
    });

    it('does not trust a scan whose answer is not a list of bindings', async () => {
      const query = vi.fn(async () => ({ type: 'boolean' as const, boolean: true }));
      const fence = new RecipientKeyRouteFence({ query } as unknown as TripleStore);
      await fence.ensureReady();
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(true);
    });

    it('stays untrusted when the scan fails, never throws into the caller, and recovers on the next attempt', async () => {
      let failing = true;
      const query = vi.fn(async () => {
        if (failing) throw new Error('store busy');
        return { type: 'bindings' as const, bindings: [{ g: PROFILE_GRAPH }] };
      });
      const fence = new RecipientKeyRouteFence({ query } as unknown as TripleStore);
      await expect(fence.ensureReady()).resolves.toBeUndefined();
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(true);
      failing = false;
      await fence.ensureReady();
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(false);
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('shares one scan between concurrent callers and does not rescan once trusted', async () => {
      const { store, query } = scanStore([PROFILE_GRAPH]);
      const fence = new RecipientKeyRouteFence(store);
      await Promise.all([fence.ensureReady(), fence.ensureReady(), fence.ensureReady()]);
      await fence.ensureReady();
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('treats a write that names no quads as making the scan stale, and a stale scan never becomes trusted', async () => {
      const { store, query } = scanStore([PROFILE_GRAPH]);
      const fence = new RecipientKeyRouteFence(store);
      await fence.ensureReady();
      expect(moved(fence, () => fence.noteUnscopedWrite())).toBe(true);
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(true);
      await fence.ensureReady();
      expect(query).toHaveBeenCalledTimes(2);
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(false);
    });

    it('does not trust a scan that a write naming no quads overtook while it was running', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const query = vi.fn(async () => {
        await gate;
        return { type: 'bindings' as const, bindings: [{ g: PROFILE_GRAPH }] };
      });
      const fence = new RecipientKeyRouteFence({ query } as unknown as TripleStore);
      const scanning = fence.ensureReady();
      fence.begin({ everything: true });
      release();
      await scanning;
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(true);
    });

    it('does not trust a scan that ran while an UPDATE was still in flight, and trusts one after it settled', async () => {
      const mutation = { everything: true };
      const { store, query } = scanStore([PROFILE_GRAPH]);
      const fence = new RecipientKeyRouteFence(store);
      await fence.ensureReady();
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(false);

      const settle = fence.begin(mutation);
      await fence.ensureReady();
      // The scan could not have seen what the write is about to add.
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(true);
      await fence.ensureReady();
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(true);

      fence.noteUnscopedWrite();
      settle();
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(true);
      await fence.ensureReady();
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(false);
      expect(query.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('trusts the scan again after a write that changed nothing has settled', async () => {
      const fence = await readyFence([PROFILE_GRAPH]);
      const settle = fence.begin({ everything: true });
      settle();
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(true);
      await fence.ensureReady();
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(false);
    });

    it('releases a write once however often it is settled, and not before every write has settled', async () => {
      const fence = await readyFence([PROFILE_GRAPH]);
      const first = fence.begin({ everything: true });
      const second = fence.begin({ everything: true });
      first();
      first();
      await fence.ensureReady();
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(true);
      second();
      await fence.ensureReady();
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(false);
    });

    it('learns the graph of an inserting write before it commits, so no removal of that graph is missed in between', async () => {
      const fence = await readyFence([PROFILE_GRAPH]);
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(false);
      const before = fence.revision;
      fence.begin({ quads: [quad(AGENT, DKG_ONTOLOGY.DKG_PEER_ID, DATA_GRAPH)] });
      expect(fence.revision).toBe(before);
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(true);
    });

    it('would miss that removal if the insert were only noted once it had settled (control)', async () => {
      const fence = await readyFence([PROFILE_GRAPH]);
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(false);
      expect(moved(fence, () => fence.noteQuads([quad(AGENT, DKG_ONTOLOGY.DKG_PEER_ID, DATA_GRAPH)]))).toBe(true);
    });

    it('does not learn a graph from a write that adds no key fact', async () => {
      const fence = await readyFence([PROFILE_GRAPH]);
      fence.begin({ quads: [quad('urn:x:y', 'http://schema.org/name', DATA_GRAPH), quad(AGENT, 'http://schema.org/name', DATA_GRAPH)] });
      expect(moved(fence, () => fence.noteRemoval({ graph: DATA_GRAPH }))).toBe(false);
    });
  });

  describe('against a real store', () => {
    const stores: OxigraphStore[] = [];
    afterEach(async () => {
      await Promise.all(stores.splice(0).map((store) => store.close()));
    });

    it('finds exactly the graphs that hold a key fact on an agent subject', async () => {
      const store = new OxigraphStore();
      stores.push(store);
      await store.insert([
        quad(AGENT, DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY, 'urn:dkg:graph:keys'),
        quad(KEY_IRI, DKG_ONTOLOGY.DKG_REVOKED_AT, 'urn:dkg:graph:revocations'),
        quad('urn:x:not-an-agent', DKG_ONTOLOGY.DKG_PEER_ID, 'urn:dkg:graph:foreign-subject'),
        quad(AGENT, 'http://schema.org/name', 'urn:dkg:graph:other-predicate'),
        quad('urn:x:y', 'http://schema.org/name', 'urn:dkg:graph:plain'),
      ]);
      const fence = new RecipientKeyRouteFence(store);
      await fence.ensureReady();
      const harmless = (graph: string) => !moved(fence, () => fence.noteRemoval({ graph }));
      expect(harmless('urn:dkg:graph:foreign-subject')).toBe(true);
      expect(harmless('urn:dkg:graph:other-predicate')).toBe(true);
      expect(harmless('urn:dkg:graph:plain')).toBe(true);
      expect(harmless('urn:dkg:graph:keys')).toBe(false);
      expect(harmless('urn:dkg:graph:revocations')).toBe(false);
    });
  });
});
