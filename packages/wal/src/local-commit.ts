import { encodeCanonicalCbor } from './protocol/canonical-cbor.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { WAL_V1_ENUMS } from './protocol/schema.js';
import type { WalEip191Signer } from './protocol/signatures.js';
import { encodePublicDkgPayload, encryptPrivateDkgPayload } from './privacy/crypto.js';
import {
  encodeAcceptedRdfMutationV1,
  DKG_MUTATION_MEDIA_TYPE_V1,
  type EncodeAcceptedRdfMutationInputV1,
  type EncodedAcceptedRdfMutationV1,
  type RdfPolicyAdmissionV1,
} from './rdf/index.js';
import type { WalControlStore } from './control/store.js';
import type { FinalizeLocalWalResult, LocalCommitWorkRecord } from './control/types.js';

const DKG_MUTATION_KIND = BigInt(WAL_V1_ENUMS.payloadKind.DKG_MUTATION);
const DETERMINISTIC_CBOR = BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR);
const REPLAY_KIND = 'WAL_REPLAY_LOGICAL_KEY';
const LOCAL_REQUEST_DIGEST_DOMAIN = new TextEncoder().encode('dkg-wal-local-request-v1\0');

function copy(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function bytes32(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`${label} must be exactly 32 bytes`);
  }
  return copy(value);
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 1_024 ? message : message.slice(0, 1_024);
}

function localRequestDigest(payloadBytes: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(LOCAL_REQUEST_DIGEST_DOMAIN.length + payloadBytes.length);
  bytes.set(LOCAL_REQUEST_DIGEST_DOMAIN);
  bytes.set(payloadBytes, LOCAL_REQUEST_DIGEST_DOMAIN.length);
  return blake3(bytes);
}

export interface WalCheckpointNudgeV1 {
  namespaceId: Uint8Array;
  writerId: Uint8Array;
  writerEpoch: bigint;
  checkpointId: Uint8Array;
  objectSetRoot: Uint8Array;
  objectCount: bigint;
  sequence: bigint;
}

export type WalCheckpointNudgeSender = (nudge: WalCheckpointNudgeV1) => void | Promise<void>;

export interface WalLocalCommitterOptions {
  control: WalControlStore;
  sendCheckpointNudge?: WalCheckpointNudgeSender;
  maximumPostCommitAttempts?: number;
  now?: () => number;
}

export interface CommitEncodedLocalMutationV1Input {
  namespaceId: Uint8Array;
  writerId: Uint8Array;
  writerEpoch: bigint;
  logicalKey: Uint8Array;
  payloadBytes?: Uint8Array;
  buildPayloadBytes?: Parameters<WalControlStore['commitLocal']>[0]['buildPayloadBytes'];
  signer: WalEip191Signer;
  idempotencyKey: string;
  requestDigest: Uint8Array;
  baseHeads?: readonly Uint8Array[];
  policyObjectId?: Uint8Array | null;
  maximumObjectBytes?: bigint;
  createdAtMs?: number;
}

export interface PrivateRdfLocalPayloadV1 {
  readonly epochKey: Uint8Array;
  readonly keyEpoch: bigint;
  /** Fixed nonce seam for conformance tests; production omits it. */
  readonly nonce?: Uint8Array;
}

export interface WalLocalCommitReceiptV1 {
  walObjectId: Uint8Array;
  checkpointId: Uint8Array;
  walStatus: FinalizeLocalWalResult['status'];
  materializationStatus: 'pending' | 'materialized' | 'blocked';
  nudgeStatus: 'sent' | 'failed' | 'not-configured';
  sequence: bigint;
  objectCount: bigint;
  objectSetRoot: Uint8Array;
  shadowError?: string;
  nudgeError?: string;
}

export interface CommitRdfLocalMutationV1Input {
  policyAdmission: RdfPolicyAdmissionV1;
  writerId: Uint8Array;
  writerEpoch: bigint;
  signer: WalEip191Signer;
  idempotencyKey: string;
  /** Optional local override; production derives it from exact payload bytes. */
  requestDigest?: Uint8Array;
  mutation: Omit<EncodeAcceptedRdfMutationInputV1, 'writerId' | 'policyObjectId' | 'policy'>;
  /** Present only for a private replication view. */
  privatePayload?: PrivateRdfLocalPayloadV1;
  createdAtMs?: number;
}

export interface CommittedRdfLocalMutationV1 {
  encoded: EncodedAcceptedRdfMutationV1;
  receipt: WalLocalCommitReceiptV1;
}

