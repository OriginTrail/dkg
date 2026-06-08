// Single source of truth for the demo's domain facts.
//
// Four legal entities and the voting-share stakes between them. The numbers
// are picked to tell one specific story:
//
//   Acme ──60%──▶ Bridge ──55%──▶ SmallCo        (two majority links)
//     │
//     ├──10%──▶ SmallCo                           (a tiny DIRECT stake)
//     └──30%──▶ Meridian                          (a minority stake)
//
// A naive "who owns what" view says Acme has no control of SmallCo (only 10%).
// The reasoner derives the opposite: Acme *indirectly* controls SmallCo through
// Bridge — concealed control that no single asserted fact states. Meridian stays
// uncontrolled (30% < 50%), proving the rule isn't just "any stake = control".
//
// Turtle/quads for eye-js and for the --live path are GENERATED from these
// arrays so the reasoning input, the on-graph KAs, and the provenance
// justification can never drift apart.

export const ENTITY_NS = 'https://example.org/entity/';
export const DEMO_NS = 'https://example.org/fibo-demo#';

export const ENTITIES = [
  { id: 'AcmeCapital', label: 'Acme Capital Partners' },
  { id: 'BridgeHldgs', label: 'Bridge Holdings plc' },
  { id: 'SmallCo', label: 'SmallCo Manufacturing Ltd' },
  { id: 'Meridian', label: 'Meridian Trading SA' },
];

// Each row is one Working-Memory fact: "<owner> holds <pct>% of the voting
// shares of <company>". A real FIBO model reifies this as an OwnershipInterest
// with hasPercentageValue; we flatten it to a list so the N3 rules stay legible.
export const OWNERSHIP = [
  { owner: 'AcmeCapital', company: 'BridgeHldgs', pct: 60 },
  { owner: 'BridgeHldgs', company: 'SmallCo', pct: 55 },
  { owner: 'AcmeCapital', company: 'SmallCo', pct: 10 },
  { owner: 'AcmeCapital', company: 'Meridian', pct: 30 },
];

export const labelOf = (id) => ENTITIES.find((e) => e.id === id)?.label ?? id;

// Stable per-fact KA name, used as the Working-Memory assertion name in --live
// mode and as the prov:wasDerivedFrom target in the provenance chain.
export const ownershipKaName = (o) =>
  `ownership-${o.owner}-${o.company}`.toLowerCase();

// Turtle for the ownership facts (consumed by eye-js and printable for the
// human walkthrough). Voting percentage carried as an rdf:List `( company pct )`.
export function ownershipTurtle() {
  const lines = [
    '@prefix demo: <https://example.org/fibo-demo#> .',
    '@prefix ex: <https://example.org/entity/> .',
    '',
  ];
  for (const o of OWNERSHIP) {
    lines.push(`ex:${o.owner} demo:ownsVotingShares ( ex:${o.company} ${o.pct} ) .`);
  }
  return lines.join('\n') + '\n';
}

// Flat {subject,predicate,object} quads for ONE ownership fact, in the shape the
// /api/knowledge-assets wm/write + create endpoints accept. The list node is
// expanded to explicit rdf:first/rdf:rest so no blank-node list sugar is assumed.
export function ownershipQuads(o) {
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const ownerIri = `${ENTITY_NS}${o.owner}`;
  const companyIri = `${ENTITY_NS}${o.company}`;
  const list = `urn:dkg:list:${o.owner}-${o.company}`;
  return [
    { subject: ownerIri, predicate: `${DEMO_NS}ownsVotingShares`, object: list },
    { subject: list, predicate: `${RDF}first`, object: companyIri },
    { subject: list, predicate: `${RDF}rest`, object: `${list}-tail` },
    {
      subject: `${list}-tail`,
      predicate: `${RDF}first`,
      object: `"${o.pct}"^^http://www.w3.org/2001/XMLSchema#integer`,
    },
    { subject: `${list}-tail`, predicate: `${RDF}rest`, object: `${RDF}nil` },
  ];
}
