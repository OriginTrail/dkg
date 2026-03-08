import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const proxyTarget = process.env.DKG_API_URL ?? 'http://127.0.0.1:9200';
const proxyToken = process.env.DKG_API_TOKEN;

export default defineConfig({
  plugins: [react()],
  root: 'ui',
  base: '/apps/origin-trail-game/',
  build: {
    outDir: '../dist-ui',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: proxyTarget,
        ...(proxyToken ? { headers: { Authorization: `Bearer ${proxyToken}` } } : {}),
      },
    },
  },
});
