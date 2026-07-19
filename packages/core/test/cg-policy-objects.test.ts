import { describe, expect, it } from 'vitest';

import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  MAX_CONTEXT_GRAPH_POLICY_PAYLOAD_BYTES_V1,
  MAX_MEMBER_ROSTER_PAYLOAD_BYTES_V1,
  MAX_MEMBER_ROSTER_ENTRIES_V1,
  MEMBER_ROSTER_ROLES_V1,
  MEMBER_ROSTER_OBJECT_TYPE_V1,
  assertContextGraphPolicyV1,
  assertMemberRosterV1,
  assertSignedContextGraphPolicyEnvelopeV1,
  assertSignedMemberRosterEnvelopeV1,
  assertUnsignedContextGraphPolicyEnvelopeV1,
  assertUnsignedMemberRosterEnvelopeV1,
  canonicalizeContextGraphPolicyPayloadV1,
  canonicalizeMemberRosterPayloadV1,
  canonicalizeSignedContextGraphPolicyEnvelopeBytesV1,
  canonicalizeSignedMemberRosterEnvelopeBytesV1,
  canonicalizeUnsignedContextGraphPolicyEnvelopeBytesV1,
  canonicalizeUnsignedMemberRosterEnvelopeBytesV1,
  computeContextGraphPolicyObjectDigestV1,
  computeMemberRosterObjectDigestV1,
  parseCanonicalContextGraphPolicyPayloadV1,
  parseCanonicalMemberRosterPayloadV1,
  parseCanonicalSignedContextGraphPolicyEnvelopeV1,
  parseCanonicalSignedMemberRosterEnvelopeV1,
  parseCanonicalUnsignedContextGraphPolicyEnvelopeV1,
  parseCanonicalUnsignedMemberRosterEnvelopeV1,
  type ContextGraphPolicyV1,
  type MemberRosterV1,
} from '../src/cg-policy-objects.js';
import {
  CONTROL_OBJECT_SIGNATURE_SUITES,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '../src/sync-control-object.js';

const ISSUER = '0x5555555555555555555555555555555555555555';
const SIGNATURE = `0x${'77'.repeat(65)}`;
const POLICY_DIGEST = '0x757a6c30157d416fc7f15e20a2ea4b4ccb57fb4d06000861d5c2bd47102a6db6';
const ROSTER_DIGEST = '0x38bcd20907a5df67651bee6df47d774e4345f907a8e23ddf34a3b32c0933b02d';

const POLICY = validatedPolicy({
  networkId: 'otp:20430',
  contextGraphId: '0x1111111111111111111111111111111111111111/policy-fixture',
  governanceChainId: '20430',
  governanceContractAddress: '0x2222222222222222222222222222222222222222',
  ownershipTransitionDigest: null,
  era: '0',
  version: '0',
  previousPolicyDigest: null,
  accessPolicy: 0,
  publishPolicy: 1,
  publishAuthority: null,
  publishAuthorityAccountId: '0',
  projectionId: 'cg-shared-v1',
  administrativeDelegationDigest: null,
  source: {
    kind: 'finalized-chain',
    chainId: '20430',
    contractAddress: '0x2222222222222222222222222222222222222222',
    blockNumber: '123',
    blockHash: `0x${'33'.repeat(32)}`,
  },
  effectiveAt: '1700000000000',
  issuedAt: '1700000000123',
});

const ROSTER = validatedRoster({
  networkId: POLICY.networkId,
  contextGraphId: POLICY.contextGraphId,
  ownershipTransitionDigest: null,
  era: '0',
  version: '0',
  previousRosterDigest: null,
  policyDigest: POLICY_DIGEST,
  administrativeDelegationDigest: null,
  members: [
    {
      agentAddress: '0x1111111111111111111111111111111111111111',
      roles: ['holder', 'provider'],
    },
    {
      agentAddress: '0x2222222222222222222222222222222222222222',
      roles: [],
    },
  ],
  issuedAt: '1700000000123',
});

const POLICY_CANONICAL = '{"accessPolicy":0,"administrativeDelegationDigest":null,"contextGraphId":"0x1111111111111111111111111111111111111111/policy-fixture","effectiveAt":"1700000000000","era":"0","governanceChainId":"20430","governanceContractAddress":"0x2222222222222222222222222222222222222222","issuedAt":"1700000000123","networkId":"otp:20430","ownershipTransitionDigest":null,"previousPolicyDigest":null,"projectionId":"cg-shared-v1","publishAuthority":null,"publishAuthorityAccountId":"0","publishPolicy":1,"source":{"blockHash":"0x3333333333333333333333333333333333333333333333333333333333333333","blockNumber":"123","chainId":"20430","contractAddress":"0x2222222222222222222222222222222222222222","kind":"finalized-chain"},"version":"0"}';
const ROSTER_CANONICAL = '{"administrativeDelegationDigest":null,"contextGraphId":"0x1111111111111111111111111111111111111111/policy-fixture","era":"0","issuedAt":"1700000000123","members":[{"agentAddress":"0x1111111111111111111111111111111111111111","roles":["holder","provider"]},{"agentAddress":"0x2222222222222222222222222222222222222222","roles":[]}],"networkId":"otp:20430","ownershipTransitionDigest":null,"policyDigest":"0x757a6c30157d416fc7f15e20a2ea4b4ccb57fb4d06000861d5c2bd47102a6db6","previousRosterDigest":null,"version":"0"}';
const POLICY_UNSIGNED = unsigned(CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1, POLICY);
const ROSTER_UNSIGNED = unsigned(MEMBER_ROSTER_OBJECT_TYPE_V1, ROSTER);
const POLICY_UNSIGNED_CANONICAL = '{"issuer":"0x5555555555555555555555555555555555555555","objectType":"ContextGraphPolicyV1","payload":{"accessPolicy":0,"administrativeDelegationDigest":null,"contextGraphId":"0x1111111111111111111111111111111111111111/policy-fixture","effectiveAt":"1700000000000","era":"0","governanceChainId":"20430","governanceContractAddress":"0x2222222222222222222222222222222222222222","issuedAt":"1700000000123","networkId":"otp:20430","ownershipTransitionDigest":null,"previousPolicyDigest":null,"projectionId":"cg-shared-v1","publishAuthority":null,"publishAuthorityAccountId":"0","publishPolicy":1,"source":{"blockHash":"0x3333333333333333333333333333333333333333333333333333333333333333","blockNumber":"123","chainId":"20430","contractAddress":"0x2222222222222222222222222222222222222222","kind":"finalized-chain"},"version":"0"},"signatureEvidence":{"kind":"none"},"signatureSuite":"eip191-personal-sign-digest-v1"}';
const ROSTER_UNSIGNED_CANONICAL = '{"issuer":"0x5555555555555555555555555555555555555555","objectType":"MemberRosterV1","payload":{"administrativeDelegationDigest":null,"contextGraphId":"0x1111111111111111111111111111111111111111/policy-fixture","era":"0","issuedAt":"1700000000123","members":[{"agentAddress":"0x1111111111111111111111111111111111111111","roles":["holder","provider"]},{"agentAddress":"0x2222222222222222222222222222222222222222","roles":[]}],"networkId":"otp:20430","ownershipTransitionDigest":null,"policyDigest":"0x757a6c30157d416fc7f15e20a2ea4b4ccb57fb4d06000861d5c2bd47102a6db6","previousRosterDigest":null,"version":"0"},"signatureEvidence":{"kind":"none"},"signatureSuite":"eip191-personal-sign-digest-v1"}';
const POLICY_SIGNED = signed(POLICY_UNSIGNED, POLICY_DIGEST);
const ROSTER_SIGNED = signed(ROSTER_UNSIGNED, ROSTER_DIGEST);

describe('ContextGraphPolicyV1 codec', () => {
  it('pins canonical payload/envelope bytes and digest', () => {
    const canonical = canonicalizeContextGraphPolicyPayloadV1(POLICY);
    expect(canonical).toBe(POLICY_CANONICAL);
    expect(new TextEncoder().encode(canonical)).toHaveLength(722);
    expect(parseCanonicalContextGraphPolicyPayloadV1(canonical)).toEqual(POLICY);
    const unsignedCanonical = new TextDecoder().decode(
      canonicalizeUnsignedContextGraphPolicyEnvelopeBytesV1(POLICY_UNSIGNED),
    );
    expect(unsignedCanonical).toBe(POLICY_UNSIGNED_CANONICAL);
    expect(new TextEncoder().encode(unsignedCanonical)).toHaveLength(910);
    expect(computeContextGraphPolicyObjectDigestV1(POLICY_UNSIGNED)).toBe(POLICY_DIGEST);
    expect(parseCanonicalUnsignedContextGraphPolicyEnvelopeV1(
      canonicalUnsigned(POLICY_UNSIGNED),
    )).toEqual(POLICY_UNSIGNED);
    expect(parseCanonicalSignedContextGraphPolicyEnvelopeV1(
      new TextDecoder().decode(canonicalizeSignedContextGraphPolicyEnvelopeBytesV1(POLICY_SIGNED)),
    )).toEqual(POLICY_SIGNED);
  });

  it('enforces finalized and unregistered governance source branches', () => {
    expect(() => assertContextGraphPolicyV1({
      ...POLICY,
      source: { ...POLICY.source, chainId: '1' },
    })).toThrow(/cg-policy-governance/);
    expect(() => assertContextGraphPolicyV1({
      ...POLICY,
      governanceChainId: null,
      governanceContractAddress: null,
      source: {
        kind: 'owner-signed-unregistered',
        ownerAddress: ISSUER,
        ownerAuthorityEra: '0',
      },
    })).not.toThrow();
    expect(() => assertContextGraphPolicyV1({
      ...POLICY,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: `0x${'44'.repeat(32)}`,
      source: {
        kind: 'owner-signed-unregistered',
        ownerAddress: ISSUER,
        ownerAuthorityEra: '0',
      },
    })).toThrow(/cg-policy-governance/);
    expect(() => assertContextGraphPolicyV1({
      ...POLICY,
      governanceContractAddress: null,
    })).toThrow(/cg-policy-governance/);
  });

  it('keeps contribution policy independent and closes its authority branch', () => {
    for (const cell of [
      { accessPolicy: 0, publishPolicy: 1, publishAuthority: null, publishAuthorityAccountId: '0' },
      { accessPolicy: 1, publishPolicy: 1, publishAuthority: null, publishAuthorityAccountId: '0' },
      { accessPolicy: 0, publishPolicy: 0, publishAuthority: ISSUER, publishAuthorityAccountId: '0' },
      { accessPolicy: 1, publishPolicy: 0, publishAuthority: ISSUER, publishAuthorityAccountId: '0' },
      { accessPolicy: 1, publishPolicy: 0, publishAuthority: ISSUER, publishAuthorityAccountId: '7' },
    ]) {
      expect(() => assertContextGraphPolicyV1({ ...POLICY, ...cell })).not.toThrow();
    }
    expect(() => assertContextGraphPolicyV1({ ...POLICY, publishAuthority: ISSUER }))
      .toThrow(/cg-policy-publish-domain/);
    expect(() => assertContextGraphPolicyV1({ ...POLICY, publishPolicy: 0 }))
      .toThrow(/cg-policy-publish-domain/);
    for (const value of [2, '0', null]) {
      expect(() => assertContextGraphPolicyV1({ ...POLICY, accessPolicy: value }))
        .toThrow(/cg-policy-scalar/);
    }
    expect(() => assertContextGraphPolicyV1({ ...POLICY, publishPolicy: 2 }))
      .toThrow(/cg-policy-scalar/);
  });

  it('rejects unknown fields, wrong projection, malformed scalars, and noncanonical wire', () => {
    expect(() => assertContextGraphPolicyV1({ ...POLICY, subGraphName: null }))
      .toThrow(/cg-policy-schema/);
    expect(() => assertContextGraphPolicyV1({ ...POLICY, projectionId: 'other' }))
      .toThrow(/cg-policy-scalar/);
    expect(() => assertContextGraphPolicyV1({ ...POLICY, version: 0 }))
      .toThrow(/cg-policy-scalar/);
    expect(() => parseCanonicalContextGraphPolicyPayloadV1(
      canonicalizeContextGraphPolicyPayloadV1(POLICY).replace('"accessPolicy":0', '"accessPolicy": 0'),
    )).toThrow();
  });

  it('rejects source accessors without invoking them', () => {
    let getterCalls = 0;
    const source = { ...POLICY.source } as Record<string, unknown>;
    Object.defineProperty(source, 'kind', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'finalized-chain';
      },
    });
    expect(() => assertContextGraphPolicyV1({ ...POLICY, source }))
      .toThrow(/cg-policy-schema/);
    expect(getterCalls).toBe(0);
  });

  it('enforces the object-specific policy byte and nesting caps before schema use', () => {
    const oversized = `{"x":"${'a'.repeat(MAX_CONTEXT_GRAPH_POLICY_PAYLOAD_BYTES_V1)}"}`;
    expect(() => parseCanonicalContextGraphPolicyPayloadV1(oversized))
      .toThrow(/cg-policy-payload-too-large/);
    expect(() => parseCanonicalContextGraphPolicyPayloadV1('{"a":{"b":{}}}'))
      .toThrow(/nesting exceeds 2/);
  });

  it('enforces exact envelope type and validates signed and unsigned variants', () => {
    expect(Object.isFrozen(CONTROL_OBJECT_SIGNATURE_SUITES)).toBe(true);
    expect(() => (CONTROL_OBJECT_SIGNATURE_SUITES as unknown as string[]).push('evil-suite'))
      .toThrow();
    expect(() => assertUnsignedContextGraphPolicyEnvelopeV1(POLICY_UNSIGNED)).not.toThrow();
    expect(() => assertSignedContextGraphPolicyEnvelopeV1(POLICY_SIGNED)).not.toThrow();
    expect(() => assertUnsignedContextGraphPolicyEnvelopeV1({
      ...POLICY_UNSIGNED,
      objectType: MEMBER_ROSTER_OBJECT_TYPE_V1,
    })).toThrow(/cg-policy-type/);
    expect(() => assertUnsignedContextGraphPolicyEnvelopeV1({
      ...POLICY_UNSIGNED,
      signatureSuite: 'evil-suite',
      signatureEvidence: {
        kind: 'eip1271-current-finalized',
        chainId: '20430',
        contractAddress: ISSUER,
      },
    } as unknown as UnsignedControlEnvelopeV1)).toThrow(/Unsupported control-object signature suite/);
  });

  it('snapshots the complete envelope once and rejects stateful proxies', () => {
    let payloadReads = 0;
    const envelopeProxy = new Proxy(POLICY_UNSIGNED, {
      get(target, property, receiver) {
        if (property === 'payload') {
          payloadReads += 1;
          return payloadReads <= 2 ? POLICY : { evil: true };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => canonicalizeUnsignedContextGraphPolicyEnvelopeBytesV1(envelopeProxy))
      .toThrow(/cg-policy-schema/);
    expect(payloadReads).toBe(2);
  });
});

describe('MemberRosterV1 codec', () => {
  it('pins canonical payload/envelope bytes and digest', () => {
    expect(canonicalizeMemberRosterPayloadV1(ROSTER)).toBe(ROSTER_CANONICAL);
    expect(new TextEncoder().encode(ROSTER_CANONICAL)).toHaveLength(513);
    expect(parseCanonicalMemberRosterPayloadV1(ROSTER_CANONICAL)).toEqual(ROSTER);
    const unsignedCanonical = new TextDecoder().decode(
      canonicalizeUnsignedMemberRosterEnvelopeBytesV1(ROSTER_UNSIGNED),
    );
    expect(unsignedCanonical).toBe(ROSTER_UNSIGNED_CANONICAL);
    expect(new TextEncoder().encode(unsignedCanonical)).toHaveLength(695);
    expect(computeMemberRosterObjectDigestV1(ROSTER_UNSIGNED)).toBe(ROSTER_DIGEST);
    expect(parseCanonicalUnsignedMemberRosterEnvelopeV1(canonicalUnsigned(ROSTER_UNSIGNED)))
      .toEqual(ROSTER_UNSIGNED);
    expect(parseCanonicalSignedMemberRosterEnvelopeV1(
      new TextDecoder().decode(canonicalizeSignedMemberRosterEnvelopeBytesV1(ROSTER_SIGNED)),
    )).toEqual(ROSTER_SIGNED);
  });

  it('requires strictly sorted unique members and the closed sorted role registry', () => {
    expect(Object.isFrozen(MEMBER_ROSTER_ROLES_V1)).toBe(true);
    expect(() => (MEMBER_ROSTER_ROLES_V1 as unknown as string[]).push('administrator'))
      .toThrow();
    expect(() => assertMemberRosterV1({
      ...ROSTER,
      members: [...ROSTER.members].reverse(),
    })).toThrow(/cg-policy-order/);
    expect(() => assertMemberRosterV1({
      ...ROSTER,
      members: [ROSTER.members[0], ROSTER.members[0]],
    })).toThrow(/cg-policy-duplicate/);
    expect(() => assertMemberRosterV1({
      ...ROSTER,
      members: [{ ...ROSTER.members[0], roles: ['provider', 'holder'] }],
    })).toThrow(/cg-policy-order/);
    expect(() => assertMemberRosterV1({
      ...ROSTER,
      members: [{ ...ROSTER.members[0], roles: ['holder', 'holder'] }],
    })).toThrow(/cg-policy-duplicate/);
    expect(() => assertMemberRosterV1({
      ...ROSTER,
      members: [{ ...ROSTER.members[0], roles: ['administrator'] }],
    })).toThrow(/cg-policy-role/);
  });

  it('never consumes a poisoned inherited roles iterator', () => {
    const roles = ['administrator'];
    const originalIterator = Array.prototype[Symbol.iterator];
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true,
      writable: true,
      value(this: unknown[]) {
        if (this === roles) return [][Symbol.iterator]();
        return originalIterator.call(this);
      },
    });
    try {
      expect(() => assertMemberRosterV1({
        ...ROSTER,
        members: [{ ...ROSTER.members[0], roles }],
      })).toThrow(/cg-policy-role/);
    } finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        writable: true,
        value: originalIterator,
      });
    }
  });

  it('rejects stateful proxies and non-string roles without coercing them', () => {
    let proxyReads = 0;
    const roles = new Proxy(['holder'], {
      get(target, property, receiver) {
        if (property === '0') {
          proxyReads += 1;
          return proxyReads === 1 ? 'holder' : 'administrator';
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => assertMemberRosterV1({
      ...ROSTER,
      members: [{ ...ROSTER.members[0], roles }],
    })).toThrow(/cg-policy-schema/);

    let coercions = 0;
    const hostileRole = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        return 'provider';
      },
    };
    expect(() => assertMemberRosterV1({
      ...ROSTER,
      members: [{ ...ROSTER.members[0], roles: [hostileRole] }],
    })).toThrow(/cg-policy-role/);
    expect(coercions).toBe(0);
  });

  it('rejects subgraph scope and hostile array shapes', () => {
    expect(() => assertMemberRosterV1({ ...ROSTER, subGraphName: 'forbidden' }))
      .toThrow(/cg-policy-schema/);
    expect(() => assertMemberRosterV1({ ...ROSTER, members: new Array(1) }))
      .toThrow(/cg-policy-array/);
    const custom = [...ROSTER.members];
    Object.defineProperty(custom, 'extra', { value: true, enumerable: true });
    expect(() => assertMemberRosterV1({ ...ROSTER, members: custom }))
      .toThrow(/cg-policy-array/);
    const symbol = [...ROSTER.members];
    Object.defineProperty(symbol, Symbol('x'), { value: true, enumerable: true });
    expect(() => assertMemberRosterV1({ ...ROSTER, members: symbol }))
      .toThrow(/cg-policy-array/);

    let getterCalls = 0;
    const roles = [...ROSTER.members[0].roles];
    Object.defineProperty(roles, '0', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'holder';
      },
    });
    expect(() => assertMemberRosterV1({
      ...ROSTER,
      members: [{ ...ROSTER.members[0], roles }],
    })).toThrow(/cg-policy-array/);
    expect(getterCalls).toBe(0);
  });

  it('accepts an empty roster but enforces the 16,384-entry hard cap', () => {
    expect(() => assertMemberRosterV1({ ...ROSTER, members: [] })).not.toThrow();
    const atCap = Array.from({ length: MAX_MEMBER_ROSTER_ENTRIES_V1 }, (_, index) => ({
      agentAddress: `0x${(index + 1).toString(16).padStart(40, '0')}`,
      roles: ['holder', 'ingress-host', 'provider'] as const,
    }));
    const atCapCanonical = canonicalizeMemberRosterPayloadV1({ ...ROSTER, members: atCap });
    expect(new TextEncoder().encode(atCapCanonical).byteLength)
      .toBeLessThanOrEqual(MAX_MEMBER_ROSTER_PAYLOAD_BYTES_V1);
    const tooMany = [
      ...atCap,
      {
        agentAddress: `0x${(MAX_MEMBER_ROSTER_ENTRIES_V1 + 1).toString(16).padStart(40, '0')}`,
        roles: [],
      },
    ];
    expect(() => assertMemberRosterV1({ ...ROSTER, members: tooMany }))
      .toThrow(/cg-policy-array/);
  });

  it('enforces the object-specific roster byte and nesting caps before schema use', () => {
    const oversized = `{"x":"${'a'.repeat(MAX_MEMBER_ROSTER_PAYLOAD_BYTES_V1)}"}`;
    expect(() => parseCanonicalMemberRosterPayloadV1(oversized))
      .toThrow(/cg-policy-payload-too-large/);
    expect(() => parseCanonicalMemberRosterPayloadV1('{"a":[{"b":[{}]}]}'))
      .toThrow(/nesting exceeds 4/);
  });

  it('enforces exact envelope type and signed digest', () => {
    expect(() => assertUnsignedMemberRosterEnvelopeV1(ROSTER_UNSIGNED)).not.toThrow();
    expect(() => assertSignedMemberRosterEnvelopeV1(ROSTER_SIGNED)).not.toThrow();
    expect(() => assertSignedMemberRosterEnvelopeV1({
      ...ROSTER_SIGNED,
      objectDigest: `0x${'00'.repeat(32)}`,
    })).toThrow(/digest mismatch/i);
  });
});

function validatedPolicy(value: unknown): ContextGraphPolicyV1 {
  assertContextGraphPolicyV1(value);
  return value;
}

function validatedRoster(value: unknown): MemberRosterV1 {
  assertMemberRosterV1(value);
  return value;
}

function unsigned(objectType: string, payload: ContextGraphPolicyV1 | MemberRosterV1) {
  return {
    issuer: ISSUER,
    objectType,
    payload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as UnsignedControlEnvelopeV1;
}

function signed(envelope: UnsignedControlEnvelopeV1, objectDigest: string) {
  return { ...envelope, objectDigest, signature: SIGNATURE } as SignedControlEnvelopeV1;
}

function canonicalUnsigned(envelope: UnsignedControlEnvelopeV1): string {
  return new TextDecoder().decode(
    envelope.objectType === CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1
      ? canonicalizeUnsignedContextGraphPolicyEnvelopeBytesV1(envelope)
      : canonicalizeUnsignedMemberRosterEnvelopeBytesV1(envelope),
  );
}
