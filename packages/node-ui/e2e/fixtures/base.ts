import { test as base } from '@playwright/test';
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

type Fixtures = {
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
};

export const test = base.extend<Fixtures>({
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
});

export { expect } from '@playwright/test';
