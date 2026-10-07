/**
 * #1863 — replaceSubject must propagate through the AGENT store wrapper.
 *
 * Regression for the review finding: the async-lift publisher's `this.store` in
 * production is NOT the bare createTripleStore stack — `DKGAgent.create` wraps
 * it in `createListContextGraphsCacheInvalidatingStore`. If that wrapper fails
 * to forward the optional `replaceSubject` (it forwards replaceGraph /
 * replaceGraphAndSubject / update but originally dropped replaceSubject), then
 * `persistJobRecord`'s `tryReplaceSubjectAtomically(this.store)` returns false
 * in every normal daemon config → the publisher silently delete-then-inserts →
 * the atomic single-subject-replace path is NEVER taken in prod and the #1863
 * transient-empty-subject race is NOT eliminated. The storage-only composed test
 * cannot see this wrapper layer.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHANGELOG_GRAPH,
  OxigraphStore,
  StoreOperationTimeoutError,
  createTripleStore,
  tryReplaceSubjectAtomically,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { contextGraphCatalogUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';
import { createProjectionMutationObserver } from '../src/internal/projection-mutation-observer.js';
import { recordingObserver } from './_helpers/store-mutation-recorder.js';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';

const GRAPH = 'urn:dkg:publisher:control-plane';
const JOB = 'urn:dkg:publisher:lift-job:job-1';
const REQ = 'urn:dkg:publisher:lift-request:job-1';

function quad(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: GRAPH };
}

/** Stable snapshot of the reserved changelog plane, to prove a mutation recorded a marker. */
async function changelogSnapshot(store: TripleStore): Promise<string> {
  const result = await store.query(
    `SELECT ?s ?p ?o WHERE { GRAPH <${CHANGELOG_GRAPH}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`,
  );
  if (result.type !== 'bindings') return '';
  return result.bindings.map((b) => `${b['s']} ${b['p']} ${b['o']}`).join('\n');
}

