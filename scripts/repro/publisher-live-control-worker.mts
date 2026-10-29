/** Disposable child for publisher-live-control-restart.test.mts; never targets an operator data directory. */
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { generateEd25519Keypair } from '../../packages/core/dist/index.js';
import { GraphManager, OxigraphStore } from '../../packages/storage/dist/index.js';
import { TripleStoreAsyncLiftPublisher } from '../../packages/publisher/dist/index.js';
import { startPublisherRuntimeIfEnabled } from '../../packages/cli/src/publisher-runner.js';
import { handlePublisherLiveControlRoute } from '../../packages/cli/src/daemon/routes/publisher-live-control.js';
import { beginGracefulShutdown } from '../../packages/cli/src/daemon/teardown.js';
import { createAllowedHttpAuthentication } from '../../packages/cli/src/auth.js';
import { kaVmPublishRequest, stageKnowledgeAssetShareSnapshot } from '../testing/ka-vm-publish.js';

const [dataDir, token, startupProbe] = process.argv.slice(2);
if (!process.send || !dataDir || !token) throw new Error('Use the parent restart campaign');
// Hold one actual control-file fsync, leaving HTTP and the SIGTERM listener live.
let holdControlFsync = false;
let releaseControlFsync: (() => void) | undefined;
const originalOpen = fs.open;
fs.open = async (...args: Parameters<typeof fs.open>) => {
  const file = await originalOpen(...args);
  if (holdControlFsync && args[1] === 'wx' && String(args[0]).startsWith(join(dataDir, 'publisher-control.json.'))) {
    holdControlFsync = false;
    const sync = file.sync.bind(file);
    file.sync = async () => {
      const held = new Promise<void>(resolve => { releaseControlFsync = resolve; });
      process.send?.({ type: 'control-fsync-held' });
      await held; await sync();
    };
  }
  return file;
};
syncBuiltinESMExports();
let executions = 0;
const store = new OxigraphStore(join(dataDir, 'queue.nq'));
const admission = new TripleStoreAsyncLiftPublisher(store);
let startupAccepted: { jobId: string; job: unknown } | undefined;
if (startupProbe) {
  const shutdownProbe = startupProbe === 'shutdown-pause';
  const shareOperationId = shutdownProbe ? 'shutdown-pause-operation' : 'startup-pause-operation';
  const base = kaVmPublishRequest();
  const kaNumber = shutdownProbe ? '9' : '8';
  const kaUal = base.kaUal.replace(/\/7$/, `/${kaNumber}`);
  await stageKnowledgeAssetShareSnapshot({ store, shareOperationId, kaUal });
  const jobId = await admission.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
    name: `maintenance-${startupProbe}`, shareOperationId, kaUal, reservedUal: kaUal, kaNumber,
    seal: { ...base.seal, reservedKaId: (BigInt(base.seal.reservedKaId!) + BigInt(kaNumber) - 7n).toString() as `${bigint}` },
    intentKey: `sha256:${(shutdownProbe ? 'ef' : 'cd').repeat(32)}` }));
  await store.flush();
  startupAccepted = { jobId, job: await admission.getStatus(jobId) };
}
const runtime = await startPublisherRuntimeIfEnabled({ dataDir, store,
  keypair: await generateEd25519Keypair(),
  config: { publisher: { enabled: true, pollIntervalMs: 30, errorBackoffMs: 30, maxRetries: 0 } }, log: () => {},
  knowledgeAssetVmPublishHandler: { execute: async input => {
    executions++;
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
process.on('message', async (message: { id: number; action: 'enqueue' | 'status' | 'hold-resume-fsync' | 'release-resume-fsync'; jobId?: string }) => {
  try {
    let result: unknown;
    if (message.action === 'enqueue') {
      await stageKnowledgeAssetShareSnapshot({ store, graphManager: new GraphManager(store) });
      const jobId = await admission.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      await store.flush();
      result = { jobId, job: await admission.getStatus(jobId) };
    } else if (message.action === 'hold-resume-fsync') { holdControlFsync = true; result = true; }
    else if (message.action === 'release-resume-fsync') { releaseControlFsync?.(); result = true; }
    else result = await admission.getStatus(message.jobId!);
    process.send?.({ id: message.id, result });
  } catch (error) { process.send?.({ id: message.id, error: String(error) }); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
process.send({ type: 'ready', url: `http://127.0.0.1:${address.port}`, pid: process.pid, startupAccepted });
process.once('SIGTERM', async () => {
  await beginGracefulShutdown({ state: { catchupAcceptingJobs: true }, publisherControl: runtime.control,
    removeApiPort: async () => {}, log: () => {} });
  process.send?.({ type: 'shutdown-fenced', effectiveState: runtime.control.status().effectiveState });
  await new Promise<void>(resolve => server.close(() => resolve()));
  await runtime.stop();
  await fs.writeFile(join(dataDir, 'shutdown-result.json'), JSON.stringify({ executions,
    job: startupAccepted ? await admission.getStatus(startupAccepted.jobId) : undefined }));
  await store.close(); process.disconnect?.();
});
