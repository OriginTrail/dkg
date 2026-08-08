import { defineConfig } from 'vitest/config';

import coreConfig from './vitest.config.js';

export default defineConfig({
  ...coreConfig,
  test: {
    ...coreConfig.test,
    include: ['test/system-record-*.test.ts'],
  },
});