describe('#1863 replaceSubject through the agent store wrapper', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('the publisher production store chain (agent wrapper over the createTripleStore stack) takes the atomic path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'replace-subject-agent-'));
    tempDirs.push(dir);
    // The full storage decorator stack (ChangelogStore -> GraphSetIndexStore ->
    // SharedMemoryLiteralBlobStore -> Oxigraph), exactly as the daemon builds it.
    const inner = await createTripleStore({
      backend: 'oxigraph',
      changelog: true,
      largeLiteralStorage: { enabled: true, directory: dir },
    });
    let invalidations = 0;
    const { observer, committed } = recordingObserver();
    // ...then the agent wrapper on top — this is the publisher's `this.store`.
    const agentStore: TripleStore = createListContextGraphsCacheInvalidatingStore(
      inner,
      () => { invalidations += 1; },
      observer,
    );

    try {
      // The direct regression: the wrapper forwards the optional capability.
      expect(typeof agentStore.replaceSubject).toBe('function');

      // Seed the job subject + a co-located request subject (separate subject).
      await agentStore.insert([
        quad(JOB, 'urn:dkg:publisher:status', '"accepted"'),
        quad(JOB, 'urn:dkg:publisher:retry', '"0"'),
        quad(REQ, 'urn:dkg:publisher:kind', '"request"'),
      ]);
      const invalidationsBefore = invalidations;
      const changelogBefore = await changelogSnapshot(agentStore);

      // Exactly what persistJobRecord runs with this.store = agentStore. STRICT
      // single-subject payload (JOB only). If the wrapper dropped replaceSubject
      // this returns false → the publisher silently falls back (the prod no-op).
      const replaced = await tryReplaceSubjectAtomically(agentStore, GRAPH, JOB, [
        quad(JOB, 'urn:dkg:publisher:status', '"validated"'),
      ]);
      expect(replaced).toBe(true);

      // Atomic: JOB's stale retry row is gone, status is new, and the co-located
      // REQ subject is untouched (never in the replace scope; not duplicated).
      const jobRows = await agentStore.query(
        `SELECT ?p ?o WHERE { GRAPH <${GRAPH}> { <${JOB}> ?p ?o } } ORDER BY ?p`,
      );
      expect(jobRows.type === 'bindings' ? jobRows.bindings : []).toEqual([
        { p: 'urn:dkg:publisher:status', o: '"validated"' },
      ]);
      expect(await agentStore.countQuads(GRAPH)).toBe(2);

      // Each decorator's side effect fires through the full production stack:
      // - agent wrapper: listGraphs-cache invalidation fires, and the projection
      //   receives the target graph/subject (for deletions) and replacement
      //   quads (for inserted authority facts), so both halves are covered.
      expect(invalidations).toBeGreaterThan(invalidationsBefore);
      expect(committed.some((mutation) => (
        mutation.removals?.[0]?.graph === GRAPH
        && mutation.removals[0].subject === JOB
        && mutation.quads?.length === 1
      ))).toBe(true);
      // - ChangelogStore: the mutation was recorded (changelog plane changed).
      expect(await changelogSnapshot(agentStore)).not.toBe(changelogBefore);
      // - GraphSetIndexStore: enumeration includes the non-empty control-plane graph.
      expect(await agentStore.listGraphs()).toContain(GRAPH);

      // GraphSetIndexStore enumeration also DROPS a graph when replaceSubject
      // empties it (remove-last-row → disappears without a rebuild scan).
      const removable = 'urn:dkg:publisher:control-plane-removable';
      await agentStore.insert([
        { subject: 'urn:s:only', predicate: 'urn:p:v', object: '"v"', graph: removable },
      ]);
      expect(await agentStore.listGraphs()).toContain(removable);
      expect(await tryReplaceSubjectAtomically(agentStore, removable, 'urn:s:only', [])).toBe(true);
      expect(await agentStore.listGraphs()).not.toContain(removable);
    } finally {
      await agentStore.close();
    }
  });

  it('markDirtyForGraph dirties CG graphs and fences opaque non-CG replacements (#1863)', () => {
    const proj = new ContextGraphMetaProjection(new OxigraphStore());
    const entries = (proj as unknown as { entries: Map<string, { invalidationVersion: number }> }).entries;

    // Seed a cached entry for CG 'music', then dirty it via its META graph — the
    // path a replaceSubject on that CG's meta graph takes (covers deletes the
    // inserted quads wouldn't reveal).
    proj.markDirty('music');
    const beforeMeta = entries.get('music')!.invalidationVersion;
    proj.markDirtyForGraph(contextGraphMetaGraphUri('music'));
    expect(entries.get('music')!.invalidationVersion).toBeGreaterThan(beforeMeta);

    // ...and via its _catalog graph — the other CG-graph branch replaceSubject can
    // target (a replace on the public catalog subgraph must dirty the CG too).
    const beforeCatalog = entries.get('music')!.invalidationVersion;
    proj.markDirtyForGraph(contextGraphCatalogUri('music'));
    expect(entries.get('music')!.invalidationVersion).toBeGreaterThan(beforeCatalog);

    // A non-CG graph does not dirty projection entries, but it still advances
    // the conservative recipient-authority fence because key resolution scans
    // every named graph.
    const beforeControlPlane = proj.readAuthorityFactsRevision;
    proj.markDirtyForGraph('urn:dkg:publisher:control-plane');
    expect(entries.has('urn:dkg:publisher:control-plane')).toBe(false);
    expect(proj.readAuthorityFactsRevision).toBe(beforeControlPlane + 1);
  });

  it('invalidates an indeterminate atomic replacement but not a proven pre-dispatch refusal', async () => {
    const inner = new OxigraphStore();
    const replaceSubject = vi.fn()
      .mockRejectedValueOnce(new Error('response lost after commit'))
      .mockRejectedValueOnce(new StoreOperationTimeoutError({
        backend: 'test-store',
        operation: 'replaceSubject',
        outcome: 'not_started',
      }));
    Object.defineProperty(inner, 'replaceSubject', { value: replaceSubject });
    const invalidate = vi.fn();
    const { observer, committed, unchanged } = recordingObserver();
    const wrapped = createListContextGraphsCacheInvalidatingStore(
      inner,
      invalidate,
      observer,
    );

    await expect(wrapped.replaceSubject!(GRAPH, JOB, [
      quad(JOB, 'urn:dkg:publisher:status', '"committed"'),
    ])).rejects.toThrow('response lost after commit');
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(committed).toHaveLength(1);

    await expect(wrapped.replaceSubject!(GRAPH, JOB, [])).rejects.toBeInstanceOf(
      StoreOperationTimeoutError,
    );
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(committed).toHaveLength(1);
    expect(unchanged).toHaveLength(1);
  });

  it('fences both known replacement graphs even when their payloads are empty', async () => {
    const inner = new OxigraphStore();
    Object.defineProperty(inner, 'replaceGraphAndSubject', {
      value: vi.fn(async () => undefined),
    });
    const projection = new ContextGraphMetaProjection(inner);
    const wrapped = createListContextGraphsCacheInvalidatingStore(
      inner,
      () => undefined,
      createProjectionMutationObserver(() => projection),
    );
    const before = projection.readAuthorityFactsRevision;
    const unrelatedBefore = projection.readContextGraphAuthorityFactsRevision('unrelated-private-cg');

    await wrapped.replaceGraphAndSubject!(
      'urn:dkg:recipient-cache',
      [],
      'urn:dkg:recipient-cache-meta',
      'did:dkg:agent:0x0000000000000000000000000000000000000001',
      [],
    );

    expect(projection.readAuthorityFactsRevision).toBe(before + 2);
    expect(projection.readContextGraphAuthorityFactsRevision('unrelated-private-cg'))
      .toBe(unrelatedBefore);
  });

  it('keeps unrelated private proof revisions stable across graph-scoped mutations', async () => {
    const inner = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(inner);
    const wrapped = createListContextGraphsCacheInvalidatingStore(
      inner,
      () => undefined,
      createProjectionMutationObserver(() => projection),
    );
    const contextGraphId = 'unrelated-private-cg';
    const before = projection.readContextGraphAuthorityFactsRevision(contextGraphId);
    const row = quad(JOB, 'urn:dkg:publisher:status', '"ready"');

    await wrapped.insert([row]);
    await wrapped.deleteByPattern({ graph: GRAPH });
    await wrapped.replaceGraph!(GRAPH, [row]);
    await wrapped.dropGraph(GRAPH);
    expect(projection.readContextGraphAuthorityFactsRevision(contextGraphId)).toBe(before);

    await wrapped.replaceGraph!(contextGraphMetaGraphUri(contextGraphId), []);
    expect(projection.readContextGraphAuthorityFactsRevision(contextGraphId)).not.toBe(before);
    await wrapped.close();
  });
});
