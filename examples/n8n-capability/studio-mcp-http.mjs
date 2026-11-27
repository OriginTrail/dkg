import { fail, mcpActor, record, closed } from './studio-mcp-contract.mjs';
import { readRequestBodyBytesBounded, RequestBodyLimitError } from './request-body.mjs';

const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const text = { type: 'string' }, pin = { kaRef: text, workflowSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } };
const tools = [
  ['studio_list', 'List saved read-only native Studio workflows.', schema({}), 'list'],
  ['studio_get', 'Inspect one exact saved workflow revision.', schema(pin), 'get'],
  ['studio_run', 'Admit one native run; retain runKey and read until terminal. Never mint a new key to retry.',
    schema({ ...pin, runKey: text, arguments: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } } }), 'run'],
  ['studio_run_read', 'Read or reconcile the same account run without dispatching it again.', schema({ runKey: text }), 'readRun'],
  ['studio_withdraw', 'Owner only: withdraw a saved revision from future tool runs.', schema(pin), 'withdraw'],
];
export function studioMcpFlags(env = process.env) {
  for (const key of ['NOS_STUDIO_MCP', 'NOS_STUDIO_MCP_AGENT_PREVIEW'])
    if (![undefined, '', '0', '1'].includes(env[key])) throw new Error('Invalid Studio MCP switch.');
  const enabled = env.NOS_STUDIO_MCP === '1', agentEnabled = env.NOS_STUDIO_MCP_AGENT_PREVIEW === '1';
  if ((enabled || agentEnabled) && env.NODE_ENV !== 'development') throw new Error('Studio MCP is development-only.');
  if (agentEnabled && !enabled) throw new Error('Agent preview requires Studio MCP.');
  return { enabled, agentEnabled };
}
export function createStudioMcpHttp({ service, session, agentEnabled = false }) {
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  return async (req, res) => {
    let actor;
    try { actor = mcpActor(session, req.headers, agentEnabled); }
    catch { json(res, 403, { error: 'STUDIO_MCP_FORBIDDEN' }); return; }
    if (req.headers['mcp-protocol-version'] && req.headers['mcp-protocol-version'] !== '2025-06-18') { json(res, 400, { error: 'STUDIO_MCP_PROTOCOL_UNSUPPORTED' }); return; }
    if (req.method !== 'POST') { json(res, 405, { error: 'STUDIO_MCP_POST_REQUIRED' }); return; }
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) { json(res, 415, { error: 'STUDIO_MCP_JSON_REQUIRED' }); return; }
    let value;
    try {
      const bytes = await readRequestBodyBytesBounded(req, 16_384);
      value = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      const tooLarge = error instanceof RequestBodyLimitError;
      if (tooLarge) res.shouldKeepAlive = false;
      json(res, tooLarge ? 413 : error.status ?? 400, { error: 'STUDIO_INVALID_REQUEST' }); return;
    }
    if (closed(value, ['jsonrpc', 'method']) && value.jsonrpc === '2.0' && value.method === 'notifications/initialized') {
      res.writeHead(202); res.end(); return;
    }
    if (!closed(value, ['jsonrpc', 'id', 'method', 'params']) || value.jsonrpc !== '2.0'
      || !(typeof value.id === 'string' && value.id.length <= 128 || Number.isSafeInteger(value.id))
      || typeof value.method !== 'string') { json(res, 400, { error: 'STUDIO_INVALID_REQUEST' }); return; }
    const reply = result => json(res, 200, { jsonrpc: '2.0', id: value.id, result });
    if (value.method === 'initialize') { reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'nos-studio', version: '0.1.0' } }); return; }
    if (value.method === 'ping') { reply({}); return; }
    if (value.method === 'tools/list') {
      reply({ tools: tools.filter(t => !actor.startedBy || t[3] !== 'withdraw')
        .map(([name, description, inputSchema]) => ({ name, description, inputSchema })) }); return;
    }
    if (value.method !== 'tools/call') { json(res, 200, { jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Method not found' } }); return; }
    try {
      if (!closed(value.params, ['name', 'arguments']) || !record(value.params.arguments)) throw fail('STUDIO_INVALID_ARGUMENTS', 400);
      const tool = tools.find(t => t[0] === value.params.name);
      if (!tool) { json(res, 200, { jsonrpc: '2.0', id: value.id, error: { code: -32602, message: 'Unknown tool' } }); return; }
      const result = tool[3] === 'list'
        ? (Object.keys(value.params.arguments).length ? (() => { throw fail('STUDIO_INVALID_ARGUMENTS', 400); })() : { workflows: service.list(actor) })
        : await service[tool[3]](value.params.arguments, actor);
      reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      const code = /^STUDIO_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'STUDIO_REQUEST_REJECTED';
      reply({ isError: true, content: [{ type: 'text', text: code }], structuredContent: { code } });
    }
  };
}
