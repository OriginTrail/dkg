import { beforeEach, describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  TypedEventBus,
  ed25519Sign,
  encodeAccessRequest,
  decodeAccessResponse,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  DKGPublisher,
  computePrivateRootV10,
  skolemizeKnowledgeAsset,
} from '../src/index.js';
import { AccessHandler } from '../src/access-handler.js';
import { parseSimpleNQuads } from '../src/publish-handler.js';

const CONTEXT_GRAPH = 'rootless-private-access';
const META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
const AUTHOR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const UAL = `did:dkg:base:8453/${AUTHOR}/77`;

function quad(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: '' };
}

function accessRequestBytes(kaUal: string): Uint8Array {
  return encodeAccessRequest({
    kaUal,
    requesterPeerId: 'graph-scope-requester',
    paymentProof: new Uint8Array(0),
    requesterSignature: new Uint8Array(0),
  });
}

/** Owner-signed request: initial private publishes default to ownerOnly. */
async function ownerAccessRequestBytes(kaUal: string): Promise<Uint8Array> {
  const keypair = await generateEd25519Keypair();
  const signature = await ed25519Sign(
    new TextEncoder().encode(kaUal), // kaUal + hex('') — empty payment proof
    keypair.secretKey,
  );
  return encodeAccessRequest({
    kaUal,
    requesterPeerId: 'rootless-publisher',
    paymentProof: new Uint8Array(0),
    requesterSignature: signature,
    requesterPublicKey: keypair.publicKey,
  });
}

async function publishVersion(
  publisher: DKGPublisher,
  assertionVersion: number,
  publicQuads: Quad[],
  privateQuads: Quad[],
  priorKaId?: bigint,
): Promise<{ kaId: bigint; canonicalPrivate: Quad[]; privateMerkleRoot: Uint8Array }> {
  const canonicalPublic = await skolemizeKnowledgeAsset(publicQuads);
  const canonicalPrivate = await skolemizeKnowledgeAsset(privateQuads);
  const privateMerkleRoot = computePrivateRootV10(canonicalPrivate)!;
  const envelope = {
    contextGraphId: CONTEXT_GRAPH,
    quads: publicQuads,
    privateQuads,
    publisherPeerId: 'rootless-publisher',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: UAL,
    assertionVersion,
    publicTripleCount: canonicalPublic.length,
    privateTripleCount: canonicalPrivate.length,
    privateMerkleRoot,
  };
  const result = priorKaId === undefined
    ? await publisher.publish(envelope)
    : await publisher.update(priorKaId, envelope);
  return { kaId: result.kaId, canonicalPrivate, privateMerkleRoot };
}

