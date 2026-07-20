import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  PackedWalObjectStore,
  WalControlStore,
  WalLocalCommitter,
  createRdfPolicyV1,
  decryptPrivateDkgPayload,
  encodePublicDkgPayload,
  encodeRdfPolicyV1,
  RDF_POLICY_MEDIA_TYPE_V1,
  verifyWalObjectV1,
  walObjectId,
  type RdfPolicyAdmissionV1,
} from '@origintrail-official/dkg-wal';
import type { PublisherWalShadowMutationV1 } from '@origintrail-official/dkg-publisher';
import { DkgWalPublisherShadowWriter } from '../src/wal/local-commit.js';

const PRIVATE_KEY = `0x${'51'.repeat(32)}`;
const wallet = new ethers.Wallet(PRIVATE_KEY);
const policyWallet = new ethers.Wallet(`0x${'52'.repeat(32)}`);
const namespaceId = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const policyObjectId = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

function admission(policyObject: { id: Uint8Array; bytes: Uint8Array }): RdfPolicyAdmissionV1 {
  return {
    policyObjectId: policyObject.id,
    policy: createRdfPolicyV1({
      allowedGraphPrefixes: ['did:dkg:context-graph:'],
      maxQuadsPerMutation: 1_000n,
      maxWalObjectBytes: 1_048_576n,
      allowedPayloadKinds: [0n, 1n],
    }),
    membershipCheckpointId: new Uint8Array(32).fill(3),
    namespaceId,
    policyNamespaceId: namespaceId,
    writerId: ethers.getBytes(policyWallet.address),
    canonicalWalObjectBytes: policyObject.bytes,
  };
}

function mutation(
  value: string,
  idempotencyKey: string,
  baseValue?: string,
  timestampMs = 1_000,
): PublisherWalShadowMutationV1 {
  const graph = 'did:dkg:context-graph:test/_shared_memory';
  const baseQuads = baseValue === undefined ? [] : [{
    subject: 'urn:wal:agent-root',
    predicate: 'https://schema.org/name',
    object: `"${baseValue}"`,
    graph,
  }];
  return {
    kind: 'share',
    operation: 'PUT',
    contextGraphId: 'test',
    logicalAuthorAddress: wallet.address,
    logicalResource: 'urn:wal:agent-root',
    idempotencyKey,
    baseQuads,
    resultQuads: [{
      subject: 'urn:wal:agent-root',
      predicate: 'https://schema.org/name',
      object: `"${value}"`,
      graph,
    }],
    signer: { address: wallet.address, signMessage: bytes => wallet.signMessage(bytes) },
    timestampMs,
  };
}

