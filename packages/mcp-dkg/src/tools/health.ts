/**
 * Node-health diagnostic tools.
 *
 * Wave-2 P2 adds (audit §7 items 6 + 7). Trivial wrappers over
 * `GET /api/status` and `GET /api/wallets/balances` — diagnostic /
 * pre-publish "do I have funds" reads with no input parameters.
 *
 * Mirrors the OpenClaw adapter's `dkg_status` + `dkg_wallet_balances`
 * (`DkgNodePlugin.ts:1899-1914`) byte-for-byte on shape so an agent
 * reading either surface sees the same diagnostic output.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DkgClient } from '../client.js';
import type { DkgConfig } from '../config.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const errResult = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

const formatError = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export function registerHealthTools(
  server: McpServer,
  client: DkgClient,
  _config: DkgConfig,
): void {
  // ── dkg_status ──────────────────────────────────────────────────
  server.registerTool(
    'dkg_status',
    {
      title: 'DKG Node Status',
      description:
        'Show DKG node status: peer ID, connected peers, multiaddrs, ' +
        'and wallet addresses. Call this to verify the daemon is ' +
        'running and to diagnose connectivity issues.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        const status = await client.getStatus();
        // Render a compact JSON block — the daemon's status payload
        // shape is stable and readable as JSON; no need to flatten
        // into prose here.
        return ok(`DKG node status:\n\n\`\`\`json\n${JSON.stringify(status, null, 2)}\n\`\`\``);
      } catch (e) {
        return errResult(`Failed to fetch node status: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_wallet_balances ─────────────────────────────────────────
  server.registerTool(
    'dkg_wallet_balances',
    {
      title: 'Wallet Balances',
      description:
        'Check TRAC and ETH token balances for the node\'s operational ' +
        'wallets. Use before publishing to verify sufficient funds. ' +
        'Returns per-wallet balances, chain id, and RPC URL.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        const result = await client.getWalletBalances();
        if (result.error) {
          return errResult(`Wallet balance probe failed: ${result.error}`);
        }
        const lines = result.balances.map(
          (b) => `- **${b.address}** — ${b.eth} ETH · ${b.trac} ${b.symbol || 'TRAC'}`,
        );
        const chain =
          result.chainId !== null
            ? `\n\nChain: ${result.chainId}` + (result.rpcUrl ? ` · RPC: ${result.rpcUrl}` : '')
            : '';
        const body = lines.length
          ? lines.join('\n')
          : '_(no operational wallets found)_';
        return ok(`Wallet balances:\n\n${body}${chain}`);
      } catch (e) {
        return errResult(`Failed to fetch wallet balances: ${formatError(e)}`);
      }
    },
  );
}
