import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MemoryLayer, readGraphIri, readGraphStateGraphIri, readScope } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '../src/index.js';
import {
  CURRENT_READ_GRAPH_VERSIONS,
  MAX_READ_GRAPH_GENERATION,
  READ_GRAPH_STATES,
  READ_GRAPH_STATE_PREDICATES,
  ReadGraphTransitionError,
  isReadGraphRowAccepted,
  newReadGraphGeneration,
  nextReadGraphState,
  parseReadGraphStateRows,
  readGraphStateCompareAndSet,
  readGraphStateFencePattern,
  readGraphStateMarkAllDirty,
  readGraphStateReset,
  readGraphStateRowsQuery,
  servingReadGraphGeneration,
  type ReadGraphState,
  type ReadGraphStateRow,
  type ReadGraphTransition,
} from '../src/read-graph/state.js';
import { propertyOptions } from '../../../scripts/testing/property-options.js';

const R = readGraphIri({ scope: readScope('0xabc/proj'), layer: MemoryLayer.VerifiableMemory });
const R2 = readGraphIri({ scope: readScope('0xabc/proj', 'code'), layer: MemoryLayer.SharedWorkingMemory });
const STATE_GRAPH = readGraphStateGraphIri('0xabc/proj');
const V = CURRENT_READ_GRAPH_VERSIONS;
const MEMBER = 'did:dkg:context-graph:0xabc/proj/_verifiable_memory/0xaa/1';

function row(state: ReadGraphState, generation = 7, readGraph = R): ReadGraphStateRow {
  return { readGraph, state, generation, ruleVersion: V.ruleVersion, builderVersion: V.builderVersion };
}

const TRANSITIONS: ReadGraphTransition[] = [
  { kind: 'create', readGraph: R, generation: 5, versions: V },
  { kind: 'mark-dirty' },
  { kind: 'start-repair', versions: V },
  { kind: 'start-rebuild', versions: V },
  { kind: 'publish-ready' },
  { kind: 'remove' },
];

