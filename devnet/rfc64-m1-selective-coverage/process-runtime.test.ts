import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  createSelectiveCoverageCorpus,
  type ExpectedSelectiveCoverageProvenanceV1,
} from './manifest.ts';
import { ProcessSelectiveCoverageRuntimeV1 } from './process-runtime.ts';
import { SELECTIVE_COVERAGE_RUNTIME_PROTOCOL } from './runtime.ts';

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

function fixtureRuntime(mode?: string): ProcessSelectiveCoverageRuntimeV1 {
  return new ProcessSelectiveCoverageRuntimeV1({
    command: process.execPath,
    args: [resolve(import.meta.dirname, 'process-runtime-fixture.mjs')],
    cwd: resolve(import.meta.dirname, '../..'),
    timeoutMs: 5_000,
    env: {
      ...process.env,
      ...(mode ? { FIXTURE_MODE: mode } : {}),
      FIXTURE_NETWORK_ID: 'otp:20430',
      FIXTURE_SOURCE_COMMIT: 'a'.repeat(40),
      FIXTURE_RUNTIME_MANIFEST: `sha256:${'b'.repeat(64)}`,
    },
  });
}
