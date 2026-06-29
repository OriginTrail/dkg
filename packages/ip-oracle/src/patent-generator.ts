/**
 * Deterministic synthetic patent → OKF bundle generator.
 *
 * Produces a Google-Patents-shaped OKF corpus (CPC class, jurisdictions,
 * assignees, families, backward citations, counts, coverage, CC-BY licence/source
 * stamps) WITHOUT any external dependency (no BigQuery/GCP) so a 100k-asset sample
 * is reproducible on any host. The data is SIMULATED — every concept stamps
 * `source: ... [SIMULATED]` so the redaction guard and the article can be honest
 * about real-vs-synthetic.
 *
 * OKF mechanics it exercises (so the importer's graph reconstruction is real):
 *   - per-patent concept files under `patents/`, concept ID = publication number
 *   - `# Prior art` section → markdown links to cited patents (schema:mentions edges)
 *   - `# Patent family` section → links to family members (schema:mentions edges)
 *   - `# Citations` section → external Google-Patents URL (schema:citation)
 *   - substance fields (claim chart ref, essentiality note) kept in the concept,
 *     to be gated to the private CG — never surfaced in the public descriptor.
 */

import { dump as dumpYaml } from 'js-yaml';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BundleFile } from '@origintrail-official/dkg-okf';
import { streamFor, pick, intBetween } from './prng.js';

export type { BundleFile };

export interface PatentGenOptions {
  /** CPC subclass, e.g. `H04L`. */
  cpcClass: string;
  /** Number of patent concepts to emit. */
  count: number;
  seed?: number;
  jurisdictions?: string[];
  yearFrom?: number;
  yearTo?: number;
  owners?: string[];
  /** Max backward citations per patent (to earlier patents in the slice). */
  citationsPerPatent?: number;
  /** Patents per simulated family. */
  familySize?: number;
  /** ISO date stamped as retrieval date + dateModified. */
  retrievalDate?: string;
}

interface ResolvedOpts extends Required<PatentGenOptions> {}

const DEFAULT_OWNERS = [
  'Acme Wireless Inc', 'Northstar Communications', 'Globex Semiconductor',
  'Initech Networks', 'Umbrella Telecom', 'Hooli Labs', 'Stark Radio Systems',
  'Wayne Signal Co', 'Soylent Comms', 'Vandelay Wireless',
];
const DEFAULT_JUR = ['US', 'EP', 'WO', 'CN', 'JP', 'KR'];
const KIND: Record<string, string> = { US: 'B2', EP: 'B1', WO: 'A1', CN: 'A', JP: 'B2', KR: 'B1' };
const TOPICS = [
  'method and apparatus for', 'system for', 'technique for', 'circuit for',
  'protocol for', 'framework for',
];
const SUBJECTS = [
  'adaptive channel coding', 'low-latency packet scheduling', 'beamforming control',
  'error-resilient transmission', 'secure key exchange', 'carrier aggregation',
  'network slice orchestration', 'interference cancellation', 'hybrid ARQ retransmission',
  'spectrum sensing',
];

function resolve(opts: PatentGenOptions): ResolvedOpts {
  return {
    cpcClass: opts.cpcClass,
    count: opts.count,
    seed: opts.seed ?? 42,
    jurisdictions: opts.jurisdictions ?? DEFAULT_JUR,
    yearFrom: opts.yearFrom ?? 2008,
    yearTo: opts.yearTo ?? 2024,
    owners: opts.owners ?? DEFAULT_OWNERS,
    citationsPerPatent: opts.citationsPerPatent ?? 4,
    familySize: opts.familySize ?? 3,
    retrievalDate: opts.retrievalDate ?? '2026-06-25',
  };
}

/** Pure: jurisdiction for a patent index (so citation targets are recomputable). */
function jurOf(o: ResolvedOpts, i: number): string {
  return pick(streamFor(o.seed + 1, i), o.jurisdictions);
}

/** Internal: publication number from already-resolved options. */
function pubNumberAt(o: ResolvedOpts, i: number): string {
  const jur = jurOf(o, i);
  return `${jur}${10_000_000 + i}${KIND[jur] ?? 'A1'}`;
}

/**
 * Publication number for patent `index` — a valid OKF concept-ID segment, and
 * the downstream recompute API for citation/family targets. Takes the public
 * {@link PatentGenOptions} (resolving defaults internally) so callers never need
 * the private resolved-options shape; deterministic for a given (options, index).
 */
export function pubNumber(opts: PatentGenOptions, index: number): string {
  return pubNumberAt(resolve(opts), index);
}

function familyId(o: ResolvedOpts, i: number): string {
  return `FAM-${o.cpcClass}-${Math.floor(i / o.familySize)}`;
}

