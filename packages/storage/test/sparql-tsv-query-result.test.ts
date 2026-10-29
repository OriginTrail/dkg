import { describe, expect, it } from 'vitest';
import {
  decodeSparqlTsvSelectResponse,
  decodeSparqlTsvSelectResult,
  SparqlTsvResultsShapeError,
} from '../src/sparql-tsv-query-result.js';
import { decodeSparqlHttpQueryResponse } from '../src/adapters/sparql-query-response.js';
import { decodeSparqlJsonQueryResult, formatSparqlJsonBindings } from '../src/sparql-json-query-result.js';

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
  it('preserves mixed terminators and empty cells at every transport boundary', async () => {
    const body = '?a\t?__proto__\t?c\r\n<urn:a>\t\t"one"\r\t"safe"\t\n\t\t\r\n<urn:b>\t\t"last"';
    const expected = {
      type: 'bindings', variables: ['a', '__proto__', 'c'],
      bindings: [{ a: 'urn:a', c: '"one"' }, JSON.parse('{"__proto__":"\\"safe\\""}'), {}, { a: 'urn:b', c: '"last"' }],
    };
    expect(decodeSparqlTsvSelectResult(body)).toEqual(expected);
    const bytes = new TextEncoder().encode(body);
    for (let split = 0; split <= bytes.length; split += 1) {
      await expect(decodeSparqlTsvSelectResponse(chunkedResponse([
        bytes.subarray(0, split), bytes.subarray(split),
      ]))).resolves.toEqual(expected);
    }
  });

  it('keeps precise lazy diagnostics and validates row arity before terms', () => {
    expect(() => decodeSparqlTsvSelectResult('?a\t?b\n<urn:ok>\t"ok"\n\t<relative>\n'))
      .toThrow('SPARQL TSV binding 1.b URI value must be an absolute safe IRI');
    expect(() => decodeSparqlTsvSelectResult('?a\n"7"^^<relative>\n'))
      .toThrow('SPARQL TSV binding 0.a datatype must be an absolute safe IRI');
    expect(() => decodeSparqlTsvSelectResult('?a\n_:bad.\n'))
      .toThrow('SPARQL TSV binding 0.a is not a valid RDF term');
    expect(() => decodeSparqlTsvSelectResult('?a\ninvalid\t\t\n'))
      .toThrow('SPARQL TSV row 0 has 3 columns; expected 1');
    expect(() => decodeSparqlTsvSelectResult('\n\t\n'))
      .toThrow('SPARQL TSV row 0 has 2 columns; expected 0');
  });

  it.each(['language', 'typed', 'escaped'] as const)(
    'decodes a 16 MB %s literal without exhausting the regex stack', async (kind) => {
      const payload = 'x'.repeat(16_000_000);
      const value = kind === 'escaped' ? `${payload}\n"quoted"\\` : payload;
      const suffix = kind === 'language' ? '@en' : kind === 'typed' ? '^^<urn:type>' : '';
      const literal = kind === 'escaped' ? `"${payload}\\n\\"quoted\\"\\\\"` : `"${payload}"${suffix}`;
      const body = `?v\n${literal}\n`;
      const expected = decodeSparqlJsonQueryResult(JSON.stringify({
        head: { vars: ['v'] },
        results: { bindings: [{ v: {
          type: 'literal', value,
          ...(kind === 'language' ? { 'xml:lang': 'en' } : {}),
          ...(kind === 'typed' ? { datatype: 'urn:type' } : {}),
        } }] },
      }), 'select');
      expect(decodeSparqlTsvSelectResult(body)).toEqual(expected);
      const bytes = new TextEncoder().encode(body);
      const chunks: Uint8Array[] = [];
      for (let offset = 0; offset < bytes.length; offset += 16_384) {
        chunks.push(bytes.subarray(offset, offset + 16_384));
      }
      await expect(decodeSparqlTsvSelectResponse(chunkedResponse(chunks), {
        maxResponseBytes: bytes.length,
      })).resolves.toEqual(expected);
    },
    // Keep the stack-overflow-sized payload under V8 coverage on slower CI runners.
    30_000,
  );

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

  it('matches JSON canonicalization for raw controls in every literal form', () => {
    const value = 'a\u0001b\u007F';
    const expected = formatSparqlJsonBindings({
      head: { vars: ['plain', 'language', 'typed'] },
      results: { bindings: [{
        plain: { type: 'literal', value },
        language: { type: 'literal', value, 'xml:lang': 'en' },
        typed: { type: 'typed-literal', value, datatype: 'urn:test:type' },
      }] },
    });
    expect(decodeSparqlTsvSelectResult(
      `?plain\t?language\t?typed\n"${value}"\t"${value}"@en\t"${value}"^^<urn:test:type>\n`,
    ).bindings).toEqual(expected);
    expect(expected).toEqual([{
      plain: '"a\\u0001b\\u007F"',
      language: '"a\\u0001b\\u007F"@en',
      typed: '"a\\u0001b\\u007F"^^<urn:test:type>',
    }]);
  });

  it.each([
    ["'hello'", '"hello"'],
    ["'hello'@en", '"hello"@en'],
    ["'hello'@es-419", '"hello"@es-419'],
    ["'7'^^<urn:type>", '"7"^^<urn:type>'],
    [String.raw`'say "hello" and \'bye\'\\'`, String.raw`"say \"hello\" and 'bye'\\"`],
    [String.raw`'\t\n\r\uD83D\uDE00'`, '"\\t\\n\\r😀"'],
    [String.raw`'7'^^<urn:\u0074ype>`, '"7"^^<urn:type>'],
    [String.raw`"7"^^<urn:\u0074ype>`, '"7"^^<urn:type>'],
    ["'a\u0001b\u007F'@en", '"a\\u0001b\\u007F"@en'],
  ])('canonicalizes %s through buffered and streamed decoding', async (literal, canonical) => {
    const body = `?v\n${literal}\n`;
    const expected = { type: 'bindings', variables: ['v'], bindings: [{ v: canonical }] };
    expect(decodeSparqlTsvSelectResult(body)).toEqual(expected);
    const chunks = Array.from(new TextEncoder().encode(body), byte => Uint8Array.of(byte));
    await expect(decodeSparqlTsvSelectResponse(chunkedResponse(chunks))).resolves.toEqual(expected);
  });

  it.each([
    String.raw`"7"^^urn:type`,
    String.raw`'7'^^urn:type`,
    String.raw`"7"^^<relative>`,
    String.raw`'7'^^<relative>`,
    String.raw`"7"^^<urn:\q>`,
    String.raw`"7"^^<urn:\uD800>`,
    String.raw`"\q"`,
    String.raw`'\q'`,
    String.raw`"\u123"`,
    String.raw`"\uD800"`,
    String.raw`'\uDC00'`,
    String.raw`"\U00110000"`,
    String.raw`'unescaped'quote'`,
    String.raw`"mismatched'`,
    String.raw`'''long'''`,
    String.raw`"""long"""`,
    String.raw`"hello"@`,
    String.raw`"hello"@419`,
    String.raw`"hello"@en-`,
    String.raw`"hello"@en--GB`,
    String.raw`"hello"@en_GB`,
  ])('rejects malformed wire literal %s through both decoders', async (literal) => {
    const body = `?v\n${literal}\n`;
    expect(() => decodeSparqlTsvSelectResult(body)).toThrow(SparqlTsvResultsShapeError);
    const chunks = Array.from(new TextEncoder().encode(body), byte => Uint8Array.of(byte));
    await expect(decodeSparqlTsvSelectResponse(chunkedResponse(chunks)))
      .rejects.toBeInstanceOf(SparqlTsvResultsShapeError);
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
    await expect(decodeSparqlTsvSelectResponse(chunkedResponse(chunks))).resolves.toEqual({
      type: 'bindings',
      variables: ['name'],
      bindings: [{ name: '"Živjo 🌍"' }],
    });
  });

  it.each(['\n', '\r', '\r\n'])(
    'preserves %j boundaries, empty rows, and an unterminated row at every split', async (delimiter) => {
      const body = `?v${delimiter}"first"${delimiter}${delimiter}"last"`;
      const bytes = new TextEncoder().encode(body);
      const expected = {
        type: 'bindings', variables: ['v'], bindings: [{ v: '"first"' }, {}, { v: '"last"' }],
      };
      expect(decodeSparqlTsvSelectResult(body)).toEqual(expected);
      for (let split = 0; split <= bytes.length; split += 1) {
        await expect(decodeSparqlTsvSelectResponse(chunkedResponse([
          bytes.subarray(0, split), new Uint8Array(), bytes.subarray(split),
        ]))).resolves.toEqual(expected);
      }
      const terminated = new TextEncoder().encode(body + delimiter);
      await expect(decodeSparqlTsvSelectResponse(chunkedResponse(
        Array.from(terminated, byte => Uint8Array.of(byte)),
      ))).resolves.toEqual(expected);
    },
  );

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
    expect(decodeSparqlTsvSelectResult('?café\t?δοκιμή\t?𐀀name\n')).toMatchObject({
      variables: ['café', 'δοκιμή', '𐀀name'],
    });
    for (const header of ['$x', String.raw`?\u0078`, '??x', '?a-b']) {
      expect(() => decodeSparqlTsvSelectResult(`${header}\n`), header)
        .toThrow('must be a variable');
    }

    const utf8Failure = await decodeSparqlTsvSelectResponse(chunkedResponse([
      Uint8Array.from([0x3f, 0x78, 0x0a, 0xc3, 0x28]),
    ])).catch((error: unknown) => error);
    expect(utf8Failure).toBeInstanceOf(SparqlTsvResultsShapeError);
    expect(utf8Failure).toMatchObject({ cause: expect.any(TypeError) });
  });

  it('passes transport failures through without translating them to TSV shape errors', async () => {
    const transportFailure = new Error('transport failed');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(transportFailure);
      },
    });
    await expect(decodeSparqlTsvSelectResponse(new Response(body)))
      .rejects.toBe(transportFailure);
  });

  it('maps a managed Oxigraph cancellation suffix to the typed timeout error', async () => {
    const body = new TextEncoder().encode(
      '?x\n<urn:partial>\nThe SPARQL operation has been cancelled',
    );
    await expect(decodeSparqlHttpQueryResponse(chunkedResponse([body], {
      'Content-Type': 'text/tab-separated-values',
    }), {
      mode: 'select-tsv',
      managedOxigraph: true,
      operation: 'query',
    })).rejects.toMatchObject({
      code: 'STORE_OPERATION_TIMEOUT',
      backend: 'oxigraph-server',
      operation: 'query',
    });
  });
});
