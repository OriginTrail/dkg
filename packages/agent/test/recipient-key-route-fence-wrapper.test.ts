// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from 'vitest';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { OxigraphStore, STORE_OPERATION_OUTCOME_TAG, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';

import { RECIPIENT_KEY_ROUTE_PREDICATES } from '../src/internal/recipient-key-route-fence.js';
import { commitInput } from './_helpers/rfc64-commit-input.js';
import {
  AGENT, CG_DID, CONTROL_GRAPH, JOIN_CACHE, KA_GRAPH, KA_UAL, KEY_IRI, MEMORY_LAYER, META_GRAPH, NAME,
  PROFILE_GRAPH, SWM_META_GRAPH, keyFact, quad, stack,
} from './_helpers/recipient-fence-stack.js';

describe('recipient key/route fence through the production store wrapper (GH#3067)', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });
  const open = async (options?: Parameters<typeof stack>[0]) => {
    const built = await stack(options);
    stores.push(built.store);
    return built;
  };

  type Wrapper = TripleStore;
  const noise: Array<[string, (store: Wrapper) => Promise<unknown>]> = [
    ['a promote-queue job replace', (s) => s.replaceSubject!(CONTROL_GRAPH, 'urn:dkg:promote-queue:job:j1', [
      quad('urn:dkg:promote-queue:job:j1', 'urn:dkg:promote-queue:state', CONTROL_GRAPH)])],
    ['a lift-queue job replace', (s) => s.replaceSubject!('urn:dkg:publisher:control-plane', 'urn:dkg:publisher:lift-job:l1', [
      quad('urn:dkg:publisher:lift-job:l1', 'urn:dkg:publisher:state', 'urn:dkg:publisher:control-plane')])],
    ['a share metadata delete', (s) => s.deleteByPatternWithoutCount!({ graph: SWM_META_GRAPH, subject: 'urn:dkg:share:s1' })],
    ['a knowledge-asset metadata delete in the graph\'s own _meta', (s) => s.deleteByPatternWithoutCount!({ graph: META_GRAPH, subject: KA_UAL })],
    ['an assertion layer delete in _meta', (s) => s.deleteByPatternWithoutCount!({
      graph: META_GRAPH, subject: KA_GRAPH, predicate: MEMORY_LAYER })],
    ['a delete counted by pattern with a harmless predicate', (s) => s.deleteByPattern({ graph: KA_GRAPH, predicate: NAME })],
    ['a drop of a knowledge-asset graph', (s) => s.dropGraph(KA_GRAPH)],
    ['a replace of a knowledge-asset graph', (s) => s.replaceGraph!(`${CG_DID}/_working_memory/a`, [quad('urn:x:doc', NAME, `${CG_DID}/_working_memory/a`)])],
    ['a replace of a graph and its metadata subject', (s) => s.replaceGraphAndSubject!(
      `${CG_DID}/_shared_memory/b`, [quad('urn:x:doc', NAME, `${CG_DID}/_shared_memory/b`)],
      META_GRAPH, KA_UAL, [quad(KA_UAL, NAME, META_GRAPH)])],
    ['an insert of content and metadata quads', (s) => s.insert([
      quad('urn:x:doc2', NAME, KA_GRAPH), quad(AGENT, NAME, KA_GRAPH), quad('urn:dkg:share:s2', DKG_ONTOLOGY.DKG_PEER_ID, SWM_META_GRAPH)])],
    ['a delete of content quads', (s) => s.delete([quad('urn:x:doc', NAME, KA_GRAPH)])],
    ['a read', (s) => s.query('SELECT * WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 5')],
  ];

  it.each(noise)('does not move for %s, which still moves the node-wide revision where it did before', async (label, run) => {
    const { wrapper, fence, projection } = await open();
    const before = fence.revision;
    const nodeWideBefore = projection.readAuthorityFactsRevision;
    await run(wrapper);
    expect(fence.revision, label).toBe(before);
    if (/promote-queue|lift-queue/.test(label)) expect(projection.readAuthorityFactsRevision).toBeGreaterThan(nodeWideBefore);
  });

  const signal: Array<[string, (store: Wrapper) => Promise<unknown>]> = [
    ['an insert of a key fact', (s) => s.insert([keyFact(KA_GRAPH, DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY)])],
    ...[...RECIPIENT_KEY_ROUTE_PREDICATES].map((predicate): [string, (store: Wrapper) => Promise<unknown>] => [
      `an insert of ${predicate.split('/').pop()}`, (s) => s.insert([quad(KEY_IRI, predicate, PROFILE_GRAPH)])]),
    ['a revocation insert', (s) => s.insert([quad(KEY_IRI, DKG_ONTOLOGY.DKG_REVOKED_AT, KA_GRAPH)])],
    ['a delete of a key fact', (s) => s.delete([keyFact(PROFILE_GRAPH, DKG_ONTOLOGY.DKG_PEER_ID)])],
    // An HTTP store turns a blank-node subject in a delete into a variable that can match an agent.
    ...[...RECIPIENT_KEY_ROUTE_PREDICATES].map((predicate): [string, (store: Wrapper) => Promise<unknown>] => [
      `a delete of ${predicate.split('/').pop()} on a blank node`,
      (s) => s.delete([{ subject: '_:x', predicate, object: '"peer-B"', graph: PROFILE_GRAPH }])]),
    ['a route removal by agent subject', (s) => s.deleteByPattern({ graph: PROFILE_GRAPH, subject: AGENT, predicate: DKG_ONTOLOGY.DKG_PEER_ID })],
    ['a route removal by agent subject, counted or not', (s) => s.deleteByPatternWithoutCount!({ graph: PROFILE_GRAPH, subject: AGENT })],
    ['a route removal by predicate in a key graph', (s) => s.deleteByPattern({ graph: PROFILE_GRAPH, predicate: DKG_ONTOLOGY.DKG_PEER_ID })],
    ['a delete by predicate in any graph', (s) => s.deleteByPattern({ predicate: DKG_ONTOLOGY.DKG_REVOKED_AT })],
    ['a delete with nothing named', (s) => s.deleteByPattern({})],
    ['a drop of a key graph', (s) => s.dropGraph(PROFILE_GRAPH)],
    ['a join-cache refresh', (s) => s.replaceSubject!(JOIN_CACHE, AGENT, [
      quad(AGENT, DKG_ONTOLOGY.DKG_PEER_ID, JOIN_CACHE), quad(AGENT, DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY, JOIN_CACHE)])],
    ['a replace of a harmless subject whose payload carries a key fact', (s) => s.replaceSubject!(
      CONTROL_GRAPH, KEY_IRI, [quad(KEY_IRI, DKG_ONTOLOGY.DKG_REVOKED_AT, CONTROL_GRAPH)])],
    ['a replace of a graph with key facts in its payload', (s) => s.replaceGraph!(KA_GRAPH, [keyFact(KA_GRAPH)])],
    ['a replace of a key graph', (s) => s.replaceGraph!(PROFILE_GRAPH, [quad('urn:x:y', NAME, PROFILE_GRAPH)])],
    ['a graph replace whose metadata payload carries a key fact', (s) => s.replaceGraphAndSubject!(
      KA_GRAPH, [], META_GRAPH, AGENT, [quad(AGENT, DKG_ONTOLOGY.DKG_PEER_ID, META_GRAPH)])],
    ['a prefix delete', (s) => s.deleteBySubjectPrefix(KA_GRAPH, 'urn:x:')],
    ['a SPARQL update', (s) => s.update!(`INSERT DATA { GRAPH <${KA_GRAPH}> { <urn:x:a> <${NAME}> "v" } }`)],
  ];

  it.each(signal)('moves for %s', async (label, run) => {
    const { wrapper, fence } = await open();
    const before = fence.revision;
    await run(wrapper);
    expect(fence.revision, label).toBeGreaterThan(before);
  });

  it('moves for a SPARQL update that a backend accepts through query()', async () => {
    const { wrapper, fence } = await open({
      inner: (store) => new Proxy(store, {
        get: (target, property) => property === 'query'
          ? async (sparql: string) => (/^s*(DELETE|INSERT)/i.test(sparql) ? { type: 'bindings' as const, bindings: [] } : target.query(sparql))
          : (typeof Reflect.get(target, property) === 'function'
            ? (Reflect.get(target, property) as (...args: unknown[]) => unknown).bind(target)
            : Reflect.get(target, property)),
      }),
    });
    const before = fence.revision;
    await wrapper.query('SELECT * WHERE { ?s ?p ?o } LIMIT 1');
    expect(fence.revision).toBe(before);
    await wrapper.query(`DELETE WHERE { GRAPH <${KA_GRAPH}> { ?s ?p ?o } }`);
    expect(fence.revision).toBeGreaterThan(before);
  });

  it('learns a graph from the payload of a replace and then moves for a later drop of that graph', async () => {
    const { wrapper, fence } = await open();
    await wrapper.replaceGraph!(`${CG_DID}/fresh`, [keyFact(`${CG_DID}/fresh`)]);
    const before = fence.revision;
    await wrapper.dropGraph(`${CG_DID}/fresh`);
    expect(fence.revision).toBeGreaterThan(before);
  });

  it('is no longer trusted after an UPDATE until the graphs are scanned again, and never reports a harmless drop meanwhile', async () => {
    const { wrapper, fence } = await open();
    await wrapper.update!(`INSERT DATA { GRAPH <urn:dkg:graph:late> { <${AGENT}> <${DKG_ONTOLOGY.DKG_PEER_ID}> "p" } }`);
    const afterUpdate = fence.revision;
    await wrapper.dropGraph('urn:dkg:graph:late');
    expect(fence.revision).toBeGreaterThan(afterUpdate);
    await fence.ensureReady();
    const settled = fence.revision;
    await wrapper.dropGraph(`${CG_DID}/never-held-keys`);
    expect(fence.revision).toBe(settled);
  });

  it('is never trusted again after an UPDATE whose outcome is unknown, because the backend may still apply it', async () => {
    const { wrapper, store, fence } = await open({
      inner: (inner) => new Proxy(inner, {
        get: (target, property) => property === 'query'
          ? async (sparql: string) => {
            if (/^\s*INSERT/i.test(sparql)) throw new Error('request timed out');
            return target.query(sparql);
          }
          : (typeof Reflect.get(target, property) === 'function'
            ? (Reflect.get(target, property) as (...args: unknown[]) => unknown).bind(target)
            : Reflect.get(target, property)),
      }),
    });
    await expect(wrapper.query(`INSERT DATA { GRAPH <urn:dkg:graph:late> { <${AGENT}> <${DKG_ONTOLOGY.DKG_PEER_ID}> "p" } }`))
      .rejects.toThrow('timed out');
    // A scan that finishes before the remote write lands does not see its graph...
    await fence.ensureReady();
    // ...which then commits, and a resolution reads its keys.
    await store.insert([keyFact('urn:dkg:graph:late')]);

    const before = fence.revision;
    await wrapper.dropGraph('urn:dkg:graph:late');
    expect(fence.revision).toBeGreaterThan(before);
  });

  it('trusts the graphs again after an UPDATE that was refused before dispatch, which cannot have committed', async () => {
    const refused = Object.assign(new Error('rejected'), {
      storeOperationOutcomeTag: STORE_OPERATION_OUTCOME_TAG,
      storeOperation: 'query',
      outcome: 'not_started',
    });
    const { wrapper, fence } = await open({
      inner: (inner) => new Proxy(inner, {
        get: (target, property) => property === 'query'
          ? async (sparql: string) => {
            if (/^\s*INSERT/i.test(sparql)) throw refused;
            return target.query(sparql);
          }
          : (typeof Reflect.get(target, property) === 'function'
            ? (Reflect.get(target, property) as (...args: unknown[]) => unknown).bind(target)
            : Reflect.get(target, property)),
      }),
    });
    await expect(wrapper.query(`INSERT DATA { GRAPH <urn:dkg:graph:late> { <${AGENT}> <${DKG_ONTOLOGY.DKG_PEER_ID}> "p" } }`))
      .rejects.toThrow('rejected');
    await fence.ensureReady();

    const before = fence.revision;
    await wrapper.dropGraph(`${CG_DID}/never-held-keys`);
    expect(fence.revision).toBe(before);
  });

  it('does not take a key fact stored under an unsafe graph name for one stored under that name', async () => {
    // An HTTP adapter renders an unsafe graph name as a cleaned one.
    const { wrapper, fence } = await open({
      inner: (inner) => new Proxy(inner, {
        get: (target, property) => property === 'insert'
          ? (quads: Quad[], options?: unknown) => target.insert(quads.map((q) => ({ ...q, graph: q.graph.replace(/[{}]/g, '') })), options as never)
          : (typeof Reflect.get(target, property) === 'function'
            ? (Reflect.get(target, property) as (...args: unknown[]) => unknown).bind(target)
            : Reflect.get(target, property)),
      }),
    });
    await wrapper.insert([{ ...keyFact('urn:dkg:graph:keys'), graph: 'urn:dkg:graph:keys{}' }]);
    await fence.ensureReady();

    const before = fence.revision;
    await wrapper.dropGraph('urn:dkg:graph:keys');
    expect(fence.revision).toBeGreaterThan(before);
  });

  describe('an RFC-64 author commit', () => {
    const committing = (result: () => 'committed' | 'conflict') => open({
      inner: (store) => new Proxy(store, {
        get: (target, property) => property === 'rfc64AuthorCommitCasV1'
          ? async () => result()
          : (typeof Reflect.get(target, property) === 'function'
            ? (Reflect.get(target, property) as (...args: unknown[]) => unknown).bind(target)
            : Reflect.get(target, property)),
      }),
    });

    it('moves when it replaces a graph that holds key facts', async () => {
      const { wrapper, fence } = await committing(() => 'committed');
      const before = fence.revision;
      await wrapper.rfc64AuthorCommitCasV1!(commitInput({ sharedProjectionGraph: PROFILE_GRAPH }));
      expect(fence.revision).toBeGreaterThan(before);
    });

    it('moves for a key fact in its payload, and later removals of that graph move too', async () => {
      const { wrapper, fence } = await committing(() => 'committed');
      const graph = `${CG_DID}/_shared_memory`;
      const before = fence.revision;
      await wrapper.rfc64AuthorCommitCasV1!(commitInput({ sharedProjectionGraph: graph, sharedProjectionQuads: [keyFact(graph)] }));
      expect(fence.revision).toBeGreaterThan(before);
      const afterCommit = fence.revision;
      await wrapper.dropGraph(graph);
      expect(fence.revision).toBeGreaterThan(afterCommit);
    });

    it('does not move for ordinary projection and control state', async () => {
      const { wrapper, fence } = await committing(() => 'committed');
      const before = fence.revision;
      await wrapper.rfc64AuthorCommitCasV1!(commitInput({ sharedProjectionGraph: `${CG_DID}/_shared_memory` }));
      expect(fence.revision).toBe(before);
    });

    it('does not move for a commit that was refused', async () => {
      const { wrapper, fence } = await committing(() => 'conflict');
      const before = fence.revision;
      await wrapper.rfc64AuthorCommitCasV1!(commitInput({ sharedProjectionGraph: PROFILE_GRAPH }));
      expect(fence.revision).toBe(before);
    });

    it('may change anything when the canonical plan cannot describe it', async () => {
      const { wrapper, fence } = await committing(() => 'committed');
      const before = fence.revision;
      await wrapper.rfc64AuthorCommitCasV1!({} as never);
      expect(fence.revision).toBeGreaterThan(before);
    });
  });

  describe('a removal that overtakes the notification of an insert into the same graph', () => {
    const racing = (store: OxigraphStore): TripleStore => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      (store as unknown as { release: () => void }).release = release;
      return new Proxy(store, {
        get: (target, property) => {
          if (property === 'replaceGraph') {
            return async (graph: string, quads: Quad[]) => { await gate; return target.replaceGraph(graph, quads); };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    };

    it('is caught because the graph is learned when the insert is dispatched', async () => {
      const { wrapper, fence, store } = await open({ inner: racing });
      const insert = wrapper.replaceGraph!(`${CG_DID}/racing`, [keyFact(`${CG_DID}/racing`)]);
      const before = fence.revision;
      await wrapper.dropGraph(`${CG_DID}/racing`);
      expect(fence.revision).toBeGreaterThan(before);
      (store as unknown as { release: () => void }).release();
      await insert;
    });
  });

  describe('a scan that runs while an UPDATE is still pending', () => {
    it('cannot make a later removal of the graph that UPDATE fills harmless', async () => {
      let commit!: () => void;
      let respond!: () => void;
      const committing = new Promise<void>((resolve) => { commit = resolve; });
      const responding = new Promise<void>((resolve) => { respond = resolve; });
      const { wrapper, fence } = await open({
        inner: (store) => new Proxy(store, {
          get: (target, property) => {
            if (property === 'update') {
              return async (sparql: string) => {
                await committing;
                await target.update!(sparql);
                await responding;
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        }),
      });
      const filled = `${CG_DID}/filled`;
      const update = wrapper.update!(
        `INSERT DATA { GRAPH <${filled}> { <${AGENT}> <${DKG_ONTOLOGY.DKG_PEER_ID}> "p" } }`,
      );
      // The scan runs before the UPDATE has committed, so it cannot list the graph.
      await fence.ensureReady();
      commit();
      await new Promise((resolve) => setImmediate(resolve));
      // The UPDATE has committed but its response is still on its way: the
      // removal completes first and must not be taken for harmless.
      const before = fence.revision;
      await wrapper.dropGraph(filled);
      expect(fence.revision).toBeGreaterThan(before);
      respond();
      await update;
    });

  });
});
