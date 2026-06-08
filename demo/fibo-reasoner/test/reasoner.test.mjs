// Pins the inference so the demo can't silently rot: the hidden-control beat
// must keep firing and minority stakes must keep producing nothing.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadSources, reason, explain } from '../lib/reasoner.mjs';
import { DEMO_NS, ENTITY_NS } from '../lib/data.mjs';

const has = (triples, s, p, o) =>
  triples.some((t) => t.s === `${ENTITY_NS}${s}` && t.p === `${DEMO_NS}${p}` && t.o === `${ENTITY_NS}${o}`);

test('derives direct control from a majority stake', async () => {
  const { triples } = await reason(await loadSources());
  assert.ok(has(triples, 'AcmeCapital', 'controls', 'BridgeHldgs'), 'Acme controls Bridge (60%)');
  assert.ok(has(triples, 'BridgeHldgs', 'controls', 'SmallCo'), 'Bridge controls SmallCo (55%)');
});

test('surfaces hidden transitive control', async () => {
  const { triples } = await reason(await loadSources());
  assert.ok(
    has(triples, 'AcmeCapital', 'indirectlyControls', 'SmallCo'),
    'Acme indirectly controls SmallCo through Bridge',
  );
});

test('minority stakes never confer control', async () => {
  const { triples } = await reason(await loadSources());
  assert.ok(!has(triples, 'AcmeCapital', 'controls', 'SmallCo'), '10% direct is not control');
  assert.ok(!has(triples, 'AcmeCapital', 'controls', 'Meridian'), '30% is not control');
  assert.ok(!triples.some((t) => t.o === `${ENTITY_NS}Meridian`), 'Meridian stays uncontrolled');
});

test('explanation cites the right rule and evidence', async () => {
  const { triples } = await reason(await loadSources());
  const indirect = triples.find((t) => t.p === `${DEMO_NS}indirectlyControls`);
  const why = explain(indirect);
  assert.match(why.rule, /transitive/);
  assert.equal(why.derivedFrom.length, 2, 'indirect control derives from two WM facts');
});
