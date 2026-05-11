import { test, expect } from '../fixtures/base.js';

test.describe('ShareProjectModal', () => {
  test.beforeEach(async ({ shell, leftPanel, projectView, page, seed }) => {
    await shell.goto();
    await leftPanel.waitForReady();
    await leftPanel.expandProject(seed.contextGraphName);
    await page.locator('.v10-layer-switcher').first().waitFor({ state: 'visible', timeout: 15_000 });
    await projectView.clickShare();
  });

  test('renders Allowlist and Join Requests tabs', async ({ shareProjectModal }) => {
    await expect(shareProjectModal.allowlistTab).toBeVisible();
    await expect(shareProjectModal.requestsTab).toBeVisible();
  });

  test('Add Agent button is disabled when input is empty', async ({ shareProjectModal }) => {
    await expect(shareProjectModal.addAgentBtn).toBeDisabled();
  });

  test('invalid address surfaces an inline error', async ({ shareProjectModal, page }) => {
    await shareProjectModal.fillAddress('not-an-address');
    await shareProjectModal.clickAdd();
    await expect(page.getByText(/Invalid Ethereum address/)).toBeVisible();
  });

  test('Copy Invite swaps button label to Copied', async ({ shareProjectModal, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await shareProjectModal.clickCopy();
    await expect(shareProjectModal.copyInviteBtn).toHaveText('Copied');
  });

  test('switching to Join Requests tab swaps the body content', async ({ shareProjectModal, page }) => {
    await shareProjectModal.switchToRequests();
    // Anchor to body-only copy: "Agents who submitted a signed request to
    // join this project." The previous regex `/join requests/i` *also*
    // matched the **tab label itself** ("Join Requests") which is always
    // visible — so the test passed even if the body never swapped.
    await expect(page.getByText(/Agents who submitted a signed request/i)).toBeVisible();
    // The seed never produces a join request, so the body MUST surface
    // the empty marker. A surprise "Approve" button here means a test
    // poisoned daemon state, or a defaulting bug seeded a phantom request.
    await expect(page.getByText('No pending join requests.', { exact: true })).toBeVisible();
  });

  test('Done button closes the modal', async ({ shareProjectModal }) => {
    await shareProjectModal.close();
    await expect(shareProjectModal.box).toBeHidden();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The default test daemon binds to 127.0.0.1 + RFC1918, so
  // `isMultiaddrRemotelyDialable` returns false for every multiaddr and
  // `inviteReady === false`. The block above covers that "Copy Project ID"
  // branch. The tests below exercise the "Copy Invite" (peer-id-enhanced)
  // branch by mocking /api/status to advertise a publicly-dialable multiaddr.
  // Without this coverage a regression in `isMultiaddrRemotelyDialable` or
  // the invitePayload assembly would slip through silently in CI.
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('inviteReady=true (peer-id-enhanced invite)', () => {
    test.beforeEach(async ({ page, shell, leftPanel, projectView, shareProjectModal, seed, daemon }) => {
      // Pre-fetch the live peerId via the APIRequestContext (which does NOT
      // route through `page.route()` — it has its own auth chain). Using a
      // static fulfilled body (vs `route.fetch()`-then-mutate) avoids the
      // `route.fetch: Target page... closed` flake observed when the fetch
      // races teardown. Pin the body to a single, deterministic shape so
      // every re-mount of ShareProjectModal sees the same status response.
      const statusResp = await page.request.get('/api/status', {
        headers: { Authorization: `Bearer ${daemon.authToken}` },
      });
      const statusBody = (await statusResp.json()) as { peerId?: string };
      const peerId = statusBody.peerId ?? '';
      expect(peerId, 'live daemon must surface a peerId on /api/status').not.toBe('');

      // Mock BEFORE goto so React's first /api/status fetch on modal mount
      // lands inside the mocked branch. Public IPv4 multiaddr passes
      // isMultiaddrRemotelyDialable's (no-private-range) filter; the real
      // peerId guarantees line 2 of the invite preview is a parseable
      // libp2p peer id.
      await shareProjectModal.close();
      await page.route('**/api/status', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            peerId,
            multiaddrs: [`/ip4/203.0.113.42/tcp/9999/p2p/${peerId}`],
          }),
        });
      });
      await shell.goto();
      await leftPanel.waitForReady();
      await leftPanel.expandProject(seed.contextGraphName);
      await page.locator('.v10-layer-switcher').first().waitFor({ state: 'visible', timeout: 15_000 });
      await projectView.clickShare();
    });

    test('button text reads "Copy Invite" when a publicly-dialable multiaddr exists', async ({ shareProjectModal }) => {
      // The visible label is the SoT for the inviteReady state. If
      // isMultiaddrRemotelyDialable accidentally re-includes private ranges
      // (or stops including the public one), this assertion fails.
      await expect(shareProjectModal.copyInviteBtn).toHaveText(/Copy Invite/);
    });

    test('the invite preview is two lines: cgId + peerId', async ({ page, seed }) => {
      // The peer-id-enhanced payload renders inside a <pre> next to the
      // copy button — line 1 is the cgId, line 2 the bare libp2p peerId.
      const pre = page.locator('.v10-modal-box pre').first();
      await expect(pre).toBeVisible();
      const text = (await pre.textContent())?.trim() ?? '';
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(seed.contextGraphId);
      // Line 2 must match a libp2p peer id shape. We don't pin to the live
      // daemon's actual peerId — that's brittle across runs — but the format
      // RE is the same one JoinProjectModal.PEER_ID_RE uses to ACCEPT a peer
      // id. Locking the format guarantees this invite would actually parse.
      expect(lines[1]).toMatch(/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|12D3Koo[1-9A-HJ-NP-Za-km-z]{45,53})$/);
    });

    test('the "Peer-id invite not ready yet" warning is hidden', async ({ page }) => {
      // ShareProjectModal.tsx:413–428 only renders that yellow callout when
      // !inviteReady. Confirm it's gone in the peer-id-ready branch.
      await expect(page.getByText(/Peer-id invite not ready yet/)).toBeHidden();
    });

    test('the helper line below the invite describes the peer-id flow', async ({ page }) => {
      // ShareProjectModal.tsx:452 — when inviteReady, the prose says the
      // daemon will dial via libp2p DHT and that "invite stays valid even
      // if your relay or public IP changes". This is the user-facing
      // promise of the peer-id-enhanced invite; loss-of-coverage on the
      // copy here would mask a misleading UX regression.
      await expect(page.getByText(/libp2p DHT|peer id over the libp2p DHT/i)).toBeVisible();
      await expect(page.getByText(/invite stays valid/i)).toBeVisible();
    });

    test('Copy Invite click flips to "Copied" (covers the peer-id-enhanced clipboard write)', async ({ shareProjectModal, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await shareProjectModal.clickCopy();
      await expect(shareProjectModal.copyInviteBtn).toHaveText('Copied');
    });
  });
});
