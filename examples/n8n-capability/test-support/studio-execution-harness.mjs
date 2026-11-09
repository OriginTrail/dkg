// Fictional provider and node effects; the Studio compiler/service/SQLite journal are real.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
process.env.NOS_DKG_PROFILE_MODULE = fileURLToPath(new URL('./measurement-profile.mjs', import.meta.url));
const { default: profile, measurements } = await import('./measurement-profile.mjs');
const { componentRegistry, component } = await import('../component-registry.mjs');
const { dkgComponentStore } = await import('../dkg-components.mjs');
const { createStudioRepository } = await import('../studio-repository.mjs');
const { createStudioProvider } = await import('../studio-provider.mjs');
const { createStudioService } = await import('../studio-service.mjs');
const { handleDkgComponentCallback } = await import('../bridge.mjs');

export function createStudioExecutionHarness({ state, graphId, owner, config, client, loadOutputs }) {
  mkdirSync(state, { recursive: true });
  const tokenValue = 'fictional-provider-token-for-isolated-regression';
  const token = join(state, 'test-token'); writeFileSync(token, tokenValue);
  config.n8nNative = { baseUrl: 'http://127.0.0.1:5679', apiTokenFile: token, webhookTokenFile: token, workflows: [] };
  const catalog = componentRegistry.map(descriptor => ({ kind: 'component',
    kaRef: 'urn:demo:n8n:component:' + descriptor.id + ':unit', sourceHash: 'a'.repeat(64), available: true, descriptor }));
  const definition = { id: randomUUID(), name: 'Fictional Read Write', entryId: 'read',
    nodes: ['dkg-read', 'dkg-write'].map((id, index) => ({ id: index ? 'write' : 'read', componentId: id,
      kaRef: catalog.find(c => c.descriptor.id === id).kaRef, sourceHash: 'a'.repeat(64),
      params: Object.fromEntries(Object.entries(component(id).parameters).map(([k, v]) => [k, v.default])), x: index * 240, y: 0 })),
    edges: [{ from: 'read', to: 'write', output: 0, input: 0 }] };
  const effects = [], assets = new Map(), native = new Map(), executions = new Map();
  const controls = { interrupted: true, normalized: true, dispatches: 0, owner: true, snapshot: v => v,
    loseWriteReply: false, nodeUnavailable: false, allowCreates: [], callbackStatuses: [] };
  const original = { transport: profile.transport, authorize: profile.authorize, requiresNosActor: profile.requiresNosActor, accountId: profile.accountId };
  profile.requiresNosActor = true; profile.accountId = 'account-fictional';
  profile.authorize = async actor => { if (!controls.owner || actor.accountId !== profile.accountId) throw new Error('owner revoked'); };
  profile.transport = async (request, kind) => {
    effects.push(kind);
    if (kind === 'read') return { graph: 'urn:test:measurements', measurements };
    if (kind !== 'write') throw new Error('unexpected effect');
    controls.allowCreates.push(request.allowCreate);
    if (controls.nodeUnavailable) throw new Error('node unavailable');
    if (request.allowCreate) {
      if (assets.has(request.name)) throw new Error('duplicate asset effect');
      assets.set(request.name, request);
      if (controls.loseWriteReply) { controls.nodeUnavailable = true; throw new Error('lost write response'); }
    } else {
      const original = assets.get(request.name);
      if (!original || JSON.stringify({ ...original, allowCreate: false }) !== JSON.stringify(request)) throw new Error('different reconciliation payload');
    }
    return { contextGraphId: profile.targetGraph, name: request.name, digest: request.digest,
      readbackVerified: true, metadata: { status: 'wm-sealed', reservedUal: 'urn:test:asset:1' } };
  };
  const actor = { accountId: profile.accountId, principalId: 'person-owner', role: 'owner' };
  let provider, service;
  const requestFor = (effectId, blockId, items) => ({ effectId, workflowId: 'native1', executionId: '42', blockId, items });
  const callback = async value => {
    const req = Readable.from([JSON.stringify(value)]);
    req.method = 'POST'; req.headers = { authorization: 'Bearer ' + tokenValue };
    let status, body;
    await handleDkgComponentCallback(req, { writeHead(s) { status = s; }, end(s) { body = JSON.parse(s); } }, service, config);
    controls.callbackStatuses.push(status);
    if (status !== 200) throw Object.assign(new Error(body.error), { code: body.code, status });
    return body;
  };
  const snapshot = workflow => {
    const value = structuredClone(workflow.activeVersion);
    if (controls.normalized) for (const node of value.nodes) {
      // n8n's execution serialization can remove the expression-leading '='.
      const normalize = x => typeof x === 'string' && x.startsWith('=') ? x.slice(1)
        : Array.isArray(x) ? x.map(normalize) : x && typeof x === 'object'
          ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, normalize(v)])) : x;
      node.parameters = normalize(node.parameters);
    }
    return value;
  };
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname, method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(String(options.body)) : undefined;
    if (path.startsWith('/webhook/')) {
      controls.dispatches++;
      const workflow = native.get('native1');
      const execution = { id: '42', workflowId: 'native1', workflowVersionId: workflow.activeVersion.versionId,
        status: 'running', workflowData: snapshot(workflow), data: { executionData: { nodeExecutionStack: [
          { node: workflow.activeVersion.nodes.find(n => n.name === 'Receive input'), data: { main: [[{ json: { body } }]] } },
        ] }, resultData: { runData: {} } } };
      executions.set('42', execution);
      const read = await callback(requestFor(body.invocationId, 'read', JSON.parse(body.input.itemsJson)));
      const writeNode = workflow.activeVersion.nodes.find(n => n.name === 'Block write request');
      let written, error;
      for (let attempt = 0; attempt < (writeNode.retryOnFail ? writeNode.maxTries : 1); attempt++) {
        try { written = await callback(requestFor(body.invocationId, 'write', read.items)); break; }
        catch (failure) { error = { message: failure.message }; }
      }
      execution.status = written ? 'success' : 'error';
      const runData = Object.fromEntries([
        ['Receive input', [{ body }]],
        ['Block read request', read.items], ...(written ? [['Block write request', written.items], ['Block write', written.items]] : []),
      ].map(([node, items]) => [node, [{ data: { main: [items.map(json => ({ json }))] } }]]));
      if (!written) runData['Block write request'] = [{ error, data: { main: [[]] } }];
      execution.data = { resultData: { runData, ...(!written ? { error, lastNodeExecuted: writeNode.name } : {}) } };
      return Response.json({ executionId: '42' });
    }
    if (path.startsWith('/api/v1/executions/')) return Response.json(controls.snapshot(structuredClone(executions.get('42'))));
    if (path === '/api/v1/workflows') {
      if (method === 'GET') return Response.json({ data: [...native.values()] });
      const workflow = { ...body, id: 'native1', active: false, versionId: 'published-1' };
      native.set('native1', workflow); return Response.json(workflow);
    }
    const workflow = native.get('native1');
    if (!workflow) return Response.json({}, { status: 404 });
    if (method === 'PUT') Object.assign(workflow, body);
    if (path.endsWith('/publish')) { workflow.active = true; workflow.activeVersion = structuredClone(workflow); }
    return Response.json(workflow);
  };
  // The native runtime loses inspection after the provider has committed its write; callbacks
  // still see the in-flight execution through the provider's independently controlled API.
  const runtimeFetch = (url, options) => {
    if (new URL(url).pathname.startsWith('/api/v1/executions/') && controls.interrupted)
      throw new Error('inspection unavailable after sealed write');
    return fetchImpl(url, options);
  };
  let repository;
  function open() {
    repository = createStudioRepository(state);
    provider = createStudioProvider({ repository, config, graphId, owner,
      headerCredential: { id: 'test-header', name: 'Test header' }, credentials: {}, fetchImpl });
    service = createStudioService({ graphId, owner, repository, provider, dkg: dkgComponentStore(repository.db), client, loadOutputs, listCapabilities: async () => catalog });
  }
  open();
  return { definition, actor, controls, effects, assets, native, executions, runtimeFetch, profile,
    requestFor, get service() { return service; }, get provider() { return provider; },
    reopen() { service.stop(); repository.close(); open(); },
    close() { service.stop(); repository.close(); Object.assign(profile, original); },
  };
}

export function memoryStudioClient() {
  const sources = new Map(), approvals = new Map();
  return { sources, approvals, programs: {
    async getSource({ programIri }) { const value = sources.get(programIri); if (!value) throw Object.assign(new Error('missing'), { code: 'PROGRAM_NOT_FOUND', status: 404 }); return value; },
    async upload(value) { sources.set(value.programIri, { ...value, authorAgentAddress: '0x' + '1'.repeat(40), sourceHash: createHash('sha256').update(value.source).digest('hex') }); },
    async getApproval({ operationIri }) { const value = approvals.get(operationIri); if (!value) throw Object.assign(new Error('missing'), { status: 404 }); return value; },
    async approve(value) { approvals.set(value.operationIri, { ...value, binding: { enabled: true, program: value.program } }); },
    async invoke() { throw new Error('stop after recording invocation grant'); },
  } };
}
