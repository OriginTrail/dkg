import { loadCampaign, persistCampaign, campaignCounts } from './campaign-manifest.mjs';
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
const campaign = mode === 'prepare' ? persistCampaign(arm) : loadCampaign(arm), counts = campaignCounts(campaign);
const cg = campaign.contextGraphId, names = campaign.cohorts.initial, catalogNames = campaign.cohorts.shares;
const log = (entry) => fs.appendFileSync(path.join(evidence, 'requests.jsonl'), JSON.stringify(entry) + '\n');
const save = (name, value) => fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(value, null, 2));
async function request(route, body, label, timeout = campaign.requestTimeoutMs) {
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
const payload = (name) => Array.from({ length: campaign.triplesPerAsset }, (_, i) => ({ subject: `urn:2963:${arm}:${name}`, predicate: `https://schema.org/p${i}`, object: JSON.stringify(`${name} value ${i}`), graph: '' }));
const create = (name, share) => request('/api/knowledge-assets', { contextGraphId: cg, name, quads: payload(name), finalize: true, alsoShareSwm: share }, `prepare:${name}`);
if (mode === 'prepare') {
  // The separately captured readiness smoke is initial row zero.
  const initial = await concurrent(names.slice(1), campaign.preparationConcurrency, async (name, i) => { const r = await create(name, true); if ((i + 1) % 20 === 0) console.log('initial', i + 1, r.status); return r; });
  save('initial-preparation', initial);
  if (initial.some(r => r.status !== 201 || r.value.status !== 'swm-shared')) throw new Error('Initial preparation failed; retained without repair');
  const drafts = await concurrent(catalogNames, campaign.preparationConcurrency, async (name, i) => { const r = await create(name, false); if ((i + 1) % 32 === 0) console.log('drafts', i + 1, r.status); return r; });
  save('catalog-drafts', drafts);
  if (drafts.some(r => r.status !== 201)) throw new Error('Draft preparation failed; retained without repair');
  console.log('Preparation finished; readiness and exact starting inventory must be checked before run.');
} else if (mode === 'run') {
  const readiness = await request('/api/status', undefined, 'readiness:status');
  const current = readiness.value?.rfc64Catalog?.contextGraphs?.find(c => c.contextGraphId === cg);
  if (!readiness.value?.asyncPublisher?.available || current?.phase !== 'complete'
    || current.appliedRowCount !== String(counts.initial) || current.legacyReadOnlyCount !== 0
    || current.authorityState !== 'accepted' || current.authorityFreshness !== 'current') {
    throw new Error('Readiness barrier refused workload before any measured mutation');
  }
  let monitoring = true;
  const monitor = (async () => {
    while (monitoring) {
      for (const name of campaign.faults.map(f => f.name)) {
        if (!fs.existsSync(path.join(home, `2963-fault-${name}.json`))) continue;
        for (const author of [undefined, campaign.author]) {
          const params = new URLSearchParams({ contextGraphId: cg, ...(author ? { agentAddress: author } : {}) });
          await request(`/api/knowledge-assets/${name}?${params}`, undefined, `recovery-observe:${name}:${author ?? 'default'}`, campaign.readTimeoutMs);
        }
      }
      if (monitoring) await new Promise(resolve => setTimeout(resolve, campaign.observationIntervalMs));
    }
  })();
  const start = Date.now();
  const protocol = { arm, cg, startedAt: new Date(start).toISOString(), initialCatalogRows: counts.initial,
    publications: counts.publications, synchronousShares: counts.shares, triplesPerAsset: campaign.triplesPerAsset,
    publisherWallets: campaign.publisherWallets, publicationAdmissionConcurrency: campaign.publicationAdmissionConcurrency,
    shareConcurrency: campaign.shareConcurrency, requestTimeoutMs: campaign.requestTimeoutMs,
    publicationDeadlineMs: campaign.publicationDeadlineMs, catalogDrainMs: campaign.catalogDrainMs, manualRepairs: 0 };
  save('protocol', protocol);
  const [publications, shares] = await Promise.all([
    concurrent(campaign.cohorts.publications, campaign.publicationAdmissionConcurrency, name => request(`/api/knowledge-assets/${name}/vm/publish-async`, { contextGraphId: cg, options: { publishEpochs: 1, publisherNodeIdentityId: '0' } }, `publish:${name}`)),
    concurrent(catalogNames, campaign.shareConcurrency, name => request(`/api/knowledge-assets/${name}/swm/share`, { contextGraphId: cg }, `share:${name}`)),
  ]);
  save('publication-admissions', publications); save('synchronous-shares', shares);
  const trafficEnd = Date.now(); save('traffic-end', { at: new Date(trafficEnd).toISOString(), elapsedMs: trafficEnd - start });
  console.log('Traffic complete', publications.filter(x => x.status === 202).length, `/${counts.publications} publications admitted;`, shares.filter(x => x.status === 200).length, `/${counts.shares} shares HTTP 200`);
  let pass = 0;
  do {
    const [jobs, status] = await Promise.all([request('/api/publisher/jobs?limit=1000', undefined, 'observe:jobs'), request('/api/status', undefined, 'observe:status')]);
    const catalog = status.value?.rfc64Catalog?.contextGraphs?.find(c => c.contextGraphId === cg);
    save('observation-' + pass++, { observedAt: new Date().toISOString(), jobs, catalog });
    console.log('observe', pass, catalog?.phase, catalog?.appliedRowCount, catalog?.legacyReadOnlyCount);
    const rows = Array.isArray(jobs.value) ? jobs.value : jobs.value?.jobs ?? [];
    const ids = publications.map(r => r.value?.jobId).filter(Boolean);
    const complete = ids.length === counts.publications && ids.every(id => rows.some(j => j.jobId === id && j.status === 'finalized'));
    if (complete && catalog?.phase === 'complete' && catalog?.appliedRowCount === String(counts.main) && catalog?.legacyReadOnlyCount === 0) break;
    if (Date.now() >= Math.max(start + protocol.publicationDeadlineMs, trafficEnd + protocol.catalogDrainMs)) break;
    await new Promise(resolve => setTimeout(resolve, campaign.observationIntervalMs));
  } while (true);
  monitoring = false; await monitor;
  console.log('Observation finished; exact RDF, inventory, identity, receipt and nonce verification still required.');
} else throw new Error('Expected prepare or run');
