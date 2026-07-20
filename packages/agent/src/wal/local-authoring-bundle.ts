import { lstat, readFile } from 'node:fs/promises';
import {
  MutableSetCommitment,
  admitSignedRdfPolicyV1,
  collectionIdV1,
  decodeProtocolTuple,
  namespaceIdV1,
  protocolTupleId,
  verifySingleSignedProtocolTuple,
  verifyThresholdSignedProtocolTuple,
  verifyWalObjectV1,
  walObjectId,
  type PackedWalObjectStore,
  type ProtocolTuple,
  type RdfPolicyAdmissionV1,
  type WalControlStore,
} from '@origintrail-official/dkg-wal';
import type { PublisherWalShadowMutationV1 } from '@origintrail-official/dkg-publisher';
import type {
  DkgWalPublisherCommitContextResolverV1,
  DkgWalPublisherCommitContextV1,
  DkgWalPrivatePayloadResolverV1,
} from './local-commit.js';

const MAXIMUM_BUNDLE_BYTES = 16 * 1024 * 1024;
const PUBLIC_VISIBILITY = 0n;
const PRIVATE_VISIBILITY = 1n;
const SWM_TIER = 0n;
const CURATOR_SCOPE = 0n;
const CLOCK_SKEW_MS = 5_000;

export type DkgWalLocalAuthoringBundleErrorCode =
  | 'WAL_LOCAL_AUTHORING_BUNDLE_INVALID'
  | 'WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED'
  | 'WAL_LOCAL_AUTHORING_VIEW_UNAVAILABLE'
  | 'WAL_LOCAL_AUTHORING_WRITER_UNAUTHORIZED';

export class DkgWalLocalAuthoringBundleError extends Error {
  constructor(readonly code: DkgWalLocalAuthoringBundleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DkgWalLocalAuthoringBundleError';
  }
}

interface JsonAuthoringViewV1 {
  contextGraphId: string;
  subGraphName: string | null;
  visibility: 'public' | 'private';
  keyEpoch: string | null;
  writerEpoch: string;
  membershipCheckpoints: string[];
  policyWalObject: string;
  policyCheckpoint: string;
}

interface JsonLocalAuthoringBundleV1 {
  version: 1;
  networkId: string;
  curatorAuthoritySets: string[];
  views: JsonAuthoringViewV1[];
}

interface AdmittedAuthoringViewV1 {
  contextGraphId: string;
  subGraphName: string | null;
  visibility: 'public' | 'private';
  keyEpoch: bigint | null;
  writerEpoch: bigint;
  membership: ProtocolTuple<'MembershipCheckpointV1'>;
  admission: RdfPolicyAdmissionV1;
}

export interface LoadDkgWalLocalAuthoringBundleOptionsV1 {
  bundlePath: string;
  expectedNetworkId: string;
  expectedCuratorAuthoritySetId: string;
  objectStore: PackedWalObjectStore;
  controlStore: WalControlStore;
  resolvePrivatePayload?: DkgWalPrivatePayloadResolverV1;
  now?: () => number;
}

function fail(
  code: DkgWalLocalAuthoringBundleErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new DkgWalLocalAuthoringBundleError(code, message, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', `${label} has unknown or missing fields`);
  }
}

function text(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.normalize('NFC') !== value) {
    fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', `${label} must be non-empty NFC text`);
  }
  return value as string;
}

function hexBytes(value: unknown, label: string, length?: number): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value)) {
    fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', `${label} must be non-empty lowercase even-length hex`);
  }
  const bytes = Uint8Array.from(value.match(/../g)!, pair => Number.parseInt(pair, 16));
  if (length !== undefined && bytes.length !== length) {
    fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', `${label} must be exactly ${length} bytes`);
  }
  return bytes;
}

function u64Text(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', `${label} must be canonical unsigned decimal text`);
  }
  const result = BigInt(value);
  if (result > 0xffff_ffff_ffff_ffffn) {
    fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', `${label} exceeds u64`);
  }
  return result;
}

