import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeQueryCatalogBindings } from '@origintrail-official/dkg-core/query-catalog';
import { SemanticRuntimeStore, type SemanticProgramBinding, type SemanticRuntimeConfig } from '@origintrail-official/dkg-semantic-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSemanticQueryPin, queryOutputSchemaSha256 } from '../src/semantic-runtime-query-pins.js';
import { createAssetCreationAdapter } from '../src/semantic-runtime-asset-adapter.js';
import { invokeBoundSemanticProgram, startConfiguredSemanticRuntime, validateSemanticRuntimeConfig } from '../src/semantic-runtime.js';

const caller = '0x2222222222222222222222222222222222222222';
const executor = '0x1111111111111111111111111111111111111111';
const graph = 'dmaast-kamstrup';
const operation = 'urn:dmaast:operation:record-w10-assessment';
const programIri = 'urn:tracelabs:program:record-w10-assessment:1';
const tool = 'urn:sr:tool:asset-create';
const id = '123e4567-e89b-42d3-a456-426614174088';
const SR = 'https://origintrail.io/semantic-runtime/v1#';
const quads = [
  { subject: 'urn:kamstrup:assessment:W10', predicate: 'urn:dmaast:device', object: 'urn:kamstrup:device:W10' },
  { subject: 'urn:kamstrup:assessment:W10', predicate: 'urn:dmaast:status', object: '"inspection-requested"' },
];
const source = `(strategy dmaast/record-w10 (version "1.0.0") (scope graph:dmaast-kamstrup) (goal record-assessment)
  (supervise one-for-one (max-restarts 1) (window-ms 60000)
    (delegate recorder (grant dkg.asset.create) (call dkg/asset-create@1 ${JSON.stringify(JSON.stringify({ quads }))}))))`;