describe('DkgWalPublisherShadowWriter', () => {
  it('compiles publisher RDF, authors the sole WalObject atom, and preserves idempotency across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-wal-agent-local-'));
    let physical = new PackedWalObjectStore({ root });
    let control = new WalControlStore({ root, now: () => 1_000 });
    const policy = createRdfPolicyV1({
      allowedGraphPrefixes: ['did:dkg:context-graph:'],
      maxQuadsPerMutation: 1_000n,
      maxWalObjectBytes: 1_048_576n,
      allowedPayloadKinds: [0n, 1n],
    });
    const policyPayload = encodePublicDkgPayload({
      payloadKind: 1n,
      codec: 0n,
      mediaType: RDF_POLICY_MEDIA_TYPE_V1,
      contentBytes: encodeRdfPolicyV1(policy),
    });
    const committedPolicy = await control.commitLocal({
      namespaceId,
      writerId: ethers.getBytes(policyWallet.address),
      writerEpoch: 0n,
      payloadBytes: policyPayload.canonicalBytes,
      signer: { address: policyWallet.address, signMessage: bytes => policyWallet.signMessage(bytes) },
      idempotencyKey: 'policy',
      requestDigest: policyObjectId,
    });
    const policyChunks: Uint8Array[] = [];
    for await (const chunk of physical.read(committedPolicy.objectId as never)) policyChunks.push(chunk);
    const policyAdmission = admission({
      id: committedPolicy.objectId,
      bytes: Buffer.concat(policyChunks.map(chunk => Buffer.from(chunk))),
    });
    const contextResolver = { resolve: async () => ({
      policyAdmission,
      writerEpoch: 0n,
      memberWriterIds: [ethers.getBytes(wallet.address)],
    }) };
    let adapter = new DkgWalPublisherShadowWriter({
      committer: new WalLocalCommitter({ control, now: () => 1_000 }),
      contextResolver,
    });

    const first = await adapter.write(mutation('first', 'request-1'));
    expect(first).toMatchObject({
      walStatus: 'committed', materializationStatus: 'pending',
      propagationStatus: 'not-claimed', sequence: '0', objectCount: '1',
    });
    expect(await physical.has(ethers.getBytes(first.walObjectId) as never)).toBe(true);
    const firstWork = control.getLocalCommitWork(ethers.getBytes(first.walObjectId))!;
    expect(control.getLocalLogicalHeads(firstWork.namespaceId, firstWork.logicalKey))
      .toEqual([ethers.getBytes(first.walObjectId)]);

    control.close();
    physical.close();
    physical = new PackedWalObjectStore({ root });
    control = new WalControlStore({ root, now: () => 2_000 });
    adapter = new DkgWalPublisherShadowWriter({
      committer: new WalLocalCommitter({ control, now: () => 2_000 }),
      contextResolver,
    });
    // A real publisher retry happens after the legacy write and therefore sees
    // the desired result as its new base. Base and local timestamp are not part
    // of request identity; the desired result is.
    const replay = await adapter.write(mutation('first', 'request-1', 'first', 2_000));
    expect(replay.walObjectId).toBe(first.walObjectId);
    expect(replay.walStatus).toBe('already-committed');
    await expect(adapter.write(mutation('different', 'request-1')))
      .rejects.toMatchObject({ code: 'WAL_CONTROL_IDEMPOTENCY_CONFLICT' });

    control.close();
    physical.close();
  });

  it('fails closed before authoring when no current admitted signed policy exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-wal-agent-policy-'));
    const physical = new PackedWalObjectStore({ root });
    const control = new WalControlStore({ root });
    const adapter = new DkgWalPublisherShadowWriter({
      committer: new WalLocalCommitter({ control }),
      contextResolver: { resolve: async () => ({
        policyAdmission: null as unknown as RdfPolicyAdmissionV1,
        writerEpoch: 0n,
        memberWriterIds: [],
      }) },
    });
    await expect(adapter.write(mutation('blocked', 'blocked')))
      .rejects.toThrow('current admitted signed RDF policy is unavailable');
    expect(control.integrityScan().objects).toBe(0);
    control.close();
    physical.close();
  });

  it('authors a sequence-bound encrypted object for an admitted private view', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-wal-agent-private-local-'));
    const physical = new PackedWalObjectStore({ root });
    const control = new WalControlStore({ root, now: () => 3_000 });
    const policy = createRdfPolicyV1({
      allowedGraphPrefixes: ['did:dkg:context-graph:'],
      maxQuadsPerMutation: 1_000n,
      maxWalObjectBytes: 1_048_576n,
      allowedPayloadKinds: [0n, 1n],
    });
    const policyPayload = encodePublicDkgPayload({
      payloadKind: 1n,
      codec: 0n,
      mediaType: RDF_POLICY_MEDIA_TYPE_V1,
      contentBytes: encodeRdfPolicyV1(policy),
    });
    const committedPolicy = await control.commitLocal({
      namespaceId,
      writerId: ethers.getBytes(policyWallet.address),
      writerEpoch: 0n,
      payloadBytes: policyPayload.canonicalBytes,
      signer: { address: policyWallet.address, signMessage: bytes => policyWallet.signMessage(bytes) },
      idempotencyKey: 'private-policy',
      requestDigest: new Uint8Array(policyObjectId).fill(7),
    });
    const policyChunks: Uint8Array[] = [];
    for await (const chunk of physical.read(committedPolicy.objectId as never)) policyChunks.push(chunk);
    const epochKey = new Uint8Array(32).fill(8);
    const writer = new DkgWalPublisherShadowWriter({
      committer: new WalLocalCommitter({ control, now: () => 3_001 }),
      contextResolver: { resolve: async () => ({
        policyAdmission: admission({
          id: committedPolicy.objectId,
          bytes: Buffer.concat(policyChunks.map(chunk => Buffer.from(chunk))),
        }),
        writerEpoch: 0n,
        memberWriterIds: [ethers.getBytes(wallet.address)],
        visibility: 'private',
        privatePayload: { epochKey, keyEpoch: 77n },
      }) },
    });

    const committed = await writer.write({ ...mutation('secret', 'private-request'), visibility: 'private' });
    const objectBytes: Uint8Array[] = [];
    for await (const chunk of physical.read(walObjectId(ethers.getBytes(committed.walObjectId)))) {
      objectBytes.push(chunk);
    }
    const object = verifyWalObjectV1(Buffer.concat(objectBytes.map(chunk => Buffer.from(chunk))));
    const plaintext = decryptPrivateDkgPayload({
      namespaceId,
      writerId: ethers.getBytes(wallet.address),
      writerEpoch: 0n,
      sequence: BigInt(committed.sequence),
      epochKey,
      envelopeBytes: object.payloadBytes,
      expectedKeyEpoch: 77n,
      expectedPayloadKind: 0n,
      expectedCodec: 0n,
      expectedMediaType: 'application/vnd.origintrail.dkg-mutation-v1+cbor',
    });
    expect(plaintext.length).toBeGreaterThan(0);
    expect(committed.walStatus).toBe('committed');

    await expect(writer.write({
      ...mutation('public', 'public-on-private-view'),
      visibility: 'public',
    }))
      .rejects.toThrow(/visibility public does not match admitted private view/);
    control.close();
    physical.close();
  });
});
