#!/usr/bin/env node

const { compileSurfacePolicy } = require('../evaluator/surface_compiler.js');
const { compareExpected, Evaluator } = require('../evaluator/reference_evaluator.js');

const cases = [
  {
    name: 'inline_owner_assertion_surface',
    source: `policy owner_assertion v0.1.0

rule owner_asserted(Claim):
  claim(Claim)
  exists Agent where
    owner_of(Claim, Agent)
    signed_by(Claim, Agent)

decision propose_accept(Claim):
  owner_asserted(Claim)
`,
    facts: [
      ['claim', 'p1'],
      ['owner_of', 'p1', '0xalice'],
      ['signed_by', 'p1', '0xalice'],
    ],
    expected: {
      derived: {
        owner_asserted: [['p1']],
      },
      decisions: {
        propose_accept: [['p1']],
      },
    },
  },
  {
    name: 'inline_context_corroboration_surface',
    source: `policy context_corroboration v0.1.0

rule corroborated(Claim):
  claim(Claim)
  count_distinct Evidence where
    supports(Evidence, Claim)
    evidence_view(Evidence, accepted)
    independent(Evidence)
  >= 2
  exists Evidence where
    supports(Evidence, Claim)
    evidence_view(Evidence, accepted)
    authority_class(Evidence, vendor)
  not exists Contradiction where
    contradicts(Contradiction, Claim)
    accepted_status(Contradiction, accepted)

rule promotable(Claim):
  corroborated(Claim)
  exists Epoch where
    claim_epoch(Claim, Epoch)
    quorum_epoch(incident_review, Epoch)
  quorum_reached(incident_review, 3, 4)

decision propose_accept(Claim):
  promotable(Claim)
`,
    facts: [
      ['claim', 'c1'],
      ['supports', 'e1', 'c1'],
      ['supports', 'e2', 'c1'],
      ['evidence_view', 'e1', 'accepted'],
      ['evidence_view', 'e2', 'accepted'],
      ['independent', 'e1'],
      ['independent', 'e2'],
      ['authority_class', 'e1', 'vendor'],
      ['authority_class', 'e2', 'operator'],
      ['claim_epoch', 'c1', 7],
      ['quorum_epoch', 'incident_review', 7],
      ['quorum_reached', 'incident_review', 3, 4],
    ],
    expected: {
      derived: {
        corroborated: [['c1']],
        promotable: [['c1']],
      },
      decisions: {
        propose_accept: [['c1']],
      },
    },
  },
  {
    name: 'inline_agents_reject_flat_earth_claim',
    source: `policy scientific_consensus v0.1.0

rule flat_claim_rejected(Claim):
  claim(Claim)
  claim_topic(Claim, earth_shape)
  claim_value(Claim, flat)
  count_distinct Agent where
    asserts(Agent, Claim)
  >= 1
  count_distinct Agent where
    submits_evidence(Agent, Evidence, Claim)
    evidence_view(Evidence, accepted)
    evidence_conclusion(Evidence, round)
  >= 3

decision propose_reject(Claim):
  flat_claim_rejected(Claim)
`,
    facts: [
      ['claim', 'claim_flat_earth'],
      ['claim_topic', 'claim_flat_earth', 'earth_shape'],
      ['claim_value', 'claim_flat_earth', 'flat'],
      ['asserts', 'agent_alex', 'claim_flat_earth'],
      ['submits_evidence', 'agent_blair', 'evidence_satellite', 'claim_flat_earth'],
      ['submits_evidence', 'agent_casey', 'evidence_horizon', 'claim_flat_earth'],
      ['submits_evidence', 'agent_drew', 'evidence_circumnavigation', 'claim_flat_earth'],
      ['evidence_view', 'evidence_satellite', 'accepted'],
      ['evidence_view', 'evidence_horizon', 'accepted'],
      ['evidence_view', 'evidence_circumnavigation', 'accepted'],
      ['evidence_conclusion', 'evidence_satellite', 'round'],
      ['evidence_conclusion', 'evidence_horizon', 'round'],
      ['evidence_conclusion', 'evidence_circumnavigation', 'round'],
    ],
    expected: {
      derived: {
        flat_claim_rejected: [['claim_flat_earth']],
      },
      decisions: {
        propose_reject: [['claim_flat_earth']],
      },
    },
    printRdf: true,
  },
  {
    name: 'inline_flat_earth_policy_fails_against_round_evidence',
    source: `policy false_flat_earth_consensus v0.1.0

rule claim_has_supporter(Claim):
  claim(Claim)
  exists Agent where
    asserts(Agent, Claim)

rule flat_claim_supported(Claim):
  claim_has_supporter(Claim)
  claim_topic(Claim, earth_shape)
  claim_value(Claim, flat)
  count_distinct Agent where
    submits_evidence(Agent, Evidence, Claim)
    evidence_view(Evidence, accepted)
    evidence_conclusion(Evidence, flat)
  >= 3

decision propose_accept(Claim):
  flat_claim_supported(Claim)
`,
    facts: [
      ['claim', 'claim_flat_earth'],
      ['claim_topic', 'claim_flat_earth', 'earth_shape'],
      ['claim_value', 'claim_flat_earth', 'flat'],
      ['asserts', 'agent_alex', 'claim_flat_earth'],
      ['submits_evidence', 'agent_blair', 'evidence_satellite', 'claim_flat_earth'],
      ['submits_evidence', 'agent_casey', 'evidence_horizon', 'claim_flat_earth'],
      ['submits_evidence', 'agent_drew', 'evidence_circumnavigation', 'claim_flat_earth'],
      ['evidence_view', 'evidence_satellite', 'accepted'],
      ['evidence_view', 'evidence_horizon', 'accepted'],
      ['evidence_view', 'evidence_circumnavigation', 'accepted'],
      ['evidence_conclusion', 'evidence_satellite', 'round'],
      ['evidence_conclusion', 'evidence_horizon', 'round'],
      ['evidence_conclusion', 'evidence_circumnavigation', 'round'],
    ],
    expected: {
      derived: {
        claim_has_supporter: [['claim_flat_earth']],
        flat_claim_supported: [],
      },
      decisions: {
        propose_accept: [],
      },
    },
    printRdf: true,
  },
];

