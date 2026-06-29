/**
 * `@origintrail-official/dkg-ip-oracle` — engineering harness for the
 * IP / Patent Context Oracle.
 *
 * Deterministic, **synthetic** Google-Patents-shaped OKF corpus generator (no
 * BigQuery / GCP dependency), reproducible from a seed. The corpus is imported
 * into a PRIVATE Context Graph via `dkg okf import --private`; substance stays
 * private, only a minimal on-chain discoverability signal is ever made public.
 *
 * The data is SIMULATED — every concept stamps `source: … [SIMULATED]` and a
 * CC BY 4.0 licence so the downstream redaction guard and the public article
 * stay honest about real-vs-generated.
 */

export {
  generatePatentBundle,
  writePatentBundle,
  pubNumber,
  type PatentGenOptions,
  type BundleFile,
} from './patent-generator.js';

export {
  ingestPatentExport,
  buildPatentFromRow,
  type PatentRow,
  type IngestOptions,
  type IngestSummary,
  type ShardSummary,
} from './patent-ingest.js';

export { mulberry32, streamFor, pick, intBetween } from './prng.js';
