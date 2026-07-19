import { decodeProtocolTuple } from '../protocol/codec.js';
import { collectionIdV1, namespaceIdV1, protocolTupleId } from '../protocol/hashes.js';
import type { ProtocolTuple, ThresholdSignedProtocolTupleName } from '../protocol/schema.js';
import { verifySingleSignedProtocolTuple, verifyThresholdSignedProtocolTuple } from '../protocol/signatures.js';
import { MutableSetCommitment } from '../reconciliation/set-commitment.js';
import type { WalObjectId } from '../reconciliation/ids.js';
import { authorityError } from './errors.js';
import { WalAuthorityPersistence, type StoredAuthorityObject, type VectorHeadRecord } from './persistence.js';
import type {
  AcceptAuthorCheckpointInput,
  PrivateDisclosureRequest,
  RollbackCohortMinimum,
  WalAuthorityCompleteness,
  WalAuthorityLifecycleOptions,
  WalAuthorityReason,
  WalAuthorityView,
} from './types.js';

const CURATOR_SCOPE = 0n;
const NETWORK_SCOPE = 1n;
const OPEN_MODE = 0n;
const CURATED_MODE = 1n;
const PUBLIC_VISIBILITY = 0n;
const PRIVATE_VISIBILITY = 1n;
const DEFAULT_CLOCK_SKEW_MS = 5_000;
const DEFAULT_MAXIMUM_AUTHORS = 65_536;

function copy(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function fixed(value: Uint8Array, length: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    authorityError('WAL_AUTHORITY_INVALID', `${name} must be exactly ${length} bytes`);
  }
  return copy(value);
}

function text(value: string, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.normalize('NFC') !== value) {
    authorityError('WAL_AUTHORITY_INVALID', `${name} must be non-empty NFC text`);
  }
  return value;
}

function safeTime(value: bigint, name: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    authorityError('WAL_AUTHORITY_INVALID', `${name} is outside the safe millisecond range`);
  }
  return Number(value);
}

