import { createStudioContext } from './studio-context.mjs';
import { isDkg, dkgComponentStore } from './dkg-components.mjs';
import { canonicalizeJson } from '../../packages/core/dist/index.js';
import { mapWithConcurrency } from '../../packages/agent/dist/map-with-concurrency.js';
import { loadExecutionOutputs } from '../../packages/cli/dist/semantic-runtime-execution-persistence.js';
import { iriValue, resultRows } from '../../packages/cli/dist/semantic-runtime-values.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { persistProgramKnowledgeAsset } from '../../packages/cli/dist/semantic-runtime-execution-persistence.js';
import { createWorkflowService } from './workflow-service.mjs';
import { WORKFLOW_PREFIX } from './workflow-definition.mjs';
import { createStudioMcpService } from './studio-mcp-service.mjs';
import { createStudioMcpHttp, studioMcpFlags } from './studio-mcp-http.mjs';
import { createStudioProvider } from './studio-provider.mjs';
import { createStudioRepository } from './studio-repository.mjs';
import { createStudioService } from './studio-service.mjs';
import { normalizeComponentInput } from './component-registry.mjs';
import { STUDIO_PREFIX } from './studio-definition.mjs';
import { createProgramCatalog } from './program-catalog.mjs';
import { capabilityPrefix, capabilityRoutes, matchCapabilityRoute } from './capability-routes.mjs';
import { readRequestBodyBytesBounded, RequestBodyLimitError } from './request-body.mjs';

const SR = 'https://origintrail.io/semantic-runtime/v1#';
const nativeCallback = capabilityRoutes.find(route => route.id === 'dkgComponent');
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };

/** Shared by the bridge and transport-level regression fixtures. */
export async function handleDkgComponentCallback(req, res, studio, config, mcp) {
  try {
    const token=readFileSync(config.n8nNative.webhookTokenFile,'utf8').trim();
    const expected=Buffer.from('Bearer '+token), supplied=Buffer.from(String(req.headers.authorization??''));
    if(!studio || !nativeCallback.methods.includes(req.method) || Object.hasOwn(req.headers, 'origin') || token.length<32 || expected.length!==supplied.length || !timingSafeEqual(expected,supplied)) { json(res,403,{error:'Native DKG component access denied'});return true; }
    const bytes = await readRequestBodyBytesBounded(req, nativeCallback.bodyLimit);
    const value = JSON.parse(bytes.toString('utf8'));
    const nativeResult = mcp ? await mcp.dkgComponent(value) : undefined;
    json(res,200,nativeResult === undefined ? await studio.dkgComponent(value) : nativeResult);
  } catch(e) {
    const tooLarge = e instanceof RequestBodyLimitError;
    if (tooLarge) res.shouldKeepAlive = false;
    json(res, tooLarge ? 413 : e.status ?? 409, { code: e.code ?? 'DKG_COMPONENT_UNCONFIRMED', error: tooLarge ? 'Bounded DKG batch required' : e.message });
  }
}

