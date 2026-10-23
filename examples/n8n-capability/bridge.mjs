import { canonicalizeJson } from '../../packages/core/dist/index.js';
import { loadExecutionOutputs } from '../../packages/cli/dist/semantic-runtime-execution-persistence.js';
import { iriValue, resultRows } from '../../packages/cli/dist/semantic-runtime-values.js';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

const SR = 'https://origintrail.io/semantic-runtime/v1#';
const prefix = '/spike/ka/accounts/account-a/capabilities';
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };

export function createCapabilityBridge({ agent, client, graphId, owner, config, definitions = [], exportTokenFile }) {
  async function list() {
    const result = await agent.query(`SELECT DISTINCT ?program WHERE { GRAPH ?g {
      ?program a <${SR}Program>; <${SR}requiresTool> <urn:dkg:tool:n8n> . } }`,
    { contextGraphId: graphId, view: 'working-memory', callerAgentAddress: owner });
    const capabilities = [];
    for (const row of resultRows(result)) {
      const kaRef = iriValue(row.program);
      const definition = definitions.find(item => item.kaRef === kaRef);
      const binding = config.programBindings?.find(item => item.operationIri === kaRef && item.contextGraphId === graphId && item.enabled && item.n8n);
      if (!binding && !definition) continue;
      const source = await client.programs.getSource({ graphId, programIri: kaRef, programLayer: 'wm' });
      if (binding && source.sourceHash !== binding.program.sourceHash) continue;
      const available = !!binding && definition?.enabled !== false;
      capabilities.push({ kaRef, graphId, sourceHash: source.sourceHash, name: source.label ?? 'n8n capability', version: source.version,
        kind: definition?.kind ?? 'text', available,
        ...(definition?.kind === 'google-sheets-export' ? { requiresExportAuthorization: true,
          ...(!available ? { unavailableReason: 'Connect a Google Sheets OAuth credential in n8n to enable this KA.' } : {}) } : {}) });
    }
    return capabilities;
  }
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
    const origin = req.headers.origin;
    if (origin && !['http://127.0.0.1:4620', 'http://localhost:4620'].includes(origin)) { json(res, 403, { error: 'Local console origin required' }); return true; }
    const identity = req.headers.authorization;
    if (!['Bearer l1-owner-a', 'Bearer l1-viewer-a'].includes(identity)
      || ![prefix, prefix + '/invoke'].includes(path)) { json(res, 403, { error: 'Account access denied' }); return true; }
    try {
      if (path === prefix && req.method === 'GET') json(res, 200, { capabilities: await list(), canInvoke: identity === 'Bearer l1-owner-a' });
      else if (path === prefix + '/invoke' && req.method === 'POST') {
        if (identity !== 'Bearer l1-owner-a') { json(res, 403, { error: 'Invocation denied' }); return true; }
        let bytes = 0, body = '';
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new Error('Request too large'); body += chunk; }
        const value = JSON.parse(body);
        if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['kaRef', 'sourceHash', 'input', 'invocationId'].includes(key))) throw new Error('Invalid invocation');
        const selected = (await list()).find(item => item.kaRef === value.kaRef && item.sourceHash === value.sourceHash);
        if (!selected) { json(res, 409, { error: 'Approved KA version changed' }); return true; }
        if (!selected.available) { json(res, 409, { error: 'This component needs an operator connection before invocation.' }); return true; }
        if (selected.kind === 'google-sheets-export') {
          const supplied = req.headers['x-dkg-export-token'];
          let authorized = false;
          if (typeof supplied === 'string' && supplied.length <= 256 && exportTokenFile) {
            try { const expected = readFileSync(exportTokenFile, 'utf8').trim();
              const a = Buffer.from(supplied), b = Buffer.from(expected);
              authorized = b.length >= 32 && a.length === b.length && timingSafeEqual(a, b); } catch {}
          }
          if (!authorized) { json(res, 403, { error: 'Operator export authorization required' }); return true; }
        }
        json(res, 200, await invoke(selected, value.input, value.invocationId));
      } else json(res, 405, { error: 'Method unavailable' });
    } catch (error) { json(res, error.status ?? 400, { code: error.code ?? 'POC_REQUEST_REJECTED', error: 'The DKG invocation did not confirm a result' }); }
    return true;
  }
  return { list, invoke, handle };
}
