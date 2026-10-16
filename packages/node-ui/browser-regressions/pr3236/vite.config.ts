import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({ plugins: [react()], root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias: { '@origintrail-official/dkg-graph-viz/react': fileURLToPath(new URL('../../../graph-viz/src/react/index.ts', import.meta.url)) } },
});
