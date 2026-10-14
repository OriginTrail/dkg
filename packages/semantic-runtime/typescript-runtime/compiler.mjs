import { build } from 'esbuild';
import { componentize } from '@bytecodealliance/componentize-js';
import { transpile } from '@bytecodealliance/jco';
import { readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { limitMemory } from './limit-memory.mjs';
import { parseTypeScriptProgramBundle, TYPESCRIPT_PROGRAM_GUEST_API } from '@origintrail-official/dkg-core/typescript-program-bundle';

process.once('message', async ({ source, directory }) => {
  try {
    // Keep Wizer's scratch files under the host-owned directory so a killed
    // compiler does not leave its temporary Wasm snapshots behind.
    process.env.TMPDIR = directory;
    process.env.TEMP = directory;
    process.env.TMP = directory;
    const hash = value => createHash('sha256').update(value).digest('hex');
    const bundle = parseTypeScriptProgramBundle(source, hash);
    const sourceFiles = bundle?.files ?? { 'main.ts': { source } };
    const entry = bundle?.entry ?? 'main.ts';
    const modules = {};
    for (const name of ['entry', 'guest', 'pipeline']) modules[name] = await readFile(new URL(`./${name}.mjs`, import.meta.url), 'utf8');
    modules.api = 'export { invoke_tool, invoke_program, pipe, map, reduce } from "guest";';
    const result = await build({
      entryPoints: ['entry'], write: false, bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
      // Unresolvable nonliteral imports/requires cannot become a guest loader.
      logOverride: { 'unsupported-dynamic-import': 'error', 'unsupported-require-call': 'error' },
      plugins: [{ name: 'closed-program-imports', setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          if (args.kind === 'entry-point' && args.path === 'entry') return { path: 'entry', namespace: 'dkg-runtime' };
          if (args.namespace === 'dkg-runtime') {
            if (args.path === 'user-program') return { path: entry, namespace: 'dkg-bundle' };
            if (Object.hasOwn(modules, args.path)) return { path: args.path, namespace: 'dkg-runtime' };
          }
          if (args.namespace === 'dkg-bundle') {
            if (args.path === TYPESCRIPT_PROGRAM_GUEST_API) return { path: 'api', namespace: 'dkg-runtime' };
            const path = args.path.startsWith('./') || args.path.startsWith('../')
              ? posix.normalize(posix.join(posix.dirname(args.importer), args.path))
              : bundle?.imports[args.path];
            if (path && Object.hasOwn(sourceFiles, path)) return { path, namespace: 'dkg-bundle' };
          }
          // No filesystem/npm/URL fallback, including for transitive imports.
          return { errors: [{ text: 'Unsupported Program import: supply the dependency in the source bundle' }] };
        });
        build.onLoad({ filter: /.*/, namespace: 'dkg-runtime' }, args => ({ contents: modules[args.path], loader: 'js' }));
        build.onLoad({ filter: /.*/, namespace: 'dkg-bundle' }, args => ({ contents: sourceFiles[args.path].source,
          loader: args.path.endsWith('.json') ? 'json' : /\.[cm]?ts$/.test(args.path) ? 'ts' : 'js' }));
      } }],
    });
    const sourcePath = join(directory, 'program.js');
    await writeFile(sourcePath, result.outputFiles[0].contents);
    // Module initialization runs during Wizer compilation. Bound the engine
    // before that step too, rather than only bounding the final snapshot.
    const engine = join(directory, 'bounded-engine.wasm');
    const engineUrl = new URL('../lib/starlingmonkey_embedding.wasm', import.meta.resolve('@bytecodealliance/componentize-js'));
    await writeFile(engine, limitMemory(await readFile(engineUrl)));
    const { component } = await componentize({ sourcePath,
      engine,
      witPath: new URL('./workflow.wit', import.meta.url).pathname,
      disableFeatures: ['random', 'stdio', 'clocks', 'http', 'fetch-event'], env: {}, enableAot: false });
    const output = await transpile(component, { name: 'component', instantiation: 'async', wasiShim: false, base64Cutoff: 0 });
    if (output.imports.length || output.exports.some(([name, kind]) => !['start', 'settle', 'inspect'].includes(name) || kind !== 'function'))
      throw new Error('Unexpected Program component interface');
    const files = [];
    for (const [name, data] of Object.entries(output.files).sort(([a], [b]) => a.localeCompare(b))) {
      if (!/^[\w.-]+$/.test(name)) { if (name.endsWith('.d.ts')) continue; throw new Error('Invalid compiler output name'); }
      const bounded = name.endsWith('.wasm') ? limitMemory(data) : data;
      await writeFile(join(directory, name), bounded);
      files.push({ name, sha256: createHash('sha256').update(bounded).digest('hex') });
    }
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    const manifest = JSON.stringify({ format: 'dkg.typescript-program.v1',
      sourceHash: createHash('sha256').update(source).digest('hex'), files });
    process.send({ ok: true, manifest, hash: createHash('sha256').update(manifest).digest('hex') }, () => process.exit(0));
  } catch (error) { process.send({ ok: false, error: String(error).slice(0, 2048) }, () => process.exit(1)); }
});
