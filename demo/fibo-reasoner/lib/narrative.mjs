// Story content for the paced human walkthrough. One short beat per phase.
// --json mode skips all of this — that channel is for agents.

export const OPENING = {
  title: 'Reasoning across the memory layers — a FIBO control example',
  body: [
    'The rc.17 "Chorus" model gives every Knowledge Asset a three-layer memory: Working Memory (what an agent observed, locally), Shared Working Memory (promoted for the swarm to see and challenge), and Verifiable Memory (anchored, provenance-backed, on-chain). The layers are a pipeline for turning raw observation into trusted knowledge.',
    'This demo puts a reasoner in that pipeline. Agents assert plain ownership facts into Working Memory. eye-js — the EYE reasoner running in-process — applies a FIBO-style control ontology and DERIVES facts nobody asserted. Those derived facts, each carrying provenance back to the evidence and the rule, are promoted to Shared Working Memory and finally published to Verifiable Memory.',
    'The example is corporate control. Four legal entities, a handful of voting-share stakes. On the surface, Acme Capital barely touches SmallCo — a 10% sliver. The reasoner shows otherwise.',
  ],
};

export const OWNERSHIP_DIAGRAM = `
  What the agents asserted (Working Memory) — voting-share stakes:

      Acme Capital ──60%──▶ Bridge Holdings ──55%──▶ SmallCo
           │
           ├──10%──▶ SmallCo            (a tiny direct stake)
           └──30%──▶ Meridian Trading   (a minority stake)

  No asserted fact says Acme controls SmallCo. Read literally, it owns 10%.
`;

export const PHASES = {
  setup: {
    id: 'Phase 0',
    title: 'Load the FIBO slice & the facts',
    body: 'We load a tiny curated FIBO fragment (every party is a fibo:LegalEntity) and the asserted ownership stakes. In --live mode this also creates the context graph that will hold the KAs.',
  },
  wm: {
    id: 'Phase 1',
    title: 'Working Memory — assert the raw facts',
    body: 'Each ownership stake is a Working-Memory fact: agent-local, unverified, exactly as observed. Nothing is inferred yet. This is the bottom of the Chorus pipeline.',
  },
  reason: {
    id: 'Phase 2',
    title: 'Reason — run eye-js over the facts',
    body: 'eye-js applies the FIBO control rules to Working Memory. Two rules: majority voting interest ⇒ control, and control is transitive. Watch what comes out that nobody put in.',
  },
  provenance: {
    id: 'Phase 3',
    title: 'Provenance & Shared Working Memory',
    body: 'A derived fact is only as good as its justification. Each inference is written with prov:wasDerivedFrom pointing at the exact Working-Memory facts and the rule that fired — then promoted to Shared Working Memory so the swarm can see and challenge it. Unlike an LLM enrichment, the derivation is a formal proof.',
  },
  vm: {
    id: 'Phase 4',
    title: 'Verifiable Memory — publish the inference',
    body: 'The inference is anchored to Verifiable Memory. Querying it back returns not just "Acme indirectlyControls SmallCo" but the whole provenance chain — the two facts and the rule behind it. A verified, explainable claim on the DKG.',
  },
};

export const CLOSING = {
  title: 'What just happened',
  body: [
    'A fact that no agent asserted — Acme Capital indirectly controls SmallCo — was derived by rule, justified by provenance, and promoted Working → Shared → Verified. Meanwhile the 30% Meridian stake correctly produced nothing: the reasoner encodes the law, not a guess.',
    'The reasoner is the missing verb in the memory model. Working Memory is what was seen; Verifiable Memory is what the swarm reasoned and confirmed; eye-js is the inference in between. Swap the FIBO control rules for supply-chain, compliance, or eligibility rules and the same pipeline applies.',
  ],
};