/**
 * WAL-013 local authoring boundary. The semantic core's accepted outcome and
 * canonical payload plaintext are complete before WalControlStore acquires its
 * packed/author writer lane. Public envelopes are also complete before the lane;
 * a private envelope is finalized inside the transaction only after its sequence
 * is allocated and its nonce is durably claimed. Replay and checkpoint wakeups
 * happen only after the durable commit returns.
 */
export class WalLocalCommitter {
  private readonly control: WalControlStore;
  private readonly sendCheckpointNudge?: WalCheckpointNudgeSender;
  private readonly maximumPostCommitAttempts: number;
  private readonly now: () => number;

  constructor(options: WalLocalCommitterOptions) {
    if (!options?.control) throw new TypeError('WalLocalCommitter requires a control store');
    const attempts = options.maximumPostCommitAttempts ?? 16;
    if (!Number.isSafeInteger(attempts) || attempts < 1) {
      throw new TypeError('maximumPostCommitAttempts must be a positive safe integer');
    }
    this.control = options.control;
    this.sendCheckpointNudge = options.sendCheckpointNudge;
    this.maximumPostCommitAttempts = attempts;
    this.now = options.now ?? Date.now;
  }

  async commitRdf(input: CommitRdfLocalMutationV1Input): Promise<CommittedRdfLocalMutationV1> {
    const admission = input.policyAdmission;
    if (!admission) throw new TypeError('current admitted RDF policy is required');
    const encoded = encodeAcceptedRdfMutationV1({
      ...input.mutation,
      writerId: input.writerId,
      policyObjectId: admission.policyObjectId,
      policy: admission.policy,
    });
    const privatePayload = input.privatePayload;
    const payloadIntent = encodeCanonicalCbor([
      encoded.contentBytes,
      privatePayload?.keyEpoch ?? null,
    ]);
    const publicEnvelope = privatePayload === undefined
      ? encodePublicDkgPayload({
          payloadKind: DKG_MUTATION_KIND,
          codec: DETERMINISTIC_CBOR,
          mediaType: DKG_MUTATION_MEDIA_TYPE_V1,
          contentBytes: encoded.contentBytes,
        })
      : null;
    const receipt = await this.commitEncoded({
      namespaceId: admission.namespaceId,
      writerId: input.writerId,
      writerEpoch: input.writerEpoch,
      logicalKey: encoded.logicalKey,
      ...(publicEnvelope === null
        ? {
            buildPayloadBytes: coordinates => encryptPrivateDkgPayload({
              ...coordinates,
              epochKey: privatePayload!.epochKey,
              keyEpoch: privatePayload!.keyEpoch,
              payloadKind: DKG_MUTATION_KIND,
              codec: DETERMINISTIC_CBOR,
              mediaType: DKG_MUTATION_MEDIA_TYPE_V1,
              plaintext: encoded.contentBytes,
              nonceRegistry: this.control,
              ...(privatePayload!.nonce === undefined ? {} : { nonce: privatePayload!.nonce }),
            }).canonicalBytes,
          }
        : { payloadBytes: publicEnvelope.canonicalBytes }),
      signer: input.signer,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest ?? localRequestDigest(
        publicEnvelope?.canonicalBytes ?? payloadIntent,
      ),
      baseHeads: encoded.dkgMutation[4],
      policyObjectId: admission.policyObjectId,
      maximumObjectBytes: admission.policy[4],
      createdAtMs: input.createdAtMs,
    });
    return { encoded, receipt };
  }

