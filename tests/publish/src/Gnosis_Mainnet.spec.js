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
  // Default: the public 'foodie-network' CG on Gnosis mainnet. Publish tests use a
  // PUBLIC CG because the node only honors open-write (anyone publishes) for
  // public-read CGs — a private CG rejects writes from non-participant nodes
  // regardless of publishPolicy (see dkg-agent-swm-host.ts).
  // Override with DKG_CONTEXT_GRAPH_ID; a '/'-scoped id auto-subscribes first.
  contextGraphId: process.env.DKG_CONTEXT_GRAPH_ID || 'foodie-network',
  // Known-good, already-indexed UAL — fallback for the read ops when a publish
  // fails (no fresh UAL). Override via DKG_FALLBACK_UAL.
  fallbackUal: process.env.DKG_FALLBACK_UAL
    || 'did:dkg:gnosis:100/0x80738050893c3e769560331c8fd63a421b340d46/94671588760210549827181812291498549983661910199997120488227079838251318509576',
  nodes,
});
