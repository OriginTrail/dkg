// Thin wrapper around eye-js (the `eyereasoner` package — EYE compiled to WASM).
// Loads the FIBO slice + ownership facts + N3 rules, runs forward inference
// in-process, and returns the derived control relations as structured triples.
//
// explain() reconstructs WHY each derived triple holds — the supporting facts
// and the rule — straight from the source data. That justification is what the
// provenance phase writes onto the graph (prov:wasDerivedFrom + the rule), and
// it's deterministic: same facts, same proof, every run.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { n3reasoner } from 'eyereasoner';
import N3 from 'n3';

import { DEMO_NS, ENTITY_NS, OWNERSHIP, labelOf, ownershipTurtle, ownershipKaName } from './data.mjs';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SELF_DIR, '..');

const CONTROLS = `${DEMO_NS}controls`;
const INDIRECT = `${DEMO_NS}indirectlyControls`;

export function shorten(iri) {
  if (typeof iri !== 'string') return String(iri);
  if (iri.startsWith(DEMO_NS)) return `demo:${iri.slice(DEMO_NS.length)}`;
  if (iri.startsWith(ENTITY_NS)) return `ex:${iri.slice(ENTITY_NS.length)}`;
  return iri;
}

const localName = (iri) => (typeof iri === 'string' ? iri.slice(iri.lastIndexOf('/') + 1) : iri);

export async function loadSources() {
  const [fibo, rules] = await Promise.all([
    readFile(join(ROOT, 'fixtures/fibo-slice.ttl'), 'utf8'),
    readFile(join(ROOT, 'rules/control.n3'), 'utf8'),
  ]);
  return { fibo, ownership: ownershipTurtle(), rules };
}

// Run eye-js. `data` = FIBO slice + ownership facts; `rules` = the N3 rules.
// With no query, the reasoner returns its derivations; we keep the two control
// predicates and drop anything echoed from the input graph.
export async function reason({ fibo, ownership, rules }) {
  const data = `${fibo}\n${ownership}`;
  const n3Text = await n3reasoner([data, rules], null);
  const triples = parseTurtle(n3Text)
    .filter((t) => t.p === CONTROLS || t.p === INDIRECT)
    .sort((a, b) => (a.p === b.p ? 0 : a.p === CONTROLS ? -1 : 1));
  return { n3Text, triples };
}

function parseTurtle(ttl) {
  // No-callback form parses synchronously and returns the quad array — the
  // callback form populates on later ticks, which would race reason()'s return.
  return new N3.Parser()
    .parse(ttl)
    .map((q) => ({ s: q.subject.value, p: q.predicate.value, o: q.object.value }));
}

export const isIndirect = (t) => t.p === INDIRECT;

// Why does this derived triple hold? Returns the rule, a one-line gloss, the
// supporting facts in plain English, and the Working-Memory KAs they came from
// (used as prov:wasDerivedFrom targets).
export function explain(triple) {
  const a = localName(triple.s);
  const z = localName(triple.o);

  if (triple.p === CONTROLS) {
    const o = OWNERSHIP.find((x) => x.owner === a && x.company === z && x.pct > 50);
    return {
      rule: 'R1 · majority-voting-control',
      gloss: 'owns > 50% of voting shares ⇒ controls',
      because: o ? [`${labelOf(a)} holds ${o.pct}% of ${labelOf(z)} — a majority stake`] : [],
      derivedFrom: o ? [ownershipKaName(o)] : [],
    };
  }

  if (triple.p === INDIRECT) {
    let chain = null;
    for (const o1 of OWNERSHIP.filter((x) => x.owner === a && x.pct > 50)) {
      const o2 = OWNERSHIP.find((x) => x.owner === o1.company && x.company === z && x.pct > 50);
      if (o2) {
        chain = [o1, o2];
        break;
      }
    }
    const direct = OWNERSHIP.find((x) => x.owner === a && x.company === z);
    const because = [];
    if (chain) {
      because.push(`${labelOf(a)} controls ${labelOf(chain[0].company)} (${chain[0].pct}%)`);
      because.push(`${labelOf(chain[1].owner)} controls ${labelOf(z)} (${chain[1].pct}%)`);
      if (direct) {
        because.push(
          `direct stake is only ${direct.pct}% — control here is BENEFICIAL, through the chain, not on the cap table`,
        );
      } else {
        because.push(`no direct stake at all — this control is entirely indirect`);
      }
    }
    return {
      rule: 'R2 · transitive-control (beneficial ownership)',
      gloss: 'controls(a,b) ∧ controls(b,c) ⇒ indirectlyControls(a,c)',
      because,
      derivedFrom: chain ? [ownershipKaName(chain[0]), ownershipKaName(chain[1])] : [],
    };
  }

  return { rule: 'unknown', gloss: '', because: [], derivedFrom: [] };
}
