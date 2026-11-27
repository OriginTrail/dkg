import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** One fixed campaign definition; all observed timings live in separate artifacts. */
export function defineCampaign(arm, provenance = 'before-preparation') {
  if (!/^[a-z][a-z0-9-]*$/.test(arm)) throw Error('Invalid campaign arm');
  const author = '0x247B02C301B34E52e9021728F34C3457F81f2dFc';
  const initial = ['readiness-smoke', ...Array.from({ length: 179 }, (_, i) => `initial-${String(i + 1).padStart(3, '0')}`)];
  return { version: 1, arm, provenance, author, contextGraphId: `${author.toLowerCase()}/2963-${arm}-20261016`,
    cohorts: { initial, shares: Array.from({ length: 256 }, (_, i) => `catalog-${String(i).padStart(3, '0')}`),
      publications: initial.slice(0, 48), restart: ['restart-recovery'] },
    faults: [{ name: 'catalog-140', kind: 'typed-not-started' }, { name: 'catalog-141', kind: 'untyped' }],
    triplesPerAsset: 8, publisherWallets: 6, preparationConcurrency: 2, publicationAdmissionConcurrency: 6, shareConcurrency: 4,
    requestTimeoutMs: 120000, readTimeoutMs: 60000, observationIntervalMs: 15000,
    publicationDeadlineMs: 1200000, catalogDrainMs: 1200000, restartDeadlineMs: 1200000, leaseMs: 900000,
  };
}
export function campaignCounts(campaign) {
  const { initial, shares, publications, restart } = campaign.cohorts;
  return { initial: initial.length, shares: shares.length, publications: publications.length,
    main: initial.length + shares.length, restart: initial.length + shares.length + restart.length,
    injected: campaign.faults.length, natural: shares.length - campaign.faults.length };
}
export function loadCampaign(arm, root = '.tmp/2963/evidence') {
  const campaign = JSON.parse(fs.readFileSync(path.join(root, arm, 'campaign-manifest.json')));
  if (campaign.version !== 1 || campaign.arm !== arm) throw Error('Campaign manifest identity mismatch');
  return campaign;
}
export function persistCampaign(arm, provenance = 'before-preparation', root = '.tmp/2963/evidence') {
  const campaign = defineCampaign(arm, provenance), dir = path.join(root, arm), file = path.join(dir, 'campaign-manifest.json');
  if (fs.existsSync(file)) {
    const existing = loadCampaign(arm, root);
    if (JSON.stringify(existing) !== JSON.stringify(campaign)) throw Error('Refusing to replace an immutable campaign manifest');
    return existing;
  }
  if (provenance === 'historical-import') {
    const protocol = JSON.parse(fs.readFileSync(path.join(dir, 'protocol.json'))), counts = campaignCounts(campaign);
    const expected = { arm, cg: campaign.contextGraphId, initialCatalogRows: counts.initial, publications: counts.publications,
      synchronousShares: counts.shares, triplesPerAsset: campaign.triplesPerAsset, publisherWallets: campaign.publisherWallets,
      publicationAdmissionConcurrency: campaign.publicationAdmissionConcurrency, shareConcurrency: campaign.shareConcurrency,
      requestTimeoutMs: campaign.requestTimeoutMs, publicationDeadlineMs: campaign.publicationDeadlineMs, catalogDrainMs: campaign.catalogDrainMs };
    for (const [key, value] of Object.entries(expected)) if (protocol[key] !== value) throw Error(`Historical protocol mismatch: ${key}`);
  } else if (provenance !== 'before-preparation') throw Error('Unknown manifest provenance');
  else if (['requests.jsonl', 'protocol.json', 'pre-workload'].some(name => fs.existsSync(path.join(dir, name)))) {
    throw Error('Preparation already started; use an explicit historical import when its protocol exists');
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(campaign, null, 2) + '\n', { flag: 'wx' });
  return campaign;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [arm, mode] = process.argv.slice(2);
  if (mode !== 'create' && mode !== 'import') throw Error('Expected <arm> create|import');
  persistCampaign(arm, mode === 'import' ? 'historical-import' : 'before-preparation');
  console.log('Persisted immutable campaign manifest:', arm, mode === 'import' ? 'historical import' : 'before preparation');
}
