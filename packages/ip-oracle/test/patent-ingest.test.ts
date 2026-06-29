import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importBundle, loadBundleDir, validateBundle } from '@origintrail-official/dkg-okf';
import { buildPatentFromRow, ingestPatentExport, type PatentRow } from '../src/index.js';

const ROW: PatentRow = {
  publication_number: 'US-9876543-B2',
  country_code: 'US',
  title: 'method for low-latency packet scheduling',
  abstract: 'A system that schedules packets with low latency across a radio link.',
  assignee: 'Acme Wireless Inc',
  cpc_class: 'H04L',
  cpc_group: 'H04L47/00',
  filing_date: '2015-03-12',
  publication_date: '2017-06-20',
  family_id: '55066910',
  cited_patents: ['US-8000000-B1', 'EP-1234567-B1'],
};

describe('real-data patent ingest (buildPatentFromRow)', () => {
  it('maps a row to a §9-conformant Patent concept with CC BY 4.0, no [SIMULATED]', () => {
    const built = buildPatentFromRow(ROW, '2026-06-28');
    expect(built).not.toBeNull();
    expect(built!.cpcClass).toBe('H04L');
    expect(built!.file.path).toBe('patents/US-9876543-B2.md');
    const c = built!.file.content;
    expect(c).toContain('type: Patent');
    expect(c).toContain('license: CC BY 4.0');
    expect(c).toContain('source: Google Patents Public Data (patents-public-data)');
    expect(c).not.toContain('[SIMULATED]');
    // substance fields are NOT part of raw capture
    expect(c).not.toContain('claim_chart_ref');
    expect(c).not.toContain('essentiality_note');
    // bundle of one validates
    const { concepts } = importBundle([built!.file]);
    expect(concepts).toHaveLength(1);
    expect(validateBundle([built!.file]).conformant).toBe(true);
  });

  it('records citations as data, not as concept-links (no broken-link edges)', () => {
    const built = buildPatentFromRow(ROW, '2026-06-28')!;
    expect(built.file.content).toContain('cited_patents');
    expect(built.file.content).toContain('citation_count: 2');
    // no markdown link to a cited patent .md (which would be a broken-link warning)
    expect(built.file.content).not.toContain('](US-8000000-B1.md)');
    const { warnings } = importBundle([built.file]);
    expect(warnings.filter((w) => /unresolved cross-link/.test(w.message))).toHaveLength(0);
  });

  it('derives the CPC subclass from cpc_group when cpc_class is absent', () => {
    const built = buildPatentFromRow({ ...ROW, cpc_class: undefined, cpc_group: 'H04W72/04' }, '2026-06-28')!;
    expect(built.cpcClass).toBe('H04W');
  });

  it('skips rows without a usable publication number', () => {
    expect(buildPatentFromRow({ title: 'x' }, '2026-06-28')).toBeNull();
    expect(buildPatentFromRow({ publication_number: 'not a pubnum' }, '2026-06-28')).toBeNull();
  });
});

describe('ingestPatentExport (streaming NDJSON → OKF bundles)', () => {
  const rows: PatentRow[] = [
    ROW,
    { ...ROW, publication_number: 'US-9000001-B2', cpc_class: 'H04L' },
    { ...ROW, publication_number: 'EP-2000002-B1', country_code: 'EP', cpc_class: 'H04W', cpc_group: 'H04W4/00' },
  ];

  function writeNdjson(dir: string): string {
    const p = join(dir, 'export.ndjson');
    // include a blank line and a malformed line to exercise skip handling
    writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n\n{not json}\n');
    return p;
  }

  it('writes one combined bundle by default; loads + validates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ingest-'));
    try {
      const input = writeNdjson(dir);
      const out = join(dir, 'out');
      const summary = await ingestPatentExport(input, out, { retrievalDate: '2026-06-28' });
      expect(summary.conceptCount).toBe(3);
      expect(summary.skipped).toBe(1); // the malformed line
      expect(summary.shards).toHaveLength(1);
      const files = loadBundleDir(out);
      const { concepts } = importBundle(files);
      expect(concepts).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shards by CPC subclass into self-contained bundles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ingest-'));
    try {
      const input = writeNdjson(dir);
      const out = join(dir, 'out');
      const summary = await ingestPatentExport(input, out, {
        retrievalDate: '2026-06-28',
        shardByCpc: true,
      });
      expect(summary.shards.map((s) => s.cpcClass).sort()).toEqual(['H04L', 'H04W']);
      expect(readdirSync(out).sort()).toEqual(['H04L', 'H04W']);
      // each shard is its own conformant OKF bundle
      for (const shard of summary.shards) {
        const files = loadBundleDir(shard.outDir);
        expect(validateBundle(files).conformant).toBe(true);
      }
      const h04l = summary.shards.find((s) => s.cpcClass === 'H04L')!;
      expect(h04l.count).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
