/* eslint-disable no-constant-condition, unicorn/no-new-array -- Preserve the frozen comparison runner; each loop has an explicit exit. */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadApiClientToken } from '../../packages/cli/dist/auth.js';
import { DkgHomeFiles } from '../../packages/cli/dist/config.js';

// Run from repository root. One-shot HTTP requests: no silent mutation retries.
const arm = process.argv[2] ?? 'baseline';
const mode = process.argv[3] ?? 'prepare';
const root = path.resolve('.tmp/2963');
const evidence = path.join(root, 'evidence', arm);
fs.mkdirSync(evidence, { recursive: true });
const home = process.env.DKG_HOME;
const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json')));
const token = await loadApiClientToken(new DkgHomeFiles(home));
const base = `http://127.0.0.1:${config.apiPort}`;
const cg = `0x247b02c301b34e52e9021728f34c3457f81f2dfc/2963-${arm}-20261016`;
const names = ['readiness-smoke', ...Array.from({ length: 179 }, (_, i) => `initial-${String(i + 1).padStart(3, '0')}`)];
const catalogNames = Array.from({ length: 256 }, (_, i) => `catalog-${String(i).padStart(3, '0')}`);
const log = (entry) => fs.appendFileSync(path.join(evidence, 'requests.jsonl'), JSON.stringify(entry) + '\n');
const save = (name, value) => fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(value, null, 2));
async function request(route, body, label, timeout = 120_000) {
  const startedAt = new Date().toISOString(), start = performance.now();
  try {
    const r = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    const text = await r.text(); let value; try { value = JSON.parse(text); } catch { value = { text }; }
    const result = { label, route, startedAt, durationMs: performance.now() - start, status: r.status, value };
    log(result); return result;
  } catch (e) { const result = { label, route, startedAt, durationMs: performance.now() - start, status: null, error: e.message }; log(result); return result; }
}
async function concurrent(items, count, fn) {
  let cursor = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: count }, async () => { for (;;) { const i = cursor++; if (i >= items.length) return; out[i] = await fn(items[i], i); } }));
  return out;
}
const payload = (name) => Array.from({ length: 8 }, (_, i) => ({ subject: `urn:2963:${arm}:${name}`, predicate: `https://schema.org/p${i}`, object: JSON.stringify(`${name} value ${i}`), graph: '' }));
const create = (name, share) => request('/api/knowledge-assets', { contextGraphId: cg, name, quads: payload(name), finalize: true, alsoShareSwm: share }, `prepare:${name}`);
if (mode === 'prepare') {
  // The separately captured readiness smoke is initial row zero.
  const initial = await concurrent(names.slice(1), 2, async (name, i) => { const r = await create(name, true); if ((i + 1) % 20 === 0) console.log('initial', i + 1, r.status); return r; });
  save('initial-preparation', initial);
  if (initial.some(r => r.status !== 201 || r.value.status !== 'swm-shared')) throw new Error('Initial preparation failed; retained without repair');
  const drafts = await concurrent(catalogNames, 2, async (name, i) => { const r = await create(name, false); if ((i + 1) % 32 === 0) console.log('drafts', i + 1, r.status); return r; });
  save('catalog-drafts', drafts);
  if (drafts.some(r => r.status !== 201)) throw new Error('Draft preparation failed; retained without repair');
  console.log('Preparation finished; readiness and exact starting inventory must be checked before run.');
} else if (mode === 'run') {
  const readiness = await request('/api/status', undefined, 'readiness:status');
  const current = readiness.value?.rfc64Catalog?.contextGraphs?.find(c => c.contextGraphId === cg);
  if (!readiness.value?.asyncPublisher?.available || current?.phase !== 'complete'
    || current.appliedRowCount !== '180' || current.legacyReadOnlyCount !== 0
    || current.authorityState !== 'accepted' || current.authorityFreshness !== 'current') {
    throw new Error('Readiness barrier refused workload before any measured mutation');
  }
  let monitoring = true;
  const monitor = (async () => {
    while (monitoring) {
      for (const name of ['catalog-140', 'catalog-141']) {
        if (!fs.existsSync(path.join(home, `2963-fault-${name}.json`))) continue;
        for (const author of [undefined, '0x247B02C301B34E52e9021728F34C3457F81f2dFc']) {
          const params = new URLSearchParams({ contextGraphId: cg, ...(author ? { agentAddress: author } : {}) });
          await request(`/api/knowledge-assets/${name}?${params}`, undefined, `recovery-observe:${name}:${author ?? 'default'}`, 60_000);
        }
      }
      if (monitoring) await new Promise(resolve => setTimeout(resolve, 15000));
    }
  })();
  const start = Date.now();
  const protocol = { arm, cg, startedAt: new Date(start).toISOString(), initialCatalogRows: 180, publications: 48, synchronousShares: 256, triplesPerAsset: 8, publisherWallets: 6, publicationAdmissionConcurrency: 6, shareConcurrency: 4, requestTimeoutMs: 120000, publicationDeadlineMs: 1200000, catalogDrainMs: 1200000, manualRepairs: 0 };
  save('protocol', protocol);
  const [publications, shares] = await Promise.all([
    concurrent(names.slice(0, 48), 6, name => request(`/api/knowledge-assets/${name}/vm/publish-async`, { contextGraphId: cg, options: { publishEpochs: 1, publisherNodeIdentityId: '0' } }, `publish:${name}`)),
    concurrent(catalogNames, 4, name => request(`/api/knowledge-assets/${name}/swm/share`, { contextGraphId: cg }, `share:${name}`)),
  ]);
  save('publication-admissions', publications); save('synchronous-shares', shares);
  const trafficEnd = Date.now(); save('traffic-end', { at: new Date(trafficEnd).toISOString(), elapsedMs: trafficEnd - start });
  console.log('Traffic complete', publications.filter(x => x.status === 202).length, '/48 publications admitted;', shares.filter(x => x.status === 200).length, '/256 shares HTTP 200');
  let pass = 0;
  do {
    const [jobs, status] = await Promise.all([request('/api/publisher/jobs?limit=1000', undefined, 'observe:jobs'), request('/api/status', undefined, 'observe:status')]);
    const catalog = status.value?.rfc64Catalog?.contextGraphs?.find(c => c.contextGraphId === cg);
    save('observation-' + pass++, { observedAt: new Date().toISOString(), jobs, catalog });
    console.log('observe', pass, catalog?.phase, catalog?.appliedRowCount, catalog?.legacyReadOnlyCount);
    const rows = Array.isArray(jobs.value) ? jobs.value : jobs.value?.jobs ?? [];
    const ids = publications.map(r => r.value?.jobId).filter(Boolean);
    const complete = ids.length === 48 && ids.every(id => rows.some(j => j.jobId === id && j.status === 'finalized'));
    if (complete && catalog?.phase === 'complete' && catalog?.appliedRowCount === '436' && catalog?.legacyReadOnlyCount === 0) break;
    if (Date.now() >= Math.max(start + protocol.publicationDeadlineMs, trafficEnd + protocol.catalogDrainMs)) break;
    await new Promise(resolve => setTimeout(resolve, 15000));
  } while (true);
  monitoring = false; await monitor;
  console.log('Observation finished; exact RDF, inventory, identity, receipt and nonce verification still required.');
} else throw new Error('Expected prepare or run');
