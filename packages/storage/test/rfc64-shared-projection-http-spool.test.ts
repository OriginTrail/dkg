import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1,
  type Rfc64SharedProjectionStreamOperationV1,
} from '@origintrail-official/dkg-core';
import { describe, expect, it } from 'vitest';

import {
  spoolRfc64SharedProjectionHttpResponseV1,
} from '../src/rfc64-shared-projection-http-spool.js';
import type { Quad } from '../src/triple-store.js';

const GRAPH = 'did:dkg:context-graph:a/b/_shared_memory/0x3333333333333333333333333333333333333333/7';
const LINE_A = '<urn:a> <urn:p> "alpha" .\n';
const LINE_M = '<urn:m> <urn:p> "middle" .\n';
const LINE_Z = '<urn:z> <urn:p> "zeta" .\n';

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
        quad('urn:a', '"alpha"'),
        quad('urn:m', '"middle"'),
        quad('urn:z', '"zeta"'),
      ]);
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
      expect((await collect(source)).map((value) => value.subject)).toEqual([
        'urn:a',
        'urn:b',
        'urn:c',
        'urn:d',
        'urn:e',
        'urn:f',
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

    expect(await collect(source)).toEqual([quad('urn:a', JSON.stringify(literal))]);
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
    resultKind: 'quad-stream',
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

function quad(subject: string, object: string): Quad {
  return Object.freeze({ subject, predicate: 'urn:p', object, graph: GRAPH });
}

async function collect(source: AsyncIterable<Quad>): Promise<Quad[]> {
  const quads: Quad[] = [];
  for await (const value of source) quads.push(value);
  return quads;
}
