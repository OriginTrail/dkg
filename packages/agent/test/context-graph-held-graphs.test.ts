import { describe, expect, it, vi } from 'vitest';
import { holdsContextGraphGraphs } from '../src/context-graph-held-graphs.js';

const ROOT = 'did:dkg:context-graph:0xab/products';

function store(graphs: readonly string[], options: { byPrefix?: boolean } = {}) {
  return {
    hasGraph: vi.fn(async (graph: string) => graphs.includes(graph)),
    listGraphs: vi.fn(async () => [...graphs]),
    ...(options.byPrefix === false ? {} : {
      listGraphsByPrefix: vi.fn(async (prefix: string) => graphs.filter((graph) => graph.startsWith(prefix))),
    }),
  };
}

describe('whether the store holds any graph of a context graph', () => {
  it('counts the root graph and any graph in its reserved partitions, such as an asset graph', async () => {
    await expect(holdsContextGraphGraphs(store([ROOT]), '0xab/products')).resolves.toBe(true);
    await expect(holdsContextGraphGraphs(store([`${ROOT}/_verifiable_memory/0xaa/1`]), '0xab/products')).resolves.toBe(true);
    await expect(holdsContextGraphGraphs(store([]), '0xab/products')).resolves.toBe(false);
  });

  it('does not count graphs under context/ or assertion/, which a child context graph may own under the same names', async () => {
    // A child context graph `<id>/context/7` with its _meta: one IRI with a per-context-ID graph and its _meta.
    const child = store([`${ROOT}/context/7`, `${ROOT}/context/7/_meta`, `${ROOT}/assertion/0xaa/notes`]);
    await expect(holdsContextGraphGraphs(child, '0xab/products')).resolves.toBe(false);
    await expect(holdsContextGraphGraphs(store([`${ROOT}/context/7`], { byPrefix: false }), '0xab/products')).resolves.toBe(false);
  });

  it('does not count another context graph whose id extends this one, a child included', async () => {
    const other = store([`${ROOT}-archive/_verifiable_memory/0xaa/1`, `${ROOT}s`, `${ROOT}/child/_verifiable_memory/0xaa/1`, `${ROOT}/child`]);
    await expect(holdsContextGraphGraphs(other, '0xab/products')).resolves.toBe(false);
    expect(other.listGraphsByPrefix).toHaveBeenCalledWith(`${ROOT}/_`, { signal: undefined });
    await expect(holdsContextGraphGraphs(store([`${ROOT}/_~read/vm`]), '0xab/products')).resolves.toBe(true);
  });

  it('lists all graphs where the store cannot list by prefix, and passes the signal on', async () => {
    const signal = new AbortController().signal;
    const plain = store([`${ROOT}/_shared_memory`, 'did:dkg:context-graph:other'], { byPrefix: false });
    await expect(holdsContextGraphGraphs(plain, '0xab/products', signal)).resolves.toBe(true);
    expect(plain.hasGraph).toHaveBeenCalledWith(ROOT, { signal });
    expect(plain.listGraphs).toHaveBeenCalledWith({ signal });
  });

  it('holds nothing of an id that cannot be written as an IRI, without asking the store', async () => {
    const asked = store([ROOT]);
    await expect(holdsContextGraphGraphs(asked, '0xab/products> <urn:x')).resolves.toBe(false);
    expect(asked.hasGraph).not.toHaveBeenCalled();
  });
});
