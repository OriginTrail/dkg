import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore, LOCAL_TRUSTED_KA_CONTROLS_GRAPH, type Quad } from '@origintrail-official/dkg-storage';
import {
  overlayLocallyTrustedKnowledgeAssetControls, reconcileConfirmedKnowledgeAssetControls, overlaySelectedKnowledgeAssetControls,
  replaceLocallyTrustedKnowledgeAssetControlEnvelope,
  replaceLocallyTrustedKnowledgeAssetControls,
  readLocallyTrustedKnowledgeAssetControlEnvelope,
  toHex,
} from '../src/index.js';

const UAL = 'did:dkg:evm:31337/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7';
const OTHER_UAL = 'did:dkg:evm:31337/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/8';
const META_GRAPH = 'did:dkg:context-graph:local-control-overlay/_meta';
const DKG = 'http://dkg.io/ontology/';
const ROOT = Uint8Array.from([...Array(31).fill(0), 1]);

function metadata(predicate: string, object: string): Quad {
  return { subject: UAL, predicate: `${DKG}${predicate}`, object, graph: META_GRAPH };
}

function incomingMetadata(): Quad[] {
  return [
    metadata('assertionVersion', '"1"^^<http://www.w3.org/2001/XMLSchema#integer>'),
    metadata('merkleRoot', `"${toHex(ROOT)}"`),
    metadata('accessPolicy', '"allowList"'),
    metadata('allowedPeer', '"untrusted-peer"'),
    metadata('publisherPeerId', '"untrusted-publisher"'),
  ];
}

describe('locally trusted KA control overlay', () => {
  it('keeps incoming metadata when there is no matching local sidecar', async () => {
    const store = new OxigraphStore();
    const incoming = incomingMetadata();
    await expect(overlayLocallyTrustedKnowledgeAssetControls(
      store, META_GRAPH, UAL, incoming,
    )).resolves.toEqual(incoming);
  });

  it.each([
    { label: 'another asset', quad: { ...metadata('accessPolicy', '"ownerOnly"'), subject: OTHER_UAL } },
    { label: 'another graph', quad: { ...metadata('accessPolicy', '"ownerOnly"'), graph: `${META_GRAPH}-other` } },
  ])('rejects metadata from $label', async ({ quad }) => {
    const store = new OxigraphStore();
    await expect(overlayLocallyTrustedKnowledgeAssetControls(
      store, META_GRAPH, UAL, [...incomingMetadata(), quad],
    )).rejects.toThrow('requires one asset in one metadata graph');
  });

  it('selects the matching KA sidecar and replaces all incoming controls', async () => {
    const store = new OxigraphStore();
    const anchor = { assertionVersion: '1', merkleRoot: ROOT };
    await replaceLocallyTrustedKnowledgeAssetControlEnvelope(store, OTHER_UAL, anchor, {
      accessPolicy: 'allowList',
      allowedPeers: ['other-asset-peer'],
      publisherPeerId: 'other-asset-publisher',
    });
    await replaceLocallyTrustedKnowledgeAssetControlEnvelope(store, UAL, anchor, {
      accessPolicy: 'allowList',
      allowedPeers: ['trusted-peer'],
      publisherPeerId: 'trusted-publisher',
    });

    const result = await overlayLocallyTrustedKnowledgeAssetControls(
      store, META_GRAPH, UAL, incomingMetadata(),
    );
    expect(result).toHaveLength(5);
    expect(result).toEqual(expect.arrayContaining([
      metadata('assertionVersion', '"1"^^<http://www.w3.org/2001/XMLSchema#integer>'),
      metadata('merkleRoot', `"${toHex(ROOT)}"`),
      metadata('accessPolicy', '"allowList"'),
      metadata('allowedPeer', '"trusted-peer"'),
      metadata('publisherPeerId', '"trusted-publisher"'),
    ]));
    expect(result.every((quad) => quad.subject === UAL && quad.graph === META_GRAPH)).toBe(true);
  });
});

