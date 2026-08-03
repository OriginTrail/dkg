import { describe, expect, it } from 'vitest';

import {
  MAX_ROOTLESS_KA_NUMBER,
  MAX_UPDATE_PAGE_EVENTS,
  UPDATE_PAGE_ASSURANCES,
  VM_UPDATE_COVERAGE_STATES,
  VM_UPDATE_ERROR_CODES,
  VM_UPDATE_EVENT_RESULTS,
  VM_UPDATE_SCAN_OUTCOMES,
  VmUpdateConvergenceError,
  buildScopedKnowledgeAssetUal,
  canonicalCoverageCursor,
  canonicalDigest32,
  canonicalEvmAddress,
  canonicalFinalizedUpdate,
  canonicalNullableAuthorAddress,
  canonicalPageProof,
  canonicalScopedKaCandidatesFromVerifiedUal,
  canonicalUnsignedDecimal,
  canonicalVmUpdateScope,
  compareEventPosition,
  deriveVmUpdateScopeId,
  isAuthoritativePage,
  isDiscardedByResume,
  nextScanFromBlock,
  normalizeEndpointOrigin,
  orderedLogCommitment,
  sameEventIdentity,
  type FinalizedEventPositionV1,
  type FinalizedUpdatePageProofV1,
  type RawLogV1,
  type VmUpdateScopeV1,
} from '../src/vm-update-convergence.js';

const KA_STORAGE = `0x${'a1'.repeat(20)}`;
const CG_STORAGE = `0x${'b2'.repeat(20)}`;
const OTHER_ADDRESS = `0x${'c3'.repeat(20)}`;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const HASH_A = `0x${'11'.repeat(32)}`;
const HASH_B = `0x${'22'.repeat(32)}`;
const HASH_C = `0x${'33'.repeat(32)}`;

function scope(overrides: Partial<VmUpdateScopeV1> = {}): VmUpdateScopeV1 {
  const identity = {
    chainId: '84532',
    deploymentId: '84532:hub=0x00000000000000000000000000000000000000ff',
    knowledgeAssetStorageAddress: KA_STORAGE,
    contextGraphStorageAddress: CG_STORAGE,
    ...overrides,
  };
  return {
    ...identity,
    scopeId: deriveVmUpdateScopeId(identity),
    deploymentBlock: 47_682_200,
    deploymentBlockSource: 'shipped',
    deploymentBlockHistoricallyValidated: true,
    ...overrides,
  } as VmUpdateScopeV1;
}

function position(overrides: Partial<FinalizedEventPositionV1> = {}): FinalizedEventPositionV1 {
  return {
    blockNumber: 100,
    blockHash: HASH_A,
    transactionHash: HASH_B,
    transactionIndex: 0,
    logIndex: 0,
    ...overrides,
  };
}

function proof(overrides: Partial<FinalizedUpdatePageProofV1> = {}): FinalizedUpdatePageProofV1 {
  return {
    assurance: 'dual-origin-corroborated',
    normalizedOrigins: ['https://a.example.com', 'https://b.example.com'],
    from: { blockNumber: 100, blockHash: HASH_A },
    through: { blockNumber: 200, blockHash: HASH_B },
    finalizedAnchor: { blockNumber: 300, blockHash: HASH_C },
    orderedLogCommitment: `0x${'44'.repeat(32)}`,
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof VmUpdateConvergenceError) return error.code;
    throw error;
  }
  throw new Error('expected the call to throw a VmUpdateConvergenceError, but it returned');
}

