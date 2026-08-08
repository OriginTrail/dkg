import {
  MAX_DECIMAL_U64,
  SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
  assertCanonicalDigest,
  assertCanonicalDeterministicUalV1,
  assertSignedSwmAuthorInventoryHeadEnvelopeV1,
  assertSwmAuthorInventoryScopeV1,
  canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1,
  canonicalizeSwmAuthorInventoryRowsBytesV1,
  computeSwmAuthorInventoryHeadObjectDigestV1,
  computeSwmAuthorInventoryRowsDigestV1,
  computeSwmAuthorInventoryScopeDigestV1,
  deriveSwmAuthorInventoryScopeFromHeadV1,
  parseCanonicalSignedSwmAuthorInventoryHeadEnvelopeV1,
  parseCanonicalSwmAuthorInventoryRowsV1,
  parseCanonicalDecimalU64,
  parseDeterministicKnowledgeAssetUal,
  type DecimalU64V1,
  type Digest32V1,
  type SignedSwmAuthorInventoryHeadEnvelopeV1,
  type SwmAuthorInventoryRowV1,
  type SwmAuthorInventoryScopeV1,
  type SwmAuthorInventorySnapshotV1,
  type TimestampMsV1,
  type UnsignedSwmAuthorInventoryHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  verifyControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';

import {
  Rfc64ControlEnvelopeSigningErrorV1,
  signAndVerifyRfc64ControlEnvelopeV1,
  type Rfc64ControlEnvelopeEip191SignerV1,
} from './control-envelope-signer-v1.js';
import {
  InventoryV1CandidateError,
  type Rfc64SwmAuthorInventoryOperationsV1,
  type SwmAuthorInventoryCasResultV1,
} from './inventory-v1/index.js';
import { applySwmAuthorInventoryMutationV1 } from './inventory-v1/swm-author-inventory-mutation.js';

export const RFC64_SWM_AUTHOR_INVENTORY_PRODUCER_MAX_CAS_ATTEMPTS_V1 = 4;

export type Rfc64SwmAuthorInventoryProducerErrorCodeV1 =
  | 'swm-inventory-producer-input'
  | 'swm-inventory-producer-history'
  | 'swm-inventory-producer-signer'
  | 'swm-inventory-producer-conflict';

export class Rfc64SwmAuthorInventoryProducerErrorV1 extends Error {
  constructor(
    readonly code: Rfc64SwmAuthorInventoryProducerErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64SwmAuthorInventoryProducerErrorV1';
  }
}

export interface MaintainRfc64SwmAuthorInventoryInputV1 {
  readonly scope: SwmAuthorInventoryScopeV1;
  readonly row: SwmAuthorInventoryRowV1;
  readonly issuedAt: TimestampMsV1;
  readonly signer: Rfc64ControlEnvelopeEip191SignerV1;
  readonly maxCasAttempts?: number;
}

export interface MaintainRfc64SwmAuthorInventoryResultV1 {
  readonly status: 'applied' | 'existing';
  readonly attempts: number;
  readonly snapshot: SwmAuthorInventorySnapshotV1;
}

export interface RemoveRfc64SwmAuthorInventoryInputV1 {
  readonly scope: SwmAuthorInventoryScopeV1;
  /** Exact SWM row identity that reached VM; a newer row for the UAL is preserved. */
  readonly expectedRow: Readonly<Pick<
    SwmAuthorInventoryRowV1,
    'kaUal' | 'assertionVersion' | 'sealDigest'
  >>;
  readonly issuedAt: TimestampMsV1;
  readonly signer: Rfc64ControlEnvelopeEip191SignerV1;
  readonly maxCasAttempts?: number;
}

export interface RemoveRfc64SwmAuthorInventoryResultV1 {
  readonly status: 'applied' | 'absent';
  readonly attempts: number;
  readonly snapshot: SwmAuthorInventorySnapshotV1 | null;
}

/**
 * Sign and atomically maintain one author's exact SWM-only live set.
 *
 * The producer trusts neither persisted history nor a signer callback. Every
 * predecessor signature is recovered before it is extended, and every newly
 * signed head is recovered before the inventory CAS can see it. Concurrent
 * writers re-read and rebuild a successor from the winning head; an exact
 * replay returns without advancing the version.
 */
export async function maintainRfc64SwmAuthorInventoryV1(
  inventory: Rfc64SwmAuthorInventoryOperationsV1,
  input: MaintainRfc64SwmAuthorInventoryInputV1,
): Promise<MaintainRfc64SwmAuthorInventoryResultV1> {
  const prepared = prepareInput(input);
  return mutateRfc64SwmAuthorInventoryV1<MaintainRfc64SwmAuthorInventoryResultV1>(
    inventory,
    prepared,
    {
      operation: 'upsert',
      plan: (current, attempt) => {
        const mutation = Object.freeze({ kind: 'upsert' as const, row: prepared.row });
        const transition = applySwmAuthorInventoryMutationV1(current?.rows ?? [], mutation);
        if (transition.status === 'existing') {
          if (current === null) {
            throw new Rfc64SwmAuthorInventoryProducerErrorV1(
              'swm-inventory-producer-history',
              'an existing SWM inventory row requires a current signed snapshot',
            );
          }
          return Object.freeze({
            kind: 'return' as const,
            result: Object.freeze({
              status: 'existing' as const,
              attempts: attempt,
              snapshot: current,
            }),
          });
        }
        return Object.freeze({
          kind: 'commit' as const,
          rows: transition.rows,
          mutation,
        });
      },
      mapCommitted: (committed, attempt) => Object.freeze({
        status: committed.status,
        attempts: attempt,
        snapshot: committed.snapshot,
      }),
    },
  );
}

/** Remove one KA after it leaves the active SWM-only set (normally VM confirmation). */
export async function removeRfc64SwmAuthorInventoryRowV1(
  inventory: Rfc64SwmAuthorInventoryOperationsV1,
  input: RemoveRfc64SwmAuthorInventoryInputV1,
): Promise<RemoveRfc64SwmAuthorInventoryResultV1> {
  const prepared = prepareRemovalInput(input);
  return mutateRfc64SwmAuthorInventoryV1<RemoveRfc64SwmAuthorInventoryResultV1>(
    inventory,
    prepared,
    {
      operation: 'removal',
      plan: (current, attempt) => {
        const currentRow = current?.rows.find(
          ({ kaUal }) => kaUal === prepared.expectedRow.kaUal,
        );
        if (
          currentRow === undefined
          || currentRow.assertionVersion !== prepared.expectedRow.assertionVersion
          || currentRow.sealDigest !== prepared.expectedRow.sealDigest
        ) {
          return Object.freeze({
            kind: 'return' as const,
            result: Object.freeze({
              status: 'absent' as const,
              attempts: attempt,
              snapshot: current,
            }),
          });
        }
        const mutation = Object.freeze({
          kind: 'remove' as const,
          kaUal: prepared.expectedRow.kaUal,
        });
        if (current === null) {
          throw new Rfc64SwmAuthorInventoryProducerErrorV1(
            'swm-inventory-producer-history',
            'an exact SWM inventory removal requires a current signed snapshot',
          );
        }
        const transition = applySwmAuthorInventoryMutationV1(current.rows, mutation);
        if (transition.status !== 'applied') {
          throw new Rfc64SwmAuthorInventoryProducerErrorV1(
            'swm-inventory-producer-history',
            'exact removal target disappeared while planning its mutation',
          );
        }
        return Object.freeze({
          kind: 'commit' as const,
          rows: transition.rows,
          mutation,
        });
      },
      // A durable exact-CAS replay means this removal already committed; expose
      // that as `applied`, never the persistence layer's generic `existing`.
      mapCommitted: (committed, attempt) => Object.freeze({
        status: 'applied' as const,
        attempts: attempt,
        snapshot: committed.snapshot,
      }),
    },
  );
}

type PreparedMutationInputV1 = Readonly<{
  scope: Readonly<SwmAuthorInventoryScopeV1>;
  issuedAt: TimestampMsV1;
  signer: Rfc64ControlEnvelopeEip191SignerV1;
  maxCasAttempts: number;
}>;

type PlannedMutationV1<TResult> =
  | Readonly<{ kind: 'return'; result: TResult }>
  | Readonly<{
      kind: 'commit';
      rows: readonly SwmAuthorInventoryRowV1[];
      mutation:
        | Readonly<{ kind: 'upsert'; row: SwmAuthorInventoryRowV1 }>
        | Readonly<{ kind: 'remove'; kaUal: SwmAuthorInventoryRowV1['kaUal'] }>;
    }>;

interface SwmAuthorInventoryMutationPolicyV1<TResult> {
  readonly operation: 'upsert' | 'removal';
  readonly plan: (
    current: SwmAuthorInventorySnapshotV1 | null,
    attempt: number,
  ) => PlannedMutationV1<TResult>;
  readonly mapCommitted: (
    committed: SwmAuthorInventoryCasResultV1,
    attempt: number,
  ) => TResult;
}

async function mutateRfc64SwmAuthorInventoryV1<TResult>(
  inventory: Rfc64SwmAuthorInventoryOperationsV1,
  prepared: PreparedMutationInputV1,
  policy: SwmAuthorInventoryMutationPolicyV1<TResult>,
): Promise<TResult> {
  const inventoryScopeDigest = computeSwmAuthorInventoryScopeDigestV1(prepared.scope);
  for (let attempt = 1; attempt <= prepared.maxCasAttempts; attempt += 1) {
    const current = inventory.readSwmAuthorInventorySnapshotV1(
      inventoryScopeDigest,
      prepared.scope.authorAddress,
    );
    if (current !== null) await verifyCurrentHistory(current, prepared.scope);
    const next = policy.plan(current, attempt);
    if (next.kind === 'return') return next.result;
    const issuedAt = clampSuccessorIssuedAtV1(
      prepared.issuedAt,
      current,
      next.rows,
    );
    const signedHead = await signHead({
      scope: prepared.scope,
      rows: next.rows,
      issuedAt,
      previous: current?.head ?? null,
      signer: prepared.signer,
    });
    try {
      const committed = inventory.compareAndSwapSwmAuthorInventoryV1({
        snapshot: Object.freeze({ head: signedHead.head, rows: next.rows }),
        mutation: next.mutation,
        issuerSignature: signedHead.issuerSignature,
        expectedCurrentHeadDigest:
          (current?.head.objectDigest as Digest32V1 | undefined) ?? null,
      });
      return policy.mapCommitted(committed, attempt);
    } catch (cause) {
      if (
        cause instanceof InventoryV1CandidateError
        && cause.code === 'swm-inventory-cas-conflict'
        && attempt < prepared.maxCasAttempts
      ) continue;
      if (cause instanceof InventoryV1CandidateError
        && cause.code === 'swm-inventory-cas-conflict') {
        throw new Rfc64SwmAuthorInventoryProducerErrorV1(
          'swm-inventory-producer-conflict',
          `SWM inventory ${policy.operation} did not converge after ${attempt} CAS attempts`,
          { cause },
        );
      }
      throw cause;
    }
  }
  throw new Rfc64SwmAuthorInventoryProducerErrorV1(
    'swm-inventory-producer-conflict',
    `SWM inventory ${policy.operation} CAS attempt bound was exhausted`,
  );
}

function clampSuccessorIssuedAtV1(
  requested: TimestampMsV1,
  current: SwmAuthorInventorySnapshotV1 | null,
  rows: readonly SwmAuthorInventoryRowV1[],
): TimestampMsV1 {
  let issuedAt = BigInt(requested);
  if (current !== null) {
    const currentIssuedAt = BigInt(current.head.payload.issuedAt);
    if (currentIssuedAt > issuedAt) issuedAt = currentIssuedAt;
  }
  for (const row of rows) {
    const sharedAt = BigInt(row.sharedAt);
    if (sharedAt > issuedAt) issuedAt = sharedAt;
  }
  return issuedAt.toString() as TimestampMsV1;
}

function prepareInput(input: MaintainRfc64SwmAuthorInventoryInputV1): Readonly<{
  scope: Readonly<SwmAuthorInventoryScopeV1>;
  row: Readonly<SwmAuthorInventoryRowV1>;
  issuedAt: TimestampMsV1;
  signer: Rfc64ControlEnvelopeEip191SignerV1;
  maxCasAttempts: number;
}> {
  try {
    assertSwmAuthorInventoryScopeV1(input.scope);
    const scope = Object.freeze({ ...input.scope });
    const row = parseCanonicalSwmAuthorInventoryRowsV1(
      canonicalizeSwmAuthorInventoryRowsBytesV1([input.row]),
    )[0]!;
    const signer = Object.freeze({
      issuer: input.signer.issuer,
      signDigest: input.signer.signDigest,
    });
    if (typeof signer.signDigest !== 'function' || signer.issuer !== scope.authorAddress) {
      throw new Error('inventory signer must be the scoped author');
    }
    parseCanonicalDecimalU64(input.issuedAt, 'issuedAt');
    if (BigInt(input.issuedAt) < BigInt(row.sharedAt)) {
      throw new Error('inventory issuedAt must not precede the shared row');
    }
    const maxCasAttempts = input.maxCasAttempts
      ?? RFC64_SWM_AUTHOR_INVENTORY_PRODUCER_MAX_CAS_ATTEMPTS_V1;
    if (!Number.isSafeInteger(maxCasAttempts) || maxCasAttempts < 1 || maxCasAttempts > 16) {
      throw new Error('maxCasAttempts must be an integer in 1..16');
    }
    return Object.freeze({ scope, row, issuedAt: input.issuedAt, signer, maxCasAttempts });
  } catch (cause) {
    throw new Rfc64SwmAuthorInventoryProducerErrorV1(
      'swm-inventory-producer-input',
      'SWM inventory producer input is not canonical or internally bound',
      { cause },
    );
  }
}

function prepareRemovalInput(input: RemoveRfc64SwmAuthorInventoryInputV1): Readonly<{
  scope: Readonly<SwmAuthorInventoryScopeV1>;
  expectedRow: Readonly<Pick<
    SwmAuthorInventoryRowV1,
    'kaUal' | 'assertionVersion' | 'sealDigest'
  >>;
  issuedAt: TimestampMsV1;
  signer: Rfc64ControlEnvelopeEip191SignerV1;
  maxCasAttempts: number;
}> {
  try {
    assertSwmAuthorInventoryScopeV1(input.scope);
    const scope = Object.freeze({ ...input.scope });
    const signer = Object.freeze({
      issuer: input.signer.issuer,
      signDigest: input.signer.signDigest,
    });
    if (typeof signer.signDigest !== 'function' || signer.issuer !== scope.authorAddress) {
      throw new Error('inventory signer must be the scoped author');
    }
    const canonicalUal = assertCanonicalDeterministicUalV1(input.expectedRow.kaUal);
    if (
      canonicalUal.agentAddress !== scope.authorAddress
      || parseDeterministicKnowledgeAssetUal(canonicalUal.ual).chainId !== scope.networkId
    ) throw new Error('removal UAL does not belong to the scoped network and author');
    parseCanonicalDecimalU64(input.expectedRow.assertionVersion, 'expectedRow.assertionVersion');
    if (BigInt(input.expectedRow.assertionVersion) < 1n) {
      throw new Error('removal assertion version must be positive');
    }
    assertCanonicalDigest(input.expectedRow.sealDigest, 'expectedRow.sealDigest');
    parseCanonicalDecimalU64(input.issuedAt, 'issuedAt');
    const maxCasAttempts = input.maxCasAttempts
      ?? RFC64_SWM_AUTHOR_INVENTORY_PRODUCER_MAX_CAS_ATTEMPTS_V1;
    if (!Number.isSafeInteger(maxCasAttempts) || maxCasAttempts < 1 || maxCasAttempts > 16) {
      throw new Error('maxCasAttempts must be an integer in 1..16');
    }
    return Object.freeze({
      scope,
      expectedRow: Object.freeze({
        kaUal: canonicalUal.ual,
        assertionVersion: input.expectedRow.assertionVersion,
        sealDigest: input.expectedRow.sealDigest,
      }),
      issuedAt: input.issuedAt,
      signer,
      maxCasAttempts,
    });
  } catch (cause) {
    throw new Rfc64SwmAuthorInventoryProducerErrorV1(
      'swm-inventory-producer-input',
      'SWM inventory removal input is not canonical or internally bound',
      { cause },
    );
  }
}

async function verifyCurrentHistory(
  current: SwmAuthorInventorySnapshotV1,
  expectedScope: SwmAuthorInventoryScopeV1,
): Promise<void> {
  try {
    const currentScope = deriveSwmAuthorInventoryScopeFromHeadV1(current.head.payload);
    if (
      computeSwmAuthorInventoryScopeDigestV1(currentScope)
      !== computeSwmAuthorInventoryScopeDigestV1(expectedScope)
      || current.head.issuer !== expectedScope.authorAddress
    ) throw new Error('persisted inventory head belongs to a different scope or author');
    await verifyControlEnvelopeIssuerSignatureV1(current.head);
  } catch (cause) {
    throw new Rfc64SwmAuthorInventoryProducerErrorV1(
      'swm-inventory-producer-history',
      'persisted SWM inventory head is not valid signed predecessor history',
      { cause },
    );
  }
}

async function signHead(input: Readonly<{
  scope: SwmAuthorInventoryScopeV1;
  rows: readonly SwmAuthorInventoryRowV1[];
  issuedAt: TimestampMsV1;
  previous: SignedSwmAuthorInventoryHeadEnvelopeV1 | null;
  signer: Rfc64ControlEnvelopeEip191SignerV1;
}>): Promise<Readonly<{
  head: SignedSwmAuthorInventoryHeadEnvelopeV1;
  issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
}>> {
  const previousVersion = input.previous === null
    ? -1n
    : BigInt(input.previous.payload.version);
  if (previousVersion >= BigInt(MAX_DECIMAL_U64)) {
    throw new Rfc64SwmAuthorInventoryProducerErrorV1(
      'swm-inventory-producer-history',
      'SWM inventory version space is exhausted',
    );
  }
  const payload = Object.freeze({
    ...input.scope,
    version: (previousVersion + 1n).toString() as DecimalU64V1,
    previousHeadDigest:
      (input.previous?.objectDigest as Digest32V1 | undefined) ?? null,
    totalRows: input.rows.length.toString() as DecimalU64V1,
    rowsDigest: computeSwmAuthorInventoryRowsDigestV1(input.rows),
    issuedAt: input.issuedAt,
  });
  const unsigned = Object.freeze({
    issuer: input.signer.issuer,
    objectType: SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: Object.freeze({ kind: 'none' as const }),
    signatureSuite: 'eip191-personal-sign-digest-v1' as const,
  }) as UnsignedSwmAuthorInventoryHeadEnvelopeV1;
  const objectDigest = computeSwmAuthorInventoryHeadObjectDigestV1(unsigned);
  try {
    const candidate = await signAndVerifyRfc64ControlEnvelopeV1(
      unsigned,
      objectDigest,
      input.signer,
    );
    assertSignedSwmAuthorInventoryHeadEnvelopeV1(candidate.envelope);
    return Object.freeze({
      head: parseCanonicalSignedSwmAuthorInventoryHeadEnvelopeV1(
        canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(candidate.envelope),
      ),
      issuerSignature: candidate.issuerSignature,
    });
  } catch (cause) {
    throw new Rfc64SwmAuthorInventoryProducerErrorV1(
      'swm-inventory-producer-signer',
      cause instanceof Rfc64ControlEnvelopeSigningErrorV1
        && cause.phase === 'callback'
        ? 'SWM inventory signer callback failed'
        : 'SWM inventory signer did not produce a canonical author signature',
      { cause },
    );
  }
}