function buildPatent(o: ResolvedOpts, i: number): BundleFile {
  const rand = streamFor(o.seed, i);
  const pub = pubNumberAt(o, i);
  const jur = jurOf(o, i);
  const subject = pick(rand, SUBJECTS);
  const title = `${pick(rand, TOPICS)} ${subject}`;
  const group = `${o.cpcClass}${intBetween(rand, 1, 69)}/${intBetween(rand, 1, 99)}`;
  const year = intBetween(rand, o.yearFrom, o.yearTo);
  const filing = `${year}-${String(intBetween(rand, 1, 12)).padStart(2, '0')}-${String(intBetween(rand, 1, 28)).padStart(2, '0')}`;
  const publication = `${Math.min(year + intBetween(rand, 1, 3), o.yearTo + 3)}-${String(intBetween(rand, 1, 12)).padStart(2, '0')}-${String(intBetween(rand, 1, 28)).padStart(2, '0')}`;
  const owner = pick(rand, o.owners);

  // Backward citations: earlier indices only (so the edge graph is a DAG).
  const nCite = i === 0 ? 0 : intBetween(rand, 0, Math.min(o.citationsPerPatent, i));
  const cited = new Set<number>();
  for (let k = 0; k < nCite; k++) cited.add(intBetween(rand, 0, i - 1));
  // Family members (same family group, excluding self).
  const famStart = Math.floor(i / o.familySize) * o.familySize;
  const family: number[] = [];
  for (let j = famStart; j < Math.min(famStart + o.familySize, o.count); j++) {
    if (j !== i) family.push(j);
  }

  const frontmatter = {
    type: 'Patent',
    title: `${pub} — ${title}`,
    description: `A ${jur} patent in CPC ${group} concerning ${subject}. (Simulated bibliographic record.)`,
    patent_number: pub,
    jurisdiction: jur,
    cpc_class: o.cpcClass,
    cpc_group: group,
    assignee: owner,
    family_id: familyId(o, i),
    filing_date: filing,
    publication_date: publication,
    citation_count: cited.size,
    family_size: family.length + 1,
    // Substance — gated to the private CG, never public:
    claim_chart_ref: `CC-${pub}-001`,
    essentiality_note: `Potential SEP for ${subject}; essentiality assessed against ${o.cpcClass} working assumptions (simulated).`,
    // Provenance / licence — public-safe bibliographic metadata:
    license: 'CC BY 4.0',
    source: 'Google Patents Public Data (patents-public-data) [SIMULATED]',
    retrieval_date: o.retrievalDate,
    timestamp: `${o.retrievalDate}T00:00:00+00:00`,
  };

  const body: string[] = [];
  body.push(
    `This record describes ${pub}, a simulated ${jur} patent assigned to ${owner}, ` +
      `classified under CPC ${group}. It concerns ${subject}.`,
    '',
  );
  if (cited.size > 0) {
    body.push('# Prior art', '');
    for (const c of [...cited].sort((a, b) => a - b)) {
      body.push(`* [${pubNumberAt(o, c)}](${pubNumberAt(o, c)}.md)`);
    }
    body.push('');
  }
  if (family.length > 0) {
    body.push('# Patent family', '');
    for (const f of family) body.push(`* [${pubNumberAt(o, f)}](${pubNumberAt(o, f)}.md)`);
    body.push('');
  }
  body.push(
    '# Citations',
    '',
    `[1] [Google Patents ${pub}](https://patents.google.com/patent/${pub}/en)`,
    '',
  );

  const yaml = dumpYaml(frontmatter, { sortKeys: false, lineWidth: -1 }).trimEnd();
  return { path: `patents/${pub}.md`, content: `---\n${yaml}\n---\n\n${body.join('\n')}` };
}

/** Generate the whole bundle in memory (for tests / small N). */
export function generatePatentBundle(opts: PatentGenOptions): BundleFile[] {
  const o = resolve(opts);
  const files: BundleFile[] = [];
  for (let i = 0; i < o.count; i++) files.push(buildPatent(o, i));
  files.push(patentsIndex(o), rootIndex(o), changeLog(o));
  return files;
}

function patentsIndex(o: ResolvedOpts): BundleFile {
  const lines = [`# CPC ${o.cpcClass} patents`, ''];
  const cap = Math.min(o.count, 200); // index lists a capped preview for huge corpora
  for (let i = 0; i < cap; i++) lines.push(`* [${pubNumberAt(o, i)}](${pubNumberAt(o, i)}.md)`);
  if (o.count > cap) lines.push(`* … and ${o.count - cap} more`);
  lines.push('');
  return { path: 'patents/index.md', content: lines.join('\n') };
}

function rootIndex(o: ResolvedOpts): BundleFile {
  return {
    path: 'index.md',
    content: [
      '---',
      'okf_version: "0.1"',
      '---',
      '',
      `# IP Context Oracle sample — CPC ${o.cpcClass}`,
      '',
      `* [patents](patents/index.md) - ${o.count} simulated CPC ${o.cpcClass} patent records`,
      '',
    ].join('\n'),
  };
}

function changeLog(o: ResolvedOpts): BundleFile {
  return {
    path: 'log.md',
    content: [
      '# Log', '',
      `## ${o.retrievalDate}`, '',
      `**Creation** - generated ${o.count} simulated CPC ${o.cpcClass} patent concepts ` +
        `(seed ${o.seed}); source Google Patents Public Data schema [SIMULATED].`, '',
    ].join('\n'),
  };
}

/**
 * Stream the bundle straight to disk — memory-bounded for large N (100k+).
 * Returns a summary; does not retain all files in memory.
 */
export function writePatentBundle(
  opts: PatentGenOptions,
  outDir: string,
): { conceptCount: number; outDir: string; cpcClass: string; seed: number } {
  const o = resolve(opts);
  mkdirSync(join(outDir, 'patents'), { recursive: true });
  for (let i = 0; i < o.count; i++) {
    const f = buildPatent(o, i);
    writeFileSync(join(outDir, f.path), f.content);
  }
  const idx = patentsIndex(o);
  writeFileSync(join(outDir, idx.path), idx.content);
  const root = rootIndex(o);
  writeFileSync(join(outDir, root.path), root.content);
  const log = changeLog(o);
  writeFileSync(join(outDir, log.path), log.content);
  return { conceptCount: o.count, outDir, cpcClass: o.cpcClass, seed: o.seed };
}