type Layer = 'wm' | 'swm' | 'vm';
type Runtime = NonNullable<Awaited<ReturnType<typeof startConfiguredSemanticRuntime>>>;
const runtimes: Runtime[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(layer: Layer = 'wm') {
  const binding: SemanticProgramBinding = {
    operationIri: operation, contextGraphId: graph, enabled: true,
    allowedCallerAgentAddresses: [caller], executorAgentAddress: executor,
    program: { contextGraphId: graph, programIri, programLayer: 'swm', authorAgentAddress: executor,
      sourceHash: createHash('sha256').update(source).digest('hex') },
    assetCreation: { toolIri: tool }, executionLayer: layer,
  };
  const config: SemanticRuntimeConfig = { enabled: true, watchdogMs: 1_000, startupTimeoutMs: 30_000, programBindings: [binding] };
  type Entry = { quads: typeof quads; wmCurrentAssertion?: string; swmCurrentAssertion?: string; vmCurrentAssertion?: string; memoryLayer?: string; publishedUal?: string };
  const assets = new Map<string, Entry>();
  const assertion = '11'.repeat(32);
  const required = (name: string) => { const entry = assets.get(name); if (!entry) throw new Error('missing asset'); return entry; };
  const memoryGraph = (at: Layer) => `did:dkg:context-graph:${graph}/${{ wm: '_working_memory', swm: '_shared_memory', vm: '_verifiable_memory' }[at]}/${executor}/7`;
  const state = { source, tools: [tool] };
  const catalogRows = [{
    q: 'urn:dkg:profile:dmaast-kamstrup:query:read-w10', name: 'Read W10',
    scopeGraph: `did:dkg:context-graph:${graph}/equipment`,
    catalog: 'urn:dkg:profile:dmaast-kamstrup:catalog:devices', catalogName: 'Devices',
    sparql: 'SELECT ?device WHERE { VALUES ?device { <urn:kamstrup:device:W10> } }', executionView: 'verifiable-memory',
  }];
  const readData = vi.fn(async () => ({ bindings: [{ device: 'urn:kamstrup:device:W10' }] }));
  const agent = {
    log: { info: vi.fn() }, listLocalAgents: () => [{ agentAddress: executor }], getCustodialAgentPrivateKey: () => '0x01',
    canReadContextGraph: vi.fn(async () => true), canUseSharedMemoryForContextGraph: vi.fn(async () => true),
    store: { query: vi.fn(async () => ({ type: 'bindings', bindings: [] })) },
    resolveContextGraphReadAuthority: vi.fn(async () => ({ outcome: 'allowed' })),
    probeContextGraphWritePreflight: vi.fn(async () => ({ storeAvailable: true, exists: true, hasLocalContent: true, callerAuthorized: true })),
    query: vi.fn(async (sparql: string, opts: Record<string, unknown>) => {
      if (sparql.includes('?language')) return { bindings: state.tools.map((iri) => ({ g: memoryGraph('swm'), language: '"sexpr-v1"', version: '"1.0.0"', source: JSON.stringify(state.source), tool: `<${iri}>` })) };
      if (opts.source === 'semantic-runtime-query-catalog') return { bindings: opts.view === 'verifiable-memory' ? catalogRows : [] };
      if (opts.source === 'semantic-runtime-dkg-query' || opts.source === 'semantic-runtime-sparql-read') return readData();
      if (opts.source === 'semantic-runtime-execution-output-load') return { bindings: [...assets.values()].flatMap((entry) => entry.quads
        .filter((q) => [SR + 'output', SR + 'orderedOutputs'].includes(q.predicate))
        .map((q) => ({ g: memoryGraph(layer), ...(q.predicate === SR + 'output' ? { output: q.object } : { orderedOutputs: q.object }) }))) };
      return { bindings: [] };
    }),
    assertion: {
      history: vi.fn(async (_graph: string, name: string) => assets.get(name) ? { ...required(name) } : null),
      query: vi.fn(async (_graph: string, name: string) => [...required(name).quads]),
      create: vi.fn(async (_graph: string, name: string) => { if (assets.has(name)) throw new Error('duplicate create'); assets.set(name, { quads: [] }); return `urn:asset:${name}`; }),
      write: vi.fn(async (_graph: string, name: string, input: typeof quads) => { required(name).quads.push(...input); }),
      finalize: vi.fn(async (_graph: string, name: string) => { Object.assign(required(name), { wmCurrentAssertion: assertion, memoryLayer: 'WM' }); }),
      promote: vi.fn(async (_graph: string, name: string) => { Object.assign(required(name), { swmCurrentAssertion: assertion, memoryLayer: 'SWM' }); return { publishReady: true }; }),
    },
    publishFromFinalizedAssertion: vi.fn(async (_graph: string, name: string) => {
      const ual = `did:dkg:asset:${name}`;
      Object.assign(required(name), { vmCurrentAssertion: assertion, memoryLayer: 'VM', publishedUal: ual });
      return { status: 'confirmed', ual };
    }),
  };
  const start = async (file = ':memory:') => {
    const runtime = await startConfiguredSemanticRuntime(config, { log: vi.fn(), openStore: () => new SemanticRuntimeStore(file) });
    runtimes.push(runtime!);
    return runtime!;
  };
  const invoke = (runtime: Runtime, invocationId = id) => invokeBoundSemanticProgram(agent as any, runtime, graph, operation, invocationId, config, caller);
  const created = () => [...assets.entries()].filter(([name]) => name.startsWith('program-asset-'));
  return { agent, assets, binding, config, state, start, invoke, created, catalogRows, readData };
}

describe('tenant-approved asset creation through real Wasm', () => {
  it.each(['wm', 'swm', 'vm'] as const)('creates content and the Execution in the approved %s layer; retries return the same receipt', async (layer) => {
    const f = fixture(layer);
    const runtime = await f.start();
    const [result, concurrent] = await Promise.all([f.invoke(runtime), f.invoke(runtime)]);
    expect(concurrent).toEqual(result);
    expect(result).toMatchObject({ persisted: true, executionLayer: layer });
    const receipt = JSON.parse(result.outputs![0]);
    expect(receipt).toMatchObject({ kind: 'asset-created', contextGraphId: graph, layer, authorAgentAddress: executor, name: expect.stringMatching(/^program-asset-[a-f0-9]{64}$/) });
    expect(f.created()).toHaveLength(1);
    expect(f.created()[0][1]).toMatchObject({ memoryLayer: layer.toUpperCase(), quads: expect.arrayContaining(quads) });
    expect(f.agent.assertion.create).toHaveBeenCalledWith(graph, receipt.name, { agentAddress: executor });
    expect(f.agent.probeContextGraphWritePreflight).toHaveBeenCalledWith(graph, { callerAgentAddress: executor });
    expect(f.agent.assertion.promote).toHaveBeenCalledTimes(layer === 'wm' ? 0 : 2);
    expect(f.agent.publishFromFinalizedAssertion).toHaveBeenCalledTimes(layer === 'vm' ? 2 : 0);
    if (layer === 'vm') expect(receipt.ual).toBe(`did:dkg:asset:${receipt.name}`);
    else expect(receipt.ual).toBeUndefined();
    const creates = f.agent.assertion.create.mock.calls.length;
    await expect(f.invoke(runtime)).resolves.toEqual(result);
    expect(f.agent.assertion.create).toHaveBeenCalledTimes(creates);
    f.binding.enabled = false;
    await expect(f.invoke(runtime)).rejects.toMatchObject({ code: 'PROGRAM_INVOCATION_FORBIDDEN' });
  });

  it('composes the permitted query and creation across delegates without consuming the shared capability', async () => {
    const f = fixture();
    f.state.source = `(strategy dmaast/record-w10 (version "1.0.0") (scope graph:dmaast-kamstrup) (goal record-assessment)
      (supervise one-for-one (max-restarts 1) (window-ms 60000)
        (sequence
          (delegate recorder (grant dkg.asset.create) (call dkg/asset-create@1 ${JSON.stringify(JSON.stringify({ quads }))}))
          (delegate reader (grant dkg.query) (call dkg/query@1 "read-w10")))))`;
    f.binding.program.sourceHash = createHash('sha256').update(f.state.source).digest('hex');
    f.state.tools.push('urn:sr:tool:query');
    f.binding.query = createSemanticQueryPin('read-w10', decodeQueryCatalogBindings(f.catalogRows, { contextGraphId: graph })[0], {
      type: 'object', additionalProperties: false, required: ['bindings'], properties: {
        bindings: { type: 'array', maxItems: 1, items: { type: 'object', additionalProperties: false,
          required: ['device'], properties: { device: { type: 'string', maxLength: 128, enum: ['urn:kamstrup:device:W10'] } } } },
      },
    });
    const result = await f.invoke(await f.start());
    expect(result.outputs).toHaveLength(2);
    expect(JSON.parse(result.outputs![0]).kind).toBe('asset-created');
    expect(JSON.parse(result.outputs![1]).result.bindings[0].device).toBe('urn:kamstrup:device:W10');
    expect(f.created()).toHaveLength(1);
    expect(f.readData).toHaveBeenCalledOnce();
  });

  it.each([false, true])('executes a raw read through real Wasm without a catalog and replays (create asset: %s)', async (createAsset) => {
    const f = fixture();
    const query = 'SELECT ?device WHERE { VALUES ?device { <urn:kamstrup:device:W10> } }';
    f.state.source = `(strategy dmaast/record-w10 (version "1.0.0") (scope graph:dmaast-kamstrup) (goal record-assessment)
      (supervise one-for-one (max-restarts 1) (window-ms 60000)
        (sequence
          (delegate reader (grant dkg.sparql.read) (call dkg/sparql-read@1 ${JSON.stringify(query)}))
          ${createAsset ? `(delegate recorder (grant dkg.asset.create) (call dkg/asset-create@1 ${JSON.stringify(JSON.stringify({ quads }))}))` : ''})))`;
    f.binding.program.sourceHash = createHash('sha256').update(f.state.source).digest('hex');
    if (!createAsset) { f.state.tools.length = 0; delete f.binding.assetCreation; }
    f.state.tools.push('urn:sr:tool:sparql-read');
    const outputSchema = { type: 'object' as const, additionalProperties: false as const, required: ['bindings'], properties: {
      bindings: { type: 'array' as const, maxItems: 1, items: { type: 'object' as const, additionalProperties: false as const,
        required: ['device'], properties: { device: { type: 'string' as const, maxLength: 128 } } } },
    } };
    f.binding.sparqlRead = { toolIri: 'urn:sr:tool:sparql-read', layer: 'swm', timeoutMs: 5000, maxResultItems: 10,
      maxOutputBytes: 4096, outputSchema, outputSchemaSha256: queryOutputSchemaSha256(outputSchema) };
    const runtime = await f.start();
    const result = await f.invoke(runtime);
    expect(result.persisted).toBe(true);
    expect(result.outputs).toHaveLength(createAsset ? 2 : 1);
    expect(JSON.parse(result.outputs![0])).toMatchObject({ kind: 'sparql-read', contextGraphId: graph, layer: 'swm',
      result: { bindings: [{ device: 'urn:kamstrup:device:W10' }] } });
    if (createAsset) expect(JSON.parse(result.outputs![1]).kind).toBe('asset-created');
    expect(f.agent.query.mock.calls.some(([, opts]) => opts.source === 'semantic-runtime-query-catalog')).toBe(false);
    expect(f.agent.query).toHaveBeenCalledWith(query, expect.objectContaining({ contextGraphId: graph,
      view: 'shared-working-memory', callerAgentAddress: executor, signal: expect.any(AbortSignal) }));
    await expect(f.invoke(runtime)).resolves.toEqual(result);
    expect(f.readData).toHaveBeenCalledOnce();
    const approved = f.binding.sparqlRead;
    f.binding.assetCreation = { toolIri: tool };
    delete f.binding.sparqlRead;
    await expect(f.invoke(runtime, '123e4567-e89b-42d3-a456-426614174099')).rejects.toMatchObject({ code: 'PROGRAM_BINDING_TOOL_FORBIDDEN' });
    f.binding.sparqlRead = { ...approved, layer: 'vm' };
    await expect(f.invoke(runtime)).rejects.toThrow();
    expect(f.readData).toHaveBeenCalledOnce();
  });

  it('requires explicit tenant approval of asset creation', async () => {
    const f = fixture();
    delete f.binding.assetCreation;
    expect(() => validateSemanticRuntimeConfig(f.config)).toThrow('EMPTY_PROGRAM_BINDING');
    f.binding.assetCreation = { toolIri: 'urn:wrong:tool' };
    const runtime = await f.start();
    await expect(f.invoke(runtime)).rejects.toMatchObject({ code: 'REQUIRED_TOOL_UNAVAILABLE' });
    expect(f.agent.assertion.create).not.toHaveBeenCalled();
  });

  it('denies writes when the executor lacks graph write authority', async () => {
    const f = fixture();
    f.agent.probeContextGraphWritePreflight.mockResolvedValue({ storeAvailable: true, exists: true, hasLocalContent: true, callerAuthorized: false });
    await expect(f.invoke(await f.start())).rejects.toThrow();
    expect(f.agent.assertion.create).not.toHaveBeenCalled();
  });

  it('recovers a lost write response after reopening the durable journal, without another asset or duplicate triples', async () => {
    const f = fixture();
    const dir = mkdtempSync(join(tmpdir(), 'program-asset-')); dirs.push(dir);
    const file = join(dir, 'runtime.sqlite');
    const runtime = await f.start(file);
    const write = f.agent.assertion.write.getMockImplementation()!;
    f.agent.assertion.write.mockImplementationOnce(async (...args) => { await write(...args); throw new Error('lost write response'); });
    await expect(f.invoke(runtime)).rejects.toThrow();
    expect(f.created()).toHaveLength(1);
    await runtime.stop(); runtimes.splice(runtimes.indexOf(runtime), 1);
    const result = await f.invoke(await f.start(file));
    expect(JSON.parse(result.outputs![0]).name).toBe(f.created()[0][0]);
    expect(f.created()[0][1].quads).toHaveLength(quads.length);
    expect(f.agent.assertion.write.mock.calls.filter(([, name]) => name.startsWith('program-asset-'))).toHaveLength(1);
  });

  it.each(['finalize', 'promote'] as const)('recovers a lost %s response from exact assertion evidence', async (phase) => {
    const f = fixture('swm');
    const runtime = await f.start();
    const complete = f.agent.assertion[phase].getMockImplementation()!;
    f.agent.assertion[phase].mockImplementationOnce(async (...args) => { await complete(...args); throw new Error('response lost'); });
    await expect(f.invoke(runtime)).rejects.toThrow();
    const result = await f.invoke(runtime);
    const name = JSON.parse(result.outputs![0]).name;
    expect(f.agent.assertion[phase].mock.calls.filter(([, assetName]) => assetName === name)).toHaveLength(1);
    expect(f.created()).toHaveLength(1);
  });

  it('does not overwrite content changed during an interrupted write', async () => {
    const f = fixture();
    const runtime = await f.start();
    const write = f.agent.assertion.write.getMockImplementation()!;
    f.agent.assertion.write.mockImplementationOnce(async (...args) => { await write(...args); throw new Error('response lost'); });
    await expect(f.invoke(runtime)).rejects.toThrow();
    f.created()[0][1].quads.push({ subject: 'urn:unrelated', predicate: 'urn:other', object: '"do not overwrite"' });
    await expect(f.invoke(runtime)).rejects.toThrow();
    expect(f.agent.assertion.write).toHaveBeenCalledOnce();
    expect(f.agent.assertion.finalize).not.toHaveBeenCalled();
  });

  it('does not resubmit an uncertain VM publication; confirmation read-back completes the original effect', async () => {
    const f = fixture('vm');
    const runtime = await f.start();
    const publish = f.agent.publishFromFinalizedAssertion.getMockImplementation()!;
    f.agent.publishFromFinalizedAssertion.mockRejectedValueOnce(new Error('publication response lost'));
    await expect(f.invoke(runtime)).rejects.toMatchObject({ code: 'INVOCATION_REQUIRES_RECONCILIATION', status: 409 });
    await expect(f.invoke(runtime)).rejects.toMatchObject({ code: 'INVOCATION_REQUIRES_RECONCILIATION', status: 409 });
    expect(f.agent.publishFromFinalizedAssertion).toHaveBeenCalledOnce();
    const [name] = f.created()[0];
    await publish(graph, name); // Publisher recovery later proves this exact assertion confirmed.
    const result = await f.invoke(runtime);
    expect(JSON.parse(result.outputs![0]).ual).toBe(`did:dkg:asset:${name}`);
    expect(f.agent.publishFromFinalizedAssertion.mock.calls.filter(([, assetName]) => assetName === name)).toHaveLength(1);
    expect(f.created()).toHaveLength(1);
  });

  it('requires matching VM history even when the publisher returns confirmed', async () => {
    const f = fixture('vm');
    const runtime = await f.start();
    f.agent.publishFromFinalizedAssertion.mockResolvedValueOnce({ status: 'confirmed', ual: 'did:dkg:unconfirmed-in-graph' });
    await expect(f.invoke(runtime)).rejects.toMatchObject({ code: 'INVOCATION_REQUIRES_RECONCILIATION', status: 409 });
    await expect(f.invoke(runtime)).rejects.toMatchObject({ code: 'INVOCATION_REQUIRES_RECONCILIATION', status: 409 });
    expect(f.agent.publishFromFinalizedAssertion).toHaveBeenCalledOnce();
    expect(f.created()[0][1].memoryLayer).toBe('SWM');
    expect(runtime.store.execution(`urn:sr:execution:${id}`)?.status).toBe('active');
  });

  it('rechecks revocation between lifecycle stages', async () => {
    const f = fixture('swm');
    const write = f.agent.assertion.write.getMockImplementation()!;
    f.agent.assertion.write.mockImplementationOnce(async (...args) => { await write(...args); f.binding.enabled = false; });
    await expect(f.invoke(await f.start())).rejects.toThrow();
    expect(f.agent.assertion.finalize).not.toHaveBeenCalled();
    expect(f.agent.assertion.promote).not.toHaveBeenCalled();
  });
});

describe('asset input boundary', () => {
  const adapter = () => createAssetCreationAdapter({} as any, graph, 'wm', executor, undefined, async () => undefined);
  it.each(['contextGraphId', 'layer', 'agentAddress', 'name', 'alsoPublishVm'])('rejects destination override %s', (field) => {
    expect(() => adapter().validateInput({ quads, [field]: 'other' })).toThrow('INVALID_ASSET_CONTENT');
  });
  it('accepts only bounded triples and normalizes equivalent RDF literals', () => {
    const a = adapter();
    for (const value of [null, { quads: [] }, { quads: Array(257).fill(quads[0]) },
      { quads: [{ ...quads[0], graph: 'urn:other' }] },
      { quads: [{ ...quads[0], subject: '_:blank' }] },
      { quads: [{ ...quads[0], object: '"bad" . <urn:x> <urn:y> <urn:z>' }] },
      { quads: [{ ...quads[0], object: 'x'.repeat(16_385) }] }]) {
      expect(() => a.validateInput(value)).toThrow();
    }
    expect(a.validateInput({ quads: [quads[1], { ...quads[1], object: '"inspection-requested"^^<http://www.w3.org/2001/XMLSchema#string>' }] }).quads).toEqual([quads[1]]);
  });
});
