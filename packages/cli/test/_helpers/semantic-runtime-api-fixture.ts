import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { DKGQueryEngine } from '@origintrail-official/dkg-query';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { type SemanticRuntimeConfig } from '@origintrail-official/dkg-semantic-runtime';
import { ethers } from 'ethers';
import Database from 'better-sqlite3';
import { expect, vi } from 'vitest';
import { createRequestActor } from '../../src/daemon/routes/context.js';
import { handleQueryRoutes } from '../../src/daemon/routes/query.js';
import { handleKnowledgeAssetsRoutes } from '../../src/daemon/routes/knowledge-assets.js';
import { handleSemanticRuntimeRoutes } from '../../src/daemon/routes/semantic-runtime.js';
import { registerSemanticRuntimeInboxSkill } from '../../src/semantic-runtime-inbox.js';
import { startConfiguredSemanticRuntime, type ConfiguredSemanticRuntimeService } from '../../src/semantic-runtime.js';
import { authenticateHttpRequest } from '../../src/auth.js';
import { signAgentHttpHeaders } from '../../src/agent-http-signing.js';
import { type LocalLlmProgramProvider } from '../../src/semantic-runtime-local-llm-adapter.js';
import { requestAuthentication } from './request-authentication.js';
import { GraphComputer } from '../../../graph-computer/src/index.js';

