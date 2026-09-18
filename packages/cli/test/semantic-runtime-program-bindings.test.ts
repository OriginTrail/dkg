import { createHash } from 'node:crypto';

import { DKGAgent } from '@origintrail-official/dkg-agent';
import { decodeQueryCatalogBindings } from '@origintrail-official/dkg-core/query-catalog';
import { RuntimeAdapterRegistry, SemanticRuntimeStore, type SemanticProgramBinding, type SemanticRuntimeConfig } from '@origintrail-official/dkg-semantic-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

import { invokeBoundSemanticProgram, resolveStoredSemanticProgram, startConfiguredSemanticRuntime, validateSemanticRuntimeConfig } from '../src/semantic-runtime.js';
import { programBindingDigest } from '../src/semantic-runtime-program-bindings.js';
import { createSemanticQueryPin } from '../src/semantic-runtime-query-pins.js';
import { invokeBoundSemanticProgramOnPeer, registerSemanticRuntimeInboxSkill } from '../src/semantic-runtime-inbox.js';

const caller = '0x2222222222222222222222222222222222222222';
const executor = '0x1111111111111111111111111111111111111111';
const author = '0x3333333333333333333333333333333333333333';
const otherCaller = '0x4444444444444444444444444444444444444444';
const dataGraph = 'dmaast-kamstrup';
const sourceGraph = 'tracelabs-programs';
const operation = 'urn:dmaast:operation:read-w10';
const programIri = 'urn:tracelabs:program:read-w10:1';
const tool = 'urn:sr:tool:query';
const SR = 'https://origintrail.io/semantic-runtime/v1#';
const source = `(strategy dmaast/read-w10
  (version "1.0.0") (scope graph:dmaast-kamstrup) (goal read-device)
  (supervise one-for-one (max-restarts 1) (window-ms 60000)
    (delegate reader (grant dkg.query) (call dkg/query@1 "read-w10"))))`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const invocationId = '123e4567-e89b-42d3-a456-426614174099';
const runtimes: NonNullable<Awaited<ReturnType<typeof startConfiguredSemanticRuntime>>>[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  vi.restoreAllMocks();
});

