import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CP1_PUBLIC_SWM_PARITY_SCHEMA,
  semanticSha256,
  verifyCp1PublicSwmParity,
} from './verifier.ts';

const projection = '<urn:cp1> <https://schema.org/name> "RFC-64 CP1" .\n'
  + '<urn:cp1> <https://schema.org/version> "1" .\n';
const digest = (byte: string) => `0x${byte.repeat(64)}`;

function fixture(): Record<string, unknown> {
  const cell = (name: string, publishPolicy: number, policyByte: string) => ({
    accessPolicy: 0,
    activatedTripleCount: 2,
    announcementPolicyDigest: digest(policyByte),
    announcedPeerId: 'receiver-peer',
    appliedHeadStatus: 'applied',
    authorPolicyDigest: digest(policyByte),
    bundleDigest: digest('a'),
    cell: name,
    contentDigest: digest('b'),
    contextGraphId: `cg-${name}`,
    inventoryRowCount: 1,
    projectionNQuads: projection,
    publishPolicy,
    receiverPolicyDigest: digest(policyByte),
    semanticSha256: semanticSha256(projection),
  });
  return {
    cells: [cell('public-open', 1, '1'), cell('public-curated', 0, '2')],
    expectedProjectionNQuads: projection,
    expectedSemanticSha256: semanticSha256(projection),
    peers: { authorPeerId: 'author-peer', receiverPeerId: 'receiver-peer' },
    processBoundary: {
      authorExitCode: 0,
      authorPid: 100,
      receiverExitCode: 0,
      receiverPid: 101,
    },
    repository: { testedHeadCommit: 'a'.repeat(40), trackedSourceClean: true },
    runtimeManifestDigest: digest('c'),
    schemaVersion: CP1_PUBLIC_SWM_PARITY_SCHEMA,
    status: 'PASS',
  };
}

test('accepts exact two-cell public SWM parity', () => {
  assert.equal(verifyCp1PublicSwmParity(fixture()).status, 'PASS');
});

test('rejects publish-axis, process-boundary, and byte-parity drift', () => {
  const wrongPolicy = structuredClone(fixture()) as { cells: Array<Record<string, unknown>> };
  wrongPolicy.cells[1]!.publishPolicy = 1;
  assert.throws(() => verifyCp1PublicSwmParity(wrongPolicy), /publishPolicy/);

  const samePid = structuredClone(fixture()) as {
    processBoundary: Record<string, unknown>;
  };
  samePid.processBoundary.receiverPid = 100;
  assert.throws(() => verifyCp1PublicSwmParity(samePid), /PIDs must differ/);

  const changedBytes = structuredClone(fixture()) as { cells: Array<Record<string, unknown>> };
  changedBytes.cells[1]!.projectionNQuads = `${projection}# drift`;
  assert.throws(() => verifyCp1PublicSwmParity(changedBytes), /projectionNQuads/);

  const extraKey = structuredClone(fixture()) as Record<string, unknown>;
  extraKey.unverified = true;
  assert.throws(() => verifyCp1PublicSwmParity(extraKey), /keys differ/);
});