it('a curator publication preserves the authenticated member controls at the same version and root', async () => {
  const store = new OxigraphStore();
  try {
    await replaceLocallyTrustedKnowledgeAssetControlEnvelope(store, UAL, { assertionVersion: '1', merkleRoot: ROOT }, {
      publisherPeerId: 'member-owner', accessPolicy: 'ownerOnly', allowedPeers: [],
    });
    const curatorMetadata = incomingMetadata().map(q => q.predicate.endsWith('/publisherPeerId') ? { ...q, object: '"curator-publisher"' } : q);
    await replaceLocallyTrustedKnowledgeAssetControls(store, UAL, curatorMetadata);
    expect(await readLocallyTrustedKnowledgeAssetControlEnvelope(store, META_GRAPH, UAL, curatorMetadata, {}, 'exact'))
      .toEqual({ publisherPeerId: 'member-owner', accessPolicy: 'ownerOnly', allowedPeers: [] });
    const next = curatorMetadata.map(q => q.predicate.endsWith('/assertionVersion') ? { ...q, object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' } : q);
    await replaceLocallyTrustedKnowledgeAssetControls(store, UAL, next);
    expect(await readLocallyTrustedKnowledgeAssetControlEnvelope(store, META_GRAPH, UAL, next, {}, 'exact'))
      .toEqual({ publisherPeerId: 'curator-publisher', accessPolicy: 'allowList', allowedPeers: ['untrusted-peer'] });
  } finally { await store.close(); }
});

it.each([false, true])('confirmed reconciliation selects exact controls once with existing=%s', async existing => {
  const store = new OxigraphStore(), anchor = { assertionVersion: '1', merkleRoot: ROOT }, incoming = incomingMetadata();
  try {
    if (existing) await replaceLocallyTrustedKnowledgeAssetControlEnvelope(store, UAL, anchor,
      { publisherPeerId: 'member', accessPolicy: 'ownerOnly', allowedPeers: [] });
    const query = vi.spyOn(store, 'query');
    const selected = await reconcileConfirmedKnowledgeAssetControls(store, { metaGraph: META_GRAPH, ual: UAL, anchor,
      metadataQuads: incoming, restoreMissing: true });
    const visible = overlaySelectedKnowledgeAssetControls(incoming, selected);
    expect(query.mock.calls.filter(([sparql]) => sparql.includes(LOCAL_TRUSTED_KA_CONTROLS_GRAPH))).toHaveLength(1);
    expect(visible.filter(q => q.predicate === DKG + 'accessPolicy').map(q => q.object)).toEqual([existing ? '"ownerOnly"' : '"allowList"']);
    expect(await readLocallyTrustedKnowledgeAssetControlEnvelope(store, META_GRAPH, UAL, incoming, {}, 'exact'))
      .toMatchObject({ publisherPeerId: existing ? 'member' : 'untrusted-publisher', accessPolicy: existing ? 'ownerOnly' : 'allowList' });
  } finally { await store.close(); }
});


it('recovery without restoration does not admit or inherit missing exact controls, while ordinary overlay still inherits', async () => {
  const store = new OxigraphStore();
  try {
    await replaceLocallyTrustedKnowledgeAssetControlEnvelope(store, UAL, { assertionVersion: '1', merkleRoot: ROOT }, {
      publisherPeerId: 'earlier-owner', accessPolicy: 'ownerOnly', allowedPeers: [],
    });
    const incoming = incomingMetadata().map(q => q.predicate.endsWith('/assertionVersion')
      ? { ...q, object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' } : q);
    const anchor = { assertionVersion: '2', merkleRoot: ROOT }, insert = vi.spyOn(store, 'insert');
    expect(await reconcileConfirmedKnowledgeAssetControls(store, {
      metaGraph: META_GRAPH, ual: UAL, anchor, metadataQuads: incoming, restoreMissing: false,
    })).toEqual([]);
    expect(insert).not.toHaveBeenCalled();
    expect(await readLocallyTrustedKnowledgeAssetControlEnvelope(store, META_GRAPH, UAL, incoming, {}, 'exact')).toBeUndefined();
    const inherited = await overlayLocallyTrustedKnowledgeAssetControls(store, META_GRAPH, UAL, incoming);
    expect(inherited.filter(q => q.predicate === DKG + 'publisherPeerId').map(q => q.object)).toEqual(['"earlier-owner"']);
    const selected = await reconcileConfirmedKnowledgeAssetControls(store, {
      metaGraph: META_GRAPH, ual: UAL, anchor, metadataQuads: incoming, restoreMissing: true,
    });
    expect(selected.filter(q => q.predicate === DKG + 'publisherPeerId').map(q => q.object)).toEqual(['"untrusted-publisher"']);
    const exact = await readLocallyTrustedKnowledgeAssetControlEnvelope(store, META_GRAPH, UAL, incoming, {}, 'exact');
    expect(exact?.publisherPeerId).toBe('untrusted-publisher');
  } finally { await store.close(); }
});
