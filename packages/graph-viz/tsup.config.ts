import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ['react', 'react-dom', 'jsonld', '3d-force-graph', 'three'],
    outDir: 'dist',
    splitting: true,
  },
  {
    entry: ['src/react/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    external: ['react', 'react-dom', 'jsonld'],
    outDir: 'dist/react',
    splitting: true,
  },
  {
    entry: ['src/parsers/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    external: ['jsonld'],
    outDir: 'dist/parsers',
    splitting: true,
  },
]);
