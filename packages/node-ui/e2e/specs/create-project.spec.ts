import { test, expect } from '../fixtures/base.js';

test.describe('Create Project Modal', () => {
  test.beforeEach(async ({ shell, dashboard, createProjectModal }) => {
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

  test('ACCESS radios are disabled (COMING SOON)', async ({ page }) => {
    const radios = page.locator('.v10-modal-box input[type="radio"]');
    const count = await radios.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      expect(await radios.nth(i).isDisabled()).toBe(true);
    }
  });

  test('layer activation info is displayed', async ({ createProjectModal }) => {
    expect(await createProjectModal.hasLayerPreview()).toBe(true);
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

  test('Ontology radios are disabled with coming soon label', async ({ page }) => {
    const group = page.locator('.v10-form-group').filter({ hasText: 'Ontology' });
    await expect(group).toBeVisible();
    await expect(group.getByText('coming soon')).toBeVisible();
    const radios = group.locator('input[type="radio"]');
    const count = await radios.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      expect(await radios.nth(i).isDisabled()).toBe(true);
    }
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

  test('Layer Activation preview shows memory tier descriptions', async ({ page }) => {
    const preview = page.locator('.v10-layer-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Verified Memory');
    await expect(preview).toContainText('Shared Memory');
    await expect(preview).toContainText('Working Memory');
  });

  test('modal opened from left panel "+ New Project" button', async ({ page, shell, leftPanel, createProjectModal }) => {
    await createProjectModal.cancel();
    await leftPanel.clickNewProject();
    expect(await createProjectModal.isOpen()).toBe(true);
  });
});
