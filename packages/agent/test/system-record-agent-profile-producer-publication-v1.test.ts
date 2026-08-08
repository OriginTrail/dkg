import {
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
  type Digest32V1,
  type SignedAgentProfileHeadEnvelopeV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { prepareAgentProfileV1 } from '../src/profile.js';
import type { AgentProfileProducerPublicationArtifactsV1 } from '../src/system-records/agent-profile-producer-api-v1.js';
import { flattenAgentProfileProducerPublicationArtifactsV1 } from '../src/system-records/agent-profile-producer-artifacts-v1-internal.js';
import { type AgentProfileProducerPublicationStoreV1 } from '../src/system-records/agent-profile-producer-v1.js';
import {
  DEPLOYMENT,
  NETWORK,
  createFixtureAgentProfileProducerV1 as createAgentProfileProducerV1,
  controlRequest,
  makePrepared,
  observingStore,
  produce,
  producerFixture,
  publicationFor,
  rootRequest,
} from './support/agent-profile-producer-v1-fixture.js';


describe('agent-profile system-record producer V1 publication and inventory', () => {
  it('flattens every publication artifact group through one ordered path', () => {
    const artifact = (
      objectKind: 'agent-profile-head' | 'profile-bundle' | 'owned-subject-table'
        | 'inventory-internal' | 'inventory-leaf',
      byte: number,
    ) => Object.freeze({
      objectKind,
      objectDigest: `0x${byte.toString(16).padStart(64, '0')}` as Digest32V1,
      canonicalBytes: Uint8Array.of(byte),
    });
    const artifacts = {
      head: artifact('agent-profile-head', 1),
      bundle: artifact('profile-bundle', 2),
      ownedSubjectTable: artifact('owned-subject-table', 3),
      inventoryObjects: Object.freeze([
        artifact('inventory-internal', 4),
        artifact('inventory-leaf', 5),
      ]),
    } as AgentProfileProducerPublicationArtifactsV1;

    expect(flattenAgentProfileProducerPublicationArtifactsV1(artifacts).map(
      ({ objectKind, canonicalBytes }) => [objectKind, canonicalBytes[0]],
    )).toEqual([
      ['agent-profile-head', 1],
      ['profile-bundle', 2],
      ['owned-subject-table', 3],
      ['inventory-internal', 4],
      ['inventory-leaf', 5],
    ]);
  });

  it('stages one exact profile, installs it, then advertises the signed inventory root', async () => {
    const fixture = await producerFixture();
    const events: string[] = [];
    const store = observingStore(fixture.store, events);
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store,
      fence: () => { events.push('fence'); },
      install: (input) => {
        events.push('install');
        expect(input.projectionQuads).toHaveLength(fixture.prepared.projectionQuads.length);
        expect(input.head.rootSubject).toBe(fixture.prepared.rootEntity);
        expect(input.verifiedAuthoritySummary.candidateHeadDigest).toBe(input.envelope.objectDigest);
      },
    });

    const result = await produce(producer, fixture.prepared, fixture.publication);
    expect(result).toMatchObject({ version: '0', authoritySequence: '0' });
    expect(result.inventoryWrites).toBe(2);
    expect(events).toEqual(['fence', 'install', 'advertise']);

    const snapshot = store.snapshot();
    expect(snapshot.currentHead?.objectDigest).toBe(result.headDigest);
    expect(snapshot.inventory?.descriptorDigest).toBe(result.rootDescriptorDigest);
    const head = await store.resolve(controlRequest(result.headDigest), new AbortController().signal);
    expect(head?.objectKind).toBe('agent-profile-head');
    if (head === null) throw new Error('published profile head is missing');
    const parsedHead = parseCanonicalSignedAgentProfileHeadEnvelopeV1(head.canonicalBytes);
    expect(parsedHead.object.version).toBe('0');
    const bundle = await store.resolve({
      type: 'object', objectKind: 'profile-bundle', objectDigest: parsedHead.object.bundleDigest,
    }, new AbortController().signal);
    expect(bundle?.objectKind).toBe('profile-bundle');
    const subjectTable = await store.resolve({
      type: 'object', objectKind: 'owned-subject-table',
      objectDigest: parsedHead.object.ownedSubjectTableDigest,
    }, new AbortController().signal);
    expect(subjectTable?.objectKind).toBe('owned-subject-table');
    const root = await store.resolve(rootRequest(), new AbortController().signal);
    expect(root?.objectKind).toBe('root-descriptor');
    expect(root?.objectDigest).toBe(result.rootDescriptorDigest);
    const inventoryDigest = snapshot.inventory?.descriptor.treeRootDigest;
    const inventoryObject = inventoryDigest === undefined
      ? undefined
      : snapshot.inventory?.objects.get(inventoryDigest);
    expect(inventoryObject).toBeDefined();
    if (inventoryObject === undefined || inventoryDigest === undefined) {
      throw new Error('published inventory object is missing');
    }
    await expect(store.resolve({
      type: 'inventory-object', rootDescriptorDigest: result.rootDescriptorDigest, path: [],
      objectKind: inventoryObject.objectKind, objectDigest: inventoryDigest,
    }, new AbortController().signal)).resolves.toMatchObject({
      objectKind: inventoryObject.objectKind,
      objectDigest: inventoryDigest,
    });
    await expect(store.resolve({
      type: 'inventory-object', rootDescriptorDigest: `0x${'ff'.repeat(32)}`, path: [],
      objectKind: inventoryObject.objectKind, objectDigest: inventoryDigest,
    }, new AbortController().signal)).resolves.toBeNull();
  });

  it('accepts the signed projection for advertised skills and hosted context graphs', async () => {
    const fixture = await producerFixture();
    const prepared = prepareAgentProfileV1({
      peerId: fixture.peerSigner.peerId,
      publicKey: Buffer.from(fixture.peerSigner.publicKey, 'base64url').toString('base64'),
      agentAddress: fixture.evmSigner.address,
      name: 'Feature profile fixture',
      framework: 'Hermes',
      nodeRole: 'edge',
      lastSeen: '2026-08-07T12:00:00.000Z',
      skills: [{
        skillType: 'ImageAnalysis',
        pricePerCall: 1,
        currency: 'TRAC',
        successRate: 0.99,
        pricingModel: 'PerInvocation',
      }],
      contextGraphsServed: ['public-image-analysis'],
    });
    const install = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install,
    });

    await expect(produce(
      producer,
      prepared,
      await publicationFor(prepared, fixture.evmSigner.address, '2026-08-07T12:00:00Z'),
    )).resolves.toMatchObject({ version: '0', authoritySequence: '0' });
    const installedSubjects = new Set(
      install.mock.calls[0]![0].projectionQuads.map((quad) => quad.subject),
    );
    expect(installedSubjects).toContain(`${prepared.rootEntity}/.well-known/genid/cap1`);
    expect(installedSubjects).toContain(`${prepared.rootEntity}/.well-known/genid/offering1`);
    expect(installedSubjects).toContain(`${prepared.rootEntity}/.well-known/genid/hosting`);
  });

  it('advances one COW path for an ordinary same-authority heartbeat', async () => {
    const fixture = await producerFixture();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install: () => {},
    });
    const first = await produce(producer, fixture.prepared, fixture.publication);
    const nextPrepared = makePrepared(
      fixture.peerSigner,
      fixture.evmSigner.address,
      '2026-08-07T12:20:00.000Z',
    );
    const second = await produce(
      producer,
      nextPrepared,
      await publicationFor(nextPrepared, fixture.evmSigner.address, '2026-08-07T12:20:00Z'),
    );

    expect(second.version).toBe('1');
    expect(second.headDigest).not.toBe(first.headDigest);
    expect(second.rootDescriptorDigest).not.toBe(first.rootDescriptorDigest);
    expect(second.inventoryWrites).toBeLessThanOrEqual(6);
    expect(second.inventoryWriteBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(fixture.store.snapshot().inventory?.descriptor.totalRows).toBe('1');
  });

  it('serves an advertised inventory root after a newer root commits', async () => {
    const fixture = await producerFixture();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install: () => {},
    });
    const first = await produce(producer, fixture.prepared, fixture.publication);
    const firstInventory = fixture.store.snapshot().inventory!;
    const firstTreeDigest = firstInventory.descriptor.treeRootDigest;
    const firstTreeObject = firstInventory.objects.get(firstTreeDigest)!;
    const nextPrepared = makePrepared(
      fixture.peerSigner,
      fixture.evmSigner.address,
      '2026-08-07T12:20:00.000Z',
    );

    await produce(
      producer,
      nextPrepared,
      await publicationFor(nextPrepared, fixture.evmSigner.address, '2026-08-07T12:20:00Z'),
    );

    await expect(fixture.store.resolve({
      type: 'inventory-object',
      rootDescriptorDigest: first.rootDescriptorDigest,
      path: [],
      objectKind: firstTreeObject.objectKind,
      objectDigest: firstTreeDigest,
    }, new AbortController().signal)).resolves.toMatchObject({
      objectKind: firstTreeObject.objectKind,
      objectDigest: firstTreeDigest,
    });
    await expect(fixture.store.resolve({
      type: 'inventory-object',
      rootDescriptorDigest: first.rootDescriptorDigest,
      path: [0],
      objectKind: firstTreeObject.objectKind,
      objectDigest: firstTreeDigest,
    }, new AbortController().signal)).resolves.toBeNull();
  });

  it.each([
    [
      'belongs to a different stable record',
      (head: SignedAgentProfileHeadEnvelopeV1): SignedAgentProfileHeadEnvelopeV1 => ({
        ...head,
        object: { ...head.object, peerId: '12D3KooWDifferentStableRecord111111111111111111111111' },
      }),
      /different stable record/,
    ],
    [
      'has an invalid signature',
      (head: SignedAgentProfileHeadEnvelopeV1): SignedAgentProfileHeadEnvelopeV1 => ({
        ...head,
        signatures: head.signatures.map((signature, index) => index === 0
          ? { ...signature, signature: Buffer.alloc(64).toString('base64url') }
          : signature),
      }),
      /stored profile head signature verification failed/,
    ],
  ])('rejects a previous head that %s before installing or committing', async (
    _label,
    mutateHead,
    expected,
  ) => {
    const fixture = await producerFixture();
    const initialProducer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install: () => {},
    });
    await produce(initialProducer, fixture.prepared, fixture.publication);
    const prepareCommit = vi.fn(fixture.store.prepareCommit.bind(fixture.store));
    const store: AgentProfileProducerPublicationStoreV1 = {
      snapshot: () => {
        const snapshot = fixture.store.snapshot();
        return Object.freeze({
          ...snapshot,
          currentHead: mutateHead(snapshot.currentHead!),
        });
      },
      resolveArtifact: (reference) => fixture.store.resolveArtifact(reference),
      prepareCommit,
    };
    const install = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store,
      fence: () => {},
      install,
    });
    const nextPrepared = makePrepared(
      fixture.peerSigner,
      fixture.evmSigner.address,
      '2026-08-07T12:20:00.000Z',
    );
    const lease = await producer.prepare(nextPrepared);

    await expect(lease.complete(await publicationFor(
      nextPrepared,
      fixture.evmSigner.address,
      '2026-08-07T12:20:00Z',
    ))).rejects.toThrow(expected);
    expect(install).not.toHaveBeenCalled();
    expect(prepareCommit).not.toHaveBeenCalled();
  });

});
