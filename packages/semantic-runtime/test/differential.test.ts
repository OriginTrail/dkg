import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MESSAGE_TYPE,
  decodeAbiSuccess,
  decodeHandle,
  encodeCreateRequest,
  encodeEmptyRequest,
  encodeEventRequest,
} from '../src/codec.js';
import { WorkerSupervisor } from '../src/worker-supervisor.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const workerUrl = new URL('../dist/worker.js', import.meta.url);

interface NativeVector {
  createRequestHex: string;
  eventRequestHex: string;
  stepOutputHex: string;
  snapshotHex: string;
}

interface NativeV1Vector {
  digestHex: string;
}

describe('native and Wasm differential conformance', () => {
  it('emits byte-identical requests, step output, and snapshot', async () => {
    const vector = JSON.parse(
      execFileSync(
        'cargo',
        [
          '+1.98.0',
          'run',
          '--quiet',
          '--locked',
          '--manifest-path',
          path.join(REPO_ROOT, 'rust', 'Cargo.toml'),
          '--package',
          'dkg-runtime-testkit',
          '--bin',
          'phase0-vector',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      ),
    ) as NativeVector;

    const createRequest = encodeCreateRequest(1n, {
      partitionId: new Uint8Array(32).fill(0x11),
      maxEvents: 32,
      maxAccumulator: 1_000_000n,
    });
    const eventRequest = encodeEventRequest(2n, {
      kind: 'advance',
      eventId: new Uint8Array(32).fill(0x22),
      logicalTime: 1_234n,
      delta: 77n,
    });
    expect(hex(createRequest)).toBe(vector.createRequestHex);
    expect(hex(eventRequest)).toBe(vector.eventRequestHex);

    const supervisor = new WorkerSupervisor({ workerUrl });
    await supervisor.start();
    try {
      const createResponse = await supervisor.call('create', createRequest);
      const handle = decodeHandle(
        decodeAbiSuccess(createResponse.body, 1n, MESSAGE_TYPE.create),
      );
      const applyResponse = await supervisor.call('apply', eventRequest, { handle });
      const stepOutput = decodeAbiSuccess(applyResponse.body, 2n, MESSAGE_TYPE.apply);
      expect(hex(stepOutput)).toBe(vector.stepOutputHex);

      const snapshotResponse = await supervisor.call(
        'snapshot',
        encodeEmptyRequest(3n, MESSAGE_TYPE.snapshot),
        { handle },
      );
      const snapshot = decodeAbiSuccess(snapshotResponse.body, 3n, MESSAGE_TYPE.snapshot);
      expect(hex(snapshot)).toBe(vector.snapshotHex);
    } finally {
      await supervisor.stop();
    }
  });

  it('executes the supervised V1 kernel identically in native Rust and Wasm', async () => {
    const vector = JSON.parse(
      execFileSync(
        'cargo',
        [
          '+1.98.0',
          'run',
          '--quiet',
          '--locked',
          '--manifest-path',
          path.join(REPO_ROOT, 'rust', 'Cargo.toml'),
          '--package',
          'dkg-runtime-testkit',
          '--bin',
          'v1-vector',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      ),
    ) as NativeV1Vector;

    const supervisor = new WorkerSupervisor({ workerUrl, allowTestOperations: true });
    await supervisor.start();
    try {
      const response = await supervisor.call('v1_conformance', new Uint8Array());
      expect(hex(response.body)).toBe(vector.digestHex);
    } finally {
      await supervisor.stop();
    }
  });
});

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