function fixture(layer: 'wm' | 'swm' | 'vm' = 'swm') {
  const programAuthor = layer === 'wm' ? executor : author;
  const catalogRows = [{
    q: 'urn:dkg:profile:dmaast-kamstrup:query:read-w10', name: 'Read W10',
    scopeGraph: `did:dkg:context-graph:${dataGraph}/equipment`,
    catalog: 'urn:dkg:profile:dmaast-kamstrup:catalog:devices', catalogName: 'Devices',
    sparql: 'SELECT ?device ?temperature WHERE { VALUES ?device { <urn:kamstrup:device:W10> } ?device <urn:temperature> ?temperature }',
    executionView: 'verifiable-memory',
  }];
  const binding: SemanticProgramBinding = {
    operationIri: operation, contextGraphId: dataGraph, enabled: true,
    allowedCallerAgentAddresses: [caller, otherCaller], executorAgentAddress: executor,
    program: { contextGraphId: sourceGraph, programIri, programLayer: layer, authorAgentAddress: programAuthor, sourceHash: hash(source) },
    query: createSemanticQueryPin('read-w10', decodeQueryCatalogBindings(catalogRows, { contextGraphId: dataGraph })[0], {
      type: 'object', additionalProperties: false, required: ['bindings'], properties: {
        bindings: { type: 'array', maxItems: 1, items: {
          type: 'object', additionalProperties: false, required: ['device', 'temperature'], properties: {
            device: { type: 'string', maxLength: 128, enum: ['urn:kamstrup:device:W10'] },
            temperature: { type: 'string', maxLength: 32 },
          },
        } },
      },
    }),
  };
  const config: SemanticRuntimeConfig = {
    enabled: true, watchdogMs: 1_000, startupTimeoutMs: 30_000,
    programBindings: [binding],
  };
  const sourceDirectory = { wm: '_working_memory', swm: '_shared_memory', vm: '_verifiable_memory' }[layer];
  const sourceMemory = `did:dkg:context-graph:${sourceGraph}/${sourceDirectory}/${programAuthor}/7`;
  const dataVm = `did:dkg:context-graph:${dataGraph}/_verifiable_memory/${executor}/7`;
  const written: Array<{ subject: string; predicate: string; object: string }> = [];
  const histories = new Set<string>();
  const state = { source, author: programAuthor, tools: [tool] as Array<string | undefined>, visible: true, child: undefined as string | undefined };
  const readData = vi.fn(async (): Promise<{ bindings: Array<Record<string, string>> }> => ({
    bindings: [{ device: 'urn:kamstrup:device:W10', temperature: '21.5' }],
  }));
  const canReadContextGraph = vi.fn(async (_graph: string, opts: { callerAgentAddress?: string }) => opts.callerAgentAddress === executor);
  const agent = {
    log: { info: vi.fn() },
    listLocalAgents: () => [{ agentAddress: executor }],
    getCustodialAgentPrivateKey: () => '0x01',
    canReadContextGraph,
    // Current canary queries preserve denied/unavailable as separate outcomes.
    resolveContextGraphReadAuthority: vi.fn(async (graph: string, opts: { callerAgentAddress?: string }) => ({
      outcome: await canReadContextGraph(graph, opts) ? 'allowed' : 'denied',
    })),
    canUseSharedMemoryForContextGraph: vi.fn(async () => true),
    store: { query: vi.fn(async () => ({ type: 'bindings', bindings: [] })) },
    query: vi.fn(async (sparql: string, opts: Record<string, unknown>) => {
      if (opts.callerAgentAddress !== executor) {
        // Real DKG raw-query authorization path, with the same membership decision.
        return DKGAgent.prototype.query.call(agent as any, sparql, opts);
      }
      if (opts.source === 'semantic-runtime-query-catalog') return { bindings: opts.view === 'verifiable-memory' ? catalogRows : [] };
      if (opts.source === 'semantic-runtime-dkg-query') return readData();
      if (opts.source === 'semantic-runtime-execution-output-load') return { bindings: written
        .filter((quad) => [SR + 'output', SR + 'orderedOutputs'].includes(quad.predicate))
        .map((quad) => ({ g: dataVm.replace('_verifiable_memory', '_working_memory'),
          ...(quad.predicate === SR + 'output' ? { output: quad.object } : { orderedOutputs: quad.object }),
        })) };
      if (sparql.includes('?language')) return { bindings: state.visible ? state.tools.map((declaredTool) => ({
        g: sourceMemory.replace(programAuthor, state.author), language: '"sexpr-v1"', version: '"1.0.0"',
        source: JSON.stringify(state.source), ...(declaredTool ? { tool: `<${declaredTool}>` } : {}),
        ...(state.child ? { permittedProgram: `<${state.child}>` } : {}),
      })) : [] };
      // No VM execution policy or tool offers exist in this fixture.
      return { bindings: [] };
    }),
    assertion: {
      history: vi.fn(async (_graph: string, name: string) => histories.has(name)
        ? { wmCurrentAssertion: '11'.repeat(32), memoryLayer: 'WM', state: 'finalized' } : null),
      create: vi.fn(async () => 'urn:test:execution'),
      write: vi.fn(async (_graph: string, _name: string, quads: typeof written) => { written.push(...quads); }),
      finalize: vi.fn(async (_graph: string, name: string) => { histories.add(name); }),
    },
  };
  const start = async () => {
    const runtime = await startConfiguredSemanticRuntime(config, { log: vi.fn(), openStore: () => new SemanticRuntimeStore(':memory:') });
    runtimes.push(runtime!);
    return runtime!;
  };
  const invoke = async (runtime: Awaited<ReturnType<typeof start>>, identity: string | undefined = caller, graph = dataGraph, iri = operation, id = invocationId) =>
    invokeBoundSemanticProgram(agent as any, runtime, graph, iri, id, config, identity);
  return { agent, binding, config, state, catalogRows, written, readData, start, invoke };
}