function equal(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function includes(values: readonly Uint8Array[], value: Uint8Array): boolean {
  return values.some(candidate => equal(candidate, value));
}

function key(
  contextGraphId: string,
  subGraphName: string | null,
  visibility: 'public' | 'private',
): string {
  return `${contextGraphId}\0${subGraphName ?? ''}\0${visibility}`;
}

function canonicalBundle(value: unknown): JsonLocalAuthoringBundleV1 {
  if (!isRecord(value)) fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', 'local-authoring bundle must be an object');
  exactKeys(value, ['version', 'networkId', 'curatorAuthoritySets', 'views'], 'local-authoring bundle');
  if (value.version !== 1) fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', 'local-authoring bundle version must equal 1');
  const networkId = text(value.networkId, 'networkId')!;
  if (!Array.isArray(value.curatorAuthoritySets) || value.curatorAuthoritySets.length === 0) {
    fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', 'curatorAuthoritySets must be a non-empty array');
  }
  if (!Array.isArray(value.views) || value.views.length === 0) {
    fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', 'views must be a non-empty array');
  }
  const curatorAuthoritySets = value.curatorAuthoritySets.map((entry, index) => {
    hexBytes(entry, `curatorAuthoritySets[${index}]`);
    return entry as string;
  });
  const views = value.views.map((entry, index): JsonAuthoringViewV1 => {
    if (!isRecord(entry)) fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', `views[${index}] must be an object`);
    const legacyKeys = [
      'contextGraphId', 'subGraphName', 'writerEpoch',
      'membershipCheckpoints', 'policyWalObject', 'policyCheckpoint',
    ];
    const visibilityKeys = [...legacyKeys, 'visibility', 'keyEpoch'];
    const actualKeys = Object.keys(entry).sort();
    const matches = (expected: readonly string[]) => {
      const sorted = [...expected].sort();
      return actualKeys.length === sorted.length
        && actualKeys.every((value, keyIndex) => value === sorted[keyIndex]);
    };
    if (!matches(legacyKeys) && !matches(visibilityKeys)) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', `views[${index}] has unknown or missing fields`);
    }
    const contextGraphId = text(entry.contextGraphId, `views[${index}].contextGraphId`)!;
    const subGraphName = text(entry.subGraphName, `views[${index}].subGraphName`, true);
    const visibility = entry.visibility === undefined
      ? 'public'
      : entry.visibility === 'public' || entry.visibility === 'private'
        ? entry.visibility
        : fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', `views[${index}].visibility is invalid`);
    const keyEpoch = entry.keyEpoch === undefined || entry.keyEpoch === null
      ? null
      : text(entry.keyEpoch, `views[${index}].keyEpoch`)!;
    if (visibility === 'private' && keyEpoch === null) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', `views[${index}] private visibility requires keyEpoch`);
    }
    if (visibility === 'public' && keyEpoch !== null) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', `views[${index}] public visibility forbids keyEpoch`);
    }
    if (keyEpoch !== null) u64Text(keyEpoch, `views[${index}].keyEpoch`);
    u64Text(entry.writerEpoch, `views[${index}].writerEpoch`);
    if (!Array.isArray(entry.membershipCheckpoints) || entry.membershipCheckpoints.length === 0) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', `views[${index}].membershipCheckpoints must be non-empty`);
    }
    const membershipCheckpoints = entry.membershipCheckpoints.map((checkpoint, checkpointIndex) => {
      hexBytes(checkpoint, `views[${index}].membershipCheckpoints[${checkpointIndex}]`);
      return checkpoint as string;
    });
    hexBytes(entry.policyWalObject, `views[${index}].policyWalObject`);
    hexBytes(entry.policyCheckpoint, `views[${index}].policyCheckpoint`);
    return {
      contextGraphId,
      subGraphName,
      visibility,
      keyEpoch,
      writerEpoch: entry.writerEpoch as string,
      membershipCheckpoints,
      policyWalObject: entry.policyWalObject as string,
      policyCheckpoint: entry.policyCheckpoint as string,
    };
  });
  return { version: 1, networkId, curatorAuthoritySets, views };
}

