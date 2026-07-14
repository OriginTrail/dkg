// V10 Gnosis Mainnet publish/query/get test — V8-faithful, one node per Jenkins
// stage (selected by NODE_TO_TEST). Nodes sign internally; per-node bearer
// tokens come from env.
import { defineChainPublishSuite } from './v10-publish-lib.js';
import { getChainPublishConfig } from './suite-manifest.js';

defineChainPublishSuite(getChainPublishConfig('gnosis-mainnet'));
