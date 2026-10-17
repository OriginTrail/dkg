/** Disposable child for publisher-live-control-restart.mts; never targets an operator data directory. */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { generateEd25519Keypair } from '../../packages/core/dist/index.js';
import { GraphManager, OxigraphStore } from '../../packages/storage/dist/index.js';
import { TripleStoreAsyncLiftPublisher } from '../../packages/publisher/dist/index.js';
import { startPublisherRuntimeIfEnabled } from '../../packages/cli/src/publisher-runner.js';
import { handlePublisherLiveControlRoute } from '../../packages/cli/src/daemon/routes/publisher-live-control.js';
import { createAllowedHttpAuthentication } from '../../packages/cli/src/auth.js';
import { kaVmPublishRequest, stageKnowledgeAssetShareSnapshot } from '../testing/ka-vm-publish.js';

const [dataDir, token, startupProbe] = process.argv.slice(2);
if (!process.send || !dataDir || !token) throw new Error('Use the parent restart campaign');
const store = new OxigraphStore(join(dataDir, 'queue.nq'));
const admission = new TripleStoreAsyncLiftPublisher(store);
let startupAccepted: { jobId: string; job: unknown } | undefined;
if (startupProbe === 'startup-pause') {
  const shareOperationId = 'startup-pause-operation';
  const base = kaVmPublishRequest();
  const kaUal = base.kaUal.replace(/\/7$/, '/8');
  await stageKnowledgeAssetShareSnapshot({ store, shareOperationId, kaUal });
  const jobId = await admission.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
    name: 'maintenance-startup', shareOperationId, kaUal, reservedUal: kaUal, kaNumber: '8',
    seal: { ...base.seal, reservedKaId: (BigInt(base.seal.reservedKaId!) + 1n).toString() as `${bigint}` },
    intentKey: `sha256:${'cd'.repeat(32)}` }));
  await store.flush();
  startupAccepted = { jobId, job: await admission.getStatus(jobId) };
}
const runtime = await startPublisherRuntimeIfEnabled({ dataDir, store,
  keypair: await generateEd25519Keypair(),
  config: { publisher: { enabled: true, pollIntervalMs: 30, errorBackoffMs: 30, maxRetries: 0 } }, log: () => {},
  knowledgeAssetVmPublishHandler: { execute: async input => {
    process.send?.({ type: 'executing', walletId: input.walletId });
    throw new Error('Isolated no-chain campaign execution boundary reached');
  } },
});
if (!runtime) throw new Error('Missing live publisher runtime');
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
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
process.send({ type: 'ready', url: `http://127.0.0.1:${address.port}`, pid: process.pid, startupAccepted });
process.once('SIGTERM', async () => {
  server.close(); server.closeAllConnections();
  await runtime.stop(); await store.close(); process.disconnect?.();
});
