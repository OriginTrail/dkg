import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  createSelectiveCoverageCorpus,
  type ExpectedSelectiveCoverageProvenanceV1,
} from './manifest.ts';
import {
  DEFAULT_SELECTIVE_COVERAGE_ADAPTER_TIMEOUT_MS,
  ProcessSelectiveCoverageRuntimeV1,
} from './process-runtime.ts';
import { SELECTIVE_COVERAGE_RUNTIME_PROTOCOL } from './runtime.ts';

test('default adapter timeout covers the shipped testnet operation window', () => {
  assert.equal(DEFAULT_SELECTIVE_COVERAGE_ADAPTER_TIMEOUT_MS, 25 * 60_000);
});

test('exchanges sequence-bound JSON without sending the trust anchor to the adapter', async () => {
  const runtime = new ProcessSelectiveCoverageRuntimeV1({
    command: process.execPath,
    args: [resolve(import.meta.dirname, 'process-runtime-fixture.mjs')],
    cwd: resolve(import.meta.dirname, '../..'),
    timeoutMs: 5_000,
    env: {
      ...process.env,
      FIXTURE_NETWORK_ID: 'otp:20430',
      FIXTURE_SOURCE_COMMIT: 'a'.repeat(40),
      FIXTURE_RUNTIME_MANIFEST: `sha256:${'b'.repeat(64)}`,
    },
  });
  const corpus = createSelectiveCoverageCorpus({
    networkId: 'otp:20430',
    coreAutomaticBatchSize: 1,
    coreCoverageRoundLimit: 1,
    graphs: [{
      contextGraphId: '0x1111111111111111111111111111111111111111/public',
      accessPolicy: 0,
      publishPolicy: 1,
      edgePolicy: 'on-demand',
      selectedSnapshot: {
        vm: { headDigest: `sha256:${'1'.repeat(64)}`, inventoryDigest: `sha256:${'2'.repeat(64)}`, assetCount: 1, dataTripleCount: 1 },
        swm: { headDigest: `sha256:${'3'.repeat(64)}`, inventoryDigest: `sha256:${'4'.repeat(64)}`, assetCount: 1, dataTripleCount: 1 },
      },
      finalSnapshot: {
        vm: { headDigest: `sha256:${'5'.repeat(64)}`, inventoryDigest: `sha256:${'6'.repeat(64)}`, assetCount: 2, dataTripleCount: 2 },
        swm: { headDigest: `sha256:${'7'.repeat(64)}`, inventoryDigest: `sha256:${'8'.repeat(64)}`, assetCount: 2, dataTripleCount: 2 },
      },
    }],
  });
  const expected: ExpectedSelectiveCoverageProvenanceV1 = {
    networkId: corpus.networkId,
    testedHeadCommit: 'a'.repeat(40),
    runtimeManifestDigest: `sha256:${'b'.repeat(64)}`,
    corpusManifestDigest: corpus.manifestDigest,
    publisherPeerId: 'publisher-peer',
    edgePeerId: 'edge-peer',
    corePeerId: 'core-peer',
  };
  try {
    const ready = await runtime.start('publisher');
    assert.equal(ready.protocol, SELECTIVE_COVERAGE_RUNTIME_PROTOCOL);
    assert.equal(ready.role, 'publisher');
    assert.equal(ready.hostIdentity, 'fixture-host');
    assert.equal(ready.peerId, 'publisher-peer');
    assert.ok(ready.pid > 0);
    await runtime.stop('publisher');
  } finally {
    await runtime.close();
  }
});

