import { build } from 'esbuild';
import { componentize } from '@bytecodealliance/componentize-js';
import { transpile } from '@bytecodealliance/jco';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { limitMemory } from './limit-memory.mjs';

process.once('message', async ({ source, directory }) => {
  try {
    // Keep Wizer's scratch files under the host-owned directory so a killed
    // compiler does not leave its temporary Wasm snapshots behind.
    process.env.TMPDIR = directory;
    process.env.TEMP = directory;
    process.env.TMP = directory;
    const modules = { 'user-program': source };
    for (const name of ['entry', 'guest', 'pipeline']) modules[name] = await readFile(new URL(`./${name}.mjs`, import.meta.url), 'utf8');
    const result = await build({
      entryPoints: ['entry'], write: false, bundle: true, format: 'esm', target: 'es2022',
      plugins: [{ name: 'closed-program-imports', setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          const id = args.path === '@origintrail-official/dkg-graph-computer/program' ? 'guest' : args.path;
          // User modules may import only the public API. Internal modules and
          // filesystem, npm and URL imports are never available to user source.
          if (args.importer === 'user-program' && args.path !== '@origintrail-official/dkg-graph-computer/program')
            return { errors: [{ text: 'Only the Graph Computer Program API may be imported' }] };
          return Object.hasOwn(modules, id) ? { path: id, namespace: 'program' }
            : { errors: [{ text: 'Unsupported Program import' }] };
        });
        build.onLoad({ filter: /.*/, namespace: 'program' }, args => ({ contents: modules[args.path], loader: 'ts' }));
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