describe('graph-scoped KA private access & metadata convergence', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;
  let handler: AccessHandler;

  beforeEach(async () => {
    store = new OxigraphStore();
    publisher = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
    handler = new AccessHandler(store, new TypedEventBus());
  });

  it('serves and verifies private triples for a graph-scoped KA by UAL', async () => {
    const { canonicalPrivate, privateMerkleRoot } = await publishVersion(
      publisher,
      1,
      [quad('urn:public:one', 'urn:predicate:value', '"visible"')],
      [
        quad('urn:private:one', 'urn:predicate:secret', '"alpha"'),
        quad('urn:private:two', 'urn:predicate:link', 'urn:private:one'),
      ],
    );

    // Regression: the rootEntity-joined lookup can never match a graph-scoped
    // KA (it writes no membership rows), which used to deny with "KA not found".
    // Initial private publishes default to ownerOnly, so authenticate as owner.
    const response = decodeAccessResponse(
      await handler.handler(await ownerAccessRequestBytes(UAL), 'rootless-publisher' as never),
    );
    expect(response.rejectionReason).toBe('');
    expect(response.granted).toBe(true);

    const served = parseSimpleNQuads(new TextDecoder().decode(response.nquads));
    expect(served).toHaveLength(canonicalPrivate.length);
    // Physical graph IRIs must not travel on the wire.
    expect(served.every((q) => q.graph === '')).toBe(true);
    expect(new Set(served.map((q) => JSON.stringify([q.subject, q.predicate, q.object]))))
      .toEqual(new Set(canonicalPrivate.map((q) => JSON.stringify([q.subject, q.predicate, q.object]))));

    // The attested root must match both the stored commitment and a client-side
    // recompute over the served triples (AccessClient's verification path).
    expect(Buffer.from(response.privateMerkleRoot).toString('hex'))
      .toBe(Buffer.from(privateMerkleRoot).toString('hex'));
    expect(Buffer.from(computePrivateRootV10(served)!).toString('hex'))
      .toBe(Buffer.from(privateMerkleRoot).toString('hex'));
  });

  it('converges metadata to the newest assertion version and serves it', async () => {
    const v1 = await publishVersion(
      publisher,
      1,
      [quad('urn:public:one', 'urn:predicate:value', '"v1"')],
      [quad('urn:private:one', 'urn:predicate:secret', '"v1-secret"')],
    );
    const v2 = await publishVersion(
      publisher,
      2,
      [quad('urn:public:one', 'urn:predicate:value', '"v2"')],
      [quad('urn:private:one', 'urn:predicate:secret', '"v2-secret"')],
      v1.kaId,
    );
    expect(Buffer.from(v2.privateMerkleRoot).toString('hex'))
      .not.toBe(Buffer.from(v1.privateMerkleRoot).toString('hex'));

    // Regression (stale-row convergence): superseded rows were deleted as
    // default-graph quads, so v1 assertionVersion/privateMerkleRoot/merkleRoot
    // rows survived alongside v2 and readers could bind either value.
    const meta = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${META_GRAPH}> { <${UAL}> ?p ?o } }`,
    );
    expect(meta.type).toBe('bindings');
    if (meta.type !== 'bindings') throw new Error('expected bindings');
    const byPredicate = new Map<string, string[]>();
    for (const row of meta.bindings) {
      const values = byPredicate.get(row['p']) ?? [];
      values.push(row['o']);
      byPredicate.set(row['p'], values);
    }
    for (const single of ['assertionVersion', 'privateMerkleRoot', 'merkleRoot', 'status', 'publicTripleCount', 'privateTripleCount']) {
      const values = byPredicate.get(`http://dkg.io/ontology/${single}`) ?? [];
      expect(values, `predicate ${single} must converge to one row`).toHaveLength(1);
    }
    expect(byPredicate.get('http://dkg.io/ontology/assertionVersion')![0]).toContain('"2"');
    expect(byPredicate.get('http://dkg.io/ontology/privateMerkleRoot')![0])
      .toContain(Buffer.from(v2.privateMerkleRoot).toString('hex'));

    // Access must follow the converged head: v2 secret, v2 attestation.
    // (Owner-authenticated: the update preserves v1's ownerOnly default —
    // the pre-fix behavior where this request succeeded UNSIGNED was the
    // access-policy regression, not the contract.)
    const response = decodeAccessResponse(
      await handler.handler(await ownerAccessRequestBytes(UAL), 'rootless-publisher' as never),
    );
    expect(response.rejectionReason).toBe('');
    expect(response.granted).toBe(true);
    const served = parseSimpleNQuads(new TextDecoder().decode(response.nquads));
    expect(served.map((q) => q.object)).toEqual(['"v2-secret"']);
    expect(Buffer.from(response.privateMerkleRoot).toString('hex'))
      .toBe(Buffer.from(v2.privateMerkleRoot).toString('hex'));
  });

  it('preserves stored access policy and owner across an update that omits policy options', async () => {
    // Publish v1 private with the ownerOnly default.
    const v1 = await publishVersion(
      publisher,
      1,
      [quad('urn:public:one', 'urn:predicate:value', '"v1"')],
      [quad('urn:private:one', 'urn:predicate:secret', '"v1-secret"')],
    );

    // Regression (otReviewAgent 3586192289): a graph-scoped update whose
    // options omit accessPolicy AND publisherPeerId used to converge the
    // metadata row set to the generator defaults — accessPolicy "public",
    // owner "unknown" — silently exposing the private triples.
    const publicQuads = [quad('urn:public:one', 'urn:predicate:value', '"v2"')];
    const privateQuads = [quad('urn:private:one', 'urn:predicate:secret', '"v2-secret"')];
    const canonicalPublic = await skolemizeKnowledgeAsset(publicQuads);
    const canonicalPrivate = await skolemizeKnowledgeAsset(privateQuads);
    await publisher.update(v1.kaId, {
      contextGraphId: CONTEXT_GRAPH,
      quads: publicQuads,
      privateQuads,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 2,
      publicTripleCount: canonicalPublic.length,
      privateTripleCount: canonicalPrivate.length,
      privateMerkleRoot: computePrivateRootV10(canonicalPrivate)!,
    });

    // Stored access rows must be carried forward, not regenerated.
    const meta = await store.query(
      `SELECT ?policy ?peer WHERE { GRAPH <${META_GRAPH}> {
        <${UAL}> <http://dkg.io/ontology/accessPolicy> ?policy .
        <${UAL}> <http://dkg.io/ontology/publisherPeerId> ?peer .
      } }`,
    );
    if (meta.type !== 'bindings') throw new Error('expected bindings');
    expect(meta.bindings.map((b) => b['policy'])).toEqual(['"ownerOnly"']);
    expect(meta.bindings.map((b) => b['peer'])).toEqual(['"rootless-publisher"']);

    // Unsigned non-owner request stays denied after the update…
    const denied = decodeAccessResponse(
      await handler.handler(accessRequestBytes(UAL), 'graph-scope-requester' as never),
    );
    expect(denied.granted).toBe(false);

    // …while the owner still reads the new version.
    const granted = decodeAccessResponse(
      await handler.handler(await ownerAccessRequestBytes(UAL), 'rootless-publisher' as never),
    );
    expect(granted.rejectionReason).toBe('');
    expect(granted.granted).toBe(true);
    const served = parseSimpleNQuads(new TextDecoder().decode(granted.nquads));
    expect(served.map((q) => q.object)).toEqual(['"v2-secret"']);
  });

  it('lets an explicit accessPolicy option override the stored policy on update', async () => {
    const v1 = await publishVersion(
      publisher,
      1,
      [quad('urn:public:one', 'urn:predicate:value', '"v1"')],
      [quad('urn:private:one', 'urn:predicate:secret', '"v1-secret"')],
    );

    const publicQuads = [quad('urn:public:one', 'urn:predicate:value', '"v2"')];
    const privateQuads = [quad('urn:private:one', 'urn:predicate:secret', '"v2-secret"')];
    const canonicalPublic = await skolemizeKnowledgeAsset(publicQuads);
    const canonicalPrivate = await skolemizeKnowledgeAsset(privateQuads);
    await publisher.update(v1.kaId, {
      contextGraphId: CONTEXT_GRAPH,
      quads: publicQuads,
      privateQuads,
      publisherPeerId: 'rootless-publisher',
      accessPolicy: 'public',
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 2,
      publicTripleCount: canonicalPublic.length,
      privateTripleCount: canonicalPrivate.length,
      privateMerkleRoot: computePrivateRootV10(canonicalPrivate)!,
    });

    // Deliberate owner-driven downgrade: unsigned requests are now served.
    const response = decodeAccessResponse(
      await handler.handler(accessRequestBytes(UAL), 'graph-scope-requester' as never),
    );
    expect(response.rejectionReason).toBe('');
    expect(response.granted).toBe(true);
  });

  it('rejects a graph-scoped update whose UAL names a different chain', async () => {
    // Regression (otReviewAgent 3586686572): the packed-id preflight proves
    // author+number but ignored the UAL's chain namespace, so an update could
    // persist/return an identity naming another chain. NoChainAdapter is
    // exempt (no chain identity to disagree with), so pin a chain id.
    const chain = new NoChainAdapter();
    Object.defineProperty(chain, 'chainId', { value: 'base:8453' });
    const chainedPublisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
    const wrongChainUal = `did:dkg:gnosis:100/${AUTHOR}/77`;
    const kaId = (BigInt(AUTHOR) << 96n) | 77n; // same packed id as the UAL derives
    await expect(chainedPublisher.update(kaId, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [quad('urn:public:one', 'urn:predicate:value', '"v2"')],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: wrongChainUal,
      assertionVersion: 2,
      publicTripleCount: 1,
    })).rejects.toThrow(/targets chain gnosis:100/);
  });

  it('fails closed when an interrupted converge leaves conflicting access rows', async () => {
    // Regression (otReviewAgent 3586687232): a converge interrupted between
    // insert-new and delete-stale leaves both policy rows on the subject;
    // the meta reader took accessPolicy off one arbitrary SPARQL binding, so
    // a stale "public" row could be paired with the newest version and expose
    // private triples. Conflicting policies must resolve to ownerOnly.
    const { canonicalPrivate } = await publishVersion(
      publisher,
      1,
      [quad('urn:public:one', 'urn:predicate:value', '"v1"')],
      [quad('urn:private:one', 'urn:predicate:secret', '"v1-secret"')],
    );
    await store.insert([{
      subject: UAL,
      predicate: 'http://dkg.io/ontology/accessPolicy',
      object: '"public"',
      graph: META_GRAPH,
    }]);

    const denied = decodeAccessResponse(
      await handler.handler(accessRequestBytes(UAL), 'graph-scope-requester' as never),
    );
    expect(denied.granted).toBe(false);

    // The unambiguous owner still gets through under the fail-closed policy.
    const granted = decodeAccessResponse(
      await handler.handler(await ownerAccessRequestBytes(UAL), 'rootless-publisher' as never),
    );
    expect(granted.rejectionReason).toBe('');
    expect(granted.granted).toBe(true);
    expect(parseSimpleNQuads(new TextDecoder().decode(granted.nquads)))
      .toHaveLength(canonicalPrivate.length);

    // A conflicting owner identity is ambiguous — nobody passes ownerOnly.
    await store.insert([{
      subject: UAL,
      predicate: 'http://dkg.io/ontology/publisherPeerId',
      object: '"impostor-peer"',
      graph: META_GRAPH,
    }]);
    const ownerDenied = decodeAccessResponse(
      await handler.handler(await ownerAccessRequestBytes(UAL), 'rootless-publisher' as never),
    );
    expect(ownerDenied.granted).toBe(false);
    const impostorDenied = decodeAccessResponse(
      await handler.handler(await ownerAccessRequestBytes(UAL), 'impostor-peer' as never),
    );
    expect(impostorDenied.granted).toBe(false);
  });

  it('denies cleanly when a graph-scoped KA has no private content', async () => {
    await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [quad('urn:public:only', 'urn:predicate:value', '"nothing private"')],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 1,
      publicTripleCount: 1,
    });
    const response = decodeAccessResponse(
      await handler.handler(accessRequestBytes(UAL), 'graph-scope-requester' as never),
    );
    expect(response.granted).toBe(false);
    expect(response.rejectionReason).toContain('No private triples');
  });
});
