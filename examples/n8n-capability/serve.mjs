import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DashboardDB, OperationTracker } from '../../packages/node-ui/dist/index.js';
import { createProtocolStores } from '../../packages/cli/dist/daemon/protocol-persistence.js';
import { DKGAgent, KaNumberAllocator } from '../../packages/agent/dist/index.js';
import { MockChainAdapter } from '../../packages/chain/dist/index.js';
import { GraphComputer } from '../../packages/graph-computer/dist/index.js';
import { authenticateHttpRequest } from '../../packages/cli/dist/auth.js';
import { SqliteAgentHttpNonceStore } from '../../packages/cli/dist/agent-http-nonce-store.js';
import { createRequestActor } from '../../packages/cli/dist/daemon/routes/context.js';
import { handleKnowledgeAssetsRoutes } from '../../packages/cli/dist/daemon/routes/knowledge-assets.js';
import { handleSemanticRuntimeRoutes } from '../../packages/cli/dist/daemon/routes/semantic-runtime.js';
import { startConfiguredSemanticRuntime } from '../../packages/cli/dist/semantic-runtime.js';
import { programSource } from './workflow.mjs';
import { createCapabilityBridge } from './bridge.mjs';

const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url));
const { Wallet } = require('ethers');
const state = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Supply the state directory created by setup-n8n.mjs');
const { grant, ...connection } = JSON.parse(readFileSync(join(state, 'n8n.json'), 'utf8'));
const graphId = 'n8n-capability-poc', kaRef = 'urn:demo:n8n:normalize-text:1';
const nodeUrl = 'http://127.0.0.1:4631';
mkdirSync(join(state, 'dkg'), { recursive: true, mode: 0o700 });
const dashDb = new DashboardDB({ dataDir: join(state, 'dkg') });
const protocolStores = createProtocolStores(dashDb, { chainCursorScope: 'n8n-poc-local-mock', changelogEnabled: false });
const tracker = new OperationTracker(dashDb);
const agent = await DKGAgent.create({ name: 'n8n-ka-poc', dataDir: join(state, 'dkg'), listenHost: '127.0.0.1',
  kaNumberAllocator: new KaNumberAllocator(protocolStores.kaNumberStore),
  nodeRole: 'edge', chainAdapter: new MockChainAdapter(), rfc64CatalogActivation: { enabled: false } });
await agent.start();
let server, runtime, nonceDb;
async function stop() {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await runtime?.stop(); nonceDb?.close(); await agent.stop(); dashDb.close();
}
try {
  const identity = agent.listLocalAgents().find(item => item.name === 'n8n-ka-poc-owner') ?? await agent.registerAgent('n8n-ka-poc-owner');
  const owner = identity.agentAddress;
  const signer = new Wallet(agent.getCustodialAgentPrivateKey(owner));
  if (!await agent.contextGraphExists(graphId)) await agent.createContextGraph({ id: graphId, name: 'n8n capability PoC',
    private: true, accessPolicy: 1, allowedAgents: [owner], callerAgentAddress: owner });
  const semanticRuntime = { enabled: true, startupTimeoutMs: 30000, watchdogMs: 1000,
    n8n: { ...connection, workflows: [{ contextGraphId: graphId, executorAgentAddress: owner,
      workflowId: grant.workflowId, workflowSha256: grant.workflowSha256 }] } };
  runtime = await startConfiguredSemanticRuntime(semanticRuntime, { dataDirectory: join(state, 'runtime'), log: () => {} });
  const config = { name: 'n8n-ka-poc', apiPort: 4631, listenPort: 0, nodeRole: 'edge', semanticRuntime };
  const Database = require('better-sqlite3');
  nonceDb = new Database(join(state, 'http-nonces.db'));
  const nonces = new SqliteAgentHttpNonceStore(nonceDb);
  const client = new GraphComputer({ nodeUrl, peerId: agent.peerId, signer, retries: 0 });
  const bridge = createCapabilityBridge({ agent, client, graphId, owner, config: semanticRuntime });
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', nodeUrl), path = url.pathname;
      if (await bridge.handle(req, res, path)) return;
      const authentication = await authenticateHttpRequest({ req, res, authEnabled: true, validTokens: new Set(),
        resolveAgentByToken: token => agent.resolveAgentByToken(token), agentKey: { targetPeerId: agent.peerId, nonces, operatorAgentAddresses: [] } });
      if (!authentication.allowed) return;
      const actor = createRequestActor(authentication, () => owner);
      const ctx = { req, res, url, path, agent, config, actor, authentication, requestAgentAddress: actor.effectiveAgentAddress,
        tracker, semanticRuntimeHost: runtime, ensureSemanticRuntime: async () => runtime };
      if (path.startsWith('/api/knowledge-assets')) await handleKnowledgeAssetsRoutes(ctx);
      else await handleSemanticRuntimeRoutes(ctx);
      if (!res.writableEnded) { res.writeHead(404); res.end('{}'); }
    } catch (error) { if (!res.writableEnded) { res.writeHead(error.status ?? 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: error.code ?? 'POC_REQUEST_FAILED', error: error.message })); } }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(4631, '127.0.0.1', resolve); });
  let program;
  try { program = await client.programs.getSource({ graphId, programIri: kaRef, programLayer: 'wm' }); }
  catch (error) { if (error.code !== 'PROGRAM_NOT_FOUND') throw error; }
  if (program) program = { graphId, programIri: kaRef, programLayer: 'wm', authorAgentAddress: program.authorAgentAddress, sourceHash: program.sourceHash };
  else program = await client.programs.upload({ graphId, programIri: kaRef, name: 'normalize-text-v1', label: 'Normalize text', language: 'typescript-v1',
    source: programSource, version: '1.0.0', requiredTools: [grant.toolIri], requestedPermissions: { graphId, n8n: grant } });
  let approval;
  try { approval = await client.programs.getApproval({ graphId, operationIri: kaRef }); }
  catch (error) { if (error.status !== 404) throw error; }
  if (!approval) await client.programs.approve({ graphId, operationIri: kaRef, program, allowedCallers: [owner], n8n: grant,
    typescript: { children: [], maxCalls: 1, maxConcurrency: 1, timeoutMs: 30000 } });
  const keyFile = join(state, 'caller-key');
  writeFileSync(keyFile, signer.privateKey, { mode: 0o600 });
  writeFileSync(join(state, 'client.json'), JSON.stringify({ nodeUrl, peerId: agent.peerId, graphId, kaRef, keyFile }, null, 2), { mode: 0o600 });
  const capabilities = await bridge.list();
  if (!capabilities.length) throw new Error('Capability KA is missing from DKG query results');
  const invocationId = randomUUID();
  const evidence = await bridge.invoke(capabilities[0], { text: '  hello dkg  ' }, invocationId);
  const replay = await bridge.invoke(capabilities[0], { text: '  hello dkg  ' }, invocationId);
  if (JSON.stringify(evidence) !== JSON.stringify(replay)) throw new Error('Completed invocation did not replay its receipt');
  writeFileSync(join(state, 'evidence.json'), JSON.stringify({ ...evidence, completedReplayVerified: true,
    chain: 'MockChainAdapter; no on-chain transactions', nodeUrl }, null, 2));
  console.log(JSON.stringify({ ready: true, ...evidence, completedReplayVerified: true, nodeUrl }));
  let stopping = false;
  const shutdown = async () => { if (stopping) return; stopping = true; await stop(); };
  process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
} catch (error) { await stop(); throw error; }
