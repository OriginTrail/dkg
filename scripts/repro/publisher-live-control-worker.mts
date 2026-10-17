/** Disposable child for publisher-live-control-restart.mts; never targets an operator data directory. */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { generateEd25519Keypair } from '../../packages/core/dist/index.js';
import { GraphManager, OxigraphStore } from '../../packages/storage/dist/index.js';
import { TripleStoreAsyncLiftPublisher } from '../../packages/publisher/dist/index.js';
import { createPublisherRuntimeFromAgent } from '../../packages/cli/src/publisher-runner.js';
import { handlePublisherLiveControlRoute } from '../../packages/cli/src/daemon/routes/publisher-live-control.js';
import { createAllowedHttpAuthentication } from '../../packages/cli/src/auth.js';
import { kaVmPublishRequest, stageKnowledgeAssetShareSnapshot } from '../testing/ka-vm-publish.js';

const [dataDir, token] = process.argv.slice(2);
if (!process.send || !dataDir || !token) throw new Error('Use the parent restart campaign');
const store = new OxigraphStore(join(dataDir, 'queue.nq'));
const runtime = await createPublisherRuntimeFromAgent({ dataDir, store,
  keypair: await generateEd25519Keypair(), runnerOptions: { pollIntervalMs: 30, errorBackoffMs: 30 }, maxRetries: 0,
  knowledgeAssetVmPublishHandler: { execute: async input => {
    process.send?.({ type: 'executing', walletId: input.walletId });
    throw new Error('Isolated no-chain campaign execution boundary reached');
  } },
});
// The independent admission instance shares RDF, but owns no runner or live gate.
const admission = new TripleStoreAsyncLiftPublisher(store);
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
  try {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    await handlePublisherLiveControlRoute({ req, res, path,
      authentication: createAllowedHttpAuthentication({ mode: 'authenticated', presentedToken: token,
        acceptedToken: token, resolveAgentByToken: () => undefined }),
      publisherState: { runtime },
    } as Parameters<typeof handlePublisherLiveControlRoute>[0]);
    if (!res.writableEnded) res.writeHead(404).end();
  } catch { if (!res.writableEnded) res.writeHead(500).end(); }
});
process.on('message', async (message: { id: number; action: 'enqueue' | 'status'; jobId?: string }) => {
  try {
    let result: unknown;
    if (message.action === 'enqueue') {
      await stageKnowledgeAssetShareSnapshot({ store, graphManager: new GraphManager(store) });
      const jobId = await admission.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      await store.flush();
      result = { jobId, job: await admission.getStatus(jobId) };
    } else result = await admission.getStatus(message.jobId!);
    process.send?.({ id: message.id, result });
  } catch (error) { process.send?.({ id: message.id, error: String(error) }); }
});
await runtime.runner.start();
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
process.send({ type: 'ready', url: `http://127.0.0.1:${address.port}`, pid: process.pid });
process.once('SIGTERM', async () => {
  server.close(); server.closeAllConnections();
  await runtime.stop(); await store.close(); process.disconnect?.();
});
