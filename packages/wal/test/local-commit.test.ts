import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WalControlStore } from '../src/control/store.js';
import { WalLocalCommitter } from '../src/local-commit.js';
import { decodeDkgPayloadEnvelope, decryptPrivateDkgPayload } from '../src/privacy/crypto.js';
import { decodeProtocolTuple } from '../src/protocol/codec.js';
import {
  recoverEip191Address,
  signEip191DigestWithPrivateKey,
  type WalEip191Signer,
} from '../src/protocol/signatures.js';
import { verifyWalObjectV1 } from '../src/protocol/wal-object.js';
import { createRdfPolicyV1 } from '../src/rdf/policy.js';
import { hashBytes } from '../src/reconciliation/hash.js';
import { walObjectId } from '../src/reconciliation/ids.js';
import { PackedWalObjectStore } from '../src/store/packed-store.js';

const vectors = JSON.parse(await readFile(
  new URL('../../../conformance/wal-v1/vectors/protocol-v1.json', import.meta.url),
  'utf8',
));
const roots: string[] = [];
const controls: WalControlStore[] = [];
const stores: PackedWalObjectStore[] = [];

afterEach(async () => {
  for (const control of controls.splice(0)) control.close();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function fromHex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.startsWith('0x') ? value.slice(2) : value, 'hex'));
}

function digest(label: string): Uint8Array {
  return hashBytes(new TextEncoder().encode(`wal-local-commit-test-v1\0${label}`));
}

const privateKey = fromHex(vectors.fixturePrivateKey);
const zero = new Uint8Array(32);
const writerId = recoverEip191Address(zero, signEip191DigestWithPrivateKey(zero, privateKey));
const signer: WalEip191Signer = {
  address: writerId,
  signMessage: value => signEip191DigestWithPrivateKey(value, privateKey),
};

async function setup(label: string, controlOptions: Partial<ConstructorParameters<typeof WalControlStore>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), `dkg-wal-local-${label}-`));
  roots.push(root);
  const store = new PackedWalObjectStore({ root });
  stores.push(store);
  const control = new WalControlStore({ root, ...controlOptions });
  controls.push(control);
  return { root, store, control };
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const part of source) { parts.push(part); length += part.length; }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

