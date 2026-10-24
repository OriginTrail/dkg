import { describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  overlayLocallyTrustedKnowledgeAssetControls,
  replaceLocallyTrustedKnowledgeAssetControlEnvelope,
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
