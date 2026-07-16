import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';

test.describe('Right Panel (Agent Panel)', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('renders three mode tabs', async ({ rightPanel }) => {
    const tabs = await rightPanel.getModeTabNames();
    expect(tabs).toContain('Agents');
    expect(tabs).toContain('Network');
    expect(tabs).toContain('Sessions');
  });

  test('Agents mode is active by default', async ({ rightPanel }) => {
    const active = await rightPanel.getActiveMode();
    expect(active?.trim()).toBe('Agents');
  });

  test.describe('Agents Mode', () => {
    test('"+" add agent subtab is visible', async ({ page }) => {
      const addTab = page.locator(sel.rightPanel.addBtn);
      await expect(addTab).toBeVisible();
    });

    test('shows CONNECT ANOTHER AGENT heading', async ({ page }) => {
      const heading = page.getByText('CONNECT ANOTHER AGENT');
      await expect(heading).toBeVisible();
    });

    test('lists at least one connectable agent integration (OpenClaw / Hermes)', async ({ page }) => {
      // Two default integrations (OpenClaw + Hermes) ship out of the
      // box now, so the original empty-state copy is unreachable until
      // both are connected. Assert the *positive* invariant — the
      // section surfaces at least one ready-to-connect integration —
      // which is the durable contract.
      const integrations = page.locator('.v10-local-agent-list .v10-local-agent-detail');
      await expect(integrations.first()).toBeVisible();
      const count = await integrations.count();
      expect(count).toBeGreaterThan(0);
    });
  });

  test.describe('Network Mode', () => {
    test.beforeEach(async ({ rightPanel }) => {
      await rightPanel.switchMode('Network');
    });

    test('shows mode as active', async ({ rightPanel }) => {
      const active = await rightPanel.getActiveMode();
      expect(active?.trim()).toBe('Network');
    });

    test('displays a peer count', async ({ page }) => {
      // On a real devnet the connected-peer count varies with libp2p connection
      // timing (0 right after boot, ≥1 once node1↔node2 dial). Assert the count
      // STAT renders ("N peer(s)") rather than a brittle exact value.
      const peerText = page.locator('.v10-agents-summary').getByText(/\d+ peers?\b/);
      await expect(peerText.first()).toBeVisible();
    });

    test('shows direct/relayed breakdown', async ({ page }) => {
      const breakdown = page.locator('.v10-agents-summary').getByText(/\d+ direct \/ \d+ relayed/);
      await expect(breakdown).toBeVisible();
    });

    test('Refresh button is visible', async ({ page }) => {
      const refreshBtn = page.locator('button').filter({ hasText: 'Refresh' });
      await expect(refreshBtn).toBeVisible();
    });

    test('Refresh button has descriptive title attribute', async ({ page }) => {
      const refreshBtn = page.locator('.v10-agents-refresh');
      const title = await refreshBtn.getAttribute('title');
      expect(title).toBeTruthy();
      expect(title).toContain('Refresh');
    });

    test('shows the network summary header', async ({ page }) => {
      // The Network tab opens on a summary row (peer-count + transport breakdown
      // + Refresh). Assert that summary renders — the old "NETWORK PEERS" heading
      // no longer exists in the rc.12 panel.
      await expect(page.locator('.v10-agents-summary')).toBeVisible();
    });

    test('shows either connected peers or a peer empty state', async ({ page }) => {
      // Depending on libp2p connection timing the panel shows the Connected /
      // Recently-seen peer groups (when peers are present) or one of the
      // empty-state strings ("No network peers detected yet." etc). Both are
      // valid on a real node — assert one of them renders.
      const emptyState = page.locator('.v10-agent-empty-state');
      const peerGroup = page.locator('.v10-peer-group');
      await expect
        .poll(async () =>
          (await emptyState.first().isVisible().catch(() => false)) ||
          (await peerGroup.first().isVisible().catch(() => false)),
        )
        .toBe(true);
    });
  });

  test.describe('Sessions Mode', () => {
    test.beforeEach(async ({ rightPanel }) => {
      await rightPanel.switchMode('Sessions');
    });

    test('shows mode as active', async ({ rightPanel }) => {
      const active = await rightPanel.getActiveMode();
      expect(active?.trim()).toBe('Sessions');
    });

    test('displays session description text', async ({ page }) => {
      const desc = page.getByText('Sessions track DKG-persisted conversations');
      await expect(desc).toBeVisible();
    });

    test('shows empty sessions message', async ({ page }) => {
      const msg = page.getByText('No integrated-agent sessions yet.');
      await expect(msg).toBeVisible();
    });
  });

  test('switching between all three modes and back', async ({ rightPanel }) => {
    await rightPanel.switchMode('Network');
    expect((await rightPanel.getActiveMode())?.trim()).toBe('Network');
    await rightPanel.switchMode('Sessions');
    expect((await rightPanel.getActiveMode())?.trim()).toBe('Sessions');
    await rightPanel.switchMode('Agents');
    expect((await rightPanel.getActiveMode())?.trim()).toBe('Agents');
  });

  // ─── PR1: Layout & header behavior ────────────────────────────────────

  test.describe('PR1: persisted width', () => {
    test('right-panel width persists across reload', async ({ page, shell }) => {
      // Write a target width via the same store that the resize-handle drives
      // (drag handles are 1px wide and not reliable to drive via mouse events
      // in Playwright on Windows). The persistence contract under test is:
      // "setRightWidth → debounce → localStorage.dkg-layout → reload survives".
      const target = 432;
      await page.evaluate((w) => {
        const win = window as unknown as { __dkgLayout?: { setRightWidth: (w: number) => void } };
        if (win.__dkgLayout?.setRightWidth) {
          win.__dkgLayout.setRightWidth(w);
        } else {
          // Fallback: poke the persisted blob directly so the reload path is
          // still exercised end-to-end.
          const existing = JSON.parse(localStorage.getItem('dkg-layout') || '{}');
          localStorage.setItem('dkg-layout', JSON.stringify({ ...existing, rightWidth: w }));
        }
      }, target);
      await page.waitForTimeout(220); // > 150ms debounce window

      const stored = await page.evaluate(() => localStorage.getItem('dkg-layout'));
      expect(stored).toBeTruthy();
      const parsed = JSON.parse(stored!);
      expect(parsed.rightWidth).toBe(target);

      await page.reload();
      await shell.root.waitFor({ state: 'visible' });
      const afterReload = await shell.getRightPanelWidth();
      expect(Math.abs(afterReload - target)).toBeLessThanOrEqual(4);
    });

    test('left-panel width persists across reload', async ({ page, shell }) => {
      const target = 296;
      await page.evaluate((w) => {
        const existing = JSON.parse(localStorage.getItem('dkg-layout') || '{}');
        localStorage.setItem('dkg-layout', JSON.stringify({ ...existing, leftWidth: w }));
      }, target);

      await page.reload();
      await shell.root.waitFor({ state: 'visible' });
      const afterReload = await shell.getLeftPanelWidth();
      expect(Math.abs(afterReload - target)).toBeLessThanOrEqual(4);
    });

    test('non-finite persisted width falls back to default on reload', async ({ page, shell }) => {
      await page.evaluate(() => {
        localStorage.setItem(
          'dkg-layout',
          JSON.stringify({ leftWidth: 'oops', rightWidth: null }),
        );
      });
      await page.reload();
      await shell.root.waitFor({ state: 'visible' });
      const right = await shell.getRightPanelWidth();
      const left = await shell.getLeftPanelWidth();
      // Defaults are 360 right / 240 left.
      expect(Math.abs(right - 360)).toBeLessThanOrEqual(4);
      expect(Math.abs(left - 240)).toBeLessThanOrEqual(4);
    });
  });

  test.describe('PR1: sticky mode-tabs header', () => {
    test('mode tabs are siblings of (not above) the scroll container', async ({ page }) => {
      // The original test scrolled `.v10-agent-content / .v10-agents-tab` to 9999
      // and asserted the mode tabs stayed pinned. After PR1 the panel became a
      // proper flex column with `.v10-panel-right { overflow: hidden }` and the
      // scroll happening inside `.v10-local-agent-messages` only, so setting
      // scrollTop on the outer containers did nothing and the assertion passed
      // vacuously. Switch to a structural assertion that captures the actual
      // contract: mode tabs are a flex sibling of the scroll region, not a
      // descendant — so they cannot scroll away regardless of message volume.
      const result = await page.evaluate(() => {
        const panel = document.querySelector('.v10-panel-right');
        const modeTabs = panel?.querySelector('.v10-agent-mode-tabs');
        const messages = panel?.querySelector('.v10-local-agent-messages');
        return {
          hasPanel: !!panel,
          hasModeTabs: !!modeTabs,
          // Mode tabs must NOT live inside the scrollable messages region;
          // they need to be a sibling/ancestor of it.
          tabsInsideScroller: messages ? messages.contains(modeTabs ?? null) : false,
          // Panel itself clips overflow so children don't bleed through.
          panelOverflow: panel ? getComputedStyle(panel as HTMLElement).overflow : null,
        };
      });
      expect(result.hasPanel).toBe(true);
      expect(result.hasModeTabs).toBe(true);
      expect(result.tabsInsideScroller).toBe(false);
      expect(result.panelOverflow === null || result.panelOverflow === 'hidden').toBe(true);
    });
  });

  // ─── Chat-shell-gated UI (composer, dropzone, project picker, kebab,
  //     lucide icons) — intentionally NOT e2e-tested here ──────────────────
  //
  // The right panel only mounts the chat shell once a LOCAL agent is
  // connected (OpenClaw / Hermes). On a headless real-node devnet both
  // adapters report `status: disconnected` and connecting kicks off a real
  // external install/spawn that can't reach chat-ready without a live
  // gateway — so these surfaces never render deterministically. The earlier
  // versions guarded every assertion behind `test.skip(...)`, which is
  // exactly the misleading-coverage trap we're removing: a "green" run that
  // silently exercised nothing.
  //
  // These behaviours are covered deterministically by the unit suites that
  // mount the same components against a real DOM (happy-dom):
  //   - composer autogrow / attach click, dropzone accept/refuse overlays,
  //     project-picker Select contrast, kebab + lucide iconography, and
  //     markdown rendering (test/markdown-message.test.ts, test/code-block.test.ts,
  //     and the PanelRight component unit tests).
  //
  // Re-add real-browser e2e here only once a connected-agent (or a test
  // harness route that mounts the chat shell with a stub transport) is
  // available in the devnet — otherwise they can only skip, which this
  // suite forbids.
});
