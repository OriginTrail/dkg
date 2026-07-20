import Database from 'better-sqlite3';
import { mkdtemp, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WalAuthorityError,
  WalAuthorityLifecycle,
  WalAuthorityPersistence,
  type DkgWalAuthorityAdapter,
  type RollbackCohortMinimum,
  type WalAuthorityLifecycleOptions,
  type WalAuthorityView,
} from '../../src/authority/index.js';
import { WalControlStore } from '../../src/control/index.js';
import { encodeProtocolTuple } from '../../src/protocol/codec.js';
import { collectionIdV1, namespaceIdV1, protocolTupleId } from '../../src/protocol/hashes.js';
import type { CborProtocolValue, ProtocolTuple } from '../../src/protocol/schema.js';
import {
  recoverEip191Address,
  signEip191DigestWithPrivateKey,
  signSingleProtocolTuple,
  signThresholdProtocolTuple,
  type WalEip191Signer,
} from '../../src/protocol/signatures.js';
import { hashBytes } from '../../src/reconciliation/hash.js';
import { MutableSetCommitment } from '../../src/reconciliation/set-commitment.js';
import { PackedWalObjectStore } from '../../src/store/packed-store.js';

const roots: string[] = [];
const packedStores: PackedWalObjectStore[] = [];
const controls: WalControlStore[] = [];
const lifecycles: WalAuthorityLifecycle[] = [];

