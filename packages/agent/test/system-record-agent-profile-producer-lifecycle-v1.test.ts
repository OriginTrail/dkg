import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { type PreparedAgentProfileV1 } from '../src/profile.js';
import {
  DEPLOYMENT,
  NETWORK,
  createFixtureAgentProfileProducerV1 as createAgentProfileProducerV1,
  producerFixture,
} from './support/agent-profile-producer-v1-fixture.js';


describe('agent-profile system-record producer V1 lifecycle and schema admission', () => {
  it('fences before publication and an aborted lease releases the local single-flight', async () => {
    const fixture = await producerFixture();
    const fence = vi.fn();
    const install = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence,
      install,
    });
    const first = await producer.prepare(fixture.prepared);
    expect(fence).toHaveBeenCalledTimes(1);
    await expect(producer.prepare(fixture.prepared)).rejects.toThrow(/busy/);
    first.abort();
    const retry = await producer.prepare(fixture.prepared);
    retry.abort();
    expect(fence).toHaveBeenCalledTimes(2);
    expect(install).not.toHaveBeenCalled();
  });

  it('releases the local single-flight when the publication fence rejects', async () => {
    const fixture = await producerFixture();
    const fence = vi.fn()
      .mockRejectedValueOnce(new Error('transient fence failure'))
      .mockResolvedValue(undefined);
    const install = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence,
      install,
    });

    await expect(producer.prepare(fixture.prepared)).rejects.toThrow(/transient fence failure/);
    const retry = await producer.prepare(fixture.prepared);
    retry.abort();
    expect(fence).toHaveBeenCalledTimes(2);
    expect(install).not.toHaveBeenCalled();
    expect(fixture.store.snapshot().currentHead).toBeNull();
  });

  it('aborts a reserved commit when cancellation races a blocked install', async () => {
    const fixture = await producerFixture();
    const installStarted = Promise.withResolvers<void>();
    const releaseInstall = Promise.withResolvers<void>();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install: async ({ signal }) => {
        installStarted.resolve();
        await releaseInstall.promise;
        signal.throwIfAborted();
      },
    });

    const lease = await producer.prepare(fixture.prepared);
    const completion = lease.complete(fixture.publication);
    await installStarted.promise;
    lease.abort(new Error('cancel blocked install'));
    releaseInstall.resolve();

    await expect(completion).rejects.toThrow(/cancel blocked install/);
    expect(fixture.store.snapshot().currentHead).toBeNull();
    expect(fixture.store.snapshot().inventory).toBeNull();

    const retry = await producer.prepare(fixture.prepared);
    await expect(retry.complete(fixture.publication)).resolves.toMatchObject({ version: '0' });
  });

  it('commits the advertisement when cancellation arrives after successful installation', async () => {
    const fixture = await producerFixture();
    let lease: Awaited<ReturnType<typeof producer.prepare>>;
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install: () => { lease.abort(new Error('late cancellation')); },
    });

    lease = await producer.prepare(fixture.prepared);
    await expect(lease.complete(fixture.publication)).resolves.toMatchObject({ version: '0' });
    expect(fixture.store.snapshot().currentHead?.object.version).toBe('0');
    expect(fixture.store.snapshot().inventory).not.toBeNull();
  });

  it('rejects duplicate canonical profile triples before fencing publication', async () => {
    const fixture = await producerFixture();
    const fence = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence,
      install: () => {},
    });
    const duplicate = Object.freeze({
      ...fixture.prepared,
      projectionQuads: Object.freeze([
        ...fixture.prepared.projectionQuads,
        fixture.prepared.projectionQuads[0]!,
      ]),
    });

    await expect(producer.prepare(duplicate)).rejects.toThrow(/duplicate-free/);
    expect(fence).not.toHaveBeenCalled();
  });

  it('rejects an out-of-schema profile predicate before fencing publication', async () => {
    const fixture = await producerFixture();
    const fence = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence,
      install: () => {},
    });
    const outOfSchema = Object.freeze({
      ...fixture.prepared,
      projectionQuads: Object.freeze([
        ...fixture.prepared.projectionQuads,
        Object.freeze({
          subject: fixture.prepared.rootEntity,
          predicate: 'https://example.org/unapproved',
          object: '"x"',
          graph: '',
        }),
      ]),
    });

    await expect(producer.prepare(outOfSchema)).rejects.toThrow(/outside schema V1/);
    expect(fence).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'a literal profile link',
      mutate: (prepared: PreparedAgentProfileV1) => prepared.projectionQuads.map((quad) => (
        quad.predicate === 'http://www.w3.org/ns/prov#wasGeneratedBy'
          ? { ...quad, object: '"not-an-iri"' }
          : quad
      )),
    },
    {
      label: 'an unapproved rdf:type object',
      mutate: (prepared: PreparedAgentProfileV1) => prepared.projectionQuads.map((quad) => (
        quad.subject === prepared.rootEntity
          && quad.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
          && quad.object === 'https://dkg.network/ontology#Agent'
          ? { ...quad, object: 'https://example.org/InvalidAgentType' }
          : quad
      )),
    },
    {
      label: 'an underived x25519 revocation subject',
      mutate: (prepared: PreparedAgentProfileV1) => [
        ...prepared.projectionQuads,
        {
          subject: prepared.rootEntity,
          predicate: 'https://dkg.network/ontology#publicEncryptionKey',
          object: `"${Buffer.alloc(32, 9).toString('base64url')}"`,
          graph: '',
        },
        {
          subject: `${prepared.rootEntity}#x25519-${'0'.repeat(32)}`,
          predicate: 'https://dkg.network/ontology#revokedAt',
          object: '"2026-08-07T12:00:00Z"',
          graph: '',
        },
      ],
    },
  ])('rejects $label before fencing publication', async ({ mutate }) => {
    const fixture = await producerFixture();
    const fence = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence,
      install: () => {},
    });
    const malformed = Object.freeze({
      ...fixture.prepared,
      projectionQuads: Object.freeze(mutate(fixture.prepared)),
    });

    await expect(producer.prepare(malformed)).rejects.toThrow(/outside schema V1/);
    expect(fence).not.toHaveBeenCalled();
    expect(fixture.store.snapshot().currentHead).toBeNull();
  });

  it.each([
    ['peerId', '"12D3KooWRhLYc1qpzVncrVpMkykB3ML1PoQ9G9gX9X9G9gX9X9G"'],
    ['agentAddress', `"0x${'33'.repeat(20)}"`],
    ['publicKey', '"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="'],
  ])('rejects a mismatched advertised %s before fencing publication', async (field, object) => {
    const fixture = await producerFixture();
    const fence = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence,
      install: () => {},
    });
    const predicate = `https://dkg.network/ontology#${field}`;
    const mismatched = Object.freeze({
      ...fixture.prepared,
      projectionQuads: Object.freeze(fixture.prepared.projectionQuads.map((quad) => Object.freeze(
        quad.predicate === predicate ? { ...quad, object } : quad,
      ))),
    });

    await expect(producer.prepare(mismatched)).rejects.toThrow(/does not bind the signed/);
    expect(fence).not.toHaveBeenCalled();
  });

  it.each([
    ['peerId', '"12D3KooWRhLYc1qpzVncrVpMkykB3ML1PoQ9G9gX9X9G9gX9X9G"'],
    ['agentAddress', `"0x${'33'.repeat(20)}"`],
    ['publicKey', '"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="'],
  ])('rejects a conflicting advertised %s before fencing publication', async (field, object) => {
    const fixture = await producerFixture();
    const fence = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence,
      install: () => {},
    });
    const conflicting = Object.freeze({
      ...fixture.prepared,
      projectionQuads: Object.freeze([
        ...fixture.prepared.projectionQuads,
        Object.freeze({
          subject: fixture.prepared.rootEntity,
          predicate: `https://dkg.network/ontology#${field}`,
          object,
          graph: '',
        }),
      ]),
    });

    await expect(producer.prepare(conflicting)).rejects.toThrow(/does not bind the signed/);
    expect(fence).not.toHaveBeenCalled();
  });
});
