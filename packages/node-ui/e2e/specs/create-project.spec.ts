import { test, expect } from '../fixtures/base.js';

const MOCK_AGENT = {
  agentAddress: '0x1111111111111111111111111111111111111111',
  agentDid: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
  name: 'mock-node-agent',
};

test.describe('Create Context Graph Modal (rc.12)', () => {
  test.beforeEach(async ({ shell, leftPanel, createProjectModal, page }) => {
    await page.route('**/api/agent/identity', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_AGENT) }),
    );
    await shell.goto();
    await leftPanel.clickNewProject();
    await expect(createProjectModal.overlay).toBeVisible();
    await expect(createProjectModal.submitBtn).not.toHaveText(/Loading agent|Agent unavailable/);
  });

  test('modal title is "Create New Context Graph"', async ({ createProjectModal }) => {
    await expect(createProjectModal.title).toHaveText('Create New Context Graph');
  });

  test('name input is visible and accepts text', async ({ createProjectModal }) => {
    await expect(createProjectModal.nameInput).toBeVisible();
    await createProjectModal.nameInput.fill('Test');
    expect(await createProjectModal.getNameValue()).toBe('Test');
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
    expect(await createProjectModal.descriptionInput.inputValue()).toBe('Track pharmaceutical compound interactions');
  });

  test('Cancel button closes the modal', async ({ createProjectModal }) => {
    await createProjectModal.cancel();
    expect(await createProjectModal.isOpen()).toBe(false);
  });

  test('clicking overlay closes the modal', async ({ createProjectModal }) => {
    await createProjectModal.closeViaOverlay();
    expect(await createProjectModal.isOpen()).toBe(false);
  });

  test('Sharing radios are enabled', async ({ page }) => {
    const group = page.locator('.v10-form-group').filter({ hasText: 'Sharing' });
    const radios = group.locator('input[type="radio"]');
    const count = await radios.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      expect(await radios.nth(i).isDisabled()).toBe(false);
    }
  });

  test('Contribution radios are enabled', async ({ page }) => {
    const group = page.locator('.v10-form-group').filter({ hasText: 'Contribution' });
    const radios = group.locator('input[type="radio"]');
    const count = await radios.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      expect(await radios.nth(i).isDisabled()).toBe(false);
    }
  });

  test('submit button text is "Create Context Graph"', async ({ createProjectModal }) => {
    await createProjectModal.fill('My Graph');
    const text = await createProjectModal.getSubmitText();
    expect(text?.trim()).toBe('Create Context Graph');
  });

  test('modal subtitle describes context graph purpose', async ({ page }) => {
    const subtitle = page.locator('.v10-modal-subtitle');
    await expect(subtitle).toBeVisible();
    expect(await subtitle.textContent()).toContain('structured memory');
  });

  test('Ontology upload option is disabled with coming soon label', async ({ page }) => {
    const group = page.locator('.v10-form-group').filter({ hasText: 'Ontology' });
    await expect(group).toBeVisible();
    await expect(group.getByText('coming soon')).toBeVisible();
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
    expect(await quorum.locator('select').isDisabled()).toBe(true);
  });

  test('modal opened from left panel "+ New Context Graph" button', async ({ leftPanel, createProjectModal }) => {
    await createProjectModal.cancel();
    await leftPanel.clickNewProject();
    expect(await createProjectModal.isOpen()).toBe(true);
  });
});
