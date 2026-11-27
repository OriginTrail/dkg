/** Local integration proof. All node data/keys below are fictional; no JPB/tailnet connection.
 * node --import /path/to/tl-nos/node_modules/tsx/dist/loader.mjs verify-nos-runner.mjs /path/to/tl-nos
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createNosNodeClient, invokeNosProgram, writeNosEvidence } from './nos-node-transport.mjs';
import { loadNosStudioSession } from './nos-studio-session.mjs';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Supply the tl-nos checkout.');
const moduleAt = path => import(pathToFileURL(join(root, path)).href);
const { createStudioAccess } = await moduleAt('apps/control-plane/src/l1/studio-access.ts');
const { NodeClient } = await moduleAt('apps/control-plane/src/l1/node-client.ts');
const { startDevelopmentNodeRunner } = await moduleAt('apps/node-runner/src/development-node.ts');
const dir = mkdtempSync(join(tmpdir(), 'nos-studio-integration-'));
const nodeSecret = 'fictional-node-api-token-1234567890';
const runnerSecret = 'fictional-runner-service-secret-1234567890';
const serviceSecret = 'fictional-studio-service-secret-1234567890';
const tokenFile = join(dir, 'node.token'), runnerFile = join(dir, 'runner.secret'), serviceFile = join(dir, 'studio.secret');
for (const [file, text] of [[tokenFile, nodeSecret], [runnerFile, runnerSecret], [serviceFile, serviceSecret]]) writeFileSync(file, text, { mode: 0o600 });
const programSource = 'return inputs.map(x => x.quantity * 2);';
const agentAddress = '0x' + '1'.repeat(40);
const selected = { contextGraphId: 'study', operationIri: 'urn:test:calculate', bindingDigest: 'b'.repeat(64), version: '1',
  program: { contextGraphId: 'programs', programIri: 'urn:test:calculator', programLayer: 'wm', authorAgentAddress: agentAddress,
    sourceHash: createHash('sha256').update(programSource).digest('hex') } };
let sourceChanged = false, revoked = false, creates = 0, executes = 0, stored;
const hits = [], invocations = new Map();
const node = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, 'Bearer ' + nodeSecret);
    assert.equal(req.headers['x-nos-workflows-secret'], undefined);
    hits.push(req.url);
    const url = new URL(req.url, 'http://127.0.0.1');
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const reply = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/status') return reply({ peerId: 'fictional-peer-123' });
    if (url.pathname === '/api/query') return reply({ records: [{ quantity: 3 }] });
    if (url.pathname.startsWith('/api/programs/')) assert.equal(req.headers['x-dkg-program-agent'], agentAddress);
    if (url.pathname === '/api/programs/bindings') return reply({ bindingDigest: selected.bindingDigest,
      binding: { enabled: true, program: selected.program, executorAgentAddress: agentAddress, allowedCallerAgentAddresses: [agentAddress] } });
    if (url.pathname === '/api/programs/source') return reply({ source: sourceChanged ? 'changed' : programSource, version: '1' });
    if (url.pathname === '/api/programs/execute') {
      if (!invocations.has(body.invocationId)) { executes++; invocations.set(body.invocationId, {
        persisted: true, invocationId: body.invocationId, executionIri: 'urn:sr:execution:' + body.invocationId,
        outputs: [JSON.stringify({ calculated: true, total: body.inputs[0].quantity * 2 })] }); }
      return reply(invocations.get(body.invocationId));
    }
    if (url.pathname === '/api/knowledge-assets') { assert.equal(body.alsoPublishVm, false); stored = body; creates++; return reply({}); }
    if (url.pathname.startsWith('/api/knowledge-assets/')) {
      if (!stored) return reply({ error: 'missing' }, 404);
      return reply(url.pathname.endsWith('/wm/quads') ? { quads: stored.quads } : { status: 'wm-sealed', reservedUal: 'urn:test:asset:1' });
    }
    reply({ error: 'not found' }, 404);
  } catch { res.writeHead(500); res.end('{}'); }
});
let runner;
const previousEnv = process.env.NODE_ENV;
try {
  node.listen(0, '127.0.0.1'); await once(node, 'listening');
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const runnerPort = reserve.address().port; await new Promise(r => reserve.close(r));
  process.env.NODE_ENV = 'development';
  runner = startDevelopmentNodeRunner({ nodeId: 'bound-node', peerId: 'fictional-peer-123', port: runnerPort,
    nodePort: node.address().port, tokenFile, secretFile: runnerFile, graphs: ['study', 'source'],
    programs: { agentAddress, programs: [{ contextGraphId: selected.contextGraphId, operationIri: selected.operationIri, bindingDigest: selected.bindingDigest, program: selected.program }] } });
  await once(runner, 'listening');
  const client = new NodeClient({ configured: true, async of(id) {
    assert.equal(id, 'bound-node'); return { id: 'test-server', accepting: false, runner: new URL(`http://127.0.0.1:${runnerPort}`), secret: runnerSecret };
  } });
  const sessionFile = join(dir, 'session.json');
  writeFileSync(sessionFile, JSON.stringify({ accountId: 'account-dev', controlPlaneUrl: 'http://127.0.0.1:4610', secretFile: serviceFile }));
  const session = loadNosStudioSession(sessionFile); session.bindState(dir);
  const cp = createStudioAccess({
    binding: { accountId: 'account-dev', jobId: 'bound-node', peerId: 'fictional-peer-123', url: 'http://127.0.0.1:4631', secret: serviceSecret },
    identity: { resolve: async h => h === 'Bearer fictional-user-session' ? { principalId: 'person-dev' } : null },
    principalOf: async p => p.principalId,
    roleOf: async (p, a) => !revoked && p === 'person-dev' && a === 'account-dev' ? 'owner' : undefined,
    requestId: () => 'request-test',
    node: async (account, id, call) => { assert.equal(account, 'account-dev'); return client.call(id, call); },
    fetch: async (_url, init) => Response.json(session.actor(init.headers)),
  });
  const authenticated = await cp(new Request('http://127.0.0.1/studio/account-dev/api/studio', { headers: { authorization: 'Bearer fictional-user-session' } }));
  assert.equal(authenticated.status, 200);
  const actor = await authenticated.json();
  const call = createNosNodeClient(session, actor, (url, init) => cp(new Request(url, init)));
  const rows = await call('query', { contextGraphId: 'source', sparql: 'SELECT * WHERE {?s ?p ?o} LIMIT 20' });
  const request = { selected, invocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', inputs: rows.records };
  const calculated = await invokeNosProgram(call, request);
  assert.deepEqual(calculated.outputs, [{ calculated: true, total: 6 }]);
  const evidence = JSON.stringify(calculated.outputs[0]);
  const payload = { name: 'calculated-study', digest: createHash('sha256').update(evidence).digest('hex'), allowCreate: true,
    quads: [{ subject: 'urn:test:study', predicate: 'urn:nos:workflow:payload', object: JSON.stringify(evidence) }] };
  const receipt = await writeNosEvidence(call, payload, 'study');
  assert.equal(receipt.metadata.status, 'wm-sealed'); assert.equal(receipt.readbackVerified, true);
  await invokeNosProgram(call, request);
  await writeNosEvidence(call, { ...payload, allowCreate: false }, 'study');
  assert.equal(executes, 1); assert.equal(creates, 1);
  sourceChanged = true;
  // Bypass the companion's own pin check to exercise the runner's independent guard.
  await assert.rejects(call('programs/execute', { contextGraphId: selected.contextGraphId, operationIri: selected.operationIri,
    invocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', inputs: rows.records }));
  assert.equal(executes, 1);
  const before = hits.length; revoked = true;
  await assert.rejects(call('query', { contextGraphId: 'source' })); assert.equal(hits.length, before);
  console.log(JSON.stringify({ passed: true, evidence: 'local module integration against fictional HTTP node',
    path: 'nOS identity -> account companion -> nOS membership recheck -> existing NodeClient -> existing node proxy -> DKG API',
    calculatedTotal: 6, sealedAssets: creates, uniqueProgramInvocations: executes, readbackVerified: true,
    changedSourceRefusedByRunner: true, ownerRevocationRefused: true, customerBearerForwarded: false, jpbContacted: false }, null, 2));
} finally {
  if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
  for (const server of [runner, node]) if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  rmSync(dir, { recursive: true, force: true });
}