afterEach(async () => {
  for (const lifecycle of lifecycles.splice(0)) lifecycle.close();
  for (const control of controls.splice(0)) control.close();
  for (const packed of packedStores.splice(0)) packed.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function bytes(label: string): Uint8Array {
  return hashBytes(new TextEncoder().encode(`wal-authority-test-v1\0${label}`));
}

function key(value: number): Uint8Array {
  const output = new Uint8Array(32);
  output[31] = value;
  return output;
}

function signer(privateKey: Uint8Array): WalEip191Signer & { address: Uint8Array } {
  const digest = new Uint8Array(32);
  const address = recoverEip191Address(digest, signEip191DigestWithPrivateKey(digest, privateKey));
  return {
    address,
    signMessage: value => signEip191DigestWithPrivateKey(value, privateKey),
  };
}

const curatorA = signer(key(1));
const curatorB = signer(key(2));
const writerA = signer(key(3));
const writerB = signer(key(4));
const member = signer(key(5));
const networkA = signer(key(6));
const networkB = signer(key(7));

function sorted(values: readonly Uint8Array[]): Uint8Array[] {
  return values.map(value => new Uint8Array(value)).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

async function temporary(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dkg-wal-authority-${label}-`));
  roots.push(root);
  return root;
}

function packed(root: string): PackedWalObjectStore {
  const value = new PackedWalObjectStore({ root });
  packedStores.push(value);
  return value;
}

function control(root: string): WalControlStore {
  const value = new WalControlStore({ root });
  controls.push(value);
  return value;
}

function closeControl(value: WalControlStore): void {
  value.close();
  controls.splice(controls.indexOf(value), 1);
}

function closeLifecycle(value: WalAuthorityLifecycle): void {
  value.close();
  lifecycles.splice(lifecycles.indexOf(value), 1);
}

interface AdapterState {
  membership: boolean;
  openAuthor: boolean;
  snapshot: boolean;
  privateDisclosure: boolean;
  policyAdmitted: boolean;
  calls: string[];
}

function adapter(state: AdapterState): DkgWalAuthorityAdapter {
  return {
    validateMembership: input => {
      state.calls.push(`membership:${Buffer.from(input.membershipCheckpointId).toString('hex')}`);
      return state.membership;
    },
    validateOpenAuthor: input => {
      state.calls.push(
        `open:${Buffer.from(input.writerId).toString('hex')}:frontier=${input.finalizedChainFrontier === null ? 'none' : input.finalizedChainFrontier[1]}`,
      );
      return state.openAuthor;
    },
    validateEpochSnapshot: input => {
      state.calls.push(`snapshot:${Buffer.from(input.baselineSnapshotObjectId).toString('hex')}`);
      return state.snapshot;
    },
    authorizePrivateDisclosure: input => {
      state.calls.push(`private:${Buffer.from(input.transportPeerId).toString('hex')}`);
      return state.privateDisclosure && input.delegation === 'ok';
    },
    isWalObjectAdmitted: () => state.policyAdmitted,
  };
}

function view(
  visibility: 0n | 1n = 0n,
  policyEpoch = 0n,
  keyEpoch: bigint | null = visibility === 1n ? 0n : null,
  tier: 0n | 1n = 0n,
): WalAuthorityView {
  return {
    collectionKey: ['testnet', 'cg:alpha', null, visibility],
    viewKey: ['testnet', 'cg:alpha', null, tier, visibility, policyEpoch, keyEpoch],
  };
}

async function authority(
  scope: 0n | 1n,
  epoch: bigint,
  authoritySigners: readonly (WalEip191Signer & { address: Uint8Array })[],
  signingKeys: readonly WalEip191Signer[],
  previous: Uint8Array | null,
  options: {
    notBefore?: bigint;
    expires?: bigint;
    revocations?: readonly Uint8Array[];
    networkId?: string;
    threshold?: bigint;
  } = {},
) {
  const unsigned = [
    1n,
    scope,
    options.networkId ?? 'testnet',
    epoch,
    options.threshold ?? BigInt(authoritySigners.length),
    sorted(authoritySigners.map(value => value.address)),
    options.notBefore ?? 0n,
    options.expires ?? 10_000n,
    previous,
    sorted(options.revocations ?? []),
  ] satisfies readonly CborProtocolValue[];
  const tuple = await signThresholdProtocolTuple('AuthoritySetV1', unsigned, signingKeys);
  return {
    tuple,
    bytes: encodeProtocolTuple('AuthoritySetV1', tuple),
    id: protocolTupleId('AuthoritySetV1', tuple),
  };
}

async function membership(
  targetView: WalAuthorityView,
  authorityId: Uint8Array,
  signingKeys: readonly WalEip191Signer[],
  options: {
    number?: bigint;
    policyEpoch?: bigint;
    mode?: 0n | 1n;
    writers?: readonly Uint8Array[];
    agents?: readonly Uint8Array[];
    peers?: readonly Uint8Array[];
    namespaces?: readonly Uint8Array[];
    previous?: Uint8Array | null;
    issuedAt?: bigint;
    policyId?: Uint8Array;
  } = {},
) {
  const unsigned = [
    1n,
    collectionIdV1(targetView.collectionKey),
    options.number ?? 0n,
    options.policyEpoch ?? targetView.viewKey[5],
    options.mode ?? 1n,
    sorted(options.writers ?? [writerA.address]),
    sorted(options.agents ?? [member.address]),
    sorted(options.peers ?? [Uint8Array.of(9)]),
    sorted(options.namespaces ?? [namespaceIdV1(targetView.viewKey)]),
    options.policyId ?? bytes('policy'),
    options.previous ?? null,
    options.issuedAt ?? 100n,
    authorityId,
  ] satisfies readonly CborProtocolValue[];
  const tuple = await signThresholdProtocolTuple('MembershipCheckpointV1', unsigned, signingKeys);
  return {
    tuple,
    bytes: encodeProtocolTuple('MembershipCheckpointV1', tuple),
    id: protocolTupleId('MembershipCheckpointV1', tuple),
  };
}

async function checkpoint(
  namespaceId: Uint8Array,
  author: WalEip191Signer & { address: Uint8Array },
  objectIds: readonly Uint8Array[],
  options: {
    writerEpoch?: bigint;
    number?: bigint;
    previous?: Uint8Array | null;
    baseline?: Uint8Array | null;
    floor?: bigint;
    root?: Uint8Array;
    count?: bigint;
    maxSequence?: bigint;
  } = {},
) {
  const set = new MutableSetCommitment(objectIds as never);
  const number = options.number ?? 0n;
  const unsigned = [
    1n,
    namespaceId,
    author.address,
    options.writerEpoch ?? 0n,
    number,
    1n,
    options.root ?? set.root,
    options.count ?? BigInt(objectIds.length),
    options.maxSequence ?? number,
    options.previous ?? null,
    options.baseline ?? null,
    options.floor ?? 0n,
  ] satisfies readonly CborProtocolValue[];
  const tuple = await signSingleProtocolTuple('AuthorCheckpointV1', unsigned, author);
  return {
    tuple,
    bytes: encodeProtocolTuple('AuthorCheckpointV1', tuple),
    id: protocolTupleId('AuthorCheckpointV1', tuple),
  };
}

async function vector(
  targetView: WalAuthorityView,
  membershipId: Uint8Array,
  authorityId: Uint8Array,
  signingKeys: readonly WalEip191Signer[],
  heads: readonly { writerId: Uint8Array; checkpointId: Uint8Array }[],
  options: {
    epoch?: bigint;
    number?: bigint;
    previous?: Uint8Array | null;
    issuedAt?: bigint;
    expiresAt?: bigint;
    frontier?: ProtocolTuple<'ChainFrontierV1'> | null;
    namespaces?: readonly ProtocolTuple<'ExpectedNamespaceV1'>[];
  } = {},
) {
  const namespace: ProtocolTuple<'ExpectedNamespaceV1'> = [
    namespaceIdV1(targetView.viewKey),
    heads.map(head => [head.writerId, head.checkpointId] as const)
      .sort((left, right) => Buffer.compare(Buffer.from(left[0]), Buffer.from(right[0]))),
  ];
  const unsigned = [
    1n,
    collectionIdV1(targetView.collectionKey),
    membershipId,
    options.namespaces ?? [namespace],
    options.epoch ?? 0n,
    options.number ?? 0n,
    options.previous ?? null,
    options.issuedAt ?? 100n,
    options.expiresAt ?? 1_000n,
    options.frontier ?? null,
    authorityId,
  ] satisfies readonly CborProtocolValue[];
  const tuple = await signThresholdProtocolTuple('CollectionHeadVectorV1', unsigned, signingKeys);
  return {
    tuple,
    bytes: encodeProtocolTuple('CollectionHeadVectorV1', tuple),
    id: protocolTupleId('CollectionHeadVectorV1', tuple),
  };
}

async function rollbackRecovery(
  collectionId: Uint8Array,
  authorityId: Uint8Array,
  signingKeys: readonly WalEip191Signer[],
  minimum: { epoch: bigint; number: bigint; id: Uint8Array },
) {
  const unsigned = [
    1n, 'testnet', collectionId, minimum.epoch, minimum.number, minimum.id,
    bytes('recovery-nonce'), 500n, authorityId,
  ] satisfies readonly CborProtocolValue[];
  const tuple = await signThresholdProtocolTuple('RollbackRecoveryV1', unsigned, signingKeys);
  return { tuple, bytes: encodeProtocolTuple('RollbackRecoveryV1', tuple) };
}

async function expectCode(action: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  if (typeof action === 'function') expect(action).toThrowError(expect.objectContaining({ code }));
  else await expect(action).rejects.toMatchObject({ code });
}

async function scenario(label: string, targetView = view(), stateOverrides: Partial<AdapterState> = {}) {
  const root = await temporary(label);
  packed(root);
  const rollback = control(root);
  const state: AdapterState = {
    membership: true,
    openAuthor: true,
    snapshot: true,
    privateDisclosure: true,
    policyAdmitted: true,
    calls: [],
    ...stateOverrides,
  };
  const curator = await authority(0n, 0n, [curatorA], [curatorA], null);
  const network = await authority(1n, 0n, [networkA], [networkA], null);
  const options: WalAuthorityLifecycleOptions = {
    networkId: 'testnet',
    genesisCuratorAuthoritySetId: curator.id,
    genesisNetworkAuthoritySetId: network.id,
    root,
    rollbackStore: rollback,
    adapter: adapter(state),
    now: () => 200,
  };
  const lifecycle = new WalAuthorityLifecycle(options);
  lifecycles.push(lifecycle);
  lifecycle.acceptAuthoritySet(curator.bytes, 100);
  lifecycle.acceptAuthoritySet(network.bytes, 100);
  return { root, rollback, state, lifecycle, curator, network, options, targetView };
}

describe('WAL authority lifecycle', () => {
  it('proves completeness only for the current membership vector and exact author checkpoint', async () => {
    const setup = await scenario('complete');
    const memberCheckpoint = await membership(setup.targetView, setup.curator.id, [curatorA]);
    expect((await setup.lifecycle.acceptMembershipCheckpoint(memberCheckpoint.bytes, 100)).status).toBe('stored');
    expect((await setup.lifecycle.acceptMembershipCheckpoint(memberCheckpoint.bytes, 100)).status).toBe('replay');
    const objectId = bytes('object-1');
    const authorCheckpoint = await checkpoint(namespaceIdV1(setup.targetView.viewKey), writerA, [objectId]);
    expect((await setup.lifecycle.acceptAuthorCheckpoint({
      collectionId: collectionIdV1(setup.targetView.collectionKey),
      canonicalBytes: authorCheckpoint.bytes,
      objectIds: [objectId],
      acceptedAtMs: 100,
    })).status).toBe('stored');
    expect((await setup.lifecycle.acceptAuthorCheckpoint({
      collectionId: collectionIdV1(setup.targetView.collectionKey),
      canonicalBytes: authorCheckpoint.bytes,
      objectIds: [objectId],
    })).status).toBe('replay');
    const currentVector = await vector(
      setup.targetView,
      memberCheckpoint.id,
      setup.curator.id,
      [curatorA],
      [{ writerId: writerA.address, checkpointId: authorCheckpoint.id }],
    );
    expect(setup.lifecycle.acceptCollectionVector(currentVector.bytes, 200).status).toBe('stored');
    expect(setup.lifecycle.acceptCollectionVector(currentVector.bytes, 200).status).toBe('replay');
    expect(await setup.lifecycle.evaluate(setup.targetView, 200)).toEqual(expect.objectContaining({
      status: 'complete', reason: 'COMPLETE', privateMetadataAllowed: true, missingCheckpointIds: [],
    }));

    closeLifecycle(setup.lifecycle);
    const restarted = new WalAuthorityLifecycle(setup.options);
    lifecycles.push(restarted);
    expect(await restarted.evaluate(setup.targetView, 200)).toEqual(expect.objectContaining({ status: 'complete' }));
    expect(await restarted.authorizePrivateDisclosure({
      view: setup.targetView,
      requesterAgentAddress: member.address,
      transportPeerId: Uint8Array.of(9),
      delegation: 'ok',
    }, 200)).toBe(false);
  });

  it('reports exact known-incomplete, freshness, policy, and view states', async () => {
    const setup = await scenario('statuses', view(), { policyAdmitted: false });
    expect(await setup.lifecycle.evaluate(setup.targetView, 200)).toEqual(expect.objectContaining({
      status: 'unknown-freshness', reason: 'NO_MEMBERSHIP', privateMetadataAllowed: false,
    }));
    const memberCheckpoint = await membership(setup.targetView, setup.curator.id, [curatorA]);
    await setup.lifecycle.acceptMembershipCheckpoint(memberCheckpoint.bytes, 100);
    expect(await setup.lifecycle.evaluate(setup.targetView, 200)).toEqual(expect.objectContaining({
      status: 'unknown-freshness', reason: 'NO_VECTOR',
    }));
    const missingCheckpointId = bytes('missing-checkpoint');
    const currentVector = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], [
      { writerId: writerA.address, checkpointId: missingCheckpointId },
    ]);
    setup.lifecycle.acceptCollectionVector(currentVector.bytes, 200);
    expect(await setup.lifecycle.evaluate(setup.targetView, 200)).toEqual(expect.objectContaining({
      status: 'known-incomplete', reason: 'MISSING_POLICY_OBJECT',
    }));
    setup.state.policyAdmitted = true;
    expect(await setup.lifecycle.evaluate(setup.targetView, 200)).toEqual(expect.objectContaining({
      status: 'known-incomplete',
      reason: 'MISSING_CHECKPOINTS',
      missingCheckpointIds: [missingCheckpointId],
    }));
    expect(await setup.lifecycle.evaluate(view(0n, 1n), 200)).toEqual(expect.objectContaining({
      status: 'blocked', reason: 'WRONG_VIEW', privateMetadataAllowed: false,
    }));
    expect(await setup.lifecycle.evaluate(view(0n, 0n, 1n), 200)).toEqual(expect.objectContaining({
      status: 'blocked', reason: 'WRONG_VIEW',
    }));
    expect(await setup.lifecycle.evaluate(setup.targetView, 6_001)).toEqual(expect.objectContaining({
      status: 'unknown-freshness', reason: 'VECTOR_EXPIRED', privateMetadataAllowed: false,
    }));
  });

  it('authorizes private disclosure only through current exact-view DKG membership delegation', async () => {
    const privateView = view(1n, 3n, 9n);
    const setup = await scenario('private', privateView);
    const memberCheckpoint = await membership(privateView, setup.curator.id, [curatorA]);
    await setup.lifecycle.acceptMembershipCheckpoint(memberCheckpoint.bytes, 100);
    const currentVector = await vector(privateView, memberCheckpoint.id, setup.curator.id, [curatorA], []);
    setup.lifecycle.acceptCollectionVector(currentVector.bytes, 200);
    expect(await setup.lifecycle.authorizePrivateDisclosure({
      view: privateView,
      requesterAgentAddress: member.address,
      transportPeerId: Uint8Array.of(9),
      delegation: 'ok',
    }, 200)).toBe(true);
    expect(await setup.lifecycle.authorizePrivateDisclosure({
      view: privateView,
      requesterAgentAddress: writerA.address,
      transportPeerId: Uint8Array.of(9),
      delegation: 'ok',
    }, 200)).toBe(false);
    expect(await setup.lifecycle.authorizePrivateDisclosure({
      view: setup.targetView,
      requesterAgentAddress: member.address,
      transportPeerId: Uint8Array.of(9),
      delegation: 'bad',
    }, 200)).toBe(false);
    setup.state.privateDisclosure = false;
    expect(await setup.lifecycle.authorizePrivateDisclosure({
      view: privateView,
      requesterAgentAddress: member.address,
      transportPeerId: Uint8Array.of(9),
      delegation: 'ok',
    }, 200)).toBe(false);
  });

  it('validates set extension, open authors, epoch snapshots, and curator/content separation', async () => {
    const setup = await scenario('authors');
    let memberCheckpoint = await membership(setup.targetView, setup.curator.id, [curatorA], { mode: 0n, writers: [writerA.address] });
    await setup.lifecycle.acceptMembershipCheckpoint(memberCheckpoint.bytes, 100);
    const namespace = namespaceIdV1(setup.targetView.viewKey);
    const firstId = bytes('first');
    const first = await checkpoint(namespace, writerA, [firstId]);
    await setup.lifecycle.acceptAuthorCheckpoint({
      collectionId: collectionIdV1(setup.targetView.collectionKey), canonicalBytes: first.bytes, objectIds: [firstId],
    });
    const secondId = bytes('second');
    const second = await checkpoint(namespace, writerA, [firstId, secondId], { number: 1n, previous: first.id });
    await setup.lifecycle.acceptAuthorCheckpoint({
      collectionId: collectionIdV1(setup.targetView.collectionKey), canonicalBytes: second.bytes, objectIds: [firstId, secondId],
    });
    const openId = bytes('open');
    const open = await checkpoint(namespace, writerB, [openId]);
    await setup.lifecycle.acceptAuthorCheckpoint({
      collectionId: collectionIdV1(setup.targetView.collectionKey), canonicalBytes: open.bytes, objectIds: [openId],
    });
    expect(setup.state.calls.some(call => call.startsWith('open:'))).toBe(true);

    const baseline = bytes('baseline');
    const rotated = await checkpoint(namespace, writerA, [baseline], {
      writerEpoch: 1n, baseline, floor: 2n,
    });
    await setup.lifecycle.acceptAuthorCheckpoint({
      collectionId: collectionIdV1(setup.targetView.collectionKey), canonicalBytes: rotated.bytes, objectIds: [baseline],
    });
    expect(setup.state.calls.some(call => call.startsWith('snapshot:'))).toBe(true);

    const vectorWithoutOpen = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], [
      { writerId: writerA.address, checkpointId: rotated.id },
    ], { frontier: [1n, 123n, bytes('frontier-block')] });
    setup.lifecycle.acceptCollectionVector(vectorWithoutOpen.bytes, 200);
    expect(await setup.lifecycle.evaluate(setup.targetView, 200)).toEqual(expect.objectContaining({
      status: 'known-incomplete', reason: 'VECTOR_MEMBERSHIP_MISMATCH',
    }));
    const postVectorOpenId = bytes('post-vector-open');
    const postVectorOpen = await checkpoint(namespace, member, [postVectorOpenId]);
    await setup.lifecycle.acceptAuthorCheckpoint({
      collectionId: collectionIdV1(setup.targetView.collectionKey),
      canonicalBytes: postVectorOpen.bytes,
      objectIds: [postVectorOpenId],
    });
    expect(setup.state.calls).toContain(`open:${Buffer.from(member.address).toString('hex')}:frontier=123`);

    memberCheckpoint = await membership(setup.targetView, setup.curator.id, [curatorA], {
      number: 1n, previous: memberCheckpoint.id, mode: 1n, writers: [curatorA.address],
    });
    await expectCode(setup.lifecycle.acceptMembershipCheckpoint(memberCheckpoint.bytes, 200), 'WAL_AUTHORITY_UNAUTHORIZED');
  });

  it('persists author, vector, and authority forks as blocking evidence', async () => {
    const setup = await scenario('forks');
    const memberCheckpoint = await membership(setup.targetView, setup.curator.id, [curatorA]);
    await setup.lifecycle.acceptMembershipCheckpoint(memberCheckpoint.bytes, 100);
    const namespace = namespaceIdV1(setup.targetView.viewKey);
    const firstId = bytes('fork-object-a');
    const first = await checkpoint(namespace, writerA, [firstId]);
    await setup.lifecycle.acceptAuthorCheckpoint({
      collectionId: collectionIdV1(setup.targetView.collectionKey), canonicalBytes: first.bytes, objectIds: [firstId],
    });
    const otherId = bytes('fork-object-b');
    const fork = await checkpoint(namespace, writerA, [otherId]);
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId: collectionIdV1(setup.targetView.collectionKey), canonicalBytes: fork.bytes, objectIds: [otherId],
    }), 'WAL_AUTHORITY_FORK');
    const currentVector = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], [
      { writerId: writerA.address, checkpointId: first.id },
    ]);
    setup.lifecycle.acceptCollectionVector(currentVector.bytes, 200);
    expect(await setup.lifecycle.evaluate(setup.targetView, 200)).toEqual(expect.objectContaining({
      status: 'blocked', reason: 'CHECKPOINT_EQUIVOCATION',
    }));

    const vectorFork = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], [], {
      epoch: 0n, number: 0n,
    });
    await expectCode(() => setup.lifecycle.acceptCollectionVector(vectorFork.bytes, 200), 'WAL_AUTHORITY_FORK');
    await expectCode(() => setup.lifecycle.acceptCollectionVector(currentVector.bytes, 200), 'WAL_AUTHORITY_BLOCKED');
    expect(await setup.lifecycle.evaluate(setup.targetView, 200)).toEqual(expect.objectContaining({
      status: 'blocked', reason: 'VECTOR_FORK',
    }));

    const curatorFork = await authority(0n, 0n, [curatorB], [curatorA], null);
    await expectCode(() => setup.lifecycle.acceptAuthoritySet(curatorFork.bytes, 200), 'WAL_AUTHORITY_FORK');
    const membershipAfterAuthorityFork = await membership(setup.targetView, setup.curator.id, [curatorA], {
      number: 1n, previous: memberCheckpoint.id,
    });
    await expectCode(
      setup.lifecycle.acceptMembershipCheckpoint(membershipAfterAuthorityFork.bytes, 200),
      'WAL_AUTHORITY_BLOCKED',
    );
    expect(await setup.lifecycle.evaluate(setup.targetView, 200)).toEqual(expect.objectContaining({
      status: 'blocked', reason: 'AUTHORITY_FORK',
    }));
  });

  it('supports threshold HA rotation, linked vector epochs, and emergency revocation', async () => {
    const setup = await scenario('rotation');
    const memberCheckpoint = await membership(setup.targetView, setup.curator.id, [curatorA]);
    await setup.lifecycle.acceptMembershipCheckpoint(memberCheckpoint.bytes, 100);
    const firstVector = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], []);
    setup.lifecycle.acceptCollectionVector(firstVector.bytes, 200);

    const rotatedCurator = await authority(0n, 1n, [curatorB, member], [curatorA], setup.curator.id);
    setup.lifecycle.acceptAuthoritySet(rotatedCurator.bytes, 300);
    const nextMembership = await membership(setup.targetView, rotatedCurator.id, [curatorB, member], {
      number: 1n, previous: memberCheckpoint.id,
    });
    await setup.lifecycle.acceptMembershipCheckpoint(nextMembership.bytes, 300);
    const rotatedVector = await vector(setup.targetView, nextMembership.id, rotatedCurator.id, [curatorB, member], [], {
      epoch: 1n, number: 0n, previous: firstVector.id, issuedAt: 300n, expiresAt: 900n,
    });
    setup.lifecycle.acceptCollectionVector(rotatedVector.bytes, 300);
    expect(await setup.lifecycle.evaluate(setup.targetView, 300)).toEqual(expect.objectContaining({ status: 'complete' }));

    const rotatedNetwork = await authority(1n, 1n, [networkB], [networkA], setup.network.id, {
      revocations: [rotatedCurator.id],
    });
    setup.lifecycle.acceptAuthoritySet(rotatedNetwork.bytes, 400);
    expect(await setup.lifecycle.evaluate(setup.targetView, 400)).toEqual(expect.objectContaining({
      status: 'unknown-freshness', reason: 'AUTHORITY_REVOKED',
    }));
    const revokedMembership = await membership(setup.targetView, rotatedCurator.id, [curatorB, member], {
      number: 2n, previous: nextMembership.id,
    });
    await expectCode(setup.lifecycle.acceptMembershipCheckpoint(revokedMembership.bytes, 400), 'WAL_AUTHORITY_UNAUTHORIZED');
  });

  it('recovers a lost rollback guard only from threshold-valid cohort-bounded evidence', async () => {
    const setup = await scenario('recovery');
    const collectionId = collectionIdV1(setup.targetView.collectionKey);
    setup.rollback.setRollbackHighWater({
      collectionId, vectorEpoch: 2n, vectorNumber: 4n, vectorId: bytes('high-water'), updatedAtMs: 200,
    });
    closeLifecycle(setup.lifecycle);
    closeControl(setup.rollback);
    await unlink(join(setup.root, 'rollback-high-water.sqlite'));
    const blockedControl = control(setup.root);
    expect(blockedControl.rollbackProtectionStatus()).toEqual({ state: 'blocked', reason: 'rollback-high-water-missing' });
    const recoveredLifecycle = new WalAuthorityLifecycle({ ...setup.options, rollbackStore: blockedControl });
    lifecycles.push(recoveredLifecycle);
    const minimum: RollbackCohortMinimum = {
      collectionId, vectorEpoch: 2n, vectorNumber: 4n, vectorId: bytes('high-water'),
    };
    const recovery = await rollbackRecovery(collectionId, setup.network.id, [networkA], {
      epoch: 2n, number: 4n, id: minimum.vectorId,
    });
    expect(recoveredLifecycle.installRollbackRecovery(recovery.bytes, minimum, 500)).toHaveLength(32);
    expect(blockedControl.rollbackProtectionStatus()).toEqual({ state: 'available' });
    expect(blockedControl.getRollbackHighWater(collectionId)).toEqual(expect.objectContaining({
      vectorEpoch: 2n, vectorNumber: 4n, vectorId: minimum.vectorId,
    }));
  });
});

describe('WAL authority fail-closed validation', () => {
  it('rejects invalid lifecycle configuration and persistence substitution', async () => {
    const root = await temporary('configuration');
    packed(root);
    const rollback = control(root);
    const genesis = await authority(0n, 0n, [curatorA], [curatorA], null);
    const network = await authority(1n, 0n, [networkA], [networkA], null);
    const base = {
      networkId: 'testnet', genesisCuratorAuthoritySetId: genesis.id,
      genesisNetworkAuthoritySetId: network.id, root, rollbackStore: rollback,
      adapter: adapter({ membership: true, openAuthor: true, snapshot: true, privateDisclosure: true, policyAdmitted: true, calls: [] }),
    };
    for (const options of [
      undefined,
      { ...base, networkId: '' },
      { ...base, genesisCuratorAuthoritySetId: Uint8Array.of(1) },
      { ...base, rollbackStore: undefined },
      { ...base, clockSkewMs: -1 },
      { ...base, maximumAuthorsPerVector: 0 },
    ]) await expectCode(() => new WalAuthorityLifecycle(options as never), 'WAL_AUTHORITY_INVALID');
    await expectCode(() => new WalAuthorityPersistence('relative'), 'WAL_AUTHORITY_INVALID');
    const fakeRoot = await temporary('persistence-missing');
    await expectCode(() => new WalAuthorityPersistence(fakeRoot), 'WAL_AUTHORITY_IO');

    closeControl(rollback);
    await unlink(join(root, 'objects.sqlite'));
    await symlink('/dev/null', join(root, 'objects.sqlite'));
    await expectCode(() => new WalAuthorityPersistence(root), 'WAL_AUTHORITY_INVALID');
  });

  it('covers default-time construction, missing authority, canonical time bounds, and durable ID corruption', async () => {
    const uninitializedRoot = await temporary('authority-uninitialized');
    packed(uninitializedRoot);
    const uninitializedControl = control(uninitializedRoot);
    const curator = await authority(0n, 0n, [curatorA], [curatorA], null);
    const network = await authority(1n, 0n, [networkA], [networkA], null);
    const lifecycleWithoutClock = new WalAuthorityLifecycle({
      networkId: 'testnet',
      genesisCuratorAuthoritySetId: curator.id,
      genesisNetworkAuthoritySetId: network.id,
      root: uninitializedRoot,
      rollbackStore: uninitializedControl,
      adapter: adapter({
        membership: true, openAuthor: true, snapshot: true,
        privateDisclosure: true, policyAdmitted: true, calls: [],
      }),
    });
    lifecycles.push(lifecycleWithoutClock);
    expect(lifecycleWithoutClock.currentNetworkAuthority(100)).toBeNull();
    expect(lifecycleWithoutClock.acceptAuthorityEvidence(network.bytes, 100)).toBeUndefined();
    expect(lifecycleWithoutClock.currentNetworkAuthority(100)).toEqual(network.tuple);
    expect(lifecycleWithoutClock.acceptAuthorityEvidence(network.bytes, 100)).toBeUndefined();
    await expectCode(() => lifecycleWithoutClock.currentNetworkAuthority(-1), 'WAL_AUTHORITY_INVALID');
    const noAuthorityMembership = await membership(view(), curator.id, [curatorA]);
    await expectCode(
      lifecycleWithoutClock.acceptMembershipCheckpoint(noAuthorityMembership.bytes, 100),
      'WAL_AUTHORITY_UNAUTHORIZED',
    );

    const setup = await scenario('authority-canonical-boundaries');
    const nullLinkedRotation = await authority(0n, 1n, [curatorB], [curatorA], null);
    await expectCode(() => setup.lifecycle.acceptAuthoritySet(nullLinkedRotation.bytes, 200), 'WAL_AUTHORITY_ROLLBACK');
    const emptyInterval = await authority(0n, 1n, [curatorB], [curatorA], setup.curator.id, {
      notBefore: 100n, expires: 100n,
    });
    await expectCode(() => setup.lifecycle.acceptAuthoritySet(emptyInterval.bytes, 100), 'WAL_AUTHORITY_INVALID');
    const unsafeTime = await authority(0n, 1n, [curatorB], [curatorA], setup.curator.id, {
      expires: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    });
    await expectCode(() => setup.lifecycle.acceptAuthoritySet(unsafeTime.bytes, 100), 'WAL_AUTHORITY_INVALID');

    const currentMembership = await membership(setup.targetView, setup.curator.id, [curatorA]);
    await setup.lifecycle.acceptMembershipCheckpoint(currentMembership.bytes, 100);
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId: collectionIdV1(setup.targetView.collectionKey),
      canonicalBytes: Uint8Array.of(0),
      objectIds: [],
    }), 'WAL_AUTHORITY_INVALID');

    const replacementBytes = (await authority(0n, 0n, [curatorA], [curatorA], null, { expires: 9_000n })).bytes;
    const database = (setup.lifecycle.persistence as unknown as { database: Database.Database }).database;
    database.prepare('UPDATE authority_sets SET canonical_bytes = ? WHERE authority_set_id = ?')
      .run(replacementBytes, setup.curator.id);
    const nextMembership = await membership(setup.targetView, setup.curator.id, [curatorA], {
      number: 1n, previous: currentMembership.id,
    });
    await expectCode(setup.lifecycle.acceptMembershipCheckpoint(nextMembership.bytes, 200), 'WAL_AUTHORITY_BLOCKED');
  });

  it('rejects untrusted, stale, expired, unlinked, and malformed authority sets', async () => {
    const setup = await scenario('authority-invalid');
    const untrusted = await authority(0n, 1n, [curatorB], [curatorB], setup.curator.id);
    await expectCode(() => setup.lifecycle.acceptAuthoritySet(untrusted.bytes, 200), 'WAL_AUTHORITY_UNAUTHORIZED');
    const skipped = await authority(0n, 2n, [curatorB], [curatorA], setup.curator.id);
    await expectCode(() => setup.lifecycle.acceptAuthoritySet(skipped.bytes, 200), 'WAL_AUTHORITY_ROLLBACK');
    const future = await authority(0n, 1n, [curatorB], [curatorA], setup.curator.id, { notBefore: 8_000n });
    await expectCode(() => setup.lifecycle.acceptAuthoritySet(future.bytes, 200), 'WAL_AUTHORITY_STALE');
    const expired = await authority(0n, 1n, [curatorB], [curatorA], setup.curator.id, { expires: 100n });
    await expectCode(() => setup.lifecycle.acceptAuthoritySet(expired.bytes, 6_000), 'WAL_AUTHORITY_EXPIRED');
    const wrongNetwork = await authority(0n, 1n, [curatorB], [curatorA], setup.curator.id, { networkId: 'other' });
    await expectCode(() => setup.lifecycle.acceptAuthoritySet(wrongNetwork.bytes, 200), 'WAL_AUTHORITY_WRONG_VIEW');
    await expectCode(() => setup.lifecycle.acceptAuthoritySet(Uint8Array.of(0), 200), 'WAL_AUTHORITY_INVALID');
  });

  it('rejects invalid membership, checkpoint, vector, and recovery transitions', async () => {
    const setup = await scenario('transition-invalid', view(), { membership: false, openAuthor: false, snapshot: false });
    let memberCheckpoint = await membership(setup.targetView, setup.curator.id, [curatorA]);
    await expectCode(setup.lifecycle.acceptMembershipCheckpoint(memberCheckpoint.bytes, 100), 'WAL_AUTHORITY_UNAUTHORIZED');
    setup.state.membership = true;
    await setup.lifecycle.acceptMembershipCheckpoint(memberCheckpoint.bytes, 100);
    const wrongWriter = await membership(setup.targetView, setup.curator.id, [curatorA], {
      number: 1n, previous: memberCheckpoint.id, writers: [writerA.address], issuedAt: 10_000n,
    });
    await expectCode(setup.lifecycle.acceptMembershipCheckpoint(wrongWriter.bytes, 100), 'WAL_AUTHORITY_STALE');

    const namespace = namespaceIdV1(setup.targetView.viewKey);
    const open = await checkpoint(namespace, writerB, [bytes('unauthorized-open')]);
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId: collectionIdV1(setup.targetView.collectionKey), canonicalBytes: open.bytes,
      objectIds: [bytes('unauthorized-open')],
    }), 'WAL_AUTHORITY_UNAUTHORIZED');
    const badRoot = await checkpoint(namespace, writerA, [bytes('root')], { root: bytes('wrong-root') });
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId: collectionIdV1(setup.targetView.collectionKey), canonicalBytes: badRoot.bytes,
      objectIds: [bytes('root')],
    }), 'WAL_AUTHORITY_INVALID');

    const badVector = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], [], {
      number: 1n,
    });
    await expectCode(() => setup.lifecycle.acceptCollectionVector(badVector.bytes, 200), 'WAL_AUTHORITY_ROLLBACK');

    const minimum: RollbackCohortMinimum = {
      collectionId: collectionIdV1(setup.targetView.collectionKey),
      vectorEpoch: 1n, vectorNumber: 1n, vectorId: bytes('cohort'),
    };
    const recovery = await rollbackRecovery(minimum.collectionId, setup.network.id, [networkA], {
      epoch: 0n, number: 0n, id: bytes('lower'),
    });
    await expectCode(() => setup.lifecycle.installRollbackRecovery(recovery.bytes, minimum, 500), 'WAL_AUTHORITY_ROLLBACK');
    const lowerNumberSameEpoch = await rollbackRecovery(minimum.collectionId, setup.network.id, [networkA], {
      epoch: 1n, number: 0n, id: bytes('lower-same-epoch'),
    });
    await expectCode(
      () => setup.lifecycle.installRollbackRecovery(lowerNumberSameEpoch.bytes, minimum, 500),
      'WAL_AUTHORITY_ROLLBACK',
    );
    const exactPosition = await rollbackRecovery(minimum.collectionId, setup.network.id, [networkA], {
      epoch: 1n, number: 1n, id: bytes('exact-position'),
    });
    await expectCode(() => setup.lifecycle.installRollbackRecovery(exactPosition.bytes, {
      ...minimum, vectorId: Uint8Array.of(1),
    }, 500), 'WAL_AUTHORITY_ROLLBACK');
  });

  it('covers authority genesis, threshold, revocation, replay, conflict, and expiry boundaries', async () => {
    const setup = await scenario('authority-boundaries');
    expect(setup.lifecycle.acceptAuthoritySet(setup.curator.bytes, 200).status).toBe('replay');
    const impossible = await authority(0n, 1n, [curatorB], [curatorA], setup.curator.id, { threshold: 2n });
    await expectCode(() => setup.lifecycle.acceptAuthoritySet(impossible.bytes, 200), 'WAL_AUTHORITY_INVALID');
    const curatorRevocations = await authority(0n, 1n, [curatorB], [curatorA], setup.curator.id, {
      revocations: [bytes('forbidden-revocation')],
    });
    await expectCode(() => setup.lifecycle.acceptAuthoritySet(curatorRevocations.bytes, 200), 'WAL_AUTHORITY_INVALID');
    const fork = await authority(0n, 0n, [curatorB], [curatorA], null);
    await expectCode(() => setup.lifecycle.acceptAuthoritySet(fork.bytes, 200), 'WAL_AUTHORITY_FORK');
    const afterFork = await authority(0n, 1n, [curatorB], [curatorA], setup.curator.id);
    await expectCode(() => setup.lifecycle.acceptAuthoritySet(afterFork.bytes, 200), 'WAL_AUTHORITY_BLOCKED');
    await expectCode(() => setup.lifecycle.acceptAuthoritySet(new Uint8Array(), 200), 'WAL_AUTHORITY_INVALID');

    const genesisRoot = await temporary('wrong-genesis');
    packed(genesisRoot);
    const genesisControl = control(genesisRoot);
    const wrongGenesisLifecycle = new WalAuthorityLifecycle({
      ...setup.options,
      root: genesisRoot,
      rollbackStore: genesisControl,
      genesisCuratorAuthoritySetId: bytes('wrong-genesis-pin'),
    });
    lifecycles.push(wrongGenesisLifecycle);
    await expectCode(() => wrongGenesisLifecycle.acceptAuthoritySet(setup.curator.bytes, 100), 'WAL_AUTHORITY_UNAUTHORIZED');

    const expiryRoot = await temporary('authority-expiry');
    packed(expiryRoot);
    const expiryControl = control(expiryRoot);
    const short = await authority(0n, 0n, [curatorA], [curatorA], null, { expires: 100n });
    const expiryLifecycle = new WalAuthorityLifecycle({
      ...setup.options,
      root: expiryRoot,
      rollbackStore: expiryControl,
      genesisCuratorAuthoritySetId: short.id,
    });
    lifecycles.push(expiryLifecycle);
    expiryLifecycle.acceptAuthoritySet(short.bytes, 100);
    const tooLate = await authority(0n, 1n, [curatorB], [curatorA], short.id);
    await expectCode(() => expiryLifecycle.acceptAuthoritySet(tooLate.bytes, 6_000), 'WAL_AUTHORITY_EXPIRED');
  });

  it('covers membership linkage, authority, fork, policy, and active-window boundaries', async () => {
    const setup = await scenario('membership-boundaries');
    const wrongAuthority = await membership(setup.targetView, setup.network.id, [curatorA]);
    await expectCode(setup.lifecycle.acceptMembershipCheckpoint(wrongAuthority.bytes, 100), 'WAL_AUTHORITY_UNAUTHORIZED');
    const nonGenesis = await membership(setup.targetView, setup.curator.id, [curatorA], { number: 1n });
    await expectCode(setup.lifecycle.acceptMembershipCheckpoint(nonGenesis.bytes, 100), 'WAL_AUTHORITY_ROLLBACK');
    const first = await membership(setup.targetView, setup.curator.id, [curatorA], { policyEpoch: 1n });
    await setup.lifecycle.acceptMembershipCheckpoint(first.bytes, 100);
    const samePosition = await membership(setup.targetView, setup.curator.id, [curatorA], { policyEpoch: 1n, issuedAt: 101n });
    await expectCode(setup.lifecycle.acceptMembershipCheckpoint(samePosition.bytes, 101), 'WAL_AUTHORITY_FORK');
    const unlinked = await membership(setup.targetView, setup.curator.id, [curatorA], {
      number: 2n, previous: first.id, policyEpoch: 1n,
    });
    await expectCode(setup.lifecycle.acceptMembershipCheckpoint(unlinked.bytes, 100), 'WAL_AUTHORITY_ROLLBACK');
    const lowerPolicy = await membership(setup.targetView, setup.curator.id, [curatorA], {
      number: 1n, previous: first.id, policyEpoch: 0n,
    });
    await expectCode(setup.lifecycle.acceptMembershipCheckpoint(lowerPolicy.bytes, 100), 'WAL_AUTHORITY_WRONG_POLICY');

    const windowRoot = await temporary('authority-window');
    packed(windowRoot);
    const windowControl = control(windowRoot);
    const futureAuthority = await authority(0n, 0n, [curatorA], [curatorA], null, { notBefore: 6_000n });
    const network = await authority(1n, 0n, [networkA], [networkA], null);
    const windowLifecycle = new WalAuthorityLifecycle({
      ...setup.options,
      root: windowRoot,
      rollbackStore: windowControl,
      genesisCuratorAuthoritySetId: futureAuthority.id,
      genesisNetworkAuthoritySetId: network.id,
    });
    lifecycles.push(windowLifecycle);
    windowLifecycle.acceptAuthoritySet(futureAuthority.bytes, 1_000);
    const futureMembership = await membership(setup.targetView, futureAuthority.id, [curatorA]);
    await expectCode(windowLifecycle.acceptMembershipCheckpoint(futureMembership.bytes, 0), 'WAL_AUTHORITY_STALE');

    const expiredRoot = await temporary('current-authority-expired');
    packed(expiredRoot);
    const expiredControl = control(expiredRoot);
    const expiredAuthority = await authority(0n, 0n, [curatorA], [curatorA], null, { expires: 100n });
    const expiredLifecycle = new WalAuthorityLifecycle({
      ...setup.options,
      root: expiredRoot,
      rollbackStore: expiredControl,
      genesisCuratorAuthoritySetId: expiredAuthority.id,
    });
    lifecycles.push(expiredLifecycle);
    expiredLifecycle.acceptAuthoritySet(expiredAuthority.bytes, 100);
    const expiredMembership = await membership(setup.targetView, expiredAuthority.id, [curatorA]);
    await expectCode(expiredLifecycle.acceptMembershipCheckpoint(expiredMembership.bytes, 6_000), 'WAL_AUTHORITY_EXPIRED');
  });

  it('covers author checkpoint wrong-view, role, sequence, extension, and snapshot rejection boundaries', async () => {
    const setup = await scenario('checkpoint-boundaries', view(), { openAuthor: false, snapshot: false });
    const firstMembership = await membership(setup.targetView, setup.curator.id, [curatorA], {
      mode: 0n, writers: [writerA.address],
    });
    await setup.lifecycle.acceptMembershipCheckpoint(firstMembership.bytes, 100);
    const collectionId = collectionIdV1(setup.targetView.collectionKey);
    const namespace = namespaceIdV1(setup.targetView.viewKey);
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId, canonicalBytes: new Uint8Array(), objectIds: [],
    }), 'WAL_AUTHORITY_INVALID');
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId: bytes('unknown-collection'), canonicalBytes: (await checkpoint(namespace, writerA, [bytes('x')])).bytes,
      objectIds: [bytes('x')],
    }), 'WAL_AUTHORITY_UNAUTHORIZED');
    const wrongViewCheckpoint = await checkpoint(bytes('other-namespace'), writerA, [bytes('wrong-view-object')]);
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId, canonicalBytes: wrongViewCheckpoint.bytes, objectIds: [bytes('wrong-view-object')],
    }), 'WAL_AUTHORITY_WRONG_VIEW');
    const curatorCheckpoint = await checkpoint(namespace, curatorA, [bytes('curator-object')]);
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId, canonicalBytes: curatorCheckpoint.bytes, objectIds: [bytes('curator-object')],
    }), 'WAL_AUTHORITY_UNAUTHORIZED');
    const deniedOpen = await checkpoint(namespace, writerB, [bytes('open-denied')]);
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId, canonicalBytes: deniedOpen.bytes, objectIds: [bytes('open-denied')],
    }), 'WAL_AUTHORITY_UNAUTHORIZED');
    const wrongSequence = await checkpoint(namespace, writerA, [bytes('wrong-sequence')], { maxSequence: 1n });
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId, canonicalBytes: wrongSequence.bytes, objectIds: [bytes('wrong-sequence')],
    }), 'WAL_AUTHORITY_INVALID');
    const invalidFirst = await checkpoint(namespace, writerA, [bytes('invalid-first')], {
      number: 1n, previous: bytes('previous'), count: 1n,
    });
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId, canonicalBytes: invalidFirst.bytes, objectIds: [bytes('invalid-first')],
    }), 'WAL_AUTHORITY_ROLLBACK');
    const rejectedBaseline = bytes('rejected-baseline');
    const firstSnapshot = await checkpoint(namespace, writerA, [rejectedBaseline], { baseline: rejectedBaseline });
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId, canonicalBytes: firstSnapshot.bytes, objectIds: [rejectedBaseline],
    }), 'WAL_AUTHORITY_UNAUTHORIZED');

    setup.state.snapshot = true;
    const firstId = bytes('valid-first');
    const first = await checkpoint(namespace, writerA, [firstId]);
    await setup.lifecycle.acceptAuthorCheckpoint({ collectionId, canonicalBytes: first.bytes, objectIds: [firstId] });
    const wrongLink = await checkpoint(namespace, writerA, [firstId, bytes('wrong-link')], {
      number: 1n, previous: bytes('not-tip'),
    });
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId, canonicalBytes: wrongLink.bytes, objectIds: [firstId, bytes('wrong-link')],
    }), 'WAL_AUTHORITY_ROLLBACK');
    const lostOld = await checkpoint(namespace, writerA, [bytes('new-a'), bytes('new-b')], {
      number: 1n, previous: first.id,
    });
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId, canonicalBytes: lostOld.bytes, objectIds: [bytes('new-a'), bytes('new-b')],
    }), 'WAL_AUTHORITY_ROLLBACK');
    const badRotation = await checkpoint(namespace, writerA, [bytes('rotation')], { writerEpoch: 2n });
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId, canonicalBytes: badRotation.bytes, objectIds: [bytes('rotation')],
    }), 'WAL_AUTHORITY_ROLLBACK');
    setup.state.snapshot = false;
    const baseline = bytes('rotation-baseline');
    const deniedRotation = await checkpoint(namespace, writerA, [baseline], { writerEpoch: 1n, baseline });
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId, canonicalBytes: deniedRotation.bytes, objectIds: [baseline],
    }), 'WAL_AUTHORITY_UNAUTHORIZED');

    const forkObject = bytes('lane-fork');
    const fork = await checkpoint(namespace, writerA, [forkObject]);
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId, canonicalBytes: fork.bytes, objectIds: [forkObject],
    }), 'WAL_AUTHORITY_FORK');
    const afterFork = await checkpoint(namespace, writerA, [firstId, bytes('after-fork')], {
      number: 1n, previous: first.id,
    });
    await expectCode(setup.lifecycle.acceptAuthorCheckpoint({
      collectionId, canonicalBytes: afterFork.bytes, objectIds: [firstId, bytes('after-fork')],
    }), 'WAL_AUTHORITY_BLOCKED');
  });

  it('covers vector authorization, limits, linkage, rollback protection, and freshness transitions', async () => {
    const setup = await scenario('vector-boundaries');
    const memberCheckpoint = await membership(setup.targetView, setup.curator.id, [curatorA], {
      writers: [writerA.address, writerB.address],
    });
    await setup.lifecycle.acceptMembershipCheckpoint(memberCheckpoint.bytes, 100);
    await expectCode(() => setup.lifecycle.acceptCollectionVector(new Uint8Array(), 200), 'WAL_AUTHORITY_INVALID');
    const wrongAuthority = await vector(setup.targetView, memberCheckpoint.id, setup.network.id, [curatorA], []);
    await expectCode(() => setup.lifecycle.acceptCollectionVector(wrongAuthority.bytes, 200), 'WAL_AUTHORITY_UNAUTHORIZED');
    const future = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], [], { issuedAt: 8_000n, expiresAt: 9_000n });
    await expectCode(() => setup.lifecycle.acceptCollectionVector(future.bytes, 200), 'WAL_AUTHORITY_STALE');
    const expired = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], [], { issuedAt: 0n, expiresAt: 100n });
    await expectCode(() => setup.lifecycle.acceptCollectionVector(expired.bytes, 6_000), 'WAL_AUTHORITY_EXPIRED');
    const emptyInterval = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], [], {
      issuedAt: 100n, expiresAt: 100n,
    });
    await expectCode(() => setup.lifecycle.acceptCollectionVector(emptyInterval.bytes, 200), 'WAL_AUTHORITY_INVALID');
    const staleMembership = await vector(setup.targetView, bytes('missing-membership'), setup.curator.id, [curatorA], []);
    await expectCode(() => setup.lifecycle.acceptCollectionVector(staleMembership.bytes, 200), 'WAL_AUTHORITY_STALE');
    const wrongNamespaces = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], [], { namespaces: [] });
    await expectCode(() => setup.lifecycle.acceptCollectionVector(wrongNamespaces.bytes, 200), 'WAL_AUTHORITY_WRONG_VIEW');
    const curatorHead = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], [
      { writerId: curatorA.address, checkpointId: bytes('curator-checkpoint') },
    ]);
    await expectCode(() => setup.lifecycle.acceptCollectionVector(curatorHead.bytes, 200), 'WAL_AUTHORITY_UNAUTHORIZED');
    const unauthorizedCuratedHead = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], [
      { writerId: member.address, checkpointId: bytes('unauthorized-curated-checkpoint') },
    ]);
    await expectCode(
      () => setup.lifecycle.acceptCollectionVector(unauthorizedCuratedHead.bytes, 200),
      'WAL_AUTHORITY_UNAUTHORIZED',
    );

    const limited = new WalAuthorityLifecycle({ ...setup.options, maximumAuthorsPerVector: 1 });
    lifecycles.push(limited);
    const tooMany = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], [
      { writerId: writerA.address, checkpointId: bytes('a') },
      { writerId: writerB.address, checkpointId: bytes('b') },
    ]);
    await expectCode(() => limited.acceptCollectionVector(tooMany.bytes, 200), 'WAL_AUTHORITY_LIMIT_EXCEEDED');

    const first = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], []);
    setup.lifecycle.acceptCollectionVector(first.bytes, 200);
    const unlinked = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], [], {
      number: 1n, previous: bytes('wrong-vector'), issuedAt: 200n,
    });
    await expectCode(() => setup.lifecycle.acceptCollectionVector(unlinked.bytes, 200), 'WAL_AUTHORITY_ROLLBACK');
    const jump = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], [], {
      number: 2n, previous: first.id, issuedAt: 200n,
    });
    await expectCode(() => setup.lifecycle.acceptCollectionVector(jump.bytes, 200), 'WAL_AUTHORITY_ROLLBACK');
    const second = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], [], {
      number: 1n, previous: first.id, issuedAt: 200n,
    });
    expect(setup.lifecycle.acceptCollectionVector(second.bytes, 200).status).toBe('stored');

    const rotated = await authority(0n, 1n, [curatorB], [curatorA], setup.curator.id);
    setup.lifecycle.acceptAuthoritySet(rotated.bytes, 300);
    expect(await setup.lifecycle.evaluate(setup.targetView, 300)).toEqual(expect.objectContaining({
      status: 'unknown-freshness', reason: 'AUTHORITY_EXPIRED',
    }));
    const wrongRotation = await vector(setup.targetView, memberCheckpoint.id, rotated.id, [curatorB], [], {
      epoch: 2n, number: 0n, previous: second.id, issuedAt: 300n,
    });
    await expectCode(() => setup.lifecycle.acceptCollectionVector(wrongRotation.bytes, 300), 'WAL_AUTHORITY_ROLLBACK');
    const wrongRotationNumber = await vector(setup.targetView, memberCheckpoint.id, rotated.id, [curatorB], [], {
      epoch: 1n, number: 1n, previous: second.id, issuedAt: 300n,
    });
    await expectCode(
      () => setup.lifecycle.acceptCollectionVector(wrongRotationNumber.bytes, 300),
      'WAL_AUTHORITY_ROLLBACK',
    );

    const blockedRoot = await temporary('vector-rollback-blocked');
    packed(blockedRoot);
    const blockedControl = control(blockedRoot);
    const blockedLifecycle = new WalAuthorityLifecycle({
      ...setup.options,
      root: blockedRoot,
      rollbackStore: {
        ...blockedControl,
        rollbackProtectionStatus: () => ({ state: 'blocked' as const, reason: 'test' }),
        getRollbackHighWater: blockedControl.getRollbackHighWater.bind(blockedControl),
        setRollbackHighWater: blockedControl.setRollbackHighWater.bind(blockedControl),
        installVerifiedRollbackRecovery: blockedControl.installVerifiedRollbackRecovery.bind(blockedControl),
      },
    });
    lifecycles.push(blockedLifecycle);
    blockedLifecycle.acceptAuthoritySet(setup.curator.bytes, 100);
    const blockedMembership = await membership(setup.targetView, setup.curator.id, [curatorA]);
    await blockedLifecycle.acceptMembershipCheckpoint(blockedMembership.bytes, 100);
    const blockedVector = await vector(setup.targetView, blockedMembership.id, setup.curator.id, [curatorA], []);
    await expectCode(() => blockedLifecycle.acceptCollectionVector(blockedVector.bytes, 200), 'WAL_AUTHORITY_BLOCKED');

    const unknownReasonRoot = await temporary('vector-rollback-unknown-reason');
    packed(unknownReasonRoot);
    const unknownReasonControl = control(unknownReasonRoot);
    const unknownReasonLifecycle = new WalAuthorityLifecycle({
      ...setup.options,
      root: unknownReasonRoot,
      rollbackStore: {
        rollbackProtectionStatus: () => ({ state: 'blocked' as const }),
        getRollbackHighWater: unknownReasonControl.getRollbackHighWater.bind(unknownReasonControl),
        setRollbackHighWater: unknownReasonControl.setRollbackHighWater.bind(unknownReasonControl),
        installVerifiedRollbackRecovery: unknownReasonControl.installVerifiedRollbackRecovery.bind(unknownReasonControl),
      },
    });
    lifecycles.push(unknownReasonLifecycle);
    unknownReasonLifecycle.acceptAuthoritySet(setup.curator.bytes, 100);
    const unknownReasonMembership = await membership(setup.targetView, setup.curator.id, [curatorA]);
    await unknownReasonLifecycle.acceptMembershipCheckpoint(unknownReasonMembership.bytes, 100);
    const unknownReasonVector = await vector(
      setup.targetView, unknownReasonMembership.id, setup.curator.id, [curatorA], [],
    );
    await expectCode(
      () => unknownReasonLifecycle.acceptCollectionVector(unknownReasonVector.bytes, 200),
      'WAL_AUTHORITY_BLOCKED',
    );

    const highRoot = await temporary('vector-high-water');
    packed(highRoot);
    const highControl = control(highRoot);
    highControl.setRollbackHighWater({
      collectionId: collectionIdV1(setup.targetView.collectionKey), vectorEpoch: 1n, vectorNumber: 0n,
      vectorId: bytes('ahead'), updatedAtMs: 1,
    });
    const highLifecycle = new WalAuthorityLifecycle({ ...setup.options, root: highRoot, rollbackStore: highControl });
    lifecycles.push(highLifecycle);
    highLifecycle.acceptAuthoritySet(setup.curator.bytes, 100);
    const highMembership = await membership(setup.targetView, setup.curator.id, [curatorA]);
    await highLifecycle.acceptMembershipCheckpoint(highMembership.bytes, 100);
    const lowVector = await vector(setup.targetView, highMembership.id, setup.curator.id, [curatorA], []);
    await expectCode(() => highLifecycle.acceptCollectionVector(lowVector.bytes, 200), 'WAL_AUTHORITY_ROLLBACK');
  });

  it('distinguishes expired authority from a vector bound to superseded membership', async () => {
    const setup = await scenario('evaluation-freshness-boundaries');
    const firstMembership = await membership(setup.targetView, setup.curator.id, [curatorA]);
    await setup.lifecycle.acceptMembershipCheckpoint(firstMembership.bytes, 100);
    const currentVector = await vector(
      setup.targetView,
      firstMembership.id,
      setup.curator.id,
      [curatorA],
      [],
      { expiresAt: 30_000n },
    );
    setup.lifecycle.acceptCollectionVector(currentVector.bytes, 200);
    const nextMembership = await membership(setup.targetView, setup.curator.id, [curatorA], {
      number: 1n,
      previous: firstMembership.id,
      issuedAt: 200n,
    });
    await setup.lifecycle.acceptMembershipCheckpoint(nextMembership.bytes, 200);
    expect(await setup.lifecycle.evaluate(setup.targetView, 200)).toEqual(expect.objectContaining({
      status: 'unknown-freshness', reason: 'VECTOR_MEMBERSHIP_MISMATCH',
    }));
    expect(await setup.lifecycle.evaluate(setup.targetView, 15_001)).toEqual(expect.objectContaining({
      status: 'unknown-freshness', reason: 'AUTHORITY_EXPIRED',
    }));
  });

  it('covers exact policy/key view errors, rollback freshness, recovery authorization, and install failure', async () => {
    const target = view();
    const policyView = view(0n, 1n);
    const badKeyView = view(0n, 0n, 1n);
    const setup = await scenario('view-boundaries', target);
    const memberCheckpoint = await membership(target, setup.curator.id, [curatorA], {
      policyEpoch: 0n,
      namespaces: [namespaceIdV1(target.viewKey), namespaceIdV1(policyView.viewKey), namespaceIdV1(badKeyView.viewKey)],
    });
    await setup.lifecycle.acceptMembershipCheckpoint(memberCheckpoint.bytes, 100);
    const namespaces: ProtocolTuple<'ExpectedNamespaceV1'>[] = [target, policyView, badKeyView]
      .map(item => [namespaceIdV1(item.viewKey), []] as const)
      .sort((left, right) => Buffer.compare(Buffer.from(left[0]), Buffer.from(right[0])));
    const currentVector = await vector(target, memberCheckpoint.id, setup.curator.id, [curatorA], [], { namespaces });
    setup.lifecycle.acceptCollectionVector(currentVector.bytes, 200);
    expect(await setup.lifecycle.evaluate(policyView, 200)).toEqual(expect.objectContaining({ reason: 'WRONG_POLICY_EPOCH' }));
    expect(await setup.lifecycle.evaluate(badKeyView, 200)).toEqual(expect.objectContaining({ reason: 'WRONG_KEY_EPOCH' }));
    const wrongCollection: WalAuthorityView = {
      collectionKey: target.collectionKey,
      viewKey: ['other', 'cg:alpha', null, 0n, 0n, 0n, null],
    };
    expect(await setup.lifecycle.evaluate(wrongCollection, 200)).toEqual(expect.objectContaining({ reason: 'WRONG_COLLECTION' }));
    await expectCode(setup.lifecycle.evaluate({ collectionKey: [] as never, viewKey: [] as never }, 200), 'WAL_AUTHORITY_INVALID');

    const blockedResultLifecycle = new WalAuthorityLifecycle({
      ...setup.options,
      rollbackStore: {
        rollbackProtectionStatus: () => ({ state: 'blocked' as const, reason: 'missing' }),
        getRollbackHighWater: setup.rollback.getRollbackHighWater.bind(setup.rollback),
        setRollbackHighWater: setup.rollback.setRollbackHighWater.bind(setup.rollback),
        installVerifiedRollbackRecovery: setup.rollback.installVerifiedRollbackRecovery.bind(setup.rollback),
      },
    });
    lifecycles.push(blockedResultLifecycle);
    expect(await blockedResultLifecycle.evaluate(target, 200)).toEqual(expect.objectContaining({
      status: 'unknown-freshness', reason: 'ROLLBACK_GUARD_UNAVAILABLE',
    }));

    const collectionId = collectionIdV1(target.collectionKey);
    const minimum: RollbackCohortMinimum = { collectionId, vectorEpoch: 0n, vectorNumber: 0n, vectorId: bytes('minimum') };
    const wrongViewRecovery = await rollbackRecovery(bytes('other-collection'), setup.network.id, [networkA], {
      epoch: 0n, number: 0n, id: minimum.vectorId,
    });
    await expectCode(() => setup.lifecycle.installRollbackRecovery(wrongViewRecovery.bytes, minimum, 500), 'WAL_AUTHORITY_WRONG_VIEW');
    const wrongAuthorityRecovery = await rollbackRecovery(collectionId, setup.curator.id, [networkA], {
      epoch: 0n, number: 0n, id: minimum.vectorId,
    });
    await expectCode(() => setup.lifecycle.installRollbackRecovery(wrongAuthorityRecovery.bytes, minimum, 500), 'WAL_AUTHORITY_UNAUTHORIZED');
    const staleUnsigned = [
      1n, 'testnet', collectionId, 0n, 0n, minimum.vectorId, bytes('stale-nonce'), 10_000n, setup.network.id,
    ] satisfies readonly CborProtocolValue[];
    const staleTuple = await signThresholdProtocolTuple('RollbackRecoveryV1', staleUnsigned, [networkA]);
    await expectCode(() => setup.lifecycle.installRollbackRecovery(
      encodeProtocolTuple('RollbackRecoveryV1', staleTuple), minimum, 500,
    ), 'WAL_AUTHORITY_STALE');

    const recovery = await rollbackRecovery(collectionId, setup.network.id, [networkA], {
      epoch: 0n, number: 0n, id: minimum.vectorId,
    });
    const throwingLifecycle = new WalAuthorityLifecycle({
      ...setup.options,
      rollbackStore: {
        rollbackProtectionStatus: () => ({ state: 'blocked' as const, reason: 'missing' }),
        getRollbackHighWater: () => null,
        setRollbackHighWater: () => 'advanced',
        installVerifiedRollbackRecovery: () => { throw new Error('injected install failure'); },
      },
    });
    lifecycles.push(throwingLifecycle);
    await expectCode(() => throwingLifecycle.installRollbackRecovery(recovery.bytes, minimum, 500), 'WAL_AUTHORITY_BLOCKED');
  });

  it('covers persistence reads, replay conflicts, schema gates, and transactional failures', async () => {
    const setup = await scenario('persistence-boundaries');
    const persistence = setup.lifecycle.persistence;
    expect(persistence.getAuthority(setup.curator.id)).toEqual(expect.objectContaining({ id: setup.curator.id }));
    expect(persistence.getAuthority(bytes('missing-authority'))).toBeNull();
    expect(persistence.putAuthority(setup.curator.id, setup.curator.bytes, setup.curator.tuple, 100)).toBe('replay');
    await expectCode(() => persistence.putAuthority(
      setup.curator.id, Uint8Array.of(1), setup.curator.tuple, 100,
    ), 'WAL_AUTHORITY_FORK');
    const memberCheckpoint = await membership(setup.targetView, setup.curator.id, [curatorA]);
    await setup.lifecycle.acceptMembershipCheckpoint(memberCheckpoint.bytes, 100);
    expect(persistence.putMembership(
      memberCheckpoint.id, memberCheckpoint.bytes, memberCheckpoint.tuple, 100,
    )).toBe('replay');
    await expectCode(() => persistence.putMembership(
      memberCheckpoint.id, Uint8Array.of(1), memberCheckpoint.tuple, 100,
    ), 'WAL_AUTHORITY_FORK');
    const objectId = bytes('persistence-object');
    const authorCheckpoint = await checkpoint(namespaceIdV1(setup.targetView.viewKey), writerA, [objectId]);
    await setup.lifecycle.acceptAuthorCheckpoint({
      collectionId: collectionIdV1(setup.targetView.collectionKey),
      canonicalBytes: authorCheckpoint.bytes,
      objectIds: [objectId],
    });
    expect(persistence.putCheckpoint(
      authorCheckpoint.id,
      authorCheckpoint.bytes,
      authorCheckpoint.tuple,
      persistence.getCheckpoint(authorCheckpoint.id)!.setSnapshot,
      100,
    )).toBe('replay');
    await expectCode(() => persistence.putCheckpoint(
      authorCheckpoint.id, Uint8Array.of(1), authorCheckpoint.tuple, Uint8Array.of(1), 100,
    ), 'WAL_AUTHORITY_FORK');
    const currentVector = await vector(setup.targetView, memberCheckpoint.id, setup.curator.id, [curatorA], [
      { writerId: writerA.address, checkpointId: authorCheckpoint.id },
    ]);
    setup.lifecycle.acceptCollectionVector(currentVector.bytes, 200);
    expect(persistence.putVector(
      currentVector.id,
      currentVector.bytes,
      currentVector.tuple,
      persistence.getVectorHeads(currentVector.id),
      200,
    )).toBe('replay');
    await expectCode(() => persistence.putVector(
      currentVector.id, Uint8Array.of(1), currentVector.tuple,
      persistence.getVectorHeads(currentVector.id), 200,
    ), 'WAL_AUTHORITY_FORK');

    const internal = persistence as unknown as { transaction(operation: () => void): void };
    await expectCode(() => internal.transaction(() => { throw new WalAuthorityError('WAL_AUTHORITY_INVALID', 'injected'); }), 'WAL_AUTHORITY_INVALID');
    await expectCode(() => internal.transaction(() => { throw new Error('raw'); }), 'WAL_AUTHORITY_IO');

    const wrongVersionRoot = await temporary('authority-schema-version');
    packed(wrongVersionRoot);
    const wrongVersionControl = control(wrongVersionRoot);
    closeControl(wrongVersionControl);
    let database = new Database(join(wrongVersionRoot, 'objects.sqlite'));
    database.prepare('UPDATE wal_control_schema SET version = 1').run();
    database.close();
    await expectCode(() => new WalAuthorityPersistence(wrongVersionRoot), 'WAL_AUTHORITY_INVALID');

    const missingTableRoot = await temporary('authority-schema-table');
    packed(missingTableRoot);
    const missingTableControl = control(missingTableRoot);
    closeControl(missingTableControl);
    database = new Database(join(missingTableRoot, 'objects.sqlite'));
    database.exec('DROP TABLE collection_vector_heads');
    database.close();
    await expectCode(() => new WalAuthorityPersistence(missingTableRoot), 'WAL_AUTHORITY_INVALID');

    const missingSchemaRoot = await temporary('authority-missing-control-schema');
    packed(missingSchemaRoot);
    const missingSchemaControl = control(missingSchemaRoot);
    closeControl(missingSchemaControl);
    database = new Database(join(missingSchemaRoot, 'objects.sqlite'));
    database.exec('DROP TABLE wal_control_schema');
    database.close();
    await expectCode(() => new WalAuthorityPersistence(missingSchemaRoot), 'WAL_AUTHORITY_IO');
  });

  it('fails lifecycle and persistence use after close with stable codes', async () => {
    const setup = await scenario('closed');
    const persistence = setup.lifecycle.persistence;
    closeLifecycle(setup.lifecycle);
    setup.lifecycle.close();
    persistence.close();
    await expectCode(() => setup.lifecycle.acceptAuthoritySet(setup.curator.bytes, 100), 'WAL_AUTHORITY_IO');
    await expectCode(() => persistence.getCurrentAuthority('testnet', 0n), 'WAL_AUTHORITY_IO');
    expect(new WalAuthorityError('WAL_AUTHORITY_INVALID', 'x').name).toBe('WalAuthorityError');
  });
});
