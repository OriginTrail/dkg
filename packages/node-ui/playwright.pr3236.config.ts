import { defineConfig } from '@playwright/test';

// Self-contained regression fixture: no devnet bootstrap, daemon proxy,
// credential injection, chain RPC, or external mutation.
export default defineConfig({
  testDir: './e2e/pr3236', testMatch: '*.spec.ts', workers: 1, retries: 0, timeout: 10_000,
  reporter: 'list', use: { baseURL: 'http://127.0.0.1:5186', browserName: 'chromium', headless: true,
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'pnpm exec vite --config e2e/pr3236/vite.config.ts --host 127.0.0.1 --port 5186 --strictPort',
    port: 5186, reuseExistingServer: false },
});
