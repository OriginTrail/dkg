import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertGate1ProductCapabilities,
  inspectGate1ProductCapabilities,
  requireGate1ProductMethod,
} from './product-capabilities.js';

function productSurface(overrides: Record<string, unknown> = {}): object {
  return {
    publishOpenAuthorCatalogGenesisV1: async () => undefined,
    publishOpenAuthorCatalogSuccessorV1: async () => undefined,
    announceRfc64PublicCatalogHeadV1: async () => undefined,
    readRfc64AppliedCatalogHeadV1: async () => undefined,
    readRfc64PublicCatalogSynchronizationEvidenceV1: async () => undefined,
    ...overrides,
  };
}

test('maps the six frozen operations to the intended product and harness capabilities', () => {
  assert.deepEqual(inspectGate1ProductCapabilities(productSurface()), {
    announce: true,
    appliedHeadReadback: true,
    exactInventoryReadback: true,
    killRestart: true,
    publishGenesis: true,
    publishSuccessor: true,
  });
});

test('fails closed with the exact missing product method names', () => {
  const incomplete = inspectGate1ProductCapabilities({
    publishOpenAuthorCatalogGenesisV1: async () => undefined,
  });
  assert.throws(
    () => assertGate1ProductCapabilities({ author: incomplete, receiver: incomplete }),
    (error) => {
      assert(error instanceof Error);
      assert.match(error.message, /author\.publishSuccessor \(publishOpenAuthorCatalogSuccessorV1\)/);
      assert.match(error.message, /author\.announce \(announceRfc64PublicCatalogHeadV1\)/);
      assert.match(error.message, /receiver\.appliedHeadReadback \(readRfc64AppliedCatalogHeadV1\)/);
      assert.match(
        error.message,
        /receiver\.exactInventoryReadback \(readRfc64PublicCatalogSynchronizationEvidenceV1\)/,
      );
      assert.match(error.message, /will not fabricate product evidence/);
      return true;
    },
  );
});

test('accepts complete role capability reports and binds real methods', async () => {
  const surface = productSurface({
    readRfc64AppliedCatalogHeadV1: async (input: unknown) => ({ input }),
  });
  const capabilities = inspectGate1ProductCapabilities(surface);
  assert.doesNotThrow(() => assertGate1ProductCapabilities({
    author: capabilities,
    receiver: capabilities,
  }));
  assert.deepEqual(
    await requireGate1ProductMethod(surface, 'appliedHeadReadback')({ scope: 'scope' }),
    { input: { scope: 'scope' } },
  );
});

test('rejects capability records outside the frozen operation set', () => {
  const capabilities = {
    ...inspectGate1ProductCapabilities(productSurface()),
    hiddenInterimMethod: true,
  };
  assert.throws(
    () => assertGate1ProductCapabilities({ author: capabilities, receiver: capabilities }),
    /do not match the frozen operation set/,
  );
});
