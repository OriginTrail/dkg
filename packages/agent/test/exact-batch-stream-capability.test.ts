import { ContextGraphBindingState } from '../src/context-graph-binding-state.js';
import { describe, expect, it } from 'vitest';
import { exactBatchStreamUnsupported, rememberExactBatchStreamUnsupported, EXACT_BATCH_UNSUPPORTED_TTL_MS, EXACT_BATCH_UNSUPPORTED_MAX_PEERS, captureExactBatchStreamRefusalScope, rememberExactBatchStreamResourceRefusal, EXACT_BATCH_RESOURCE_REFUSAL_MAX_ENTRIES, EXACT_BATCH_RESOURCE_REFUSAL_TTL_MS } from '../src/sync/exact-batch-stream-capability.js';

describe('experimental exact stream unsupported transport hints', () => {
  it('suppresses only the captured current connection until the inclusive deadline', () => {
    const owner = {};
    rememberExactBatchStreamUnsupported(owner, 'peer', 'connection1', 'connection1', 100);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'connection1', 100 + EXACT_BATCH_UNSUPPORTED_TTL_MS - 1)).toBe(true);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'connection1', 100 + EXACT_BATCH_UNSUPPORTED_TTL_MS)).toBe(false);
  });
  it('never transfers an old failure to a replacement connection or another owner', () => {
    const owner = {};
    rememberExactBatchStreamUnsupported(owner, 'peer', 'old', 'new', 100);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'new', 100)).toBe(false);
    rememberExactBatchStreamUnsupported(owner, 'peer', 'old', 'old', 100);
    expect(exactBatchStreamUnsupported({}, 'peer', 'old', 100)).toBe(false);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'new', 100)).toBe(false);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'old', 100)).toBe(false);
  });
  it('clears disconnected evidence and ignores missing connection identity', () => {
    const owner = {};
    rememberExactBatchStreamUnsupported(owner, 'peer', null, null, 100);
    expect(exactBatchStreamUnsupported(owner, 'peer', null, 100)).toBe(false);
    rememberExactBatchStreamUnsupported(owner, 'peer', 'connection', 'connection', 100);
    expect(exactBatchStreamUnsupported(owner, 'peer', null, 100)).toBe(false);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'connection', 100)).toBe(false);
  });
  it('bounds each owner to an LRU set without refreshing expiry on reads', () => {
    const owner = {};
    for (let i = 0; i < EXACT_BATCH_UNSUPPORTED_MAX_PEERS; i++) rememberExactBatchStreamUnsupported(owner, `peer${i}`, 'c', 'c', 100);
    expect(exactBatchStreamUnsupported(owner, 'peer0', 'c', 101)).toBe(true);
    rememberExactBatchStreamUnsupported(owner, 'new', 'c', 'c', 101);
    expect(exactBatchStreamUnsupported(owner, 'peer1', 'c', 101)).toBe(false);
    expect(exactBatchStreamUnsupported(owner, 'peer0', 'c', 100 + EXACT_BATCH_UNSUPPORTED_TTL_MS)).toBe(false);
    expect(exactBatchStreamUnsupported(owner, 'new', 'c', 100 + EXACT_BATCH_UNSUPPORTED_TTL_MS)).toBe(true);
  });
});


