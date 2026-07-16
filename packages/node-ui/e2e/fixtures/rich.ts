import { test as base, expect } from './base.js';
import { SubGraphBarPage, StatStripPage } from '../pages/subgraph-bar.po.js';
import { ShareProjectModal } from '../pages/modals/share-project.po.js';
import { ProjectLayerPage } from '../pages/project-layer.po.js';

type RichFixtures = {
  subgraphBar: SubGraphBarPage;
  statStrip: StatStripPage;
  shareProjectModal: ShareProjectModal;
  projectLayer: ProjectLayerPage;
};

export const test = base.extend<RichFixtures>({
  subgraphBar: async ({ page }, use) => {
    await use(new SubGraphBarPage(page));
  },

  statStrip: async ({ page }, use) => {
    await use(new StatStripPage(page));
  },

  shareProjectModal: async ({ page }, use) => {
    await use(new ShareProjectModal(page));
  },

  projectLayer: async ({ page }, use) => {
    await use(new ProjectLayerPage(page));
  },
});

export { expect };
