import { expect, it } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { nonEmptyNamedGraphEnumerationPattern } from '../src/adapters/graph-enumeration-query.js';

it.each(['g', 's', 'p', 'o', '_s'])('enumerates the same nonempty graphs with variable %s', async variable => {
  const store = new OxigraphStore();
  try {
    await store.update('CREATE GRAPH <urn:empty>');
    await store.insert([{ graph: 'urn:g', subject: 'urn:item', predicate: 'urn:name', object: '"value"' }]);
    const result = await store.query(`SELECT ?${variable} WHERE { ${nonEmptyNamedGraphEnumerationPattern(variable)} }`);
    expect(result).toMatchObject({type: 'bindings', bindings: [{[variable]: 'urn:g'}]});
  } finally { await store.close(); }
});