function safeInteger(value: number, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    authorityError('WAL_AUTHORITY_INVALID', `${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function includesBytes(values: readonly Uint8Array[], value: Uint8Array): boolean {
  return values.some(candidate => bytesEqual(candidate, value));
}

function decode<Name extends ThresholdSignedProtocolTupleName>(
  name: Name,
  canonicalBytes: Uint8Array,
): ProtocolTuple<Name> {
  if (!(canonicalBytes instanceof Uint8Array) || canonicalBytes.length === 0) {
    authorityError('WAL_AUTHORITY_INVALID', `${name} canonical bytes cannot be empty`);
  }
  try {
    return decodeProtocolTuple(name, canonicalBytes);
  } catch (error) {
    return authorityError('WAL_AUTHORITY_INVALID', `invalid canonical ${name}`, error);
  }
}

function decodeCheckpoint(canonicalBytes: Uint8Array): ProtocolTuple<'AuthorCheckpointV1'> {
  if (!(canonicalBytes instanceof Uint8Array) || canonicalBytes.length === 0) {
    authorityError('WAL_AUTHORITY_INVALID', 'AuthorCheckpointV1 canonical bytes cannot be empty');
  }
  try {
    const tuple = decodeProtocolTuple('AuthorCheckpointV1', canonicalBytes);
    verifySingleSignedProtocolTuple('AuthorCheckpointV1', tuple);
    return tuple;
  } catch (error) {
    return authorityError('WAL_AUTHORITY_INVALID', 'invalid signed AuthorCheckpointV1', error);
  }
}

function thresholdPolicy(tuple: ProtocolTuple<'AuthoritySetV1'>) {
  return { signerAddresses: tuple[5], threshold: tuple[4] };
}

function verifyThreshold<Name extends ThresholdSignedProtocolTupleName>(
  name: Name,
  tuple: ProtocolTuple<Name>,
  authority: ProtocolTuple<'AuthoritySetV1'>,
): void {
  try {
    verifyThresholdSignedProtocolTuple(name, tuple, thresholdPolicy(authority));
  } catch (error) {
    authorityError('WAL_AUTHORITY_UNAUTHORIZED', `${name} does not satisfy its referenced authority`, error);
  }
}

function storedTuple<Name extends 'AuthoritySetV1' | 'MembershipCheckpointV1' | 'CollectionHeadVectorV1'>(
  name: Name,
  stored: StoredAuthorityObject<Name>,
): ProtocolTuple<Name> {
  const tuple = decode(name, stored.canonicalBytes);
  const computed = protocolTupleId(name, tuple);
  if (!bytesEqual(computed, stored.id)) authorityError('WAL_AUTHORITY_BLOCKED', `${name} durable ID binding is corrupt`);
  return tuple;
}

function comparePosition(
  leftEpoch: bigint,
  leftNumber: bigint,
  rightEpoch: bigint,
  rightNumber: bigint,
): number {
  if (leftEpoch !== rightEpoch) return leftEpoch < rightEpoch ? -1 : 1;
  if (leftNumber === rightNumber) return 0;
  return leftNumber < rightNumber ? -1 : 1;
}

function flattenVector(tuple: ProtocolTuple<'CollectionHeadVectorV1'>): VectorHeadRecord[] {
  const output: VectorHeadRecord[] = [];
  for (const namespace of tuple[3]) {
    for (const writer of namespace[1]) {
      output.push({
        namespaceId: copy(namespace[0]),
        writerId: copy(writer[0]),
        checkpointId: copy(writer[1]),
      });
    }
  }
  return output;
}

function setMatches(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left.map(hex));
  return right.every(value => expected.has(hex(value)));
}

export class WalAuthorityLifecycle {
  readonly networkId: string;
  readonly clockSkewMs: number;
  readonly maximumAuthorsPerVector: number;
  readonly persistence: WalAuthorityPersistence;
  private readonly genesisCuratorAuthoritySetId: Uint8Array;
  private readonly genesisNetworkAuthoritySetId: Uint8Array;
  private readonly rollbackStore: WalAuthorityLifecycleOptions['rollbackStore'];
  private readonly adapter: WalAuthorityLifecycleOptions['adapter'];
  private readonly now: () => number;
  private closed = false;

  constructor(options: WalAuthorityLifecycleOptions) {
    if (!options) authorityError('WAL_AUTHORITY_INVALID', 'WAL authority options are required');
    this.networkId = text(options.networkId, 'networkId');
    this.genesisCuratorAuthoritySetId = fixed(options.genesisCuratorAuthoritySetId, 32, 'genesisCuratorAuthoritySetId');
    this.genesisNetworkAuthoritySetId = fixed(options.genesisNetworkAuthoritySetId, 32, 'genesisNetworkAuthoritySetId');
    if (!options.rollbackStore || !options.adapter) {
      authorityError('WAL_AUTHORITY_INVALID', 'rollback store and DKG authority adapter are required');
    }
    this.rollbackStore = options.rollbackStore;
    this.adapter = options.adapter;
    this.clockSkewMs = safeInteger(options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS, 'clockSkewMs');
    this.maximumAuthorsPerVector = safeInteger(
      options.maximumAuthorsPerVector ?? DEFAULT_MAXIMUM_AUTHORS,
      'maximumAuthorsPerVector',
      1,
    );
    this.now = options.now ?? Date.now;
    this.persistence = new WalAuthorityPersistence(options.root);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.persistence.close();
  }

  acceptAuthoritySet(
    canonicalBytes: Uint8Array,
    acceptedAtMs = safeInteger(this.now(), 'current time'),
  ): { status: 'stored' | 'replay'; authoritySetId: Uint8Array } {
    this.assertOpen();
    safeInteger(acceptedAtMs, 'acceptedAtMs');
    const tuple = decode('AuthoritySetV1', canonicalBytes);
    const id = protocolTupleId('AuthoritySetV1', tuple);
    if (tuple[2] !== this.networkId) authorityError('WAL_AUTHORITY_WRONG_VIEW', 'authority set belongs to another network');
    const notBeforeMs = safeTime(tuple[6], 'authority notBeforeMs');
    const expiresAtMs = safeTime(tuple[7], 'authority expiresAtMs');
    if (expiresAtMs <= notBeforeMs) authorityError('WAL_AUTHORITY_INVALID', 'authority validity interval is empty');
    if (acceptedAtMs + this.clockSkewMs < notBeforeMs) authorityError('WAL_AUTHORITY_STALE', 'authority set is not active yet');
    if (acceptedAtMs > expiresAtMs + this.clockSkewMs) authorityError('WAL_AUTHORITY_EXPIRED', 'authority set expired');
    if (tuple[4] <= 0n || tuple[4] > BigInt(tuple[5].length)) {
      authorityError('WAL_AUTHORITY_INVALID', 'authority threshold is not attainable');
    }
    if (tuple[1] === CURATOR_SCOPE && tuple[9].length !== 0) {
      authorityError('WAL_AUTHORITY_INVALID', 'only network authority rotations may carry emergency revocations');
    }
    // The authority ID commits to the revocation list, so producing a literal
    // self-reference would require a cryptographic hash fixed point. Keep the
    // protocol rule explicit even though valid signed input cannot construct it.
    /* v8 ignore start -- cryptographically unreachable defensive invariant */
    if (includesBytes(tuple[9], id)) authorityError('WAL_AUTHORITY_INVALID', 'authority set cannot revoke itself');
    /* v8 ignore stop */
    const current = this.persistence.getCurrentAuthority(this.networkId, tuple[1]);
    if (current === null) {
      const expectedGenesis = tuple[1] === CURATOR_SCOPE
        ? this.genesisCuratorAuthoritySetId
        : this.genesisNetworkAuthoritySetId;
      if (!bytesEqual(id, expectedGenesis) || tuple[3] !== 0n || tuple[8] !== null) {
        authorityError('WAL_AUTHORITY_UNAUTHORIZED', 'authority genesis does not match the configured trust anchor');
      }
      verifyThreshold('AuthoritySetV1', tuple, tuple);
    } else {
      const currentTuple = storedTuple('AuthoritySetV1', current);
      if (bytesEqual(current.id, id)) {
        verifyThreshold('AuthoritySetV1', tuple, currentTuple);
        return { status: 'replay', authoritySetId: copy(id) };
      }
      if (this.persistence.hasAuthorityConflict(this.networkId, tuple[1])) {
        authorityError('WAL_AUTHORITY_BLOCKED', 'authority scope is blocked by a persisted fork');
      }
      if (tuple[3] === currentTuple[3]) {
        this.persistence.recordAuthorityConflict(this.networkId, tuple[1], tuple[3], current.id, id, acceptedAtMs);
        authorityError('WAL_AUTHORITY_FORK', 'two authority sets occupy the same epoch');
      }
      if (tuple[3] !== currentTuple[3] + 1n || !bytesEqual(tuple[8], current.id)) {
        authorityError('WAL_AUTHORITY_ROLLBACK', 'authority rotation must increment and link the current epoch');
      }
      if (acceptedAtMs > safeTime(currentTuple[7], 'current authority expiry') + this.clockSkewMs) {
        authorityError('WAL_AUTHORITY_EXPIRED', 'expired authority cannot authorize a late rotation');
      }
      verifyThreshold('AuthoritySetV1', tuple, currentTuple);
    }
    const status = this.persistence.putAuthority(id, canonicalBytes, tuple, acceptedAtMs);
    return { status, authoritySetId: copy(id) };
  }

  async acceptMembershipCheckpoint(
    canonicalBytes: Uint8Array,
    acceptedAtMs = safeInteger(this.now(), 'current time'),
  ): Promise<{ status: 'stored' | 'replay'; membershipCheckpointId: Uint8Array }> {
    this.assertOpen();
    safeInteger(acceptedAtMs, 'acceptedAtMs');
    const tuple = decode('MembershipCheckpointV1', canonicalBytes);
    const id = protocolTupleId('MembershipCheckpointV1', tuple);
    const authority = this.currentAuthority(CURATOR_SCOPE, acceptedAtMs);
    if (!bytesEqual(tuple[12], authority.id)) {
      authorityError('WAL_AUTHORITY_UNAUTHORIZED', 'membership does not reference the current curator authority');
    }
    verifyThreshold('MembershipCheckpointV1', tuple, authority.tuple);
    const issuedAtMs = safeTime(tuple[11], 'membership issuedAtMs');
    if (issuedAtMs > acceptedAtMs + this.clockSkewMs) {
      authorityError('WAL_AUTHORITY_STALE', 'membership checkpoint was issued too far in the future');
    }
    // Canonical protocol decoding already restricts publish mode to OPEN or
    // CURATED; lifecycle rules below enforce the mode-specific semantics.
    if (tuple[5].some(writer => includesBytes(authority.tuple[5], writer))) {
      authorityError('WAL_AUTHORITY_UNAUTHORIZED', 'curator authority signers cannot be content writers');
    }
    const current = this.persistence.getCurrentMembership(tuple[1]);
    if (current === null) {
      if (tuple[2] !== 0n || tuple[10] !== null) {
        authorityError('WAL_AUTHORITY_ROLLBACK', 'first membership checkpoint must start at zero without a predecessor');
      }
    } else {
      const currentTuple = storedTuple('MembershipCheckpointV1', current);
      if (bytesEqual(id, current.id)) return { status: 'replay', membershipCheckpointId: copy(id) };
      if (tuple[2] === currentTuple[2]) authorityError('WAL_AUTHORITY_FORK', 'membership checkpoint position forked');
      if (tuple[2] !== currentTuple[2] + 1n || !bytesEqual(tuple[10], current.id)) {
        authorityError('WAL_AUTHORITY_ROLLBACK', 'membership checkpoint must increment and link its predecessor');
      }
      if (tuple[3] < currentTuple[3]) authorityError('WAL_AUTHORITY_WRONG_POLICY', 'membership policy epoch cannot decrease');
    }
    if (!await this.adapter.validateMembership({ membershipCheckpointId: copy(id), membership: tuple })) {
      authorityError('WAL_AUTHORITY_UNAUTHORIZED', 'current DKG membership adapter rejected the checkpoint');
    }
    const status = this.persistence.putMembership(id, canonicalBytes, tuple, acceptedAtMs);
    return { status, membershipCheckpointId: copy(id) };
  }

  async acceptAuthorCheckpoint(input: AcceptAuthorCheckpointInput): Promise<{
    status: 'stored' | 'replay';
    checkpointId: Uint8Array;
  }> {
    this.assertOpen();
    const acceptedAtMs = safeInteger(input.acceptedAtMs ?? this.now(), 'acceptedAtMs');
    const collectionId = fixed(input.collectionId, 32, 'collectionId');
    const tuple = decodeCheckpoint(input.canonicalBytes);
    const id = protocolTupleId('AuthorCheckpointV1', tuple);
    const membershipStored = this.persistence.getCurrentMembership(collectionId);
    if (membershipStored === null) authorityError('WAL_AUTHORITY_UNAUTHORIZED', 'author checkpoint has no current membership');
    const membership = storedTuple('MembershipCheckpointV1', membershipStored);
    if (!bytesEqual(membership[1], collectionId) || !includesBytes(membership[8], tuple[1])) {
      authorityError('WAL_AUTHORITY_WRONG_VIEW', 'author checkpoint namespace is outside current membership');
    }
    const curator = this.currentAuthority(CURATOR_SCOPE, acceptedAtMs);
    if (includesBytes(curator.tuple[5], tuple[2])) {
      authorityError('WAL_AUTHORITY_UNAUTHORIZED', 'curator authority cannot author content or checkpoints');
    }
    if (!includesBytes(membership[5], tuple[2])) {
      if (membership[4] !== OPEN_MODE) authorityError('WAL_AUTHORITY_UNAUTHORIZED', 'writer is not in curated membership');
      const currentVector = this.persistence.getCurrentVector(collectionId);
      const frontier = currentVector === null
        ? null
        : storedTuple('CollectionHeadVectorV1', currentVector)[9];
      if (!await this.adapter.validateOpenAuthor({
        collectionId: copy(collectionId),
        namespaceId: copy(tuple[1]),
        writerId: copy(tuple[2]),
        checkpoint: tuple,
        finalizedChainFrontier: frontier,
      })) {
        authorityError('WAL_AUTHORITY_UNAUTHORIZED', 'open author lacks current chain authorization');
      }
    }
    const commitment = new MutableSetCommitment(input.objectIds.map(value => fixed(value, 32, 'WalObjectId') as WalObjectId));
    if (BigInt(commitment.size) !== tuple[7] || !bytesEqual(commitment.root, tuple[6])) {
      authorityError('WAL_AUTHORITY_INVALID', 'author checkpoint count/root does not match its supplied object set');
    }
    if (tuple[4] !== tuple[8]) {
      authorityError('WAL_AUTHORITY_INVALID', 'version 1 requires one author checkpoint per sequence');
    }
    const atPosition = this.persistence.findCheckpointAtPosition(tuple[1], tuple[2], tuple[3], tuple[4]);
    const same = atPosition.find(candidate => bytesEqual(candidate.id, id));
    if (same !== undefined) return { status: 'replay', checkpointId: copy(id) };
    if (atPosition.length > 0) {
      this.persistence.putCheckpoint(id, input.canonicalBytes, tuple, commitment.serialize(), acceptedAtMs);
      this.persistence.markEquivocation([...atPosition.map(candidate => candidate.id), id]);
      authorityError('WAL_AUTHORITY_FORK', 'author checkpoint position has different signed hashes');
    }
    if (this.persistence.hasLaneEquivocation(tuple[1], tuple[2])) {
      authorityError('WAL_AUTHORITY_BLOCKED', 'author lane remains blocked after equivocation');
    }
    const latestEpoch = this.persistence.getLatestWriterEpoch(tuple[1], tuple[2]);
    const tip = this.persistence.getAcceptedLaneTip(tuple[1], tuple[2], tuple[3]);
    if (tip !== null) {
      const previous = decodeCheckpoint(tip.canonicalBytes);
      const previousSet = MutableSetCommitment.restore(tip.setSnapshot);
      if (
        tuple[4] !== previous[4] + 1n
        || !bytesEqual(tuple[9], tip.id)
        || tuple[7] !== previous[7] + 1n
        || tuple[8] !== previous[8] + 1n
        || tuple[10] !== null
        || tuple[11] !== previous[11]
      ) {
        authorityError('WAL_AUTHORITY_ROLLBACK', 'author checkpoint does not extend the exact current lane tip');
      }
      const nextIds = new Set(commitment.ids().map(hex));
      if (previousSet.ids().some(value => !nextIds.has(hex(value)))) {
        authorityError('WAL_AUTHORITY_ROLLBACK', 'author checkpoint is not a set extension');
      }
    } else if (latestEpoch === null) {
      if (tuple[4] !== 0n || tuple[8] !== 0n || tuple[9] !== null || tuple[7] !== 1n) {
        authorityError('WAL_AUTHORITY_ROLLBACK', 'first observed author epoch must begin with one sequence-zero object');
      }
      if (tuple[10] !== null && !await this.adapter.validateEpochSnapshot({
        collectionId: copy(collectionId), checkpoint: tuple, baselineSnapshotObjectId: copy(tuple[10]),
      })) {
        authorityError('WAL_AUTHORITY_UNAUTHORIZED', 'first observed snapshot baseline was not authorized');
      }
    } else {
      if (
        tuple[3] !== latestEpoch + 1n
        || tuple[4] !== 0n
        || tuple[8] !== 0n
        || tuple[9] !== null
        || tuple[10] === null
        || tuple[7] !== 1n
        || !includesBytes(input.objectIds, tuple[10])
      ) {
        authorityError('WAL_AUTHORITY_ROLLBACK', 'new author epoch must begin with its signed snapshot baseline');
      }
      if (!await this.adapter.validateEpochSnapshot({
        collectionId: copy(collectionId), checkpoint: tuple, baselineSnapshotObjectId: copy(tuple[10]),
      })) {
        authorityError('WAL_AUTHORITY_UNAUTHORIZED', 'author epoch snapshot was not authorized');
      }
    }
    const status = this.persistence.putCheckpoint(id, input.canonicalBytes, tuple, commitment.serialize(), acceptedAtMs);
    return { status, checkpointId: copy(id) };
  }

  acceptCollectionVector(
    canonicalBytes: Uint8Array,
    acceptedAtMs = safeInteger(this.now(), 'current time'),
  ): { status: 'stored' | 'replay'; vectorId: Uint8Array } {
    this.assertOpen();
    safeInteger(acceptedAtMs, 'acceptedAtMs');
    const tuple = decode('CollectionHeadVectorV1', canonicalBytes);
    const id = protocolTupleId('CollectionHeadVectorV1', tuple);
    const authority = this.currentAuthority(CURATOR_SCOPE, acceptedAtMs);
    if (!bytesEqual(tuple[10], authority.id)) {
      authorityError('WAL_AUTHORITY_UNAUTHORIZED', 'vector does not reference current curator authority');
    }
    verifyThreshold('CollectionHeadVectorV1', tuple, authority.tuple);
    const issuedAtMs = safeTime(tuple[7], 'vector issuedAtMs');
    const expiresAtMs = safeTime(tuple[8], 'vector expiresAtMs');
    if (expiresAtMs <= issuedAtMs) authorityError('WAL_AUTHORITY_INVALID', 'vector validity interval is empty');
    if (issuedAtMs > acceptedAtMs + this.clockSkewMs) authorityError('WAL_AUTHORITY_STALE', 'vector was issued too far in the future');
    if (acceptedAtMs > expiresAtMs + this.clockSkewMs) authorityError('WAL_AUTHORITY_EXPIRED', 'vector already expired');
    const membershipStored = this.persistence.getMembership(tuple[2]);
    const currentMembership = this.persistence.getCurrentMembership(tuple[1]);
    if (membershipStored === null || currentMembership === null || !bytesEqual(membershipStored.id, currentMembership.id)) {
      authorityError('WAL_AUTHORITY_STALE', 'vector does not reference the current collection membership');
    }
    const membership = storedTuple('MembershipCheckpointV1', membershipStored);
    const vectorNamespaces = tuple[3].map(value => value[0]);
    if (!setMatches(membership[8], vectorNamespaces)) {
      authorityError('WAL_AUTHORITY_WRONG_VIEW', 'vector must name every and only active membership namespace');
    }
    const heads = flattenVector(tuple);
    if (heads.length > this.maximumAuthorsPerVector) {
      authorityError('WAL_AUTHORITY_LIMIT_EXCEEDED', 'vector exceeds the version-1 author limit');
    }
    for (const head of heads) {
      if (includesBytes(authority.tuple[5], head.writerId)) {
        authorityError('WAL_AUTHORITY_UNAUTHORIZED', 'curator authority cannot insert its own authored checkpoint');
      }
      if (membership[4] === CURATED_MODE && !includesBytes(membership[5], head.writerId)) {
        authorityError('WAL_AUTHORITY_UNAUTHORIZED', 'curated vector contains an unauthorized writer');
      }
    }
    if (this.persistence.hasVectorConflict(tuple[1])) {
      authorityError('WAL_AUTHORITY_BLOCKED', 'collection vector lifecycle is blocked by a persisted fork');
    }
    const current = this.persistence.getCurrentVector(tuple[1]);
    if (current === null) {
      if (tuple[5] !== 0n || tuple[6] !== null) {
        authorityError('WAL_AUTHORITY_ROLLBACK', 'first vector must start at number zero without a predecessor');
      }
    } else {
      const currentTuple = storedTuple('CollectionHeadVectorV1', current);
      if (bytesEqual(id, current.id)) return { status: 'replay', vectorId: copy(id) };
      const position = comparePosition(tuple[4], tuple[5], currentTuple[4], currentTuple[5]);
      if (position === 0) {
        this.persistence.recordVectorConflict(tuple[1], tuple[4], tuple[5], current.id, id, acceptedAtMs);
        authorityError('WAL_AUTHORITY_FORK', 'two vectors occupy the same collection position');
      }
      if (position < 0 || !bytesEqual(tuple[6], current.id)) {
        authorityError('WAL_AUTHORITY_ROLLBACK', 'vector cannot roll back or unlink current history');
      }
      if (bytesEqual(currentTuple[10], tuple[10])) {
        if (tuple[4] !== currentTuple[4] || tuple[5] !== currentTuple[5] + 1n) {
          authorityError('WAL_AUTHORITY_ROLLBACK', 'same-authority vector must increment its current epoch number');
        }
      } else if (tuple[4] !== currentTuple[4] + 1n || tuple[5] !== 0n) {
        authorityError('WAL_AUTHORITY_ROLLBACK', 'curator rotation must increment vector epoch and reset number');
      }
    }
    const rollbackStatus = this.rollbackStore.rollbackProtectionStatus();
    if (rollbackStatus.state !== 'available') {
      authorityError('WAL_AUTHORITY_BLOCKED', `rollback protection unavailable: ${rollbackStatus.reason ?? 'unknown'}`);
    }
    try {
      this.rollbackStore.setRollbackHighWater({
        collectionId: copy(tuple[1]),
        vectorEpoch: tuple[4],
        vectorNumber: tuple[5],
        vectorId: copy(id),
        updatedAtMs: acceptedAtMs,
      });
    } catch (error) {
      authorityError('WAL_AUTHORITY_ROLLBACK', 'vector violates protected rollback high-water', error);
    }
    const status = this.persistence.putVector(id, canonicalBytes, tuple, heads, acceptedAtMs);
    return { status, vectorId: copy(id) };
  }

  async evaluate(view: WalAuthorityView, evaluatedAtMs = safeInteger(this.now(), 'current time')): Promise<WalAuthorityCompleteness> {
    this.assertOpen();
    safeInteger(evaluatedAtMs, 'evaluatedAtMs');
    const resolved = this.resolveView(view);
    const base = {
      collectionId: copy(resolved.collectionId),
      namespaceId: copy(resolved.namespaceId),
      missingCheckpointIds: [] as Uint8Array[],
      privateMetadataAllowed: false,
    };
    const rollback = this.rollbackStore.rollbackProtectionStatus();
    if (rollback.state !== 'available') return { ...base, status: 'unknown-freshness', reason: 'ROLLBACK_GUARD_UNAVAILABLE' };
    if (this.persistence.hasAuthorityConflict(this.networkId, CURATOR_SCOPE)) {
      return { ...base, status: 'blocked', reason: 'AUTHORITY_FORK' };
    }
    if (this.persistence.hasVectorConflict(resolved.collectionId)) {
      return { ...base, status: 'blocked', reason: 'VECTOR_FORK' };
    }
    const membershipStored = this.persistence.getCurrentMembership(resolved.collectionId);
    if (membershipStored === null) return { ...base, status: 'unknown-freshness', reason: 'NO_MEMBERSHIP' };
    const membership = storedTuple('MembershipCheckpointV1', membershipStored);
    const vectorStored = this.persistence.getCurrentVector(resolved.collectionId);
    if (vectorStored === null) return {
      ...base,
      status: 'unknown-freshness',
      reason: 'NO_VECTOR',
      membershipCheckpointId: copy(membershipStored.id),
    };
    const vector = storedTuple('CollectionHeadVectorV1', vectorStored);
    const context = {
      ...base,
      membershipCheckpointId: copy(membershipStored.id),
      vectorId: copy(vectorStored.id),
    };
    const currentAuthority = this.persistence.getCurrentAuthority(this.networkId, CURATOR_SCOPE);
    if (currentAuthority === null || !bytesEqual(vector[10], currentAuthority.id)) {
      return { ...context, status: 'unknown-freshness', reason: 'AUTHORITY_EXPIRED' };
    }
    const authority = storedTuple('AuthoritySetV1', currentAuthority);
    if (this.persistence.isRevoked(currentAuthority.id)) {
      return { ...context, status: 'unknown-freshness', reason: 'AUTHORITY_REVOKED' };
    }
    if (evaluatedAtMs > safeTime(authority[7], 'authority expiry') + this.clockSkewMs) {
      return { ...context, status: 'unknown-freshness', reason: 'AUTHORITY_EXPIRED' };
    }
    if (evaluatedAtMs > safeTime(vector[8], 'vector expiry') + this.clockSkewMs) {
      return { ...context, status: 'unknown-freshness', reason: 'VECTOR_EXPIRED' };
    }
    if (!bytesEqual(vector[2], membershipStored.id)) {
      return { ...context, status: 'unknown-freshness', reason: 'VECTOR_MEMBERSHIP_MISMATCH' };
    }
    const wrong = this.viewMismatchReason(view, resolved.collectionId, resolved.namespaceId, membership);
    if (wrong !== null) return { ...context, status: 'blocked', reason: wrong };
    if (!await this.adapter.isWalObjectAdmitted(membership[9])) {
      return { ...context, status: 'known-incomplete', reason: 'MISSING_POLICY_OBJECT', privateMetadataAllowed: true };
    }
    const expected = this.persistence.getVectorHeads(vectorStored.id)
      .filter(head => bytesEqual(head.namespaceId, resolved.namespaceId));
    const expectedWriters = new Set(expected.map(head => hex(head.writerId)));
    const localHeads = this.persistence.getAcceptedNamespaceHeads(resolved.namespaceId);
    if (localHeads.some(head => !expectedWriters.has(hex(head.writerId)))) {
      return { ...context, status: 'known-incomplete', reason: 'VECTOR_MEMBERSHIP_MISMATCH', privateMetadataAllowed: true };
    }
    const missing: Uint8Array[] = [];
    for (const head of expected) {
      if (this.persistence.hasLaneEquivocation(head.namespaceId, head.writerId)) {
        return { ...context, status: 'blocked', reason: 'CHECKPOINT_EQUIVOCATION' };
      }
      const checkpoint = this.persistence.getCheckpoint(head.checkpointId);
      if (checkpoint === null || checkpoint.status !== 'ACCEPTED') missing.push(copy(head.checkpointId));
    }
    if (missing.length > 0) {
      return {
        ...context,
        status: 'known-incomplete',
        reason: 'MISSING_CHECKPOINTS',
        missingCheckpointIds: missing,
        privateMetadataAllowed: true,
      };
    }
    return { ...context, status: 'complete', reason: 'COMPLETE', privateMetadataAllowed: true };
  }

  async authorizePrivateDisclosure(request: PrivateDisclosureRequest, evaluatedAtMs = safeInteger(this.now(), 'current time')): Promise<boolean> {
    this.assertOpen();
    const result = await this.evaluate(request.view, evaluatedAtMs);
    if (!result.privateMetadataAllowed || request.view.viewKey[4] !== PRIVATE_VISIBILITY) return false;
    const membershipStored = this.persistence.getCurrentMembership(result.collectionId);
    /* v8 ignore start -- a concurrent external SQLite writer can only make this fail closed */
    if (membershipStored === null) return false;
    /* v8 ignore stop */
    const membership = storedTuple('MembershipCheckpointV1', membershipStored);
    const agent = fixed(request.requesterAgentAddress, 20, 'requesterAgentAddress');
    const peer = fixed(request.transportPeerId, request.transportPeerId.length, 'transportPeerId');
    if (peer.length === 0 || !includesBytes(membership[6], agent)) return false;
    return this.adapter.authorizePrivateDisclosure({
      collectionId: copy(result.collectionId),
      namespaceId: copy(result.namespaceId),
      membershipCheckpointId: copy(membershipStored.id),
      memberAgentAddress: agent,
      transportPeerId: peer,
      delegation: request.delegation,
      nowMs: evaluatedAtMs,
    });
  }

  installRollbackRecovery(
    canonicalBytes: Uint8Array,
    cohortMinimum: RollbackCohortMinimum,
    acceptedAtMs = safeInteger(this.now(), 'current time'),
  ): Uint8Array {
    this.assertOpen();
    safeInteger(acceptedAtMs, 'acceptedAtMs');
    const tuple = decode('RollbackRecoveryV1', canonicalBytes);
    const id = protocolTupleId('RollbackRecoveryV1', tuple);
    if (tuple[1] !== this.networkId || !bytesEqual(tuple[2], cohortMinimum.collectionId)) {
      authorityError('WAL_AUTHORITY_WRONG_VIEW', 'rollback recovery network or collection mismatches its cohort');
    }
    const authority = this.currentAuthority(NETWORK_SCOPE, acceptedAtMs);
    if (!bytesEqual(tuple[8], authority.id)) {
      authorityError('WAL_AUTHORITY_UNAUTHORIZED', 'rollback recovery does not reference current network authority');
    }
    verifyThreshold('RollbackRecoveryV1', tuple, authority.tuple);
    if (safeTime(tuple[7], 'rollback recovery issuedAtMs') > acceptedAtMs + this.clockSkewMs) {
      authorityError('WAL_AUTHORITY_STALE', 'rollback recovery was issued too far in the future');
    }
    const comparison = comparePosition(tuple[3], tuple[4], cohortMinimum.vectorEpoch, cohortMinimum.vectorNumber);
    if (comparison < 0 || (comparison === 0 && !bytesEqual(tuple[5], cohortMinimum.vectorId))) {
      authorityError('WAL_AUTHORITY_ROLLBACK', 'rollback recovery is below the required cohort maximum');
    }
    try {
      this.rollbackStore.installVerifiedRollbackRecovery({
        collectionId: copy(tuple[2]),
        vectorEpoch: tuple[3],
        vectorNumber: tuple[4],
        vectorId: copy(tuple[5]),
        updatedAtMs: acceptedAtMs,
      });
    } catch (error) {
      authorityError('WAL_AUTHORITY_BLOCKED', 'rollback high-water recovery installation failed', error);
    }
    return copy(id);
  }

  private currentAuthority(scope: bigint, atMs: number): {
    id: Uint8Array;
    tuple: ProtocolTuple<'AuthoritySetV1'>;
  } {
    if (this.persistence.hasAuthorityConflict(this.networkId, scope)) {
      authorityError('WAL_AUTHORITY_BLOCKED', 'authority scope is blocked by a persisted fork');
    }
    const stored = this.persistence.getCurrentAuthority(this.networkId, scope);
    if (stored === null) authorityError('WAL_AUTHORITY_UNAUTHORIZED', 'required authority set is not installed');
    if (this.persistence.isRevoked(stored.id)) authorityError('WAL_AUTHORITY_UNAUTHORIZED', 'required authority set is revoked');
    const tuple = storedTuple('AuthoritySetV1', stored);
    if (atMs + this.clockSkewMs < safeTime(tuple[6], 'authority notBeforeMs')) {
      authorityError('WAL_AUTHORITY_STALE', 'required authority set is not active yet');
    }
    if (atMs > safeTime(tuple[7], 'authority expiresAtMs') + this.clockSkewMs) {
      authorityError('WAL_AUTHORITY_EXPIRED', 'required authority set expired');
    }
    return { id: copy(stored.id), tuple };
  }

  private resolveView(view: WalAuthorityView): { collectionId: Uint8Array; namespaceId: Uint8Array } {
    try {
      return {
        collectionId: collectionIdV1(view.collectionKey),
        namespaceId: namespaceIdV1(view.viewKey),
      };
    } catch (error) {
      return authorityError('WAL_AUTHORITY_INVALID', 'replication view is not canonical', error);
    }
  }

  private viewMismatchReason(
    view: WalAuthorityView,
    collectionId: Uint8Array,
    namespaceId: Uint8Array,
    membership: ProtocolTuple<'MembershipCheckpointV1'>,
  ): WalAuthorityReason | null {
    const collection = view.collectionKey;
    const exact = view.viewKey;
    if (
      collection[0] !== exact[0]
      || collection[1] !== exact[1]
      || collection[2] !== exact[2]
      || collection[3] !== exact[4]
      || !bytesEqual(membership[1], collectionId)
    ) return 'WRONG_COLLECTION';
    if (!includesBytes(membership[8], namespaceId)) return 'WRONG_VIEW';
    if (membership[3] !== exact[5]) return 'WRONG_POLICY_EPOCH';
    if (
      (exact[4] === PRIVATE_VISIBILITY && exact[6] === null)
      || (exact[4] === PUBLIC_VISIBILITY && exact[6] !== null)
    ) return 'WRONG_KEY_EPOCH';
    return null;
  }

  private assertOpen(): void {
    if (this.closed) authorityError('WAL_AUTHORITY_IO', 'WAL authority lifecycle is closed');
  }
}
