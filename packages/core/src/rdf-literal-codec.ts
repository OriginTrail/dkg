export interface ParsedRdfLiteralTerm {
  readonly lexical: string;
  readonly suffix: string;
  readonly language?: string;
  readonly datatype?: string;
}

export function parseRdfLiteralTerm(term: string): ParsedRdfLiteralTerm | null {
  if (!term.startsWith('"')) return null;
  let escaped = false;
  for (let i = 1; i < term.length; i++) {
    const ch = term[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (isRawLiteralControlCharacter(ch)) return null;
    if (ch !== '"') continue;

    try {
      const body = term.slice(1, i);
      const suffix = term.slice(i + 1);
      const metadata = parseLiteralSuffix(suffix);
      return {
        lexical: decodeRdfLiteralBody(body),
        suffix,
        ...metadata,
      };
    } catch {
      return null;
    }
  }
  return null;
}

export function rdfLiteralTerm(lexical: string, suffix = ''): string {
  return `${JSON.stringify(lexical)}${suffix}`;
}

function isRawLiteralControlCharacter(value: string): boolean {
  return value.charCodeAt(0) < 0x20;
}

function parseLiteralSuffix(suffix: string): { language?: string; datatype?: string } {
  if (suffix === '') return {};
  const language = /^@([A-Za-z]+(?:-[A-Za-z0-9]+)*)$/.exec(suffix);
  if (language) return { language: language[1] };
  const datatype = /^\^\^<([^<>"{}|\\^`\x00-\x20>]+)>$/.exec(suffix);
  if (datatype) return { datatype: datatype[1] };
  throw new Error(`Invalid RDF literal suffix: ${suffix.slice(0, 80)}`);
}

function decodeRdfLiteralBody(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i += 1;
    if (i >= body.length) throw new Error('Invalid trailing RDF literal escape');
    const escaped = body[i]!;
    switch (escaped) {
      case 't':
        out += '\t';
        break;
      case 'b':
        out += '\b';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 'f':
        out += '\f';
        break;
      case '"':
      case "'":
      case '\\':
        out += escaped;
        break;
      case 'u': {
        const hex = body.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('Invalid RDF \\u escape');
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      case 'U': {
        const hex = body.slice(i + 1, i + 9);
        if (!/^[0-9a-fA-F]{8}$/.test(hex)) throw new Error('Invalid RDF \\U escape');
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 8;
        break;
      }
      default:
        throw new Error(`Invalid RDF literal escape: \\${escaped}`);
    }
  }
  return out;
}
