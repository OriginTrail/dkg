export const BASE_TESTNET_FALLBACK_UAL =
  'did:dkg:base:84532/0x4c92aee34bad19c3c51b632a0d48872dbdb02495/177';

export function getBaseTestnetPublishConfig(env = process.env) {
  return {
    title: 'DKG Asset Lifecycle on Base Testnet',
    blockchainName: 'v10:base:84532',
    // 'jenkins-publish-tests' is our public open-publish CG on Base Sepolia.
    contextGraphId: env.DKG_CONTEXT_GRAPH_ID || 'jenkins-publish-tests',
    // Query Remote selects an arbitrary one of the other beacon nodes. Make
    // that assertion valid by ensuring every possible receiver actively hosts
    // and syncs the CG before any parallel publish stage starts.
    remoteQuerySubscribeAll: true,
    // Jenkins may override the known-good default without changing this branch.
    fallbackUal: env.DKG_FALLBACK_UAL || BASE_TESTNET_FALLBACK_UAL,
    nodes: [
      { name: 'TestNode1', hostname: env.TESTNET1_API_URL || 'http://100.99.142.87:9200',  token: env.V10_TOKEN_TESTNET1 },
      { name: 'TestNode2', hostname: env.TESTNET2_API_URL || 'http://100.70.65.41:9200',   token: env.V10_TOKEN_TESTNET2 },
      { name: 'TestNode3', hostname: env.TESTNET3_API_URL || 'http://100.120.12.74:9200',  token: env.V10_TOKEN_TESTNET3 },
      { name: 'TestNode4', hostname: env.TESTNET4_API_URL || 'http://100.65.228.120:9200', token: env.V10_TOKEN_TESTNET4 },
    ],
  };
}
