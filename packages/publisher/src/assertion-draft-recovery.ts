import { ethers } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { ResolvedAssertionSource } from './assertion-seal-recovery.js';
import { validateGraphScopedPayloadAgainstSeal } from './assertion-seal-recovery.js';

export interface ExactPullSource {
  kaUal: string;
  assertionVersion: string;
  merkleRoot: string;
}

export interface AssertionPullFromOptions {
  subGraphName?: string;
  onConflict?: 'reject' | 'replace';
  /** Verify an existing draft without writes. Retain this tuple before the original pull. */
  recoverExact?: ExactPullSource;
}

export interface AssertionDraftEvidence extends ExactPullSource {
  contextGraphId: string;
  subGraphName?: string;
  name: string;
  agentAddress: string;
  fromLayer: 'swm' | 'vm';
  publicTripleCount: number;
  privateTripleCount: number;
  privateMerkleRoot: string | null;
}

export interface AssertionPullFromResult extends ExactPullSource {
  seeded: number;
  seededPublic: number;
  seededPrivate: number;
  fromLayer: 'swm' | 'vm';
  contentScopeVersion: number;
  recovered?: true;
  draftEvidence?: AssertionDraftEvidence;
}

export function snapshotAssertionPullOptions(opts?: AssertionPullFromOptions): AssertionPullFromOptions | undefined {
  if (!opts) return undefined;
  const source = opts.recoverExact;
  if (source !== undefined && (!source || typeof source !== 'object' || Array.isArray(source)
    || typeof source.kaUal !== 'string' || !source.kaUal
    || typeof source.assertionVersion !== 'string' || !/^[1-9]\d*$/.test(source.assertionVersion)
    || typeof source.merkleRoot !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(source.merkleRoot)
    || (opts.onConflict !== undefined && opts.onConflict !== 'reject'))) {
    throw Object.assign(new Error('recoverExact requires kaUal, assertionVersion and merkleRoot strings and onConflict:"reject".'),
      { code: 'INVALID_PULL_RECOVERY_OPTIONS' });
  }
  return { ...opts, ...(source !== undefined ? { recoverExact: { kaUal: source.kaUal, assertionVersion: source.assertionVersion, merkleRoot: source.merkleRoot.toLowerCase() } } : {}) };
}

/** Bounded errors deliberately exclude RDF, parser errors and exception causes. */
export function draftRecoveryError(code: 'WM_DRAFT_NOT_EXACT' | 'WM_RECOVERY_SOURCE_UNAVAILABLE'): Error {
  return Object.assign(new Error(code === 'WM_DRAFT_NOT_EXACT'
    ? 'The existing WM draft is not the exact pinned source; no draft was modified.'
    : 'The pinned recovery source is unavailable or superseded; no draft was modified.'), { code });
}

/** Caller holds the assertion lifecycle lock across source selection and BOTH partition reads. */
export async function verifyExactAssertionDraft(input: {
  source: ResolvedAssertionSource;
  contextGraphId: string;
  subGraphName?: string;
  name: string;
  agentAddress: string;
  fromLayer: 'swm' | 'vm';
  publicQuads: Quad[];
  privateQuads: Quad[];
}): Promise<AssertionDraftEvidence> {
  const { source, publicQuads, privateQuads, ...binding } = input;
  try {
    await validateGraphScopedPayloadAgainstSeal(source.loadedSeal.seal, publicQuads, privateQuads, 'wm-draft');
  } catch { throw draftRecoveryError('WM_DRAFT_NOT_EXACT'); }
  const seal = source.loadedSeal.seal;
  return { ...binding, kaUal: source.scope.ual, assertionVersion: source.scope.assertionVersion,
    publicTripleCount: publicQuads.length, privateTripleCount: privateQuads.length,
    merkleRoot: ethers.hexlify(seal.merkleRoot),
    privateMerkleRoot: seal.privateMerkleRoot ? ethers.hexlify(seal.privateMerkleRoot) : null };
}
