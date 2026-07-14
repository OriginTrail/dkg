import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryLayer } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  DKG_NS,
  RDF_TYPE,
  SCHEMA_NAME,
  lineGraphsFromNquads,
  linesFromNquads,
  registerTestSyncHandler,
  subGraphRegistrationQuads,
  workspaceOpQuads,
} from './_helpers/sync-responder.js';

const DKG_CONTEXT_GRAPH = 'https://dkg.network/ontology#ContextGraph';

function compareCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const delta = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

function q(graph: string, subject: string, predicate: string, object: string): Quad {
  return { graph, subject, predicate, object };
}

describe('sync responder graph admission planner', () => {
  let store: OxigraphStore;

  beforeEach(() => {
    store = new OxigraphStore();
  });

  it('D-SEC denies durable data for a curated child requested through a bare public ancestor', async () => {
    const ancestorId = '0x1111111111111111111111111111111111111111';
    const childId = `${ancestorId}/medical-evidence`;
    const childPrefix = `did:dkg:context-graph:${childId}`;
    const childMeta = `${childPrefix}/_meta`;
    const childPerCgData = `${childPrefix}/context/1`;
    const childPerCgMeta = `${childPrefix}/context/1/_meta`;
    const childSwm = `${childPrefix}/_shared_memory`;
    const childSwmMeta = `${childPrefix}/_shared_memory_meta`;

    await store.insert([
      q(childMeta, childPrefix, RDF_TYPE, DKG_CONTEXT_GRAPH),
      q(childMeta, childPrefix, `${DKG_NS}accessPolicy`, '"private"'),
      q(childPrefix, 'urn:patient:root', 'http://schema.org/name', '"CHILD-DATA-LEAK"'),
      q(childPerCgData, 'urn:patient:kc', 'http://schema.org/name', '"CHILD-PER-CG-LEAK"'),
      q(childPerCgMeta, 'urn:patient:meta', `${DKG_NS}merkleRoot`, '"CHILD-META-LEAK"'),
      q(childSwm, 'urn:patient:swm', 'http://schema.org/name', '"CHILD-SWM-LEAK"'),
      ...workspaceOpQuads(childId, 'op-child', 'urn:patient:swm', childSwmMeta, '2026-06-01T00:00:00.000Z'),
    ]);

    const cap = registerTestSyncHandler(store);
    const out = await cap.invoke({
      contextGraphId: ancestorId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 5000,
    });

    expect(out).toBe('');
  });

  it('D-SEC denies durable data for slash-bearing descendant CGs even when the first segment is not a CG', async () => {
    const ancestorId = '0x2222222222222222222222222222222222222222';
    const childId = `${ancestorId}/team/project`;
    const childPrefix = `did:dkg:context-graph:${childId}`;
    const childMeta = `${childPrefix}/_meta`;

    await store.insert([
      q(childMeta, childPrefix, RDF_TYPE, DKG_CONTEXT_GRAPH),
      q(childPrefix, 'urn:descendant:root', 'http://schema.org/name', '"DESCENDANT-LEAK"'),
      q(`${childPrefix}/context/1/_meta`, 'urn:descendant:meta', `${DKG_NS}merkleRoot`, '"DESCENDANT-META-LEAK"'),
    ]);

    const cap = registerTestSyncHandler(store);
    const out = await cap.invoke({
      contextGraphId: ancestorId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 5000,
    });

    expect(out).toBe('');
  });

  it('preserves durable data admission while excluding private, top-level meta, WM assertions, and child CGs', async () => {
    const cgId = 'planner-cg';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const cgMeta = `${cgPrefix}/_meta`;
    const canonicalData = cgPrefix;
    const perCgData = `${cgPrefix}/context/1`;
    const perCgMeta = `${cgPrefix}/context/1/_meta`;
    const privateGraph = `${cgPrefix}/_private/secret`;
    const wmAssertion = `${cgPrefix}/assertion/0xabc/wm-draft`;
    const vmAssertion = `${cgPrefix}/assertion/0xabc/vm-final`;
    const childId = `${cgId}/child`;
    const childPrefix = `did:dkg:context-graph:${childId}`;
    const childMeta = `${childPrefix}/_meta`;

    await store.insert([
      q(canonicalData, 'urn:durable:root', 'http://schema.org/name', '"canonical"'),
      q(cgMeta, cgPrefix, `${DKG_NS}createdAt`, '"2026-06-01T00:00:00Z"'),
      q(perCgData, 'urn:per-cg:data', 'http://schema.org/name', '"per-cg-data"'),
      q(perCgMeta, 'urn:per-cg:meta', `${DKG_NS}merkleRoot`, '"per-cg-meta"'),
      q(privateGraph, 'urn:private:data', 'http://schema.org/name', '"private-leak"'),
      q(wmAssertion, 'urn:assertion:wm', 'http://schema.org/name', '"wm-assertion-leak"'),
      q(vmAssertion, 'urn:assertion:vm', 'http://schema.org/name', '"vm-assertion"'),
      q(cgMeta, 'urn:lifecycle:wm', `${DKG_NS}assertionGraph`, wmAssertion),
      q(cgMeta, 'urn:lifecycle:wm', `${DKG_NS}memoryLayer`, `"${MemoryLayer.WorkingMemory}"`),
      q(cgMeta, 'urn:lifecycle:vm', `${DKG_NS}assertionGraph`, vmAssertion),
      q(cgMeta, 'urn:lifecycle:vm', `${DKG_NS}memoryLayer`, `"${MemoryLayer.VerifiableMemory}"`),
      q(childMeta, childPrefix, RDF_TYPE, DKG_CONTEXT_GRAPH),
      q(childPrefix, 'urn:child:data', 'http://schema.org/name', '"child-leak"'),
    ]);

    const cap = registerTestSyncHandler(store);
    const out = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 5000,
    });
    const graphs = lineGraphsFromNquads(out);

    expect(graphs.has(canonicalData)).toBe(true);
    expect(graphs.has(perCgData)).toBe(true);
    expect(graphs.has(perCgMeta)).toBe(true);
    expect(graphs.has(vmAssertion)).toBe(true);
    expect(graphs.has(cgMeta)).toBe(false);
    expect(graphs.has(privateGraph)).toBe(false);
    expect(graphs.has(wmAssertion)).toBe(false);
    expect(graphs.has(childPrefix)).toBe(false);
    expect(out).toContain('"vm-assertion"');
    expect(out).not.toContain('"wm-assertion-leak"');
    expect(out).not.toContain('"private-leak"');
    expect(out).not.toContain('"child-leak"');
  });

  it('keeps parent durable partitions when a child CG has a reserved partition name', async () => {
    const cgId = 'planner-reserved-child-cg';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const parentPartition = `${cgPrefix}/context/1`;
    const parentAssertion = `${cgPrefix}/assertion/0xabc/final`;
    const parentAssertionMeta = `${parentAssertion}/_meta`;
    const malformedAssertion = `${cgPrefix}/assertion/foo`;
    const reservedNameChildId = `${cgId}/context`;
    const reservedNameChildPrefix = `did:dkg:context-graph:${reservedNameChildId}`;
    const reservedNameChildMeta = `${reservedNameChildPrefix}/_meta`;
    const reservedNameChildSwm = `${reservedNameChildPrefix}/_shared_memory`;
    const assertionNameChildId = `${cgId}/assertion`;
    const assertionNameChildPrefix = `did:dkg:context-graph:${assertionNameChildId}`;
    const assertionNameChildMeta = `${assertionNameChildPrefix}/_meta`;
    const assertionNameChildPartition = `${assertionNameChildPrefix}/context/1`;
    const regularChildId = `${cgId}/team`;
    const regularChildPrefix = `did:dkg:context-graph:${regularChildId}`;
    const regularChildMeta = `${regularChildPrefix}/_meta`;
    const regularChildNumericPartition = `${regularChildPrefix}/1`;
    const regularChildNumericMeta = `${regularChildPrefix}/1/_meta`;

    await store.insert([
      q(parentPartition, 'urn:parent:partition', 'http://schema.org/name', '"parent-context-partition"'),
      q(parentAssertion, 'urn:parent:assertion', 'http://schema.org/name', '"parent-assertion"'),
      q(parentAssertionMeta, 'urn:parent:assertion', `${DKG_NS}merkleRoot`, '"parent-assertion-meta"'),
      q(`${parentPartition}/_meta`, parentPartition, RDF_TYPE, DKG_CONTEXT_GRAPH),
      q(`${parentAssertion}/_meta`, parentAssertion, RDF_TYPE, DKG_CONTEXT_GRAPH),
      q(malformedAssertion, 'urn:malformed:assertion', 'http://schema.org/name', '"malformed-assertion-leak"'),
      q(`${cgPrefix}/_meta`, 'urn:lifecycle:reserved-vm', `${DKG_NS}memoryLayer`, `"${MemoryLayer.VerifiableMemory}"`),
      q(`${cgPrefix}/_meta`, 'urn:lifecycle:reserved-vm', `${DKG_NS}assertionGraph`, parentAssertion),
      q(reservedNameChildMeta, reservedNameChildPrefix, RDF_TYPE, DKG_CONTEXT_GRAPH),
      q(reservedNameChildPrefix, 'urn:reserved-child:data', 'http://schema.org/name', '"reserved-child-leak"'),
      q(reservedNameChildSwm, 'urn:reserved-child:swm', 'http://schema.org/name', '"reserved-child-swm-leak"'),
      q(assertionNameChildMeta, assertionNameChildPrefix, RDF_TYPE, DKG_CONTEXT_GRAPH),
      q(assertionNameChildPartition, 'urn:assertion-child:partition', 'http://schema.org/name', '"assertion-child-partition-leak"'),
      q(regularChildMeta, regularChildPrefix, RDF_TYPE, DKG_CONTEXT_GRAPH),
      q(regularChildNumericPartition, 'urn:regular-child:partition', 'http://schema.org/name', '"regular-child-numeric-leak"'),
      q(regularChildNumericMeta, 'urn:regular-child:meta', `${DKG_NS}merkleRoot`, '"regular-child-numeric-meta-leak"'),
    ]);

    const cap = registerTestSyncHandler(store);
    const out = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 5000,
    });

    expect(lineGraphsFromNquads(out).has(parentPartition)).toBe(true);
    expect(lineGraphsFromNquads(out).has(parentAssertion)).toBe(true);
    expect(lineGraphsFromNquads(out).has(parentAssertionMeta)).toBe(true);
    expect(out).toContain('"parent-context-partition"');
    expect(out).toContain('"parent-assertion"');
    expect(out).toContain('"parent-assertion-meta"');
    expect(out).not.toContain('"reserved-child-leak"');
    expect(out).not.toContain('"reserved-child-swm-leak"');
    expect(out).not.toContain('"assertion-child-partition-leak"');
    expect(out).not.toContain('"malformed-assertion-leak"');
    expect(out).not.toContain('"regular-child-numeric-leak"');
    expect(out).not.toContain('"regular-child-numeric-meta-leak"');
  });

  it('preserves durable meta admission without per-row EXISTS filters', async () => {
    const cgId = 'planner-meta-cg';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const cgMeta = `${cgPrefix}/_meta`;
    const vmAssertion = `${cgPrefix}/assertion/0xabc/final`;
    const wmAssertion = `${cgPrefix}/assertion/0xabc/draft`;
    const registeredSubGraph = `${cgPrefix}/registered`;
    const childCollisionSubGraph = `${cgPrefix}/child`;

    await store.insert([
      q(cgMeta, cgPrefix, `${DKG_NS}createdAt`, '"2026-06-01T00:00:00Z"'),
      ...subGraphRegistrationQuads(cgId, 'registered'),
      ...subGraphRegistrationQuads(cgId, 'child'),
      q(`${childCollisionSubGraph}/_meta`, childCollisionSubGraph, RDF_TYPE, DKG_CONTEXT_GRAPH),
      q(cgMeta, 'urn:forged-subgraph-registration', RDF_TYPE, `${DKG_NS}SubGraph`),
      q(cgMeta, 'urn:forged-subgraph-registration', SCHEMA_NAME, '"forged"'),
      q(cgMeta, `${cgPrefix}/context`, RDF_TYPE, `${DKG_NS}SubGraph`),
      q(cgMeta, `${cgPrefix}/context`, SCHEMA_NAME, '"context"'),
      q(cgMeta, 'did:dkg:activity:1', 'http://schema.org/name', '"activity"'),
      q(cgMeta, 'did:dkg:join-request:1', 'http://schema.org/name', '"join"'),
      // Even a malformed moderation row that also matches a normally admitted
      // lifecycle branch must remain curator-local.
      q(cgMeta, 'did:dkg:join-request:1', `${DKG_NS}memoryLayer`, `"${MemoryLayer.VerifiableMemory}"`),
      q(cgMeta, 'urn:lifecycle:vm', `${DKG_NS}memoryLayer`, `"${MemoryLayer.VerifiableMemory}"`),
      q(cgMeta, 'urn:lifecycle:vm', `${DKG_NS}assertionGraph`, vmAssertion),
      q(cgMeta, 'urn:lifecycle:vm', `${DKG_NS}assertionName`, '"final"'),
      q(cgMeta, vmAssertion, `${DKG_NS}merkleRoot`, '"vm-assertion-meta"'),
      q(cgMeta, 'urn:event:vm', 'http://www.w3.org/ns/prov#generated', 'urn:lifecycle:vm'),
      q(cgMeta, 'urn:lifecycle:wm', `${DKG_NS}memoryLayer`, `"${MemoryLayer.WorkingMemory}"`),
      q(cgMeta, 'urn:lifecycle:wm', `${DKG_NS}assertionGraph`, wmAssertion),
      q(cgMeta, wmAssertion, `${DKG_NS}merkleRoot`, '"wm-assertion-meta-leak"'),
      q(cgMeta, 'urn:noise', 'http://schema.org/name', '"noise-leak"'),
    ]);

    const cap = registerTestSyncHandler(store);
    const out = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'meta',
      offset: 0,
      limit: 5000,
    });

    expect(out).toContain(cgPrefix);
    expect(out).toContain(registeredSubGraph);
    expect(out).toContain(childCollisionSubGraph);
    expect(out).toContain(`${DKG_NS}SubGraph`);
    expect(out).toContain(SCHEMA_NAME);
    expect(out).toContain('did:dkg:activity:1');
    expect(out).not.toContain('did:dkg:join-request:1');
    expect(out).toContain('urn:lifecycle:vm');
    expect(out).toContain(vmAssertion);
    expect(out).toContain('urn:event:vm');
    expect(out).not.toContain('urn:forged-subgraph-registration');
    expect(out).not.toContain(`${cgPrefix}/context`);
    expect(out).not.toContain('urn:lifecycle:wm');
    expect(out).not.toContain('wm-assertion-meta-leak');
    expect(out).not.toContain('noise-leak');
  });

  it('uses true codepoint order for graph-level pagination', async () => {
    const cgId = 'planner-order-cg';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const graphs = [
      `${cgPrefix}/alpha`,
      `${cgPrefix}/\u{10000}-astral`,
      `${cgPrefix}/\uF900-bmp`,
      `${cgPrefix}/zeta`,
    ];
    await store.insert(graphs.map((graph) =>
      q(graph, `urn:subject:${graph.slice(cgPrefix.length + 1)}`, 'http://schema.org/name', `"${graph}"`),
    ));

    const cap = registerTestSyncHandler(store, { syncPageSize: 2 });
    const first = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 2,
    });
    const second = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 2,
      limit: 2,
    });
    const actualLines = [...linesFromNquads(first), ...linesFromNquads(second)];
    const expectedGraphs = [...graphs].sort(compareCodePoint);

    expect(actualLines).toHaveLength(expectedGraphs.length);
    for (let i = 0; i < expectedGraphs.length; i++) {
      expect(actualLines[i]).toContain(`<${expectedGraphs[i]}> .`);
    }
  });

  it('serves registered SWM subgraphs while denying unregistered and child-CG collisions', async () => {
    const cgId = 'planner-swm-cg';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const cgMeta = `${cgPrefix}/_meta`;
    const rootSwm = `${cgPrefix}/_shared_memory`;
    const rootSwmMeta = `${cgPrefix}/_shared_memory_meta`;
    const registeredSwm = `${cgPrefix}/registered/_shared_memory`;
    const registeredSwmMeta = `${cgPrefix}/registered/_shared_memory_meta`;
    const unregisteredSwm = `${cgPrefix}/unregistered/_shared_memory`;
    const childId = `${cgId}/child`;
    const childPrefix = `did:dkg:context-graph:${childId}`;
    const childMeta = `${childPrefix}/_meta`;
    const childSwm = `${childPrefix}/_shared_memory`;
    const childSwmMeta = `${childPrefix}/_shared_memory_meta`;
    const now = '2026-06-01T00:00:00.000Z';

    await store.insert([
      q(rootSwm, 'urn:swm:root', 'http://schema.org/name', '"root-swm"'),
      ...workspaceOpQuads(cgId, 'root', 'urn:swm:root', rootSwmMeta, now),
      ...subGraphRegistrationQuads(cgId, 'registered'),
      q(registeredSwm, 'urn:swm:registered', 'http://schema.org/name', '"registered-swm"'),
      ...workspaceOpQuads(cgId, 'registered', 'urn:swm:registered', registeredSwmMeta, now),
      q(unregisteredSwm, 'urn:swm:unregistered', 'http://schema.org/name', '"unregistered-leak"'),
      ...subGraphRegistrationQuads(cgId, 'child'),
      q(childMeta, childPrefix, RDF_TYPE, DKG_CONTEXT_GRAPH),
      q(childSwm, 'urn:swm:child', 'http://schema.org/name', '"child-swm-leak"'),
      ...workspaceOpQuads(childId, 'child', 'urn:swm:child', childSwmMeta, now),
    ]);

    const cap = registerTestSyncHandler(store);
    const dataOut = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data',
      offset: 0,
      limit: 5000,
    });
    const dataGraphs = lineGraphsFromNquads(dataOut);

    expect(dataGraphs.has(rootSwm)).toBe(true);
    expect(dataGraphs.has(registeredSwm)).toBe(true);
    expect(dataGraphs.has(unregisteredSwm)).toBe(false);
    expect(dataGraphs.has(childSwm)).toBe(false);
    expect(dataOut).not.toContain('"unregistered-leak"');
    expect(dataOut).not.toContain('"child-swm-leak"');

    const metaOut = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'meta',
      offset: 0,
      limit: 5000,
    });
    const metaGraphs = lineGraphsFromNquads(metaOut);

    expect(metaGraphs.has(rootSwmMeta)).toBe(true);
    expect(metaGraphs.has(registeredSwmMeta)).toBe(true);
    expect(metaGraphs.has(cgMeta)).toBe(false);
    expect(metaGraphs.has(childSwmMeta)).toBe(false);
    expect(metaOut).not.toContain(`${DKG_NS}SubGraph`);
    expect(metaOut).not.toContain(`did:dkg:context-graph:${cgId}/child`);
  });

  it('does not append SWM registration rows to paged meta responses', async () => {
    const cgId = 'planner-swm-registration-page-cg';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const alphaSwmMeta = `${cgPrefix}/alpha/_shared_memory_meta`;
    const bravoSwmMeta = `${cgPrefix}/bravo/_shared_memory_meta`;
    const now = '2026-06-01T00:00:00.000Z';

    await store.insert([
      ...subGraphRegistrationQuads(cgId, 'alpha'),
      ...subGraphRegistrationQuads(cgId, 'bravo'),
      ...workspaceOpQuads(cgId, 'alpha', 'urn:swm:prelude:alpha', alphaSwmMeta, now),
      ...workspaceOpQuads(cgId, 'bravo', 'urn:swm:prelude:bravo', bravoSwmMeta, now),
    ]);

    const cap = registerTestSyncHandler(store);
    const first = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'meta',
      offset: 0,
      limit: 5,
    });
    await store.insert([
      q(`${cgPrefix}/bravo/_meta`, `${cgPrefix}/bravo`, RDF_TYPE, DKG_CONTEXT_GRAPH),
    ]);
    const second = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'meta',
      offset: 5,
      limit: 5,
    });

    expect(first).not.toContain(`${DKG_NS}SubGraph`);
    expect(linesFromNquads(first)).toHaveLength(5);
    expect(second).not.toContain(`${DKG_NS}SubGraph`);
    expect(lineGraphsFromNquads(second).has(bravoSwmMeta)).toBe(true);
  });

  it('does not serve stale SWM rows from a previous request after same-graph writes', async () => {
    const cgId = 'planner-swm-freshness-cg';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const rootSwm = `${cgPrefix}/_shared_memory`;
    const rootSwmMeta = `${cgPrefix}/_shared_memory_meta`;
    const now = new Date().toISOString();

    await store.insert([
      q(rootSwm, 'urn:swm:freshness:first', 'http://schema.org/name', '"first"'),
      ...workspaceOpQuads(cgId, 'first', 'urn:swm:freshness:first', rootSwmMeta, now),
    ]);

    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: 60_000 });
    const firstOut = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data',
      offset: 0,
      limit: 5000,
    });
    expect(firstOut).toContain('"first"');
    expect(firstOut).not.toContain('"second"');

    await store.insert([
      q(rootSwm, 'urn:swm:freshness:second', 'http://schema.org/name', '"second"'),
      ...workspaceOpQuads(cgId, 'second', 'urn:swm:freshness:second', rootSwmMeta, now),
    ]);

    const secondOut = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data',
      offset: 0,
      limit: 5000,
    });

    expect(secondOut).toContain('"first"');
    expect(secondOut).toContain('"second"');
  });

  it('discovers newly-created SWM graphs on the next request', async () => {
    const cgId = 'planner-swm-new-graph-cg';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const rootSwm = `${cgPrefix}/_shared_memory`;
    const rootSwmMeta = `${cgPrefix}/_shared_memory_meta`;
    const subSwm = `${cgPrefix}/fresh-sub/_shared_memory`;
    const subSwmMeta = `${cgPrefix}/fresh-sub/_shared_memory_meta`;
    const now = new Date().toISOString();

    await store.insert([
      q(rootSwm, 'urn:swm:new-graph:root', 'http://schema.org/name', '"root"'),
      ...workspaceOpQuads(cgId, 'root', 'urn:swm:new-graph:root', rootSwmMeta, now),
    ]);

    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: 60_000 });
    const firstOut = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data',
      offset: 0,
      limit: 5000,
    });
    expect(firstOut).toContain('"root"');
    expect(firstOut).not.toContain('"new-sub"');

    await store.insert([
      ...subGraphRegistrationQuads(cgId, 'fresh-sub'),
      q(subSwm, 'urn:swm:new-graph:sub', 'http://schema.org/name', '"new-sub"'),
      ...workspaceOpQuads(cgId, 'sub', 'urn:swm:new-graph:sub', subSwmMeta, now),
    ]);

    const secondOut = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data',
      offset: 0,
      limit: 5000,
    });
    const graphs = lineGraphsFromNquads(secondOut);
    expect(graphs.has(rootSwm)).toBe(true);
    expect(graphs.has(subSwm)).toBe(true);
    expect(secondOut).toContain('"new-sub"');
  });

  it('ignores malformed replicated subgraph names without failing SWM sync', async () => {
    const cgId = 'planner-swm-malformed-subgraph-cg';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const cgMeta = `${cgPrefix}/_meta`;
    const rootSwm = `${cgPrefix}/_shared_memory`;
    const rootSwmMeta = `${cgPrefix}/_shared_memory_meta`;
    const malformedSg = `${cgPrefix}/bad-name-record`;
    const now = new Date().toISOString();

    await store.insert([
      q(rootSwm, 'urn:swm:malformed:root', 'http://schema.org/name', '"root"'),
      ...workspaceOpQuads(cgId, 'root', 'urn:swm:malformed:root', rootSwmMeta, now),
      q(cgMeta, malformedSg, RDF_TYPE, `${DKG_NS}SubGraph`),
      q(cgMeta, malformedSg, 'http://schema.org/name', '"bad name"'),
    ]);

    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: 60_000 });
    const out = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data',
      offset: 0,
      limit: 5000,
    });

    expect(out).toContain('"root"');
  });

  it('uses top-level durable meta for sinceBatchId filtering without emitting it as data', async () => {
    const cgId = 'planner-delta-top-meta-cg';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const cgMeta = `${cgPrefix}/_meta`;
    const kc = 'did:dkg:evm:31337/0xplannerdelta';
    const ka = `${kc}/1`;
    const root = 'urn:delta:top-meta-root';

    await store.insert([
      q(cgPrefix, root, 'http://schema.org/name', '"stale-data"'),
      q(cgMeta, kc, `${DKG_NS}batchId`, '"4"'),
      q(cgMeta, ka, `${DKG_NS}partOf`, kc),
      q(cgMeta, ka, `${DKG_NS}rootEntity`, root),
    ]);

    const cap = registerTestSyncHandler(store);
    const staleOut = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 5000,
      sinceBatchId: '4',
    });
    expect(staleOut).not.toContain('"stale-data"');
    expect(lineGraphsFromNquads(staleOut).has(cgMeta)).toBe(false);

    const freshOut = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 5000,
      sinceBatchId: '3',
    });
    expect(freshOut).toContain('"stale-data"');
    expect(lineGraphsFromNquads(freshOut).has(cgMeta)).toBe(false);
  });
});