function verifyAuthorityChain(
  encoded: readonly string[],
  expectedNetworkId: string,
  expectedGenesisId: Uint8Array,
  nowMs: number,
): Map<string, ProtocolTuple<'AuthoritySetV1'>> {
  const authorities = new Map<string, ProtocolTuple<'AuthoritySetV1'>>();
  let previous: { id: Uint8Array; tuple: ProtocolTuple<'AuthoritySetV1'> } | null = null;
  for (let index = 0; index < encoded.length; index += 1) {
    let tuple: ProtocolTuple<'AuthoritySetV1'>;
    try {
      tuple = decodeProtocolTuple('AuthoritySetV1', hexBytes(encoded[index], `curatorAuthoritySets[${index}]`));
    } catch (error) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', `curator authority ${index} is not canonical`, error);
    }
    const id = protocolTupleId('AuthoritySetV1', tuple);
    if (tuple[1] !== CURATOR_SCOPE || tuple[2] !== expectedNetworkId || tuple[9].length !== 0) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED', `curator authority ${index} has the wrong scope or network`);
    }
    if (tuple[4] <= 0n || tuple[4] > BigInt(tuple[5].length)) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED', `curator authority ${index} has an unattainable threshold`);
    }
    try {
      if (previous === null) {
        if (!equal(id, expectedGenesisId) || tuple[3] !== 0n || tuple[8] !== null) {
          fail('WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED', 'curator genesis does not match the configured trust anchor');
        }
        verifyThresholdSignedProtocolTuple('AuthoritySetV1', tuple, {
          signerAddresses: tuple[5], threshold: tuple[4],
        });
      } else {
        if (tuple[3] !== previous.tuple[3] + 1n || !equal(tuple[8], previous.id)) {
          fail('WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED', `curator authority ${index} does not extend its predecessor`);
        }
        verifyThresholdSignedProtocolTuple('AuthoritySetV1', tuple, {
          signerAddresses: previous.tuple[5], threshold: previous.tuple[4],
        });
      }
    } catch (error) {
      if (error instanceof DkgWalLocalAuthoringBundleError) throw error;
      fail('WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED', `curator authority ${index} signature is invalid`, error);
    }
    authorities.set(Buffer.from(id).toString('hex'), tuple);
    previous = { id, tuple };
  }
  const current = previous!.tuple;
  if (BigInt(nowMs + CLOCK_SKEW_MS) < current[6] || BigInt(nowMs - CLOCK_SKEW_MS) > current[7]) {
    fail('WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED', 'current curator authority is outside its validity window');
  }
  return authorities;
}

function verifyMembershipChain(
  encoded: readonly string[],
  collectionId: Uint8Array,
  authorities: ReadonlyMap<string, ProtocolTuple<'AuthoritySetV1'>>,
  nowMs: number,
): ProtocolTuple<'MembershipCheckpointV1'> {
  let previous: { id: Uint8Array; tuple: ProtocolTuple<'MembershipCheckpointV1'> } | null = null;
  for (let index = 0; index < encoded.length; index += 1) {
    let tuple: ProtocolTuple<'MembershipCheckpointV1'>;
    try {
      tuple = decodeProtocolTuple('MembershipCheckpointV1', hexBytes(encoded[index], `membershipCheckpoints[${index}]`));
    } catch (error) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', `membership checkpoint ${index} is not canonical`, error);
    }
    const id = protocolTupleId('MembershipCheckpointV1', tuple);
    const authority = authorities.get(Buffer.from(tuple[12]).toString('hex'));
    if (!equal(tuple[1], collectionId) || authority === undefined) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED', `membership checkpoint ${index} has the wrong collection or authority`);
    }
    if (tuple[5].some(writer => includes(authority[5], writer))) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED', 'curator authority signer cannot be a content writer');
    }
    if (BigInt(nowMs + CLOCK_SKEW_MS) < tuple[11]) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED', `membership checkpoint ${index} was issued in the future`);
    }
    if (previous === null) {
      if (tuple[2] !== 0n || tuple[10] !== null) {
        fail('WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED', 'membership genesis must start at checkpoint zero');
      }
    } else if (
      tuple[2] !== previous.tuple[2] + 1n
      || tuple[3] < previous.tuple[3]
      || !equal(tuple[10], previous.id)
    ) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED', `membership checkpoint ${index} does not extend its predecessor`);
    }
    try {
      verifyThresholdSignedProtocolTuple('MembershipCheckpointV1', tuple, {
        signerAddresses: authority[5], threshold: authority[4],
      });
    } catch (error) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED', `membership checkpoint ${index} signature is invalid`, error);
    }
    previous = { id, tuple };
  }
  return previous!.tuple;
}

