import { test as base } from '@playwright/test';
import { loadState } from '../setup/state.js';
import type { DaemonState } from '../setup/daemon.js';
import type { SeedState } from '../setup/seed.js';
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
import { CreateProjectModal } from '../pages/modals/create-project.po.js';
import { ImportFilesModal } from '../pages/modals/import-files.po.js';
import { FilePreviewModal } from '../pages/modals/file-preview.po.js';
import { JoinProjectModal } from '../pages/modals/join-project.po.js';
import { ShareProjectModal } from '../pages/modals/share-project.po.js';
import { SettingsPage } from '../pages/settings.po.js';

type Fixtures = {
  daemon: DaemonState;
  seed: SeedState;
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
  createProjectModal: CreateProjectModal;
  importFilesModal: ImportFilesModal;
  filePreviewModal: FilePreviewModal;
  joinProjectModal: JoinProjectModal;
  shareProjectModal: ShareProjectModal;
  settings: SettingsPage;
};

export const test = base.extend<Fixtures>({
  // Force the daemon's bearer token onto every /api request via two
  // independent mechanisms — both are needed:
  //
  //   1) `page.route` intercepts /api/** and injects a fresh Authorization
  //      header. This wins over Vite's stale `inject-dkg-token` plugin
  //      (which reads `.devnet/node1/auth.token` at server-start time,
  //      before the test daemon wipes & regenerates that file).
  //
  //   2) `__DKG_TOKEN__` is sealed via `Object.defineProperty` with a
  //      no-op setter so Vite's inline `<script>window.__DKG_TOKEN__ = ...`
  //      cannot overwrite it. This matters for the EventSource at
  //      `/api/events?token=…`, which the daemon auth-gates as a query
  //      param (`packages/cli/src/auth.ts:823`): the EventSource is the
  //      ONE consumer that doesn't run through `page.route` because
  //      Playwright buffers `route.continue()` on long-lived streams and
  //      breaks the SSE memory_graph_changed live-update contract. So we
  //      exclude /api/events from interception AND make the in-page token
  //      sticky so the SSE URL carries the correct credential.
  page: async ({ page }, use) => {
    const { daemon } = loadState();
    await page.route(/\/api\/(?!events(?:\?|$))/, async (route) => {
      const headers = { ...route.request().headers(), Authorization: `Bearer ${daemon.authToken}` };
      await route.continue({ headers });
    });
    await page.addInitScript((token) => {
      let value = token;
      try {
        Object.defineProperty(window, '__DKG_TOKEN__', {
          configurable: false,
          get() { return value; },
          set() { /* swallow Vite's inject-dkg-token override */ },
        });
      } catch {
        (window as any).__DKG_TOKEN__ = value;
      }
    }, daemon.authToken);
    await use(page);
  },
  daemon: async ({}, use) => {
    await use(loadState().daemon);
  },
  seed: async ({}, use) => {
    await use(loadState().seed);
  },
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
  createProjectModal: async ({ page }, use) => {
    await use(new CreateProjectModal(page));
  },
  importFilesModal: async ({ page }, use) => {
    await use(new ImportFilesModal(page));
  },
  filePreviewModal: async ({ page }, use) => {
    await use(new FilePreviewModal(page));
  },
  joinProjectModal: async ({ page }, use) => {
    await use(new JoinProjectModal(page));
  },
  shareProjectModal: async ({ page }, use) => {
    await use(new ShareProjectModal(page));
  },
  settings: async ({ page }, use) => {
    await use(new SettingsPage(page));
  },
});

export { expect } from '@playwright/test';