for (const [mode, message] of [
  ['malformed-value', /response failed decoding/],
  ['wrong-nonce', /invalid result envelope/],
  ['wrong-protocol', /invalid result envelope/],
  ['wrong-schema', /invalid result envelope/],
  ['unknown-sequence', /unknown result sequence/],
  ['extra-envelope', /invalid result envelope/],
  ['mixed-success-envelope', /invalid result envelope/],
  ['mixed-failure-envelope', /invalid result envelope/],
  ['nonboolean-ok', /invalid result envelope/],
  ['malformed-json', /malformed result JSON/],
  ['oversized-line', /exceeds 1 MiB/],
] as const) {
  test(`rejects fail-closed adapter output: ${mode}`, async () => {
    const runtime = fixtureRuntime(mode);
    try {
      await assert.rejects(runtime.start('publisher'), message);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });
}

test('accepts the exact closed failure result envelope', async () => {
  const runtime = fixtureRuntime('failure-envelope');
  try {
    await assert.rejects(runtime.start('publisher'), /fixture failure/);
  } finally {
    await runtime.close().catch(() => undefined);
  }
});

test('decodes non-start command results at the adapter boundary', async () => {
  const runtime = fixtureRuntime('malformed-publish');
  try {
    await runtime.start('publisher');
    await assert.rejects(
      runtime.publishWave('selected'),
      /response failed decoding: publish-wave/,
    );
  } finally {
    await runtime.close().catch(() => undefined);
  }
});

test('missing adapter executable fails startup and close without hanging', async () => {
  const runtime = new ProcessSelectiveCoverageRuntimeV1({
    command: resolve(import.meta.dirname, `missing-adapter-${process.pid}`),
    cwd: resolve(import.meta.dirname, '../..'),
    timeoutMs: 5_000,
  });
  await assert.rejects(runtime.start('publisher'), /runtime adapter process failed/);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const closeTimeout = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('runtime close timed out')), 1_000);
  });
  try {
    await assert.rejects(
      Promise.race([runtime.close(), closeTimeout]),
      /runtime adapter process failed/,
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

test('a non-terminal child error cannot satisfy the process-exit proof', async () => {
  const runtime = fixtureRuntime();
  const internals = runtime as unknown as {
    readonly child: { emit(event: 'error', error: Error): boolean };
    readonly exited: Promise<void>;
  };
  try {
    await runtime.start('publisher');
    internals.child.emit('error', new Error('synthetic live-child kill failure'));
    assert.doesNotThrow(() => {
      internals.child.emit('error', new Error('second synthetic live-child error'));
    });
    const terminalState = await Promise.race([
      internals.exited.then(() => 'exited' as const),
      new Promise<'still-running'>((resolveState) => {
        setTimeout(() => resolveState('still-running'), 50);
      }),
    ]);
    assert.equal(terminalState, 'still-running');
  } finally {
    await runtime.close().catch(() => undefined);
  }
});

test('rejects a non-zero adapter exit after shutdown acknowledgement', async () => {
  const runtime = fixtureRuntime('shutdown-nonzero');
  await runtime.start('publisher');
  await assert.rejects(
    runtime.close(),
    /runtime adapter exited abnormally after shutdown \(code=17 signal=null\)/,
  );
});

test('rejects forced termination after shutdown acknowledgement', async () => {
  const runtime = fixtureRuntime('shutdown-hang');
  await runtime.start('publisher');
  await assert.rejects(
    runtime.close(),
    /runtime adapter required forced SIGTERM during shutdown/,
  );
});

for (const [command, invoke] of [
  ['observe-edge', (runtime: ProcessSelectiveCoverageRuntimeV1) =>
    runtime.observeEdge('before-selection')],
  ['synchronize-edge', (runtime: ProcessSelectiveCoverageRuntimeV1) =>
    runtime.synchronizeEdge({
      contextGraphId: '0x1111111111111111111111111111111111111111/public',
      phase: 'selection',
      syncMode: 'on-demand',
      wave: 'selected',
    })],
  ['restart-edge', (runtime: ProcessSelectiveCoverageRuntimeV1) => runtime.restartEdge()],
  ['wait-edge-reconciler', (runtime: ProcessSelectiveCoverageRuntimeV1) =>
    runtime.waitForEdgeReconciler({
      contextGraphId: '0x1111111111111111111111111111111111111111/public',
    })],
  ['core-automatic-round', (runtime: ProcessSelectiveCoverageRuntimeV1) =>
    runtime.runCoreAutomaticRound(0)],
  ['observe-core-final', (runtime: ProcessSelectiveCoverageRuntimeV1) =>
    runtime.observeCoreFinal()],
  ['shutdown', (runtime: ProcessSelectiveCoverageRuntimeV1) => runtime.close()],
] as const) {
  test(`rejects malformed ${command} values at the adapter boundary`, async () => {
    const runtime = fixtureRuntime(undefined, command);
    try {
      await runtime.start('publisher');
      await assert.rejects(invoke(runtime), /response failed decoding/);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });
}

function fixtureRuntime(
  mode?: string,
  malformedCommand?: string,
): ProcessSelectiveCoverageRuntimeV1 {
  return new ProcessSelectiveCoverageRuntimeV1({
    command: process.execPath,
    args: [resolve(import.meta.dirname, 'process-runtime-fixture.mjs')],
    cwd: resolve(import.meta.dirname, '../..'),
    timeoutMs: 5_000,
    env: {
      ...process.env,
      ...(mode ? { FIXTURE_MODE: mode } : {}),
      ...(malformedCommand ? { FIXTURE_MALFORM_COMMAND: malformedCommand } : {}),
      FIXTURE_NETWORK_ID: 'otp:20430',
      FIXTURE_SOURCE_COMMIT: 'a'.repeat(40),
      FIXTURE_RUNTIME_MANIFEST: `sha256:${'b'.repeat(64)}`,
    },
  });
}
