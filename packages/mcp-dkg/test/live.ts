/**
 * Shared real-node test harness (NO daemon mocks).
 *
 * Every behavioural test that needs the daemon imports from here so the
 * env wiring + real `DkgClient` construction lives in exactly one place.
 *
 * `FakeServer` (re-exported from `./harness`) is NOT a daemon mock — it is
 * the in-process MCP transport shim: it records `registerTool` calls and
 * invokes the REAL tool handler with zod-parsed input, exactly the way the
 * production MCP SDK does. The handler it invokes calls the REAL `DkgClient`
 * against the REAL daemon, so every `server.call(...)` is a true round-trip.
 *
 * Gating: behavioural suites wrap in `describe.skipIf(!LIVE)` and run only
 * when `MCP_INTEGRATION_TEST=1` + a devnet is reachable (mirrors
 * `cli/test/blazegraph-integration.test.ts`). Pure schema/registration
 * tests don't need any of this — they build a real `DkgClient` that is
 * never invoked (or use `FakeServer.parse`), so they run in every lane.
 */
import { DkgClient } from '../src/client.js';
import type { DkgConfig } from '../src/config.js';
import { FakeServer } from './harness.js';

export { FakeServer } from './harness.js';
export type { ToolResult } from './harness.js';

export const LIVE = process.env.MCP_INTEGRATION_TEST === '1';

export const API = process.env.DKG_API ?? 'http://127.0.0.1:9200';
export const API2 = process.env.DKG_API2 ?? process.env.DKG_API_2 ?? '';
export const TOKEN = process.env.DKG_TOKEN ?? '';
export const TOKEN2 = process.env.DKG_TOKEN2 ?? process.env.DKG_TOKEN ?? '';
export const CG = process.env.DKG_PROJECT ?? process.env.DKG_CG ?? 'devnet-test';
export const PEER2 = process.env.DKG_PEER2 ?? '';

/**
 * Real production-shaped config. When `MCP_INTEGRATION_TEST` is unset the
 * api/token fall back to harmless placeholders — fine for the pure tests
 * that never invoke the client, and irrelevant for the gated suites which
 * only run when the real env is exported.
 */
export function liveConfig(overrides: Partial<DkgConfig> = {}): DkgConfig {
  return {
    api: API,
    token: TOKEN,
    defaultProject: CG,
    agentUri: 'urn:dkg:agent:mcp-live-test',
    capture: {
      autoShare: true,
      defaultPrivacy: 'team',
      subGraph: 'chat',
      assertion: 'chat-log',
    },
    sourcePath: null,
    ...overrides,
  };
}

/** A REAL DkgClient (real global fetch → real daemon). No mock. */
export function liveClient(overrides: Partial<DkgConfig> = {}): DkgClient {
  return new DkgClient({ config: liveConfig(overrides) });
}

/** Wire the REAL client into a fresh transport shim with the given register fns. */
export function liveSurface(
  registerFns: Array<(server: unknown, client: DkgClient, config: DkgConfig) => void>,
  overrides: Partial<DkgConfig> = {},
): { server: FakeServer; client: DkgClient; config: DkgConfig } {
  const config = liveConfig(overrides);
  const client = new DkgClient({ config });
  const server = new FakeServer();
  const mcp = server.asMcpServer();
  for (const reg of registerFns) reg(mcp, client, config);
  return { server, client, config };
}

/**
 * Guard for gated suites: throws a clear message if MCP_INTEGRATION_TEST=1
 * but the token is missing, so the failure is actionable rather than a
 * mysterious 401 deep in a test.
 */
export function assertLiveEnv(): void {
  if (!LIVE) return;
  if (!TOKEN) {
    throw new Error(
      'MCP_INTEGRATION_TEST=1 but DKG_TOKEN is empty. Export the daemon API token ' +
        '(2nd non-comment line of .devnet/nodeN/auth.token) or unset MCP_INTEGRATION_TEST to skip.',
    );
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
