// Fictional provider and node effects; the Studio compiler/service/SQLite journal are real.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
const { default: baseProfile, measurements } = await import('./measurement-profile.mjs');
import { createStudioContext } from '../studio-context.mjs';
const { dkgComponentStore } = await import('../dkg-components.mjs');
const { createStudioRepository } = await import('../studio-repository.mjs');
const { createStudioProvider } = await import('../studio-provider.mjs');
const { createStudioService } = await import('../studio-service.mjs');
const { handleDkgComponentCallback } = await import('../bridge.mjs');

export function createStudioExecutionHarness({ state, graphId, owner, config, client, loadOutputs, programAuthority, withProgram = false }) {
  const profile = { ...baseProfile };
  const { registry: { componentRegistry, component }, compiler } = createStudioContext({ profile });
  mkdirSync(state, { recursive: true });
  const tokenValue = 'fictional-provider-token-for-isolated-regression';
  const token = join(state, 'test-token'); writeFileSync(token, tokenValue);
  config.n8nNative = { baseUrl: 'http://127.0.0.1:5679', apiTokenFile: token, webhookTokenFile: token, workflows: [] };
  const catalog = componentRegistry.map(descriptor => ({ kind: 'component',
    kaRef: 'urn:demo:n8n:component:' + descriptor.id + ':unit', sourceHash: 'a'.repeat(64), available: true, descriptor }));
  const lastBlock = withProgram ? 'program' : 'write';
  const definition = { id: randomUUID(), name: 'Fictional Read ' + lastBlock, entryId: 'read',
    nodes: ['dkg-read', withProgram ? 'invoke-dkg-program' : 'dkg-write'].map((id, index) => ({ id: index ? lastBlock : 'read', componentId: id,
      kaRef: catalog.find(c => c.descriptor.id === id).kaRef, sourceHash: 'a'.repeat(64),
      params: Object.fromEntries(Object.entries(component(id).parameters).map(([k, v]) => [k, v.default])), x: index * 240, y: 0 })),
    edges: [{ from: 'read', to: lastBlock, output: 0, input: 0 }] };
  const effects = [], assets = new Map(), native = new Map(), executions = new Map();
  const controls = { interrupted: true, normalized: true, dispatches: 0, owner: true, snapshot: v => v,
    loseWriteReply: false, nodeUnavailable: false, allowCreates: [], callbackStatuses: [], callbackErrors: [] };
  profile.requiresNosActor = true; profile.accountId = 'account-fictional';
  profile.authorize = async actor => {
    if (!controls.owner || actor.accountId !== profile.accountId) throw new Error('owner revoked');
    await controls.authorizing?.();
  };
  profile.transport = async (request, kind) => {
    effects.push(kind);
    if (kind === 'read') return { graph: 'urn:test:measurements', measurements };
    if (kind === 'invoke') return controls.invokeProgram(request);
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
  const requestFor = (effectId, blockId, items, executionId = '42') => ({ effectId, workflowId: 'native1', executionId, blockId, items });
  const callback = async value => {
    const req = Readable.from([JSON.stringify(value)]);
    req.method = 'POST'; req.headers = { authorization: 'Bearer ' + tokenValue };
    let status, body;
    await handleDkgComponentCallback(req, { writeHead(s) { status = s; }, end(s) { body = JSON.parse(s); } }, service, config);
    controls.callbackStatuses.push(status);
    if (status !== 200) controls.callbackErrors.push(body);
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
      const executionId = String(41 + controls.dispatches);
      const workflow = native.get('native1');
      const execution = { id: executionId, workflowId: 'native1', workflowVersionId: workflow.activeVersion.versionId,
        status: 'running', workflowData: snapshot(workflow), data: { executionData: { nodeExecutionStack: [
          { node: workflow.activeVersion.nodes.find(n => n.name === 'Receive input'), data: { main: [[{ json: { body } }]] } },
        ] }, resultData: { runData: {} } } };
      executions.set(executionId, execution);
      const complete = async () => {
        const read = await callback(requestFor(body.invocationId, 'read', JSON.parse(body.input.itemsJson), executionId));
        await controls.beforeWrite?.();
        const lastName = 'Block ' + lastBlock, requestName = lastName + ' request';
        const lastNode = workflow.activeVersion.nodes.find(n => n.name === requestName);
        let result, error;
        const request = requestFor(body.invocationId, lastBlock, read.items, executionId);
        controls[withProgram ? 'programRequest' : 'writeRequest'] = request;
        if (controls.skipWrite) error = { message: 'Provider stopped before Write' };
        for (let attempt = 0; !controls.skipWrite && attempt < (lastNode.retryOnFail ? lastNode.maxTries : 1); attempt++) {
          try { result = await callback(request); break; }
          catch (failure) { error = { message: failure.message }; }
        }
        execution.status = controls.terminalStatus ?? (result ? 'success' : 'error');
        const runData = Object.fromEntries([
          ['Receive input', [{ body }]],
          ['Block read request', read.items], ...(result ? [[requestName, result.items], [lastName, result.items]] : []),
        ].map(([node, items]) => [node, [{ data: { main: [items.map(json => ({ json }))] } }]]));
        if (!result) runData[requestName] = [{ error, data: { main: [[]] } }];
        execution.data = { resultData: { runData, ...(!result ? { error, lastNodeExecuted: lastNode.name } : {}) } };
      };
      if (controls.earlyAcknowledgement) {
        controls.finished = complete().catch(error => {
          execution.status = 'error';
          execution.data.resultData.error = { message: error.message };
        });
      } else await complete();
      return Response.json({ executionId });
    }
    if (path.startsWith('/api/v1/executions/')) return Response.json(controls.snapshot(structuredClone(executions.get(path.split('/').at(-1)))));
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
    provider = createStudioProvider({ compiler, repository, config, graphId, owner,
      headerCredential: { id: 'test-header', name: 'Test header' }, credentials: {}, fetchImpl });
    service = createStudioService({ compiler, graphId, owner, repository, provider, eventsEnabled: false, dkg: dkgComponentStore(repository.db, profile), programAuthority, client, loadOutputs, listCapabilities: async () => catalog });
  }
  open();
  return { definition, actor, controls, effects, assets, native, executions, runtimeFetch, profile,
    requestFor, get service() { return service; }, get provider() { return provider; }, get repository() { return repository; },
    reopen() { service.stop(); repository.close(); open(); },
    close() { service.stop(); repository.close(); },
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
