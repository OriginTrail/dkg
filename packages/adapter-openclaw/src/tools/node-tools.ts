/**
 * Node status / wallet tool definitions for {@link DkgNodePlugin}.
 *
 * Moved verbatim out of `DkgNodePlugin.tools()` — same metadata and handler
 * delegation, only relocated. The `execute` callbacks forward to the host's
 * `handle*` methods (see {@link DkgToolHost}). No behavior change.
 */
import type { OpenClawTool } from '../types.js';
import type { DkgToolHost } from './tool-host.js';

export function buildNodeTools(ctx: DkgToolHost): OpenClawTool[] {
  return [
    {
      name: 'dkg_status',
      description:
        'Show DKG node status: peer ID, connected peers, multiaddrs, and wallet addresses. ' +
        'Call this to verify the daemon is running and to diagnose connectivity issues.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (_toolCallId, _params) => ctx.handleStatus(),
    },
    {
      name: 'dkg_wallet_balances',
      description:
        'Check TRAC and ETH token balances for the node\'s operational wallets. ' +
        'Use this before publishing to verify sufficient funds. Returns per-wallet balances, ' +
        'chain ID, and RPC URL.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (_toolCallId, _params) => ctx.handleWalletBalances(),
    },
  ];
}
