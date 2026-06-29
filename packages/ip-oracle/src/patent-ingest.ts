/**
 * Real Google Patents Public Data → OKF bundle ingest.
 *
 * Maps a newline-delimited JSON (NDJSON) export of
 * `patents-public-data.patents.publications` (one flattened row per publication)
 * into the SAME OKF concept shape the synthetic generator emits — but with REAL
 * bibliographic fields, real CC BY 4.0 provenance (no `[SIMULATED]` stamp), and
 * NO synthetic substance fields (claim charts / essentiality are a later PRIVATE
 * enrichment layer, never part of raw capture).
 *
 * The BigQuery query is run by the OPERATOR (their GCP project, their billing);
 * this module is pure/offline — it reads the export file, needs no GCP SDK and no
 * network, and is deterministic for a given export. For 1M+ rows it streams
 * line-by-line (memory-bounded) and can shard the output by CPC subclass so each
 * shard imports into its own private Context Graph (avoids the single-CG write
 * throughput collapse observed at scale).
 *
 * Out-of-slice citations are recorded as the `cited_patents` frontmatter list
 * (preserved as data), NOT as markdown concept-links: a link to a patent absent
 * from the bundle is a broken-link warning (SPEC §5.3), not an edge, so at 1M
 * scale rendering them would be a warning storm and yield no graph edges.
 */

import { dump as dumpYaml } from 'js-yaml';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { BundleFile } from './patent-generator.js';

export type { BundleFile };

/** Flattened row shape produced by the provided BigQuery extract (the contract). */
export interface PatentRow {
  /** e.g. `US-9876543-B2` — required; rows without it are skipped + counted. */
  publication_number?: string;
  country_code?: string;
  title?: string;
  abstract?: string;
  assignee?: string;
  /** CPC subclass, e.g. `H04L`. Derived from `cpc_group` when absent. */
  cpc_class?: string;
  /** First inventive CPC code, e.g. `H04L29/06`. */
  cpc_group?: string;
  /** `YYYY-MM-DD`. */
  filing_date?: string;
  publication_date?: string;
  family_id?: string;
  /** Cited publication numbers (recorded as data, not concept-links). */
  cited_patents?: string[];
}

export interface IngestOptions {
  /** Stamped retrieval date + dateModified (YYYY-MM-DD). */
  retrievalDate?: string;
  /** Write one self-contained OKF bundle per CPC subclass (recommended at scale). */
  shardByCpc?: boolean;
}

export interface ShardSummary {
  cpcClass: string;
  outDir: string;
  count: number;
}

export interface IngestSummary {
  conceptCount: number;
  skipped: number;
  shards: ShardSummary[];
  outDir: string;
  retrievalDate: string;
}

const PUBNUM_RE = /^[A-Za-z]{2}-[A-Za-z0-9-]+$/;
const SUBCLASS_RE = /^([A-HY]\d{2}[A-Z])/;
const INDEX_PREVIEW_CAP = 200;

/** CPC subclass for a row: explicit `cpc_class`, else derived from `cpc_group`. */
function subclassOf(row: PatentRow): string {
  if (row.cpc_class && row.cpc_class.trim()) return row.cpc_class.trim();
  const m = (row.cpc_group ?? '').match(SUBCLASS_RE);
  return m ? m[1] : 'UNKNOWN';
}

/** Collapse an abstract to a single-line, length-bounded description. */
function toDescription(row: PatentRow, jur: string, group: string): string {
  const abstract = (row.abstract ?? '').replace(/\s+/g, ' ').trim();
  if (abstract) return abstract.length > 500 ? `${abstract.slice(0, 497)}…` : abstract;
  return `A ${jur} patent classified under CPC ${group || 'n/a'}.`;
}

/**
 * Map one export row → an OKF `Patent` concept. Returns the file plus its CPC
 * subclass (for sharding/indexing), or `null` if the row lacks a usable
 * publication number.
 */