function main() {
  let passed = 0;

  for (const testCase of cases) {
    const compiled = compileSurfacePolicy(testCase.source);
    const result = new Evaluator(compiled, testCase.facts).run();
    const comparison = compareExpected(result, testCase.expected);

    if (!comparison.ok) {
      console.error(`FAIL ${testCase.name}`);
      console.error(JSON.stringify(comparison.detail, null, 2));
      process.exitCode = 1;
      return;
    }

    if (testCase.printRdf) {
      console.log(renderEvaluationAsTrig(testCase.name, testCase.facts, result));
    }

    passed += 1;
    console.log(`PASS ${testCase.name}`);
  }

  console.log(`\n${passed}/${cases.length} inline surface cases passed`);
}

main();

function renderEvaluationAsTrig(name, facts, result) {
  const graph = 'did:dkg:paranet:test-ccl';
  const evaluation = `did:dkg:ccl-eval:${name}`;
  const lines = [
    '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
    '@prefix dkg: <https://dkg.network/ontology#> .',
    '@prefix cclf: <https://example.org/ccl-fact#> .',
    '',
    `GRAPH <${graph}> {`,
  ];

  appendFacts(lines, name, facts);

  lines.push(
    `  <${evaluation}> rdf:type dkg:CCLEvaluation .`,
  );

  appendEntries(lines, evaluation, 'derived', result.derived, graph);
  appendEntries(lines, evaluation, 'decision', result.decisions, graph);

  lines.push('}');

  return `RDF for ${name}:\n${lines.join('\n')}`;
}

function appendFacts(lines, name, facts) {
  facts.forEach((fact, factIndex) => {
    const [predicate, ...args] = fact;
    const factNode = `did:dkg:ccl-fact:${name}:${factIndex}`;
    lines.push(
      `  <${factNode}> rdf:type cclf:InputFact .`,
      `  <${factNode}> cclf:predicate "${predicate}" .`,
    );

    args.forEach((arg, argIndex) => {
      lines.push(`  <${factNode}> cclf:arg${argIndex} ${jsonLiteral(arg)} .`);
    });
  });
}

function appendEntries(lines, evaluation, kind, entries, graph) {
  for (const [predicate, tuples] of Object.entries(entries)) {
    tuples.forEach((tuple, tupleIndex) => {
      const entry = `${evaluation}/result/${kind}/${predicate}/${tupleIndex}`;
      lines.push(
        `  <${entry}> rdf:type dkg:CCLResultEntry .`,
        `  <${evaluation}> dkg:hasResult <${entry}> .`,
        `  <${entry}> dkg:resultKind "${kind}" .`,
        `  <${entry}> dkg:resultName "${predicate}" .`,
      );

      tuple.forEach((value, argIndex) => {
        const arg = `${entry}/arg/${argIndex}`;
        lines.push(
          `  <${arg}> rdf:type dkg:CCLResultArg .`,
          `  <${entry}> dkg:hasResultArg <${arg}> .`,
          `  <${arg}> dkg:resultArgIndex "${argIndex}" .`,
          `  <${arg}> dkg:resultArgValue ${jsonLiteral(value)} .`,
        );
      });
    });
  }
}

function jsonLiteral(value) {
  return `"${JSON.stringify(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
