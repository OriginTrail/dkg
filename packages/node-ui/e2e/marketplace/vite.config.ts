/**
 * The node UI's Vite config for one node of the marketplace lane: the same
 * config (it proxies `/api` to the devnet node `DEVNET_NODE` names and serves
 * that node's token with the page), with a dependency cache of its own, since
 * the lane runs a server for each of three nodes at once and they would
 * otherwise rewrite one cache under each other.
 */
import { resolve } from 'node:path';
import { mergeConfig } from 'vite';
import base from '../../vite.config.js';

const node = process.env.DEVNET_NODE;
if (!node) throw new Error('DEVNET_NODE must name the devnet node this UI server proxies to');

export default mergeConfig(base, {
  cacheDir: resolve(__dirname, `../../node_modules/.vite-marketplace-node${node}`),
  clearScreen: false,
});