describe('tenant Program bindings', () => {
  it('executes a wallet-signed inbox operation with real Wasm, retries once and enforces tenant revocation', async () => {
    const f = fixture();
    const privateKey = `0x${'01'.padStart(64, '0')}`;
    const signer = new ethers.Wallet(privateKey).address;
    f.binding.allowedCallerAgentAddresses = [signer];
    const runtime = await f.start();
    let handler: (request: any, peer: string) => Promise<any>;
    const tenant = Object.assign(f.agent, {
      peerId: 'peer-kamstrup',
      registerSkill: (_skill: string, fn: typeof handler) => { handler = fn; },
    });
    registerSemanticRuntimeInboxSkill(tenant as any, runtime, f.config, undefined);
    const transportReplies = new Map<string, any>();
    const sender = {
      peerId: 'peer-idener',
      resolveLocalAgentAddress: (address: string) => address,
      getCustodialAgentPrivateKey: () => privateKey,
      invokeSkill: vi.fn(async (_peer: string, _skill: string, data: Uint8Array, options: { messageId: string }) => {
        // Model the transport cache: duplicate deliveries skip the inbox handler.
        if (transportReplies.has(options.messageId)) return transportReplies.get(options.messageId);
        const response = await handler({ inputData: data }, 'peer-idener');
        transportReplies.set(options.messageId, response);
        return response;
      }),
    };
    const routes = { enabled: true, programRoutes: [{ contextGraphId: dataGraph, operationIri: operation, targetPeerId: tenant.peerId }] };
    const invoke = () => invokeBoundSemanticProgramOnPeer(sender as any, routes, dataGraph, operation, invocationId, signer);
    const result = await invoke();
    expect(result).toMatchObject({ persisted: true, executionLayer: 'wm' });
    expect(JSON.parse(result.outputs![0]).result.bindings).toEqual([{ device: 'urn:kamstrup:device:W10', temperature: '21.5' }]);
    expect(f.written).toEqual(expect.arrayContaining([
      expect.objectContaining({ predicate: SR + 'invokedBy', object: `did:dkg:agent:${signer}` }),
      expect.objectContaining({ predicate: SR + 'executedBy', object: `did:dkg:agent:${executor}` }),
    ]));
    await expect(invoke()).resolves.toEqual(result);
    expect(f.readData).toHaveBeenCalledOnce();
    // Signing and invocation do not enroll IDENER in the data graph.
    await expect(f.agent.query(f.catalogRows[0].sparql, { contextGraphId: dataGraph, callerAgentAddress: signer })).resolves.toMatchObject({ bindings: [] });
    f.binding.allowedCallerAgentAddresses = [];
    await expect(invoke()).rejects.toMatchObject({ code: 'PROGRAM_INVOCATION_FORBIDDEN', status: 403 });
    expect(f.readData).toHaveBeenCalledOnce();
  });

  it('runs a real Wasm query from a separate author graph, preserves raw ACLs and replays only to its caller', async () => {
    const f = fixture();
    const runtime = await f.start();
    const result = await f.invoke(runtime);
    expect(result).toMatchObject({ persisted: true, executionLayer: 'wm' });
    expect(JSON.parse(result.outputs![0]).result.bindings).toEqual([{ device: 'urn:kamstrup:device:W10', temperature: '21.5' }]);
    expect(f.agent.query).toHaveBeenCalledWith(expect.stringContaining('?language'), expect.objectContaining({ contextGraphId: sourceGraph, callerAgentAddress: executor }));
    expect(f.agent.query).toHaveBeenCalledWith(f.catalogRows[0].sparql, expect.objectContaining({ contextGraphId: dataGraph, subGraphName: 'equipment', callerAgentAddress: executor }));
    expect(f.agent.assertion.write).toHaveBeenCalledWith(dataGraph, expect.any(String), expect.any(Array), { agentAddress: executor });
    expect(f.written).toEqual(expect.arrayContaining([
      expect.objectContaining({ predicate: SR + 'usedProgram', object: programIri }),
      expect.objectContaining({ predicate: SR + 'invokedBy', object: `did:dkg:agent:${caller}` }),
      expect.objectContaining({ predicate: SR + 'executedBy', object: `did:dkg:agent:${executor}` }),
      expect.objectContaining({ predicate: SR + 'operation', object: operation }),
      expect.objectContaining({ predicate: SR + 'appliedPolicy', object: `urn:dkg:program-binding:${programBindingDigest(f.binding)}` }),
      expect.objectContaining({ predicate: SR + 'policyHash', object: expect.stringMatching(/^"sha256:[0-9a-f]{64}"$/) }),
    ]));
    await expect(f.agent.query(f.catalogRows[0].sparql, { contextGraphId: dataGraph, callerAgentAddress: caller })).resolves.toMatchObject({ bindings: [] });
    await expect(f.invoke(runtime)).resolves.toEqual(result);
    expect(f.readData).toHaveBeenCalledOnce();
    expect(f.agent.query.mock.calls.some(([, opts]) =>
      ['semantic-runtime-policy-load', 'semantic-runtime-tool-offers'].includes(String(opts.source)))).toBe(false);
    await expect(f.invoke(runtime, otherCaller)).rejects.toMatchObject({ code: 'INVOCATION_LAYER_CONFLICT' });
    f.binding.enabled = false;
    await expect(f.invoke(runtime)).rejects.toMatchObject({ code: 'PROGRAM_INVOCATION_FORBIDDEN' });
    expect(f.readData).toHaveBeenCalledOnce();
  });

  it.each(['wm', 'swm', 'vm'] as const)('executes readable %s source even when the configured direct VM policy is unpublished', async (layer) => {
    const f = fixture(layer);
    // A stale or unrelated direct-execution policy must not become a dependency.
    f.config.operatorPolicyIri = 'urn:policy:unpublished-direct-policy';
    const runtime = await f.start();
    await expect(f.invoke(runtime)).resolves.toMatchObject({ persisted: true });
    expect(f.agent.query.mock.calls.some(([, opts]) =>
      ['semantic-runtime-policy-load', 'semantic-runtime-tool-offers'].includes(String(opts.source)))).toBe(false);
    expect(f.readData).toHaveBeenCalledOnce();
  });

  it.each([false, true])('still requires trusted VM policy for direct resolution (configured: %s)', async (configured) => {
    const f = fixture();
    if (configured) f.config.operatorPolicyIri = 'urn:policy:unpublished';
    await expect(resolveStoredSemanticProgram(f.agent as any, sourceGraph, programIri, 'swm', f.config, undefined, executor))
      .rejects.toMatchObject({ code: configured ? 'OPERATOR_POLICY_UNTRUSTED' : 'OPERATOR_POLICY_NOT_CONFIGURED' });
    expect(f.readData).not.toHaveBeenCalled();
  });

  it.each([[undefined], [tool, 'urn:tool:unapproved']])('rejects missing or multiple tool declarations: %j', async (...tools) => {
    const f = fixture();
    f.state.tools = tools;
    const runtime = await f.start();
    await expect(f.invoke(runtime)).rejects.toMatchObject({ code: 'PROGRAM_BINDING_TOOL_FORBIDDEN' });
    expect(f.readData).not.toHaveBeenCalled();
  });

  it.each(['missing', 'disabled'])('retains the %s local adapter check', async (change) => {
    const f = fixture();
    const runtime = await f.start();
    const describeAdapter = RuntimeAdapterRegistry.prototype.describe;
    vi.spyOn(RuntimeAdapterRegistry.prototype, 'describe').mockImplementation(function (operation, version) {
      const adapter = describeAdapter.call(this, operation, version);
      return change === 'missing' || !adapter ? null : { ...adapter, enabled: false };
    });
    await expect(f.invoke(runtime)).rejects.toMatchObject({ code: 'REQUIRED_TOOL_UNAVAILABLE' });
    expect(f.readData).not.toHaveBeenCalled();
  });

  it('reports SWM graph authority unavailability only after binding authorization', async () => {
    const f = fixture('swm');
    const runtime = await f.start();
    f.agent.canUseSharedMemoryForContextGraph.mockResolvedValue(false);
    await expect(f.invoke(runtime, author)).rejects.toMatchObject({ code: 'PROGRAM_INVOCATION_FORBIDDEN', status: 403 });
    expect(f.agent.canUseSharedMemoryForContextGraph).not.toHaveBeenCalled();
    await expect(f.invoke(runtime)).rejects.toMatchObject({ code: 'PROGRAM_GRAPH_AUTHORITY_UNAVAILABLE', status: 503 });
    expect(f.agent.canUseSharedMemoryForContextGraph).toHaveBeenCalledWith(sourceGraph, { callerAgentAddress: executor });
    expect(f.agent.query).not.toHaveBeenCalled();
    expect(f.readData).not.toHaveBeenCalled();
    expect(f.written).toHaveLength(0);
  });

  it('does not bypass a source graph read denial', async () => {
    const f = fixture();
    f.state.visible = false;
    const runtime = await f.start();
    await expect(f.invoke(runtime)).rejects.toMatchObject({ code: 'PROGRAM_NOT_FOUND' });
    expect(f.readData).not.toHaveBeenCalled();
  });

  it('rejects replay after a tool declaration changes even when the source and binding are unchanged', async () => {
    const f = fixture();
    const runtime = await f.start();
    await f.invoke(runtime);
    f.state.tools = ['urn:tool:renamed-query'];
    await expect(f.invoke(runtime)).rejects.toMatchObject({ code: 'INVOCATION_LAYER_CONFLICT' });
    expect(f.readData).toHaveBeenCalledOnce();
  });

  it('keeps tenant query-only grants independent of the optional local Program policy', async () => {
    const f = fixture();
    f.config.programPolicy = {
      contextGraphIds: ['separate-llm-graph'],
      programs: [{ programIri: 'urn:program:other', sourceHash: 'a'.repeat(64) }],
    };
    const runtime = await f.start();
    await expect(f.invoke(runtime)).resolves.toMatchObject({ persisted: true, executionLayer: 'wm' });
    expect(f.readData).toHaveBeenCalledOnce();
  });

  it.each(['caller', 'anonymous', 'tenant', 'operation', 'disabled', 'removed grant', 'executor membership'])('denies %s before reading data', async (change) => {
    const f = fixture();
    if (change === 'disabled') f.binding.enabled = false;
    if (change === 'removed grant') f.binding.allowedCallerAgentAddresses = [];
    if (change === 'executor membership') f.agent.canReadContextGraph.mockResolvedValue(false);
    await expect(invokeBoundSemanticProgram(f.agent as any, {} as any,
      change === 'tenant' ? 'dmaast-jpb' : dataGraph, change === 'operation' ? 'urn:unknown' : operation,
      invocationId, f.config, change === 'anonymous' ? undefined : change === 'caller' ? author : caller,
    )).rejects.toMatchObject({ code: 'PROGRAM_INVOCATION_FORBIDDEN' });
    expect(f.agent.query).not.toHaveBeenCalled();
  });

  it.each(['source', 'author', 'child', 'tool', 'selector', 'query definition', 'output'])('fails closed on changed %s', async (change) => {
    const f = fixture();
    const runtime = await f.start();
    if (change === 'source') f.state.source += '\n; changed';
    if (change === 'author') f.state.author = caller;
    if (change === 'child') f.state.child = 'urn:program:unapproved-child';
    if (change === 'tool') f.state.source = source.replace('(grant dkg.query) (call dkg/query@1 "read-w10")', '(grant llm.invoke.safe) (call llm/safe@1 "exfiltrate")');
    if (change === 'selector') f.state.source = source.replace('"read-w10"', '"unapproved-query"');
    if (['tool', 'selector'].includes(change)) f.binding.program.sourceHash = hash(f.state.source);
    if (change === 'query definition') f.catalogRows[0].sparql = 'SELECT ?secret WHERE { ?s <urn:salary> ?secret }';
    if (change === 'output') f.readData.mockResolvedValue({ bindings: [{ device: 'urn:kamstrup:device:W10', temperature: '21.5', secret: 'private' }] });
    await expect(f.invoke(runtime)).rejects.toThrow();
    if (change !== 'output') expect(f.readData).not.toHaveBeenCalled();
    expect(f.written).toHaveLength(0);
  });

  it('rechecks a revoked grant after a query is dispatched and releases no result', async () => {
    const f = fixture();
    const runtime = await f.start();
    f.readData.mockImplementation(async () => {
      f.binding.enabled = false;
      return { bindings: [{ device: 'urn:kamstrup:device:W10', temperature: '21.5' }] };
    });
    await expect(f.invoke(runtime)).rejects.toThrow();
    expect(f.readData).toHaveBeenCalledOnce();
    expect(f.written).toHaveLength(0);
  });

  it('joins an identical in-flight request but rejects another caller using the same UUID', async () => {
    const f = fixture();
    const runtime = await f.start();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    f.readData.mockImplementation(async () => {
      entered();
      await blocked;
      return { bindings: [{ device: 'urn:kamstrup:device:W10', temperature: '21.5' }] };
    });
    const first = f.invoke(runtime);
    await started;
    const retry = f.invoke(runtime);
    try {
      await expect(f.invoke(runtime, otherCaller)).rejects.toMatchObject({ code: 'INVOCATION_LAYER_CONFLICT' });
    } finally {
      release();
    }
    expect(await retry).toEqual(await first);
    expect(f.readData).toHaveBeenCalledOnce();
  });

  it('withholds a persisted result if the tenant revokes the grant during persistence', async () => {
    const f = fixture();
    const runtime = await f.start();
    const finalize = f.agent.assertion.finalize.getMockImplementation()!;
    f.agent.assertion.finalize.mockImplementation(async (graph, name) => {
      await finalize(graph, name);
      f.binding.enabled = false;
    });
    await expect(f.invoke(runtime)).rejects.toMatchObject({ code: 'PROGRAM_INVOCATION_FORBIDDEN' });
    expect(f.written.length).toBeGreaterThan(0);
    await expect(f.invoke(runtime)).rejects.toMatchObject({ code: 'PROGRAM_INVOCATION_FORBIDDEN' });
    expect(f.readData).toHaveBeenCalledOnce();
  });

  it('requires a new invocation ID after a version activation and rejects replay against changed catalog data', async () => {
    const f = fixture();
    const runtime = await f.start();
    await f.invoke(runtime);
    f.catalogRows[0].sparql += ' LIMIT 1';
    await expect(f.invoke(runtime)).rejects.toThrow();
    f.catalogRows[0].sparql = f.catalogRows[0].sparql.replace(' LIMIT 1', '');
    f.state.source += '\n; approved update';
    f.binding.program.sourceHash = hash(f.state.source);
    await expect(f.invoke(runtime)).rejects.toMatchObject({ code: 'INVOCATION_LAYER_CONFLICT' });
    expect(f.readData).toHaveBeenCalledOnce();
  });

  it.each(['duplicate', 'hash', 'graph', 'address', 'schema', 'unknown field'])('rejects invalid binding configuration: %s', (change) => {
    const f = fixture();
    if (change === 'duplicate') f.config.programBindings!.push(structuredClone(f.binding));
    if (change === 'hash') f.binding.program.sourceHash = 'latest';
    if (change === 'graph') f.binding.contextGraphId = '../private';
    if (change === 'address') f.binding.executorAgentAddress = 'anyone';
    if (change === 'schema') f.binding.query.outputSchemaSha256 = '0'.repeat(64);
    if (change === 'unknown field') Object.assign(f.binding, { allowAll: true });
    expect(() => validateSemanticRuntimeConfig(f.config)).toThrow();
  });
});
