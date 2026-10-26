#!/usr/bin/env node
// Seeds retained queue history for the async queue contention benchmark (OT-RFC-73 P2a/P2b): a deterministic N-Quads
// file of terminal jobs plus a manifest <out>.json, and optionally a load into a namespace. Needs the built workspace
// (pnpm run build:packages). The same file is the history of both arms of an A/B (plan 8.4: "the same seed file in both
// arms"). The file is a function of --jobs, --base-time and the build's serializers (and --failed-fraction for lift).
//   --kind share (default)  terminal share jobs, 8 quads each, about 2.2 KB per job: 50k jobs are about 110 MB raw, so
//                           use .gz
//   --kind lift             terminal publisher jobs cloned from a real lifecycle (lift-history.mjs): a finalized job is 37
//                           job quads and 60 audit-journal quads (7 entries), a terminal failure 27 and 22 (3 entries),
//                           about 95 quads and 23 KB per job: 10k jobs are about 230 MB raw, so use .gz;
//                           --failed-fraction F (default 0.05) of the jobs are terminal failures.
//                           G2's seeded-history cell is 50k share jobs and 10k lift jobs: one file of each kind.
//
//   node scripts/repro/async-queue-seed-history.mjs --jobs 50k --out seed-50k.nq.gz [--base-time <epoch ms>]
//   node scripts/repro/async-queue-seed-history.mjs --kind lift --jobs 10k --out lift-10k.nq.gz
//   node scripts/repro/async-queue-seed-history.mjs --jobs 10k --out seed-10k.nq.gz \
//        --load http://127.0.0.1:9999/bigdata/namespace/<ns>/sparql [--force-nonempty]
//
// --load posts the file to a namespace you own (loopback only unless --allow-remote-backend) and refuses a namespace
// whose queue control graph (for lift also its journal) already holds rows unless --force-nonempty. To seed a G2 node's
// namespace: stop the node first, then
//   curl --data-binary @seed.nq -H 'Content-Type: text/x-nquads' <namespace sparql url>
// (gunzip a .gz file first). Prints one JSON line: the manifest.
import { parseArgs } from 'node:util';
import { loadDist, resolveEndpoint, EXIT_REFUSED_BACKEND } from './async-queue-contention/backend.mjs';
import { loadSeedFile, parseCount, writeSeedFile } from './async-queue-contention/history.mjs';
import { writeLiftSeedFile } from './async-queue-contention/lift-history.mjs';

const USAGE =
  'usage: async-queue-seed-history.mjs --jobs 10k|50k --out <file[.gz]> [--kind share|lift] [--base-time <ms>] ' +
  '[--failed-fraction F (lift)] [--load <namespace sparql url> [--allow-remote-backend] [--force-nonempty]]';
const usage = (msg) => {
  console.error(`${msg}\n${USAGE}`);
  process.exit(2);
};
const OPTIONS = {
  jobs: { type: 'string' },
  kind: { type: 'string', default: 'share' },
  'base-time': { type: 'string' },
  'failed-fraction': { type: 'string' },
  out: { type: 'string' },
  load: { type: 'string' },
  'allow-remote-backend': { type: 'boolean', default: false },
  'force-nonempty': { type: 'boolean', default: false },
};
let values;
try {
  ({ values } = parseArgs({ options: OPTIONS, strict: true }));
} catch (e) {
  usage(e.message);
}
if (!['share', 'lift'].includes(values.kind)) usage(`unknown --kind ${values.kind}`);
let failedFraction = 0.05;
if (values['failed-fraction'] !== undefined) {
  if (values.kind !== 'lift') usage('--failed-fraction belongs to --kind lift');
  failedFraction = Number(values['failed-fraction']);
  if (!(failedFraction >= 0 && failedFraction <= 1)) usage('--failed-fraction must be a fraction in [0, 1]');
}
if (!values.out) usage('--out is required');
let jobs;
try {
  jobs = parseCount(values.jobs);
} catch (e) {
  usage(e.message);
}
if (!(jobs > 0)) usage('--jobs must be positive');
const baseTime = values['base-time'] === undefined ? Date.now() : Number(values['base-time']);
if (!Number.isFinite(baseTime)) usage('--base-time must be epoch milliseconds');
let target = null;
if (values.load) {
  try {
    target = resolveEndpoint({ url: values.load, allowRemote: values['allow-remote-backend'] });
  } catch (e) {
    console.error(e.message);
    process.exit(e.exitCode ?? EXIT_REFUSED_BACKEND);
  }
}

const deps = await loadDist();
// the graphs the history lives in: the share control graph, or the publisher's control graph and audit journal
const graphs =
  values.kind === 'lift'
    ? [deps.liftControl.DEFAULT_CONTROL_GRAPH_URI, deps.liftControl.DEFAULT_JOURNAL_GRAPH_URI]
    : [deps.utils.DEFAULT_PROMOTE_CONTROL_GRAPH_URI];
if (target && !values['force-nonempty']) {
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' },
    body: `ASK { ${graphs.map((g) => `{ GRAPH <${g}> { ?s ?p ?o } }`).join(' UNION ')} }`,
  });
  if (!res.ok) {
    console.error(`could not inspect ${target}: HTTP ${res.status}`);
    process.exit(1);
  }
  if ((await res.json()).boolean) {
    console.error(
      `the queue graphs of that namespace (${graphs.join(', ')}) are not empty; use --force-nonempty to load anyway`,
    );
    process.exit(1);
  }
}
const manifest =
  values.kind === 'lift'
    ? await writeLiftSeedFile(deps, { jobs, baseTime, failedFraction, path: values.out })
    : await writeSeedFile(deps, { jobs, baseTime, path: values.out });
if (target) {
  console.error(
    `loading ${values.out} into ${target} ` +
      `(equivalent: gunzip -c ${values.out} | curl --data-binary @- -H 'Content-Type: text/x-nquads' ${target})`,
  );
  manifest.loaded = await loadSeedFile(target, values.out);
}
console.log(JSON.stringify(manifest));
process.exit(0);