export function buildPatentFromRow(
  row: PatentRow,
  retrievalDate: string,
): { file: BundleFile; cpcClass: string; pub: string } | null {
  const pub = (row.publication_number ?? '').trim();
  if (!pub || !PUBNUM_RE.test(pub)) return null;

  const cpcClass = subclassOf(row);
  const jur = (row.country_code ?? pub.split('-')[0] ?? '').trim();
  const group = (row.cpc_group ?? '').trim();
  const title = (row.title ?? '').replace(/\s+/g, ' ').trim();
  const cited = (row.cited_patents ?? []).filter((c) => typeof c === 'string' && c.trim());

  const frontmatter: Record<string, unknown> = {
    type: 'Patent',
    title: title ? `${pub} — ${title}` : pub,
    description: toDescription(row, jur, group),
    patent_number: pub,
    jurisdiction: jur,
    cpc_class: cpcClass,
    ...(group ? { cpc_group: group } : {}),
    ...(row.assignee && row.assignee.trim() ? { assignee: row.assignee.trim() } : {}),
    ...(row.family_id && String(row.family_id).trim()
      ? { family_id: String(row.family_id).trim() }
      : {}),
    ...(row.filing_date ? { filing_date: row.filing_date } : {}),
    ...(row.publication_date ? { publication_date: row.publication_date } : {}),
    citation_count: cited.length,
    // Cited patents kept as DATA (not concept-links): out-of-slice targets would
    // otherwise be broken-link warnings, not edges (SPEC §5.3).
    ...(cited.length ? { cited_patents: cited } : {}),
    // Provenance / licence — public-safe bibliographic metadata (CC BY 4.0):
    license: 'CC BY 4.0',
    source: 'Google Patents Public Data (patents-public-data)',
    retrieval_date: retrievalDate,
    timestamp: `${retrievalDate}T00:00:00+00:00`,
  };

  const body: string[] = [];
  const descLead = title
    ? `${pub} — ${title}, a ${jur} patent`
    : `${pub}, a ${jur} patent`;
  body.push(
    `This record describes ${descLead}${group ? ` classified under CPC ${group}` : ''}.`,
    '',
    '# Citations',
    '',
    `[1] [Google Patents ${pub}](https://patents.google.com/patent/${pub.replace(/-/g, '')}/en)`,
    '',
  );

  const yaml = dumpYaml(frontmatter, { sortKeys: false, lineWidth: -1 }).trimEnd();
  return {
    file: { path: `patents/${pub}.md`, content: `---\n${yaml}\n---\n\n${body.join('\n')}` },
    cpcClass,
    pub,
  };
}

interface ShardState {
  count: number;
  preview: string[];
  dir: string;
}

function rootIndex(cpcClass: string, count: number): string {
  return [
    '---',
    'okf_version: "0.1"',
    '---',
    '',
    `# IP Context Oracle — CPC ${cpcClass} (Google Patents Public Data)`,
    '',
    `* [patents](patents/index.md) - ${count} real CPC ${cpcClass} patent records (CC BY 4.0)`,
    '',
  ].join('\n');
}

function patentsIndex(cpcClass: string, count: number, preview: string[]): string {
  const lines = [`# CPC ${cpcClass} patents`, ''];
  for (const pub of preview) lines.push(`* [${pub}](${pub}.md)`);
  if (count > preview.length) lines.push(`* … and ${count - preview.length} more`);
  lines.push('');
  return lines.join('\n');
}

function changeLog(cpcClass: string, count: number, retrievalDate: string): string {
  return [
    '# Log',
    '',
    `## ${retrievalDate}`,
    '',
    `**Creation** - ingested ${count} real CPC ${cpcClass} patent concepts from ` +
      'Google Patents Public Data (patents-public-data), CC BY 4.0.',
    '',
  ].join('\n');
}

function writeShardIndexes(
  shard: ShardState,
  cpcClass: string,
  retrievalDate: string,
): void {
  writeFileSync(join(shard.dir, 'patents', 'index.md'), patentsIndex(cpcClass, shard.count, shard.preview));
  writeFileSync(join(shard.dir, 'index.md'), rootIndex(cpcClass, shard.count));
  writeFileSync(join(shard.dir, 'log.md'), changeLog(cpcClass, shard.count, retrievalDate));
}

/**
 * Stream an NDJSON export → OKF bundle(s) on disk. Memory-bounded: one row at a
 * time, retaining only per-shard counts + a capped index preview. Resolves once
 * the stream ends.
 */
export async function ingestPatentExport(
  inputPath: string,
  outDir: string,
  opts: IngestOptions = {},
): Promise<IngestSummary> {
  const retrievalDate = opts.retrievalDate ?? new Date().toISOString().slice(0, 10);
  const shardByCpc = opts.shardByCpc ?? false;
  const shards = new Map<string, ShardState>();
  let conceptCount = 0;
  let skipped = 0;

  const ensureShard = (cpcClass: string): ShardState => {
    const key = shardByCpc ? cpcClass : '.';
    let shard = shards.get(key);
    if (!shard) {
      const dir = shardByCpc ? join(outDir, cpcClass) : outDir;
      mkdirSync(join(dir, 'patents'), { recursive: true });
      shard = { count: 0, preview: [], dir };
      shards.set(key, shard);
    }
    return shard;
  };

  const rl = createInterface({
    input: createReadStream(inputPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: PatentRow;
    try {
      row = JSON.parse(trimmed) as PatentRow;
    } catch {
      skipped++;
      continue;
    }
    const built = buildPatentFromRow(row, retrievalDate);
    if (!built) {
      skipped++;
      continue;
    }
    const shard = ensureShard(built.cpcClass);
    writeFileSync(join(shard.dir, built.file.path), built.file.content);
    shard.count++;
    conceptCount++;
    if (shard.preview.length < INDEX_PREVIEW_CAP) shard.preview.push(built.pub);
  }

  const summary: ShardSummary[] = [];
  for (const [key, shard] of shards) {
    const cpcLabel = shardByCpc ? key : 'mixed';
    writeShardIndexes(shard, cpcLabel, retrievalDate);
    summary.push({ cpcClass: cpcLabel, outDir: shard.dir, count: shard.count });
  }

  return { conceptCount, skipped, shards: summary, outDir, retrievalDate };
}
