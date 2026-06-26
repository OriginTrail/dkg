// V10 Base Sepolia TESTNET publish/query/get test — V8-faithful, one node per
// Jenkins stage (selected by NODE_TO_TEST). Nodes sign internally; per-node
// bearer tokens come from env.
//
// NOTE: the two nodes below are PLACEHOLDERS — set the real testnet node URLs
// via TESTNET1_API_URL / TESTNET2_API_URL (or edit here) and their tokens via
// V10_TOKEN_TESTNET1 / V10_TOKEN_TESTNET2 before running.
import { defineChainPublishSuite } from './v10-publish-lib.js';

const nodes = [
  { name: 'TestNode1', hostname: process.env.TESTNET1_API_URL || 'http://CHANGE-ME-ot-testnet-1:9200', token: process.env.V10_TOKEN_TESTNET1 },
  { name: 'TestNode2', hostname: process.env.TESTNET2_API_URL || 'http://CHANGE-ME-ot-testnet-2:9200', token: process.env.V10_TOKEN_TESTNET2 },
];

defineChainPublishSuite({
  title: 'DKG Asset Lifecycle on Base Testnet',
  blockchainName: 'v10:base:84532',
  // 'megagiga' is an existing public CG on Base Sepolia (testnet) — publish into it
  // directly; testnet TRAC is free via the faucet.
  contextGraphId: process.env.DKG_CONTEXT_GRAPH_ID || 'megagiga',
  nodes,
});