describe('closed vocabularies', () => {
  it('exposes each vocabulary as a runtime tuple with no duplicates', () => {
    for (const vocabulary of [
      UPDATE_PAGE_ASSURANCES,
      VM_UPDATE_SCAN_OUTCOMES,
      VM_UPDATE_EVENT_RESULTS,
      VM_UPDATE_COVERAGE_STATES,
      VM_UPDATE_ERROR_CODES,
    ]) {
      expect(vocabulary.length).toBeGreaterThan(0);
      expect(new Set(vocabulary).size).toBe(vocabulary.length);
    }
  });

  it('keeps every error code the module can actually raise inside the vocabulary', () => {
    // Each entry is a call that MUST fail with that exact code. A code with no
    // reachable producer is dead vocabulary; a producer whose code is missing
    // from the tuple is drift. Both are caught here.
    const producers: Record<string, () => unknown> = {
      'scope-drift': () => canonicalVmUpdateScope({ ...scope(), scopeId: HASH_A }),
      'noncanonical-scalar': () => canonicalEvmAddress('0xNOTANADDRESS'),
      'foreign-chain': () =>
        canonicalScopedKaCandidatesFromVerifiedUal(scope(), `did:dkg:1/${KA_STORAGE}/7`),
      'noncanonical-ual': () =>
        canonicalScopedKaCandidatesFromVerifiedUal(scope(), 'not-a-ual'),
      'ka-number-overflow': () =>
        canonicalScopedKaCandidatesFromVerifiedUal(
          scope(),
          `did:dkg:84532/${KA_STORAGE}/${(MAX_ROOTLESS_KA_NUMBER + 1n).toString()}`,
        ),
      'page-malformed': () =>
        canonicalPageProof(proof({ through: { blockNumber: 400, blockHash: HASH_B } })),
      'assurance-insufficient': () =>
        canonicalPageProof(proof({ assurance: 'trust-me' as never })),
      'origin-not-distinct': () =>
        canonicalPageProof(proof({ normalizedOrigins: ['https://a.example.com'] })),
      'page-oversized': () =>
        orderedLogCommitment(
          Array.from({ length: MAX_UPDATE_PAGE_EVENTS + 1 }, (_unused, index) => ({
            address: KA_STORAGE,
            topics: [HASH_A],
            data: '0x',
            position: position({ logIndex: index }),
          })),
        ),
      'cursor-regression': () =>
        canonicalCoverageCursor({
          coveredThrough: { blockNumber: 200, blockHash: HASH_A },
          resumeAfter: position({ blockNumber: 150 }),
        }),
    };

    for (const [expected, produce] of Object.entries(producers)) {
      expect(VM_UPDATE_ERROR_CODES).toContain(expected);
      expect(codeOf(produce)).toBe(expected);
    }
  });

  it('bounds the error detail so an unbounded payload cannot reach a log line', () => {
    const error = new VmUpdateConvergenceError('page-malformed', 'x'.repeat(5_000));
    expect(error.detail.length).toBeLessThanOrEqual(200);
    expect(error.detail.endsWith('...')).toBe(true);
    expect(error.message.length).toBeLessThan(300);
  });
});

describe('canonical scalars', () => {
  it('rejects the zero address for ordinary addresses but maps it to null for author', () => {
    expect(codeOf(() => canonicalEvmAddress(ZERO_ADDRESS))).toBe('noncanonical-scalar');
    expect(canonicalNullableAuthorAddress(ZERO_ADDRESS)).toBeNull();
    expect(canonicalNullableAuthorAddress(null)).toBeNull();
    expect(canonicalNullableAuthorAddress(OTHER_ADDRESS)).toBe(OTHER_ADDRESS);
  });

  it('rejects mixed case rather than normalizing it', () => {
    const mixed = `0x${'A1'.repeat(20)}`;
    expect(codeOf(() => canonicalEvmAddress(mixed))).toBe('noncanonical-scalar');
    expect(codeOf(() => canonicalNullableAuthorAddress(mixed))).toBe('noncanonical-scalar');
    expect(codeOf(() => canonicalDigest32(`0x${'AB'.repeat(32)}`))).toBe('noncanonical-scalar');
  });

  it('rejects the leading-zero decimal alias', () => {
    expect(canonicalUnsignedDecimal('0')).toBe(0n);
    expect(canonicalUnsignedDecimal('7')).toBe(7n);
    expect(codeOf(() => canonicalUnsignedDecimal('007'))).toBe('noncanonical-scalar');
  });
});