describe('read-graph state machine', () => {
  it('allows exactly the transitions of the state diagram', () => {
    const allowed: Record<string, string[]> = {
      absent: ['create'],
      building: ['mark-dirty', 'publish-ready', 'remove'],
      ready: ['mark-dirty', 'remove'],
      dirty: ['mark-dirty', 'start-repair', 'start-rebuild', 'remove'],
      repairing: ['mark-dirty', 'publish-ready', 'remove'],
      rebuilding: ['mark-dirty', 'publish-ready', 'remove'],
    };
    for (const from of ['absent', ...READ_GRAPH_STATES] as const) {
      for (const transition of TRANSITIONS) {
        const current = from === 'absent' ? undefined : row(from);
        const attempt = () => nextReadGraphState(current, transition);
        if (allowed[from]!.includes(transition.kind)) expect(attempt, `${from} ${transition.kind}`).not.toThrow();
        else expect(attempt, `${from} ${transition.kind}`).toThrow(ReadGraphTransitionError);
      }
    }
  });

  it('gives every phase but ready a new generation', () => {
    expect(nextReadGraphState(undefined, TRANSITIONS[0]!)).toEqual(row('building', 5));
    expect(nextReadGraphState(row('ready'), { kind: 'mark-dirty' })).toEqual(row('dirty', 8));
    expect(nextReadGraphState(row('dirty'), { kind: 'start-repair', versions: V })).toEqual(row('repairing', 8));
    expect(nextReadGraphState(row('rebuilding'), { kind: 'publish-ready' })).toEqual(row('ready', 7));
    expect(nextReadGraphState(row('ready'), { kind: 'remove' })).toBeUndefined();
  });

  it('repairs only under the current rule and an accepted builder, and rebuilds under the current versions', () => {
    const old = { ...row('dirty'), ruleVersion: V.ruleVersion + 1 };
    expect(() => nextReadGraphState(old, { kind: 'start-repair', versions: V })).toThrow(/Cannot start-repair/);
    expect(nextReadGraphState({ ...old, builderVersion: 99 }, { kind: 'start-rebuild', versions: V }))
      .toEqual(row('rebuilding', 8));
    expect(isReadGraphRowAccepted({ ...row('ready'), builderVersion: 99 }, V)).toBe(false);
  });

  it('serves only a ready row under accepted versions', () => {
    expect(servingReadGraphGeneration(row('ready'))).toBe(7);
    expect(servingReadGraphGeneration(row('dirty'))).toBeUndefined();
    expect(servingReadGraphGeneration(undefined)).toBeUndefined();
    expect(servingReadGraphGeneration({ ...row('ready'), ruleVersion: 99 })).toBeUndefined();
  });

  it('refuses rows it cannot store', () => {
    for (const bad of [
      { ...row('ready'), generation: 0 },
      { ...row('ready'), generation: 1.5 },
      { ...row('ready'), ruleVersion: 0 },
      { ...row('ready'), readGraph: 'did:dkg:context-graph:x' },
      { ...row('ready'), state: 'gone' as ReadGraphState },
    ]) {
      expect(() => readGraphStateCompareAndSet(undefined, bad), JSON.stringify(bad)).toThrow(ReadGraphTransitionError);
    }
    expect(() => nextReadGraphState(row('ready', MAX_READ_GRAPH_GENERATION), { kind: 'mark-dirty' })).toThrow(/exhausted/);
    expect(() => readGraphStateCompareAndSet(undefined, undefined)).toThrow(/needs a row/);
    expect(() => readGraphStateCompareAndSet(row('ready'), row('ready'))).toThrow(/must change/);
    expect(() => readGraphStateCompareAndSet(row('ready'), row('dirty', 8, R2))).toThrow(/another read graph/);
    expect(() => readGraphStateFencePattern(R, 'gone' as ReadGraphState, 7)).toThrow(/Unknown read-graph state/);
    expect(() => readGraphStateFencePattern(R, 'ready', 0)).toThrow(/Invalid read-graph generation/);
    expect(() => nextReadGraphState(undefined, { kind: 'mark-dirty' })).toThrow(/absent/);
  });

  it('starts new rows at a random generation that leaves room to count', () => {
    for (let i = 0; i < 20; i += 1) {
      const generation = newReadGraphGeneration();
      expect(Number.isSafeInteger(generation) && generation >= 1 && generation < 2 ** 48).toBe(true);
    }
  });

  it('never returns to a work phase it has left', () => {
    const step = fc.constantFrom<ReadGraphTransition>(
      { kind: 'mark-dirty' }, { kind: 'start-repair', versions: V }, { kind: 'start-rebuild', versions: V }, { kind: 'publish-ready' },
    );
    fc.assert(fc.property(fc.integer({ min: 1, max: 2 ** 40 }), fc.array(step, { maxLength: 40 }), (start, steps) => {
      let current: ReadGraphStateRow | undefined = nextReadGraphState(undefined, { kind: 'create', readGraph: R, generation: start, versions: V });
      const left = new Set<string>();
      let phase = `${current!.state}@${current!.generation}`;
      for (const transition of steps) {
        let next: ReadGraphStateRow | undefined;
        try {
          next = nextReadGraphState(current, transition);
        } catch (error) {
          expect(error).toBeInstanceOf(ReadGraphTransitionError);
          continue;
        }
        if (transition.kind === 'publish-ready') expect(next!.generation).toBe(current!.generation);
        else expect(next!.generation).toBe(current!.generation + 1);
        const nextPhase = `${next!.state}@${next!.generation}`;
        if (nextPhase !== phase) left.add(phase);
        expect(left.has(nextPhase)).toBe(false);
        current = next;
        phase = nextPhase;
      }
    }), propertyOptions());
  });
});

