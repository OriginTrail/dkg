import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DKGAgent } from '@origintrail-official/dkg-agent';
import { DKGQueryEngine } from '@origintrail-official/dkg-query';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { SemanticRuntimeStore, type SemanticRuntimeConfig } from '@origintrail-official/dkg-semantic-runtime';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRequestActor } from '../src/daemon/routes/context.js';
import { handleQueryRoutes } from '../src/daemon/routes/query.js';
import { handleSemanticRuntimeRoutes } from '../src/daemon/routes/semantic-runtime.js';
import { registerSemanticRuntimeInboxSkill } from '../src/semantic-runtime-inbox.js';
import { startConfiguredSemanticRuntime, type ConfiguredSemanticRuntimeService } from '../src/semantic-runtime.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const owner = '0x1111111111111111111111111111111111111111';
const executor = '0x2222222222222222222222222222222222222222';
const author = '0x3333333333333333333333333333333333333333';
const member = '0x4444444444444444444444444444444444444444';
const callerKey = '0x' + '01'.padStart(64, '0');
const caller = new ethers.Wallet(callerKey).address;
const graph = 'tenant-data';
const sourceGraph = 'program-library';
const operation = 'urn:example:operation:read-device';
const programIri = 'urn:example:program:read-device:1';
const tool = 'urn:example:tool:sparql-read';
const SR = 'https://origintrail.io/semantic-runtime/v1#';
const source = `(strategy example/read-device (version "1.0.0") (scope graph:tenant-data) (goal read-device)
  (supervise one-for-one (max-restarts 1) (window-ms 60000)
    (delegate reader (grant dkg.sparql.read) (call dkg/sparql-read@1 "SELECT ?value WHERE { <urn:example:device:1> <urn:example:value> ?value } LIMIT 5"))))`;
