#!/usr/bin/env node
// Seeds retained share-queue history for the async queue contention benchmark (OT-RFC-73 P2a): a deterministic N-Quads file of terminal share jobs
// (8 quads each, about 2.2 KB per job: 50k jobs are about 110 MB raw, so use .gz) plus a manifest <out>.json, and optionally a load into a namespace.
// Needs the built workspace (pnpm run build:packages). The same file is the history of both arms of an A/B (plan 8.4: "the same seed file in both arms").
//
//   node scripts/repro/async-queue-seed-history.mjs --jobs 50k --out seed-50k.nq.gz [--base-time <epoch ms>]
//   node scripts/repro/async-queue-seed-history.mjs --jobs 10k --out seed-10k.nq.gz --load http://127.0.0.1:9999/bigdata/namespace/<ns>/sparql [--force-nonempty]
//
// --load posts the file to a namespace you own (loopback only unless --allow-remote-backend) and refuses a namespace whose queue control graph already
// holds rows unless --force-nonempty. To seed a G2 node's namespace: stop the node first, then
//   curl --data-binary @seed.nq -H 'Content-Type: text/x-nquads' <namespace sparql url>
// (gunzip a .gz file first). Prints one JSON line: the manifest. --kind lift (publisher history) belongs to P2b.
import { parseArgs } from 'node:util';
import { loadDist, resolveEndpoint, EXIT_REFUSED_BACKEND } from './async-queue-contention/backend.mjs';
import { loadSeedFile, parseCount, writeSeedFile } from './async-queue-contention/history.mjs';

const usage = (msg) => { console.error(`${msg}\nusage: async-queue-seed-history.mjs --jobs 10k|50k --out <file[.gz]> [--kind share] [--base-time <ms>] [--load <namespace sparql url> [--allow-remote-backend] [--force-nonempty]]`); process.exit(2); };
let values;
try {
  ({ values } = parseArgs({ options: { jobs: { type: 'string' }, kind: { type: 'string', default: 'share' }, 'base-time': { type: 'string' }, out: { type: 'string' }, load: { type: 'string' }, 'allow-remote-backend': { type: 'boolean', default: false }, 'force-nonempty': { type: 'boolean', default: false } }, strict: true }));
} catch (e) { usage(e.message); }
if (values.kind === 'lift') usage('--kind lift needs P2b (publisher and mixed cells)');
if (values.kind !== 'share') usage(`unknown --kind ${values.kind}`);
if (!values.out) usage('--out is required');
let jobs;
try { jobs = parseCount(values.jobs); } catch (e) { usage(e.message); }
if (!(jobs > 0)) usage('--jobs must be positive');
const baseTime = values['base-time'] === undefined ? Date.now() : Number(values['base-time']);
if (!Number.isFinite(baseTime)) usage('--base-time must be epoch milliseconds');
let target = null;
if (values.load) {
  try { target = resolveEndpoint({ url: values.load, allowRemote: values['allow-remote-backend'] }); } catch (e) { console.error(e.message); process.exit(e.exitCode ?? EXIT_REFUSED_BACKEND); }
}

const deps = await loadDist();
if (target && !values['force-nonempty']) {
  const res = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' }, body: `ASK { GRAPH <${deps.utils.DEFAULT_PROMOTE_CONTROL_GRAPH_URI}> { ?s ?p ?o } }` });
  if (!res.ok) { console.error(`could not inspect ${target}: HTTP ${res.status}`); process.exit(1); }
  if ((await res.json()).boolean) { console.error('the queue control graph of that namespace is not empty; use --force-nonempty to load anyway'); process.exit(1); }
}
const manifest = await writeSeedFile(deps, { jobs, baseTime, path: values.out });
if (target) {
  console.error(`loading ${values.out} into ${target} (equivalent: gunzip -c ${values.out} | curl --data-binary @- -H 'Content-Type: text/x-nquads' ${target})`);
  manifest.loaded = await loadSeedFile(target, values.out);
}
console.log(JSON.stringify(manifest));
process.exit(0);
