import { type Page } from '@playwright/test';
import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';
import { EXPECTED_MIN_PEERS, IS_RELAY_HUB, NUM_NODES, UI_NODE } from '../helpers/real-node.js';
import { fetchApiInPage } from '../helpers/page-api.js';

/**
 * Peer connectivity against the real multi-node devnet.
 *
 * Topology (scripts/devnet.sh): node1 is the relay HUB and every other node is
 * booted with `relay = node1's multiaddr`, so each one dials node1. The node the
 * UI talks to therefore reports a DIFFERENT settled peer count depending on
 * which node it is: the hub (node1) sees every other node (N-1), a non-hub node
 * sees only the hub (1). We assert against `EXPECTED_MIN_PEERS`, derived from
 * the SAME env vars that pick the UI node + mesh size, so the spec stays correct
 * across the default node1/3-node CI run AND a `UI_NODE_ID`-repointed run instead
 * of baking in node1's `N-1 = 2`. Falling below that count means a peer failed to
 * dial or the relay broke — the regression this spec is here to catch.
 *
 * Counts are polled (not read once) to ride out libp2p dial timing on a cold
 * boot; on the persistent/reused devnet the mesh is already settled, so this is
 * effectively instant there.
 */
const MIN_PEERS = EXPECTED_MIN_PEERS;

async function readStatus(page: Page): Promise<{
  connectedPeers?: number;
  connections?: { total?: number; direct?: number; relayed?: number };
} | null> {
  // Authed in-page fetch (same bearer the UI uses) so an auth-enabled node
  // doesn't 401; retries on transient 5xx, like the daemon's own status poll.
  const res = await fetchApiInPage<{
    connectedPeers?: number;
    connections?: { total?: number; direct?: number; relayed?: number };
  }>(page, '/api/status', { retries: 8 });
  return res.json;
}

function parsePeerCount(text: string | null): number {
  // No trailing `\b`: a container's textContent concatenates adjacent spans
  // (e.g. "2 peers2 direct / 0 relayed"), so "peers" is often immediately
  // followed by a digit — a word boundary there would never match.
  const m = (text ?? '').match(/(\d+)\s+peers?/);
  return m ? Number(m[1]) : -1;
}

test.describe('Peer connectivity (multi-node devnet)', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test(`the UI node reports its expected connected-peer count (>= ${MIN_PEERS}) for the devnet mesh`, async ({ page }) => {
    await expect
      .poll(
        async () => (await readStatus(page))?.connectedPeers ?? -1,
        {
          timeout: 30_000,
          message: `connectedPeers never reached the expected devnet mesh size (>= ${MIN_PEERS} for node${UI_NODE}, ${IS_RELAY_HUB ? `relay hub of ${NUM_NODES} nodes` : 'non-hub: dials only the hub'})`,
        },
      )
      .toBeGreaterThanOrEqual(MIN_PEERS);
  });

  test('the libp2p connection breakdown accounts for every connected peer', async ({ page }) => {
    await expect
      .poll(async () => (await readStatus(page))?.connectedPeers ?? -1, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(MIN_PEERS);

    const s = await readStatus(page);
    expect(s, '/api/status must return JSON').toBeTruthy();
    const peers = s!.connectedPeers ?? 0;
    const direct = s!.connections?.direct ?? 0;
    const relayed = s!.connections?.relayed ?? 0;
    const total = s!.connections?.total ?? 0;

    expect(peers).toBeGreaterThanOrEqual(MIN_PEERS);
    // A single peer can hold both a direct and a relayed link, so the link
    // counts sum to >= the unique-peer count, and total >= peers.
    expect(direct + relayed).toBeGreaterThanOrEqual(peers);
    expect(total).toBeGreaterThanOrEqual(peers);
  });

  test(`the header renders the live peer count, matching the devnet mesh (>= ${MIN_PEERS})`, async ({ page }) => {
    // The header reads `connectedPeers` straight off /api/status, so its rendered
    // "N peers" must reach the same settled mesh value once the mesh settles.
    const meta = page.locator(sel.header.meta);
    await expect(meta).toBeVisible();
    await expect
      .poll(async () => parsePeerCount(await meta.textContent()), {
        timeout: 30_000,
        message: `header peer count never rendered the expected mesh size (>= ${MIN_PEERS})`,
      })
      .toBeGreaterThanOrEqual(MIN_PEERS);
  });

  test('the right-panel Network mode reflects the live multi-peer count', async ({ rightPanel, page }) => {
    // The Network summary's "N peers" stat carries a tooltip promising it
    // "matches the count in the header" — assert that contract holds against the
    // real mesh. Scope to that exact stat span so the assertion can't be fooled
    // by the adjacent "N direct / N relayed" figure.
    await rightPanel.switchMode('Network');
    const peerStat = page.locator(
      '.v10-agents-summary span[title*="Unique libp2p peers"]',
    );
    await expect(peerStat).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => parsePeerCount(await peerStat.textContent()), {
        timeout: 30_000,
        message: `right-panel Network summary never showed the expected mesh size (>= ${MIN_PEERS})`,
      })
      .toBeGreaterThanOrEqual(MIN_PEERS);
  });
});
