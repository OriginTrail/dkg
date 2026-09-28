import { describe, expect, it } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import { overlayLocallyTrustedKnowledgeAssetControls } from '../src/index.js';

const UAL = 'did:dkg:evm:31337/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7';
const META_GRAPH = 'did:dkg:context-graph:local-control-overlay/_meta';
const DKG = 'http://dkg.io/ontology/';

function metadata(predicate: string, object: string): Quad {
  return { subject: UAL, predicate: `${DKG}${predicate}`, object, graph: META_GRAPH };
}

describe('locally trusted KA control overlay', () => {
  it('keeps incoming metadata when there is no matching local sidecar', () => {
    const incoming = [metadata('accessPolicy', '"ownerOnly"')];
    expect(overlayLocallyTrustedKnowledgeAssetControls(incoming, [])).toEqual(incoming);
  });

  it('replaces the complete incoming policy, peer set, and publisher', () => {
    const structural = metadata('assertionVersion', '"1"');
    const incoming = [
      structural,
      metadata('accessPolicy', '"allowList"'),
      metadata('allowedPeer', '"untrusted-peer"'),
      metadata('publisherPeerId', '"untrusted-publisher"'),
    ];
    const trusted = [
      metadata('accessPolicy', '"allowList"'),
      metadata('allowedPeer', '"trusted-peer"'),
      metadata('publisherPeerId', '"trusted-publisher"'),
    ];

    expect(overlayLocallyTrustedKnowledgeAssetControls(incoming, trusted)).toEqual([
      structural,
      ...trusted,
    ]);
  });
});