describe('experimental exact stream resource refusal transport hints', () => {
  const scope = (contextGraphId: string, bindingKey = 'binding') => ({ contextGraphId, bindingKey });

  it('suppresses only the scoped graph binding on the current connection and owner', () => {
    const owner = {}, graph = scope('graph');
    rememberExactBatchStreamResourceRefusal(owner, 'peer', 'c', 'c', graph, graph, 100);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'c', 101, graph)).toBe(true);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'c', 101, scope('another-graph'))).toBe(false);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'c', 101)).toBe(false);
    expect(exactBatchStreamUnsupported({}, 'peer', 'c', 101, graph)).toBe(false);
    expect(exactBatchStreamUnsupported(owner, 'another-peer', 'c', 101, graph)).toBe(false);
  });

  it('expires at the inclusive deadline without refreshing TTL on reads', () => {
    const owner = {}, graph = scope('graph');
    rememberExactBatchStreamResourceRefusal(owner, 'peer', 'c', 'c', graph, graph, 100);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'c', 100 + EXACT_BATCH_RESOURCE_REFUSAL_TTL_MS - 1, graph)).toBe(true);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'c', 100 + EXACT_BATCH_RESOURCE_REFUSAL_TTL_MS, graph)).toBe(false);
  });

  it('rejects stale scope or connection settlements and clears disconnected evidence', () => {
    const owner = {}, graph = scope('graph');
    rememberExactBatchStreamResourceRefusal(owner, 'peer', 'old', 'new', graph, graph, 100);
    rememberExactBatchStreamResourceRefusal(owner, 'peer', 'c', 'c', graph, scope('graph', 'replacement'), 100);
    rememberExactBatchStreamResourceRefusal(owner, 'peer', 'c', 'c', null, null, 100);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'c', 101, graph)).toBe(false);
    rememberExactBatchStreamResourceRefusal(owner, 'peer', 'c', 'c', graph, graph, 100);
    expect(exactBatchStreamUnsupported(owner, 'peer', null, 101, graph)).toBe(false);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'c', 101, graph)).toBe(false);
  });

  it('revokes an old binding instead of reviving it when the prior scope returns', () => {
    const owner = {}, graph = scope('graph');
    rememberExactBatchStreamResourceRefusal(owner, 'peer', 'c', 'c', graph, graph, 100);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'c', 101, scope('graph', 'replacement'))).toBe(false);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'c', 101, graph)).toBe(false);
  });

  it('bounds graph-scoped refusal entries by LRU without granting a peer-wide downgrade', () => {
    const owner = {};
    for (let n = 0; n < EXACT_BATCH_RESOURCE_REFUSAL_MAX_ENTRIES; n++) {
      const graph = scope(`graph${n}`);
      rememberExactBatchStreamResourceRefusal(owner, 'peer', 'c', 'c', graph, graph, 100);
    }
    expect(exactBatchStreamUnsupported(owner, 'peer', 'c', 101, scope('graph0'))).toBe(true);
    const graph = scope('new');
    rememberExactBatchStreamResourceRefusal(owner, 'peer', 'c', 'c', graph, graph, 101);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'c', 102, scope('graph0'))).toBe(true);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'c', 102, scope('graph1'))).toBe(false);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'c', 102)).toBe(false);
  });

  it('captures deployment, graph binding, selected binding and lifecycle generations', () => {
    const state = new ContextGraphBindingState();
    const graph = 'graph';
    const subscription = { onChainId: '14' };
    const params = { contextGraphId: graph, deploymentId: 'deployment', binding: state.currentBindingFor(graph, subscription),
      bindingGeneration: state.capture(graph), selectedBindingGeneration: 1, lifecycleGeneration: 1 };
    const initial = captureExactBatchStreamRefusalScope(params);
    expect(initial).not.toBeNull();
    expect(Object.isFrozen(initial)).toBe(true);
    expect(captureExactBatchStreamRefusalScope(params)).toEqual(initial);
    expect(captureExactBatchStreamRefusalScope({ ...params, binding: undefined })).toBeNull();
    const changes = [
      () => { params.deploymentId = 'replacement'; },
      () => { params.bindingGeneration = state.bump(graph); },
      () => { subscription.onChainId = '15'; params.binding = state.currentBindingFor(graph, subscription); },
      () => { params.selectedBindingGeneration++; },
      () => { params.lifecycleGeneration++; },
    ];
    let previous = initial;
    for (const change of changes) { change(); const next = captureExactBatchStreamRefusalScope(params); expect(next?.bindingKey).not.toBe(previous?.bindingKey); previous = next; }
  });
});