describe('scope identity', () => {
  it('derives one id from the four identity fields', () => {
    expect(deriveVmUpdateScopeId(scope())).toBe(deriveVmUpdateScopeId(scope()));
    expect(deriveVmUpdateScopeId(scope())).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('does NOT include deploymentBlock — a proven lower anchor must stay in its scope', () => {
    // If this ever changes, an anchor correction would silently mint a new
    // scope instead of triggering revision reset and replay inside the old one,
    // and every persisted cursor for that chain would be orphaned.
    const high = canonicalVmUpdateScope(scope());
    const low = canonicalVmUpdateScope({ ...scope(), deploymentBlock: 1 });
    expect(low.scopeId).toBe(high.scopeId);
    expect(low.deploymentBlock).not.toBe(high.deploymentBlock);
  });

  it('changes the id when any one identity field changes', () => {
    const base = deriveVmUpdateScopeId(scope());
    expect(deriveVmUpdateScopeId(scope({ chainId: '31337' }))).not.toBe(base);
    expect(deriveVmUpdateScopeId(scope({ deploymentId: 'other' }))).not.toBe(base);
    expect(
      deriveVmUpdateScopeId(scope({ knowledgeAssetStorageAddress: OTHER_ADDRESS })),
    ).not.toBe(base);
    expect(deriveVmUpdateScopeId(scope({ contextGraphStorageAddress: OTHER_ADDRESS }))).not.toBe(
      base,
    );
  });

  it('cannot be collided by moving a boundary between two fields', () => {
    // These two identities CONCATENATE to the same bytes — '84532' + 'abc' and
    // '8453' + '2abc' — and differ only in where the field boundary falls. A
    // digest over a plain join, or over a join whose length prefix is not
    // actually written, hashes them identically and lets one chain's scope
    // impersonate another's. Only the length prefix separates them.
    //
    // An earlier version of this test compared inputs of different total
    // content, which every encoding distinguishes; it passed under a mutant
    // that zeroed the length field entirely.
    const shared = { knowledgeAssetStorageAddress: KA_STORAGE, contextGraphStorageAddress: CG_STORAGE };
    const left = deriveVmUpdateScopeId({ chainId: '84532', deploymentId: 'abc', ...shared });
    const right = deriveVmUpdateScopeId({ chainId: '8453', deploymentId: '2abc', ...shared });
    expect(left).not.toBe(right);
  });

  it('fails closed on caller scope-id drift and freezes what it returns', () => {
    expect(codeOf(() => canonicalVmUpdateScope({ ...scope(), scopeId: HASH_A }))).toBe(
      'scope-drift',
    );
    const frozen = canonicalVmUpdateScope(scope());
    expect(Object.isFrozen(frozen)).toBe(true);
  });
});

describe('exact event identity and ordering', () => {
  it('orders by (block, txIndex, logIndex) and ignores transactionHash', () => {
    const a = position({ blockNumber: 10, transactionIndex: 2, logIndex: 5 });
    const b = position({ blockNumber: 10, transactionIndex: 3, logIndex: 0 });
    expect(compareEventPosition(a, b)).toBeLessThan(0);
    expect(compareEventPosition(b, a)).toBeGreaterThan(0);

    // Same ordering coordinates, different tx hash: ordering says equal…
    const sameOrder = position({ transactionHash: HASH_C });
    expect(compareEventPosition(position(), sameOrder)).toBe(0);
    // …but identity says different, which is how a malformed page is caught.
    expect(sameEventIdentity(position(), sameOrder)).toBe(false);
    expect(sameEventIdentity(position(), position())).toBe(true);
  });

  it('accepts a legal zero author on the admin path', () => {
    const update = canonicalFinalizedUpdate({
      kind: 'lifecycle-update',
      kaId: '7',
      author: ZERO_ADDRESS,
      merkleRoot: HASH_C,
      ...position(),
    });
    expect(update.author).toBeNull();
    expect(Object.isFrozen(update)).toBe(true);
  });

  it('rejects a root-added event that claims an author', () => {
    expect(
      codeOf(() =>
        canonicalFinalizedUpdate({
          kind: 'root-added',
          kaId: '7',
          author: OTHER_ADDRESS,
          merkleRoot: HASH_C,
          ...position(),
        }),
      ),
    ).toBe('page-malformed');
  });
});

describe('ordered log commitment', () => {
  const log = (overrides: Partial<RawLogV1> = {}): RawLogV1 => ({
    address: KA_STORAGE,
    topics: [HASH_A, HASH_B],
    data: '0xdeadbeef',
    position: position(),
    ...overrides,
  });

  it('is stable for identical input', () => {
    expect(orderedLogCommitment([log()])).toBe(orderedLogCommitment([log()]));
  });

  it('changes when payload bytes change at an unchanged identity', () => {
    // This is the whole point: an identity-only commitment would call these
    // two pages corroborated while one endpoint altered the event data.
    expect(orderedLogCommitment([log()])).not.toBe(
      orderedLogCommitment([log({ data: '0xdeadbeee' })]),
    );
    expect(orderedLogCommitment([log()])).not.toBe(
      orderedLogCommitment([log({ topics: [HASH_A, HASH_C] })]),
    );
    expect(orderedLogCommitment([log()])).not.toBe(
      orderedLogCommitment([log({ address: OTHER_ADDRESS })]),
    );
  });

  it('cannot be collided by moving a boundary between two adjacent fields', () => {
    // `transactionIndex` and `logIndex` are adjacent variable-width numerics.
    // (1, 23) and (12, 3) concatenate to the same '123', so a commitment whose
    // length prefix is not actually written would call two different log
    // positions equal — and two endpoints returning different events would
    // corroborate. Only the length prefix separates them.
    const left = orderedLogCommitment([
      log({ position: position({ transactionIndex: 1, logIndex: 23 }) }),
    ]);
    const right = orderedLogCommitment([
      log({ position: position({ transactionIndex: 12, logIndex: 3 }) }),
    ]);
    expect(left).not.toBe(right);
  });

  it('rejects unordered logs and two logs at one ordering position', () => {
    expect(
      codeOf(() =>
        orderedLogCommitment([
          log({ position: position({ logIndex: 5 }) }),
          log({ position: position({ logIndex: 1 }) }),
        ]),
      ),
    ).toBe('page-malformed');
    expect(
      codeOf(() =>
        orderedLogCommitment([
          log(),
          log({ data: '0xcafe' }),
        ]),
      ),
    ).toBe('page-malformed');
  });

  it('commits to an empty page distinctly from a one-log page', () => {
    expect(orderedLogCommitment([])).toMatch(/^0x[0-9a-f]{64}$/);
    expect(orderedLogCommitment([])).not.toBe(orderedLogCommitment([log()]));
  });
});

describe('page assurance', () => {
  it('requires exactly two distinct origins to corroborate', () => {
    expect(isAuthoritativePage(canonicalPageProof(proof()))).toBe(true);
    expect(
      codeOf(() => canonicalPageProof(proof({ normalizedOrigins: ['https://a.example.com'] }))),
    ).toBe('origin-not-distinct');
  });

  it('treats two spellings of one origin as one origin', () => {
    // A path/credential/case difference is not a second provider; accepting it
    // would let a single faulty endpoint corroborate itself.
    expect(
      codeOf(() =>
        canonicalPageProof(
          proof({
            normalizedOrigins: ['https://a.example.com/rpc', 'https://A.example.com/other?k=1'],
          }),
        ),
      ),
    ).toBe('origin-not-distinct');
    expect(normalizeEndpointOrigin('https://user:pw@A.Example.com:8545/rpc?k=1#f')).toBe(
      'https://a.example.com:8545',
    );
  });

  it('lets an unattested proof carry a single origin', () => {
    const unattested = canonicalPageProof(
      proof({ assurance: 'unattested', normalizedOrigins: ['https://a.example.com'] }),
    );
    expect(isAuthoritativePage(unattested)).toBe(false);
  });

  it('rejects a page above the finalized anchor or inverted in range', () => {
    expect(
      codeOf(() => canonicalPageProof(proof({ through: { blockNumber: 400, blockHash: HASH_B } }))),
    ).toBe('page-malformed');
    expect(
      codeOf(() => canonicalPageProof(proof({ from: { blockNumber: 250, blockHash: HASH_A } }))),
    ).toBe('page-malformed');
  });

  it('freezes the proof and its origin list', () => {
    const frozen = canonicalPageProof(proof());
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.normalizedOrigins)).toBe(true);
  });
});