const bindingInput = () => ({
  contextGraphId: `did:dkg:context-graph:${graph}`, operationIri: operation,
  executorAgentAddress: executor, allowedCallerAgentAddresses: [caller],
  program: { contextGraphId: `did:dkg:context-graph:${sourceGraph}`, programIri, programLayer: 'swm' },
  sparqlRead: { toolIri: tool, layer: 'wm', timeoutMs: 5000, maxResultItems: 5, maxOutputBytes: 4096,
    outputSchema: { type: 'object', additionalProperties: false, required: ['bindings'], properties: {
      bindings: { type: 'array', maxItems: 5, items: { type: 'object', additionalProperties: false,
        required: ['value'], properties: { value: { type: 'string', maxLength: 128 } } } },
    } } },
});
const runtimes = new Set<ConfiguredSemanticRuntimeService>();
const dirs: string[] = [];
afterEach(async () => { for (const runtime of runtimes) await runtime.stop(); runtimes.clear(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
type Identity = 'owner' | 'operator' | 'member' | 'caller' | 'anonymous' | 'disabled-anonymous';
type Node = { agent: any; config: { semanticRuntime: SemanticRuntimeConfig }; runtime: ConfiguredSemanticRuntimeService | null; dir: string; boot(activate?: boolean): Promise<ConfiguredSemanticRuntimeService | null> };

function node(agent: any, configured: SemanticRuntimeConfig = {}): Node {
  const dir = mkdtempSync(join(tmpdir(), 'program-api-')); dirs.push(dir);
  const n: Node = { agent, dir, config: { semanticRuntime: { watchdogMs: 1000, startupTimeoutMs: 30_000, ...configured } }, runtime: null,
    async boot(activate = false) {
      if (n.runtime) return n.runtime;
      n.runtime = await startConfiguredSemanticRuntime(n.config.semanticRuntime, { dataDirectory: dir, log: vi.fn(), activate });
      if (n.runtime) { runtimes.add(n.runtime); registerSemanticRuntimeInboxSkill(agent, n.runtime, n.config.semanticRuntime, undefined); }
      return n.runtime;
    } };
  return n;
}
async function request(n: Node, identity: Identity, method: string, path: string, body?: unknown) {
  const auth = identity === 'anonymous' || identity === 'disabled-anonymous'
    ? requestAuthentication({ kind: 'anonymous', mode: identity === 'anonymous' ? 'public' : 'disabled' })
    : identity === 'operator' ? requestAuthentication({ kind: 'nodeOperator' })
      : requestAuthentication({ kind: 'agent', agentAddress: { owner, member, caller }[identity] });
  const url = new URL(path, 'http://local.test');
  const req = Object.assign(new EventEmitter(), { method, aborted: false, __dkgPrebufferedBody: Buffer.from(JSON.stringify(body ?? {})) });
  const res: any = new EventEmitter();
  res.writeHead = (status: number) => { res.statusCode = status; return res; };
  res.end = (data: string) => { res.body = JSON.parse(data); res.writableEnded = true; };
  const handler = url.pathname === '/api/query' ? handleQueryRoutes : handleSemanticRuntimeRoutes;
  await handler({ req, res, path: url.pathname, url, agent: n.agent, config: n.config,
    actor: createRequestActor(auth, () => owner), authentication: auth, requestAgentAddress: owner,
    tracker: { start: vi.fn(), startPhase: vi.fn(), completePhase: vi.fn(), complete: vi.fn(), fail: vi.fn(), cancel: vi.fn() },
    semanticRuntimeHost: n.runtime, ensureSemanticRuntime: () => n.boot(true),
  } as any);
  return { status: res.statusCode as number, body: res.body as any };
}
const inspect = `/api/programs/bindings?contextGraphId=${graph}&operationIri=${encodeURIComponent(operation)}`;
const remove = (revision: number) => ({ contextGraphId: graph, operationIri: operation, expectedRevision: revision });

async function fixture() {
  const store = new OxigraphStore(); const engine = new DKGQueryEngine(store);
  const content = new Map<string, Quad[]>();
  const sealed = new Set<string>();
  let uploaded: Quad[] = [];
  let inbox!: (request: any, peer: string) => Promise<any>;
  const allowed = (address?: string) => [owner, executor, author, member].includes(address ?? '');
  const agent: any = {
    peerId: 'peer-runner', log: { info: vi.fn() }, store,
    registerSkill: (_skill: string, handler: typeof inbox) => { inbox = handler; },
    listLocalAgents: () => [{ agentAddress: executor }], getCustodialAgentPrivateKey: (address: string) => address === executor ? callerKey : undefined,
    assertContextGraphOwner: vi.fn(async (cg: string, identity: string) => { if (cg !== graph || identity !== owner) throw new Error('not owner'); }),
    canReadContextGraph: vi.fn(async (_cg: string, opts: any) => allowed(opts.callerAgentAddress)),
    resolveContextGraphReadAuthority: vi.fn(async (_cg: string, opts: any) => ({ outcome: allowed(opts.callerAgentAddress) ? 'allowed' : 'denied' })),
    canUseSharedMemoryForContextGraph: vi.fn(async () => true),
    probeContextGraphWritePreflight: vi.fn(async () => ({ storeAvailable: true, exists: true, hasLocalContent: true, callerAuthorized: true })),
    query: vi.fn(async (query: string, opts: any) => allowed(opts.callerAgentAddress)
      ? engine.query(query, opts) : DKGAgent.prototype.query.call(agent, query, opts)),
    assertion: {
      history: vi.fn(async (_cg: string, name: string) => sealed.has(name) ? { wmCurrentAssertion: 'aa'.repeat(32), memoryLayer: 'WM' } : null),
      create: vi.fn(async (_cg: string, name: string) => { content.set(name, []); return 'urn:example:asset:' + name; }),
      write: vi.fn(async (cg: string, name: string, quads: Quad[]) => {
        const at = `did:dkg:context-graph:${cg}/_working_memory/${executor}/${content.size + 10}`;
        const entries = quads.map((q) => ({ ...q, graph: at })); content.get(name)!.push(...entries); await store.insert(entries);
      }),
      finalize: vi.fn(async (_cg: string, name: string) => { sealed.add(name); }),
      query: vi.fn(async (_cg: string, name: string) => content.get(name) ?? []),
    },
  };
  const target = node(agent);
  const senderAgent: any = {
    peerId: 'peer-client', registerSkill: vi.fn(), resolveLocalAgentAddress: (address: string) => address,
    getCustodialAgentPrivateKey: (address: string) => address === caller ? callerKey : undefined,
    invokeSkill: vi.fn(async (peer: string, _skill: string, data: Uint8Array) => {
      if (peer !== agent.peerId) throw new Error('wrong peer');
      return inbox({ inputData: data }, 'peer-client');
    }),
  };
  const client = node(senderAgent);
  const upload = async (text = source, tools = [tool]) => {
    if (uploaded.length) await store.delete(uploaded);
    const g = `did:dkg:context-graph:${sourceGraph}/_shared_memory/${author}/1`;
    uploaded = [
      { predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: SR + 'Program' },
      { predicate: SR + 'language', object: '"sexpr-v1"' }, { predicate: SR + 'version', object: '"1.0.0"' },
      { predicate: SR + 'source', object: JSON.stringify(text) }, ...tools.map((iri) => ({ predicate: SR + 'requiresTool', object: iri })),
    ].map((q) => ({ ...q, subject: programIri, graph: g }));
    await store.insert(uploaded);
  };
  await store.insert([{ subject: 'urn:example:device:1', predicate: 'urn:example:value', object: '"42"',
    graph: `did:dkg:context-graph:${graph}/_working_memory/${executor}/1` }]);
  await upload();
  const activate = () => request(target, 'owner', 'POST', '/api/programs/bindings', { binding: bindingInput() });
  const route = () => request(client, 'operator', 'POST', '/api/programs/routes', { route: { contextGraphId: graph, operationIri: operation, targetPeerId: agent.peerId } });
  const invoke = (id = randomUUID()) => request(client, 'caller', 'POST', '/api/programs/execute', { contextGraphId: graph, operationIri: operation, invocationId: id });
  return { target, client, agent, senderAgent, store, upload, activate, route, invoke };
}

describe('durable Program management API', () => {
  it.each(['member', 'caller', 'anonymous', 'disabled-anonymous'] as const)('denies %s binding changes without starting a runtime or reading Program data', async (identity) => {
    const f = await fixture();
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const body = method === 'DELETE' ? remove(0) : { binding: bindingInput(), ...(method === 'PUT' ? { expectedRevision: 0 } : {}) };
      expect((await request(f.target, identity, method, method === 'GET' ? inspect : '/api/programs/bindings', body)).status).toBe(403);
    }
    expect(f.target.runtime).toBeNull(); expect(f.agent.query).not.toHaveBeenCalled();
  });
  it.each(['owner', 'member', 'caller', 'anonymous', 'disabled-anonymous'] as const)('requires the calling node operator for route changes, including %s', async (identity) => {
    const f = await fixture();
    expect((await request(f.client, identity, 'POST', '/api/programs/routes', { route: { contextGraphId: graph, operationIri: operation, targetPeerId: 'peer-runner' } })).status).toBe(403);
    expect(f.client.runtime).toBeNull();
  });
  it('resolves the separate source Program, computes canonical pins, and activates without executing', async () => {
    const f = await fixture(); const approved = await f.activate();
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({ origin: 'api', revision: 1, contextGraphId: graph, bindingDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      binding: { contextGraphId: graph, allowedCallerAgentAddresses: [caller], authorizationRevision: 1,
        program: { contextGraphId: sourceGraph, authorAgentAddress: author, sourceHash: createHash('sha256').update(source).digest('hex') },
        sparqlRead: { outputSchemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } }, resolution: { executable: true } });
    expect(approved.body.resolution.selectedPolicy.iri).toBe(`urn:dkg:program-binding:${approved.body.bindingDigest}`);
    expect(f.agent.assertion.create).not.toHaveBeenCalled();
    expect(f.agent.query.mock.calls.some(([, opts]: any[]) => opts.source === 'semantic-runtime-sparql-read')).toBe(false);
    expect((await request(f.target, 'owner', 'GET', inspect)).body.binding).toEqual(approved.body.binding);
    expect((await request(f.target, 'owner', 'GET', `/api/programs/bindings?contextGraphId=${graph}`)).body).toHaveLength(1);
    expect((await f.activate()).status).toBe(409);
  });
  it('keeps upload and routing separate from execution permission, then signs, executes, restarts, and revokes', async () => {
    const f = await fixture();
    await f.target.boot(true); // A runtime alone does not grant permission to the uploaded Program.
    expect((await f.route()).status).toBe(201);
    expect((await f.invoke()).status).toBe(403);
    expect((await f.activate()).status).toBe(201);
    const id = randomUUID(); const result = await f.invoke(id);
    expect(result.status).toBe(200); expect(result.body.persisted).toBe(true);
    expect(JSON.parse(result.body.outputs[0]).result.bindings).toEqual([{ value: '"42"' }]);
    const signed = JSON.parse(new TextDecoder().decode(f.senderAgent.invokeSkill.mock.calls[1][2]));
    expect(signed).toMatchObject({ version: 3, kind: 'bound-operation', authorization: { agentAddress: caller, delegateePeerId: 'peer-client' } });
    const creates = f.agent.assertion.create.mock.calls.length;
    for (const n of [f.target, f.client]) {
      await n.runtime!.stop(); runtimes.delete(n.runtime!); n.runtime = null;
      n.config.semanticRuntime = { watchdogMs: 1000, startupTimeoutMs: 30_000 };
      expect(await n.boot()).not.toBeNull();
    }
    const replay = await f.invoke(id); expect(replay).toEqual(result); expect(f.agent.assertion.create).toHaveBeenCalledTimes(creates);
    for (const view of ['working-memory', 'shared-working-memory', 'verifiable-memory']) {
      const raw = await request(f.target, 'caller', 'POST', '/api/query', {
        sparql: 'SELECT ?value WHERE { ?s ?p ?value }', contextGraphId: graph, view, agentAddress: executor,
      });
      expect(raw.status).toBe(200); expect(raw.body.result.bindings).toEqual([]);
      expect(f.agent.query).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ callerAgentAddress: caller }));
    }
    const revoked = await request(f.target, 'owner', 'DELETE', '/api/programs/bindings', remove(1));
    expect(revoked.status).toBe(200); expect(revoked.body).toMatchObject({ revision: 2, binding: { enabled: false } });
    expect((await f.invoke(id)).status).toBe(403); expect((await f.invoke()).status).toBe(403);
    await f.target.runtime!.stop(); runtimes.delete(f.target.runtime!); f.target.runtime = null;
    f.target.config.semanticRuntime = { watchdogMs: 1000, startupTimeoutMs: 30_000 }; await f.target.boot();
    expect((await f.invoke(id)).status).toBe(403); expect(f.agent.assertion.create).toHaveBeenCalledTimes(creates);
  });
  it('requires renewed source authorization and a new invocation UUID after a Program changes', async () => {
    const f = await fixture(); const approved = await f.activate(); await f.route();
    const id = randomUUID(); expect((await f.invoke(id)).status).toBe(200);
    await f.upload(source.replace('LIMIT 5', 'LIMIT 4'));
    expect((await f.invoke()).status).toBe(403); expect((await f.invoke(id)).status).toBe(403);
    const previous = structuredClone(approved.body.binding); delete previous.authorizationRevision;
    expect((await request(f.target, 'owner', 'PUT', '/api/programs/bindings', { binding: previous, expectedRevision: 1 })).status).toBe(409);
    delete previous.program.sourceHash;
    const renewed = await request(f.target, 'owner', 'PUT', '/api/programs/bindings', { binding: previous, expectedRevision: 1 });
    expect(renewed.status).toBe(200); expect(renewed.body.revision).toBe(2);
    expect((await f.invoke()).status).toBe(200); expect((await f.invoke(id)).status).toBe(409);
  });
  it('withholds the result when permission is revoked during a running query', async () => {
    const f = await fixture(); await f.activate(); await f.route();
    const query = f.agent.query.getMockImplementation()!;
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    f.agent.query.mockImplementation(async (sparql: string, opts: any) => {
      if (opts.source === 'semantic-runtime-sparql-read') { entered(); await barrier; }
      return query(sparql, opts);
    });
    const invocation = f.invoke();
    await waiting;
    try { expect((await request(f.target, 'owner', 'DELETE', '/api/programs/bindings', remove(1))).status).toBe(200); }
    finally { release(); }
    const result = await invocation;
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.outputs).toBeUndefined();
    expect(f.agent.assertion.create).not.toHaveBeenCalled();
  });
  it('keeps the effective permission unchanged if the durable commit fails', async () => {
    const f = await fixture(); const approved = await f.activate(); await f.route();
    const failure = vi.spyOn(f.target.runtime!.store, 'writeProgramConfiguration').mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    await expect(request(f.target, 'owner', 'DELETE', '/api/programs/bindings', remove(1))).rejects.toThrow('disk unavailable');
    failure.mockRestore();
    expect((await request(f.target, 'owner', 'GET', inspect)).body.binding).toEqual(approved.body.binding);
    expect(f.target.runtime!.store.programConfigurationRecords()[0].revision).toBe(1);
    expect((await f.invoke()).status).toBe(200);
  });
  it('checks the current graph owner and prevents a stale update from undoing revocation', async () => {
    const f = await fixture(); await f.activate();
    const query = f.agent.query.getMockImplementation()!;
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    f.agent.query.mockImplementationOnce(async (...args: any[]) => { entered(); await barrier; return query(...args); });
    const updating = request(f.target, 'owner', 'PUT', '/api/programs/bindings', { binding: bindingInput(), expectedRevision: 1 });
    await waiting;
    expect((await request(f.target, 'owner', 'DELETE', '/api/programs/bindings', remove(1))).status).toBe(200);
    release(); expect((await updating).status).toBe(409);
    expect((await request(f.target, 'owner', 'GET', inspect)).body.binding.enabled).toBe(false);
    f.agent.assertContextGraphOwner.mockRejectedValue(new Error('owner changed'));
    expect((await request(f.target, 'owner', 'PUT', '/api/programs/bindings', { binding: bindingInput(), expectedRevision: 2 })).status).toBe(403);
    expect((await request(f.target, 'operator', 'PUT', '/api/programs/bindings', { binding: bindingInput(), expectedRevision: 2 })).status).toBe(200);
  });
  it('removes a route durably and never grants permission through its replacement', async () => {
    const f = await fixture(); await f.route();
    const changed = await request(f.client, 'operator', 'PUT', '/api/programs/routes', { expectedRevision: 1,
      route: { contextGraphId: `did:dkg:context-graph:${graph}`, operationIri: operation, targetPeerId: 'peer-other' } });
    expect(changed.status).toBe(200); expect(changed.body.route.contextGraphId).toBe(graph);
    expect((await request(f.client, 'operator', 'DELETE', '/api/programs/routes', remove(2))).body).toMatchObject({ revision: 3, route: null });
    expect((await f.invoke()).status).toBe(403); expect(f.senderAgent.invokeSkill).not.toHaveBeenCalled();
    await f.client.runtime!.stop(); runtimes.delete(f.client.runtime!); f.client.runtime = null;
    f.client.config.semanticRuntime = { programRoutes: [{ contextGraphId: graph, operationIri: operation, targetPeerId: 'peer-runner' }] };
    await f.client.boot();
    expect(f.client.config.semanticRuntime.programRoutes).toEqual([]);
    expect((await request(f.client, 'operator', 'GET', inspect.replace('bindings', 'routes'))).body).toMatchObject({ revision: 3, route: null });
  });
  it('API revocation overrides file bindings after restart and revisions cannot be supplied by the request', async () => {
    const f = await fixture(); const approved = await f.activate();
    expect((await request(f.target, 'owner', 'PUT', '/api/programs/bindings', { expectedRevision: 1, binding: approved.body.binding })).status).toBe(400);
    await request(f.target, 'owner', 'DELETE', '/api/programs/bindings', remove(1));
    await f.target.runtime!.stop(); runtimes.delete(f.target.runtime!); f.target.runtime = null;
    f.target.config.semanticRuntime = { programBindings: [{ ...approved.body.binding, enabled: true }] };
    await f.target.boot();
    expect(f.target.config.semanticRuntime.programBindings![0].enabled).toBe(false);
    expect((await request(f.target, 'owner', 'DELETE', '/api/programs/bindings', remove(1))).status).toBe(409);
  });
  it.each(['hash', 'tool', 'executor', 'source-rights', 'uncompilable', 'asset-write-rights', 'raw-update', 'multiple-calls'] as const)('does not persist an invalid activation: %s', async (fault) => {
    const f = await fixture(); const input: any = bindingInput();
    if (fault === 'hash') input.program.sourceHash = '00'.repeat(32);
    if (fault === 'tool') input.sparqlRead.toolIri = 'urn:wrong:tool';
    if (fault === 'executor') input.executorAgentAddress = caller;
    if (fault === 'source-rights') f.agent.canReadContextGraph.mockImplementation(async (_cg: string, opts: any) => opts.callerAgentAddress === executor);
    if (fault === 'uncompilable') await f.upload('(invalid)');
    if (fault === 'raw-update') await f.upload(source.replace('SELECT ?value WHERE { <urn:example:device:1> <urn:example:value> ?value } LIMIT 5', 'DELETE WHERE { ?s ?p ?o }'));
    if (fault === 'multiple-calls') await f.upload(source.replace('(call dkg/sparql-read@1', '(sequence (call dkg/sparql-read@1 "ASK {}") (call dkg/sparql-read@1') + ')');
    if (fault === 'asset-write-rights') { input.assetCreation = { toolIri: 'urn:example:tool:asset-create' }; f.agent.probeContextGraphWritePreflight.mockResolvedValue({ storeAvailable: true, exists: true, callerAuthorized: false }); }
    const result = await request(f.target, 'owner', 'POST', '/api/programs/bindings', { binding: input });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(f.target.runtime!.store.programConfigurationRecords()).toEqual([]);
    expect(f.agent.assertion.create).not.toHaveBeenCalled();
  });
  it('computes named-query pins and rejects a selector not used by the approved Program', async () => {
    const f = await fixture();
    await f.upload(source.replace('dkg.sparql.read', 'dkg.query').replace(/\(call dkg\/sparql-read@1 "[^"]*"\)/, '(call dkg/query@1 "device-value")'), ['urn:example:tool:query']);
    const query = f.agent.query.getMockImplementation()!;
    f.agent.query.mockImplementation(async (sparql: string, opts: any) => opts.source === 'semantic-runtime-query-catalog'
      ? { bindings: opts.view === 'verifiable-memory' ? [{ q: 'urn:dkg:profile:tenant-data:query:device-value', name: 'device-value',
        scopeGraph: `did:dkg:context-graph:${graph}/equipment`, catalog: 'urn:dkg:profile:tenant-data:catalog:devices', catalogName: 'Devices',
        sparql: 'SELECT ?value WHERE { ?s <urn:example:value> ?value } LIMIT 5', executionView: 'shared-working-memory' }] : [] }
      : query(sparql, opts));
    const input: any = bindingInput(); const outputSchema = input.sparqlRead.outputSchema; delete input.sparqlRead;
    input.query = { selector: 'device-value', outputSchema };
    const result = await request(f.target, 'owner', 'POST', '/api/programs/bindings', { binding: input });
    expect(result.status).toBe(201); expect(result.body.binding.query).toMatchObject({ definitionSha256: expect.stringMatching(/^[a-f0-9]{64}$/), outputSchemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(f.agent.query.mock.calls.some(([, opts]: any[]) => opts.source === 'semantic-runtime-dkg-query')).toBe(false);
    await f.upload(source.replace('dkg.sparql.read', 'dkg.query').replace(/\(call dkg\/sparql-read@1 "[^"]*"\)/, '(call dkg/query@1 "other-query")'), ['urn:example:tool:query']);
    expect((await request(f.target, 'owner', 'PUT', '/api/programs/bindings', { binding: input, expectedRevision: 1 })).status).toBe(422);
  });
  it('validates literal asset creation and layer permissions without creating an asset during approval', async () => {
    const f = await fixture(); const input: any = bindingInput(); delete input.sparqlRead;
    input.assetCreation = { toolIri: 'urn:example:tool:asset-create' }; input.executionLayer = 'vm';
    const content = { quads: [{ subject: 'urn:example:assessment:1', predicate: 'urn:example:status', object: '"ready"' }] };
    const creation = `(strategy example/record (version "1.0.0") (scope graph:tenant-data) (goal record)
      (supervise one-for-one (max-restarts 1) (window-ms 60000)
        (delegate recorder (grant dkg.asset.create) (call dkg/asset-create@1 ${JSON.stringify(JSON.stringify(content))}))))`;
    await f.upload(creation, [input.assetCreation.toolIri]);
    const result = await request(f.target, 'owner', 'POST', '/api/programs/bindings', { binding: input });
    expect(result.status).toBe(201); expect(result.body.binding.executionLayer).toBe('vm');
    expect(f.agent.probeContextGraphWritePreflight).toHaveBeenCalledWith(graph, { callerAgentAddress: executor });
    expect(f.agent.assertion.create).not.toHaveBeenCalled();
    await f.upload(creation.replace(JSON.stringify(JSON.stringify(content)), JSON.stringify('{}')), [input.assetCreation.toolIri]);
    expect((await request(f.target, 'owner', 'PUT', '/api/programs/bindings', { binding: input, expectedRevision: 1 })).status).toBe(422);
  });
  it('overrides a file-only binding through the API while preserving an unrelated file entry', async () => {
    const f = await fixture(); const approved = await f.activate();
    const clean = structuredClone(approved.body.binding); delete clean.authorizationRevision;
    const otherNode = node(f.agent, { enabled: true, programBindings: [clean, { ...clean, operationIri: 'urn:example:other-operation' }] });
    await otherNode.boot();
    expect((await request(otherNode, 'owner', 'GET', inspect)).body).toMatchObject({ origin: 'configuration-file', revision: 0 });
    expect((await request(otherNode, 'owner', 'DELETE', '/api/programs/bindings', remove(0))).body).toMatchObject({ origin: 'api', revision: 1, binding: { enabled: false } });
    expect(otherNode.config.semanticRuntime.programBindings!.find((entry) => entry.operationIri === 'urn:example:other-operation')!.enabled).toBe(true);
  });
  it('preserves an explicit service kill switch and allows no management calls to bypass it', async () => {
    const f = await fixture(); f.target.config.semanticRuntime.enabled = false;
    expect((await f.activate()).status).toBe(409); expect(f.target.runtime).toBeNull();
  });
  it('rejects identity fallbacks and caller-supplied execution inputs on the explicit operation API', async () => {
    const f = await fixture(); await f.activate(); await f.route();
    const invocation = { contextGraphId: graph, operationIri: operation, invocationId: randomUUID() };
    for (const identity of ['operator', 'anonymous', 'disabled-anonymous'] as const) {
      expect((await request(f.client, identity, 'POST', '/api/programs/execute', invocation)).status).toBe(403);
    }
    for (const input of [{ parameters: { device: 'other' } }, { executorAgentAddress: caller }, { executionLayer: 'vm' }, { sparql: 'SELECT * WHERE {}' }]) {
      expect((await request(f.client, 'caller', 'POST', '/api/programs/execute', { ...invocation, ...input })).status).toBe(400);
    }
    expect(f.senderAgent.invokeSkill).not.toHaveBeenCalled();
  });
  it('fails closed on a corrupt durable record instead of restoring a file permission', async () => {
    const f = await fixture(); const approved = await f.activate();
    const persisted = f.target.runtime!.store.programConfigurationRecords()[0];
    f.target.runtime!.store.writeProgramConfiguration({ ...persisted, payload: '{}' }, 1);
    await f.target.runtime!.stop(); runtimes.delete(f.target.runtime!); f.target.runtime = null;
    f.target.config.semanticRuntime = { programBindings: [approved.body.binding] };
    await expect(f.target.boot()).rejects.toThrow('PROGRAM_CONFIGURATION_ID_MISMATCH');
    expect(f.target.runtime).toBeNull();
    expect(f.target.config.semanticRuntime.enabled).toBeUndefined();
  });
  it('restores file defaults if Worker startup fails after loading API overrides', async () => {
    const f = await fixture(); await f.route();
    await f.client.runtime!.stop(); runtimes.delete(f.client.runtime!); f.client.runtime = null;
    const config: SemanticRuntimeConfig = { programRoutes: [{ contextGraphId: graph, operationIri: operation, targetPeerId: 'file-peer' }] };
    const original = structuredClone(config);
    await expect(startConfiguredSemanticRuntime(config, { dataDirectory: f.client.dir, log: vi.fn(),
      start: async () => { throw new Error('worker unavailable'); } })).rejects.toThrow('worker unavailable');
    expect(config).toEqual(original);
    const reopened = SemanticRuntimeStore.openInDataDirectory(f.client.dir);
    expect(reopened.programConfigurationRecords()).toHaveLength(1); reopened.close();
  });
  it('uses SQLite compare-and-swap across handles and preserves the record on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'program-config-cas-')); dirs.push(dir); const file = join(dir, 'runtime.sqlite');
    const a = new SemanticRuntimeStore(file); const b = new SemanticRuntimeStore(file);
    const record = { kind: 'route' as const, contextGraphId: graph, operationIri: operation, payload: null, updatedBy: 'node-operator', updatedAt: 1 };
    expect(a.writeProgramConfiguration(record, 0)).toBe(1);
    expect(() => b.writeProgramConfiguration(record, 0)).toThrow('PROGRAM_CONFIGURATION_CONFLICT');
    a.close(); b.close(); const reopened = new SemanticRuntimeStore(file);
    expect(reopened.programConfigurationRecords()).toEqual([{ ...record, revision: 1 }]); reopened.close();
  });
});
