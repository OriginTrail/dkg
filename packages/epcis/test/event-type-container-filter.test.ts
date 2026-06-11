/**
 * Liveness/regression test for GH #709 —
 * "EPCIS no-filter events query returns EPCISDocument container rows".
 * https://github.com/OriginTrail/dkg/issues/709
 *
 * `buildEpcisQuery` matches every RDF type under the EPCIS namespace via
 * `FILTER(STRSTARTS(STR(?eventType), "https://gs1.github.io/EPCIS/"))`. That
 * prefix also matches `https://gs1.github.io/EPCIS/EPCISDocument` — the
 * document container — so an unfiltered `/api/epcis/events` query returns the
 * container as if it were an event. (Confirmed live on rc.17: a no-filter query
 * returned `[ObjectEvent, EPCISDocument]`.) The fix should exclude container /
 * document classes from the event result set.
 *
 * Encoded as `it.fails`: asserting the generated query guards against the
 * EPCISDocument container fails today (bug live). When the builder excludes
 * containers, flip to a plain `it(...)` and close #709.
 */
import { describe, expect, it } from 'vitest';
import { buildEpcisQuery } from '../src/query-builder.js';

const CG = 'epcis-709-cg';
const EPCIS_DOCUMENT = 'https://gs1.github.io/EPCIS/EPCISDocument';

describe('GH #709 — EPCIS event-type filter excludes the document container', () => {
  it('CONTROL: a no-filter events query is generated and scopes ?eventType to the EPCIS namespace', () => {
    const sparql = buildEpcisQuery({}, CG);
    expect(sparql).toContain('?event a ?eventType');
    expect(sparql).toContain('https://gs1.github.io/EPCIS/');
  });

  it.fails(
    'a no-filter events query excludes the EPCISDocument container class',
    () => {
      const sparql = buildEpcisQuery({}, CG);
      // The generated SPARQL must guard against the document container —
      // e.g. `FILTER(?eventType != <…/EPCISDocument>)` or a NOT-IN / NOT-EXISTS.
      expect(sparql).toContain(EPCIS_DOCUMENT);
    },
  );
});
