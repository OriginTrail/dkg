import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { V10ProofRootMismatchError, V10ProofLeafCountMismatchError, V10ProofChunkOutOfRangeError,
  verifyV10ProofMaterial } from '@origintrail-official/dkg-core';
import { WorkerThreadProofBuilder, WorkerCrashedError } from '../src/proof-worker.js';
import { proofRequest } from './helpers/proof-fixture.js';

const entry = fileURLToPath(new URL('../dist/proof-worker-entry.js', import.meta.url));
const builders: WorkerThreadProofBuilder[] = [];
const directories: string[] = [];
function builder(entryPath = entry) {
  const value = new WorkerThreadProofBuilder({ entryPath });
  builders.push(value);
  return value;
}
function fixture(source: (directory: string) => string) {
  const directory = mkdtempSync(join(tmpdir(), 'dkg-proof-worker-'));
  directories.push(directory);
  const file = join(directory, 'worker.cjs');
  writeFileSync(file, source(directory));
  return file;
}
afterEach(async () => {
  try { await Promise.all(builders.splice(0).map(value => value.close())); }
  finally { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); }
});

describe('real proof-worker lifecycle', () => {
  it('starts the thread with the environment that keeps the native addon out', async () => {
    const file = fixture(() => `const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ taskId }) => parentPort.postMessage({
  taskId, ok: false, errorName: 'Probe', message: 'addon switch: ' + process.env.WS_NO_BUFFER_UTIL,
}));`);
    await expect(builder(file).build(proofRequest('catalog'))).rejects.toThrow('addon switch: 1');
  });

  it.each(['catalog', 'public'] as const)('builds concurrent %s challenges without mutating or detaching caller buffers', async kind => {
    const worker = builder();
    const request = proofRequest(kind);
    const before = structuredClone(request);
    const results = await Promise.all([0, 1, 2].map(chunkId => worker.build({ ...request, chunkId })));
    for (const [chunkId, result] of results.entries()) {
      expect(verifyV10ProofMaterial(result, chunkId, request.expected)).toBe(true);
      const corrupted = { ...result, content: new Uint8Array(result.content.length).fill(255) };
      expect(verifyV10ProofMaterial(corrupted, chunkId, request.expected)).toBe(false);
    }
    expect(request).toEqual(before);
  });

  it.each(['root', 'count', 'chunk'] as const)('preserves typed %s diagnostics across the real worker boundary', async mode => {
    const worker = builder();
    const request = proofRequest();
    const computedRoot = request.expected.merkleRoot;
    const wrongRoot = new Uint8Array(32).fill(255);
    if (mode === 'root') request.expected.merkleRoot = wrongRoot;
    if (mode === 'count') request.expected.merkleLeafCount = 42;
    if (mode === 'chunk') request.chunkId = 3;
    const task = worker.build(request);
    if (mode === 'root') {
      await expect(task).rejects.toBeInstanceOf(V10ProofRootMismatchError);
      await expect(task).rejects.toMatchObject({ computedMerkleRoot: computedRoot, expectedMerkleRoot: wrongRoot });
    } else if (mode === 'count') {
      await expect(task).rejects.toBeInstanceOf(V10ProofLeafCountMismatchError);
      await expect(task).rejects.toMatchObject({ computedLeafCount: 3, expectedLeafCount: 42 });
    } else {
      await expect(task).rejects.toBeInstanceOf(V10ProofChunkOutOfRangeError);
      await expect(task).rejects.toMatchObject({ chunkId: 3, leafCount: 3 });
    }
    const valid = proofRequest();
    expect(verifyV10ProofMaterial(await worker.build(valid), valid.chunkId, valid.expected)).toBe(true);
  });

  it('rejects every pending task after a nonzero exit, then respawns to build a real proof', async () => {
    const script = fixture(directory => `
      const fs = require('node:fs');
      const { parentPort } = require('node:worker_threads');
      const marker = ${JSON.stringify(join(directory, 'started'))};
      if (!fs.existsSync(marker)) {
        fs.writeFileSync(marker, 'first worker');
        parentPort.on('message', () => process.exit(23));
      } else { import(${JSON.stringify(pathToFileURL(entry).href)}); }
    `);
    const worker = builder(script);
    const request = proofRequest();
    const results = await Promise.allSettled([worker.build(request), worker.build({ ...request, chunkId: 1 })]);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') throw new Error('Crashed worker unexpectedly returned a proof');
      expect(result.reason).toBeInstanceOf(WorkerCrashedError);
      expect(result.reason).toMatchObject({ exitCode: 23, message: 'worker exited with code 23' });
    }
    expect(verifyV10ProofMaterial(await worker.build(request), request.chunkId, request.expected)).toBe(true);
  });

  it('rejects all pending work when the worker throws an uncaught error', async () => {
    const script = fixture(() => "require('node:worker_threads').parentPort.on('message', () => { throw new Error('fixture crash'); });");
    const worker = builder(script);
    const results = await Promise.allSettled([worker.build(proofRequest()), worker.build(proofRequest())]);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') throw new Error('Failed worker unexpectedly returned a proof');
      expect(result.reason).toMatchObject({ name: 'WorkerCrashedError', exitCode: null, message: 'worker error: fixture crash' });
    }
  });

  it('rejects pending work on close and permits repeated close calls', async () => {
    const script = fixture(() => "require('node:worker_threads').parentPort.on('message', () => {});");
    const worker = builder(script);
    const results = Promise.allSettled([worker.build(proofRequest()), worker.build(proofRequest())]);
    await worker.close();
    for (const result of await results) {
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') throw new Error('Closed worker unexpectedly returned a proof');
      expect(result.reason).toEqual(new Error('proof builder closed'));
    }
    await worker.close();
    await new WorkerThreadProofBuilder().close();
  });

  it.each([
    ['V10ProofRootMismatchError', V10ProofRootMismatchError, { computedMerkleRoot: new Uint8Array(32), expectedMerkleRoot: new Uint8Array(32) }],
    ['V10ProofLeafCountMismatchError', V10ProofLeafCountMismatchError, { computedLeafCount: 0, expectedLeafCount: 0 }],
    ['V10ProofChunkOutOfRangeError', V10ProofChunkOutOfRangeError, { chunkId: 0, leafCount: 0 }],
    ['Error', Error, { message: 'legacy worker failure' }],
  ] as const)('accepts legacy %s responses without structured fields and ignores stale task ids', async (name, errorClass, fields) => {
    const script = fixture(() => `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', message => {
        parentPort.postMessage({ taskId: 9999, ok: false, errorName: 'Error', message: 'stale' });
        parentPort.postMessage({ taskId: message.taskId, ok: false, errorName: ${JSON.stringify(name)}, message: 'legacy worker failure' });
      });
    `);
    const task = builder(script).build(proofRequest());
    await expect(task).rejects.toBeInstanceOf(errorClass);
    await expect(task).rejects.toMatchObject(fields);
  });
});
