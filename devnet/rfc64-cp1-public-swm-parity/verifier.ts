import { createHash } from 'node:crypto';

export const CP1_PUBLIC_SWM_PARITY_SCHEMA =
  'dkg-rfc64-cp1-public-swm-parity-v1' as const;

const DIGEST = /^0x[0-9a-f]{64}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const CELLS = ['public-open', 'public-curated'] as const;

export function semanticSha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function verifyCp1PublicSwmParity(value: unknown): Record<string, unknown> {
  const root = record(value, '$');
  exact(root.schemaVersion, CP1_PUBLIC_SWM_PARITY_SCHEMA, '$.schemaVersion');
  exact(root.status, 'PASS', '$.status');
  const repository = record(root.repository, '$.repository');
  string(repository.testedHeadCommit, '$.repository.testedHeadCommit');
  exact(repository.trackedSourceClean, true, '$.repository.trackedSourceClean');
  const boundary = record(root.processBoundary, '$.processBoundary');
  integer(boundary.authorPid, '$.processBoundary.authorPid');
  integer(boundary.receiverPid, '$.processBoundary.receiverPid');
  if (boundary.authorPid === boundary.receiverPid) fail('$.processBoundary', 'PIDs must differ');
  exact(boundary.authorExitCode, 0, '$.processBoundary.authorExitCode');
  exact(boundary.receiverExitCode, 0, '$.processBoundary.receiverExitCode');
  const peers = record(root.peers, '$.peers');
  const authorPeerId = string(peers.authorPeerId, '$.peers.authorPeerId');
  const receiverPeerId = string(peers.receiverPeerId, '$.peers.receiverPeerId');
  if (authorPeerId === receiverPeerId) fail('$.peers', 'peer IDs must differ');
  const expectedProjection = string(root.expectedProjectionNQuads, '$.expectedProjectionNQuads');
  const expectedSemanticDigest = semanticSha256(expectedProjection);
  exact(root.expectedSemanticSha256, expectedSemanticDigest, '$.expectedSemanticSha256');

  if (!Array.isArray(root.cells) || root.cells.length !== 2) {
    fail('$.cells', 'must contain exactly public-open and public-curated');
  }
  const cells = root.cells.map((entry, index) => {
    const path = `$.cells[${index}]`;
    const cell = record(entry, path);
    exact(cell.cell, CELLS[index], `${path}.cell`);
    exact(cell.accessPolicy, 0, `${path}.accessPolicy`);
    exact(cell.publishPolicy, index === 0 ? 1 : 0, `${path}.publishPolicy`);
    string(cell.contextGraphId, `${path}.contextGraphId`);
    const policyDigest = digest(cell.authorPolicyDigest, `${path}.authorPolicyDigest`);
    exact(cell.receiverPolicyDigest, policyDigest, `${path}.receiverPolicyDigest`);
    exact(cell.announcementPolicyDigest, policyDigest, `${path}.announcementPolicyDigest`);
    exact(cell.announcedPeerId, receiverPeerId, `${path}.announcedPeerId`);
    exact(cell.inventoryRowCount, 1, `${path}.inventoryRowCount`);
    exact(cell.activatedTripleCount, 2, `${path}.activatedTripleCount`);
    exact(cell.appliedHeadStatus, 'applied', `${path}.appliedHeadStatus`);
    const bundleDigest = digest(cell.bundleDigest, `${path}.bundleDigest`);
    const contentDigest = digest(cell.contentDigest, `${path}.contentDigest`);
    const projection = string(cell.projectionNQuads, `${path}.projectionNQuads`);
    exact(projection, expectedProjection, `${path}.projectionNQuads`);
    const semanticDigest = sha256(cell.semanticSha256, `${path}.semanticSha256`);
    exact(semanticDigest, expectedSemanticDigest, `${path}.semanticSha256`);
    return { bundleDigest, contentDigest, semanticDigest };
  });
  exact(cells[1]!.bundleDigest, cells[0]!.bundleDigest, '$.cells bundle parity');
  exact(cells[1]!.contentDigest, cells[0]!.contentDigest, '$.cells content parity');
  exact(cells[1]!.semanticDigest, cells[0]!.semanticDigest, '$.cells semantic parity');
  return root;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string');
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(path, 'must be a positive PID');
  return value as number;
}

function digest(value: unknown, path: string): string {
  const result = string(value, path);
  if (!DIGEST.test(result)) fail(path, 'must be a canonical digest');
  return result;
}

function sha256(value: unknown, path: string): string {
  const result = string(value, path);
  if (!SHA256.test(result)) fail(path, 'must be a canonical sha256 digest');
  return result;
}

function exact(actual: unknown, expected: unknown, path: string): void {
  if (actual !== expected) fail(path, `expected ${JSON.stringify(expected)}`);
}

function fail(path: string, message: string): never {
  throw new Error(`RFC64_CP1_PUBLIC_SWM_PARITY_INVALID at ${path}: ${message}`);
}

