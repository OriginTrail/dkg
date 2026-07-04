import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readDevnetNode } from '../helpers/devnet.js';
import { UI_NODE } from '../helpers/real-node.js';
import { AppShellPage } from '../pages/app-shell.po.js';
import { HeaderPage } from '../pages/header.po.js';
import { LeftPanelPage } from '../pages/left-panel.po.js';
import { CenterPanelPage } from '../pages/center-panel.po.js';
import { BottomPanelPage } from '../pages/bottom-panel.po.js';
import { RightPanelPage } from '../pages/right-panel.po.js';
import { DashboardPage } from '../pages/dashboard.po.js';
import { ProjectViewPage } from '../pages/project-view.po.js';
import { MemoryLayerPage } from '../pages/memory-layer.po.js';
import { OperationsPage } from '../pages/operations.po.js';
import { NetworkPagePO } from '../pages/network-page.po.js';
import { SettingsPage } from '../pages/settings.po.js';
import { CreateProjectModal } from '../pages/modals/create-project.po.js';
import { ImportFilesModal } from '../pages/modals/import-files.po.js';
import { FilePreviewModal } from '../pages/modals/file-preview.po.js';
import { PublishingConvictionPage } from '../pages/publishing-conviction.po.js';

type Fixtures = {
  /**
   * Auto fixture (no spec references it directly). Opens the dashboard through
   * the explicit token-exchange flow before app navigation so specs drive the
   * same cookie session path operators use, without reintroducing a browser
   * bearer token or tokenless loopback bootstrap.
   */
  _dashboardSession: void;
  /**
   * Auto fixture (no spec references it directly). Fails ANY test whose page
   * silently fell back to demo/mock data. See the implementation note below.
   */
  _noMockModeGuard: void;
  shell: AppShellPage;
  header: HeaderPage;
  leftPanel: LeftPanelPage;
  centerPanel: CenterPanelPage;
  bottomPanel: BottomPanelPage;
  rightPanel: RightPanelPage;
  dashboard: DashboardPage;
  projectView: ProjectViewPage;
  memoryLayer: MemoryLayerPage;
  operations: OperationsPage;
  networkPage: NetworkPagePO;
  settingsPage: SettingsPage;
  createProjectModal: CreateProjectModal;
  importFilesModal: ImportFilesModal;
  filePreviewModal: FilePreviewModal;
  conviction: PublishingConvictionPage;
};

async function ensureDashboardSession(page: Page): Promise<void> {
  const status = await page.request.get('/api/dashboard/session/status', {
    failOnStatusCode: false,
  });
  if (status.ok()) {
    const body = await status.json().catch(() => null) as { authenticated?: boolean; authDisabled?: boolean } | null;
    if (body?.authenticated === true || body?.authDisabled === true) return;
  }

  const node = readDevnetNode(UI_NODE);
  if (!node?.authToken) {
    throw new Error(`Devnet node${UI_NODE} auth token is unavailable; cannot open a dashboard session for e2e`);
  }
  const exchange = await page.request.post('/api/dashboard/session/exchange', {
    data: { token: node.authToken },
    failOnStatusCode: false,
  });
  if (!exchange.ok()) {
    const body = await exchange.text().catch(() => '');
    throw new Error(
      `Failed to exchange devnet node${UI_NODE} token for dashboard session: ` +
      `${exchange.status()} ${body.slice(0, 300)}`,
    );
  }
}

export const test = base.extend<Fixtures>({
  // No mocks: every test runs against a real devnet node (see playwright.config.ts
  // `webServer` → bootstrap-devnet.ts). The page object fixtures below simply
  // wrap the real UI so specs read as user journeys.

  _dashboardSession: [
    async ({ page }, use) => {
      await ensureDashboardSession(page);
      await use();
    },
    { auto: true },
  ],

  // HARD GUARD against silent false positives. The product wraps several core
  // endpoints in `api-wrapper.detectMockMode`, which swaps in fabricated demo
  // fixtures (connectedPeers:12, "Pharma Drug Interactions" CGs, a `my-dkg-node`
  // identity, …) after repeated /api/status probes 5xx, time out, or
  // network-fail — and the decision is sticky for the whole page. If
  // that ever fires mid-run, EVERY assertion on the rendered data is suspect.
  // This auto fixture refuses to let such a run pass: after each test it reads
  // the `window.__DKG_USING_MOCKS__` flag the wrapper sets and fails the test
  // if the page was ever serving mocks. Better a loud failure pointing at node
  // health than a green tick earned against fake data.
  _noMockModeGuard: [
    async ({ page }, use) => {
      await use();
      if (page.isClosed()) return;
      const usedMocks = await page
        .evaluate(() => (window as { __DKG_USING_MOCKS__?: boolean }).__DKG_USING_MOCKS__ === true)
        .catch(() => false);
      expect(
        usedMocks,
        'UI silently fell back to MOCK/demo data — the real node /api/status probe failed during this test, so any assertion on rendered data is a potential false positive. Investigate node health; this run is NOT trustworthy.',
      ).toBe(false);
    },
    { auto: true },
  ],

  shell: async ({ page }, use) => {
    await use(new AppShellPage(page));
  },
  header: async ({ page }, use) => {
    await use(new HeaderPage(page));
  },
  leftPanel: async ({ page }, use) => {
    await use(new LeftPanelPage(page));
  },
  centerPanel: async ({ page }, use) => {
    await use(new CenterPanelPage(page));
  },
  bottomPanel: async ({ page }, use) => {
    await use(new BottomPanelPage(page));
  },
  rightPanel: async ({ page }, use) => {
    await use(new RightPanelPage(page));
  },
  dashboard: async ({ page }, use) => {
    await use(new DashboardPage(page));
  },
  projectView: async ({ page }, use) => {
    await use(new ProjectViewPage(page));
  },
  memoryLayer: async ({ page }, use) => {
    await use(new MemoryLayerPage(page));
  },
  operations: async ({ page }, use) => {
    await use(new OperationsPage(page));
  },
  networkPage: async ({ page }, use) => {
    await use(new NetworkPagePO(page));
  },
  settingsPage: async ({ page }, use) => {
    await use(new SettingsPage(page));
  },
  createProjectModal: async ({ page }, use) => {
    await use(new CreateProjectModal(page));
  },
  importFilesModal: async ({ page }, use) => {
    await use(new ImportFilesModal(page));
  },
  filePreviewModal: async ({ page }, use) => {
    await use(new FilePreviewModal(page));
  },
  conviction: async ({ page }, use) => {
    await use(new PublishingConvictionPage(page));
  },
});

export { expect } from '@playwright/test';
