import { describe, it, expect } from 'vitest';
import { parseBoundary, parseMultipart, MultipartParseError } from '../src/http/multipart.js';

const BOUNDARY = '----dkgtestboundary';
const CRLF = '\r\n';

function buildBody(...parts: Buffer[]): Buffer {
  const segments: Buffer[] = [];
  for (const part of parts) {
    segments.push(Buffer.from(`--${BOUNDARY}${CRLF}`));
    segments.push(part);
    segments.push(Buffer.from(CRLF));
  }
  segments.push(Buffer.from(`--${BOUNDARY}--${CRLF}`));
  return Buffer.concat(segments);
}

function textPart(name: string, value: string): Buffer {
  return Buffer.from(
    `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}`,
  );
}

function filePart(name: string, filename: string, contentType: string, content: Buffer): Buffer {
  const header = Buffer.from(
    `Content-Disposition: form-data; name="${name}"; filename="${filename}"${CRLF}` +
    `Content-Type: ${contentType}${CRLF}${CRLF}`,
  );
  return Buffer.concat([header, content]);
}

describe('parseBoundary', () => {
  it('extracts boundary from a standard header', () => {
    expect(parseBoundary('multipart/form-data; boundary=abc123')).toBe('abc123');
  });

  it('extracts quoted boundaries', () => {
    expect(parseBoundary('multipart/form-data; boundary="abc 123"')).toBe('abc 123');
  });

  it('is case-insensitive on the media type', () => {
    expect(parseBoundary('Multipart/Form-Data; boundary=xyz')).toBe('xyz');
  });

  it('handles boundaries with dashes and punctuation', () => {
    expect(parseBoundary('multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW')).toBe('----WebKitFormBoundary7MA4YWxkTrZu0gW');
  });

  it('returns null for missing header', () => {
    expect(parseBoundary(undefined)).toBeNull();
  });

  it('returns null for non-multipart content type', () => {
    expect(parseBoundary('application/json')).toBeNull();
  });

  it('returns null when boundary parameter is missing', () => {
    expect(parseBoundary('multipart/form-data')).toBeNull();
  });

  it('returns null for an array value (duplicated Content-Type headers)', () => {
    // Node may deliver IncomingHttpHeaders['content-type'] as string[] when
    // the client sends duplicated headers. Reject as ambiguous so the route
    // handler returns a clean 400 instead of crashing in toLowerCase().
    expect(parseBoundary(['multipart/form-data; boundary=abc', 'application/json'])).toBeNull();
    expect(parseBoundary([] as unknown as string[])).toBeNull();
  });
});

describe('parseMultipart — Content-Disposition parameter parsing', () => {
  it('rejects a part that has only filename= and no name=', () => {
    // The `name=` parameter regex must be anchored to a real `;` boundary so
    // it does not silently match the `name=` substring inside `filename=`.
    // A part with only `filename="x"` should be rejected, not mis-routed as
    // a field named "x".
    const malformed = Buffer.concat([
      Buffer.from(`--${BOUNDARY}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; filename="lonely.txt"${CRLF}${CRLF}contents`),
      Buffer.from(CRLF),
      Buffer.from(`--${BOUNDARY}--${CRLF}`),
    ]);
    expect(() => parseMultipart(malformed, BOUNDARY)).toThrow(MultipartParseError);
    expect(() => parseMultipart(malformed, BOUNDARY)).toThrow(/without name/);
  });

  it('parses name= and filename= independently when both are present', () => {
    const body = buildBody(filePart('attachment', 'doc.pdf', 'application/pdf', Buffer.from('PDF', 'utf-8')));
    const fields = parseMultipart(body, BOUNDARY);
    expect(fields).toHaveLength(1);
    expect(fields[0].name).toBe('attachment');
    expect(fields[0].filename).toBe('doc.pdf');
  });

  it('parses name= when filename= comes first in the Content-Disposition', () => {
    // Order-independence: filename before name should still work because the
    // anchored regex looks for `;\s*name=` (or start-of-string) regardless of
    // position.
    const body = Buffer.concat([
      Buffer.from(`--${BOUNDARY}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; filename="doc.pdf"; name="attachment"${CRLF}${CRLF}body`),
      Buffer.from(CRLF),
      Buffer.from(`--${BOUNDARY}--${CRLF}`),
    ]);
    const fields = parseMultipart(body, BOUNDARY);
    expect(fields).toHaveLength(1);
    expect(fields[0].name).toBe('attachment');
    expect(fields[0].filename).toBe('doc.pdf');
  });
});

