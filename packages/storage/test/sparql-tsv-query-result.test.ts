import { describe, expect, it } from 'vitest';
import {
  decodeSparqlTsvSelectResponse,
  decodeSparqlTsvSelectResult,
} from '../src/sparql-tsv-query-result.js';

function chunkedResponse(
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200, headers });
}

describe('SPARQL TSV SELECT decoding', () => {
  it('normalizes every supported term kind and preserves unbound cells', () => {
    const result = decodeSparqlTsvSelectResult(
      '?iri\t?blank\t?plain\t?language\t?typed\t?integer\t?decimal\t?double\t?boolean\t?missing\n'
      + '<urn:test:item>\t_:b0\t"hello\\tworld"\t"colour"@en-GB\t"7"^^<urn:type>\t42\t.5\t1e3\ttrue\t\n',
    );

    expect(result).toEqual({
      type: 'bindings',
      variables: [
        'iri', 'blank', 'plain', 'language', 'typed', 'integer', 'decimal',
        'double', 'boolean', 'missing',
      ],
      bindings: [{
        iri: 'urn:test:item',
        blank: '_:b0',
        plain: '"hello\\tworld"',
        language: '"colour"@en-GB',
        typed: '"7"^^<urn:type>',
        integer: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        decimal: '".5"^^<http://www.w3.org/2001/XMLSchema#decimal>',
        double: '"1e3"^^<http://www.w3.org/2001/XMLSchema#double>',
        boolean: '"true"^^<http://www.w3.org/2001/XMLSchema#boolean>',
      }],
    });
  });

  it('handles BOM, CRLF, empty results, zero-column rows, and __proto__ safely', () => {
    const decoded = decodeSparqlTsvSelectResult('\uFEFF?__proto__\r\n"safe"\r\n');
    expect(decoded.type).toBe('bindings');
    expect(decoded.variables).toEqual(['__proto__']);
    const binding = decoded.bindings[0]!;
    expect(binding['__proto__']).toBe('"safe"');
    expect(Object.getPrototypeOf(binding)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(binding, '__proto__')).toBe(true);
    expect(decodeSparqlTsvSelectResult('?x\n')).toEqual({
      type: 'bindings', variables: ['x'], bindings: [],
    });
    expect(decodeSparqlTsvSelectResult('\n\n')).toEqual({
      type: 'bindings', variables: [], bindings: [{}],
    });
  });

  it('decodes UTF-8 and row delimiters incrementally across arbitrary chunks', async () => {
    const bytes = new TextEncoder().encode('?name\r\n"Živjo 🌍"\r\n');
    const chunks = Array.from(bytes, byte => Uint8Array.of(byte));
    await expect(decodeSparqlTsvSelectResponse(chunkedResponse(chunks), {
      operation: 'query',
    })).resolves.toEqual({
      type: 'bindings',
      variables: ['name'],
      bindings: [{ name: '"Živjo 🌍"' }],
    });
  });

  it('enforces maxResponseBytes while streaming and from Content-Length', async () => {
    const bytes = new TextEncoder().encode('?x\n"value"\n');
    let streamCancelled = false;
    const streamingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 4));
        controller.enqueue(bytes.slice(4));
      },
      cancel() {
        streamCancelled = true;
      },
    });
    await expect(decodeSparqlTsvSelectResponse(new Response(streamingBody), {
      operation: 'query',
      maxResponseBytes: bytes.byteLength - 1,
    })).rejects.toMatchObject({
      code: 'STORE_RESPONSE_TOO_LARGE',
      maxBytes: bytes.byteLength - 1,
    });
    expect(streamCancelled).toBe(true);

    let headerCancelled = false;
    const declaredBody = new ReadableStream<Uint8Array>({
      cancel() {
        headerCancelled = true;
      },
    });
    await expect(decodeSparqlTsvSelectResponse(new Response(declaredBody, {
      headers: { 'Content-Length': String(bytes.byteLength) },
    }), {
      operation: 'query',
      maxResponseBytes: 1,
    })).rejects.toMatchObject({
      code: 'STORE_RESPONSE_TOO_LARGE',
      actualBytes: BigInt(bytes.byteLength),
    });
    expect(headerCancelled).toBe(true);
  });

  it('rejects malformed headers, rows, RDF terms, UTF-8, and duplicate variables', async () => {
    expect(() => decodeSparqlTsvSelectResult('')).toThrow('missing its header');
    expect(() => decodeSparqlTsvSelectResult('x\n')).toThrow('must be a variable');
    expect(() => decodeSparqlTsvSelectResult('?x\t?x\n')).toThrow('must not contain duplicates');
    expect(() => decodeSparqlTsvSelectResult('?x\t?y\n"one"\n')).toThrow('1 columns; expected 2');
    expect(() => decodeSparqlTsvSelectResult('?x\n<relative>\n')).toThrow('absolute safe IRI');
    expect(() => decodeSparqlTsvSelectResult('?x\n_:bad.\n')).toThrow('not a valid RDF term');

    await expect(decodeSparqlTsvSelectResponse(chunkedResponse([
      Uint8Array.from([0x3f, 0x78, 0x0a, 0xc3, 0x28]),
    ]), { operation: 'query' })).rejects.toThrow('not valid UTF-8');
  });

  it('maps a managed Oxigraph cancellation suffix to the typed timeout error', async () => {
    const body = new TextEncoder().encode(
      '?x\n<urn:partial>\nThe SPARQL operation has been cancelled',
    );
    await expect(decodeSparqlTsvSelectResponse(chunkedResponse([body]), {
      operation: 'query',
      managedOxigraph: true,
    })).rejects.toMatchObject({
      code: 'STORE_OPERATION_TIMEOUT',
      backend: 'oxigraph-server',
      operation: 'query',
    });
  });
});
