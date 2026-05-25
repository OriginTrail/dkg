/**
 * Decode an RDF string literal whose body was written with JSON-style
 * escaping, optionally followed by an RDF datatype or language suffix.
 */
export function decodeRdfStringLiteral(value: string): string {
  if (!value) return '';
  const typed = value.match(/^"([\s\S]*)"(?:\^\^<[^>]+>)?(?:@[a-z-]+)?$/);
  if (!typed) return value;
  try {
    return JSON.parse(`"${typed[1]}"`) as string;
  } catch {
    return typed[1];
  }
}
