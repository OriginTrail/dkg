import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OXIGRAPH_WRITE_CASES,
  recordOxigraphWorkerWrite,
  recordOxigraphWrite,
} from './helpers/oxigraph-write-requests.js';

/**
 * What embedded Oxigraph is asked to do for each write method, recorded on the
 * base of this change: OxigraphStore's engine calls, and the messages
 * OxigraphWorkerStore posts to its worker. A write that carries no read-graph
 * operations must keep making exactly these.
 */
const TODAY: Readonly<Record<'embedded' | 'worker', Readonly<Record<string, readonly string[]>>>> = JSON.parse(
  readFileSync(new URL('./fixtures/oxigraph-write-requests.json', import.meta.url), 'utf8'),
);
const WORKER_CASES = OXIGRAPH_WRITE_CASES.filter((c) => c.worker !== false);

describe('OxigraphStore engine calls', () => {
  it('records every write case once', () => {
    expect(Object.keys(TODAY.embedded).sort()).toEqual(OXIGRAPH_WRITE_CASES.map((c) => c.name).sort());
  });

  it.each(OXIGRAPH_WRITE_CASES)('$name makes the recorded engine calls', async (writeCase) => {
    const { requests, error } = await recordOxigraphWrite((store) => writeCase.run(store));
    expect(error).toBeUndefined();
    expect(requests).toEqual(TODAY.embedded[writeCase.name]);
  });
});

describe('OxigraphWorkerStore worker messages', () => {
  it('records every write case of the worker store once', () => {
    expect(Object.keys(TODAY.worker).sort()).toEqual(WORKER_CASES.map((c) => c.name).sort());
  });

  it.each(WORKER_CASES)('$name posts the recorded messages', async (writeCase) => {
    const { requests, error } = await recordOxigraphWorkerWrite((store) => writeCase.run(store));
    expect(error).toBeUndefined();
    expect(requests).toEqual(TODAY.worker[writeCase.name]);
  });
});