export function createCapabilityBridge({ agent, client, graphId, owner, config, definitions = [], exportTokenFile, studioOptions, programAuthority, context = createStudioContext() }) {
  const { session, profile, compiler, registry } = context;
  const { componentNeedsExport } = registry;
  const prefix = capabilityPrefix(session?.accountId ?? 'account-a');
  if (!session && studioOptions && existsSync(join(studioOptions.state, 'nos-account.json')))
    throw new Error('This state requires its authenticated nOS account configuration.');
  const commitAccountBinding = session && studioOptions ? session.prepareStateBinding(studioOptions.state) : null;
  if (session && profile && (!profile.requiresNosActor || profile.accountId !== session.accountId))
    throw new Error('Authenticated Studio requires an account-bound nOS transport profile.');
  const listPrograms = createProgramCatalog({ graphId, owner, client, definitions });
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
  async function loadCapability(definition) {
    const kaRef = definition.kaRef;
    const [approval, source] = await Promise.all([
      client.programs.getApproval({ graphId, operationIri: kaRef }).catch(error => { if (error.status !== 404) throw error; }),
      client.programs.getSource({ graphId, programIri: kaRef, programLayer: 'wm' }),
    ]);
    const binding = approval?.binding;
    const sameOwner = address => typeof address === 'string' && address.toLowerCase() === owner.toLowerCase();
    const available = definition.enabled !== false && binding?.enabled === true && !!binding.n8n
      && binding.contextGraphId === graphId && binding.operationIri === kaRef
      && sameOwner(binding.executorAgentAddress) && binding.allowedCallerAgentAddresses?.some(sameOwner) === true
      && binding.program?.contextGraphId === graphId && binding.program.programIri === kaRef && binding.program.programLayer === 'wm'
      && binding.program.sourceHash === source.sourceHash
      && typeof source.authorAgentAddress === 'string'
      && binding.program.authorAgentAddress?.toLowerCase() === source.authorAgentAddress.toLowerCase();
    return { kaRef, graphId, sourceHash: source.sourceHash, name: source.label ?? 'n8n capability', version: source.version,
      kind: definition.kind ?? 'text', available,
      ...(definition.retired ? { retired: true } : {}),
      ...(definition.kind === 'component' ? { descriptor: definition.descriptor } : {}),
      ...((definition.requiresExportAuthorization || componentNeedsExport(definition.descriptor) || definition.kind === 'google-sheets-export') ? { requiresExportAuthorization: true } : {}),
      ...(!available && definition.descriptor?.connection ? { unavailableReason: 'Connect ' + definition.descriptor.name + ' OAuth in local n8n, then refresh the operator installation.' } : {}),
      ...(definition.kind === 'google-sheets-export' && !available ? { unavailableReason: 'Connect a Google Sheets OAuth credential in n8n to enable this KA.' } : {}) };
  }
  async function list() {
    const result = await agent.query(`SELECT DISTINCT ?program WHERE { GRAPH ?g {
      ?program a <${SR}Program>; <${SR}requiresTool> <urn:dkg:tool:n8n> . } }`,
    { contextGraphId: graphId, view: 'working-memory', callerAgentAddress: owner });
    const installed = resultRows(result).map(row => definitions.find(item => item.kaRef === iriValue(row.program))).filter(Boolean);
    // Four capabilities at a time, with two independent metadata reads each.
    return mapWithConcurrency(installed, 4, loadCapability);
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
  const repository = studioOptions ? createStudioRepository(studioOptions.state) : null;
  const provider = repository && config.n8nNative ? createStudioProvider({ ...studioOptions, compiler, repository, config, graphId, owner }) : null;
  let studio, mcp, mcpHttp;
  try {
    if (session && repository?.hasActiveWorkflows())
      throw new Error('Deactivate legacy schedules before adopting Studio state for an account.');
    if (session && repository?.pendingUnpublications().length)
      throw new Error('Complete pending legacy schedule cleanup before adopting Studio state for an account.');
    const dkg = repository ? dkgComponentStore(repository.db, profile) : undefined;
    studio = repository ? createStudioService({ compiler, graphId, owner, client, repository, provider, dkg, programAuthority, exportTokenFile, eventsEnabled: !session,
      listCapabilities: async () => [...await list(), ...await listPrograms()],
      loadOutputs: executionIri => loadExecutionOutputs(agent, graphId, executionIri, 'wm', owner) }) : null;
    const mcpFlags = studioMcpFlags();
    if (mcpFlags.enabled && (!session || !provider)) throw new Error('Studio MCP requires an authenticated account companion.');
    mcp = mcpFlags.enabled ? createStudioMcpService({ compiler, repository, provider, dkg, installation: config.n8nNative, accountId: session.accountId }) : null;
    mcpHttp = mcp ? createStudioMcpHttp({ service: mcp, session: session, agentEnabled: mcpFlags.agentEnabled }) : null;
    commitAccountBinding?.();
  } catch (error) { studio?.stop(); repository?.close(); throw error; }
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
  const handlers = {
    list: async ({ res, ownerAccess }) => json(res, 200, { capabilities: (await list()).filter(c => c.kind !== 'component'), canInvoke: ownerAccess }),
    workflows: async ({ res }) => json(res, 200, { workflows: await workflows.list() }),
    workflowSave: async ({ res, value, authorize }) => json(res, 200, await workflows.save(value, authorize)),
    workflowRun: async ({ res, value, authorize }) => json(res, 200, await workflows.run(value, authorize)),
    studio: async ({ res, ownerAccess }) => json(res, 200, { capabilities: [...(await list()).filter(c => c.kind === 'component'), ...await listPrograms()], workflows: await studio.list(), canInvoke: ownerAccess }),
    studioSave: async ({ res, value, authorize }) => json(res, 200, await studio.save(value, authorize)),
    studioRun: async ({ res, value, authorize, actor }) => json(res, 200, await studio.run(value, authorize, actor)),
    studioActivation: async ({ res, value, authorize }) => json(res, 200, await studio.activate(value, authorize)),
    studioHistory: async ({ res, params, ownerAccess, authorize }) => json(res, 200, await studio.history(params.get('kaRef'), needsExport => {
      if (!ownerAccess || session) return false;
      try { if (needsExport) authorize(); return true; } catch { return false; }
    })),
    studioInvoke: async ({ res, value, authorize }) => {
      const selected = (await list()).find(c => c.kind === 'component' && c.kaRef === value.kaRef && c.sourceHash === value.sourceHash && c.available);
      if (!selected) throw Object.assign(new Error('Component revision unavailable.'), { code: 'WORKFLOW_CAPABILITY_CHANGED', status: 409 });
      if (isDkg(selected.descriptor.id)) throw Object.assign(new Error('Compose DKG Read / Write inside a saved native workflow.'), { status: 400 });
      if (selected.requiresExportAuthorization) authorize();
      let input; try { input = normalizeComponentInput(selected.descriptor, value.input); }
      catch (e) { throw Object.assign(selected.retired ? new Error('This older component version does not accept these inputs. Choose Use current component version, then invoke it again. Your URL and field settings are kept.') : e, { code: 'INVALID_WORKFLOW', status: 400 }); }
      json(res, 200, await invoke(selected, input, value.invocationId));
    },
    inspect: async ({ res, params }) => {
      const kaRef = params.get('kaRef'), sourceHash = params.get('sourceHash');
      if (!sourceHash || !/^[a-f0-9]{64}$/.test(sourceHash)) return json(res, 400, { error: 'An exact KA revision is required.' });
      const selected = kaRef?.startsWith(STUDIO_PREFIX) && studio ? (await studio.get(kaRef, sourceHash)).workflow
        : kaRef?.startsWith(WORKFLOW_PREFIX) ? (await workflows.get(kaRef, sourceHash)).workflow
        : [...await list(), ...await listPrograms()].find(item => item.kaRef === kaRef && item.sourceHash === sourceHash);
      if (!selected) return json(res, 404, { error: 'KA revision unavailable.' });
      const source = await client.programs.getSource({ graphId, programIri: kaRef, programLayer: 'wm' });
      if (source.sourceHash !== sourceHash) return json(res, 409, { error: 'KA revision changed.' });
      json(res, 200, { kaRef, sourceHash, graphId, layer: 'wm', nodeUrl: 'http://127.0.0.1:4631',
        label: source.label, language: source.language, source: source.source, authorAgentAddress: source.authorAgentAddress, readbackVerified: true });
    },
    invoke: async ({ res, value, authorize }) => {
      if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['kaRef', 'sourceHash', 'input', 'invocationId'].includes(key))) throw new Error('Invalid invocation');
      const selected = (await list()).find(item => item.kaRef === value.kaRef && item.sourceHash === value.sourceHash);
      if (!selected) return json(res, 409, { error: 'Approved KA version changed' });
      if (!selected.available) return json(res, 409, { error: 'This component needs an operator connection before invocation.' });
      if (selected.requiresExportAuthorization) authorize();
      json(res, 200, await invoke(selected, value.input, value.invocationId));
    },
    dkgComponent: async ({ req, res }) => handleDkgComponentCallback(req, res, studio, config, mcp),
    event: async ({ res, eventKey, value }) => json(res, 200, await studio.event(eventKey, value)),
    demo: async ({ res, value }) => json(res, 200, { source: 'nOS local demo API', items: [{ name: 'Ana', value: 12 }, { name: 'Luka', value: 7 }], ...(value === undefined ? {} : { received: value }) }),
  };
  async function handle(req, res, path) {
    if (!path.startsWith('/spike/ka/')) return false;
    if (path === prefix + '/studio/mcp') {
      if (mcpHttp) await mcpHttp(req, res);
      else json(res, 404, { error: 'Not found' });
      return true;
    }
    const match = matchCapabilityRoute(path, prefix), route = match?.route;
    if (route?.role === 'native') { await handlers[route.id]({ req, res }); return true; }
    const delegated = route?.role === 'delegated', publicRoute = route?.role === 'public';
    if (delegated && session) { json(res, 403, { error: 'Account Studio supports manual execution only.' }); return true; }
    let actor, ownerAccess = false;
    if (!delegated && !publicRoute) {
      const origin = req.headers.origin;
      if (origin && !['http://127.0.0.1:4620', 'http://localhost:4620'].includes(origin)) { json(res, 403, { error: 'Local console origin required' }); return true; }
      if (session) {
        try { actor = session.actor(req.headers); }
        catch { json(res, 403, { error: 'Authenticated nOS account context required.' }); return true; }
      }
      ownerAccess = session ? actor.role === 'owner' : req.headers.authorization === 'Bearer l1-owner-a';
      const memberAccess = session ? !!actor : ['Bearer l1-owner-a', 'Bearer l1-viewer-a'].includes(req.headers.authorization);
      if (!memberAccess || !route) { json(res, 403, { error: 'Account access denied' }); return true; }
      if (session && route.legacyOnly) { json(res, 403, { error: 'Account Studio supports manual execution only.' }); return true; }
    }
    if (!route.methods.includes(req.method)) { json(res, 405, { error: 'Method unavailable' }); return true; }
    if (route.role === 'owner' && !ownerAccess) { json(res, 403, { error: 'Owner access required.' }); return true; }
    if (route.studio && !studio) { json(res, delegated ? 403 : 405, { error: 'Studio unavailable.' }); return true; }
    try {
      let value;
      if (route.bodyLimit) {
        const bytes = await readRequestBodyBytesBounded(req, route.bodyLimit);
        if (bytes.length || !route.optionalBody) value = JSON.parse(bytes.toString('utf8'));
      }
      await handlers[route.id]({ res, value, ownerAccess, actor, eventKey: match.params.eventKey,
        params: new URL(req.url ?? path, 'http://127.0.0.1:4631').searchParams, authorize: () => authorizeExport(req) });
    } catch (error) {
      const tooLarge = error instanceof RequestBodyLimitError;
      if (tooLarge) res.shouldKeepAlive = false;
      json(res, tooLarge ? 413 : error.status ?? 400, { code: error.code ?? (delegated ? 'EVENT_UNCONFIRMED' : 'POC_REQUEST_REJECTED'),
        ...(error.code === 'DKG_WRITE_PENDING' ? { invocationId: error.invocationId, n8nExecutionId: error.n8nExecutionId } : {}),
        error: delegated ? 'The event did not confirm a result. Retain its invocationId.'
          : error.code === 'DKG_WRITE_PENDING' ? 'The DKG write is unconfirmed. Retry this invocation; do not start another run.'
          : ['INVALID_WORKFLOW', 'WORKFLOW_CAPABILITY_CHANGED'].includes(error.code) ? error.message : 'The DKG request did not confirm a result' });
    }
    return true;
  }
  return { list, listPrograms, invoke, workflows, studio, handle, close() { studio?.stop(); repository?.close(); } };
}