async function installPolicyObject(
  objectStore: PackedWalObjectStore,
  controlStore: WalControlStore,
  policyObjectBytes: Uint8Array,
  policyCheckpointBytes: Uint8Array,
  writerEpoch: bigint,
  nowMs: number,
): Promise<ReturnType<typeof verifyWalObjectV1>> {
  let verified: ReturnType<typeof verifyWalObjectV1>;
  let checkpoint: ProtocolTuple<'AuthorCheckpointV1'>;
  try {
    verified = verifyWalObjectV1(policyObjectBytes);
    checkpoint = decodeProtocolTuple('AuthorCheckpointV1', policyCheckpointBytes);
    verifySingleSignedProtocolTuple('AuthorCheckpointV1', checkpoint);
  } catch (error) {
    fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', 'policy object or checkpoint is not canonical and signed', error);
  }
  const checkpointId = protocolTupleId('AuthorCheckpointV1', checkpoint);
  const commitment = new MutableSetCommitment([walObjectId(verified.walObjectId)]);
  if (
    verified.tuple[3] !== writerEpoch
    || verified.tuple[4] !== 0n
    || verified.tuple[5] !== null
    || !equal(checkpoint[1], verified.tuple[1])
    || !equal(checkpoint[2], verified.writerId)
    || checkpoint[3] !== writerEpoch
    || checkpoint[4] !== 0n
    || !equal(checkpoint[6], commitment.root)
    || checkpoint[7] !== 1n
    || checkpoint[8] !== 0n
    || checkpoint[9] !== null
    || checkpoint[10] !== null
    || checkpoint[11] !== 0n
  ) {
    fail('WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED', 'policy checkpoint does not bind the exact genesis policy object');
  }
  await objectStore.put(walObjectId(verified.walObjectId), (async function* () {
    yield policyObjectBytes;
  })());
  await controlStore.finalizeLocal({
    objectId: verified.walObjectId,
    object: verified.tuple,
    canonicalLength: policyObjectBytes.length,
    requestDigest: verified.walObjectId,
    idempotencyKey: `signed-rdf-policy:${Buffer.from(verified.walObjectId).toString('hex')}`,
    checkpointId,
    checkpointBytes: policyCheckpointBytes,
    policyObjectId: null,
    createdAtMs: nowMs,
  });
  return verified;
}

export class SignedDkgWalLocalAuthoringResolverV1 implements DkgWalPublisherCommitContextResolverV1 {
  private constructor(
    private readonly views: ReadonlyMap<string, AdmittedAuthoringViewV1>,
    private readonly resolvePrivatePayload?: DkgWalPrivatePayloadResolverV1,
  ) {}

