import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createCapabilityBridge } from './bridge.mjs';
import { component } from './component-registry.mjs';

function fixture(count = 1) {
  const graphId = 'catalog-test', owner = '0x' + '1'.repeat(40), sourceHash = 'a'.repeat(64);
  const definitions = Array.from({ length: count }, (_, i) => ({ kaRef: 'urn:test:component:' + i,
    kind: 'component', descriptor: component('edit-fields') }));
  const programs = {
    async getApproval({ operationIri }) { return { binding: { contextGraphId: graphId, operationIri, enabled: true,
      executorAgentAddress: owner, allowedCallerAgentAddresses: [owner], n8n: {},
      program: { contextGraphId: graphId, programIri: operationIri, programLayer: 'wm', sourceHash, authorAgentAddress: owner } } }; },
    async getSource() { return { sourceHash, authorAgentAddress: owner, label: 'Edit fields', version: '1.0.0' }; },
  };
  const bridge = createCapabilityBridge({ graphId, owner, definitions, config: {}, client: { programs },
    agent: { query: async () => ({ bindings: [{ program: 'urn:test:not-installed' }, ...definitions.map(d => ({ program: d.kaRef }))] }) } });
  return { bridge, definitions, programs };
}

test('catalog bounds concurrent metadata reads and preserves installed/retired order under out-of-order completion', async () => {
  const f = fixture(33), gates = new Map(f.definitions.map(d => [d.kaRef, Promise.withResolvers()]));
  f.definitions[31].retired = true; f.definitions[32].retired = true;
  const started = []; let inFlight = 0, peak = 0;
  for (const method of ['getApproval', 'getSource']) {
    const read = f.programs[method];
    f.programs[method] = async request => {
      const ref = request.operationIri ?? request.programIri;
      started.push([ref, method]); inFlight++; peak = Math.max(peak, inFlight);
      try { await gates.get(ref).promise; return await read(request); }
      finally { inFlight--; }
    };
  }
  const listing = f.bridge.list();
  try {
    await setImmediate();
    assert.deepEqual(started, f.definitions.slice(0, 4).flatMap(d => [[d.kaRef, 'getApproval'], [d.kaRef, 'getSource']]));
    // Keep the first revision pending while every later revision finishes.
    for (const definition of f.definitions.slice(1).reverse()) gates.get(definition.kaRef).resolve();
    await setImmediate();
    assert.equal(started.length, 66, 'uninstalled query results must not trigger metadata reads');
    assert.equal(inFlight, 2);
    assert.equal(peak, 8);
    gates.get(f.definitions[0].kaRef).resolve();
    const catalog = await listing;
    assert.deepEqual(catalog.map(c => c.kaRef), f.definitions.map(d => d.kaRef));
    assert.ok(catalog.every(c => c.available && c.descriptor.id === 'edit-fields'));
    assert.deepEqual(catalog.filter(c => c.retired).map(c => c.kaRef), f.definitions.slice(31).map(d => d.kaRef));
  } finally { for (const gate of gates.values()) gate.resolve(); await listing; f.bridge.close(); }
});

test('missing approval keeps source metadata in the catalog but never grants availability', async () => {
  const f = fixture(2), approval = f.programs.getApproval;
  f.programs.getApproval = async request => {
    if (request.operationIri === f.definitions[0].kaRef) throw Object.assign(new Error('approval missing'), { status: 404 });
    const value = await approval(request); value.binding.program.sourceHash = 'b'.repeat(64); return value;
  };
  try {
    const catalog = await f.bridge.list();
    assert.deepEqual(catalog.map(c => [c.kaRef, c.name, c.version, c.available]),
      f.definitions.map(d => [d.kaRef, 'Edit fields', '1.0.0', false]));
  } finally { f.bridge.close(); }
});

for (const [method, status] of [['getApproval', 503], ['getSource', 404], ['getSource', 503]]) {
  test(`catalog propagates ${method} ${status} instead of returning partial capabilities`, async () => {
    const f = fixture(), error = Object.assign(new Error('metadata unavailable'), { status });
    f.programs[method] = async () => { throw error; };
    try { await assert.rejects(f.bridge.list(), e => e === error); }
    finally { f.bridge.close(); }
  });
}
