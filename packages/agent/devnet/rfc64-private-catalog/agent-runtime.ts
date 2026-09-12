// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent } from '@origintrail-official/dkg-agent';

export const RFC64_PRIVATE_RUNTIME_ROLES_V1 = Object.freeze([
  'owner',
  'provider2',
  'receiver',
  'outsider',
] as const);

export type Rfc64PrivateRuntimeRoleV1 =
  typeof RFC64_PRIVATE_RUNTIME_ROLES_V1[number];

export type Rfc64PrivateRuntimeManifestV1 = Readonly<{
  authorityStatePath: string;
  peerIds: Readonly<Record<Rfc64PrivateRuntimeRoleV1, string>>;
}>;

export type Rfc64PrivateFaultProfileV1 = Readonly<{
  authority: Readonly<{
    fixture: <T>(canonical: T, receiverAddress: string) => T;
    adapterOptions: (input: Readonly<{
      authorityStatePath: string;
      ownerAddress: string;
    }>) => Readonly<Record<string, unknown>>;
  }>;
  proof: Readonly<Record<string, unknown>>;
}>;

export type Rfc64PrivateFinalizedRpcV1 = Readonly<{
  url: string;
  calls: (method: string) => number;
  snapshot: () => Readonly<Record<string, number>>;
  close: () => Promise<void>;
}>;

export type Rfc64PrivateInitialFinalizedAuthorityV1 = Readonly<{
  source: string;
  policyDigest: string;
  roster: Readonly<{
    version: string;
    members: readonly Readonly<{ agentAddress: string }>[];
  }>;
}>;

export type OwnerPublicationBaselineV1 = Readonly<{
  kind: 'baseline';
  scope: unknown;
  assets: readonly unknown[];
}>;

export type OwnerPublicationStateV1 = Readonly<{
  beginBaseline: () => void;
  commitBaseline: (scope: unknown, assets: readonly unknown[]) => void;
  requireBaseline: () => OwnerPublicationBaselineV1;
}>;

export type ProbeRuntimeV1 = Readonly<{
  kind: 'probe';
  role: Rfc64PrivateRuntimeRoleV1;
  agent: DKGAgent;
  faultProfile: Rfc64PrivateFaultProfileV1;
}>;

type FinalizedRuntimeCommonV1 = Readonly<{
  kind: 'run';
  agent: DKGAgent;
  chainAdapter: object;
  faultProfile: Rfc64PrivateFaultProfileV1;
  rpc: Rfc64PrivateFinalizedRpcV1;
  initialFinalizedAuthority: Rfc64PrivateInitialFinalizedAuthorityV1;
  peerIds: Readonly<Record<Rfc64PrivateRuntimeRoleV1, string>>;
}>;

export type FinalizedRuntimeV1 = FinalizedRuntimeCommonV1 & Readonly<
  | { role: 'owner'; publication: OwnerPublicationStateV1 }
  | {
    role: Exclude<Rfc64PrivateRuntimeRoleV1, 'owner'>;
    publication: null;
  }
>;

export type Rfc64PrivateRuntimeV1 = ProbeRuntimeV1 | FinalizedRuntimeV1;

/** Validate the process role once, where untyped environment input enters. */
export function parseRfc64PrivateRuntimeRoleV1(
  value: unknown,
): Rfc64PrivateRuntimeRoleV1 {
  if (
    typeof value !== 'string'
    || !RFC64_PRIVATE_RUNTIME_ROLES_V1.some((role) => role === value)
  ) {
    throw new TypeError('RFC-64 private runtime role is invalid');
  }
  return value as Rfc64PrivateRuntimeRoleV1;
}

/** Validate the untrusted JSON manifest before resource creation. */
export function parseRfc64PrivateRuntimeManifestV1(
  value: unknown,
): Rfc64PrivateRuntimeManifestV1 {
  const manifest = plainRecordV1(value, 'RFC-64 private runtime manifest');
  if (
    Object.keys(manifest).length !== 2
    || !Object.hasOwn(manifest, 'authorityStatePath')
    || !Object.hasOwn(manifest, 'peerIds')
  ) {
    throw new TypeError('RFC-64 private runtime manifest has unexpected fields');
  }
  const authorityStatePath = boundedStringV1(
    manifest.authorityStatePath,
    'RFC-64 private authority state path',
  );
  const rawPeerIds = plainRecordV1(
    manifest.peerIds,
    'RFC-64 private runtime peer identities',
  );
  const peerIds = Object.fromEntries(RFC64_PRIVATE_RUNTIME_ROLES_V1.map((role) => [
    role,
    boundedStringV1(rawPeerIds[role], `RFC-64 private ${role} peer identity`),
  ])) as Record<Rfc64PrivateRuntimeRoleV1, string>;
  if (
    Object.keys(rawPeerIds).length !== RFC64_PRIVATE_RUNTIME_ROLES_V1.length
    || new Set(Object.values(peerIds)).size !== RFC64_PRIVATE_RUNTIME_ROLES_V1.length
  ) {
    throw new TypeError('RFC-64 private runtime peer identities must exactly cover unique roles');
  }
  return Object.freeze({
    authorityStatePath,
    peerIds: Object.freeze(peerIds),
  });
}

/** Narrow the internal discriminated union at command dispatch boundaries. */
export function assertFinalizedRuntimeV1(
  context: Rfc64PrivateRuntimeV1,
): asserts context is FinalizedRuntimeV1 {
  if (context.kind !== 'run') throw new Error('command requires a finalized runtime');
}

/** Explicit owner-only baseline publication state machine. */
export function createOwnerPublicationStateV1(): OwnerPublicationStateV1 {
  let state: Readonly<
    | { kind: 'empty' }
    | { kind: 'publishing-baseline' }
    | OwnerPublicationBaselineV1
  > = Object.freeze({ kind: 'empty' });
  return Object.freeze({
    beginBaseline() {
      if (state.kind !== 'empty') throw new Error('catalog baseline already published');
      state = Object.freeze({ kind: 'publishing-baseline' });
    },
    commitBaseline(scope: unknown, assets: readonly unknown[]) {
      if (state.kind !== 'publishing-baseline') {
        throw new Error('catalog baseline publication was not started');
      }
      state = Object.freeze({ kind: 'baseline', scope, assets: Object.freeze([...assets]) });
    },
    requireBaseline() {
      if (state.kind !== 'baseline') {
        throw new Error('catalog update requires a published finalized-VM baseline');
      }
      return state;
    },
  });
}

function plainRecordV1(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedStringV1(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError(`${label} must be a bounded string`);
  }
  return value;
}