describe('two-cursor model', () => {
  it('starts the first authoritative page at the deployment block', () => {
    const cursor = canonicalCoverageCursor({
      coveredThrough: null,
      scannedThroughUnattested: {
        blockNumber: 9_000_000,
        blockHash: HASH_A,
        normalizedOrigin: 'https://a.example.com',
      },
    });
    // Unattested observation is far ahead and must NOT be used as a start.
    expect(nextScanFromBlock(cursor, 500)).toBe(500);
  });

  it('resumes AT the partial block, not one past it', () => {
    const cursor = canonicalCoverageCursor({
      coveredThrough: { blockNumber: 100, blockHash: HASH_A },
      resumeAfter: position({ blockNumber: 101, logIndex: 3 }),
    });
    expect(nextScanFromBlock(cursor, 1)).toBe(101);
  });

  it('advances past coveredThrough when no partial page is open', () => {
    const cursor = canonicalCoverageCursor({
      coveredThrough: { blockNumber: 100, blockHash: HASH_A },
    });
    expect(nextScanFromBlock(cursor, 1)).toBe(101);
  });

  it('discards only identities at or below resumeAfter', () => {
    const resume = position({ blockNumber: 101, transactionIndex: 2, logIndex: 3 });
    expect(isDiscardedByResume(position({ blockNumber: 101, transactionIndex: 2, logIndex: 3 }), resume)).toBe(true);
    expect(isDiscardedByResume(position({ blockNumber: 101, transactionIndex: 2, logIndex: 2 }), resume)).toBe(true);
    expect(isDiscardedByResume(position({ blockNumber: 101, transactionIndex: 2, logIndex: 4 }), resume)).toBe(false);
    expect(isDiscardedByResume(position({ blockNumber: 102, transactionIndex: 0, logIndex: 0 }), resume)).toBe(false);
    expect(isDiscardedByResume(position(), undefined)).toBe(false);
  });

  it('rejects a resume point at or below covered coverage', () => {
    expect(
      codeOf(() =>
        canonicalCoverageCursor({
          coveredThrough: { blockNumber: 200, blockHash: HASH_A },
          resumeAfter: position({ blockNumber: 200 }),
        }),
      ),
    ).toBe('cursor-regression');
  });
});