const ownerWallet = new ethers.Wallet('0x' + '02'.padStart(64, '0'));
const owner = ownerWallet.address;
const executor = owner;
const foreignExecutor = '0x2222222222222222222222222222222222222222';
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
export async function cleanupRuntimeFixtures() {
  for (const runtime of runtimes) await runtime.stop();
  runtimes.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
type Identity = 'owner' | 'operator' | 'member' | 'caller' | 'anonymous' | 'disabled-anonymous';
type Node = { agent: any; config: { semanticRuntime: SemanticRuntimeConfig }; runtime: ConfiguredSemanticRuntimeService | null; dir: string; localLlmProvider?: LocalLlmProgramProvider; boot(activate?: boolean): Promise<ConfiguredSemanticRuntimeService | null> };

function node(agent: any, configured: SemanticRuntimeConfig = {}): Node {
  const dir = mkdtempSync(join(tmpdir(), 'program-api-')); dirs.push(dir);
  const n: Node = { agent, dir, config: { semanticRuntime: { watchdogMs: 1000, startupTimeoutMs: 30_000, ...configured } }, runtime: null,
    async boot(activate = false) {
      if (n.runtime) return n.runtime;
      n.runtime = await startConfiguredSemanticRuntime(n.config.semanticRuntime, { dataDirectory: dir, log: vi.fn(), activate, localLlmProvider: n.localLlmProvider });
      if (n.runtime) { runtimes.add(n.runtime); registerSemanticRuntimeInboxSkill(agent, n.runtime, n.config.semanticRuntime, undefined); }
      return n.runtime;
    } };
  return n;
}
/** Reopen the same durable home; boot alone intentionally reuses a live runtime. */
async function restartNode(n: Node) {
  const previous = n.runtime!;
  const databasePath = previous.store.databasePath;
  await previous.stop();
  runtimes.delete(previous);
  n.runtime = null;
  const reopened = (await n.boot())!;
  expect(reopened).not.toBe(previous);
  expect(reopened.store).not.toBe(previous.store);
  expect(reopened.host).not.toBe(previous.host);
  expect(reopened.configuration).not.toBe(previous.configuration);
  expect(reopened.typescript).not.toBe(previous.typescript);
  expect(reopened.store.databasePath).toBe(databasePath);
  return reopened;
}
async function request(n: Node, identity: Identity, method: string, path: string, body?: unknown, signing?: { wallet: ethers.Wallet; operator?: boolean; headers?: Record<string, string> }, localAgent?: string) {
  let auth = identity === 'anonymous' || identity === 'disabled-anonymous'
    ? requestAuthentication({ kind: 'anonymous', mode: identity === 'anonymous' ? 'public' : 'disabled' })
    : identity === 'operator' ? requestAuthentication({ kind: 'nodeOperator' })
      : requestAuthentication({ kind: 'agent', agentAddress: { owner, member, caller }[identity] });
  const url = new URL(path, 'http://local.test');
  let req: any = Object.assign(new EventEmitter(), { method, headers: localAgent ? { 'x-dkg-program-agent': localAgent } : {}, aborted: false, __dkgPrebufferedBody: Buffer.from(JSON.stringify(body ?? {})) });
  const res: any = new EventEmitter();
  res.writeHead = (status: number) => { res.statusCode = status; return res; };
  res.end = (data: string) => { res.body = JSON.parse(data); res.writableEnded = true; };
  if (signing) {
    const bytes = Buffer.from(body === undefined && signing.headers ? '' : JSON.stringify(body ?? {}));
    const headers = signing.headers ?? signAgentHttpHeaders({ agentAddress: signing.wallet.address, method, path, targetPeerId: n.agent.peerId,
      body: bytes, contentType: 'application/json', timestamp: String(Date.now()), nonce: randomUUID().replaceAll('-', '') }, signing.wallet.signingKey);
    req = Object.assign(Readable.from([bytes]), { method, url: path, headers, rawHeaders: [] });
    const result = await authenticateHttpRequest({ req, res, authEnabled: true, validTokens: new Set(), resolveAgentByToken: () => undefined,
      agentKey: { targetPeerId: n.agent.peerId, nonces: { claim: () => true }, operatorAgentAddresses: signing.operator ? [signing.wallet.address] : [] } });
    if (!result.allowed) return { status: res.statusCode as number, body: res.body as any };
    auth = result;
  }
  if (localAgent) req.headers = { ...req.headers, 'x-dkg-program-agent': localAgent };
  const handler = url.pathname === '/api/query' ? handleQueryRoutes
    : url.pathname === '/api/knowledge-assets' ? handleKnowledgeAssetsRoutes : handleSemanticRuntimeRoutes;
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
  const layers = new Map<string, 'WM' | 'SWM' | 'VM'>();
  const receiptUal = (name: string) => `did:dkg:asset:${name}`;
  let inbox!: (request: any, peer: string) => Promise<any>;
  const allowed = (address?: string) => [owner, foreignExecutor, author, member].includes(address ?? '');
  const agent: any = {
    peerId: 'peer-runner', log: { info: vi.fn() }, store, queryEngine: engine,
    registerSkill: (_skill: string, handler: typeof inbox) => { inbox = handler; },
    listLocalAgents: () => [executor, foreignExecutor].map((agentAddress) => ({ agentAddress })),
    getCustodialAgentPrivateKey: (address: string) => [executor, foreignExecutor].includes(address) ? callerKey : undefined,
    assertContextGraphOwner: vi.fn(async (cg: string, identity: string) => { if (cg !== graph || identity !== owner) throw new Error('not owner'); }),
    canReadContextGraph: vi.fn(async (_cg: string, opts: any) => allowed(opts.callerAgentAddress)),
    resolveContextGraphReadAuthority: vi.fn(async (_cg: string, opts: any) => ({ outcome: allowed(opts.callerAgentAddress) ? 'allowed' : 'denied' })),
    canUseSharedMemoryForContextGraph: vi.fn(async () => true),
    resolveSharedMemoryReadAdmission: vi.fn(async (_cg: string, opts: any) => ({
      outcome: allowed(opts.callerAgentAddress) ? 'allowed' : 'denied',
    })),
    probeContextGraphWritePreflight: vi.fn(async () => ({ storeAvailable: true, exists: true, hasLocalContent: true, callerAuthorized: true })),
    query: vi.fn(async (query: string, opts: any) => DKGAgent.prototype.query.call(agent, query, opts)),
    assertion: {
      history: vi.fn(async (_cg: string, name: string) => sealed.has(name)
        ? { wmCurrentAssertion: 'aa'.repeat(32), memoryLayer: layers.get(name) ?? 'WM',
          ...(layers.get(name) !== 'WM' && layers.has(name) ? { swmCurrentAssertion: 'aa'.repeat(32) } : {}),
          ...(layers.get(name) === 'VM' ? { vmCurrentAssertion: 'aa'.repeat(32), publishedUal: receiptUal(name) } : {}) }
        : content.has(name) ? { wmCurrentAssertion: null, memoryLayer: 'WM' } : null),
      create: vi.fn(async (_cg: string, name: string) => { content.set(name, []); return 'urn:example:asset:' + name; }),
      write: vi.fn(async (cg: string, name: string, quads: Quad[], lane: { agentAddress: string }) => {
        const at = `did:dkg:context-graph:${cg}/_working_memory/${lane.agentAddress}/${content.size + 10}`;
        const entries = quads.map((q) => ({ ...q, graph: at })); content.get(name)!.push(...entries); await store.insert(entries);
      }),
      finalize: vi.fn(async (_cg: string, name: string) => { sealed.add(name); return { merkleRoot: new Uint8Array(32).fill(170), authorAddress: owner }; }),
      query: vi.fn(async (_cg: string, name: string) => content.get(name) ?? []),
      promote: vi.fn(async (_cg: string, name: string) => {
        layers.set(name, 'SWM');
        await store.insert((content.get(name) ?? []).map(q => ({ ...q, graph: q.graph.replace('_working_memory', '_shared_memory') })));
        return { publishReady: true };
      }),
    },
  };
  agent.publishFromFinalizedAssertion = vi.fn(async (_cg: string, name: string) => {
    layers.set(name, 'VM');
    await store.insert((content.get(name) ?? []).map(q => ({ ...q, graph: q.graph.replace('_working_memory', '_verifiable_memory') })));
    return { status: 'confirmed', ual: receiptUal(name) };
  });
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
  await store.insert([{ subject: 'urn:example:foreign-device:1', predicate: 'urn:example:value', object: '"42"',
    graph: `did:dkg:context-graph:${graph}/_working_memory/${foreignExecutor}/1` }]);
  await upload();
  const activate = () => request(target, 'owner', 'POST', '/api/programs/bindings', { binding: bindingInput() });
  const route = () => request(client, 'operator', 'POST', '/api/programs/routes', { route: { contextGraphId: graph, operationIri: operation, targetPeerId: agent.peerId } });
  const invoke = (id = randomUUID()) => request(client, 'caller', 'POST', '/api/programs/execute', { contextGraphId: graph, operationIri: operation, invocationId: id });
  return { target, client, agent, senderAgent, store, upload, activate, route, invoke };
}


const toolApi = '@origintrail-official/dkg-graph-computer/program';
const readQuery = 'SELECT ?value WHERE { <urn:example:device:1> <urn:example:value> ?value } LIMIT 5';
const createTool = 'urn:example:tool:create-asset';
const assetInput = { quads: [{ subject: 'urn:example:assessment:1', predicate: 'urn:example:status', object: '"checked"' }] };
async function toolFixture(text: string, permissions: any = { graphId: graph, sparqlRead: bindingInput().sparqlRead }, tools = [tool], localLlmProvider?: LocalLlmProgramProvider) {
  const f = await fixture();
  f.agent.listContextGraphs = vi.fn(async () => [{ id: graph }, { id: sourceGraph }]);
  const fetchFor = (n: Node, wallet: ethers.Wallet, operator = false): typeof fetch => async (url, init) => {
    const u = new URL(String(url));
    const result = await request(n, wallet.address === owner ? 'owner' : 'caller', init!.method!, u.pathname + u.search,
      init!.body ? JSON.parse(String(init!.body)) : undefined,
      { wallet, operator, headers: Object.fromEntries(new Headers(init!.headers).entries()) });
    return new Response(JSON.stringify(result.body), { status: result.status });
  };
  const manager = new GraphComputer({ nodeUrl: 'http://target', peerId: f.agent.peerId, signer: ownerWallet,
    fetch: fetchFor(f.target, ownerWallet), retries: 0 });
  const client = new GraphComputer({ nodeUrl: 'http://client', peerId: f.senderAgent.peerId, signer: new ethers.Wallet(callerKey),
    executorPeerId: f.agent.peerId, fetch: fetchFor(f.client, new ethers.Wallet(callerKey), true), retries: 0 });
  const program = await manager.programs.upload({ graphId: sourceGraph, language: 'typescript-v1', requiredTools: tools,
    requestedPermissions: permissions, source: text });
  f.target.localLlmProvider = localLlmProvider;
  await f.target.boot(true);
  const operation = { graphId: graph, operationIri: 'urn:test:direct-tool' };
  const approve = (overrides: any = {}) => manager.programs.approve({ ...permissions, ...operation, program,
    allowedCallers: [caller], typescript: { children: [] }, ...overrides });
  return { ...f, manager, client, program, operation, approve, permissions };
}

type AuthorityChange = 'revoke' | 'expire' | 'epoch';
function invalidateExecutionCapability(n: Node, id: string, change: AuthorityChange) {
  const capabilityId = `urn:sr:capability:${id}`;
  if (change === 'revoke') {
    expect(n.runtime!.store.revokeCapability(capabilityId, Date.now())).toBe(true);
    return;
  }
  // Public revocation uses the real store API. Seed the other immutable grant
  // fields through a separate SQLite connection so restart also observes them.
  const db = new Database(n.runtime!.store.databasePath);
  try {
    const assignment = change === 'expire' ? 'expires_at = 0' : 'policy_epoch = policy_epoch + 1';
    expect(db.prepare(`UPDATE capability_ref SET ${assignment} WHERE capability_id = ?`).run(capabilityId).changes).toBe(1);
  } finally { db.close(); }
}
export { ownerWallet, owner, executor, foreignExecutor, author, member, callerKey, caller,
  graph, sourceGraph, operation, programIri, tool, SR, source, bindingInput, runtimes, dirs,
  node, restartNode, request, inspect, remove, fixture, toolApi, readQuery, createTool, assetInput,
  toolFixture, invalidateExecutionCapability };
export type { Identity, Node, AuthorityChange };
