/**
 * Adapter literal round-trip on delete (OT-RFC-56 boot-sweep blocker).
 *
 * `termToString` (query results) N-Quads-ESCAPES literal values, while
 * `store.load` (insert) UNescapes them — so a literal containing `"`, `\`, LF,
 * or CR is stored unescaped but handed back escaped. `parseTerm` (used by
 * `deleteByPattern` / `delete`) must reverse that, or a caller that deletes a
 * term it just read back matches ZERO quads. This is the silent no-op that made
 * the boot sweep write its "done" marker while removing nothing.
 */
import { describe, it, expect } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import type { Quad } from '../src/triple-store.js';

const G = 'http://ex.org/g';
const S = 'http://ex.org/s';
const P = 'http://ex.org/p';

// Values that exercise every escape produced by escapeNQuadsLiteral.
const trickyValues = [
  'line1\nline2',            // LF
  'has "double quotes"',     // "
  'back\\slash',             // \
  'carriage\rreturn',        // CR
  'all: "q" \\ \n \r mix',   // combined
  'literal backslash-n: \\n', // an escaped backslash then n → must NOT become LF
];

describe('OxigraphStore literal round-trip: read → delete matches', () => {
  it.each(trickyValues)('deleteByPattern removes a literal containing special chars: %j', async (value) => {
    const store = new OxigraphStore();
    // Insert via the escaped N-Quads form the rest of the stack uses.
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    await store.insert([{ subject: S, predicate: P, object: `"${escaped}"`, graph: G } as Quad]);

    // Read it back exactly as the sweep does (CONSTRUCT → adapter object term).
    const r = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${G}> { ?s ?p ?o } }`);
    const quads = r.type === 'quads' ? r.quads : [];
    expect(quads).toHaveLength(1);
    const objTerm = quads[0]!.object;

    // Delete by the read-back term — must match and remove it.
    const deleted = await store.deleteByPattern({ graph: G, subject: S, predicate: P, object: objTerm });
    expect(deleted).toBe(1);

    const after = await store.query(`SELECT ?o WHERE { GRAPH <${G}> { ?s ?p ?o } }`);
    expect(after.type === 'bindings' && after.bindings).toHaveLength(0);
  });

  it('does not over-delete: a same-S/P sibling literal survives', async () => {
    const store = new OxigraphStore();
    await store.insert([
      { subject: S, predicate: P, object: '"has \\"quote\\""', graph: G } as Quad,
      { subject: S, predicate: P, object: '"plain sibling"', graph: G } as Quad,
    ]);
    const r = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${G}> { ?s ?p ?o } }`);
    const target = (r.type === 'quads' ? r.quads : []).find((q) => q.object.includes('quote'))!;
    await store.deleteByPattern({ graph: G, subject: S, predicate: P, object: target.object });
    const after = await store.query(`SELECT ?o WHERE { GRAPH <${G}> { ?s ?p ?o } }`);
    const objs = after.type === 'bindings' ? after.bindings.map((b) => b.o) : [];
    expect(objs).toEqual(['"plain sibling"']); // the sibling remains (SELECT returns the quoted term)
  });
});