  static async load(options: LoadDkgWalLocalAuthoringBundleOptionsV1): Promise<SignedDkgWalLocalAuthoringResolverV1> {
    if (!options?.objectStore || !options.controlStore) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', 'local-authoring bundle requires live WAL stores');
    }
    const nowMs = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', 'local-authoring clock must return a non-negative safe integer');
    }
    let raw: Uint8Array;
    try {
      const details = await lstat(options.bundlePath);
      if (!details.isFile() || details.isSymbolicLink() || details.size < 1 || details.size > MAXIMUM_BUNDLE_BYTES) {
        fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', 'local-authoring bundle must be a bounded regular file');
      }
      raw = await readFile(options.bundlePath);
    } catch (error) {
      if (error instanceof DkgWalLocalAuthoringBundleError) throw error;
      fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', 'failed to read local-authoring bundle', error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch (error) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', 'local-authoring bundle is not canonical UTF-8 JSON', error);
    }
    const bundle = canonicalBundle(parsed);
    if (bundle.networkId !== options.expectedNetworkId) {
      fail('WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED', 'local-authoring bundle belongs to another network');
    }
    const expectedGenesisId = hexBytes(
      options.expectedCuratorAuthoritySetId,
      'expectedCuratorAuthoritySetId',
      32,
    );
    const authorities = verifyAuthorityChain(
      bundle.curatorAuthoritySets,
      options.expectedNetworkId,
      expectedGenesisId,
      nowMs,
    );
    const views = new Map<string, AdmittedAuthoringViewV1>();
    for (let index = 0; index < bundle.views.length; index += 1) {
      const entry = bundle.views[index]!;
      const viewKey = key(entry.contextGraphId, entry.subGraphName, entry.visibility);
      if (views.has(viewKey)) {
        fail('WAL_LOCAL_AUTHORING_BUNDLE_INVALID', `duplicate local-authoring view ${viewKey}`);
      }
      const visibility = entry.visibility === 'private' ? PRIVATE_VISIBILITY : PUBLIC_VISIBILITY;
      const keyEpoch = entry.keyEpoch === null
        ? null
        : u64Text(entry.keyEpoch, `views[${index}].keyEpoch`);
      const collectionId = collectionIdV1([
        options.expectedNetworkId,
        entry.contextGraphId,
        entry.subGraphName,
        visibility,
      ]);
      const membership = verifyMembershipChain(
        entry.membershipCheckpoints,
        collectionId,
        authorities,
        nowMs,
      );
      const targetNamespaceId = namespaceIdV1([
        options.expectedNetworkId,
        entry.contextGraphId,
        entry.subGraphName,
        SWM_TIER,
        visibility,
        membership[3],
        keyEpoch,
      ]);
      if (!includes(membership[8], targetNamespaceId)) {
        fail('WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED', 'membership omits the exact SWM authoring view');
      }
      const writerEpoch = u64Text(entry.writerEpoch, `views[${index}].writerEpoch`);
      const policyObjectBytes = hexBytes(entry.policyWalObject, `views[${index}].policyWalObject`);
      const policyCheckpointBytes = hexBytes(entry.policyCheckpoint, `views[${index}].policyCheckpoint`);
      const verifiedPolicy = await installPolicyObject(
        options.objectStore,
        options.controlStore,
        policyObjectBytes,
        policyCheckpointBytes,
        writerEpoch,
        nowMs,
      );
      const authority = authorities.get(Buffer.from(membership[12]).toString('hex'))!;
      const admission = admitSignedRdfPolicyV1({
        currentMembershipCheckpoint: membership,
        expectedMembershipCheckpointId: protocolTupleId('MembershipCheckpointV1', membership),
        expectedAuthoritySetId: membership[12],
        membershipAuthority: { signerAddresses: authority[5], threshold: authority[4] },
        canonicalWalObjectBytes: policyObjectBytes,
        targetNamespaceId,
        expectedPolicyNamespaceId: verifiedPolicy.tuple[1],
      });
      views.set(viewKey, {
        contextGraphId: entry.contextGraphId,
        subGraphName: entry.subGraphName,
        visibility: entry.visibility,
        keyEpoch,
        writerEpoch,
        membership,
        admission,
      });
    }
    return new SignedDkgWalLocalAuthoringResolverV1(views, options.resolvePrivatePayload);
  }

  async resolve(
    mutation: PublisherWalShadowMutationV1,
    writerId: Uint8Array,
  ): Promise<DkgWalPublisherCommitContextV1> {
    const subGraphName = mutation.subGraphName ?? null;
    const candidates = mutation.visibility === undefined
      ? (['public', 'private'] as const).flatMap(visibility => {
          const candidate = this.views.get(key(mutation.contextGraphId, subGraphName, visibility));
          return candidate === undefined ? [] : [candidate];
        })
      : [this.views.get(key(mutation.contextGraphId, subGraphName, mutation.visibility))]
          .filter((candidate): candidate is AdmittedAuthoringViewV1 => candidate !== undefined);
    if (candidates.length > 1) {
      fail(
        'WAL_LOCAL_AUTHORING_VIEW_UNAVAILABLE',
        `WAL mutation visibility is required for ambiguous view ${mutation.contextGraphId}/${subGraphName ?? ''}`,
      );
    }
    const exact = candidates[0];
    if (!exact) {
      fail(
        'WAL_LOCAL_AUTHORING_VIEW_UNAVAILABLE',
        `no signed WAL local-authoring view for ${mutation.contextGraphId}/${subGraphName ?? ''}`,
      );
    }
    if (!includes(exact.membership[5], writerId)) {
      fail('WAL_LOCAL_AUTHORING_WRITER_UNAUTHORIZED', 'WAL mutation signer is not in current signed membership');
    }
    let privatePayload: Awaited<ReturnType<DkgWalPrivatePayloadResolverV1>> | undefined;
    if (exact.visibility === 'private') {
      if (!this.resolvePrivatePayload || exact.keyEpoch === null) {
        fail(
          'WAL_LOCAL_AUTHORING_VIEW_UNAVAILABLE',
          'private WAL local authoring requires the current Sender Key epoch resolver',
        );
      }
      privatePayload = await this.resolvePrivatePayload({
        mutation,
        writerId,
        expectedKeyEpoch: exact.keyEpoch,
      });
      if (privatePayload.keyEpoch !== exact.keyEpoch) {
        fail(
          'WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED',
          'current Sender Key epoch does not match the signed private WAL view',
        );
      }
    }
    return {
      policyAdmission: exact.admission,
      writerEpoch: exact.writerEpoch,
      memberWriterIds: exact.membership[5],
      visibility: exact.visibility,
      ...(privatePayload === undefined ? {} : { privatePayload }),
    };
  }
}

export async function loadSignedDkgWalLocalAuthoringResolverV1(
  options: LoadDkgWalLocalAuthoringBundleOptionsV1,
): Promise<SignedDkgWalLocalAuthoringResolverV1> {
  return SignedDkgWalLocalAuthoringResolverV1.load(options);
}
