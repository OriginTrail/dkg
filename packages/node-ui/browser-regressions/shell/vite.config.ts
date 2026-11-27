import { defineConfig, mergeConfig } from 'vite';
import app from '../../vite.config.js';

// The app's own Vite config, with every module scanned for dependencies up
// front. Otherwise a cold server finds a lazily loaded dependency mid-test
// (a dialog, a view) and reloads the page, losing the state under test.
export default mergeConfig(app, defineConfig({
  optimizeDeps: { entries: ['index.html', '**/*.tsx'] },
  server: { hmr: false },
}));
