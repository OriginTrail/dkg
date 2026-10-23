import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { hexlify } from 'ethers';
import { confirmedLifecycleRecoveryFixture } from './confirmed-lifecycle-recovery-fixture.js';
import { confirmedNamedKaVmLifecycleInput } from '../../src/named-ka-vm-lifecycle-evidence.js';

export function confirmedMaterializationFixture(privateContent = false, subGraphName?: string, assertionVersion = '1') {
  const { publication, input: coordinates } = confirmedLifecycleRecoveryFixture();
  const publicQuads = [{ subject: 'urn:payload', predicate: 'urn:value', object: '"original public payload"', graph: '' }];
  const privateMerkleRoot = privateContent ? new Uint8Array(32).fill(0x35) : undefined;
  const merkleRoot = computeFlatKCRootV10(publicQuads, privateMerkleRoot ? [privateMerkleRoot] : []);
  const confirmed = { ...publication, merkleRoot, seal: { ...publication.seal, assertionVersion, merkleRoot,
    privateMerkleRoot, privateTripleCount: privateContent ? 2 : 0 } };
  const input = confirmedNamedKaVmLifecycleInput(confirmed, { ...coordinates, subGraphName }, {
    publicQuads, publisherPeerId: 'test-publisher', accessPolicy: 'allowList', allowedPeers: ['test-reader'],
  });
  const graph = input.materialization!.metadataQuads.find(q => q.predicate === 'http://dkg.io/ontology/assertionGraph')!.object;
  const chain = { getEvmChainId: async () => BigInt(input.publicationDeployment.chainId),
    getKnowledgeAssetsLifecycleAddress: async () => input.publicationDeployment.lifecycleAddress,
    readKnowledgeAssetVersionSnapshot: async () => ({ rootCount: BigInt(input.assertionVersion), latestRoot: hexlify(merkleRoot), latestAuthor: input.agentAddress, latestPublisher: input.agentAddress, blockNumber: 12 }) };
  return { input, publicQuads, graph, chain };
}
