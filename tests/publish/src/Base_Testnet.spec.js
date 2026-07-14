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
import { getChainPublishConfig } from './suite-manifest.js';

defineChainPublishSuite(getChainPublishConfig('base-testnet'));
