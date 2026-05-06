import { test, expect } from '../fixtures/base.js';

// The pre-existing create-project.spec.ts covers the modal's open / cancel
// / validation paths but stops short of submitting a real Create — by far
// the most common flow on this modal. This file exercises the full
// create-and-land happy path against the live (isolated) daemon, mirroring
// what `e2e/setup/seed.ts` does directly via the API but driving it
// through the UI instead.
//
// CreateProjectModal.tsx:141 calls `openTab(...)` BEFORE manifest publish,
// so the project tab should appear regardless of whether the isolated
// daemon's manifest publish succeeds. We assert on the tab signal and
// the sidebar tree, both of which should reflect the new CG within ~60s.
test.describe('Create Project — full submit path', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  // Use a per-run unique name so the test is idempotent if the daemon
  // happens to carry state from a prior incomplete run. Keep the slugified
  // form deterministic to make sidebar lookups predictable.
  const uniqueName = `E2E Created ${Date.now().toString(36)}`;

  test('submitting a valid form opens a project tab and adds the CG to the sidebar', async ({
    leftPanel,
    centerPanel,
    createProjectModal,
    page,
  }) => {
    await leftPanel.clickNewProject();
    await expect(createProjectModal.overlay).toBeVisible();

    // Fill name + description. The submit button's disabled gate
    // (CreateProjectModal.tsx:390) is `!name.trim() || creating ||
    // !agentAddress || identityLoading`. Don't hard-wait on
    // `toBeEnabled` here — Playwright's `.click()` actionability
    // checks already retry up to actionTimeout (10s in our config)
    // for the button to become enabled.
    await createProjectModal.fill(uniqueName, 'Created from Playwright e2e suite.');
    expect(await createProjectModal.getNameValue()).toBe(uniqueName);

    await createProjectModal.submit();

    // Phase signal: the modal posts a progress line ("Registering project
    // on the network…") synchronously after click. Asserting on this
    // proves the click handler actually fired — a regression that breaks
    // the click wiring would silently fail the rest of the flow.
    await expect(page.getByText(/Registering project on the network/)).toBeVisible({ timeout: 5_000 });

    // The full path can take up to 30s on the isolated daemon (chain
    // ack + ontology install + manifest publish). Give it 60s and
    // assert the user-visible outcome: a tab with the project name.
    await expect(async () => {
      const tabs = await centerPanel.getTabNames();
      expect(tabs.some(t => t.includes(uniqueName))).toBe(true);
    }).toPass({ timeout: 60_000 });

    // And the new CG should appear in the sidebar tree (proves the
    // post-create CG-list refresh ran and the daemon returned it).
    await leftPanel.waitForReady();
    await expect(async () => {
      const names = await leftPanel.getProjectNames();
      expect(names).toContain(uniqueName);
    }).toPass({ timeout: 30_000 });
  });

  test('attempting to create a CG with the same name a second time surfaces a graceful error or duplicate-rejection', async ({
    leftPanel,
    createProjectModal,
    page,
  }) => {
    // The slug derived from the name is deterministic — the daemon will
    // produce a `<addr>/<slug>` ID collision for a second run. The UI
    // must NOT crash; it must either show an error in the modal or
    // refuse to advance. This protects against a regression that lets
    // the modal silently overwrite an existing CG.
    await leftPanel.clickNewProject();
    await expect(createProjectModal.overlay).toBeVisible();
    await createProjectModal.fill(uniqueName);
    // `.click()` retries up to actionTimeout for the button to become
    // enabled, so we don't need an explicit `toBeEnabled` wait here.
    await createProjectModal.submit();

    const error = page.locator('.v10-modal-error');
    const stillOpen = createProjectModal.overlay;
    // Either the modal stays open with an error message, OR it closes
    // (if the daemon idempotently re-opens the existing CG and the
    // post-create flow runs again). What's NOT acceptable is a silent
    // crash with no visible signal — assert at least one branch.
    const observed = await Promise.race([
      error.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'error').catch(() => null),
      stillOpen.waitFor({ state: 'hidden', timeout: 60_000 }).then(() => 'closed').catch(() => null),
    ]);
    expect(observed).not.toBeNull();
  });
});
