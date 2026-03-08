import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
        target: 'http://127.0.0.1:19200',
        headers: { Authorization: 'Bearer origin-trail-game-local-play' },
      },
    },
  },
});
