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
  // Default: the org's private publish-test CG on Base mainnet (curated, curator
  // 0xB34ca972…). Nodes auto-subscribe to it (it contains '/') before publishing.
  // NOTE: publishes need >=3 staked-core MEMBER ACKs — add more member cores or
  // override to a public CG ('sports') via DKG_CONTEXT_GRAPH_ID if quorum is short.
  contextGraphId: process.env.DKG_CONTEXT_GRAPH_ID || '0xB34ca972B85264f2a9303C236c7e52D000B1e7d6/publish-tests',
  // Known-good, already-indexed UAL — used to exercise query/VM GET/Query Remote
  // when a publish fails (no fresh UAL). Override via DKG_FALLBACK_UAL.
  fallbackUal: process.env.DKG_FALLBACK_UAL
    || 'did:dkg:base:8453/0x80738050893c3e769560331c8fd63a421b340d46/99151283273890217601250345024195922266519347286718115506932280650983152812050',
  nodes,
});