describe('read-graph state statements on embedded Oxigraph', () => {
  async function storedRows(store: OxigraphStore) {
    const result = await store.query(readGraphStateRowsQuery());
    if (result.type !== 'bindings') throw new Error('expected bindings');
    return parseReadGraphStateRows(result.bindings);
  }

  it('creates a row once, then moves it only from the exact row it expects', async () => {
    const store = new OxigraphStore();
    const building = row('building', 7);
    await store.update(readGraphStateCompareAndSet(undefined, building));
    await store.update(readGraphStateCompareAndSet(undefined, row('building', 9)));
    expect(await storedRows(store)).toEqual({ rows: [building], damaged: [] });

    const ready = nextReadGraphState(building, { kind: 'publish-ready' })!;
    await store.update(readGraphStateCompareAndSet(building, ready));
    expect((await storedRows(store)).rows).toEqual([ready]);

    // A job that finished for an earlier generation cannot publish over a newer dirty mark.
    const dirty = nextReadGraphState(ready, { kind: 'mark-dirty' })!;
    await store.update(readGraphStateCompareAndSet(ready, dirty));
    await store.update(readGraphStateCompareAndSet(building, ready));
    expect((await storedRows(store)).rows).toEqual([dirty]);

    await store.update(readGraphStateCompareAndSet(ready, undefined));
    expect((await storedRows(store)).rows).toEqual([dirty]);
    await store.update(readGraphStateCompareAndSet(dirty, undefined));
    expect(await storedRows(store)).toEqual({ rows: [], damaged: [] });
  });

  it('refuses a compare-and-set whose state matches but whose generation is stale', async () => {
    const store = new OxigraphStore();
    const current = row('rebuilding', 9);
    await store.update(readGraphStateCompareAndSet(undefined, current));
    await store.update(readGraphStateCompareAndSet(row('rebuilding', 7), row('ready', 7)));
    expect((await storedRows(store)).rows).toEqual([current]);
    await store.update(readGraphStateCompareAndSet(current, nextReadGraphState(current, { kind: 'publish-ready' })));
    expect((await storedRows(store)).rows).toEqual([row('ready', 9)]);
  });

  it('lets a fenced operation write only for its own state and generation', async () => {
    const store = new OxigraphStore();
    await store.insert([{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o', graph: MEMBER }]);
    const copy = (state: ReadGraphState, generation: number) =>
      `INSERT { GRAPH <${R}> { ?s ?p ?o } } WHERE {\n${readGraphStateFencePattern(R, state, generation)}\n  GRAPH <${MEMBER}> { ?s ?p ?o }\n}`;
    const count = async () => {
      const result = await store.query(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${R}> { ?s ?p ?o } }`);
      return result.type === 'bindings' ? result.bindings[0]!.n : undefined;
    };

    await store.update(copy('building', 7));
    expect(await count()).toMatch(/^"?0/);

    await store.update(readGraphStateCompareAndSet(undefined, row('rebuilding', 7)));
    await store.update(copy('building', 7));
    await store.update(copy('rebuilding', 6));
    expect(await count()).toMatch(/^"?0/);
    await store.update(copy('rebuilding', 7));
    expect(await count()).toMatch(/^"?1/);

    // A damaged row with a second state value fences everything out.
    await store.update(`INSERT DATA { GRAPH <${STATE_GRAPH}> { <${R}> <${READ_GRAPH_STATE_PREDICATES.state}> "dirty" } }`);
    await store.update(`DROP SILENT GRAPH <${R}>`);
    await store.update(copy('rebuilding', 7));
    expect(await count()).toMatch(/^"?0/);
  });

  it('finds damaged rows and resets them', async () => {
    const store = new OxigraphStore();
    const p = READ_GRAPH_STATE_PREDICATES;
    const elsewhere = readGraphStateGraphIri('other');
    await store.update(readGraphStateCompareAndSet(undefined, row('ready', 3)));
    await store.update(`INSERT DATA {
      GRAPH <${STATE_GRAPH}> { <${R}> <${p.generation}> 4 . <${R2}> <${p.state}> "ready" }
      GRAPH <${elsewhere}> { <${R2}> <${p.state}> "ready" ; <${p.generation}> 1 ; <${p.ruleVersion}> 1 ; <${p.builderVersion}> 1 }
      GRAPH <${STATE_GRAPH}> { <urn:not-a-read-graph> <${p.state}> "ready" }
    }`);
    const found = await storedRows(store);
    expect(found.rows).toEqual([]);
    expect(found.damaged.sort()).toEqual([R, R2, 'urn:not-a-read-graph'].sort());

    await store.update(readGraphStateReset(row('dirty', 11)));
    expect((await storedRows(store)).rows).toEqual([row('dirty', 11)]);
    // A reset also clears a copy of the row left in another context graph's state graph.
    await store.update(readGraphStateReset(row('dirty', 12, R2)));
    const after = await storedRows(store);
    expect(after.rows.sort((a, b) => a.readGraph.localeCompare(b.readGraph)))
      .toEqual([row('dirty', 11), row('dirty', 12, R2)].sort((a, b) => a.readGraph.localeCompare(b.readGraph)));
    expect(after.damaged).toEqual(['urn:not-a-read-graph']);
  });

  it('finds a row that has lost its state, creates nothing beside it, and recovers it with a reset', async () => {
    const store = new OxigraphStore();
    const p = READ_GRAPH_STATE_PREDICATES;
    const fieldCount = async () => {
      const result = await store.query(`SELECT ?p ?o WHERE { GRAPH <${STATE_GRAPH}> { <${R}> ?p ?o } }`);
      return result.type === 'bindings' ? result.bindings.length : -1;
    };
    // The generation and versions of an earlier row survive without its state.
    await store.update(`INSERT DATA { GRAPH <${STATE_GRAPH}> { <${R}> <${p.generation}> 7 ; <${p.ruleVersion}> 1 ; <${p.builderVersion}> 1 } }`);
    expect(await storedRows(store)).toEqual({ rows: [], damaged: [R] });

    await store.update(readGraphStateCompareAndSet(undefined, row('building', 11)));
    expect(await fieldCount()).toBe(3);
    expect(await storedRows(store)).toEqual({ rows: [], damaged: [R] });

    await store.update(readGraphStateReset(row('building', 12)));
    const ready = nextReadGraphState(row('building', 12), { kind: 'publish-ready' })!;
    await store.update(readGraphStateCompareAndSet(row('building', 12), ready));
    expect(await storedRows(store)).toEqual({ rows: [ready], damaged: [] });
    expect(await fieldCount()).toBe(4);
  });

  it('changes nothing for an expected row that differs from the stored one only in a version', async () => {
    const store = new OxigraphStore();
    const stored = { ...row('rebuilding', 9), ruleVersion: 2 };
    await store.update(readGraphStateCompareAndSet(undefined, stored));
    for (const expected of [{ ...stored, ruleVersion: 1 }, { ...stored, builderVersion: 2 }]) {
      await store.update(readGraphStateCompareAndSet(expected, { ...expected, state: 'ready' }));
      expect((await storedRows(store)).rows).toEqual([stored]);
    }
    await store.update(readGraphStateCompareAndSet(stored, { ...stored, state: 'ready' }));
    expect((await storedRows(store)).rows).toEqual([{ ...stored, state: 'ready' }]);
  });

  it('marks every read graph dirty in one request, once, leaving dirty rows as they are', async () => {
    const store = new OxigraphStore();
    await store.update(readGraphStateMarkAllDirty());
    expect(await storedRows(store)).toEqual({ rows: [], damaged: [] });

    const R3 = readGraphIri({ scope: readScope('other'), layer: MemoryLayer.WorkingMemory, agentAddress: '0x' + 'cd'.repeat(20) });
    const R4 = readGraphIri({ scope: readScope('other', 'code'), layer: MemoryLayer.VerifiableMemory });
    await store.update(readGraphStateCompareAndSet(undefined, row('ready', 3)));
    await store.update(readGraphStateCompareAndSet(undefined, row('dirty', 8, R2)));
    await store.update(readGraphStateCompareAndSet(undefined, row('rebuilding', 20, R3)));
    // A damaged row without a generation still loses its ready mark.
    await store.update(`INSERT DATA { GRAPH <${readGraphStateGraphIri('other')}> { <${R4}> <${READ_GRAPH_STATE_PREDICATES.state}> "ready" } }`);
    // The same predicate outside a state graph is not a state row.
    await store.update(`INSERT DATA { GRAPH <urn:elsewhere> { <${R}> <${READ_GRAPH_STATE_PREDICATES.state}> "ready" } }`);
    // A damaged row with a second state.
    const R5 = readGraphIri({ scope: readScope('other', 'code'), layer: MemoryLayer.SharedWorkingMemory });
    await store.update(readGraphStateCompareAndSet(undefined, row('ready', 30, R5)));
    await store.update(`INSERT DATA { GRAPH <${readGraphStateGraphIri('other')}> { <${R5}> <${READ_GRAPH_STATE_PREDICATES.state}> "building" } }`);

    await store.update(readGraphStateMarkAllDirty());
    const found = await storedRows(store);
    expect(found.rows.sort((a, b) => a.readGraph.localeCompare(b.readGraph)))
      .toEqual([row('dirty', 4), row('dirty', 8, R2), row('dirty', 21, R3), row('dirty', 31, R5)].sort((a, b) => a.readGraph.localeCompare(b.readGraph)));
    const ready = await store.query(`ASK { GRAPH ?g { ?r <${READ_GRAPH_STATE_PREDICATES.state}> "ready" } FILTER(?g != <urn:elsewhere>) }`);
    expect(ready.type === 'boolean' ? ready.value : undefined).toBe(false);
    expect(found.damaged).toEqual([R4]);
    const states = await store.query(`SELECT ?g ?state WHERE { GRAPH ?g { <${R4}> <${READ_GRAPH_STATE_PREDICATES.state}> ?state } }`);
    expect(states.type === 'bindings' ? states.bindings.map((binding) => binding.state) : []).toEqual(['"dirty"']);
    const untouched = await store.query(`ASK { GRAPH <urn:elsewhere> { <${R}> <${READ_GRAPH_STATE_PREDICATES.state}> "ready" } }`);
    expect(untouched.type === 'boolean' ? untouched.value : undefined).toBe(true);

    // Running it again changes nothing: every row is dirty already.
    await store.update(readGraphStateMarkAllDirty());
    const byReadGraph = (a: ReadGraphStateRow, b: ReadGraphStateRow) => a.readGraph.localeCompare(b.readGraph);
    expect((await storedRows(store)).rows.sort(byReadGraph)).toEqual([...found.rows].sort(byReadGraph));
  });

  it('reads plain and typed literals in either result form', () => {
    const binding = (state: string, generation: string) => ({
      stateGraph: STATE_GRAPH, readGraph: R, state, generation, ruleVersion: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', builderVersion: '1',
    });
    expect(parseReadGraphStateRows([binding('"ready"', '"7"^^<http://www.w3.org/2001/XMLSchema#integer>')]).rows).toEqual([row('ready')]);
    expect(parseReadGraphStateRows([binding('ready', '7')]).rows).toEqual([row('ready')]);
    expect(parseReadGraphStateRows([binding('"ready"', '"07"')]).damaged).toEqual([R]);
    // Only the term forms the statements write and match: no language tag, no string where a number belongs.
    expect(parseReadGraphStateRows([binding('"ready"@en', '7')]).damaged).toEqual([R]);
    expect(parseReadGraphStateRows([binding('"ready"', '"7"')]).damaged).toEqual([R]);
    expect(parseReadGraphStateRows([binding('"ready"', '"7"^^<http://www.w3.org/2001/XMLSchema#long>')]).damaged).toEqual([R]);
    expect(parseReadGraphStateRows([binding('"ready"', String(2 ** 60))]).damaged).toEqual([R]);
    expect(parseReadGraphStateRows([{ stateGraph: STATE_GRAPH }])).toEqual({ rows: [], damaged: [] });
  });
});
