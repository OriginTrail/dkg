import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import type { Plugin } from 'vite';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Copy Monaco's packaged workers as same-origin assets. Parsing the TypeScript
// compiler a second time through Rollup adds substantial build memory.
const root = resolve(dirname(createRequire(import.meta.url).resolve('monaco-editor')), '../..');
const assets = join(root, 'min/vs/assets');
function worker(name: string): string {
  const matches = readdirSync(assets).filter(file => file.startsWith(`${name}.worker-`) && file.endsWith('.js'));
  if (matches.length !== 1) throw new Error(`Expected one packaged Monaco ${name} worker`);
  return join(assets, matches[0]);
}
/** Build the editor in esbuild, then copy it without constructing a Rollup AST. */
export function monacoAssetsPlugin(): Plugin {
  let files: Array<{ name: string; contents: Uint8Array }> = [];
  let base = '/ui/';
  return {
    name: 'dkg-monaco-assets',
    configResolved(config) { base = config.base; },
    async buildStart() {
      const output = resolve(dirname(fileURLToPath(import.meta.url)), '.monaco-build');
      const result = await build({
        entryPoints: { editor: resolve(dirname(fileURLToPath(import.meta.url)), 'src/ui/components/Programs/monaco-entry.ts') },
        outdir: output, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
        entryNames: '[name]-[hash]', minify: true, write: false, loader: { '.ttf': 'file' },
      });
      files = result.outputFiles.map(file => ({ name: file.path.slice(output.length + 1), contents: file.contents }));
      for (const name of ['editor', 'ts']) {
        const path = worker(name);
        files.push({ name: basename(path), contents: readFileSync(path) });
      }
      files.push({ name: 'LICENSE.txt', contents: readFileSync(join(root, 'LICENSE')) });
      files.push({ name: 'ThirdPartyNotices.txt', contents: readFileSync(join(root, 'ThirdPartyNotices.txt')) });
    },
    resolveId(id) { if (id === 'virtual:dkg-monaco-assets') return '\0dkg-monaco-assets'; },
    load(id) {
      if (id !== '\0dkg-monaco-assets') return;
      const url = (suffix: string) => {
        const file = files.find(file => file.name.startsWith('editor-') && file.name.endsWith(suffix));
        if (!file) throw new Error(`Missing Monaco ${suffix} asset`);
        return JSON.stringify(`${base}monaco/${file.name}`);
      };
      const workerUrl = (name: string) => JSON.stringify(`${base}monaco/${basename(worker(name))}`);
      return `export const scriptUrl = ${url('.js')}; export const styleUrl = ${url('.css')};
        export const editorWorkerUrl = ${workerUrl('editor')}; export const typescriptWorkerUrl = ${workerUrl('ts')};`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const prefix = `${base}monaco/`;
        const path = req.url?.split('?')[0];
        if (!path?.startsWith(prefix)) return next();
        const file = files.find(file => file.name === path.slice(prefix.length));
        if (!file) { res.statusCode = 404; res.end(); return; }
        res.setHeader('Content-Type', file.name.endsWith('.js') ? 'text/javascript' : file.name.endsWith('.css') ? 'text/css' : 'font/ttf');
        res.end(file.contents);
      });
    },
    generateBundle() {
      for (const file of files) this.emitFile({ type: 'asset', fileName: `monaco/${file.name}`, source: file.contents });
    },
  };
}
