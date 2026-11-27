import { expect, it } from 'vitest';
import { StoreContentFence, STORE_CONTENT_EFFECT_MAX_GRAPHS as GRAPH_LIMIT,
  STORE_CONTENT_EFFECT_MAX_SUBJECTS_PER_GRAPH as SUBJECT_LIMIT } from '../src/internal/store-content-fence.js';

const quad = (graph: string, subject: string) => ({ graph, subject, predicate: 'urn:p', object: '"value"' });
const scope = (graph: string, subject = 'urn:never-written') => ({ graphs: [], metadataGraph: graph, subjects: [subject] });
function expectOpen(fence: StoreContentFence, graph: string, subject?: string) {
  const proof = fence.openScope(scope(graph, subject));
  expect(proof).toBeDefined(); proof!.assertCurrent(); proof!.close();
}

it.each(['one batch', 'many writes'])('collapses subject uncertainty conservatively for %s', mode => {
  const fence = new StoreContentFence();
  const quads = Array.from({ length: SUBJECT_LIMIT + 1 }, (_, i) => quad('urn:meta', `urn:s:${i}`));
  if (mode === 'one batch') fence.begin({ quads })('indeterminate');
  else for (const q of quads) fence.begin({ quads: [q] })('indeterminate');
  for (const subject of ['urn:s:0', `urn:s:${SUBJECT_LIMIT}`, 'urn:never-written']) {
    expect(fence.openScope(scope('urn:meta', subject))).toBeUndefined();
  }
  expectOpen(fence, 'urn:unrelated');
  fence.begin({ quads: [quad('urn:meta', 'urn:new')] })('changed');
  expect(fence.openScope(scope('urn:meta'))).toBeUndefined();
});

it.each(['one batch', 'many writes'])('collapses graph uncertainty globally for %s', mode => {
  const fence = new StoreContentFence();
  const quads = Array.from({ length: GRAPH_LIMIT + 1 }, (_, i) => quad(`urn:g:${i}`, 'urn:s'));
  if (mode === 'one batch') fence.begin({ quads })('indeterminate');
  else for (const q of quads) fence.begin({ quads: [q] })('indeterminate');
  for (const graph of ['urn:g:0', `urn:g:${GRAPH_LIMIT}`, 'urn:unrelated']) {
    expect(fence.openScope(scope(graph))).toBeUndefined();
  }
  fence.begin({ quads: [quad('urn:new', 'urn:new')] })('unchanged');
  expect(fence.openScope(scope('urn:unrelated'))).toBeUndefined();
});

it('retires collapsed supervised uncertainty only after a ready replacement', () => {
  let state = { generation: 7, ready: true };
  const fence = new StoreContentFence(() => state);
  const quads = Array.from({ length: GRAPH_LIMIT + 1 }, (_, i) => quad(`urn:g:${i}`, 'urn:s'));
  fence.begin({ quads })('indeterminate');
  expect(fence.openScope(scope('urn:unrelated'))).toBeUndefined();
  state = { generation: 8, ready: false };
  expect(fence.openScope(scope('urn:unrelated'))).toBeUndefined();
  state = { generation: 8, ready: true };
  expectOpen(fence, 'urn:unrelated'); expectOpen(fence, 'urn:g:0', 'urn:s');
});

it('coalesces delayed execution epochs without losing their effects or retiring unbound writes', () => {
  let state: { generation: number; ready: boolean } | undefined;
  const fence = new StoreContentFence(() => state);
  fence.begin({ quads: [quad('urn:unbound', 'urn:s')] })('indeterminate');
  for (let generation = 0; generation < 1000; generation++) {
    fence.begin({ quads: [quad('urn:meta', `urn:s:${generation}`)] })('indeterminate', { generation });
  }
  state = { generation: 999, ready: true };
  expect(fence.openScope(scope('urn:meta', 'urn:s:0'))).toBeUndefined();
  expect(fence.openScope(scope('urn:meta', 'urn:s:999'))).toBeUndefined();
  state = { generation: 1000, ready: true };
  expectOpen(fence, 'urn:meta', 'urn:s:0');
  expect(fence.openScope(scope('urn:unbound', 'urn:s'))).toBeUndefined();
});

it('does not reintroduce uncertainty for a delayed failure from a terminated generation', () => {
  let generation = 0;
  const fence = new StoreContentFence(() => ({ generation, ready: true }));
  const settle = fence.begin({ quads: [quad('urn:meta', 'urn:s')] });
  generation = 1;
  expect(fence.openScope(scope('urn:meta', 'urn:s'))).toBeUndefined();
  settle('indeterminate', { generation: 0 });
  expectOpen(fence, 'urn:meta', 'urn:s');
});
