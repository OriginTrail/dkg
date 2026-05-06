import { test, expect } from '../fixtures/base.js';

test.describe('Create Project Modal', () => {
  test.beforeEach(async ({ shell, dashboard, createProjectModal, page }) => {
    // The modal's submit button is gated on agentAddress, which loads via
    // /api/agent/current (not part of the dev-mock provider). Stub it so the
    // form behaves the same in dev mode as it would against a live daemon.
    await page.route('**/api/agent/identity', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agentAddress: '0x1234567890abcdef1234567890abcdef12345678',
          name: 'qa-agent',
        }),
      }),
    );

    await shell.goto();
    await dashboard.clickQuickAction('Create Project');
    await expect(createProjectModal.overlay).toBeVisible();
  });

  test('modal title is "Create New Project"', async ({ createProjectModal }) => {
    await expect(createProjectModal.title).toHaveText('Create New Project');
  });

  test('name input is focused by default', async ({ createProjectModal }) => {
    await expect(createProjectModal.nameInput).toBeFocused();
  });

  test('submit disabled when name is empty', async ({ createProjectModal }) => {
    expect(await createProjectModal.isSubmitDisabled()).toBe(true);
  });

  test('submit enabled after entering a name', async ({ createProjectModal }) => {
    await createProjectModal.fill('Test Knowledge Graph');
    expect(await createProjectModal.isSubmitDisabled()).toBe(false);
  });

  test('whitespace-only name keeps submit disabled', async ({ createProjectModal }) => {
    await createProjectModal.fill('   ');
    expect(await createProjectModal.isSubmitDisabled()).toBe(true);
  });

  test('name with only special characters / punctuation keeps submit enabled', async ({ createProjectModal }) => {
    // The id is derived from the name by slugifying; pure punctuation may
    // produce an empty slug. The current production behavior is to NOT
    // pre-validate the name — `name.trim()` is the only gate, so any
    // non-empty string enables submit (CreateProjectModal.tsx:390).
    // The earlier version of this test used
    // `expect([true, false]).toContain(disabled)`, which is a tautology
    // — it could never fail. Pin to the actual contract so a future
    // refactor that adds a slug-empty pre-check will surface here.
    //
    // Fill first (the button is disabled while name is empty per
    // `!name.trim()` gate). The disabled gate also depends on
    // `agentAddress` and `!identityLoading`. Mirror the pattern of
    // the surrounding test "submit enabled after entering a name"
    // (line 36) — a single boolean check rather than a hard-wait —
    // so this test is consistent and has the same timing budget.
    await createProjectModal.fill('!!!@@@###');
    expect(await createProjectModal.isSubmitDisabled()).toBe(false);
  });

  test('very long name (300+ chars) does not crash the modal', async ({ createProjectModal, page }) => {
    const longName = 'a'.repeat(300);
    await createProjectModal.fill(longName);
    // Modal must still be visible and responsive after a big input.
    await expect(page.locator('.v10-modal-box')).toBeVisible();
    expect(await createProjectModal.getNameValue()).toBe(longName);
  });

  test('name and description inputs accept text', async ({ createProjectModal }) => {
    await createProjectModal.fill('Drug Interactions', 'Track pharmaceutical compound interactions');
    expect(await createProjectModal.getNameValue()).toBe('Drug Interactions');
    const descValue = await createProjectModal.descriptionInput.inputValue();
    expect(descValue).toBe('Track pharmaceutical compound interactions');
  });

  test('Cancel button closes the modal', async ({ createProjectModal }) => {
    await createProjectModal.cancel();
    expect(await createProjectModal.isOpen()).toBe(false);
  });

  test('clicking overlay closes the modal', async ({ createProjectModal }) => {
    await createProjectModal.closeViaOverlay();
    expect(await createProjectModal.isOpen()).toBe(false);
  });

  test('Access radio group renders Curated and Public options', async ({ page }) => {
    const access = page.locator('.v10-form-group').filter({ hasText: 'Access' }).first();
    await expect(access).toBeVisible();
    await expect(access.getByText(/Curated/)).toBeVisible();
    await expect(access.getByText(/Public/)).toBeVisible();
  });

  test('submit button text is "Create Project"', async ({ createProjectModal }) => {
    const text = await createProjectModal.getSubmitText();
    expect(text?.trim()).toBe('Create Project');
  });

  test('modal subtitle describes project purpose', async ({ page }) => {
    const subtitle = page.locator('.v10-modal-subtitle');
    await expect(subtitle).toBeVisible();
    const text = await subtitle.textContent();
    expect(text).toContain('structured memory');
  });

  test('Publish Policy radios are disabled with coming soon label', async ({ page }) => {
    const group = page.locator('.v10-form-group').filter({ hasText: 'Publish Policy' });
    await expect(group).toBeVisible();
    await expect(group.getByText('coming soon')).toBeVisible();
    const radios = group.locator('input[type="radio"]');
    const count = await radios.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      expect(await radios.nth(i).isDisabled()).toBe(true);
    }
  });

  test('Ontology radio group renders the starter / agent / upload options', async ({ page }) => {
    const group = page.locator('.v10-form-group').filter({ hasText: 'Ontology' }).first();
    await expect(group).toBeVisible();
    await expect(group.getByText(/Choose a starter/).first()).toBeVisible();
    await expect(group.getByText(/Let agent decide/).first()).toBeVisible();
  });

  test('Advanced settings toggle shows/hides content', async ({ createProjectModal }) => {
    expect(await createProjectModal.isAdvancedVisible()).toBe(false);
    await createProjectModal.toggleAdvanced();
    expect(await createProjectModal.isAdvancedVisible()).toBe(true);
    await createProjectModal.toggleAdvanced();
    expect(await createProjectModal.isAdvancedVisible()).toBe(false);
  });

  test('Advanced settings contains Consensus Quorum dropdown (disabled)', async ({ createProjectModal, page }) => {
    await createProjectModal.toggleAdvanced();
    const quorum = page.locator('.v10-form-advanced-body .v10-form-group').filter({ hasText: 'Consensus Quorum' });
    await expect(quorum).toBeVisible();
    const select = quorum.locator('select');
    expect(await select.isDisabled()).toBe(true);
  });

  test('Advanced settings contains SWM TTL dropdown (disabled)', async ({ createProjectModal, page }) => {
    await createProjectModal.toggleAdvanced();
    const ttl = page.locator('.v10-form-advanced-body .v10-form-group').filter({ hasText: 'SWM TTL' });
    await expect(ttl).toBeVisible();
    const select = ttl.locator('select');
    expect(await select.isDisabled()).toBe(true);
  });

  test('Advanced settings contains SWM Size Cap dropdown (disabled)', async ({ createProjectModal, page }) => {
    await createProjectModal.toggleAdvanced();
    const cap = page.locator('.v10-form-advanced-body .v10-form-group').filter({ hasText: 'SWM Size Cap' });
    await expect(cap).toBeVisible();
    const select = cap.locator('select');
    expect(await select.isDisabled()).toBe(true);
  });

  test('modal opened from left panel "+ New Project" button', async ({ page, shell, leftPanel, createProjectModal }) => {
    await createProjectModal.cancel();
    // Wait for the left tree to settle before clicking the secondary entry point.
    await page.locator('.v10-tree-section').first().waitFor({ state: 'visible', timeout: 10_000 });
    await leftPanel.clickNewProject();
    expect(await createProjectModal.isOpen()).toBe(true);
  });
});