describe('scoped KA candidate parser', () => {
  it('always builds the rootless candidate, including KA number zero', () => {
    const set = canonicalScopedKaCandidatesFromVerifiedUal(
      scope(),
      `did:dkg:84532/${OTHER_ADDRESS}/0`,
    );
    expect(set.candidates).toHaveLength(1);
    expect(set.candidates[0].kind).toBe('rootless-packed');
    expect(BigInt(set.candidates[0].kaId) >> 96n).toBe(BigInt(OTHER_ADDRESS));
    expect(BigInt(set.candidates[0].kaId) & MAX_ROOTLESS_KA_NUMBER).toBe(0n);
  });

  it('returns BOTH candidates for the same-address collision and refuses to choose', () => {
    // did:dkg:<chain>/<KA-storage>/7 round-trips under both forms. Choosing
    // either here would attribute a graph write to the wrong KA; the store
    // resolves it against chain provenance instead.
    const set = canonicalScopedKaCandidatesFromVerifiedUal(
      scope(),
      `did:dkg:84532/${KA_STORAGE}/7`,
    );
    expect(set.candidates.map((candidate) => candidate.kind).sort()).toEqual([
      'legacy-sequential',
      'rootless-packed',
    ]);
    expect(new Set(set.candidates.map((candidate) => candidate.kaId)).size).toBe(2);
  });

  it('omits the legacy candidate for a zero id at the KA storage address', () => {
    // Legacy sequential ids start at 1; id 0 at the storage address is only the
    // rootless (address<<96 | 0) form.
    const set = canonicalScopedKaCandidatesFromVerifiedUal(
      scope(),
      `did:dkg:84532/${KA_STORAGE}/0`,
    );
    expect(set.candidates).toHaveLength(1);
    expect(set.candidates[0].kind).toBe('rootless-packed');
  });

  it('omits the legacy candidate for a foreign address', () => {
    const set = canonicalScopedKaCandidatesFromVerifiedUal(
      scope(),
      `did:dkg:84532/${OTHER_ADDRESS}/7`,
    );
    expect(set.candidates).toHaveLength(1);
    expect(set.candidates[0].kind).toBe('rootless-packed');
  });

  it('round-trips every returned candidate byte-for-byte', () => {
    for (const ual of [
      `did:dkg:84532/${KA_STORAGE}/7`,
      `did:dkg:84532/${OTHER_ADDRESS}/0`,
      `did:dkg:84532/${OTHER_ADDRESS}/${MAX_ROOTLESS_KA_NUMBER.toString()}`,
    ]) {
      const set = canonicalScopedKaCandidatesFromVerifiedUal(scope(), ual);
      for (const candidate of set.candidates) {
        expect(buildScopedKnowledgeAssetUal('84532', KA_STORAGE, BigInt(candidate.kaId))).toBe(ual);
      }
    }
  });

  it('fails closed on a foreign chain', () => {
    expect(
      codeOf(() =>
        canonicalScopedKaCandidatesFromVerifiedUal(scope(), `did:dkg:1/${KA_STORAGE}/7`),
      ),
    ).toBe('foreign-chain');
  });

  it('fails closed on a leading-zero alias and on mixed case', () => {
    expect(
      codeOf(() =>
        canonicalScopedKaCandidatesFromVerifiedUal(scope(), `did:dkg:84532/${KA_STORAGE}/007`),
      ),
    ).toBe('noncanonical-ual');
    expect(
      codeOf(() =>
        canonicalScopedKaCandidatesFromVerifiedUal(
          scope(),
          `did:dkg:84532/0x${'A1'.repeat(20)}/7`,
        ),
      ),
    ).toBe('noncanonical-ual');
  });

  it('fails closed on uint96 overflow at the exact boundary', () => {
    expect(() =>
      canonicalScopedKaCandidatesFromVerifiedUal(
        scope(),
        `did:dkg:84532/${OTHER_ADDRESS}/${MAX_ROOTLESS_KA_NUMBER.toString()}`,
      ),
    ).not.toThrow();
    expect(
      codeOf(() =>
        canonicalScopedKaCandidatesFromVerifiedUal(
          scope(),
          `did:dkg:84532/${OTHER_ADDRESS}/${(MAX_ROOTLESS_KA_NUMBER + 1n).toString()}`,
        ),
      ),
    ).toBe('ka-number-overflow');
  });

  it('fails closed on a malformed UAL shape', () => {
    for (const bad of [
      'did:dkg:84532/only-two-segments',
      `did:dkg:84532/${KA_STORAGE}/7/extra`,
      `dld:dkg:84532/${KA_STORAGE}/7`,
      '',
    ]) {
      expect(codeOf(() => canonicalScopedKaCandidatesFromVerifiedUal(scope(), bad))).toBe(
        'noncanonical-ual',
      );
    }
  });

  it('recomputes scopeId from the supplied scope rather than trusting the caller', () => {
    expect(
      codeOf(() =>
        canonicalScopedKaCandidatesFromVerifiedUal(
          { ...scope(), scopeId: HASH_A },
          `did:dkg:84532/${KA_STORAGE}/7`,
        ),
      ),
    ).toBe('scope-drift');
    const set = canonicalScopedKaCandidatesFromVerifiedUal(
      scope(),
      `did:dkg:84532/${KA_STORAGE}/7`,
    );
    expect(set.scopeId).toBe(deriveVmUpdateScopeId(scope()));
    expect(Object.isFrozen(set)).toBe(true);
    expect(Object.isFrozen(set.candidates)).toBe(true);
  });
});