describe('parseMultipart — text fields', () => {
  it('extracts a single text field', () => {
    const body = buildBody(textPart('greeting', 'hello'));
    const fields = parseMultipart(body, BOUNDARY);
    expect(fields).toHaveLength(1);
    expect(fields[0].name).toBe('greeting');
    expect(fields[0].filename).toBeUndefined();
    expect(fields[0].contentType).toBeUndefined();
    expect(fields[0].content.toString('utf-8')).toBe('hello');
  });

  it('extracts multiple text fields in order', () => {
    const body = buildBody(
      textPart('first', 'one'),
      textPart('second', 'two'),
      textPart('third', 'three'),
    );
    const fields = parseMultipart(body, BOUNDARY);
    expect(fields).toHaveLength(3);
    expect(fields.map(f => f.name)).toEqual(['first', 'second', 'third']);
    expect(fields.map(f => f.content.toString('utf-8'))).toEqual(['one', 'two', 'three']);
  });

  it('handles empty text field values', () => {
    const body = buildBody(textPart('empty', ''));
    const fields = parseMultipart(body, BOUNDARY);
    expect(fields).toHaveLength(1);
    expect(fields[0].content.length).toBe(0);
  });

  it('preserves CRLF-free text values', () => {
    const body = buildBody(textPart('iri', 'did:dkg:context-graph:my-cg'));
    const fields = parseMultipart(body, BOUNDARY);
    expect(fields[0].content.toString('utf-8')).toBe('did:dkg:context-graph:my-cg');
  });
});

describe('parseMultipart — file fields', () => {
  it('extracts a file part with filename and content-type', () => {
    const fileContent = Buffer.from('# Markdown Document\n\nBody text.\n', 'utf-8');
    const body = buildBody(filePart('file', 'doc.md', 'text/markdown', fileContent));

    const fields = parseMultipart(body, BOUNDARY);
    expect(fields).toHaveLength(1);
    expect(fields[0].name).toBe('file');
    expect(fields[0].filename).toBe('doc.md');
    expect(fields[0].contentType).toBe('text/markdown');
    expect(fields[0].content.equals(fileContent)).toBe(true);
  });

  it('extracts binary file content without corruption', () => {
    const binary = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x0a, 0x0d, 0x2d, 0x2d]);
    const body = buildBody(filePart('file', 'binary.bin', 'application/octet-stream', binary));

    const fields = parseMultipart(body, BOUNDARY);
    expect(fields[0].content.equals(binary)).toBe(true);
  });

  it('does not treat boundary bytes inside file payload as the next multipart boundary', () => {
    const payload = Buffer.from(`prefix--${BOUNDARY}--suffix`, 'utf-8');
    const body = buildBody(filePart('file', 'embedded-boundary.bin', 'application/octet-stream', payload));

    const fields = parseMultipart(body, BOUNDARY);
    expect(fields).toHaveLength(1);
    expect(fields[0].content.equals(payload)).toBe(true);
  });

  it('does not treat CRLF-prefixed boundary-like payload bytes as a real boundary unless followed by CRLF or --', () => {
    const payload = Buffer.from(`prefix${CRLF}--${BOUNDARY}junk${CRLF}suffix`, 'utf-8');
    const body = buildBody(filePart('file', 'embedded-delimiter.bin', 'application/octet-stream', payload));

    const fields = parseMultipart(body, BOUNDARY);
    expect(fields).toHaveLength(1);
    expect(fields[0].content.equals(payload)).toBe(true);
  });

  it('extracts mixed text and file parts in a single body', () => {
    const fileContent = Buffer.from('file body', 'utf-8');
    const body = buildBody(
      textPart('contextGraphId', 'my-cg'),
      filePart('file', 'doc.pdf', 'application/pdf', fileContent),
      textPart('ontologyRef', 'did:dkg:context-graph:my-cg/_ontology'),
    );

    const fields = parseMultipart(body, BOUNDARY);
    expect(fields).toHaveLength(3);
    expect(fields[0].name).toBe('contextGraphId');
    expect(fields[0].content.toString('utf-8')).toBe('my-cg');
    expect(fields[1].name).toBe('file');
    expect(fields[1].filename).toBe('doc.pdf');
    expect(fields[1].contentType).toBe('application/pdf');
    expect(fields[1].content.equals(fileContent)).toBe(true);
    expect(fields[2].name).toBe('ontologyRef');
    expect(fields[2].content.toString('utf-8')).toBe('did:dkg:context-graph:my-cg/_ontology');
  });
});

describe('parseMultipart — error handling', () => {
  it('throws on empty boundary', () => {
    expect(() => parseMultipart(Buffer.alloc(0), '')).toThrow(MultipartParseError);
  });

  it('throws when no opening boundary is present', () => {
    expect(() => parseMultipart(Buffer.from('random bytes'), BOUNDARY)).toThrow(/Missing opening boundary/);
  });

  it('throws on missing Content-Disposition header', () => {
    const badPart = Buffer.from(`Content-Type: text/plain${CRLF}${CRLF}orphaned`);
    const body = buildBody(badPart);
    expect(() => parseMultipart(body, BOUNDARY)).toThrow(/missing Content-Disposition/);
  });

  it('throws on missing header terminator', () => {
    const delim = `--${BOUNDARY}${CRLF}`;
    const body = Buffer.concat([
      Buffer.from(delim),
      Buffer.from(`Content-Disposition: form-data; name="x"`), // no CRLF CRLF
    ]);
    expect(() => parseMultipart(body, BOUNDARY)).toThrow(MultipartParseError);
  });

  it('throws when a part has no closing boundary', () => {
    const body = Buffer.from(`--${BOUNDARY}${CRLF}Content-Disposition: form-data; name="x"${CRLF}${CRLF}orphaned`);
    expect(() => parseMultipart(body, BOUNDARY)).toThrow(MultipartParseError);
  });
});
