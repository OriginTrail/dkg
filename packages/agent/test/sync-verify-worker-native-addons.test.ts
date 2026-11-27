import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';

const threads = vi.hoisted(() => ({ execArgv: [] as string[] }));
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return { ...actual, Worker: class extends actual.Worker {
    constructor(path: string, options: ConstructorParameters<typeof actual.Worker>[1] = {}) {
      super(path, { ...options, execArgv: threads.execArgv });
    }
  } };
});

it('keeps the native addon out of a real verification thread, which can be terminated while it loads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dkg-sync-verify-addons-'));
  const log = join(directory, 'addons.log');
  const preload = join(directory, 'report-addons.cjs');
  writeFileSync(preload, `const { appendFileSync } = require('node:fs');
const load = process.dlopen;
process.dlopen = function (module, filename, ...rest) {
  appendFileSync(${JSON.stringify(log)}, filename + '\\n');
  return load.call(this, module, filename, ...rest);
};`);
  threads.execArgv = ['--require', preload];
  const addons = () => existsSync(log) ? readFileSync(log, 'utf8') : '';
  try {
    // The verifier now imports a transport-free surface. Use the public core
    // barrel as an independent positive control for addon instrumentation.
    const control = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData).then(() => parentPort.postMessage('loaded'));
    `, { eval: true, workerData: import.meta.resolve('@origintrail-official/dkg-core') });
    await new Promise(resolve => control.once('message', resolve));
    await control.terminate();
    expect(addons()).toContain('bufferutil');
    rmSync(log);

    const worker = new SyncVerifyWorker();
    await worker.parseAndFilter('', 'urn:g', 'test');
    await worker.close();
    expect(addons()).toBe('');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
