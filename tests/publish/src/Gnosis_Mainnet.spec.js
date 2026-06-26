// V10 Gnosis Mainnet publish/query/get test — V8-faithful, one node per Jenkins
// stage (selected by NODE_TO_TEST). Nodes sign internally; per-node bearer
// tokens come from env.
import { defineChainPublishSuite } from './v10-publish-lib.js';

const nodes = [
  { name: 'Terminus', hostname: process.env.TERMINUS_API_URL || 'http://100.100.23.77:9200', token: process.env.V10_TOKEN_TERMINUS },
  { name: 'Rhodia',   hostname: process.env.RHODIA_API_URL   || 'http://100.74.33.99:9200',  token: process.env.V10_TOKEN_RHODIA },
];

defineChainPublishSuite({
  title: 'DKG Asset Lifecycle on Gnosis Mainnet',
  blockchainName: 'v10:gnosis:100',
  contextGraphId: process.env.DKG_CONTEXT_GRAPH_ID || 'jenkins-v10-gnosis-mainnet',
  nodes,
});
