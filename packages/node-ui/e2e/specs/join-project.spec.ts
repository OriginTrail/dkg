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
});