  async commitEncoded(input: CommitEncodedLocalMutationV1Input): Promise<WalLocalCommitReceiptV1> {
    const logicalKey = bytes32(input.logicalKey, 'logicalKey');
    const committed = await this.control.commitLocal({
      namespaceId: input.namespaceId,
      writerId: input.writerId,
      writerEpoch: input.writerEpoch,
      ...(input.payloadBytes === undefined ? {} : { payloadBytes: input.payloadBytes }),
      ...(input.buildPayloadBytes === undefined ? {} : { buildPayloadBytes: input.buildPayloadBytes }),
      signer: input.signer,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      status: 'MATERIALIZATION_PENDING',
      policyObjectId: input.policyObjectId,
      maximumObjectBytes: input.maximumObjectBytes,
      logicalKey,
      baseHeads: input.baseHeads,
      createdAtMs: input.createdAtMs,
    });

    let shadowError: string | undefined;
    let work = this.control.getLocalCommitWork(committed.objectId);
    if (work === null) throw new Error('durable local commit is missing its post-commit outbox row');
    if (work.state === 'PENDING' || work.state === 'BLOCKED') {
      try {
        this.enqueueReplay(work);
        this.control.setLocalCommitWorkState({
          objectId: committed.objectId,
          expected: ['PENDING', 'BLOCKED'],
          state: 'QUEUED',
          updatedAtMs: this.now(),
        });
      } catch (error) {
        shadowError = errorMessage(error);
        try {
          const current = this.control.getLocalCommitWork(committed.objectId);
          if (current?.state === 'PENDING' || current?.state === 'BLOCKED') {
            this.control.setLocalCommitWorkState({
              objectId: committed.objectId,
              expected: ['PENDING', 'BLOCKED'],
              state: 'BLOCKED',
              lastError: shadowError,
              updatedAtMs: this.now(),
            });
          }
        } catch {
          // The durable PENDING row itself remains sufficient for restart recovery.
        }
      }
      work = this.control.getLocalCommitWork(committed.objectId)!;
    }

    let nudgeStatus: WalLocalCommitReceiptV1['nudgeStatus'] = 'not-configured';
    let nudgeError: string | undefined;
    if (this.sendCheckpointNudge) {
      try {
        await this.sendCheckpointNudge({
          namespaceId: copy(input.namespaceId),
          writerId: copy(input.writerId),
          writerEpoch: input.writerEpoch,
          checkpointId: copy(committed.checkpointId),
          objectSetRoot: copy(committed.objectSetRoot),
          objectCount: committed.objectCount,
          sequence: committed.sequence,
        });
        nudgeStatus = 'sent';
      } catch (error) {
        nudgeStatus = 'failed';
        nudgeError = errorMessage(error);
      }
    }

    return {
      walObjectId: copy(committed.objectId),
      checkpointId: copy(committed.checkpointId),
      walStatus: committed.status,
      materializationStatus:
        work.state === 'MATERIALIZED' ? 'materialized' : work.state === 'BLOCKED' ? 'blocked' : 'pending',
      nudgeStatus,
      sequence: committed.sequence,
      objectCount: committed.objectCount,
      objectSetRoot: copy(committed.objectSetRoot),
      ...(shadowError === undefined ? {} : { shadowError }),
      ...(nudgeError === undefined ? {} : { nudgeError }),
    };
  }

  /** Read-only encoder frontier; commitLocal enforces it again as a CAS. */
  localHeads(namespaceId: Uint8Array, logicalKey: Uint8Array): readonly Uint8Array[] {
    return this.control.getLocalLogicalHeads(
      bytes32(namespaceId, 'namespaceId'),
      bytes32(logicalKey, 'logicalKey'),
    );
  }

  /** Replays the durable outbox after a crash between commit and queueing. */
  recoverPostCommitWork(limit = 1_000): { queued: number; blocked: number; remaining: number } {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError('post-commit recovery limit must be a positive safe integer');
    }
    const effectiveLimit = Math.min(limit, this.control.maximumQueueEntries);
    const pending = this.control.listLocalCommitWork(['PENDING', 'BLOCKED'], effectiveLimit);
    let queued = 0;
    let blocked = 0;
    for (const work of pending) {
      try {
        this.enqueueReplay(work);
        this.control.setLocalCommitWorkState({
          objectId: work.objectId,
          expected: ['PENDING', 'BLOCKED'],
          state: 'QUEUED',
          updatedAtMs: this.now(),
        });
        queued += 1;
      } catch (error) {
        blocked += 1;
        const current = this.control.getLocalCommitWork(work.objectId);
        if (current?.state === 'PENDING' || current?.state === 'BLOCKED') {
          this.control.setLocalCommitWorkState({
            objectId: work.objectId,
            expected: ['PENDING', 'BLOCKED'],
            state: 'BLOCKED',
            lastError: errorMessage(error),
            updatedAtMs: this.now(),
          });
        }
      }
    }
    return {
      queued,
      blocked,
      remaining: this.control.listLocalCommitWork(['PENDING', 'BLOCKED'], effectiveLimit).length,
    };
  }

  private enqueueReplay(work: LocalCommitWorkRecord): void {
    const namespaceHex = hex(work.namespaceId);
    const logicalKeyHex = hex(work.logicalKey);
    this.control.enqueueRetry({
      key: `wal-replay:${namespaceHex}:${logicalKeyHex}`,
      kind: REPLAY_KIND,
      payload: encodeCanonicalCbor([1n, work.namespaceId, work.logicalKey]),
      maximumAttempts: this.maximumPostCommitAttempts,
      availableAtMs: this.now(),
    });
  }
}
