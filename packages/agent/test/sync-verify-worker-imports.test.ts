import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';

it('boots the compiled verifier without transport addons and retains parsing and rejection checks', async () => {
  // Observe actual compiled imports in an isolated worker. No dependency is
  // mocked or disabled: an accidental transport import must fail this test.
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const Module = require('node:module');
    const addons = [], transports = [];
    const dlopen = process.dlopen, load = Module._load;
    process.dlopen = function(module, filename, ...args) {
      addons.push(filename); return dlopen.call(this, module, filename, ...args);
    };
    Module._load = function(request, ...args) {
      if (request === 'bufferutil' || request === 'utf-8-validate' || request === 'ws') transports.push(request);
      return load.call(this, request, ...args);
    };
    import(workerData).then(() => parentPort.postMessage({ addons, transports }));
  `, { eval: true, workerData: new URL('../dist/sync-verify-worker-impl.js', import.meta.url).href });
  try {
    const [boot] = await once(worker, 'message');
    expect(boot).toEqual({ addons: [], transports: [] });
    const parsed = once(worker, 'message');
    worker.postMessage({ id: 1, method: 'parseAndFilter', args: [
      '<urn:a> <urn:p> "a" <urn:g> .\n<urn:b> <urn:p> "b" <urn:other> .\n', 'urn:g', 'test',
    ] });
    const [message] = await parsed;
    expect(message).toMatchObject({ id: 1, result: { totalQuads: 2,
      quads: [{ subject: 'urn:a', predicate: 'urn:p', object: '"a"', graph: 'urn:g' }] } });
    const rejected = once(worker, 'message');
    worker.postMessage({ id: 2, method: 'processDurableBatch', args: [message.result.quads, [], false, { kind: 'fullSnapshot' }] });
    expect((await rejected)[0]).toMatchObject({ id: 2, result: {
      verifiedDataIndexes: [], dataRejectedMissingMeta: 1,
    } });
  } finally { await worker.terminate(); }
});
