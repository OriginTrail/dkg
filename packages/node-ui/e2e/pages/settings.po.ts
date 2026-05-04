import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

export class SettingsPage {
  readonly page: Page;
  readonly root: Locator;
  readonly title: Locator;

  // LLM
  readonly llmCard: Locator;
  readonly llmStatusBadge: Locator;
  readonly apiKeyInput: Locator;
  readonly apiKeyToggleBtn: Locator;
  readonly modelInput: Locator;
  readonly baseUrlInput: Locator;
  readonly llmSaveBtn: Locator;
  readonly llmDisconnectBtn: Locator;

  // Telemetry
  readonly telemetryCard: Locator;
  readonly telemetryToggle: Locator;
  readonly retentionSelect: Locator;
  readonly retentionPruneBtn: Locator;
  readonly retentionCancelBtn: Locator;
  readonly consentModal: Locator;
  readonly consentEnableBtn: Locator;
  readonly consentCancelBtn: Locator;

  // Identity / blockchain
  readonly identityCard: Locator;
  readonly offlineBanner: Locator;
  readonly blockchainCard: Locator;

  // Sync status
  readonly syncCard: Locator;
  readonly syncSelect: Locator;
  readonly syncRefreshBtn: Locator;

  // Developer
  readonly devCard: Locator;
  readonly devModeToggle: Locator;

  // Danger zone
  readonly shutdownBtn: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator('.page-section').first();
    this.title = page.getByRole('heading', { name: 'Settings', level: 1 });

    this.llmCard = this.cardByTitle('LLM Configuration');
    this.llmStatusBadge = this.llmCard.getByText(/LLM Connected|Not Configured/);
    this.apiKeyInput = this.llmCard.locator('input[placeholder^="sk-"], input[placeholder*="key saved"]');
    this.apiKeyToggleBtn = this.llmCard.getByRole('button', { name: /Show|Hide/ });
    this.modelInput = this.llmCard.locator('input[placeholder="gpt-4o-mini"]');
    this.baseUrlInput = this.llmCard.locator('input[placeholder="https://api.openai.com/v1"]');
    this.llmSaveBtn = this.llmCard.getByRole('button', { name: /^(Save|Saving…)$/ });
    this.llmDisconnectBtn = this.llmCard.getByRole('button', { name: 'Disconnect' });

    this.telemetryCard = this.cardByTitle('Telemetry & Observability');
    this.telemetryToggle = this.telemetryCard.locator('button').first();
    this.retentionSelect = this.telemetryCard.locator('select').first();
    this.retentionPruneBtn = this.telemetryCard.getByRole('button', { name: /Prune/ });
    this.retentionCancelBtn = this.telemetryCard.getByRole('button', { name: 'Cancel' });
    this.consentModal = page.getByText('Enable Telemetry Streaming?').locator('xpath=ancestor::div[3]');
    this.consentEnableBtn = page.getByRole('button', { name: 'Enable Streaming' });
    this.consentCancelBtn = this.consentModal.getByRole('button', { name: 'Cancel' });

    this.identityCard = this.cardByTitle('Node Identity');
    this.offlineBanner = this.identityCard.getByText(/OFFLINE|ONLINE/);
    this.blockchainCard = this.cardByTitle('Blockchain Config');

    this.syncCard = this.cardByTitle('Background Sync Status');
    this.syncSelect = this.syncCard.locator('select');
    this.syncRefreshBtn = this.syncCard.getByRole('button', { name: /Refresh|Refreshing/ });

    this.devCard = this.cardByTitle('Developer');
    this.devModeToggle = this.devCard.locator('button').first();

    this.shutdownBtn = page.getByRole('button', { name: /Shutdown Node|Confirm Shutdown|Shutting down/ });
  }

  private cardByTitle(name: string): Locator {
    return this.page.locator(sel.settings.card).filter({ has: this.page.getByText(name, { exact: true }) }).first();
  }

  async open() {
    const settingsBtn = this.page.locator(sel.header.settingsBtn);
    await settingsBtn.click();
    // The Settings page is lazy-loaded behind Suspense ("Loading settings…"
    // fallback); under a busy daemon the chunk takes longer to resolve, so
    // give it a wider window than the default actionTimeout.
    await this.title.waitFor({ state: 'visible', timeout: 25_000 });
    await this.waitForReady();
  }

  /**
   * Wait for all sections of the Settings page to be present in the DOM.
   * The page is composed of multiple `.settings-card`s rendered as their
   * own data fetches resolve (LLM, telemetry, identity, blockchain, sync,
   * developer, privacy, danger). The Danger Zone card is last and only
   * mounts after the wallet/status fetches return — that's the right
   * "fully loaded" signal.
   */
  async waitForReady(timeoutMs = 20_000): Promise<void> {
    await this.shutdownBtn.waitFor({ state: 'attached', timeout: timeoutMs });
  }

  async toggleApiKeyVisibility() {
    await this.apiKeyToggleBtn.click();
  }

  async fillApiKey(key: string) {
    await this.apiKeyInput.fill(key);
  }

  async fillModel(model: string) {
    await this.modelInput.fill(model);
  }

  async fillBaseUrl(url: string) {
    await this.baseUrlInput.fill(url);
  }

  async clickSave() {
    await this.llmSaveBtn.click();
  }

  async toggleTelemetry() {
    await this.telemetryToggle.click();
  }

  async changeRetention(days: number) {
    await this.retentionSelect.selectOption(String(days));
  }

  async toggleDevMode() {
    await this.devModeToggle.click();
  }

  async clickShutdown() {
    await this.shutdownBtn.click();
  }

  async getRetentionValue() {
    return this.retentionSelect.inputValue();
  }
}
