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
  createTripleStore,
  tryReplaceSubjectAtomically,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { contextGraphCatalogUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';
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
    const projectionDirtyCalls: Array<{ quads?: readonly unknown[]; targetGraph?: string }> = [];
    // ...then the agent wrapper on top — this is the publisher's `this.store`.
    const agentStore: TripleStore = createListContextGraphsCacheInvalidatingStore(
      inner,
      () => { invalidations += 1; },
      (quads, targetGraph) => { projectionDirtyCalls.push({ quads, targetGraph }); },
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
      //   is dirtied BY THE TARGET GRAPH (not the inserted quads) so a subject
      //   replace that deletes projection-relevant metadata is still covered (#1863).
      expect(invalidations).toBeGreaterThan(invalidationsBefore);
      expect(projectionDirtyCalls.some((c) => c.targetGraph === GRAPH && c.quads === undefined)).toBe(true);
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

  it('markDirtyForGraph dirties the CG derived from its meta graph and no-ops for a non-CG graph (#1863)', () => {
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

    // A non-CG graph (e.g. the publisher control-plane graph) is a no-op — no
    // entry created, no whole-cache churn on the hot job-write path.
    proj.markDirtyForGraph('urn:dkg:publisher:control-plane');
    expect(entries.has('urn:dkg:publisher:control-plane')).toBe(false);
  });

  it('invalidates structured mutation effects after success without decoding them in Agent', async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => { release = resolve; });
    const inner = {
      structuredMutation: vi.fn(async () => inFlight),
    } as unknown as TripleStore;
    const invalidate = vi.fn();
    const markProjectionDirty = vi.fn();
    const store = createListContextGraphsCacheInvalidatingStore(
      inner,
      invalidate,
      markProjectionDirty,
    );
    const mutation = {
      kind: 'copy-subject-projection' as const,
      input: {
        sourceGraphUris: ['urn:test:source'],
        targetGraphUri: 'urn:test:target',
        roots: ['urn:test:root'],
        descendantSuffix: '/',
        excludedPredicates: [],
      },
    };

    const pending = store.structuredMutation!(mutation);
    mutation.input.targetGraphUri = 'urn:test:redirected';
    expect(invalidate).not.toHaveBeenCalled();
    release();
    await pending;

    expect(invalidate).toHaveBeenCalledOnce();
    expect(markProjectionDirty).toHaveBeenCalledOnce();
    expect(markProjectionDirty).toHaveBeenCalledWith(undefined, 'urn:test:target');
  });

  it('does not invalidate structured mutation failures or structural no-ops', async () => {
    const invalidate = vi.fn();
    const markProjectionDirty = vi.fn();
    const inner = {
      structuredMutation: vi.fn(async () => undefined),
    } as unknown as TripleStore;
    const store = createListContextGraphsCacheInvalidatingStore(
      inner,
      invalidate,
      markProjectionDirty,
    );

    await store.structuredMutation!({
      kind: 'delete-subjects',
      input: { graphUri: 'urn:test:target', subjects: [] },
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(markProjectionDirty).not.toHaveBeenCalled();

    inner.structuredMutation = vi.fn(async () => { throw new Error('commit failed'); });
    await expect(store.structuredMutation!({
      kind: 'delete-subjects',
      input: { graphUri: 'urn:test:target', subjects: ['urn:test:subject'] },
    })).rejects.toThrow('commit failed');
    expect(invalidate).not.toHaveBeenCalled();
    expect(markProjectionDirty).not.toHaveBeenCalled();
  });
});
