import { afterEach, expect, it, vi } from 'vitest';
import { META, createSwmExpiryFixture, stopTrackedSwmExpiryAgents, type SwmExpiryTestInternals } from './_helpers/swm-expiry-cleanup.js';

afterEach(async () => {
  await stopTrackedSwmExpiryAgents();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('rotates graph priority so a continuously busy graph cannot starve another CG', async () => {
  const f = await createSwmExpiryFixture(1);
  const otherMeta = 'did:dkg:context-graph:other-expiry/_shared_memory_meta';
  let otherPending = true;
  const selected: string[] = [];
  vi.mocked(f.store.listGraphsByPrefix!).mockImplementation(async prefix =>
    [META, otherMeta].filter(graph => graph.startsWith(prefix)));
  vi.mocked(f.store.query).mockImplementation(async (sparql, options) => {
    if (options?.source === 'agent.swmCleanup.revalidateOperation') return { type: 'bindings', bindings: [{ op: 'urn:busy' }] };
    if (options?.source !== 'agent.swmCleanup.expiredOperations') return { type: 'bindings', bindings: [] };
    const graph = sparql.includes(`<${otherMeta}>`) ? otherMeta : META;
    selected.push(graph);
    return { type: 'bindings', bindings: graph === META || otherPending ? [{ op: 'urn:busy' }] : [] };
  });
  vi.mocked(f.store.deleteByPattern).mockImplementation(async pattern => {
    if (pattern.graph === otherMeta) otherPending = false;
    return 1;
  });
  vi.useFakeTimers();
  (f.agent as unknown as SwmExpiryTestInternals).swmExpiryCleanupWorker.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(selected).toEqual([META, META, META, META]);
  expect(otherPending).toBe(true);
  selected.length = 0;
  await vi.advanceTimersByTimeAsync(10);
  expect(selected[0]).toBe(otherMeta);
  expect(otherPending).toBe(false);
  expect(f.warning).not.toHaveBeenCalled();
});

it('discovers a newly added graph while an older graph continuously fills its pass budget', async () => {
  const f = await createSwmExpiryFixture(1);
  const otherMeta = 'did:dkg:context-graph:late-expiry/_shared_memory_meta';
  let added = false;
  let pending = true;
  vi.mocked(f.store.listGraphsByPrefix!).mockImplementation(async prefix =>
    (added ? [META, otherMeta] : [META]).filter(graph => graph.startsWith(prefix)));
  vi.mocked(f.store.query).mockImplementation(async (sparql, options) => {
    if (options?.source === 'agent.swmCleanup.revalidateOperation') return { type: 'bindings', bindings: [{ op: 'urn:busy' }] };
    if (options?.source !== 'agent.swmCleanup.expiredOperations') return { type: 'bindings', bindings: [] };
    return { type: 'bindings', bindings: !sparql.includes(`<${otherMeta}>`) || pending ? [{ op: 'urn:busy' }] : [] };
  });
  vi.mocked(f.store.deleteByPattern).mockImplementation(async pattern => {
    if (pattern.graph === otherMeta) pending = false;
    return 1;
  });
  vi.useFakeTimers();
  (f.agent as unknown as SwmExpiryTestInternals).swmExpiryCleanupWorker.start();
  await vi.advanceTimersByTimeAsync(0);
  added = true;
  await vi.advanceTimersByTimeAsync(10);
  expect(pending).toBe(false);
});

