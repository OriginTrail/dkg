import { canonicalizeJson } from '../../packages/core/dist/index.js';
import { loadExecutionOutputs } from '../../packages/cli/dist/semantic-runtime-execution-persistence.js';
import { iriValue, resultRows } from '../../packages/cli/dist/semantic-runtime-values.js';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { persistProgramKnowledgeAsset } from '../../packages/cli/dist/semantic-runtime-execution-persistence.js';
import { createWorkflowService } from './workflow-service.mjs';
import { WORKFLOW_PREFIX } from './workflow-definition.mjs';
import { createStudioProvider } from './studio-provider.mjs';
import { createStudioService } from './studio-service.mjs';
import { normalizeComponentInput } from './component-registry.mjs';
import { STUDIO_PREFIX } from './studio-definition.mjs';

const SR = 'https://origintrail.io/semantic-runtime/v1#';
const prefix = '/spike/ka/accounts/account-a/capabilities';
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };

export function createCapabilityBridge({ agent, client, graphId, owner, config, definitions = [], exportTokenFile, studioOptions }) {
  function authorizeExport(req) {
    const supplied = req.headers['x-dkg-export-token'];
    let authorized = false;
    if (typeof supplied === 'string' && supplied.length <= 256 && exportTokenFile) {
      try { const expected = readFileSync(exportTokenFile, 'utf8').trim();
        const a = Buffer.from(supplied), b = Buffer.from(expected);
        authorized = b.length >= 32 && a.length === b.length && timingSafeEqual(a, b); } catch {}
    }
    if (!authorized) throw Object.assign(new Error('Operator export authorization required'), { status: 403 });
  }
  async function list() {
    const result = await agent.query(`SELECT DISTINCT ?program WHERE { GRAPH ?g {
      ?program a <${SR}Program>; <${SR}requiresTool> <urn:dkg:tool:n8n> . } }`,
    { contextGraphId: graphId, view: 'working-memory', callerAgentAddress: owner });
    const capabilities = [];
    for (const row of resultRows(result)) {
      const kaRef = iriValue(row.program);
      const definition = definitions.find(item => item.kaRef === kaRef);
      const binding = config.programBindings?.find(item => item.operationIri === kaRef && item.contextGraphId === graphId && item.enabled && item.n8n);
      if (!definition) continue;
      const source = await client.programs.getSource({ graphId, programIri: kaRef, programLayer: 'wm' });
      if (binding && source.sourceHash !== binding.program.sourceHash) continue;
      const available = !!binding && definition?.enabled !== false;
      capabilities.push({ kaRef, graphId, sourceHash: source.sourceHash, name: source.label ?? 'n8n capability', version: source.version,
        kind: definition?.kind ?? 'text', available,
        ...(definition.retired ? { retired: true } : {}),
        ...(definition?.kind === 'component' ? { descriptor: definition.descriptor } : {}),
        ...((definition?.requiresExportAuthorization || definition?.kind === 'google-sheets-export') ? { requiresExportAuthorization: true } : {}),
        ...(!available && definition?.descriptor?.connection ? { unavailableReason: 'Connect ' + definition.descriptor.name + ' OAuth in local n8n, then refresh the operator installation.' } : {}),
        ...(definition?.kind === 'google-sheets-export' && !available ? { unavailableReason: 'Connect a Google Sheets OAuth credential in n8n to enable this KA.' } : {}) });
    }
    return capabilities;
  }
  const workflows = createWorkflowService({ graphId, owner, client, listCapabilities: list,
    listPrograms: async () => resultRows(await agent.query(`SELECT DISTINCT ?program WHERE { GRAPH ?g {
      ?program a <${SR}Program> . FILTER(STRSTARTS(STR(?program), "${WORKFLOW_PREFIX}")) } }`,
    { contextGraphId: graphId, view: 'working-memory', callerAgentAddress: owner })).map(row => iriValue(row.program)),
    persistProgram: async (compiled, authorized) => {
      const quad = (predicate, object) => ({ subject: compiled.kaRef, predicate, object });
      const quads = [quad('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', SR + 'Program'),
        quad('http://www.w3.org/2000/01/rdf-schema#label', JSON.stringify(compiled.definition.name)),
        quad(SR + 'language', '"typescript-v1"'), quad(SR + 'version', '"1.0.0"'), quad(SR + 'source', JSON.stringify(compiled.source)),
        ...[...new Set(compiled.ordered.map(node => node.kaRef))].map(iri => quad(SR + 'permitsProgram', iri))];
      await persistProgramKnowledgeAsset(agent, graphId, compiled.name, owner, quads,
        await agent.assertion.history(graphId, compiled.name, { agentAddress: owner }), 'wm', authorized);
    },
    loadOutputs: executionIri => loadExecutionOutputs(agent, graphId, executionIri, 'wm', owner),
  });
  const provider = studioOptions ? createStudioProvider({ ...studioOptions, config, graphId, owner }) : null;
  const studio = provider ? createStudioService({ graphId, owner, client, provider, exportTokenFile, listCapabilities: list,
    loadOutputs: executionIri => loadExecutionOutputs(agent, graphId, executionIri, 'wm', owner) }) : null;
  async function invoke(capability, input, invocationId) {
    const result = await client.programs.invoke({ graphId, operationIri: capability.kaRef, inputs: [input], invocationId });
    const stored = await loadExecutionOutputs(agent, graphId, result.executionIri, 'wm', owner);
    if (canonicalizeJson(stored) !== canonicalizeJson(result.rawOutputs)) throw new Error('DKG execution readback differs');
    const output = result.outputs[0];
    if (!output || output.kind !== 'n8n-result') throw new Error('n8n result is missing');
    return { kaRef: capability.kaRef, sourceHash: capability.sourceHash, invocationId: result.invocationId,
      executionIri: result.executionIri, n8nExecutionId: output.n8nExecutionId, workflowSha256: output.workflowSha256,
      output: output.output, persisted: result.persisted, readbackVerified: true };
  }
  async function handle(req, res, path) {
    if (!path.startsWith('/spike/ka/')) return false;
    if (path === '/spike/ka/demo-data' && ['GET', 'POST'].includes(req.method)) {
      let body = '', size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4096) { json(res, 413, { error: 'Small JSON only.' }); return true; } body += chunk; }
      json(res, 200, { source: 'nOS local demo API', items: [{ name: 'Ana', value: 12 }, { name: 'Luka', value: 7 }], ...(body ? { received: JSON.parse(body) } : {}) }); return true;
    }
    if (studio && /^\/spike\/ka\/events\/[a-f0-9-]{36}$/.test(path) && req.method === 'POST') {
      try { let body = '', size = 0; for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new Error('Request too large'); body += chunk; }
        json(res, 200, await studio.event(path.split('/').at(-1), JSON.parse(body))); }
      catch (e) { json(res, e.status ?? 400, { code: e.code ?? 'EVENT_UNCONFIRMED', error: 'The event did not confirm a result. Retain its invocationId.' }); }
      return true;
    }
    const origin = req.headers.origin;
    if (origin && !['http://127.0.0.1:4620', 'http://localhost:4620'].includes(origin)) { json(res, 403, { error: 'Local console origin required' }); return true; }
    const identity = req.headers.authorization;
    const routes = [prefix, prefix + '/invoke', prefix + '/inspect', prefix + '/workflows', prefix + '/workflows/save', prefix + '/workflows/run',
      ...['', '/save', '/run', '/invoke', '/activation', '/history'].map(s => prefix + '/studio' + s)];
    if (!['Bearer l1-owner-a', 'Bearer l1-viewer-a'].includes(identity)
      || !routes.includes(path)) { json(res, 403, { error: 'Account access denied' }); return true; }
    try {
      if (studio && path.startsWith(prefix + '/studio')) {
        const route = path.slice((prefix + '/studio').length), authorize = () => authorizeExport(req);
        if (route === '' && req.method === 'GET') json(res, 200, { capabilities: (await list()).filter(c => c.kind === 'component'), workflows: await studio.list(), canInvoke: identity === 'Bearer l1-owner-a' });
        else if (route === '/history' && req.method === 'GET') {
          const params = new URL(req.url, 'http://127.0.0.1:4631').searchParams; json(res, 200, await studio.history(params.get('kaRef')));
        } else if (['/save', '/run', '/invoke', '/activation'].includes(route) && req.method === 'POST') {
          if (identity !== 'Bearer l1-owner-a') { json(res, 403, { error: 'Owner access required.' }); return true; }
          let body = '', size = 0; for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new Error('Request too large'); body += chunk; }
          const value = JSON.parse(body);
          if (route === '/save') json(res, 200, await studio.save(value, authorize));
          else if (route === '/run') json(res, 200, await studio.run(value, authorize));
          else if (route === '/activation') json(res, 200, await studio.activate(value, authorize));
          else {
            const selected = (await list()).find(c => c.kind === 'component' && c.kaRef === value.kaRef && c.sourceHash === value.sourceHash && c.available);
            if (!selected) throw Object.assign(new Error('Component revision unavailable.'), { code: 'WORKFLOW_CAPABILITY_CHANGED', status: 409 });
            if (selected.requiresExportAuthorization) authorize();
            let input; try { input = normalizeComponentInput(selected.descriptor, value.input); }
            catch (e) { throw Object.assign(e, { code: 'INVALID_WORKFLOW', status: 400 }); }
            json(res, 200, await invoke(selected, input, value.invocationId));
          }
        } else json(res, 405, { error: 'Method unavailable.' });
      }
      else if (path === prefix && req.method === 'GET') json(res, 200, { capabilities: (await list()).filter(c => c.kind !== 'component'), canInvoke: identity === 'Bearer l1-owner-a' });
      else if (path === prefix + '/workflows' && req.method === 'GET') json(res, 200, { workflows: await workflows.list() });
      else if (path === prefix + '/inspect' && req.method === 'GET') {
        const params = new URL(req.url, 'http://127.0.0.1:4631').searchParams;
        const kaRef = params.get('kaRef'), sourceHash = params.get('sourceHash');
        if (!sourceHash || !/^[a-f0-9]{64}$/.test(sourceHash)) { json(res, 400, { error: 'An exact KA revision is required.' }); return true; }
        const selected = kaRef?.startsWith(STUDIO_PREFIX) && studio ? (await studio.get(kaRef, sourceHash)).workflow
          : kaRef?.startsWith(WORKFLOW_PREFIX) ? (await workflows.get(kaRef, sourceHash)).workflow
          : (await list()).find(item => item.kaRef === kaRef && item.sourceHash === sourceHash);
        if (!selected) { json(res, 404, { error: 'KA revision unavailable.' }); return true; }
        const source = await client.programs.getSource({ graphId, programIri: kaRef, programLayer: 'wm' });
        if (source.sourceHash !== sourceHash) { json(res, 409, { error: 'KA revision changed.' }); return true; }
        json(res, 200, { kaRef, sourceHash, graphId, layer: 'wm', nodeUrl: 'http://127.0.0.1:4631',
          label: source.label, language: source.language, source: source.source, authorAgentAddress: source.authorAgentAddress, readbackVerified: true });
      }
      else if ([prefix + '/workflows/save', prefix + '/workflows/run'].includes(path) && req.method === 'POST') {
        if (identity !== 'Bearer l1-owner-a') { json(res, 403, { error: 'Workflow writes require the owner.' }); return true; }
        let bytes = 0, body = '';
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new Error('Request too large'); body += chunk; }
        const value = JSON.parse(body), authorize = () => authorizeExport(req);
        json(res, 200, await (path.endsWith('/save') ? workflows.save(value, authorize) : workflows.run(value, authorize)));
      }
      else if (path === prefix + '/invoke' && req.method === 'POST') {
        if (identity !== 'Bearer l1-owner-a') { json(res, 403, { error: 'Invocation denied' }); return true; }
        let bytes = 0, body = '';
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new Error('Request too large'); body += chunk; }
        const value = JSON.parse(body);
        if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['kaRef', 'sourceHash', 'input', 'invocationId'].includes(key))) throw new Error('Invalid invocation');
        const selected = (await list()).find(item => item.kaRef === value.kaRef && item.sourceHash === value.sourceHash);
        if (!selected) { json(res, 409, { error: 'Approved KA version changed' }); return true; }
        if (!selected.available) { json(res, 409, { error: 'This component needs an operator connection before invocation.' }); return true; }
        if (selected.kind === 'google-sheets-export') authorizeExport(req);
        json(res, 200, await invoke(selected, value.input, value.invocationId));
      } else json(res, 405, { error: 'Method unavailable' });
    } catch (error) { json(res, error.status ?? 400, { code: error.code ?? 'POC_REQUEST_REJECTED',
      error: ['INVALID_WORKFLOW', 'WORKFLOW_CAPABILITY_CHANGED'].includes(error.code) ? error.message : 'The DKG request did not confirm a result' }); }
    return true;
  }
  return { list, invoke, workflows, studio, handle, close() { studio?.stop(); provider?.close(); } };
}
