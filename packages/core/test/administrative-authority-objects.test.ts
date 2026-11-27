import { describe, expect, it } from 'vitest';

import {
  CG_ADMINISTRATIVE_DELEGATION_OBJECT_TYPE_V1,
  CG_ADMINISTRATIVE_DELEGATION_ROLES_V1,
  CG_OWNERSHIP_TRANSITION_OBJECT_TYPE_V1,
  CHECKPOINT_AUTHORITY_DELEGATION_OBJECT_TYPE_V1,
  MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_BYTES_V1,
  assertCgAdministrativeDelegationV1,
  assertCgOwnershipTransitionV1,
  assertCheckpointAuthorityDelegationV1,
  assertSignedCgAdministrativeDelegationEnvelopeV1,
  assertSignedCgOwnershipTransitionEnvelopeV1,
  assertSignedCheckpointAuthorityDelegationEnvelopeV1,
  assertUnsignedCgAdministrativeDelegationEnvelopeV1,
  assertUnsignedCgOwnershipTransitionEnvelopeV1,
  assertUnsignedCheckpointAuthorityDelegationEnvelopeV1,
  canonicalizeCgAdministrativeDelegationPayloadV1,
  canonicalizeCgOwnershipTransitionPayloadV1,
  canonicalizeCheckpointAuthorityDelegationPayloadV1,
  canonicalizeSignedCgAdministrativeDelegationEnvelopeBytesV1,
  canonicalizeSignedCgOwnershipTransitionEnvelopeBytesV1,
  canonicalizeSignedCheckpointAuthorityDelegationEnvelopeBytesV1,
  canonicalizeUnsignedCgAdministrativeDelegationEnvelopeBytesV1,
  canonicalizeUnsignedCgOwnershipTransitionEnvelopeBytesV1,
  canonicalizeUnsignedCheckpointAuthorityDelegationEnvelopeBytesV1,
  computeCgAdministrativeDelegationObjectDigestV1,
  computeCgOwnershipTransitionObjectDigestV1,
  computeCheckpointAuthorityDelegationObjectDigestV1,
  parseCanonicalCgAdministrativeDelegationPayloadV1,
  parseCanonicalCgOwnershipTransitionPayloadV1,
  parseCanonicalCheckpointAuthorityDelegationPayloadV1,
  parseCanonicalSignedCgAdministrativeDelegationEnvelopeV1,
  parseCanonicalSignedCgOwnershipTransitionEnvelopeV1,
  parseCanonicalSignedCheckpointAuthorityDelegationEnvelopeV1,
  parseCanonicalUnsignedCgAdministrativeDelegationEnvelopeV1,
  parseCanonicalUnsignedCgOwnershipTransitionEnvelopeV1,
  parseCanonicalUnsignedCheckpointAuthorityDelegationEnvelopeV1,
  type CgAdministrativeDelegationV1,
  type CgOwnershipTransitionV1,
  type CheckpointAuthorityDelegationV1,
} from '../src/administrative-authority-objects.js';
import {
  computeControlObjectDigestHex,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '../src/sync-control-object.js';

const SIGNATURE = `0x${'77'.repeat(65)}`;
const ZERO_DIGEST = `0x${'00'.repeat(32)}`;
const TRANSITION_DIGEST = '0x0b54bd4b92d5520c8fe70585ded23a6af0867fc954c0224dbb1e783b95e41a4a';
const ADMIN_DIGEST = '0x050e947b2c06bb5278c8b9b1bb5abd230c82fd97f53b86eb0363f12e966a22b4';
const CHECKPOINT_DIGEST = '0xf46e611726d61ca4da35f031fb407623dcf96cb61a4b3433fef0634395c073de';

const TRANSITION = validatedTransition({
  networkId: 'otp:20430',
  contextGraphId: '0x1111111111111111111111111111111111111111/admin-fixture',
  ownershipEpoch: '2',
  previousFinalizedTransfer: {
    blockNumber: '100',
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: `0x${'12'.repeat(32)}`,
    transactionIndex: '1',
    logIndex: '2',
  },
  finalizedTransfer: {
    chainId: '20430',
    contractAddress: '0x2222222222222222222222222222222222222222',
    blockNumber: '101',
    blockHash: `0x${'21'.repeat(32)}`,
    transactionHash: `0x${'22'.repeat(32)}`,
    transactionIndex: '0',
    logIndex: '3',
    previousOwnerAddress: '0x3333333333333333333333333333333333333333',
    newOwnerAddress: '0x4444444444444444444444444444444444444444',
  },
  mode: 'chain-rebaseline-v1',
  issuedAt: '1700000000123',
});

const ADMIN = validatedAdmin({
  networkId: TRANSITION.networkId,
  contextGraphId: TRANSITION.contextGraphId,
  ownershipTransitionDigest: TRANSITION_DIGEST,
  adminEra: '0',
  version: '0',
  previousDelegationDigest: null,
  ownerAddress: TRANSITION.finalizedTransfer.newOwnerAddress,
  delegateAddress: '0x6666666666666666666666666666666666666666',
  roles: ['checkpoint-delegation', 'policy', 'retention', 'roster'],
  source: {
    kind: 'finalized-chain-owner',
    chainId: '20430',
    contractAddress: TRANSITION.finalizedTransfer.contractAddress,
    blockNumber: '101',
    blockHash: TRANSITION.finalizedTransfer.blockHash,
  },
  effectiveAt: '1700000001000',
  expiresAt: '1700003601000',
});

const CHECKPOINT = validatedCheckpoint({
  networkId: TRANSITION.networkId,
  contextGraphId: TRANSITION.contextGraphId,
  ownershipTransitionDigest: TRANSITION_DIGEST,
  authorityEpoch: '0',
  previousDelegationDigest: null,
  predecessorCheckpointDigest: null,
  predecessorCheckpointVersion: null,
  rebaselineTransitionDigest: TRANSITION_DIGEST,
  checkpointAuthorityAddress: '0x7777777777777777777777777777777777777777',
  standbyCheckpointAuthorityAddress: '0x8888888888888888888888888888888888888888',
  administrativeDelegationDigest: ADMIN_DIGEST,
  activatedAt: '1700000002000',
  expiresAt: '1700003600000',
});

const TRANSITION_CANONICAL = '{"contextGraphId":"0x1111111111111111111111111111111111111111/admin-fixture","finalizedTransfer":{"blockHash":"0x2121212121212121212121212121212121212121212121212121212121212121","blockNumber":"101","chainId":"20430","contractAddress":"0x2222222222222222222222222222222222222222","logIndex":"3","newOwnerAddress":"0x4444444444444444444444444444444444444444","previousOwnerAddress":"0x3333333333333333333333333333333333333333","transactionHash":"0x2222222222222222222222222222222222222222222222222222222222222222","transactionIndex":"0"},"issuedAt":"1700000000123","mode":"chain-rebaseline-v1","networkId":"otp:20430","ownershipEpoch":"2","previousFinalizedTransfer":{"blockHash":"0x1111111111111111111111111111111111111111111111111111111111111111","blockNumber":"100","logIndex":"2","transactionHash":"0x1212121212121212121212121212121212121212121212121212121212121212","transactionIndex":"1"}}';
const ADMIN_CANONICAL = '{"adminEra":"0","contextGraphId":"0x1111111111111111111111111111111111111111/admin-fixture","delegateAddress":"0x6666666666666666666666666666666666666666","effectiveAt":"1700000001000","expiresAt":"1700003601000","networkId":"otp:20430","ownerAddress":"0x4444444444444444444444444444444444444444","ownershipTransitionDigest":"0x0b54bd4b92d5520c8fe70585ded23a6af0867fc954c0224dbb1e783b95e41a4a","previousDelegationDigest":null,"roles":["checkpoint-delegation","policy","retention","roster"],"source":{"blockHash":"0x2121212121212121212121212121212121212121212121212121212121212121","blockNumber":"101","chainId":"20430","contractAddress":"0x2222222222222222222222222222222222222222","kind":"finalized-chain-owner"},"version":"0"}';
const CHECKPOINT_CANONICAL = '{"activatedAt":"1700000002000","administrativeDelegationDigest":"0x050e947b2c06bb5278c8b9b1bb5abd230c82fd97f53b86eb0363f12e966a22b4","authorityEpoch":"0","checkpointAuthorityAddress":"0x7777777777777777777777777777777777777777","contextGraphId":"0x1111111111111111111111111111111111111111/admin-fixture","expiresAt":"1700003600000","networkId":"otp:20430","ownershipTransitionDigest":"0x0b54bd4b92d5520c8fe70585ded23a6af0867fc954c0224dbb1e783b95e41a4a","predecessorCheckpointDigest":null,"predecessorCheckpointVersion":null,"previousDelegationDigest":null,"rebaselineTransitionDigest":"0x0b54bd4b92d5520c8fe70585ded23a6af0867fc954c0224dbb1e783b95e41a4a","standbyCheckpointAuthorityAddress":"0x8888888888888888888888888888888888888888"}';

const TRANSITION_UNSIGNED = unsigned(
  CG_OWNERSHIP_TRANSITION_OBJECT_TYPE_V1,
  TRANSITION,
  TRANSITION.finalizedTransfer.newOwnerAddress,
);
const ADMIN_UNSIGNED = unsigned(
  CG_ADMINISTRATIVE_DELEGATION_OBJECT_TYPE_V1,
  ADMIN,
  ADMIN.ownerAddress,
);
const CHECKPOINT_UNSIGNED = unsigned(
  CHECKPOINT_AUTHORITY_DELEGATION_OBJECT_TYPE_V1,
  CHECKPOINT,
  ADMIN.delegateAddress,
);

const TRANSITION_UNSIGNED_CANONICAL = `{"issuer":"0x4444444444444444444444444444444444444444","objectType":"CgOwnershipTransitionV1","payload":${TRANSITION_CANONICAL},"signatureEvidence":{"kind":"none"},"signatureSuite":"eip191-personal-sign-digest-v1"}`;
const ADMIN_UNSIGNED_CANONICAL = `{"issuer":"0x4444444444444444444444444444444444444444","objectType":"CgAdministrativeDelegationV1","payload":${ADMIN_CANONICAL},"signatureEvidence":{"kind":"none"},"signatureSuite":"eip191-personal-sign-digest-v1"}`;
const CHECKPOINT_UNSIGNED_CANONICAL = `{"issuer":"0x6666666666666666666666666666666666666666","objectType":"CheckpointAuthorityDelegationV1","payload":${CHECKPOINT_CANONICAL},"signatureEvidence":{"kind":"none"},"signatureSuite":"eip191-personal-sign-digest-v1"}`;

describe('CgOwnershipTransitionV1 codec', () => {
  it('pins canonical payload/envelope bytes and object digest', () => {
    expect(canonicalizeCgOwnershipTransitionPayloadV1(TRANSITION)).toBe(TRANSITION_CANONICAL);
    expect(new TextEncoder().encode(TRANSITION_CANONICAL)).toHaveLength(894);
    expect(parseCanonicalCgOwnershipTransitionPayloadV1(TRANSITION_CANONICAL))
      .toEqual(TRANSITION);

    const canonicalEnvelope = decode(
      canonicalizeUnsignedCgOwnershipTransitionEnvelopeBytesV1(TRANSITION_UNSIGNED),
    );
    expect(canonicalEnvelope).toBe(TRANSITION_UNSIGNED_CANONICAL);
    expect(new TextEncoder().encode(canonicalEnvelope)).toHaveLength(1085);
    expect(computeCgOwnershipTransitionObjectDigestV1(TRANSITION_UNSIGNED))
      .toBe(TRANSITION_DIGEST);
    expect(parseCanonicalUnsignedCgOwnershipTransitionEnvelopeV1(canonicalEnvelope))
      .toEqual(TRANSITION_UNSIGNED);
    const signedEnvelope = signed(TRANSITION_UNSIGNED, TRANSITION_DIGEST);
    expect(parseCanonicalSignedCgOwnershipTransitionEnvelopeV1(
      decode(canonicalizeSignedCgOwnershipTransitionEnvelopeBytesV1(signedEnvelope)),
    )).toEqual(signedEnvelope);
  });

  it('closes the one-based finalized transfer branch and orders chain positions', () => {
    expect(() => assertCgOwnershipTransitionV1({
      ...TRANSITION,
      ownershipEpoch: '1',
      previousFinalizedTransfer: null,
    })).not.toThrow();
    expect(() => assertCgOwnershipTransitionV1({
      ...TRANSITION,
      ownershipEpoch: '0',
    })).toThrow(/one-based/);
    expect(() => assertCgOwnershipTransitionV1({
      ...TRANSITION,
      ownershipEpoch: '1',
    })).toThrow(/only ownership epoch one/);
    expect(() => assertCgOwnershipTransitionV1({
      ...TRANSITION,
      previousFinalizedTransfer: null,
    })).toThrow(/only ownership epoch one/);
    expect(() => assertCgOwnershipTransitionV1({
      ...TRANSITION,
      previousFinalizedTransfer: {
        ...TRANSITION.previousFinalizedTransfer,
        blockNumber: '102',
      },
    })).toThrow(/must precede/);

    expect(() => assertCgOwnershipTransitionV1({
      ...TRANSITION,
      previousFinalizedTransfer: {
        ...TRANSITION.previousFinalizedTransfer,
        blockNumber: TRANSITION.finalizedTransfer.blockNumber,
        transactionIndex: TRANSITION.finalizedTransfer.transactionIndex,
        logIndex: '2',
      },
    })).not.toThrow();
    expect(() => assertCgOwnershipTransitionV1({
      ...TRANSITION,
      previousFinalizedTransfer: {
        ...TRANSITION.previousFinalizedTransfer,
        blockNumber: TRANSITION.finalizedTransfer.blockNumber,
        transactionIndex: '1',
        logIndex: '99',
      },
      finalizedTransfer: {
        ...TRANSITION.finalizedTransfer,
        transactionIndex: '2',
        logIndex: '0',
      },
    })).not.toThrow();
    expect(() => assertCgOwnershipTransitionV1({
      ...TRANSITION,
      previousFinalizedTransfer: {
        ...TRANSITION.previousFinalizedTransfer,
        blockNumber: TRANSITION.finalizedTransfer.blockNumber,
        transactionIndex: TRANSITION.finalizedTransfer.transactionIndex,
        logIndex: TRANSITION.finalizedTransfer.logIndex,
      },
    })).toThrow(/must precede/);
  });

  it('rejects unknown modes, fields, and noncanonical scalars', () => {
    expect(() => assertCgOwnershipTransitionV1({ ...TRANSITION, mode: 'linked-v1' }))
      .toThrow(/chain-rebaseline-v1/);
    expect(() => assertCgOwnershipTransitionV1({ ...TRANSITION, subGraphName: 'forbidden' }))
      .toThrow(/admin-authority-schema/);
    expect(() => assertCgOwnershipTransitionV1({ ...TRANSITION, ownershipEpoch: 2 }))
      .toThrow(/admin-authority-scalar/);
    expect(() => assertCgOwnershipTransitionV1({
      ...TRANSITION,
      finalizedTransfer: {
        ...TRANSITION.finalizedTransfer,
        newOwnerAddress: '0x0000000000000000000000000000000000000000',
      },
    })).toThrow(/admin-authority-scalar/);
  });

  it('accepts the structurally legal all-zero digest in every required hash field', () => {
    expect(() => assertCgOwnershipTransitionV1({
      ...TRANSITION,
      previousFinalizedTransfer: {
        ...TRANSITION.previousFinalizedTransfer,
        blockHash: ZERO_DIGEST,
        transactionHash: ZERO_DIGEST,
      },
      finalizedTransfer: {
        ...TRANSITION.finalizedTransfer,
        blockHash: ZERO_DIGEST,
        transactionHash: ZERO_DIGEST,
      },
    })).not.toThrow();
  });
});

describe('CgAdministrativeDelegationV1 codec', () => {
  it('pins canonical payload/envelope bytes and object digest', () => {
    expect(canonicalizeCgAdministrativeDelegationPayloadV1(ADMIN)).toBe(ADMIN_CANONICAL);
    expect(new TextEncoder().encode(ADMIN_CANONICAL)).toHaveLength(728);
    expect(parseCanonicalCgAdministrativeDelegationPayloadV1(ADMIN_CANONICAL)).toEqual(ADMIN);

    const canonicalEnvelope = decode(
      canonicalizeUnsignedCgAdministrativeDelegationEnvelopeBytesV1(ADMIN_UNSIGNED),
    );
    expect(canonicalEnvelope).toBe(ADMIN_UNSIGNED_CANONICAL);
    expect(new TextEncoder().encode(canonicalEnvelope)).toHaveLength(924);
    expect(computeCgAdministrativeDelegationObjectDigestV1(ADMIN_UNSIGNED)).toBe(ADMIN_DIGEST);
    expect(parseCanonicalUnsignedCgAdministrativeDelegationEnvelopeV1(canonicalEnvelope))
      .toEqual(ADMIN_UNSIGNED);
    const signedEnvelope = signed(ADMIN_UNSIGNED, ADMIN_DIGEST);
    expect(parseCanonicalSignedCgAdministrativeDelegationEnvelopeV1(
      decode(canonicalizeSignedCgAdministrativeDelegationEnvelopeBytesV1(signedEnvelope)),
    )).toEqual(signedEnvelope);
  });

  it('freezes the exact role registry and requires sorted unique literal roles', () => {
    expect(Object.isFrozen(CG_ADMINISTRATIVE_DELEGATION_ROLES_V1)).toBe(true);
    expect(CG_ADMINISTRATIVE_DELEGATION_ROLES_V1).toEqual([
      'checkpoint-delegation',
      'policy',
      'retention',
      'roster',
    ]);
    expect(() => (CG_ADMINISTRATIVE_DELEGATION_ROLES_V1 as unknown as string[]).push('owner'))
      .toThrow();
    expect(() => assertCgAdministrativeDelegationV1({ ...ADMIN, roles: [] })).not.toThrow();
    expect(() => assertCgAdministrativeDelegationV1({
      ...ADMIN,
      roles: ['policy', 'checkpoint-delegation'],
    })).toThrow(/strictly sorted/);
    expect(() => assertCgAdministrativeDelegationV1({
      ...ADMIN,
      roles: ['policy', 'policy'],
    })).toThrow(/strictly sorted/);
    expect(() => assertCgAdministrativeDelegationV1({ ...ADMIN, roles: ['vm-publisher'] }))
      .toThrow(/admin-authority-role/);

    let coercions = 0;
    const hostile = { toString() { coercions += 1; return 'policy'; } };
    expect(() => assertCgAdministrativeDelegationV1({ ...ADMIN, roles: [hostile] }))
      .toThrow(/admin-authority-role/);
    expect(coercions).toBe(0);
  });

  it('closes finalized-chain and owner-signed-unregistered source branches', () => {
    expect(() => assertCgAdministrativeDelegationV1({
      ...ADMIN,
      ownershipTransitionDigest: null,
    })).not.toThrow();
    expect(() => assertCgAdministrativeDelegationV1({
      ...ADMIN,
      ownershipTransitionDigest: null,
      source: { kind: 'owner-signed-unregistered', ownerAuthorityEra: '0' },
    })).not.toThrow();
    expect(() => assertCgAdministrativeDelegationV1({
      ...ADMIN,
      source: { kind: 'owner-signed-unregistered', ownerAuthorityEra: '0' },
    })).toThrow(/requires a null ownership transition/);
    expect(() => assertCgAdministrativeDelegationV1({
      ...ADMIN,
      source: { ...ADMIN.source, kind: 'claimed-owner' },
    })).toThrow(/source kind/);
    expect(() => assertCgAdministrativeDelegationV1({
      ...ADMIN,
      source: { ...ADMIN.source, proof: 'extra' },
    })).toThrow(/admin-authority-schema/);
  });

  it('enforces the local genesis/successor predecessor branch in both directions', () => {
    expect(() => assertCgAdministrativeDelegationV1(ADMIN)).not.toThrow();
    expect(() => assertCgAdministrativeDelegationV1({
      ...ADMIN,
      version: '1',
      previousDelegationDigest: ZERO_DIGEST,
    })).not.toThrow();
    expect(() => assertCgAdministrativeDelegationV1({
      ...ADMIN,
      adminEra: '1',
      previousDelegationDigest: ZERO_DIGEST,
    })).not.toThrow();

    expect(() => assertCgAdministrativeDelegationV1({
      ...ADMIN,
      version: '1',
      previousDelegationDigest: null,
    })).toThrow(/null exactly for admin era\/version zero/);
    expect(() => assertCgAdministrativeDelegationV1({
      ...ADMIN,
      adminEra: '1',
      previousDelegationDigest: null,
    })).toThrow(/null exactly for admin era\/version zero/);
    expect(() => assertCgAdministrativeDelegationV1({
      ...ADMIN,
      previousDelegationDigest: ZERO_DIGEST,
    })).toThrow(/null exactly for admin era\/version zero/);
  });

  it('accepts all-zero values in required and optional administrative digest fields', () => {
    expect(() => assertCgAdministrativeDelegationV1({
      ...ADMIN,
      ownershipTransitionDigest: ZERO_DIGEST,
      source: { ...ADMIN.source, blockHash: ZERO_DIGEST },
    })).not.toThrow();
    expect(() => assertCgAdministrativeDelegationV1({
      ...ADMIN,
      version: '1',
      previousDelegationDigest: ZERO_DIGEST,
      source: { ...ADMIN.source, blockHash: ZERO_DIGEST },
    })).not.toThrow();
  });

  it('requires a strictly increasing validity interval', () => {
    expect(() => assertCgAdministrativeDelegationV1({
      ...ADMIN,
      expiresAt: ADMIN.effectiveAt,
    })).toThrow(/effectiveAt must be earlier/);
    expect(() => assertCgAdministrativeDelegationV1({
      ...ADMIN,
      effectiveAt: '1700003601001',
    })).toThrow(/effectiveAt must be earlier/);
  });
});

describe('CheckpointAuthorityDelegationV1 codec', () => {
  it('pins canonical payload/envelope bytes and object digest', () => {
    expect(canonicalizeCheckpointAuthorityDelegationPayloadV1(CHECKPOINT))
      .toBe(CHECKPOINT_CANONICAL);
    expect(new TextEncoder().encode(CHECKPOINT_CANONICAL)).toHaveLength(735);
    expect(parseCanonicalCheckpointAuthorityDelegationPayloadV1(CHECKPOINT_CANONICAL))
      .toEqual(CHECKPOINT);

    const canonicalEnvelope = decode(
      canonicalizeUnsignedCheckpointAuthorityDelegationEnvelopeBytesV1(CHECKPOINT_UNSIGNED),
    );
    expect(canonicalEnvelope).toBe(CHECKPOINT_UNSIGNED_CANONICAL);
    expect(new TextEncoder().encode(canonicalEnvelope)).toHaveLength(934);
    expect(computeCheckpointAuthorityDelegationObjectDigestV1(CHECKPOINT_UNSIGNED))
      .toBe(CHECKPOINT_DIGEST);
    expect(parseCanonicalUnsignedCheckpointAuthorityDelegationEnvelopeV1(canonicalEnvelope))
      .toEqual(CHECKPOINT_UNSIGNED);
    const signedEnvelope = signed(CHECKPOINT_UNSIGNED, CHECKPOINT_DIGEST);
    expect(parseCanonicalSignedCheckpointAuthorityDelegationEnvelopeV1(
      decode(canonicalizeSignedCheckpointAuthorityDelegationEnvelopeBytesV1(signedEnvelope)),
    )).toEqual(signedEnvelope);
  });

  it('requires predecessor digest/version to be jointly null or non-null', () => {
    expect(() => assertCheckpointAuthorityDelegationV1({
      ...CHECKPOINT,
      predecessorCheckpointDigest: `0x${'91'.repeat(32)}`,
    })).toThrow(/jointly null/);
    expect(() => assertCheckpointAuthorityDelegationV1({
      ...CHECKPOINT,
      predecessorCheckpointVersion: '0',
    })).toThrow(/jointly null/);
  });

  it('accepts the local initial branch shape', () => {
    const initial = {
      ...CHECKPOINT,
      ownershipTransitionDigest: null,
      rebaselineTransitionDigest: null,
      administrativeDelegationDigest: null,
    };
    expect(() => assertCheckpointAuthorityDelegationV1(initial)).not.toThrow();
  });

  it('accepts the local ownership-rebaseline branch shape', () => {
    expect(() => assertCheckpointAuthorityDelegationV1(CHECKPOINT)).not.toThrow();
  });

  it('accepts the local ordinary-rotation branch shape', () => {
    const rotation = {
      ...CHECKPOINT,
      authorityEpoch: '1',
      previousDelegationDigest: `0x${'90'.repeat(32)}`,
      predecessorCheckpointDigest: `0x${'91'.repeat(32)}`,
      predecessorCheckpointVersion: '8',
      rebaselineTransitionDigest: null,
    };
    expect(() => assertCheckpointAuthorityDelegationV1(rotation)).not.toThrow();
  });

  it('rejects values that mix initial, rebaseline, and ordinary-rotation branches', () => {
    const rotation = {
      ...CHECKPOINT,
      authorityEpoch: '1',
      previousDelegationDigest: `0x${'90'.repeat(32)}`,
      predecessorCheckpointDigest: `0x${'91'.repeat(32)}`,
      predecessorCheckpointVersion: '8',
      rebaselineTransitionDigest: null,
    };
    expect(() => assertCheckpointAuthorityDelegationV1({
      ...rotation,
      previousDelegationDigest: null,
    })).toThrow(/ordinary rotation requires/);
    expect(() => assertCheckpointAuthorityDelegationV1({
      ...rotation,
      authorityEpoch: '0',
    })).toThrow(/ordinary rotation requires/);
    expect(() => assertCheckpointAuthorityDelegationV1({
      ...CHECKPOINT,
      rebaselineTransitionDigest: `0x${'99'.repeat(32)}`,
    })).toThrow(/rebaseline must bind/);
    expect(() => assertCheckpointAuthorityDelegationV1({
      ...CHECKPOINT,
      previousDelegationDigest: `0x${'90'.repeat(32)}`,
    })).toThrow(/rebaseline must bind/);
    expect(() => assertCheckpointAuthorityDelegationV1({
      ...CHECKPOINT,
      rebaselineTransitionDigest: null,
    })).toThrow(/initial delegation/);
  });

  it('accepts all-zero values in every optional checkpoint digest field', () => {
    expect(() => assertCheckpointAuthorityDelegationV1({
      ...CHECKPOINT,
      ownershipTransitionDigest: ZERO_DIGEST,
      rebaselineTransitionDigest: ZERO_DIGEST,
      administrativeDelegationDigest: ZERO_DIGEST,
    })).not.toThrow();

    expect(() => assertCheckpointAuthorityDelegationV1({
      ...CHECKPOINT,
      ownershipTransitionDigest: ZERO_DIGEST,
      authorityEpoch: '1',
      previousDelegationDigest: ZERO_DIGEST,
      predecessorCheckpointDigest: ZERO_DIGEST,
      predecessorCheckpointVersion: '0',
      rebaselineTransitionDigest: null,
      administrativeDelegationDigest: ZERO_DIGEST,
    })).not.toThrow();
  });

  it('rejects equal standby authority and non-increasing validity', () => {
    expect(() => assertCheckpointAuthorityDelegationV1({
      ...CHECKPOINT,
      standbyCheckpointAuthorityAddress: CHECKPOINT.checkpointAuthorityAddress,
    })).toThrow(/standby authority must differ/);
    expect(() => assertCheckpointAuthorityDelegationV1({
      ...CHECKPOINT,
      expiresAt: CHECKPOINT.activatedAt,
    })).toThrow(/activatedAt must be earlier/);
  });
});

describe('administrative authority hostile-input and envelope boundaries', () => {
  it('enforces the 16 KiB payload cap and depth three before typed use', () => {
    const exactlyAtCap = `"${'a'.repeat(
      MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_BYTES_V1 - 2,
    )}"`;
    expect(new TextEncoder().encode(exactlyAtCap)).toHaveLength(
      MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_BYTES_V1,
    );
    expect(() => parseCanonicalCgOwnershipTransitionPayloadV1(exactlyAtCap))
      .toThrow(/admin-authority-schema/);

    const oneByteOver = `"${'a'.repeat(
      MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_BYTES_V1 - 1,
    )}"`;
    expect(() => parseCanonicalCgOwnershipTransitionPayloadV1(oneByteOver))
      .toThrow(/admin-authority-payload-too-large/);
    const multibyteOver = `"${'é'.repeat(
      MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_BYTES_V1 / 2,
    )}"`;
    expect(multibyteOver.length).toBeLessThan(MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_BYTES_V1);
    expect(() => parseCanonicalCgOwnershipTransitionPayloadV1(multibyteOver))
      .toThrow(/admin-authority-payload-too-large/);
    expect(() => parseCanonicalCgOwnershipTransitionPayloadV1(
      new Uint8Array(MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_BYTES_V1 + 1),
    )).toThrow(/admin-authority-payload-too-large/);
    expect(() => parseCanonicalCgAdministrativeDelegationPayloadV1('{"a":{"b":{"c":{}}}}'))
      .toThrow(/nesting exceeds 3/);
    expect(() => parseCanonicalCheckpointAuthorityDelegationPayloadV1(
      CHECKPOINT_CANONICAL.replace('"authorityEpoch":"0"', '"authorityEpoch": "0"'),
    )).toThrow();
  });

  it('rejects accessors and stateful payload or whole-envelope proxies', () => {
    let getterCalls = 0;
    const source = { ...ADMIN.source } as Record<string, unknown>;
    Object.defineProperty(source, 'kind', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'finalized-chain-owner';
      },
    });
    expect(() => assertCgAdministrativeDelegationV1({ ...ADMIN, source }))
      .toThrow(/admin-authority-schema/);
    expect(getterCalls).toBe(0);

    let roleReads = 0;
    const roles = new Proxy(['policy'], {
      get(target, property, receiver) {
        if (property === '0') {
          roleReads += 1;
          return roleReads === 1 ? 'policy' : 'owner';
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => assertCgAdministrativeDelegationV1({ ...ADMIN, roles }))
      .toThrow(/admin-authority-schema/);

    let payloadReads = 0;
    const envelope = new Proxy(ADMIN_UNSIGNED, {
      get(target, property, receiver) {
        if (property === 'payload') {
          payloadReads += 1;
          return payloadReads <= 2 ? ADMIN : { granted: true };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => canonicalizeUnsignedCgAdministrativeDelegationEnvelopeBytesV1(envelope))
      .toThrow(/admin-authority-schema/);
    expect(payloadReads).toBe(2);
  });

  it('enforces exact object types and validates signed digests', () => {
    expect(() => assertUnsignedCgOwnershipTransitionEnvelopeV1(TRANSITION_UNSIGNED))
      .not.toThrow();
    expect(() => assertUnsignedCgAdministrativeDelegationEnvelopeV1(ADMIN_UNSIGNED))
      .not.toThrow();
    expect(() => assertUnsignedCheckpointAuthorityDelegationEnvelopeV1(CHECKPOINT_UNSIGNED))
      .not.toThrow();
    expect(() => assertSignedCgOwnershipTransitionEnvelopeV1(
      signed(TRANSITION_UNSIGNED, TRANSITION_DIGEST),
    )).not.toThrow();
    expect(() => assertSignedCgAdministrativeDelegationEnvelopeV1(
      signed(ADMIN_UNSIGNED, ADMIN_DIGEST),
    )).not.toThrow();
    expect(() => assertSignedCheckpointAuthorityDelegationEnvelopeV1(
      signed(CHECKPOINT_UNSIGNED, CHECKPOINT_DIGEST),
    )).not.toThrow();
    expect(() => assertUnsignedCgOwnershipTransitionEnvelopeV1({
      ...TRANSITION_UNSIGNED,
      objectType: CG_ADMINISTRATIVE_DELEGATION_OBJECT_TYPE_V1,
    })).toThrow(/admin-authority-type/);
    expect(() => assertSignedCheckpointAuthorityDelegationEnvelopeV1({
      ...signed(CHECKPOINT_UNSIGNED, CHECKPOINT_DIGEST),
      objectDigest: TRANSITION_DIGEST,
    })).toThrow(/admin-authority-schema/);
  });

  it('binds ownership and administrative issuers on unsigned and redigested signed envelopes', () => {
    const wrongTransitionIssuer = {
      ...TRANSITION_UNSIGNED,
      issuer: '0x5555555555555555555555555555555555555555',
    } as UnsignedControlEnvelopeV1;
    expect(() => assertUnsignedCgOwnershipTransitionEnvelopeV1(wrongTransitionIssuer))
      .toThrow(/issuer must equal finalizedTransfer\.newOwnerAddress/);
    const redigestedTransition = computeControlObjectDigestHex(wrongTransitionIssuer);
    expect(redigestedTransition).not.toBe(TRANSITION_DIGEST);
    expect(() => assertSignedCgOwnershipTransitionEnvelopeV1(
      signed(wrongTransitionIssuer, redigestedTransition),
    )).toThrow(/issuer must equal finalizedTransfer\.newOwnerAddress/);

    const wrongAdministrativeIssuer = {
      ...ADMIN_UNSIGNED,
      issuer: ADMIN.delegateAddress,
    } as UnsignedControlEnvelopeV1;
    expect(() => assertUnsignedCgAdministrativeDelegationEnvelopeV1(
      wrongAdministrativeIssuer,
    )).toThrow(/issuer must equal ownerAddress/);
    const redigestedAdministrative = computeControlObjectDigestHex(wrongAdministrativeIssuer);
    expect(redigestedAdministrative).not.toBe(ADMIN_DIGEST);
    expect(() => assertSignedCgAdministrativeDelegationEnvelopeV1(
      signed(wrongAdministrativeIssuer, redigestedAdministrative),
    )).toThrow(/issuer must equal ownerAddress/);
  });
});

function validatedTransition(value: unknown): CgOwnershipTransitionV1 {
  assertCgOwnershipTransitionV1(value);
  return value;
}

function validatedAdmin(value: unknown): CgAdministrativeDelegationV1 {
  assertCgAdministrativeDelegationV1(value);
  return value;
}

function validatedCheckpoint(value: unknown): CheckpointAuthorityDelegationV1 {
  assertCheckpointAuthorityDelegationV1(value);
  return value;
}

function unsigned(objectType: string, payload: object, issuer: string): UnsignedControlEnvelopeV1 {
  return {
    issuer,
    objectType,
    payload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as unknown as UnsignedControlEnvelopeV1;
}

function signed(
  envelope: UnsignedControlEnvelopeV1,
  objectDigest: string,
): SignedControlEnvelopeV1 {
  return { ...envelope, objectDigest, signature: SIGNATURE } as SignedControlEnvelopeV1;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
