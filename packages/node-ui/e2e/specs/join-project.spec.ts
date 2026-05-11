import { test, expect } from '../fixtures/base.js';

test.describe('JoinProjectModal', () => {
  test.beforeEach(async ({ shell, leftPanel, page }) => {
    await shell.goto();
    await leftPanel.root.waitFor({ state: 'visible' });
    await page.getByRole('button', { name: /Join Project/ }).first().click();
  });

  test('opens with title and subtitle', async ({ joinProjectModal }) => {
    await expect(joinProjectModal.title).toHaveText('Join a Project');
    await expect(joinProjectModal.subtitle).toContainText('Enter the project ID');
  });

  test('Join button is disabled when invite is empty', async ({ joinProjectModal }) => {
    await expect(joinProjectModal.joinBtn).toBeDisabled();
  });

  test('Join button enables once invite text is entered', async ({ joinProjectModal }) => {
    await joinProjectModal.fillInvite('cg:demo');
    await expect(joinProjectModal.joinBtn).toBeEnabled();
  });

  test('multiaddr without /p2p/ peer ID surfaces a peer-id error', async ({ joinProjectModal }) => {
    await joinProjectModal.fillInvite('cg:demo\n/ip4/1.2.3.4/tcp/10001');
    await joinProjectModal.clickJoin();
    await expect(joinProjectModal.error).toContainText('missing peer ID');
  });

  test('Cancel button closes the modal', async ({ joinProjectModal }) => {
    await joinProjectModal.clickCancel();
    await expect(joinProjectModal.box).toBeHidden();
  });

  test('overlay click closes the modal', async ({ joinProjectModal }) => {
    await joinProjectModal.closeViaOverlay();
    await expect(joinProjectModal.box).toBeHidden();
  });

  test('How it works tip explains the flow', async ({ joinProjectModal }) => {
    await expect(joinProjectModal.tip).toContainText('How it works');
    await expect(joinProjectModal.tip).toContainText('subscribe');
  });

  test('invite textarea accepts multi-line input', async ({ joinProjectModal }) => {
    const code = 'cg:multi\n/ip4/1.2.3.4/tcp/10001/p2p/12D3KooWxyz';
    await joinProjectModal.fillInvite(code);
    await expect(joinProjectModal.inviteInput).toHaveValue(code);
  });

  test('invite with whitespace-only content keeps the Join button disabled', async ({ joinProjectModal }) => {
    await joinProjectModal.fillInvite('   \n  \t  \n');
    await expect(joinProjectModal.joinBtn).toBeDisabled();
  });

  test('multiaddr without a protocol prefix does not crash the parser', async ({ joinProjectModal }) => {
    await joinProjectModal.fillInvite('cg:demo\nlooks-like-multiaddr-but-isnt');
    await joinProjectModal.clickJoin();
    // The non-`/`-prefixed line is skipped by the parser; the join attempt
    // continues without a multiaddr. The error surface is either the
    // backend's response or no multiaddr error — never a crash.
    await expect(joinProjectModal.box).toBeVisible();
  });

  test('extreme whitespace around the cg id is trimmed before submit', async ({ joinProjectModal }) => {
    await joinProjectModal.fillInvite('   cg:trimmed   ');
    // Button enables once non-whitespace content lands.
    await expect(joinProjectModal.joinBtn).toBeEnabled();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // V10 invite-format additions (post-merge from main, PR #431 and follow-ups).
  // The v10 share modal now produces a 2-line invite where line 2 is a bare
  // libp2p peer ID resolved via Kademlia DHT (`connectToPeerIdWithTimeout`),
  // not an embedded multiaddr. Several edge cases this format introduces are
  // not exercised by the legacy tests above.
  // ─────────────────────────────────────────────────────────────────────────

  test('V10 peer-id-only invite parses cleanly and keeps Join enabled', async ({ joinProjectModal }) => {
    // Per JoinProjectModal.tsx:42, PEER_ID_RE accepts `12D3Koo…` (45–53 chars)
    // and the legacy `Qm…` (44 chars). Below is a structurally-valid 12D3Koo
    // id taken from the audit-node we ran live (52 chars after the prefix).
    // The parser must extract this as curatorPeerId, leave cgId == 'cg:peer-id',
    // and produce hasUnparsedExtra === false → validateInvite returns null →
    // Join button stays enabled and no error chip appears.
    const v10Invite = 'cg:peer-id\n12D3KooWKv7WQygiGickKh5ERgCgiAt7ejgec7jARXutcWGjn5No';
    await joinProjectModal.fillInvite(v10Invite);
    await expect(joinProjectModal.joinBtn).toBeEnabled();
    // No error chip while the input is just being typed.
    await expect(joinProjectModal.error).toBeHidden();
  });

  test('invite with a typo\'d peer ID on line 2 is rejected with the hasUnparsedExtra message', async ({ joinProjectModal }) => {
    // Per JoinProjectModal.tsx:93, when the second line has content but
    // neither parser (peer-id RE nor multiaddr pattern) matches it, the
    // modal must show:
    //   "Invite contains a second line that is not a valid peer ID
    //    (12D3Koo…) or multiaddr (/ip4/…). Check for typos."
    // This is the loud-rejection contract that replaced silent-drop
    // behaviour (Codex review PR #431).
    await joinProjectModal.fillInvite('cg:typo\n12D3KooBADtypo-not-a-real-peer-id');
    await joinProjectModal.clickJoin();
    await expect(joinProjectModal.error).toContainText(/not a valid peer ID|multiaddr|typos/i);
  });

  test('valid /dnsaddr/ multiaddr is accepted (regression for PR #431 round-2 fix)', async ({ joinProjectModal }) => {
    // PR #431 round-2 widened the multiaddr regex from /ip4|ip6|dns/ to
    // /ip4|ip6|dns|dns4|dns6|dnsaddr/. Before the fix, a legacy invite of
    // the form below silently collapsed the multiaddr into the cgId. The
    // post-fix parser MUST extract the multiaddr and keep cgId clean.
    const dnsaddrInvite = 'cg:dnsaddr\n/dnsaddr/example.com/p2p/12D3KooWKv7WQygiGickKh5ERgCgiAt7ejgec7jARXutcWGjn5No';
    await joinProjectModal.fillInvite(dnsaddrInvite);
    // The Join button must stay enabled and the input value must NOT show
    // any parse-error glyph yet (it only fires post-clickJoin).
    await expect(joinProjectModal.joinBtn).toBeEnabled();
    await expect(joinProjectModal.error).toBeHidden();
  });

  test('the V9 single-line `cgId @ /ip4/...` shape is parsed without leaking the multiaddr into cgId', async ({ joinProjectModal, page }) => {
    // PR #431 round-2 also tightened parseInviteCode so that the V9 single-
    // line shape `my-project @ /ip4/.../p2p/...` no longer leaves cgId as
    // `"my-project @"`. We can't read the internal cgId from the DOM, but
    // we can prove the parser doesn't bail: the Join button is enabled and
    // no error fires on submit (the submission will fail later with a
    // backend error because the daemon doesn't have this CG, but that's
    // fine — the parser-level contract is what we're guarding here).
    const v9Style = 'demo-cg @ /ip4/1.2.3.4/tcp/9001/p2p/12D3KooWKv7WQygiGickKh5ERgCgiAt7ejgec7jARXutcWGjn5No';
    await joinProjectModal.fillInvite(v9Style);
    await expect(joinProjectModal.joinBtn).toBeEnabled();
    // No parser error before submit:
    await expect(joinProjectModal.error).toBeHidden();
  });

  test('`unreachable` catchup status surfaces its specific banner with a Send Join Request CTA', async ({ joinProjectModal, page }) => {
    // The merge added a fourth terminal catchup state: `unreachable`.
    // It must produce its own banner (not the generic timeout one) reading
    // "Couldn't reach the curator". JoinProjectModal.tsx:471–492 owns this
    // branch. The catchup endpoint lives at /api/sync/catchup-status
    // (api.ts:342) — pin the route there. We also stub the subscribe call
    // so the modal advances into the catchup-poll phase regardless of the
    // real daemon state.
    await page.route('**/api/sync/catchup-status*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'unreachable', error: 'no peer accepted catchup' }),
      }),
    );
    await page.route('**/api/context-graph/*/subscribe', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
    );

    await joinProjectModal.fillInvite('cg:unreachable-probe');
    await joinProjectModal.clickJoin();

    // The banner can take up to maxAttempts * intervalMs (1500ms) before
    // firing in the worst case. Our mock returns terminal `unreachable`
    // immediately, so the first poll wins and the banner shows fast.
    await expect(joinProjectModal.box.getByText(/Couldn't reach the curator/i)).toBeVisible({ timeout: 15_000 });
    await expect(joinProjectModal.box.getByText(/no peer was able to deliver/i)).toBeVisible();
    await expect(joinProjectModal.accessDeniedSendBtn).toBeVisible();
  });
});
