import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CP1_PUBLIC_SWM_PARITY_SCHEMA,
  semanticSha256,
  verifyCp1PublicSwmParity,
} from './verifier.ts';
import {
  CP1_PUBLIC_CELL_SPECS,
  cp1PolicyDigest,
} from './policy-cells.ts';

const projection = '<urn:cp1> <https://schema.org/name> "RFC-64 CP1" .\n'
  + '<urn:cp1> <https://schema.org/version> "1" .\n';
const digest = (byte: string) => `0x${byte.repeat(64)}`;
const TESTED_HEAD = 'a'.repeat(40);
const RUNTIME_MANIFEST_DIGEST = digest('c');
const EXPECTED_PROVENANCE = Object.freeze({
  runtimeManifestDigest: RUNTIME_MANIFEST_DIGEST,
  testedHeadCommit: TESTED_HEAD,
});

function fixture(): Record<string, unknown> {
  const cell = (index: number) => {
    const spec = CP1_PUBLIC_CELL_SPECS[index]!;
    const policyDigest = cp1PolicyDigest(spec);
    return {
      accessPolicy: 0,
      activatedTripleCount: 2,
      announcementPolicyDigest: policyDigest,
      announcedPeerId: 'receiver-peer',
      appliedHeadStatus: 'applied',
      authorPolicyDigest: policyDigest,
      bundleDigest: digest('a'),
      cell: spec.cell,
      contentDigest: digest('b'),
      contextGraphId: spec.contextGraphId,
      inventoryRowCount: 1,
      projectionNQuads: projection,
      publishPolicy: spec.publishPolicy,
      receiverPolicyDigest: policyDigest,
      semanticSha256: semanticSha256(projection),
    };
  };
  return {
    cells: [cell(0), cell(1)],
    expectedProjectionNQuads: projection,
    expectedSemanticSha256: semanticSha256(projection),
    peers: { authorPeerId: 'author-peer', receiverPeerId: 'receiver-peer' },
    processBoundary: {
      authorExitCode: 0,
      authorPid: 100,
      receiverExitCode: 0,
      receiverPid: 101,
    },
    repository: { testedHeadCommit: TESTED_HEAD, trackedSourceClean: true },
    runtimeManifestDigest: RUNTIME_MANIFEST_DIGEST,
    schemaVersion: CP1_PUBLIC_SWM_PARITY_SCHEMA,
    status: 'PASS',
  };
}

test('accepts exact two-cell public SWM parity', () => {
  assert.equal(verifyCp1PublicSwmParity(fixture(), EXPECTED_PROVENANCE).status, 'PASS');
});

test('rejects publish-axis, process-boundary, and byte-parity drift', () => {
  const wrongPolicy = structuredClone(fixture()) as { cells: Array<Record<string, unknown>> };
  wrongPolicy.cells[1]!.publishPolicy = 1;
  assert.throws(() => verifyCp1PublicSwmParity(wrongPolicy, EXPECTED_PROVENANCE), /publishPolicy/);

  const samePid = structuredClone(fixture()) as {
    processBoundary: Record<string, unknown>;
  };
  samePid.processBoundary.receiverPid = 100;
  assert.throws(() => verifyCp1PublicSwmParity(samePid, EXPECTED_PROVENANCE), /PIDs must differ/);

  const changedBytes = structuredClone(fixture()) as { cells: Array<Record<string, unknown>> };
  changedBytes.cells[1]!.projectionNQuads = `${projection}# drift`;
  assert.throws(() => verifyCp1PublicSwmParity(changedBytes, EXPECTED_PROVENANCE), /projectionNQuads/);

  const changedBundle = structuredClone(fixture()) as {
    cells: Array<Record<string, unknown>>;
  };
  changedBundle.cells[1]!.bundleDigest = digest('d');
  assert.throws(
    () => verifyCp1PublicSwmParity(changedBundle, EXPECTED_PROVENANCE),
    /bundle parity/,
  );

  const changedContent = structuredClone(fixture()) as {
    cells: Array<Record<string, unknown>>;
  };
  changedContent.cells[1]!.contentDigest = digest('e');
  assert.throws(
    () => verifyCp1PublicSwmParity(changedContent, EXPECTED_PROVENANCE),
    /content parity/,
  );

  const extraKey = structuredClone(fixture()) as Record<string, unknown>;
  extraKey.unverified = true;
  assert.throws(() => verifyCp1PublicSwmParity(extraKey, EXPECTED_PROVENANCE), /keys differ/);
});

test('rejects stale repository and runtime provenance', () => {
  assert.throws(
    () => verifyCp1PublicSwmParity(fixture(), {
      ...EXPECTED_PROVENANCE,
      testedHeadCommit: 'b'.repeat(40),
    }),
    /testedHeadCommit/,
  );
  assert.throws(
    () => verifyCp1PublicSwmParity(fixture(), {
      ...EXPECTED_PROVENANCE,
      runtimeManifestDigest: digest('f'),
    }),
    /runtimeManifestDigest/,
  );
});

test('rejects wrong or duplicate policy-cell identity', () => {
  const wrongContextGraph = structuredClone(fixture()) as {
    cells: Array<Record<string, unknown>>;
  };
  wrongContextGraph.cells[1]!.contextGraphId = 'cg-unrelated';
  assert.throws(() => verifyCp1PublicSwmParity(wrongContextGraph, EXPECTED_PROVENANCE), /contextGraphId/);

  const duplicateContextGraph = structuredClone(fixture()) as {
    cells: Array<Record<string, unknown>>;
  };
  duplicateContextGraph.cells[1]!.contextGraphId = duplicateContextGraph.cells[0]!.contextGraphId;
  assert.throws(() => verifyCp1PublicSwmParity(duplicateContextGraph, EXPECTED_PROVENANCE), /contextGraphId/);

  const wrongPolicyDigest = structuredClone(fixture()) as {
    cells: Array<Record<string, unknown>>;
  };
  for (const field of [
    'announcementPolicyDigest',
    'authorPolicyDigest',
    'receiverPolicyDigest',
  ]) {
    wrongPolicyDigest.cells[1]![field] = digest('9');
  }
  assert.throws(() => verifyCp1PublicSwmParity(wrongPolicyDigest, EXPECTED_PROVENANCE), /authorPolicyDigest/);

  const duplicatePolicyDigest = structuredClone(fixture()) as {
    cells: Array<Record<string, unknown>>;
  };
  for (const field of [
    'announcementPolicyDigest',
    'authorPolicyDigest',
    'receiverPolicyDigest',
  ]) {
    duplicatePolicyDigest.cells[1]![field] = duplicatePolicyDigest.cells[0]![field];
  }
  assert.throws(() => verifyCp1PublicSwmParity(duplicatePolicyDigest, EXPECTED_PROVENANCE), /authorPolicyDigest/);
});
