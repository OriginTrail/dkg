import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeKaProjectionDigestV1,
  RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1,
  type Rfc64SharedProjectionStreamOperationV1,
} from '@origintrail-official/dkg-core';
import { describe, expect, it } from 'vitest';

import {
  spoolRfc64SharedProjectionHttpResponseV1,
} from '../src/rfc64-shared-projection-http-spool.js';
import { RFC64_PROJECTION_TEST_GRAPH } from './helpers/rfc64-shared-projection-fixture.js';

const GRAPH = RFC64_PROJECTION_TEST_GRAPH;
const LINE_A = '<urn:a> <urn:p> "alpha" .\n';
const LINE_M = '<urn:m> <urn:p> "middle" .\n';
const LINE_Z = '<urn:z> <urn:p> "zeta" .\n';
const INTEGER_DATATYPE = 'http://www.w3.org/2001/XMLSchema#integer';
const PADDED_INTEGER_LINE =
  `<urn:a> <urn:p> "00000000000000000001"^^<${INTEGER_DATATYPE}> .\n`;
const CANONICAL_INTEGER_LINE = `<urn:a> <urn:p> "1"^^<${INTEGER_DATATYPE}> .\n`;

describe('RFC-64 shared-projection HTTP spool', () => {
  it('externally sorts a chunked response and removes every spill artifact on exhaustion', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'dkg-rfc64-spool-test-'));
    try {
      const source = await spoolRfc64SharedProjectionHttpResponseV1({
        body: byteStream([LINE_Z.slice(0, 9), LINE_Z.slice(9) + LINE_A, LINE_M]),
        operation: operation({ publicTripleCount: '3' }),
        byteCeiling: 4096,
        tempRoot,
        sortChunkBytes: 32,
        sortChunkLines: 1,
      });

      expect(await readdir(tempRoot)).toHaveLength(1);
      expect(await collect(source)).toEqual([
        LINE_A,
        LINE_M,
        LINE_Z,
      ]);
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('removes a spilled projection when an unstarted iterator is returned', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'dkg-rfc64-spool-test-'));
    try {
      const source = await spoolRfc64SharedProjectionHttpResponseV1({
        body: byteStream([LINE_Z, LINE_A]),
        operation: operation({ publicTripleCount: '2' }),
        byteCeiling: 4096,
        tempRoot,
        sortChunkLines: 1,
      });
      expect(await readdir(tempRoot)).toHaveLength(1);

      await source[Symbol.asyncIterator]().return?.();

      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('removes spill artifacts when the consumer returns early or aborts', async () => {
    for (const abortBeforeRead of [false, true]) {
      const tempRoot = await mkdtemp(join(tmpdir(), 'dkg-rfc64-spool-test-'));
      try {
        const controller = new AbortController();
        const source = await spoolRfc64SharedProjectionHttpResponseV1({
          body: byteStream([LINE_Z, LINE_A, LINE_M]),
          operation: operation({ publicTripleCount: '3' }),
          byteCeiling: 4096,
          signal: controller.signal,
          tempRoot,
          sortChunkLines: 1,
        });
        const iterator = source[Symbol.asyncIterator]();

        if (abortBeforeRead) {
          controller.abort(new DOMException('test abort', 'AbortError'));
          await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
        } else {
          await expect(iterator.next()).resolves.toMatchObject({ done: false });
          await iterator.return?.();
        }

        expect(await readdir(tempRoot)).toEqual([]);
      } finally {
        await rm(tempRoot, { force: true, recursive: true });
      }
    }
  });

  it('keeps a distinct consumption signal live through spilled iteration', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'dkg-rfc64-spool-test-'));
    try {
      const construction = new AbortController();
      const consumption = new AbortController();
      const source = await spoolRfc64SharedProjectionHttpResponseV1({
        body: byteStream([LINE_Z, LINE_A, LINE_M]),
        operation: operation({ publicTripleCount: '3' }),
        byteCeiling: 4096,
        signal: construction.signal,
        consumptionSignal: consumption.signal,
        tempRoot,
        sortChunkLines: 1,
      });
      const iterator = source[Symbol.asyncIterator]();

      consumption.abort(new DOMException('consumer stopped', 'AbortError'));

      await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
      expect(construction.signal.aborted).toBe(false);
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('uses bounded fan-in passes instead of opening every spill run at once', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'dkg-rfc64-spool-test-'));
    const lines = [
      '<urn:f> <urn:p> "6" .\n',
      '<urn:a> <urn:p> "1" .\n',
      '<urn:e> <urn:p> "5" .\n',
      '<urn:b> <urn:p> "2" .\n',
      '<urn:d> <urn:p> "4" .\n',
      '<urn:c> <urn:p> "3" .\n',
    ];
    try {
      const source = await spoolRfc64SharedProjectionHttpResponseV1({
        body: byteStream(lines),
        operation: operation({ publicTripleCount: '6' }),
        byteCeiling: 4096,
        tempRoot,
        sortChunkLines: 1,
        mergeFanIn: 2,
      });

      const [spoolDirectory] = await readdir(tempRoot);
      expect(spoolDirectory).toBeDefined();
      expect(await readdir(join(tempRoot, spoolDirectory!))).toHaveLength(2);
      expect(await collect(source)).toEqual([
        '<urn:a> <urn:p> "1" .\n',
        '<urn:b> <urn:p> "2" .\n',
        '<urn:c> <urn:p> "3" .\n',
        '<urn:d> <urn:p> "4" .\n',
        '<urn:e> <urn:p> "5" .\n',
        '<urn:f> <urn:p> "6" .\n',
      ]);
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('coalesces many tiny transport chunks while retaining the line ceiling', async () => {
    const literal = 'x'.repeat(300);
    const line = `<urn:a> <urn:p> "${literal}" .\n`;
    const source = await spoolRfc64SharedProjectionHttpResponseV1({
      body: byteStream([...line]),
      operation: operation({ publicTripleCount: '1' }),
      byteCeiling: 4096,
    });

    expect(await collect(source)).toEqual([line]);
  });

  it('rejects a fragmented oversized line before LF or EOF arrives', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('12345'));
        controller.enqueue(new TextEncoder().encode('67890'));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(spoolRfc64SharedProjectionHttpResponseV1({
      body,
      operation: operation({ publicTripleCount: '1' }),
      byteCeiling: 4096,
      inputLineByteCeiling: 8,
    })).rejects.toThrow('local input-line ceiling');
    expect(cancelled).toBe(true);
  });

  it.each([
    ['memory', undefined],
    ['spill', 1],
  ] as const)(
    'canonicalizes backend lexical bytes before accounting and emission on the %s path',
    async (_name, sortChunkLines) => {
      const source = await spoolRfc64SharedProjectionHttpResponseV1({
        body: byteStream([PADDED_INTEGER_LINE]),
        operation: operation({
          publicTripleCount: '1',
          signedByteCeiling: CANONICAL_INTEGER_LINE.length,
        }),
        byteCeiling: CANONICAL_INTEGER_LINE.length,
        ...(sortChunkLines === undefined ? {} : { sortChunkLines }),
      });
      const emitted = await collectRaw(source);
      expect(emitted.map((line) => new TextDecoder().decode(line)))
        .toEqual([CANONICAL_INTEGER_LINE]);
      expect(computeKaProjectionDigestV1(joinBytes(emitted)))
        .toBe(computeKaProjectionDigestV1(new TextEncoder().encode(CANONICAL_INTEGER_LINE)));
      expect(PADDED_INTEGER_LINE.length).toBeGreaterThan(CANONICAL_INTEGER_LINE.length);
    },
  );

  it('emits identical owned LF-terminated bytes from memory and spilled paths', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'dkg-rfc64-spool-test-'));
    try {
      const base = {
        body: byteStream([LINE_Z, LINE_A, LINE_M]),
        operation: operation({ publicTripleCount: '3' }),
        byteCeiling: 4096,
      };
      const memory = await spoolRfc64SharedProjectionHttpResponseV1(base);
      const spilled = await spoolRfc64SharedProjectionHttpResponseV1({
        ...base,
        body: byteStream([LINE_Z, LINE_A, LINE_M]),
        tempRoot,
        sortChunkLines: 1,
      });
      const memoryLines = await collectRaw(memory);
      const spilledLines = await collectRaw(spilled);

      expect(spilledLines).toEqual(memoryLines);
      expect(memoryLines.every((line) => line.at(-1) === 0x0a)).toBe(true);
      spilledLines[0].fill(0x7f);
      expect(new TextDecoder().decode(memoryLines[0])).toBe(LINE_A);
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('removes prior spill runs when later response validation fails', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'dkg-rfc64-spool-test-'));
    try {
      await expect(spoolRfc64SharedProjectionHttpResponseV1({
        body: byteStream([LINE_A, '<urn:broken>\n']),
        operation: operation({ publicTripleCount: '2' }),
        byteCeiling: 4096,
        tempRoot,
        sortChunkLines: 1,
      })).rejects.toThrow('malformed N-Quads line');
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it.each([
    {
      name: 'malformed UTF-8',
      body: [new Uint8Array([0xc3, 0x28, 0x0a])],
      operation: operation({ publicTripleCount: '1' }),
      byteCeiling: 4096,
      message: 'not strict UTF-8',
    },
    {
      name: 'a different named graph',
      body: ['<urn:a> <urn:p> "alpha" <urn:other> .\n'],
      operation: operation({ publicTripleCount: '1' }),
      byteCeiling: 4096,
      message: 'escaped the exact authenticated graph',
    },
    {
      name: 'triple-count overflow',
      body: [LINE_A + LINE_M],
      operation: operation({ publicTripleCount: '1' }),
      byteCeiling: 4096,
      message: 'exceeds the author-sealed triple count',
    },
    {
      name: 'triple-count underflow',
      body: [LINE_A],
      operation: operation({ publicTripleCount: '2' }),
      byteCeiling: 4096,
      message: 'does not match the author-sealed triple count',
    },
    {
      name: 'effective canonical byte ceiling',
      body: [LINE_A],
      operation: operation({ publicTripleCount: '1' }),
      byteCeiling: 10,
      message: 'effective projection byte ceiling',
    },
    {
      name: 'protocol wire hard cap',
      body: [LINE_A],
      operation: operation({ publicTripleCount: '1', protocolByteCeiling: 8 }),
      byteCeiling: 8,
      message: 'wire response exceeds the protocol hard cap',
    },
    {
      name: 'independent raw input-line ceiling',
      body: [LINE_A],
      operation: operation({ publicTripleCount: '1' }),
      byteCeiling: 4096,
      inputLineByteCeiling: 8,
      message: 'local input-line ceiling',
    },
  ])('rejects $name before exposing a stream', async (testCase) => {
    await expect(spoolRfc64SharedProjectionHttpResponseV1({
      body: byteStream(testCase.body),
      operation: testCase.operation,
      byteCeiling: testCase.byteCeiling,
      inputLineByteCeiling: testCase.inputLineByteCeiling,
    })).rejects.toThrow(testCase.message);
  });
});

function operation(
  overrides: Partial<Rfc64SharedProjectionStreamOperationV1> = {},
): Rfc64SharedProjectionStreamOperationV1 {
  return Object.freeze({
    queryId: 'SYNC_KA_SHARED_PROJECTION_STREAM_V1',
    graphIri: GRAPH,
    commitmentSubject:
      'did:dkg:otp:20430/0x3333333333333333333333333333333333333333/7/_cg-shared-v1',
    projectionDigest: `0x${'11'.repeat(32)}`,
    publicTripleCount: '3',
    signedByteCeiling: 4096,
    protocolByteCeiling: RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1,
    resultKind: 'canonical-line-byte-stream',
    concurrencyClass: 'rfc64-shared-projection-v1',
    sparql: `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${GRAPH}> { ?s ?p ?o . } }`,
    ...overrides,
  }) as Rfc64SharedProjectionStreamOperationV1;
}

function byteStream(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<string[]> {
  return (await collectRaw(source)).map((line) => new TextDecoder().decode(line));
}

async function collectRaw(source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const lines: Uint8Array[] = [];
  for await (const value of source) lines.push(value);
  return lines;
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
