// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertFinalizedRuntimeV1,
  createOwnerPublicationStateV1,
  parseRfc64PrivateRuntimeManifestV1,
  parseRfc64PrivateRuntimeRoleV1,
} from './agent-runtime.ts';
import { withRfc64PrivateFinalizedRuntimeAcquisitionV1 } from
  './agent-runtime-factory.ts';

test('runtime discriminant and owner publication enforce behavioral transitions', async () => {
  const probe = { kind: 'probe', role: 'owner' };
  assert.throws(() => assertFinalizedRuntimeV1(probe), /requires a finalized runtime/u);
  assert.doesNotThrow(() => assertFinalizedRuntimeV1({ kind: 'run', role: 'provider2' }));

  const publication = createOwnerPublicationStateV1();
  assert.throws(() => publication.requireBaseline(), /requires a published/u);
  const scope = Object.freeze({ scope: 'test' });
  let releasePublication;
  const publicationGate = new Promise((resolve) => { releasePublication = resolve; });
  const inFlight = publication.publishBaseline(async () => {
    await publicationGate;
    return { scope, assets: [Object.freeze({ asset: 1 })], result: 'published' };
  });
  await assert.rejects(
    publication.publishBaseline(async () => ({ scope, assets: [], result: 'duplicate' })),
    /already published/u,
  );
  releasePublication();
  assert.equal(await inFlight, 'published');
  assert.deepEqual(publication.requireBaseline(), {
    kind: 'baseline',
    scope,
    assets: [{ asset: 1 }],
  });
  await assert.rejects(
    publication.publishBaseline(async () => ({ scope, assets: [], result: 'late duplicate' })),
    /already published/u,
  );

  const retrying = createOwnerPublicationStateV1();
  await assert.rejects(
    retrying.publishBaseline(async () => { throw new Error('injected publish failure'); }),
    /injected publish failure/u,
  );
  assert.throws(() => retrying.requireBaseline(), /requires a published/u);
  assert.equal(await retrying.publishBaseline(async () => ({
    scope,
    assets: [],
    result: 'retried',
  })), 'retried');
});

test('runtime external boundaries accept only canonical roles and complete manifests', () => {
  assert.equal(parseRfc64PrivateRuntimeRoleV1('receiver'), 'receiver');
  assert.throws(() => parseRfc64PrivateRuntimeRoleV1('unknown'), /role is invalid/u);
  const manifest = {
    authorityStatePath: '/not-used/authority.json',
    peerIds: {
      owner: 'owner-peer',
      provider2: 'provider2-peer',
      receiver: 'receiver-peer',
      outsider: 'outsider-peer',
    },
  };
  assert.deepEqual(parseRfc64PrivateRuntimeManifestV1(manifest), manifest);
  assert.throws(() => parseRfc64PrivateRuntimeManifestV1({
    ...manifest,
    unexpected: true,
  }), /unexpected fields/u);
  assert.throws(() => parseRfc64PrivateRuntimeManifestV1({
    ...manifest,
    peerIds: { ...manifest.peerIds, unexpected: 'unexpected-peer' },
  }), /exactly cover unique roles/u);
  assert.throws(() => parseRfc64PrivateRuntimeManifestV1({
    ...manifest,
    peerIds: { ...manifest.peerIds, outsider: manifest.peerIds.owner },
  }), /exactly cover unique roles/u);
});

test('finalized runtime acquisition rolls partial resources back in reverse order', async () => {
  const releaseOrder = [];
  const acquisitionFailure = new Error('injected post-start binding failure');
  await assert.rejects(
    withRfc64PrivateFinalizedRuntimeAcquisitionV1(async (owner) => {
      owner.ownStore({ close: async () => { releaseOrder.push('store'); } });
      owner.ownRpc({ close: async () => { releaseOrder.push('rpc'); } });
      owner.ownAgent({ stop: async () => { releaseOrder.push('agent'); } });
      throw acquisitionFailure;
    }),
    (error) => error === acquisitionFailure,
  );
  assert.deepEqual(releaseOrder, ['agent', 'rpc', 'store']);
});
