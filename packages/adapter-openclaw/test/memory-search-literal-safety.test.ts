import { afterEach, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DkgMemorySearchManager } from '../src/DkgMemoryPlugin.js';
import { DkgDaemonClient } from '../src/dkg-client.js';

const searchTerms = [
  String.raw`\u0022`,
  String.raw`\U00000022`,
  String.raw`\u0061`,
  String.raw`\u005c\u0022`,
  String.raw`\\u0022`,
  String.raw`\\\u0022`,
  String.raw`\u0022)||true||(\u0022`,
  '")||true||("',
  'needle"#suffix',
  String.raw`folder\memory`,
  'café',
  'Привет',
  '🧠📚',
];

afterEach(() => vi.restoreAllMocks());

it.each(searchTerms)('searches %j as literal text using the real SPARQL parser', async (term) => {
  const store = new OxigraphStore();
  const client = new DkgDaemonClient({ baseUrl: 'http://127.0.0.1:1' });
  const warn = vi.fn();
  const returnedSubjects: string[][] = [];
  try {
    const texts = [
      ['target', `Matching memory record contains ${term} in ordinary text.`],
      ['unrelated', 'Unrelated memory record contains a plain " quote and alphabetic text.'],
    ];
    // Encode fixture RDF independently of the search expression builder.
    await store.insert(texts.map(([id, text]) => ({
      subject: `urn:memory:${id}`, predicate: 'urn:memory:text',
      object: JSON.stringify(text), graph: '',
    })));
    // Keep transport/view routing outside this parser witness; execute every
    // production-generated search expression against a real isolated dataset.
    const query = vi.spyOn(client, 'query').mockImplementation(async (sparql) => {
      const result = await store.query(sparql);
      if (result.type !== 'bindings') throw new Error('Expected SELECT bindings');
      returnedSubjects.push(result.bindings.map((row) => row.uri));
      return { result };
    });
    const manager = new DkgMemorySearchManager({
      client, logger: { warn, info: vi.fn(), debug: vi.fn() },
      resolver: {
        getSession: () => ({ agentAddress: 'peer-literal-test' }),
        getDefaultAgentAddress: () => 'peer-literal-test',
        listAvailableContextGraphs: () => [],
      },
    });
    const results = await manager.search(term);
    expect(query).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
    expect(returnedSubjects).toEqual(Array.from({ length: 3 }, () => ['urn:memory:target']));
    expect(results).toHaveLength(1);
    expect(results[0].snippet).toContain('Matching memory record');
    expect(results[0].layer).toBe('agent-context-vm');
  } finally {
    await store.close();
  }
});
