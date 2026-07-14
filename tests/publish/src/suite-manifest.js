// Canonical topology for both the chain specs and the CLI suite runner. Adding
// or renaming a node here updates aggregate and single-node entry points alike.
export const CHAIN_SUITE_MANIFEST = {
  'base-mainnet': {
    spec: 'src/Base_Mainnet.spec.js',
    title: 'DKG Asset Lifecycle on Base Mainnet',
    blockchainName: 'v10:base:8453',
    defaultContextGraphId: 'sports',
    nodes: [
      {
        name: 'SBB',
        urlEnv: 'SBB_API_URL',
        defaultHostname: 'http://100.100.87.86:9200',
        tokenEnv: 'V10_TOKEN_SBB',
        reportFilename: 'mainnet_base_sbb',
      },
      {
        name: 'DMaaST',
        urlEnv: 'DMAAST_API_URL',
        defaultHostname: 'http://100.95.129.115:9200',
        tokenEnv: 'V10_TOKEN_DMAAST',
        reportFilename: 'mainnet_base_dmaast',
      },
    ],
  },
  'gnosis-mainnet': {
    spec: 'src/Gnosis_Mainnet.spec.js',
    title: 'DKG Asset Lifecycle on Gnosis Mainnet',
    blockchainName: 'v10:gnosis:100',
    defaultContextGraphId: 'foodie-network',
    nodes: [
      {
        name: 'Terminus',
        urlEnv: 'TERMINUS_API_URL',
        defaultHostname: 'http://100.100.23.77:9200',
        tokenEnv: 'V10_TOKEN_TERMINUS',
        reportFilename: 'mainnet_gnosis_terminus',
      },
      {
        name: 'Rhodia',
        urlEnv: 'RHODIA_API_URL',
        defaultHostname: 'http://100.74.33.99:9200',
        tokenEnv: 'V10_TOKEN_RHODIA',
        reportFilename: 'mainnet_gnosis_rhodia',
      },
    ],
  },
  'base-testnet': {
    spec: 'src/Base_Testnet.spec.js',
    title: 'DKG Asset Lifecycle on Base Testnet',
    blockchainName: 'v10:base:84532',
    defaultContextGraphId: 'jenkins-publish-tests',
    nodes: [
      {
        name: 'TestNode1',
        urlEnv: 'TESTNET1_API_URL',
        defaultHostname: 'http://100.99.142.87:9200',
        tokenEnv: 'V10_TOKEN_TESTNET1',
        reportFilename: 'testnet_base_node1',
      },
      {
        name: 'TestNode2',
        urlEnv: 'TESTNET2_API_URL',
        defaultHostname: 'http://100.70.65.41:9200',
        tokenEnv: 'V10_TOKEN_TESTNET2',
        reportFilename: 'testnet_base_node2',
      },
      {
        name: 'TestNode3',
        urlEnv: 'TESTNET3_API_URL',
        defaultHostname: 'http://100.120.12.74:9200',
        tokenEnv: 'V10_TOKEN_TESTNET3',
        reportFilename: 'testnet_base_node3',
      },
      {
        name: 'TestNode4',
        urlEnv: 'TESTNET4_API_URL',
        defaultHostname: 'http://100.65.228.120:9200',
        tokenEnv: 'V10_TOKEN_TESTNET4',
        reportFilename: 'testnet_base_node4',
      },
    ],
  },
};

export function getSuiteDefinition(groupName) {
  const suite = CHAIN_SUITE_MANIFEST[groupName];
  if (!suite) {
    throw new Error(`Unknown node-suite group "${groupName || ''}". Choose: ${Object.keys(CHAIN_SUITE_MANIFEST).join(', ')}`);
  }
  return suite;
}

export function getChainPublishConfig(groupName, env = process.env) {
  const suite = getSuiteDefinition(groupName);
  return {
    title: suite.title,
    blockchainName: suite.blockchainName,
    contextGraphId: env.DKG_CONTEXT_GRAPH_ID || suite.defaultContextGraphId,
    nodes: suite.nodes.map((node) => ({
      name: node.name,
      hostname: env[node.urlEnv] || node.defaultHostname,
      token: env[node.tokenEnv],
    })),
  };
}
