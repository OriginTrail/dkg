import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importBundle, validateBundle } from '@origintrail-official/dkg-okf';
import {
  generatePatentBundle,
  writePatentBundle,
  pubNumber,
  type BundleFile,
} from '../src/index.js';

const OPTS = { cpcClass: 'H04L', count: 12, seed: 7 };

function byPath(files: BundleFile[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe('synthetic patent generator', () => {
  it('is deterministic: same seed ⇒ byte-identical bundle', () => {
    const a = generatePatentBundle(OPTS);
    const b = generatePatentBundle(OPTS);
    expect(b).toEqual(a);
  });

  it('changing the seed changes the corpus', () => {
    const a = generatePatentBundle(OPTS);
    const b = generatePatentBundle({ ...OPTS, seed: 8 });
    expect(b).not.toEqual(a);
  });

  it('emits count patents + reserved index/log files', () => {
    const files = generatePatentBundle(OPTS);
    const patents = files.filter(
      (f) => f.path.startsWith('patents/') && f.path !== 'patents/index.md',
    );
    expect(patents).toHaveLength(OPTS.count);
    const map = byPath(files);
    expect(map.has('index.md')).toBe(true);
    expect(map.has('log.md')).toBe(true);
    expect(map.has('patents/index.md')).toBe(true);
  });

  it('stamps every patent as SIMULATED CC BY 4.0 with substance + provenance', () => {
    const files = generatePatentBundle(OPTS);
    const patents = files.filter(
      (f) => f.path.startsWith('patents/') && f.path !== 'patents/index.md',
    );
    for (const f of patents) {
      expect(f.content).toContain('type: Patent');
      expect(f.content).toContain('license: CC BY 4.0');
      expect(f.content).toContain('[SIMULATED]');
      expect(f.content).toContain('retrieval_date:');
      // substance fields that must stay in the private layer
      expect(f.content).toContain('claim_chart_ref:');
      expect(f.content).toContain('essentiality_note:');
    }
  });

  it('is OKF-conformant and reconstructs the citation + family link graph', () => {
    const files = generatePatentBundle(OPTS);
    const conformance = validateBundle(files);
    expect(conformance.conformant).toBe(true);

    const imported = importBundle(files);
    // 12 patent concepts (index.md / log.md / patents/index.md are reserved/non-concept).
    expect(imported.concepts).toHaveLength(OPTS.count);

    // Prior-art + family links become resolved concept→concept edges.
    let resolved = 0;
    let broken = 0;
    let citations = 0;
    for (const c of imported.concepts) {
      resolved += c.resolvedLinks.length;
      broken += c.brokenLinks.length;
      citations += c.citations.length;
    }
    expect(broken).toBe(0); // every internal link resolves
    expect(resolved).toBeGreaterThan(0); // families guarantee edges
    expect(citations).toBe(OPTS.count); // one Google-Patents external citation each
  });

  it('writePatentBundle streams to disk and matches the in-memory bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-oracle-'));
    try {
      const summary = writePatentBundle(OPTS, dir);
      expect(summary.conceptCount).toBe(OPTS.count);
      expect(summary.cpcClass).toBe('H04L');

      const onDisk = readdirSync(join(dir, 'patents')).filter((f) => f.endsWith('.md'));
      // count patents + patents/index.md
      expect(onDisk).toHaveLength(OPTS.count + 1);

      // Byte-for-byte equal to the in-memory generator for every file.
      const mem = byPath(generatePatentBundle(OPTS));
      for (const [path, content] of mem) {
        expect(readFileSync(join(dir, path), 'utf-8')).toBe(content);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pubNumber recomputes the exact publication number for an index', () => {
    // Public API: takes PatentGenOptions and resolves internally (no private shape).
    const files = generatePatentBundle(OPTS);
    const patents = files.filter(
      (f) => f.path.startsWith('patents/') && f.path !== 'patents/index.md',
    );

    // For every patent, pubNumber(OPTS, i) must equal the generated file's segment.
    patents.forEach((f, i) => {
      const seg = f.path.replace('patents/', '').replace('.md', '');
      expect(pubNumber(OPTS, i)).toBe(seg);
    });

    // It is a valid single OKF concept-ID segment (no slashes) and deterministic.
    const first = pubNumber(OPTS, 0);
    expect(first).not.toContain('/');
    expect(first).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/);
    expect(pubNumber(OPTS, 0)).toBe(first); // stable across calls
  });
});
