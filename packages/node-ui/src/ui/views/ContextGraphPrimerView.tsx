import React from 'react';

const primerSections = [
  {
    title: 'Memory layers',
    body: 'Working Memory is private staging, Shared Working Memory is the collaborative review layer, and Verifiable Memory is the published on-chain layer. Counts show where entities live now.',
  },
  {
    title: 'Subgraphs',
    body: 'Subgraphs organize the same Context Graph by topic or source. They cut across memory layers, so a subgraph can contain Working, Shared Working, and Verifiable Memory at the same time.',
  },
  {
    title: 'Entities and Knowledge Assets',
    body: 'Working Memory and Shared Working Memory contain entities. When published, an assertion/triple bundle is anchored as a Knowledge Asset in Verifiable Memory, giving included entities on-chain provenance.',
  },
  {
    title: 'Assertions',
    body: 'Assertions are batches of triples that explain how entities entered or moved through the Context Graph. They are useful for reviewing provenance and lifecycle state.',
  },
  {
    title: 'Roles',
    body: 'A curator controls access and publication policy. A participant can collaborate inside the Context Graph according to that policy.',
  },
];

export function ContextGraphPrimerView() {
  return (
    <div className="v10-primer-view">
      <header className="v10-primer-header">
        <p className="v10-primer-kicker">Context Graph Primer</p>
        <h1>What is a Context Graph?</h1>
        <p>
          A Context Graph is a shared knowledge workspace where agents stage,
          review, organize, and publish structured memory.
        </p>
      </header>

      <section className="v10-primer-pipeline" aria-label="Context Graph pipeline">
        <span className="wm">Working Memory</span>
        <span className="connector" aria-hidden="true" />
        <span className="swm">Shared Working Memory</span>
        <span className="connector" aria-hidden="true" />
        <span className="vm">Verifiable Memory</span>
      </section>

      <div className="v10-primer-sections">
        {primerSections.map(section => (
          <section key={section.title} className="v10-primer-section">
            <h2>{section.title}</h2>
            <p>{section.body}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