describe('WalLocalCommitter', () => {
  it('validates its boundary, recovery limit, logical keys, and admitted RDF policy', async () => {
    const { control } = await setup('validation');
    expect(() => new WalLocalCommitter(undefined as never)).toThrow(
      'WalLocalCommitter requires a control store',
    );
    for (const maximumPostCommitAttempts of [0, Number.NaN]) {
      expect(() => new WalLocalCommitter({ control, maximumPostCommitAttempts })).toThrow(
        'maximumPostCommitAttempts must be a positive safe integer',
      );
    }
    const committer = new WalLocalCommitter({ control, maximumPostCommitAttempts: 2 });
    expect(committer.localHeads(digest('valid-namespace'), digest('valid-empty-key'))).toEqual([]);
    expect(() => committer.localHeads(new Uint8Array(31), digest('valid-empty-key'))).toThrow(
      'namespaceId must be exactly 32 bytes',
    );
    expect(() => committer.localHeads(digest('valid-namespace'), new Uint8Array(31))).toThrow(
      'logicalKey must be exactly 32 bytes',
    );
    expect(() => committer.recoverPostCommitWork(0)).toThrow(
      'post-commit recovery limit must be a positive safe integer',
    );
    expect(() => committer.recoverPostCommitWork(Number.NaN)).toThrow(
      'post-commit recovery limit must be a positive safe integer',
    );
    await expect(committer.commitEncoded({
      namespaceId: digest('invalid-namespace'),
      writerId,
      writerEpoch: 0n,
      logicalKey: new Uint8Array(31),
      payloadBytes: Uint8Array.of(1),
      signer,
      idempotencyKey: 'invalid-logical-key',
      requestDigest: digest('invalid-logical-key'),
    })).rejects.toThrow('logicalKey must be exactly 32 bytes');
    await expect(committer.commitRdf({
      policyAdmission: undefined as never,
    } as never)).rejects.toThrow('current admitted RDF policy is required');
  });

  it('queues only after commit, treats checkpoint nudges as best effort, and returns stable API truth', async () => {
    const { store, control } = await setup('receipt', { now: () => 1_000 });
    let nudges = 0;
    const committer = new WalLocalCommitter({
      control,
      now: () => 1_001,
      sendCheckpointNudge: () => {
        nudges += 1;
        if (nudges === 1) throw new Error('nudge unavailable');
      },
    });
    const input = {
      namespaceId: digest('namespace'),
      writerId,
      writerEpoch: 0n,
      logicalKey: digest('logical-key'),
      payloadBytes: new TextEncoder().encode('complete-payload-envelope'),
      signer,
      idempotencyKey: 'request-1',
      requestDigest: digest('request-1'),
    } as const;
    const first = await committer.commitEncoded(input);
    expect(first).toEqual(expect.objectContaining({
      walStatus: 'committed',
      materializationStatus: 'pending',
      nudgeStatus: 'failed',
      nudgeError: 'nudge unavailable',
      sequence: 0n,
    }));
    expect(verifyWalObjectV1(await collect(store.read(walObjectId(first.walObjectId)))).payloadBytes)
      .toEqual(input.payloadBytes);
    expect(control.getLocalCommitWork(first.walObjectId)).toEqual(expect.objectContaining({ state: 'QUEUED' }));
    expect(control.leaseRetry(10, 1_001)).toEqual(expect.objectContaining({
      key: `wal-replay:${Buffer.from(input.namespaceId).toString('hex')}:${Buffer.from(input.logicalKey).toString('hex')}`,
      kind: 'WAL_REPLAY_LOGICAL_KEY',
    }));

    control.setLocalCommitWorkState({
      objectId: first.walObjectId,
      expected: ['QUEUED'],
      state: 'MATERIALIZED',
      updatedAtMs: 1_002,
    });
    const replay = await committer.commitEncoded(input);
    expect(replay).toEqual(expect.objectContaining({
      walStatus: 'already-committed',
      materializationStatus: 'materialized',
      nudgeStatus: 'sent',
      walObjectId: first.walObjectId,
    }));
  });

  it('keeps a bounded blocked outbox visible and recovers it after queue pressure clears', async () => {
    const { control } = await setup('blocked', { maximumQueueEntries: 1, now: () => 2_000 });
    control.enqueueRetry({ key: 'occupied', kind: 'TEST', payload: Uint8Array.of(1), maximumAttempts: 1 });
    const committer = new WalLocalCommitter({ control, now: () => 2_001 });
    const receipt = await committer.commitEncoded({
      namespaceId: digest('blocked-namespace'),
      writerId,
      writerEpoch: 0n,
      logicalKey: digest('blocked-logical-key'),
      payloadBytes: Uint8Array.of(1, 2, 3),
      signer,
      idempotencyKey: 'blocked-request',
      requestDigest: digest('blocked-request'),
    });
    expect(receipt).toEqual(expect.objectContaining({
      walStatus: 'committed',
      materializationStatus: 'blocked',
      nudgeStatus: 'not-configured',
    }));
    expect(receipt.shadowError).toMatch(/queue limit exceeded/);
    expect(control.getLocalCommitWork(receipt.walObjectId)).toEqual(expect.objectContaining({
      state: 'BLOCKED',
    }));

    const occupied = control.leaseRetry(10, 2_001)!;
    control.completeRetry(occupied.key);
    expect(committer.recoverPostCommitWork()).toEqual({ queued: 1, blocked: 0, remaining: 0 });
    expect(control.getLocalCommitWork(receipt.walObjectId)).toEqual(expect.objectContaining({
      state: 'QUEUED', lastError: null,
    }));
  });

  it('bounds non-Error nudge diagnostics without changing the durable commit', async () => {
    const { control } = await setup('long-nudge');
    const committer = new WalLocalCommitter({
      control,
      sendCheckpointNudge: () => { throw 'x'.repeat(2_000); },
    });
    const receipt = await committer.commitEncoded({
      namespaceId: digest('long-nudge-namespace'),
      writerId,
      writerEpoch: 0n,
      logicalKey: digest('long-nudge-key'),
      payloadBytes: Uint8Array.of(4),
      signer,
      idempotencyKey: 'long-nudge',
      requestDigest: digest('long-nudge'),
    });
    expect(receipt.nudgeStatus).toBe('failed');
    expect(receipt.nudgeError).toHaveLength(1_024);
    expect(control.getLocalCommitWork(receipt.walObjectId)?.state).toBe('QUEUED');
  });

  it('fails visibly if the durable outbox invariant is violated after commit', async () => {
    const { control } = await setup('missing-outbox');
    const original = control.getLocalCommitWork.bind(control);
    let reads = 0;
    (control as unknown as { getLocalCommitWork: typeof control.getLocalCommitWork }).getLocalCommitWork = id => {
      reads += 1;
      return reads === 1 ? null : original(id);
    };
    const committer = new WalLocalCommitter({ control });
    await expect(committer.commitEncoded({
      namespaceId: digest('missing-outbox-namespace'),
      writerId,
      writerEpoch: 0n,
      logicalKey: digest('missing-outbox-key'),
      payloadBytes: Uint8Array.of(5),
      signer,
      idempotencyKey: 'missing-outbox',
      requestDigest: digest('missing-outbox'),
    })).rejects.toThrow('durable local commit is missing its post-commit outbox row');
  });

  it('keeps pending work recoverable when post-commit error bookkeeping races or also fails', async () => {
    const failedBookkeeping = await setup('bookkeeping-failure', { maximumQueueEntries: 1 });
    failedBookkeeping.control.enqueueRetry({
      key: 'occupied-bookkeeping', kind: 'TEST', payload: Uint8Array.of(1), maximumAttempts: 1,
    });
    (failedBookkeeping.control as unknown as {
      setLocalCommitWorkState: typeof failedBookkeeping.control.setLocalCommitWorkState;
    }).setLocalCommitWorkState = () => { throw new Error('bookkeeping unavailable'); };
    const failedReceipt = await new WalLocalCommitter({ control: failedBookkeeping.control }).commitEncoded({
      namespaceId: digest('bookkeeping-namespace'),
      writerId,
      writerEpoch: 0n,
      logicalKey: digest('bookkeeping-key'),
      payloadBytes: Uint8Array.of(6),
      signer,
      idempotencyKey: 'bookkeeping-failure',
      requestDigest: digest('bookkeeping-failure'),
    });
    expect(failedReceipt).toEqual(expect.objectContaining({
      materializationStatus: 'pending',
      shadowError: expect.stringMatching(/queue limit exceeded/),
    }));

    const raced = await setup('bookkeeping-race', { maximumQueueEntries: 1 });
    raced.control.enqueueRetry({
      key: 'occupied-race', kind: 'TEST', payload: Uint8Array.of(1), maximumAttempts: 1,
    });
    const original = raced.control.getLocalCommitWork.bind(raced.control);
    let reads = 0;
    (raced.control as unknown as { getLocalCommitWork: typeof raced.control.getLocalCommitWork }).getLocalCommitWork = id => {
      reads += 1;
      return reads === 2 ? null : original(id);
    };
    const racedReceipt = await new WalLocalCommitter({ control: raced.control }).commitEncoded({
      namespaceId: digest('race-namespace'),
      writerId,
      writerEpoch: 0n,
      logicalKey: digest('race-key'),
      payloadBytes: Uint8Array.of(7),
      signer,
      idempotencyKey: 'bookkeeping-race',
      requestDigest: digest('bookkeeping-race'),
    });
    expect(racedReceipt.materializationStatus).toBe('pending');
  });

  it('recovers a crash between durable local commit and post-commit queue insertion without decoding RDF', async () => {
    const { control } = await setup('recover', { now: () => 3_000 });
    const logicalKey = digest('recover-logical-key');
    const committed = await control.commitLocal({
      namespaceId: digest('recover-namespace'),
      writerId,
      writerEpoch: 0n,
      payloadBytes: Uint8Array.of(9),
      signer,
      idempotencyKey: 'recover-request',
      requestDigest: digest('recover-request'),
      logicalKey,
    });
    expect(control.getLocalCommitWork(committed.objectId)?.state).toBe('PENDING');

    const committer = new WalLocalCommitter({ control, now: () => 3_001 });
    expect(committer.recoverPostCommitWork()).toEqual({ queued: 1, blocked: 0, remaining: 0 });
    expect(control.getLocalCommitWork(committed.objectId)?.state).toBe('QUEUED');
  });

  it('marks durable recovery work blocked while queue pressure remains', async () => {
    const { control } = await setup('recover-blocked', { maximumQueueEntries: 1, now: () => 3_500 });
    control.enqueueRetry({ key: 'occupied-recovery', kind: 'TEST', payload: Uint8Array.of(1), maximumAttempts: 1 });
    const committed = await control.commitLocal({
      namespaceId: digest('recover-blocked-namespace'),
      writerId,
      writerEpoch: 0n,
      payloadBytes: Uint8Array.of(8),
      signer,
      idempotencyKey: 'recover-blocked',
      requestDigest: digest('recover-blocked'),
      logicalKey: digest('recover-blocked-key'),
    });
    const committer = new WalLocalCommitter({ control, now: () => 3_501 });
    expect(committer.recoverPostCommitWork()).toEqual({ queued: 0, blocked: 1, remaining: 1 });
    expect(control.getLocalCommitWork(committed.objectId)).toEqual(expect.objectContaining({
      state: 'BLOCKED', lastError: expect.stringMatching(/queue limit exceeded/),
    }));
  });

  it('does not overwrite post-commit work that another recovery worker already queued', async () => {
    const { control } = await setup('recover-race');
    const committed = await control.commitLocal({
      namespaceId: digest('recover-race-namespace'),
      writerId,
      writerEpoch: 0n,
      payloadBytes: Uint8Array.of(9),
      signer,
      idempotencyKey: 'recover-race',
      requestDigest: digest('recover-race'),
      logicalKey: digest('recover-race-key'),
    });
    (control as unknown as { enqueueRetry: typeof control.enqueueRetry }).enqueueRetry = () => {
      throw new Error('simulated queue race');
    };
    const original = control.getLocalCommitWork.bind(control);
    (control as unknown as { getLocalCommitWork: typeof control.getLocalCommitWork }).getLocalCommitWork = id => {
      const work = original(id);
      return work === null ? null : { ...work, state: 'QUEUED' };
    };
    expect(new WalLocalCommitter({ control }).recoverPostCommitWork()).toEqual({
      queued: 0, blocked: 1, remaining: 1,
    });
    expect(original(committed.objectId)?.state).toBe('PENDING');
  });

  it('uses the admitted policy and accepted-outcome encoder before entering the local author lane', async () => {
    const { store, control } = await setup('rdf', { now: () => 4_000 });
    const namespaceId = digest('rdf-namespace');
    const policy = createRdfPolicyV1({
      allowedGraphPrefixes: ['https://example.com/graph/'],
      maxQuadsPerMutation: 100n,
      maxWalObjectBytes: 100_000n,
      allowedPayloadKinds: [0n, 1n],
    });
    const policyPayload = new TextEncoder().encode('admitted-policy-placeholder');
    const policyCommit = await control.commitLocal({
      namespaceId,
      writerId,
      writerEpoch: 0n,
      payloadBytes: policyPayload,
      signer,
      idempotencyKey: 'policy',
      requestDigest: digest('policy'),
    });
    const policyBytes = await collect(store.read(walObjectId(policyCommit.objectId)));
    const committer = new WalLocalCommitter({ control, now: () => 4_001 });
    const graph = 'https://example.com/graph/data';
    const subject = 'https://example.com/entity/1';
    const committed = await committer.commitRdf({
      policyAdmission: {
        policyObjectId: policyCommit.objectId,
        policy,
        membershipCheckpointId: digest('membership'),
        namespaceId,
        policyNamespaceId: namespaceId,
        writerId,
        canonicalWalObjectBytes: policyBytes,
      },
      writerId,
      writerEpoch: 0n,
      signer,
      idempotencyKey: 'rdf-put',
      mutation: {
        operation: 'PUT',
        logicalKey: {
          contextGraphId: 'cg-1',
          subGraphName: null,
          authorAddress: writerId,
          knowledgeAssetUalOrRootEntity: subject,
        },
        memberWriterIds: [writerId],
        baseHeads: [],
        baseNQuads: '',
        allowedGraphIris: [graph],
        source: {
          kind: 'replace',
          subjects: [{
            graphIri: graph,
            subjectIri: subject,
            nquads: `<${subject}> <https://example.com/predicate> "value" <${graph}> .`,
          }],
        },
      },
    });
    expect(committed.receipt).toEqual(expect.objectContaining({
      walStatus: 'committed', materializationStatus: 'pending', sequence: 1n,
    }));
    const object = verifyWalObjectV1(
      await collect(store.read(walObjectId(committed.receipt.walObjectId))),
    );
    const envelope = decodeDkgPayloadEnvelope(object.payloadBytes);
    expect(envelope.slice(0, 5)).toEqual([
      1n,
      0n,
      0n,
      'application/vnd.origintrail.dkg-mutation-v1+cbor',
      null,
    ]);
    const mutation = decodeProtocolTuple('DkgMutationV1', envelope[5]);
    expect(mutation[2]).toEqual(committed.encoded.logicalKey);
    expect(mutation[5]).toEqual(policyCommit.objectId);
  });

  it('encrypts private accepted outcomes only after the author sequence is allocated', async () => {
    const { store, control } = await setup('private-rdf', { now: () => 5_000 });
    const namespaceId = digest('private-rdf-namespace');
    const policy = createRdfPolicyV1({
      allowedGraphPrefixes: ['https://example.com/private/'],
      maxQuadsPerMutation: 100n,
      maxWalObjectBytes: 100_000n,
      allowedPayloadKinds: [0n, 1n],
    });
    const policyCommit = await control.commitLocal({
      namespaceId,
      writerId,
      writerEpoch: 0n,
      payloadBytes: new TextEncoder().encode('private-policy-placeholder'),
      signer,
      idempotencyKey: 'private-policy',
      requestDigest: digest('private-policy'),
    });
    const policyBytes = await collect(store.read(walObjectId(policyCommit.objectId)));
    const graph = 'https://example.com/private/data';
    const subject = 'https://example.com/private/entity/1';
    const epochKey = new Uint8Array(32).fill(0x45);
    const nonce = new Uint8Array(12).fill(0x67);
    const committer = new WalLocalCommitter({ control, now: () => 5_001 });
    const input = {
      policyAdmission: {
        policyObjectId: policyCommit.objectId,
        policy,
        membershipCheckpointId: digest('private-membership'),
        namespaceId,
        policyNamespaceId: namespaceId,
        writerId,
        canonicalWalObjectBytes: policyBytes,
      },
      writerId,
      writerEpoch: 0n,
      signer,
      idempotencyKey: 'private-rdf-put',
      privatePayload: { epochKey, keyEpoch: 9n, nonce },
      mutation: {
        operation: 'PUT' as const,
        logicalKey: {
          contextGraphId: 'private-cg',
          subGraphName: null,
          authorAddress: writerId,
          knowledgeAssetUalOrRootEntity: subject,
        },
        memberWriterIds: [writerId],
        baseHeads: [],
        baseNQuads: '',
        allowedGraphIris: [graph],
        source: {
          kind: 'replace' as const,
          subjects: [{
            graphIri: graph,
            subjectIri: subject,
            nquads: `<${subject}> <https://example.com/private/predicate> "secret" <${graph}> .`,
          }],
        },
      },
    };
    const committed = await committer.commitRdf(input);
    expect(committed.receipt.sequence).toBe(1n);
    const object = verifyWalObjectV1(
      await collect(store.read(walObjectId(committed.receipt.walObjectId))),
    );
    expect(decodeDkgPayloadEnvelope(object.payloadBytes)[4]).not.toBeNull();
    expect(decryptPrivateDkgPayload({
      namespaceId,
      writerId,
      writerEpoch: 0n,
      sequence: committed.receipt.sequence,
      epochKey,
      envelopeBytes: object.payloadBytes,
      expectedKeyEpoch: 9n,
      expectedPayloadKind: 0n,
      expectedCodec: 0n,
      expectedMediaType: 'application/vnd.origintrail.dkg-mutation-v1+cbor',
    })).toEqual(committed.encoded.contentBytes);

    const automaticSubject = 'https://example.com/private/entity/automatic-nonce';
    const automatic = await committer.commitRdf({
      ...input,
      idempotencyKey: 'private-rdf-put-automatic-nonce',
      privatePayload: { epochKey, keyEpoch: 9n },
      mutation: {
        ...input.mutation,
        logicalKey: {
          ...input.mutation.logicalKey,
          knowledgeAssetUalOrRootEntity: automaticSubject,
        },
        source: {
          kind: 'replace',
          subjects: [{
            graphIri: graph,
            subjectIri: automaticSubject,
            nquads: `<${automaticSubject}> <https://example.com/private/predicate> "secret" <${graph}> .`,
          }],
        },
      },
    });
    const automaticObject = verifyWalObjectV1(
      await collect(store.read(walObjectId(automatic.receipt.walObjectId))),
    );
    expect(decryptPrivateDkgPayload({
      namespaceId,
      writerId,
      writerEpoch: 0n,
      sequence: automatic.receipt.sequence,
      epochKey,
      envelopeBytes: automaticObject.payloadBytes,
      expectedKeyEpoch: 9n,
      expectedPayloadKind: 0n,
      expectedCodec: 0n,
      expectedMediaType: 'application/vnd.origintrail.dkg-mutation-v1+cbor',
    })).toEqual(automatic.encoded.contentBytes);

    const replay = await committer.commitRdf(input);
    expect(replay.receipt).toEqual(expect.objectContaining({
      walStatus: 'already-committed',
      walObjectId: committed.receipt.walObjectId,
    }));
    await expect(committer.commitRdf({
      ...input,
      privatePayload: { ...input.privatePayload, keyEpoch: 10n },
    })).rejects.toMatchObject({ code: 'WAL_CONTROL_IDEMPOTENCY_CONFLICT' });
  });
});
