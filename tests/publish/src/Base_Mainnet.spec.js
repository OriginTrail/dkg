// V10 Base Mainnet publish/query/get test — V8-faithful, one node per Jenkins
// stage (selected by NODE_TO_TEST). Nodes sign internally; per-node bearer
// tokens come from env.
import { defineChainPublishSuite } from './v10-publish-lib.js';

const nodes = [
  { name: 'SBB',    hostname: process.env.SBB_API_URL    || 'http://100.100.87.86:9200',  token: process.env.V10_TOKEN_SBB },
  { name: 'DMaaST', hostname: process.env.DMAAST_API_URL || 'http://100.95.129.115:9200', token: process.env.V10_TOKEN_DMAAST },
];

defineChainPublishSuite({
  title: 'DKG Asset Lifecycle on Base Mainnet',
  blockchainName: 'v10:base:8453',
  // Default: the public 'sports' CG on Base mainnet. Publish tests use a PUBLIC
  // CG because the node only honors open-write (anyone publishes) for public-read
  // CGs — a private CG rejects writes from non-participant nodes regardless of
  // publishPolicy (see dkg-agent-swm-host.ts: accessPolicy===0 && publishPolicy===1).
  // Override with DKG_CONTEXT_GRAPH_ID; a '/'-scoped id auto-subscribes first.
  contextGraphId: process.env.DKG_CONTEXT_GRAPH_ID || 'sports',
  nodes,
});
