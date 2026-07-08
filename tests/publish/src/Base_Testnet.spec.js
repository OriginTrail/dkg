// V10 Base Sepolia TESTNET publish/query/get test — V8-faithful, one node per
// Jenkins stage (selected by NODE_TO_TEST). Nodes sign internally; per-node
// bearer tokens come from env.
//
// Base Sepolia testnet "beacon" fleet (V10 core), reached over Tailscale by raw
// tailnet IP :9200 — same pattern as the mainnet specs. (The HTTPS `tailscale serve`
// on :443 is NOT reachable from the Jenkins host; :9200 is.) Per-node bearer tokens
// come from V10_TOKEN_TESTNET<N> (Jenkins secret-text creds dkg-v10-base-testnode<N>-token).
// Sequential node map (TestNode<N> = beacon-0<N>):
//   TestNode1 = dkg-v10-beacon-01 (100.99.142.87)
//   TestNode2 = dkg-v10-beacon-02 (100.70.65.41)
//   TestNode3 = dkg-v10-beacon-03 (100.120.12.74)
//   TestNode4 = dkg-v10-beacon-04 (100.65.228.120)
import { defineChainPublishSuite } from './v10-publish-lib.js';

const nodes = [
  { name: 'TestNode1', hostname: process.env.TESTNET1_API_URL || 'http://100.99.142.87:9200',  token: process.env.V10_TOKEN_TESTNET1 },
  { name: 'TestNode2', hostname: process.env.TESTNET2_API_URL || 'http://100.70.65.41:9200',   token: process.env.V10_TOKEN_TESTNET2 },
  { name: 'TestNode3', hostname: process.env.TESTNET3_API_URL || 'http://100.120.12.74:9200',  token: process.env.V10_TOKEN_TESTNET3 },
  { name: 'TestNode4', hostname: process.env.TESTNET4_API_URL || 'http://100.65.228.120:9200', token: process.env.V10_TOKEN_TESTNET4 },
];

defineChainPublishSuite({
  title: 'DKG Asset Lifecycle on Base Testnet',
  blockchainName: 'v10:base:84532',
  // 'megagiga' is an existing public CG on Base Sepolia (testnet) — publish into it
  // directly; testnet TRAC is free via the faucet.
  contextGraphId: process.env.DKG_CONTEXT_GRAPH_ID || 'megagiga',
  // Fallback UAL for read ops when a publish fails. Set via DKG_FALLBACK_UAL once
  // real Base Sepolia testnet nodes exist (publish one KA, use its UAL here).
  fallbackUal: process.env.DKG_FALLBACK_UAL || '',
  nodes,
});
