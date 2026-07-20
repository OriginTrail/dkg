import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  MutableSetCommitment,
  DKG_MUTATION_MEDIA_TYPE_V1,
  PackedWalObjectStore,
  RDF_POLICY_MEDIA_TYPE_V1,
  WAL_V1_ENUMS,
  WalControlStore,
  WalLocalCommitter,
  collectionIdV1,
  createRdfPolicyV1,
  createWalObjectV1,
  decodeDkgPayloadEnvelope,
  decryptPrivateDkgPayload,
  encodeProtocolTuple,
  encodePublicDkgPayload,
  encodeRdfPolicyV1,
  namespaceIdV1,
  protocolTupleId,
  signSingleProtocolTuple,
  signThresholdProtocolTuple,
  verifyWalObjectV1,
  walObjectId,
  type CborProtocolValue,
  type ProtocolTuple,
} from '@origintrail-official/dkg-wal';
import type { PublisherWalShadowMutationV1 } from '@origintrail-official/dkg-publisher';
import {
  DkgWalLocalAuthoringBundleError,
  loadSignedDkgWalLocalAuthoringResolverV1,
} from '../src/wal/local-authoring-bundle.js';
import { DkgWalPublisherShadowWriter } from '../src/wal/local-commit.js';

const NETWORK_ID = 'wal-devnet-test-network';
const CONTEXT_GRAPH_ID = 'devnet-test';
const GRAPH = 'did:dkg:context-graph:devnet-test/_shared_memory';
const curator = new ethers.Wallet(`0x${'61'.repeat(32)}`);
const policyWriter = new ethers.Wallet(`0x${'62'.repeat(32)}`);
const contentWriter = new ethers.Wallet(`0x${'63'.repeat(32)}`);
const otherWriter = new ethers.Wallet(`0x${'64'.repeat(32)}`);

function bytes(value: string): Uint8Array {
  return ethers.getBytes(value);
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

async function bundleFixture(overrides: {
  networkId?: string;
  contentWriters?: readonly string[];
  contextGraphId?: string;
  visibility?: 'public' | 'private';
  keyEpoch?: bigint;
} = {}) {
  const networkId = overrides.networkId ?? NETWORK_ID;
  const contextGraphId = overrides.contextGraphId ?? CONTEXT_GRAPH_ID;
  const visibility = overrides.visibility ?? 'public';
  const visibilityCode = visibility === 'private' ? 1n : 0n;
  const keyEpoch = visibility === 'private' ? (overrides.keyEpoch ?? 77n) : null;
  const collectionId = collectionIdV1([networkId, contextGraphId, null, visibilityCode]);
  const swmNamespaceId = namespaceIdV1([
    networkId, contextGraphId, null, 0n, visibilityCode, 0n, keyEpoch,
  ]);
  const vmNamespaceId = namespaceIdV1([
    networkId, contextGraphId, null, 1n, visibilityCode, 0n, keyEpoch,
  ]);
  const policy = createRdfPolicyV1({
    allowedGraphPrefixes: ['did:dkg:context-graph:'],
    maxQuadsPerMutation: 1_000_000n,
    maxWalObjectBytes: 1_073_741_824n,
    allowedPayloadKinds: [
      BigInt(WAL_V1_ENUMS.payloadKind.DKG_MUTATION),
      BigInt(WAL_V1_ENUMS.payloadKind.RDF_POLICY),
    ],
  });
  const policyPayload = encodePublicDkgPayload({
    payloadKind: BigInt(WAL_V1_ENUMS.payloadKind.RDF_POLICY),
    codec: BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR),
    mediaType: RDF_POLICY_MEDIA_TYPE_V1,
    contentBytes: encodeRdfPolicyV1(policy),
  });
  const policyObject = await createWalObjectV1([
    1n,
    swmNamespaceId,
    bytes(policyWriter.address),
    0n,
    0n,
    null,
    policyPayload.canonicalBytes,
  ], policyWriter);
  const commitment = new MutableSetCommitment([walObjectId(policyObject.walObjectId)]);
  const policyCheckpoint = await signSingleProtocolTuple('AuthorCheckpointV1', [
    1n,
    swmNamespaceId,
    bytes(policyWriter.address),
    0n,
    0n,
    1n,
    commitment.root,
    1n,
    0n,
    null,
    null,
    0n,
  ], policyWriter);
  const authorityUnsigned = [
    1n,
    0n,
    networkId,
    0n,
    1n,
    [bytes(curator.address)],
    0n,
    4_102_444_800_000n,
    null,
    [],
  ] satisfies readonly CborProtocolValue[];
  const authority = await signThresholdProtocolTuple('AuthoritySetV1', authorityUnsigned, [curator]);
  const authorityId = protocolTupleId('AuthoritySetV1', authority);
  const memberWriterIds = [
    ...(overrides.contentWriters ?? [contentWriter.address]).map(bytes),
    bytes(policyWriter.address),
  ].sort(Buffer.compare);
  const membershipUnsigned = [
    1n,
    collectionId,
    0n,
    0n,
    1n,
    memberWriterIds,
    [],
    [],
    [swmNamespaceId, vmNamespaceId].sort(Buffer.compare),
    policyObject.walObjectId,
    null,
    100n,
    authorityId,
  ] satisfies readonly CborProtocolValue[];
  const membership = await signThresholdProtocolTuple(
    'MembershipCheckpointV1',
    membershipUnsigned,
    [curator],
  );
  const json = {
    version: 1,
    networkId,
    curatorAuthoritySets: [hex(encodeProtocolTuple('AuthoritySetV1', authority))],
    views: [{
      contextGraphId,
      subGraphName: null,
      ...(visibility === 'public' ? {} : { visibility, keyEpoch: keyEpoch!.toString() }),
      writerEpoch: '0',
      membershipCheckpoints: [hex(encodeProtocolTuple('MembershipCheckpointV1', membership))],
      policyWalObject: hex(policyObject.canonicalBytes),
      policyCheckpoint: hex(encodeProtocolTuple('AuthorCheckpointV1', policyCheckpoint)),
    }],
  };
  return { json, authorityId, policyObject, swmNamespaceId, memberWriterIds };
}

