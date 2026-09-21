import { defineConfig } from 'vitest/config';
import { monacoAssetsPlugin } from './monaco-workers.js';
import { coverageForPackage } from '../../vitest.coverage';

export default defineConfig({
  plugins: [monacoAssetsPlugin()],
  test: {
    allowOnly: false,
    include: ['test/**/*.test.ts'],
    coverage: coverageForPackage('node-ui'),
  },
});
