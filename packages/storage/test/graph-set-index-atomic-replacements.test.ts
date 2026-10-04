// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GraphSetIndexStore, OxigraphStore, UnsupportedTripleStoreCapabilityError,
  type GraphSetMutationEvent, type Quad, type TripleStore,
} from '../src/index.js';

const GRAPH = 'urn:test:target', META = 'urn:test:metadata', OTHER = 'urn:test:other';
const SUBJECT = 'urn:test:subject', PREDICATE = 'urn:test:value';
const operations = ['replaceGraph', 'replaceGraphAndSubject', 'replaceSubject', 'replaceSubjectPredicates'] as const;
type Operation = typeof operations[number];
const cleanup: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of cleanup.splice(0)) await store.close(); });
function quad(graph: string): Quad { return { graph, subject: SUBJECT, predicate: PREDICATE, object: '"value"' }; }
function mutate(store: TripleStore, operation: Operation, present: boolean): Promise<void> {
  const quads = present ? [quad(GRAPH)] : [];
  switch (operation) {
    case 'replaceGraph': return store.replaceGraph!(GRAPH, quads);
    case 'replaceGraphAndSubject': return store.replaceGraphAndSubject!(GRAPH, quads, META, SUBJECT, present ? [quad(META)] : []);
    case 'replaceSubject': return store.replaceSubject!(GRAPH, SUBJECT, quads);
    case 'replaceSubjectPredicates': return store.replaceSubjectPredicates!(GRAPH, SUBJECT, [PREDICATE], quads);
  }
}
async function fixture(enabled = true) {
  const raw = new OxigraphStore(); cleanup.push(raw); await raw.insert([quad(OTHER)]);
  const scans = vi.spyOn(raw, 'listGraphs'), mutations: GraphSetMutationEvent[] = [];
  const indexed = new GraphSetIndexStore(raw, { enabled, revalidateMs: 60_000, onMutation: event => mutations.push(event) });
  return { raw, scans, mutations, indexed };
}
function expectedGraphs(operation: Operation) { return [OTHER, GRAPH, ...(operation === 'replaceGraphAndSubject' ? [META] : [])].sort(); }

describe('graph-index tracking of every atomic replacement', () => {
  it.each(operations)('keeps warm membership untouched after a clean %s refusal', async operation => {
    const f = await fixture(); expect(await f.indexed.listGraphs()).toEqual([OTHER]); f.mutations.length = 0;
    const failure = new UnsupportedTripleStoreCapabilityError(operation, 'fixture');
    vi.spyOn(f.raw, operation).mockRejectedValue(failure);
    await expect(mutate(f.indexed, operation, true)).rejects.toBe(failure);
    expect(await f.indexed.listGraphs()).toEqual([OTHER]); expect(f.scans).toHaveBeenCalledTimes(1);
    expect(f.mutations).toEqual([]);
  });

  it.each(operations.flatMap(operation => ['before', 'after'].map(fault => ({ operation, fault }))))(
    'rebuilds after ambiguous $fault-commit $operation failure', async ({ operation, fault }) => {
      const f = await fixture(); expect(await f.indexed.listGraphs()).toEqual([OTHER]);
      const engine = (f.raw as unknown as { store: { update(update: string): void } }).store;
      const update = engine.update.bind(engine), failure = new Error('indeterminate replacement'); let armed = true;
      vi.spyOn(engine, 'update').mockImplementation(statement => {
        if (!armed) return update(statement); armed = false;
        if (fault === 'after') update(statement);
        throw failure;
      });
      await expect(mutate(f.indexed, operation, true)).rejects.toBe(failure);
      expect(armed).toBe(false);
      expect(await f.indexed.listGraphs()).toEqual(fault === 'after' ? expectedGraphs(operation) : [OTHER]);
      expect(f.scans).toHaveBeenCalledTimes(2);
    });

  it.each(operations)('maintains first/last-row membership after successful %s without full scans', async operation => {
    const f = await fixture(); expect(await f.indexed.listGraphs()).toEqual([OTHER]);
    await mutate(f.indexed, operation, true); expect(await f.indexed.listGraphs()).toEqual(expectedGraphs(operation));
    await mutate(f.indexed, operation, false); expect(await f.indexed.listGraphs()).toEqual([OTHER]);
    expect(f.scans).toHaveBeenCalledTimes(1);
    for (const graph of expectedGraphs(operation).filter(graph => graph !== OTHER)) {
      expect(f.mutations).toContainEqual({ type: 'graph-added', graph, source: operation });
      expect(f.mutations).toContainEqual({ type: 'graph-removed', graph, source: operation });
    }
  });

  it.each(operations)('forwards %s through a disabled index without bookkeeping reads', async operation => {
    const f = await fixture(false);
    await mutate(f.indexed, operation, true); expect(f.scans).not.toHaveBeenCalled();
    expect((await f.indexed.listGraphs()).sort()).toEqual(expectedGraphs(operation));
    await mutate(f.indexed, operation, false); expect(await f.indexed.listGraphs()).toEqual([OTHER]);
    expect(f.mutations).toEqual([]);
  });
});