function mutation(signer = contentWriter): PublisherWalShadowMutationV1 {
  return {
    kind: 'share',
    operation: 'PUT',
    contextGraphId: CONTEXT_GRAPH_ID,
    logicalAuthorAddress: contentWriter.address,
    logicalResource: 'urn:wal:devnet-root',
    idempotencyKey: 'share:operation:urn:wal:devnet-root',
    baseQuads: [],
    resultQuads: [{
      subject: 'urn:wal:devnet-root',
      predicate: 'https://schema.org/name',
      object: '"WAL"',
      graph: GRAPH,
    }],
    signer: { address: signer.address, signMessage: value => signer.signMessage(value) },
    timestampMs: 1_000,
  };
}

describe('signed WAL local-authoring bundle', () => {
  it('pins authority, admits the exact public SWM view, installs policy bytes, and survives restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-wal-authoring-bundle-'));
    const bundlePath = join(root, 'bundle.json');
    const fixture = await bundleFixture();
    await writeFile(bundlePath, JSON.stringify(fixture.json), { mode: 0o600 });
    let physical = new PackedWalObjectStore({ root: join(root, 'objects') });
    let control = new WalControlStore({ root: join(root, 'objects'), now: () => 1_000 });
    let resolver = await loadSignedDkgWalLocalAuthoringResolverV1({
      bundlePath,
      expectedNetworkId: NETWORK_ID,
      expectedCuratorAuthoritySetId: hex(fixture.authorityId),
      objectStore: physical,
      controlStore: control,
      now: () => 1_000,
    });
    expect(await physical.has(walObjectId(fixture.policyObject.walObjectId))).toBe(true);
    expect(control.integrityScan().objects).toBe(1);
    const context = await resolver.resolve(mutation(), bytes(contentWriter.address));
    expect(context.policyAdmission.namespaceId).toEqual(fixture.swmNamespaceId);
    expect(context.policyAdmission.policyNamespaceId).toEqual(fixture.swmNamespaceId);
    expect(context.memberWriterIds).toEqual(fixture.memberWriterIds);

    let writer = new DkgWalPublisherShadowWriter({
      committer: new WalLocalCommitter({ control, now: () => 1_000 }),
      contextResolver: resolver,
    });
    const first = await writer.write(mutation());
    expect(first).toMatchObject({ walStatus: 'committed', sequence: '0', objectCount: '1' });
    control.close();
    physical.close();

    physical = new PackedWalObjectStore({ root: join(root, 'objects') });
    control = new WalControlStore({ root: join(root, 'objects'), now: () => 2_000 });
    resolver = await loadSignedDkgWalLocalAuthoringResolverV1({
      bundlePath,
      expectedNetworkId: NETWORK_ID,
      expectedCuratorAuthoritySetId: hex(fixture.authorityId),
      objectStore: physical,
      controlStore: control,
      now: () => 2_000,
    });
    expect(control.integrityScan().objects).toBe(2);
    writer = new DkgWalPublisherShadowWriter({
      committer: new WalLocalCommitter({ control, now: () => 2_000 }),
      contextResolver: resolver,
    });
    expect((await writer.write({ ...mutation(), timestampMs: 2_000 })).walObjectId).toBe(first.walObjectId);
    control.close();
    physical.close();
  });

  it('fails closed for wrong trust, wrong network, unavailable views, and unauthorized writers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-wal-authoring-negative-'));
    const bundlePath = join(root, 'bundle.json');
    const fixture = await bundleFixture();
    await writeFile(bundlePath, JSON.stringify(fixture.json), { mode: 0o600 });
    const load = async (expectedNetworkId = NETWORK_ID, expectedId = hex(fixture.authorityId)) => {
      const physical = new PackedWalObjectStore({ root: join(root, `objects-${Math.random()}`) });
      const control = new WalControlStore({ root: physical.root });
      try {
        return await loadSignedDkgWalLocalAuthoringResolverV1({
          bundlePath,
          expectedNetworkId,
          expectedCuratorAuthoritySetId: expectedId,
          objectStore: physical,
          controlStore: control,
          now: () => 1_000,
        });
      } finally {
        control.close();
        physical.close();
      }
    };
    await expect(load(NETWORK_ID, '00'.repeat(32))).rejects.toMatchObject({
      code: 'WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED',
    });
    await expect(load('another-network')).rejects.toMatchObject({
      code: 'WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED',
    });

    const physical = new PackedWalObjectStore({ root: join(root, 'objects-valid') });
    const control = new WalControlStore({ root: physical.root });
    const resolver = await loadSignedDkgWalLocalAuthoringResolverV1({
      bundlePath,
      expectedNetworkId: NETWORK_ID,
      expectedCuratorAuthoritySetId: hex(fixture.authorityId),
      objectStore: physical,
      controlStore: control,
      now: () => 1_000,
    });
    await expect(resolver.resolve({ ...mutation(), contextGraphId: 'missing' }, bytes(contentWriter.address)))
      .rejects.toMatchObject({ code: 'WAL_LOCAL_AUTHORING_VIEW_UNAVAILABLE' });
    await expect(resolver.resolve(mutation(otherWriter), bytes(otherWriter.address)))
      .rejects.toMatchObject({ code: 'WAL_LOCAL_AUTHORING_WRITER_UNAUTHORIZED' });
    control.close();
    physical.close();
  });

  it('binds a private view to the signed key epoch and resolves only the existing Sender Key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-wal-authoring-private-bundle-'));
    const bundlePath = join(root, 'bundle.json');
    const fixture = await bundleFixture({ visibility: 'private', keyEpoch: 77n });
    await writeFile(bundlePath, JSON.stringify(fixture.json), { mode: 0o600 });
    let physical = new PackedWalObjectStore({ root: join(root, 'objects') });
    let control = new WalControlStore({ root: join(root, 'objects'), now: () => 1_000 });
    const epochKey = new Uint8Array(32).fill(0x44);
    const resolvePrivatePayload = vi.fn(async () => ({ epochKey, keyEpoch: 77n }));
    let resolver = await loadSignedDkgWalLocalAuthoringResolverV1({
      bundlePath,
      expectedNetworkId: NETWORK_ID,
      expectedCuratorAuthoritySetId: hex(fixture.authorityId),
      objectStore: physical,
      controlStore: control,
      resolvePrivatePayload,
      now: () => 1_000,
    });
    const privateMutation = { ...mutation(), visibility: 'private' as const };
    const context = await resolver.resolve(privateMutation, bytes(contentWriter.address));
    expect(context).toEqual(expect.objectContaining({
      visibility: 'private',
      privatePayload: { epochKey, keyEpoch: 77n },
    }));
    expect(resolvePrivatePayload).toHaveBeenCalledWith(expect.objectContaining({ expectedKeyEpoch: 77n }));

    let writer = new DkgWalPublisherShadowWriter({
      committer: new WalLocalCommitter({ control, now: () => 1_001 }),
      contextResolver: resolver,
    });
    const first = await writer.write(privateMutation);
    expect(first).toMatchObject({
      walStatus: 'committed', sequence: '0', objectCount: '1',
    });

    control.close();
    physical.close();
    physical = new PackedWalObjectStore({ root: join(root, 'objects') });
    control = new WalControlStore({ root: join(root, 'objects'), now: () => 2_000 });
    resolver = await loadSignedDkgWalLocalAuthoringResolverV1({
      bundlePath,
      expectedNetworkId: NETWORK_ID,
      expectedCuratorAuthoritySetId: hex(fixture.authorityId),
      objectStore: physical,
      controlStore: control,
      resolvePrivatePayload,
      now: () => 2_000,
    });
    writer = new DkgWalPublisherShadowWriter({
      committer: new WalLocalCommitter({ control, now: () => 2_001 }),
      contextResolver: resolver,
    });
    await expect(writer.write({ ...privateMutation, timestampMs: 2_000 })).resolves.toMatchObject({
      walObjectId: first.walObjectId,
      walStatus: 'already-committed',
      sequence: '0',
      objectCount: '1',
    });

    const mismatched = await loadSignedDkgWalLocalAuthoringResolverV1({
      bundlePath,
      expectedNetworkId: NETWORK_ID,
      expectedCuratorAuthoritySetId: hex(fixture.authorityId),
      objectStore: physical,
      controlStore: control,
      resolvePrivatePayload: async () => ({ epochKey, keyEpoch: 78n }),
      now: () => 1_000,
    });
    await expect(mismatched.resolve(privateMutation, bytes(contentWriter.address)))
      .rejects.toMatchObject({ code: 'WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED' });
    control.close();
    physical.close();
  });

  it('authors isolated public and encrypted private WalObjectV1 atoms for one accepted operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-wal-authoring-dual-view-'));
    const bundlePath = join(root, 'bundle.json');
    const publicFixture = await bundleFixture();
    const privateFixture = await bundleFixture({ visibility: 'private', keyEpoch: 77n });
    await writeFile(bundlePath, JSON.stringify({
      ...publicFixture.json,
      views: [...publicFixture.json.views, ...privateFixture.json.views],
    }), { mode: 0o600 });
    const physical = new PackedWalObjectStore({ root: join(root, 'objects') });
    const control = new WalControlStore({ root: join(root, 'objects'), now: () => 1_000 });
    const epochKey = new Uint8Array(32).fill(0x44);
    const resolver = await loadSignedDkgWalLocalAuthoringResolverV1({
      bundlePath,
      expectedNetworkId: NETWORK_ID,
      expectedCuratorAuthoritySetId: hex(publicFixture.authorityId),
      objectStore: physical,
      controlStore: control,
      resolvePrivatePayload: async () => ({ epochKey, keyEpoch: 77n }),
      now: () => 1_000,
    });
    const writer = new DkgWalPublisherShadowWriter({
      committer: new WalLocalCommitter({ control, now: () => 1_001 }),
      contextResolver: resolver,
    });
    const publicMutation = {
      ...mutation(),
      visibility: 'public' as const,
      resultQuads: [{ ...mutation().resultQuads[0]!, object: '"PUBLIC_ONLY"' }],
    };
    const privateMutation = {
      ...mutation(),
      visibility: 'private' as const,
      resultQuads: [{
        ...mutation().resultQuads[0]!,
        object: '"PRIVATE_SECRET"',
        graph: 'did:dkg:context-graph:devnet-test/_private',
      }],
    };
    const [publicReceipt, privateReceipt] = await Promise.all([
      writer.write(publicMutation),
      writer.write(privateMutation),
    ]);
    expect(publicReceipt.walObjectId).not.toBe(privateReceipt.walObjectId);
    expect(control.integrityScan()).toMatchObject({ objects: 4, checkpoints: 4 });

    const readObject = async (id: string): Promise<Uint8Array> => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of physical.read(bytes(id) as never)) chunks.push(chunk);
      return new Uint8Array(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
    };
    const publicBytes = await readObject(publicReceipt.walObjectId);
    const privateBytes = await readObject(privateReceipt.walObjectId);
    const publicObject = verifyWalObjectV1(publicBytes).tuple;
    const privateObject = verifyWalObjectV1(privateBytes).tuple;
    expect(publicObject[1]).toEqual(publicFixture.swmNamespaceId);
    expect(privateObject[1]).toEqual(privateFixture.swmNamespaceId);
    expect(decodeDkgPayloadEnvelope(publicObject[6])[4]).toBeNull();
    expect(Buffer.from(publicObject[6]).includes(Buffer.from('PUBLIC_ONLY'))).toBe(true);
    expect(Buffer.from(publicObject[6]).includes(Buffer.from('PRIVATE_SECRET'))).toBe(false);
    expect(decodeDkgPayloadEnvelope(privateObject[6])[4]).not.toBeNull();
    expect(Buffer.from(privateBytes).includes(Buffer.from('PRIVATE_SECRET'))).toBe(false);
    const plaintext = decryptPrivateDkgPayload({
      namespaceId: privateObject[1],
      writerId: privateObject[2],
      writerEpoch: privateObject[3],
      sequence: privateObject[4],
      epochKey,
      expectedKeyEpoch: 77n,
      expectedPayloadKind: BigInt(WAL_V1_ENUMS.payloadKind.DKG_MUTATION),
      expectedCodec: BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR),
      expectedMediaType: DKG_MUTATION_MEDIA_TYPE_V1,
      envelopeBytes: privateObject[6],
    });
    expect(Buffer.from(plaintext).includes(Buffer.from('PRIVATE_SECRET'))).toBe(true);
    expect(Buffer.from(plaintext).includes(Buffer.from('PUBLIC_ONLY'))).toBe(false);
    control.close();
    physical.close();
  });

  it('rejects symlinked and malformed bundle files before importing policy state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-wal-authoring-file-'));
    const fixture = await bundleFixture();
    const realPath = join(root, 'real.json');
    const linkPath = join(root, 'link.json');
    await writeFile(realPath, JSON.stringify(fixture.json));
    await symlink(realPath, linkPath);
    const physical = new PackedWalObjectStore({ root: join(root, 'objects') });
    const control = new WalControlStore({ root: physical.root });
    const invoke = (bundlePath: string) => loadSignedDkgWalLocalAuthoringResolverV1({
      bundlePath,
      expectedNetworkId: NETWORK_ID,
      expectedCuratorAuthoritySetId: hex(fixture.authorityId),
      objectStore: physical,
      controlStore: control,
      now: () => 1_000,
    });
    await expect(invoke(linkPath)).rejects.toBeInstanceOf(DkgWalLocalAuthoringBundleError);
    await writeFile(realPath, '{"version":1}');
    await expect(invoke(realPath)).rejects.toMatchObject({ code: 'WAL_LOCAL_AUTHORING_BUNDLE_INVALID' });
    expect(control.integrityScan().objects).toBe(0);
    control.close();
    physical.close();
  });
});
